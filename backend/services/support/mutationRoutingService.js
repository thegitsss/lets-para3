const { reportOperationalFailure } = require("../../utils/operationalFailure");
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { cancelsFollowUp } = require('./answeredFollowUp');
const SupportTicket = require('../../models/SupportTicket');
const SupportMessage = require('../../models/SupportMessage');
const SupportConversation = require('../../models/SupportConversation');
const Incident = require('../../models/Incident');
const { LpcEvent } = require('../../models/LpcEvent');
const { INCIDENT_TERMINAL_STATES } = require('../../utils/incidentConstants');
const { createIncidentFromSupportSignal } = require('../incidents/intakeService');
const { shouldEscalateTicketToIncident, findMatchingActiveIncident, startEngineeringDiagnosisForIncident } = require('../lpcEvents/supportRoutingService');
const { notifyFounderSupportEngineeringIssue } = require('../incidents/notificationService');
const { publishConversationEvent } = require('./liveUpdateService');
const { routeSupportTicketEscalated, routeEvent } = require('../lpcEvents/routerService');

const OPEN = ['open', 'in_review', 'waiting_on_user', 'waiting_on_info'];
const LEASE_MS = 15 * 60 * 1000;
const id = value => String(value || '');
const formatSupportTicketReference = value => value ? `SUP-${id(value).slice(-6).toUpperCase()}` : '';

