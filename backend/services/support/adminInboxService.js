const mongoose = require('mongoose');
const { cancelsFollowUp } = require('./answeredFollowUp');
const SupportTicket = require('../../models/SupportTicket');
const SupportConversation = require('../../models/SupportConversation');
const SupportMessage = require('../../models/SupportMessage');
const User = require('../../models/User');
const sendEmail = require('../../utils/email');
const {
  publishConversationEvent
} = require('./liveUpdateService');
const { enqueueAlert } = require('../adminAlertService');
const logger = require('../../utils/logger').createLogger('admin-inbox');
async function queueOwnerAlert(args, { session } = {}) {
  if (session) return enqueueAlert(args, { session });
  try {await enqueueAlert(args);}catch(_) {logger.warn('Owner alert enqueue failed; the communications worker will reconcile the saved request.');}
}
const ACTIVE = ['open', 'in_review', 'waiting_on_user', 'waiting_on_info'];
const ref = id => `SUP-${String(id).slice(-6).toUpperCase()}`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
const sourceQuery = source => source === 'email' ? {requestKind:'email'} : source === 'contact' ? {
  $or: [{
    requestKind: 'contact'
  }, {
    sourceSurface: 'public',
    conversationId: null
  }]
} : source === 'human' ? {
  requestKind: 'human'
} : {};
async function recordContactSubmission({
  name,
  email,
  role,
  subject,
  message
}) {
  const {
    classifyTicket
  } = require('./ticketService');
  const ticket = await SupportTicket.create({
    subject,
    message,
    requesterEmail: email.toLowerCase(),
    requesterRole: ['attorney', 'paralegal'].includes(role) ? role : 'visitor',
    requestKind: 'contact',
    sourceSurface: 'public',
    sourceLabel: 'Contact form',
    routePath: '/contact.html',
    contextSnapshot: {
      requesterName: name,
      declaredRole: role
    },
    classification: classifyTicket({
      subject,
      message
    }),
    routingSuggestion: {
      ownerKey: 'support_ops',
      priority: 'normal',
      queueLabel: 'Contact submissions',
      reason: 'A visitor requested a reply.'
    }
  });
  await queueOwnerAlert({key:`contact:${ticket._id}`,kind:'contact',targetId:ticket._id});
  return ticket;
}
async function handleHumanRequest({
  conversation,
  user,
  userMessage,
  explicit,
  context,
  session = null,
  publish = true
}) {
  const active = await SupportTicket.findOne({
    conversationId: conversation._id,
    status: {
      $in: ACTIVE
    }
  }).sort({
    createdAt: -1
  }).session(session);
  if (!explicit && active?.requestKind !== 'human') return null;
  let ticketId = active?._id || conversation.escalation?.ticketId;
  if (!ticketId) {
    const claim = await SupportConversation.findOneAndUpdate({
      _id: conversation._id,
      'escalation.ticketId': null
    }, {
      $set: {
        'escalation.ticketId': new mongoose.Types.ObjectId()
      }
    }, {
      returnDocument: 'after',
      ...(session ? { session } : {})
    });
    ticketId = claim?.escalation?.ticketId || (await SupportConversation.findById(conversation._id).session(session))?.escalation?.ticketId;
  }
  if (!ticketId) throw new Error('Unable to save your request for the team. Please try again.');
  const update = {
    $set: {
      requestKind: 'human',
      status: 'open',
      resolvedAt: null,
      resolutionIsStable: false,
      latestUserMessage: userMessage.text,
      conversationId: conversation._id,
      requesterUserId: user._id,
      userId: user._id,
      requesterEmail: user.email || '',
      requesterRole: user.role,
      sourceSurface: user.role,
      sourceLabel: 'Assistant · human requested',
      routePath: context.sourcePage,
      pageContext: context.pageContext,
      escalationReason: 'User requested a person',
      'routingSuggestion.ownerKey': 'support_ops',
      'routingSuggestion.queueLabel': 'Human requests'
    },
    $setOnInsert: {
      subject: 'Human assistance requested',
      message: userMessage.text,
      urgency: 'medium'
    }
  };
  if (cancelsFollowUp(active, userMessage.createdAt)) update.$set.followUpAt = null;
  let ticket;
  try {
    ticket = await SupportTicket.findOneAndUpdate({
      _id: ticketId
    }, update, {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      ...(session ? { session } : {})
    });
  } catch (error) {
    if (error.code !== 11000 || session) throw error;
    ticket = await SupportTicket.findOneAndUpdate({
      _id: ticketId
    }, update, {
      returnDocument: 'after',
      runValidators: true,
      ...(session ? { session } : {})
    });
  }
  await queueOwnerAlert({key:`human:${ticket._id}:${ticket.lastAdminReplyAt?.toISOString()||'initial'}`,kind:'human',targetId:ticket._id}, { session });
  const savedConversation = await SupportConversation.findByIdAndUpdate(conversation._id, {
    $set: {
      status: 'escalated',
      lastMessageAt: new Date(),
      'escalation.ticketId': ticketId,
      'escalation.requested': true,
      'escalation.requestedAt': conversation.escalation?.requestedAt || new Date(),
      'escalation.note': 'Human assistance requested',
      'metadata.support.humanRequested': true,
      'metadata.support.escalationSent': true
    }
  }, {
    returnDocument: 'after',
    ...(session ? { session } : {})
  });
  const [acknowledgement] = await SupportMessage.create([{
    conversationId: conversation._id,
    sender: 'system',
    text: explicit ? `Your request has been sent to the LPC team (${ref(ticketId)}). You can add your question here, and a team member will reply in this conversation. You do not need to submit another form.` : `Your message has been added to ${ref(ticketId)} for the LPC team.`,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
    metadata: {
      kind: 'human_handoff',
      ticketId: String(ticketId),
      ticketReference: ref(ticketId)
    }
  }], session ? { session } : {});
  if (publish) publishConversationEvent(conversation._id, {
    type: 'conversation.updated',
    reason: 'human.requested',
    ticketId: String(ticketId)
  });
  return {
    conversation: savedConversation,
    assistantMessage: acknowledgement,
    ticket
  };
}
// Explicit harness markers only; never infer test data from a person's name.
const realInboxRecords = () => ({ $nor: [
  { sourceLabel: 'Control Room e2e harness' },
  { 'supportFactsSnapshot.harnessRunKey': /^cr-e2e-/i }
] });
async function listInbox({
  source = '',
  status = 'active',
  q = '',
  assignment = '',
  followUp = '',
  operatorId = '',
  includeTests = false,
  page = 1,
  limit = 20
} = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const query = { ...sourceQuery(source), ...(includeTests === true || includeTests === 'true' ? {} : realInboxRecords()) };
  if(assignment==='mine' && mongoose.isValidObjectId(operatorId))query.assignedTo=operatorId;
  if(assignment==='unassigned')query.assignedTo=null;
  if(followUp==='overdue')query.followUpAt={$lte:new Date(),$ne:null};
  if (status === 'active') query.status = {
    $in: ACTIVE
  };else if (status !== 'all') query.status = status === 'resolved' ? {
    $in: ['resolved', 'closed']
  } : status;
  if (String(q).trim()) {
    const regex = new RegExp(String(q).trim().slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({ $or: [{ firstName: regex }, { lastName: regex }, { email: regex }] }).select('_id').lean();
    query.$and = [{
      $or: [{
        subject: regex
      }, {
        message: regex
      }, {
        requesterEmail: regex
      }, {
        'contextSnapshot.requesterName': regex
      }, {
        requesterUserId: { $in: users.map(user => user._id) }
      }]
    }];
    const search = String(q).trim();
    if (mongoose.isValidObjectId(search)) query.$and[0].$or.push({ _id: search },{caseId:search},{requesterUserId:search});
    if (/^SUP-[a-f0-9]{6}$/i.test(search)) query.$and[0].$or.push({
      $expr: { $eq: [{ $substrBytes: [{ $toString: '$_id' }, 18, 6] }, search.slice(4).toLowerCase()] }
    });
  }
  const [tickets, total] = await Promise.all([SupportTicket.find(query).select('-latestResponsePacket -supportFactsSnapshot -internalNotes -emailReplies').populate('requesterUserId', 'firstName lastName email role status').sort({
    updatedAt: -1,
    _id: -1
  }).skip((page - 1) * limit).limit(limit).lean(), SupportTicket.countDocuments(query)]);
  return {
    tickets: tickets.map(t => ({
      ...t,
      id: String(t._id),
      reference: ref(t._id)
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
    limit
  };
}
async function inboxSummary() {
  const [all, contact, human] = await Promise.all([{}, sourceQuery('contact'), sourceQuery('human')].map(query => SupportTicket.countDocuments({
    ...query,
    ...realInboxRecords(),
    status: {
      $in: ['open', 'in_review']
    }
  })));
  const overdue=await SupportTicket.countDocuments({...realInboxRecords(),status:{$in:ACTIVE},followUpAt:{$lte:new Date(),$ne:null}});
  return {
    all,
    contact,
    human,
    overdue
  };
}

// The persisted request ID claims a send before contacting the provider. An uncertain
// send is never automatically retried, including after a lost HTTP response.
async function replyByEmail({
  ticket,
  adminUser,
  text,
  status,
  requestId
}) {
  if (!/^[a-f0-9-]{36}$/i.test(String(requestId || ''))) {
    const e = new Error('A reply request ID is required.');
    e.statusCode = 400;
    throw e;
  }
  const prior = ticket.emailReplies?.find(r => r.requestId === requestId);
  if (prior) {
    if (prior.text !== text || String(prior.adminId) !== String(adminUser._id || adminUser.id)) {
      const e = new Error('This request was already used for a different reply.');
      e.statusCode = 409;
      throw e;
    }
    return {
      ticket: ticket.toObject(),
      delivery: prior.delivery,
      reused: true
    };
  }
  if (!ticket.requesterEmail) throw new Error('This contact submission has no reply address.');
  const reply = {
    requestId,
    messageId: `<lpc-support.${ticket._id}.${requestId}@lets-paraconnect.com>`,
    text,
    adminId: adminUser._id || adminUser.id,
    adminName: [adminUser.firstName, adminUser.lastName].filter(Boolean).join(' ') || 'LPC Team',
    delivery: 'pending',
    createdAt: new Date()
  };
  const claimed = await SupportTicket.findOneAndUpdate({
    _id: ticket._id,
    updatedAt: ticket.updatedAt,
    requesterEmail: ticket.requesterEmail,
    status: ticket.status,
    subject: ticket.subject,
    message: ticket.message,
    latestUserMessage: ticket.latestUserMessage,
    $expr: { $eq: [{ $size: { $ifNull: ['$emailReplies', []] } }, ticket.emailReplies?.length || 0] },
    'emailReplies.requestId': {
      $ne: requestId
    }
  }, {
    $push: {
      emailReplies: reply
    }
  }, {
    returnDocument: 'after'
  });
  if (!claimed) {
    const current = await SupportTicket.findById(ticket._id);
    if (current?.emailReplies?.some(item => item.requestId === requestId)) {
      return replyByEmail({ ticket: current, adminUser, text, status, requestId });
    }
    throw Object.assign(new Error('This inquiry changed. Refresh it before sending your reply.'), { statusCode: 409 });
  }
  let delivery = 'unknown';
  try {
    const result = await sendEmail(ticket.requesterEmail, `Re: ${ticket.subject}`, `<p style="white-space:pre-wrap">${escapeHtml(text)}</p><p>Reference: ${ref(ticket._id)}</p>`, {
      text: `${text}\n\nReference: ${ref(ticket._id)}`,
      throwOnError: true,
      messageId: reply.messageId,
      replyTo: process.env.SUPPORT_ZOHO_MAILBOX || 'help@lets-paraconnect.com'
    });
    delivery = result?.disabled ? 'disabled' : result?.accepted?.length ? 'accepted' : 'unknown';
  } catch (_) {
    delivery = 'unknown';
  }
  const changes = {
    'emailReplies.$.delivery': delivery
  };
  if (delivery === 'accepted') {
    changes.status = status || 'waiting_on_user';
    changes.lastAdminReplyAt = new Date();
    if (['resolved', 'closed'].includes(changes.status)) changes.resolvedAt = new Date();
  }
  let updated = await SupportTicket.findOneAndUpdate({
    _id: ticket._id,
    updatedAt: claimed.updatedAt,
    status: claimed.status,
    message: claimed.message,
    latestUserMessage: claimed.latestUserMessage,
    'emailReplies.requestId': requestId
  }, {
    $set: changes
  }, {
    returnDocument: 'after'
  });
  // Record the provider outcome without overwriting a newer owner decision or
  // an incoming user reply that arrived while the send was in flight.
  if (!updated) updated = await SupportTicket.findOneAndUpdate({
    _id: ticket._id, 'emailReplies.requestId': requestId
  }, { $set: { 'emailReplies.$.delivery': delivery } }, { returnDocument: 'after' });
  if (!updated) throw Object.assign(new Error('The reply outcome could not be recorded. Check delivery before retrying.'), { statusCode: 409 });
  return {
    ticket: updated.toObject(),
    delivery
  };
}
module.exports = {
  recordContactSubmission,
  handleHumanRequest,
  listInbox,
  inboxSummary,
  replyByEmail
};
