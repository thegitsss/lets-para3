const User = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const Case = require('../models/Case');
const PaymentOperation = require('../models/PaymentOperation');
const FollowUp = require('../models/AdminFollowUp');
const mongoose = require('mongoose');
const ApprovalTask = require('../models/ApprovalTask');
const IncidentApproval = require('../models/IncidentApproval');
const KEY = /^(application|inquiry|payment|matter|approval|incident|photo):[a-f0-9]{24}$/;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

function parseDeferred(raw = '[]') {
  let entries;
  try { entries = JSON.parse(raw); } catch { entries = null; }
  if (!Array.isArray(entries) || entries.length > 50 || entries.some(entry =>
    !entry || !/^(application|inquiry|payment|matter|approval|incident|photo):[a-f0-9]{24}$/.test(entry.key) ||
    typeof entry.revision !== 'string' || !Number.isFinite(Date.parse(entry.revision)))) {
    throw Object.assign(new Error('Refresh your saved queue and try again.'), { statusCode: 400 });
  }
  return entries;
}

function availableQuery(query, kind, deferred) {
  const exclusions = deferred.filter(entry => entry.key.startsWith(`${kind}:`)).map(entry => ({
    _id: new mongoose.Types.ObjectId(entry.key.split(':')[1]), updatedAt: new Date(entry.revision)
  }));
  return exclusions.length ? { $and: [query, { $nor: exclusions }] } : query;
}