// The reply, ticket, incident, operator alert and routing intent commit with
// the same fenced send receipt. Model/provider work runs after that commit.
async function stageSupportIncidentRouting({ conversation, user, userMessage, assistantMessage, assistantReply, context, mutation, session }) {
  if (!session?.inTransaction()) throw new Error('Assistant handoff requires a transaction.');
  const prepared = mutation.record.prepared || {};
  const submission = prepared.submission;
  if (!submission) throw new Error('Assistant handoff was not prepared.');
  const reopening = mutation.record.action === 'send' && assistantReply.payload.primaryAsk === 'issue_reopen';
  const preferred = userMessage.metadata?.promptAction?.ticketId || conversation.metadata?.support?.proactiveTicketId || conversation.escalation?.ticketId;
  const ownership = { $or: [{ requesterUserId: user._id }, { userId: user._id }] };
  let ticket = reopening
    ? await SupportTicket.findOne({ ...ownership, ...(mongoose.isObjectIdOrHexString(preferred) ? { _id: preferred } : { conversationId: conversation._id, status: { $in: ['resolved', 'closed'] } }) }).sort({ resolvedAt: -1, updatedAt: -1 }).session(session)
    : await SupportTicket.findOne({ ...ownership, conversationId: conversation._id, ...(prepared.existingTicketId
      ? { _id: prepared.existingTicketId }
      : { $or: [{ status: { $in: OPEN } }, { status: { $in: ['resolved', 'closed'] }, lastAdminReplyAt: { $gt: userMessage.createdAt } }] }) }).sort({ updatedAt: -1, createdAt: -1 }).session(session);
  if (!ticket) {
    if (reopening || !prepared.preparedTicket) throw new Error('The support ticket to continue is unavailable.');
    ticket = new SupportTicket(prepared.preparedTicket);
  }
  const ticketBefore = ticket.isNew ? null : ticket.toObject();
  const laterAdminReply = ticket.lastAdminReplyAt && ticket.lastAdminReplyAt > userMessage.createdAt;
  const laterTerminalDecision = laterAdminReply && ['resolved', 'closed'].includes(ticket.status);
  if (!laterAdminReply && cancelsFollowUp(ticket, userMessage.createdAt)) ticket.followUpAt = null;
  if (reopening && !laterAdminReply) {
    ticket.status = 'in_review'; ticket.resolvedAt = null; ticket.resolutionIsStable = false;
    ticket.resolutionSummary = 'Issue reopened from support chat after the user reported it is still happening.';
  } else if (!laterAdminReply && ['waiting_on_user', 'waiting_on_info'].includes(ticket.status)) ticket.status = 'in_review';
  ticket.latestUserMessage = submission.latestUserMessage || ticket.latestUserMessage;
  ticket.assistantSummary = submission.assistantSummary || ticket.assistantSummary;
  ticket.supportFactsSnapshot = { ...(ticket.supportFactsSnapshot || {}), ...(submission.supportFactsSnapshot || {}) };
  ticket.pageContext = context.pageContext || {};
  ticket.routePath = context.sourcePage || ticket.routePath;
  ticket.escalationReason = submission.escalationReason || ticket.escalationReason;
  ticket.routingSuggestion = { ...(ticket.routingSuggestion?.toObject?.() || ticket.routingSuggestion || {}), ownerKey: 'founder_review', priority: 'high', queueLabel: 'War Room review', reason: 'In-product support escalation requires review.' };

  let incident = null, linkedToExisting = false;
  const decision = shouldEscalateTicketToIncident(ticket.toObject(), submission);
  if (decision.shouldEscalate && !(laterAdminReply && ['resolved', 'closed'].includes(ticket.status))) {
    incident = await Incident.findOne({ _id: { $in: ticket.linkedIncidentIds || [] }, state: { $nin: INCIDENT_TERMINAL_STATES } }).session(session).lean();
    if (!incident) incident = (await findMatchingActiveIncident({ ticket: ticket.toObject(), submission, session })).incident;
    linkedToExisting = Boolean(incident);
    if (!incident) incident = await createIncidentFromSupportSignal({ submission, session });
    if (!(ticket.linkedIncidentIds || []).some(value => id(value) === id(incident._id))) ticket.linkedIncidentIds.push(incident._id);
  }
  await ticket.save({ session });

  const now = new Date(), reference = formatSupportTicketReference(ticket._id);
  let systemMessage = null;
  if (!conversation.escalation?.requested && !laterTerminalDecision) {
    [systemMessage] = await SupportMessage.create([{ conversationId: conversation._id, sender: 'system', text: `Sent to the team for review. Reference: ${reference}.`, sourcePage: context.sourcePage, pageContext: context.pageContext,
      metadata: { kind: 'support_escalation', ticketId: id(ticket._id), ticketReference: reference, handoffSummary: prepared.handoffSummary || '' } }], { session });
  }
  assistantMessage.metadata = { ...(assistantMessage.metadata || {}), ticketId: id(ticket._id), ticketReference: reference,
    escalation: { ...(assistantMessage.metadata?.escalation || {}), requested: true, requestedAt: now, ticketId: id(ticket._id), ticketReference: reference, ticketStatus: ticket.status } };
  if (laterTerminalDecision) assistantMessage.text = `The team marked this issue ${ticket.status}.`;
  await assistantMessage.save({ session });
  conversation.escalation = { ...(conversation.escalation?.toObject?.() || conversation.escalation || {}), requested: true, requestedAt: now, ticketId: ticket._id, note: `Sent to the team for review. Reference: ${reference}.` };
  conversation.status = laterTerminalDecision ? ticket.status : 'escalated';
  conversation.metadata = { ...(conversation.metadata || {}), support: { ...(conversation.metadata?.support || {}), escalationOffered: true, escalationSent: true,
    ...(laterTerminalDecision ? { lastAssistantReply: assistantMessage.text, proactiveIssueState: ticket.status, proactiveTicketStatus: ticket.status } : {}),
    ...(reopening ? { proactiveTicketId: id(ticket._id), proactiveTicketStatus: ticket.status, proactiveIssueState: 'open' } : {}) } };
  if (systemMessage) conversation.lastMessageAt = new Date(Math.max(new Date(conversation.lastMessageAt || 0).getTime(), systemMessage.createdAt.getTime()));
  await conversation.save({ session });
  if (laterTerminalDecision) return { conversation, assistantMessage, systemMessage, ticket, reused: true };

  const eventBase = {
    eventFamily: 'support', occurredAt: now, correlationId: `support-ticket:${ticket._id}`,
    actor: { actorType: 'user', userId: user._id, role: user.role, email: user.email || '' },
    subject: { entityType: 'support_ticket', entityId: id(ticket._id), publicId: reference },
    related: { userId: user._id, supportTicketId: ticket._id, incidentId: incident?._id || null, caseId: ticket.caseId, jobId: ticket.jobId, applicationId: ticket.applicationId },
    source: { surface: user.role, route: context.sourcePage || '', service: 'support', producer: 'service' },
    facts: { assistantMutationId: id(mutation.record._id), conversationId: id(conversation._id), assistantMessageId: id(assistantMessage._id), linkedToExisting,
      summary: submission.latestUserMessage || submission.subject, before: ticketBefore,
      after: { ...submission, role: user.role, email: user.email || '', ticketReference: reference, status: ticket.status, category: assistantReply.payload.category,
        primaryAsk: assistantReply.payload.primaryAsk, requesterRole: user.role, requesterName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || '',
        sourceSurface: user.role, sourcePage: context.sourcePage || '', viewName: context.pageContext?.viewName || '',
        caseTitle: submission.supportFactsSnapshot?.caseState?.title || ticket.supportFactsSnapshot?.caseState?.title || '',
        latestUserMessage: userMessage.text, patternKey: ticket.classification?.patternKey, escalationReason: ticket.escalationReason } },
    signals: { priority: 'high', founderVisible: true },
  };
  const [alertEvent] = await LpcEvent.create([{ ...eventBase, eventType: 'support.ticket.escalated', idempotencyKey: `support-mutation:${mutation.record._id}:alert` }], { session });
  const alert = await routeSupportTicketEscalated(alertEvent, { session });
  alertEvent.routing.status = alert.status; alertEvent.routing.actionKeys = alert.actionKeys; alertEvent.routing.lastRoutedAt = now;
  await alertEvent.save({ session });
  await LpcEvent.create([{ ...eventBase, eventType: 'support.submission.created', idempotencyKey: `support-mutation:${mutation.record._id}:routing`,
    routing: { status: incident ? 'pending' : 'skipped', lastRoutedAt: incident ? null : now } }], { session });
  return { conversation, assistantMessage, systemMessage, ticket, reused: Boolean(ticketBefore) };
}

async function deliverSupportIncidentRouting(event, { claimToken = '' } = {}) {
  const claim = { _id: event._id, 'routing.claimToken': claimToken, 'routing.leaseExpiresAt': { $gt: new Date() } };
  const assertClaim = async () => {
    claim['routing.leaseExpiresAt'] = { $gt: new Date() };
    if (!claimToken || !await LpcEvent.exists(claim)) throw new Error('Support routing requires a current worker claim.');
  };
  await assertClaim();
  const ticket = await SupportTicket.findById(event.related?.supportTicketId).lean();
  const incident = await Incident.findById(event.related?.incidentId).lean();
  if (!ticket || !incident) throw new Error('The staged support ticket or incident is unavailable.');
  const actionKeys = [id(ticket._id), id(incident._id)];
  if (['resolved', 'closed'].includes(ticket.status) || INCIDENT_TERMINAL_STATES.includes(incident.state)) return { status: 'skipped', actionKeys };
  const kickoff = event.routing.supportKickoff || await startEngineeringDiagnosisForIncident(incident);
  if (!kickoff?.ok) throw new Error('Engineering routing is unavailable; the support request remains saved.');
  await assertClaim();
  const checkpoint = await LpcEvent.updateOne(claim, { $set: { 'routing.supportKickoff': kickoff } });
  if (checkpoint.matchedCount !== 1) throw new Error('Support routing claim was superseded.');
  const patch = {};
  if (kickoff.runId || kickoff.started || kickoff.reused) {
    patch['escalation.engineeringReviewStarted'] = true;
    patch['escalation.engineeringReviewStartedAt'] = new Date();
    patch['escalation.diagnosisRunId'] = kickoff.runId || '';
    patch['metadata.support.engineeringReviewStarted'] = true;
    patch['metadata.support.diagnosisRunId'] = kickoff.runId || '';
  }
  if (kickoff.executionStarted) {
    patch['escalation.engineeringExecutionStarted'] = true;
    patch['escalation.engineeringExecutionStartedAt'] = new Date();
    patch['escalation.executionRunId'] = kickoff.executionRunId || '';
    patch['escalation.executionStatus'] = kickoff.executionStatus || '';
    patch['metadata.support.engineeringExecutionStarted'] = true;
    patch['metadata.support.executionRunId'] = kickoff.executionRunId || '';
    patch['metadata.support.executionStatus'] = kickoff.executionStatus || '';
  }
  if (Object.keys(patch).length) await SupportConversation.updateOne({ _id: event.facts.conversationId, 'escalation.ticketId': ticket._id,
    'metadata.support.restartedToConversationId': { $exists: false }, 'metadata.support.lifecycleClosedReason': { $exists: false } }, { $set: patch });
  publishConversationEvent(event.facts.conversationId, { type: 'conversation.updated', reason: 'conversation.routing_updated' });
  await assertClaim();
  const notifications = await notifyFounderSupportEngineeringIssue({ incident, ticket: { ...ticket, id: id(ticket._id), reference: formatSupportTicketReference(ticket._id) }, diagnosisKickoff: kickoff, linkedToExisting: event.facts?.linkedToExisting === true });
  if (notifications.some(notification => notification.status !== 'sent')) throw new Error('Founder email delivery is not confirmed. Review the saved delivery receipt.');
  return { status: 'routed', actionKeys };
}