async function nextAdminTask({ deferred: raw, current = '', selected = '', page = 1, owner, now = new Date() } = {}) {
  page = Number(page);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail('Invalid queue page.');
  if (selected && (typeof selected !== 'string' || !KEY.test(selected))) fail('Invalid queue selection.');
  const pageSize = 20;
  let deferred = parseDeferred(raw);
  if (current && !/^(application|inquiry|payment|matter|approval|incident|photo):[a-f0-9]{24}$/.test(current)) {
    throw Object.assign(new Error('Invalid queue item.'), { statusCode: 400 });
  }
  if (owner && !mongoose.isValidObjectId(owner)) fail('Your account could not be checked. Please sign in again.', 401);
  const reminders = owner ? await FollowUp.find({ owner, followUpAt: { $ne: null } }).lean() : [];
  const scheduled = reminders.filter(row => row.followUpAt > now);
  const dueReminders = reminders.filter(row => row.followUpAt <= now);
  // Saved follow-ups work across browsers. New source revisions become visible immediately.
  deferred = [...new Map([...deferred, ...scheduled.map(row => ({ key: row.key, revision: row.sourceRevision.toISOString() }))].map(row => [row.key, row])).values()];
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // An accepted information request waits for the applicant. Their reply reopens the ticket.
  const waitingRequests = await SupportTicket.aggregate([
    { $match: { administrativeRequestKey: { $exists: true }, requesterUserId: { $ne: null } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $group: { _id: '$requesterUserId', request: { $first: '$$ROOT' } } },
    { $match: { 'request.status': 'waiting_on_user', $expr: { $eq: [{ $arrayElemAt: ['$request.emailReplies.delivery', -1] }, 'accepted'] } } },
    { $project: { _id: 1 } }
  ]);
  const waitingIds = waitingRequests.map(request => request._id);
  const applications = { role: { $in: ['attorney', 'paralegal'] }, status: 'pending', deleted: { $ne: true }, disabled: { $ne: true } };
  const inquiries = { $or: [
    { status: { $in: ['open', 'in_review'] } },
    { status: { $in: ['waiting_on_user', 'waiting_on_info'] }, followUpAt: { $ne: null, $lte: now } },
    { status: { $in: ['waiting_on_user', 'waiting_on_info'] }, $expr: { $in: [{ $arrayElemAt: ['$emailReplies.delivery', -1] }, ['unknown', 'disabled', 'pending']] } }
  ] };
  const payments = { $or: [
    { kind: { $ne: 'chargeback' }, status: { $in: ['failed', 'needs_reconciliation'] } },
    { kind: 'chargeback', administrativeStatus: { $in: ['pending_review', 'acknowledged', null] } }
  ] };
  const matters = { $or: [
    { status: 'disputed', 'disputes.status': 'open' },
    { postingSyncStatus: 'needs_reconciliation' }, { hiringClaimStatus: 'needs_reconciliation' },
    { completionClaimStatus: 'needs_reconciliation' }, { fundingIntegrityStatus: 'failed' },
    { moderationStatus: 'resolution_requested', status: { $in: ['open', 'paused'] }, archived: { $ne: true } },
    { status: { $in: ['open', 'in progress', 'in_progress', 'paused'] }, deadlineDate: { $nin: ['', null], $lt: today } }
  ] };
  const sources = [
    ['application', User, { ...applications, _id: { $nin: waitingIds } }, 'firstName lastName email role createdAt updatedAt'],
    ['inquiry', SupportTicket, inquiries, 'subject requesterEmail requestKind caseId status followUpAt urgency routingSuggestion.priority emailReplies.delivery createdAt updatedAt'],
    ['payment', PaymentOperation, payments, 'kind caseId status administrativeStatus createdAt updatedAt'],
    ['matter', Case, matters, 'title status disputes.status deadlineDate fundingIntegrityStatus postingSyncStatus hiringClaimStatus completionClaimStatus moderationStatus createdAt updatedAt'],
    ['approval', ApprovalTask, { approvalState: 'pending' }, 'title summary taskType targetType targetId metadata.automationFailure createdAt updatedAt'],
    ['incident', IncidentApproval, { status: 'pending', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, 'incidentId approvalType createdAt updatedAt'],
    ['photo', User, { role: { $in: ['attorney', 'paralegal'] }, deleted: { $ne: true }, disabled: { $ne: true }, status: { $nin: ['denied', 'pending'] }, pendingProfileImage: { $nin: ['', null] } }, 'firstName lastName email createdAt updatedAt']
  ];
  const queues = await Promise.all(sources.map(async ([kind, Model, query, fields]) => {
    const available = availableQuery(query, kind, deferred);
    const saved = deferred.filter(entry => entry.key.startsWith(`${kind}:`));
    const priority = kind === 'payment' ? 0 : kind === 'incident' ? 1 : ['application', 'photo'].includes(kind) ? 2 : kind === 'approval' ? { $cond: [{ $eq: ['$metadata.automationFailure.needsReview', true] }, 1, 3] } : kind === 'inquiry'
      ? { $cond: [{ $or: [{ $eq: ['$urgency', 'high'] }, { $eq: ['$routingSuggestion.priority', 'high'] }, { $and: [{ $ne: [{ $ifNull: ['$followUpAt', null] }, null] }, { $lte: ['$followUpAt', now] }] }] }, 1, 2] }
      : { $cond: [{ $or: [{ $eq: ['$fundingIntegrityStatus', 'failed'] }, { $and: [{ $eq: ['$status', 'disputed'] }, { $in: ['open', { $ifNull: ['$disputes.status', []] }] }] }] }, 0,
        { $cond: [{ $or: ['postingSyncStatus', 'hiringClaimStatus', 'completionClaimStatus'].map(field => ({ $eq: [`$${field}`, 'needs_reconciliation'] })) }, 1, 3] }] };
    const projection = Object.fromEntries(fields.split(' ').map(field => [field, 1]));
    // Apply the owner's due reminders before pagination. An older reminder
    // does not promote a changed source or another owner's queue.
    const due = dueReminders.filter(row => row.key.startsWith(`${kind}:`));
    const reminderDue = due.length ? { $or: due.map(row => ({ $and: [
      { $eq: ['$_id', new mongoose.Types.ObjectId(row.key.split(':')[1])] },
      { $eq: ['$updatedAt', row.sourceRevision] }
    ] })) } : { $literal: false };
    const basePriority = typeof priority === 'number' ? { $literal: priority } : priority;
    const [total, remaining, candidates, retained] = await Promise.all([
      Model.countDocuments(query), Model.countDocuments(available),
      Model.aggregate([{ $match: available }, { $addFields: { reminderDue, attentionPriority: basePriority } }, { $addFields: { attentionPriority: { $cond: ['$reminderDue', { $min: ['$attentionPriority', 1] }, '$attentionPriority'] } } }, { $sort: { attentionPriority: 1, createdAt: 1, _id: 1 } }, { $limit: page * pageSize }, { $project: { ...projection, attentionPriority: 1, reminderDue: 1 } }]),
      saved.length ? Model.find({ $and: [query, { $or: saved.map(entry => ({ _id: entry.key.split(':')[1], updatedAt: new Date(entry.revision) })) }] }).select(fields).lean() : []
    ]);
    if (kind === 'payment') await Model.populate(candidates, { path: 'caseId', select: 'title' });
    return { kind, total, remaining, candidates, retained };
  }));
  const waiting = await User.countDocuments({ ...applications, _id: { $in: waitingIds } });
  let currentRecord = null;
  if (current) {
    const [kind, id] = current.split(':');
    const [, Model, query] = sources.find(source => source[0] === kind);
    currentRecord = await Model.findOne({ $and: [query, { _id: id }] }).select('updatedAt').lean();
  }
  function toTask(kind, row) {
    const id = String(row._id);
    const task = { key: `${kind}:${id}`, kind: kind, id, revision: row.updatedAt.toISOString(), priority: row.attentionPriority === 0 ? 'urgent' : row.attentionPriority === 1 ? 'high' : 'normal' };
    if (kind === 'application') Object.assign(task, { title: 'Review application', name: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email, detail: row.role });
    if (kind === 'inquiry') Object.assign(task, { title: 'Reply to an inquiry', name: row.subject, detail: row.requestKind === 'human' ? 'Human request' : 'Message', caseId: row.caseId ? String(row.caseId) : null });
    if (kind === 'payment') Object.assign(task, { view: row.kind === 'chargeback' ? 'chargeback' : 'payment', title: row.kind === 'chargeback' ? 'Review a chargeback' : 'Check a payment', name: row.caseId?.title || row.kind.replace(/_/g, ' '), detail: row.kind === 'chargeback' ? 'Financial review needed' : 'Payment needs reconciliation', caseId: row.caseId ? String(row.caseId._id) : null });
    if (kind === 'approval') Object.assign(task, { title: 'Review prepared content', name: row.title, detail: row.summary, workKey: `${row.targetType}:${row.targetId}`, section: 'approvals-workspace' });
    if (kind === 'incident') Object.assign(task, { title: 'Review a technical decision', name: row.approvalType.replace(/_/g, ' '), detail: 'A technical change is waiting for your decision.', incidentId: String(row.incidentId), section: 'engineering' });
    if (kind === 'photo') Object.assign(task, { title: 'Review a profile photo', name: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email, detail: 'A new photo is waiting for your review.', section: 'user-management' });
    if (kind === 'matter') {
      const dispute = row.status === 'disputed' && row.disputes?.some(item => item.status === 'open');
      Object.assign(task, { view: dispute ? 'dispute' : row.moderationStatus === 'resolution_requested' ? 'posting' : 'matter', title: 'Review a matter', name: row.title, detail: dispute ? 'Open dispute' : row.moderationStatus === 'resolution_requested' ? 'Posting edits submitted for review' : row.fundingIntegrityStatus === 'failed' ? 'Funding needs review' : [row.postingSyncStatus, row.hiringClaimStatus, row.completionClaimStatus].includes('needs_reconciliation') ? 'Workflow needs review' : 'Deadline has passed', caseId: id });
    }
    task.reason = kind === 'approval' ? row.metadata?.automationFailure?.needsReview ? 'Automatic approval could not finish. Please review this draft before it is used.' : 'This draft needs your decision before it can be used.'
      : kind === 'incident' ? 'This change needs your approval. Opening the review does not deploy or change anything.'
      : kind === 'photo' ? 'Review the submitted photo before it appears on the profile.'
      : task.view === 'posting' ? 'The author has submitted changes for you to review.'
      : kind === 'application' ? 'This application is waiting for your review.'
      : kind === 'payment' ? 'The payment records need checking before this can move forward.'
      : kind === 'inquiry' ? row.followUpAt && row.followUpAt <= now ? 'The follow-up you set is due.' : row.attentionPriority === 1 ? 'This inquiry has been marked as needing prompt attention.' : 'This person is waiting for a reply.'
      : task.view === 'dispute' ? 'The participants need your help resolving this dispute.' : 'This matter needs a closer look.';
    const delivery = kind === 'inquiry' ? row.emailReplies?.at(-1)?.delivery : null;
    if (['unknown', 'pending', 'disabled'].includes(delivery)) {
      task.title = 'Check reply delivery';
      task.detail = 'Reply outcome needs review';
      task.reason = delivery === 'disabled'
        ? 'The reply was saved, but email sending was disabled. Check the sending configuration before sending it.'
        : 'A reply was attempted, but its delivery is unconfirmed. Check the mailbox before sending another reply.';
    }
    if (row.reminderDue) {
      task.followUpDue = true;
      if (!task.reason.startsWith('The follow-up you set is due.')) task.reason = `The follow-up you set is due. ${task.reason}`;
    }
    return task;
  }
  const ordered = queues.flatMap(queue => queue.candidates.map(row => ({ kind: queue.kind, row }))).sort((a, b) => a.row.attentionPriority - b.row.attentionPriority || new Date(a.row.createdAt) - new Date(b.row.createdAt) || String(a.row._id).localeCompare(String(b.row._id)));
  const remaining = queues.reduce((sum, queue) => sum + queue.remaining, 0);
  const pages = Math.max(1, Math.ceil(remaining / pageSize));
  page = Math.min(page, pages);
  const items = ordered.slice((page - 1) * pageSize, page * pageSize).map(({ kind, row }) => toTask(kind, row));
  let task = items.find(item => item.key === selected) || items[0] || null;
  if (task) task.followUpRevision = owner ? (await FollowUp.findById(`${owner}:${task.key}`).select('revision').lean())?.revision || 0 : 0;
  const selectedPreference = owner && (current || task?.key) ? await FollowUp.findById(`${owner}:${current || task.key}`).lean() : null;
  const deferredItems = queues.flatMap(queue => queue.retained.map(row => ({ key: `${queue.kind}:${row._id}`, revision: row.updatedAt.toISOString() })));
  const retainedKeys = new Set(deferredItems.map(row => row.key));
  const retainedRecords = new Map(queues.flatMap(queue => queue.retained.map(row => [`${queue.kind}:${row._id}`, row])));
  const followUps = scheduled.filter(row => retainedKeys.has(row.key)).map(row => {
    const source = retainedRecords.get(row.key);
    return { key: row.key, name: source.subject || source.title || [source.firstName, source.lastName].filter(Boolean).join(' ') || 'Payment review', sourceRevision: row.sourceRevision.toISOString(), followUpAt: row.followUpAt.toISOString(), revision: row.revision };
  }).sort((a, b) => a.followUpAt.localeCompare(b.followUpAt));
  return {
    task, items, page, pages, pageSize, total: queues.reduce((sum, queue) => sum + queue.total, 0),
    remaining: queues.reduce((sum, queue) => sum + queue.remaining, 0),
    deferred: queues.reduce((sum, queue) => sum + queue.total - queue.remaining, 0),
    deferredItems, followUps, followUpRevision: selectedPreference?.revision || 0,
    counts: Object.fromEntries(queues.map(row => [row.kind, { total: row.total, ready: row.remaining }])),
    scope: 'Applications, inquiries, payment and matter exceptions, posting edits, profile photos, content approvals, and technical approvals',
    waiting, currentPending: Boolean(currentRecord), currentRevision: currentRecord?.updatedAt?.toISOString() || null,
    checkedAt: now.toISOString()
  };
}

async function saveFollowUp({ owner, key, sourceRevision, followUpAt, revision, now = new Date() }) {
  if (!mongoose.isValidObjectId(owner)) fail('Your account could not be checked. Please sign in again.', 401);
  if (typeof key !== 'string' || !KEY.test(key) || typeof sourceRevision !== 'string' || !Number.isFinite(Date.parse(sourceRevision)) || !Number.isSafeInteger(revision) || revision < 0) fail('Refresh this item before saving its follow-up.');
  const due = followUpAt === null ? null : typeof followUpAt === 'string' ? new Date(followUpAt) : new Date(NaN);
  if (due && (!Number.isFinite(due.getTime()) || due <= now || due.getTime() > now.getTime() + 90 * 86400000)) fail('Choose a future time within the next 90 days.');
  const current = await nextAdminTask({ owner, current: key, now });
  if (!current.currentPending) fail('This item no longer needs attention. Refresh your queue.', 409);
  if (current.currentRevision !== new Date(sourceRevision).toISOString()) fail('This item has changed. Refresh it before setting a follow-up.', 409);
  let saved;
  try {
    saved = await FollowUp.findOneAndUpdate({ _id: `${owner}:${key}`, revision }, {
      $set: { owner, key, sourceRevision: new Date(sourceRevision), followUpAt: due }, $inc: { revision: 1 },
    }, { upsert: revision === 0, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: false }).lean();
  } catch (error) { if (error.code !== 11000) throw error; }
  if (!saved) fail('The follow-up changed in another tab. Refresh before changing it again.', 409);
  return { key, followUpAt: saved.followUpAt?.toISOString() || null, revision: saved.revision };
}

module.exports = { nextAdminTask, parseDeferred, saveFollowUp };