async function processPendingSupportRouting({ maxJobs = 5 } = {}) {
  if (mongoose.connection.readyState !== 1) return { processed: 0, results: [] };
  const results = [];
  for (let index = 0; index < Math.min(10, Math.max(1, maxJobs)); index++) {
    const token = crypto.randomUUID(), now = new Date();
    const event = await LpcEvent.findOneAndUpdate({ eventType: 'support.submission.created', 'facts.assistantMutationId': { $exists: true }, 'routing.status': { $in: ['pending', 'failed'] },
      $and: [{ $or: [{ 'routing.leaseExpiresAt': null }, { 'routing.leaseExpiresAt': { $lte: now } }] },
        { $or: [{ 'routing.nextAttemptAt': null }, { 'routing.nextAttemptAt': { $lte: now } }] }] },
    { $set: { 'routing.claimToken': token, 'routing.leaseExpiresAt': new Date(Date.now() + LEASE_MS) }, $inc: { 'routing.attempts': 1 } }, { sort: { occurredAt: 1, _id: 1 }, returnDocument: 'after' });
    if (!event) break;
    const claim = { _id: event._id, 'routing.claimToken': token };
    const heartbeat = setInterval(() => { void LpcEvent.updateOne(claim, { $set: { 'routing.leaseExpiresAt': new Date(Date.now() + LEASE_MS) } }).catch(reportOperationalFailure("services.support.mutationRoutingService.routing_lease_renewal")); }, 30000);
    heartbeat.unref?.();
    try {
      await routeEvent(event, { claimToken: token });
      results.push({ id: id(event._id), ok: true });
    } catch (error) {
      await LpcEvent.updateOne(claim, { $set: { 'routing.status': 'failed', 'routing.error': String(error.message).slice(0, 4000), 'routing.claimToken': '', 'routing.leaseExpiresAt': null,
        'routing.nextAttemptAt': new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(event.routing.attempts, 6))) } });
      results.push({ id: id(event._id), ok: false });
    } finally { clearInterval(heartbeat); }
  }
  return { processed: results.length, results };
}

module.exports = { stageSupportIncidentRouting, deliverSupportIncidentRouting, processPendingSupportRouting };
