const crypto = require('node:crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY = 'sk_test_support_routing_local_only';
process.env.EMAIL_DISABLE = 'true';
jest.mock('../services/lpcEvents/supportRoutingService', () => ({
  ...jest.requireActual('../services/lpcEvents/supportRoutingService'),
  startEngineeringDiagnosisForIncident: jest.fn(async () => ({ ok: true, started: true, runId: 'synthetic-diagnosis', executionStarted: true, executionRunId: 'synthetic-execution', executionStatus: 'in_progress' })),
}));
jest.mock('../services/incidents/notificationService', () => ({
  ...jest.requireActual('../services/incidents/notificationService'),
  notifyFounderSupportEngineeringIssue: jest.fn(async () => []),
}));
const User = require('../models/User');
const Conversation = require('../models/SupportConversation');
const Message = require('../models/SupportMessage');
const Ticket = require('../models/SupportTicket');
const Incident = require('../models/Incident');
const IncidentArtifact = require('../models/IncidentArtifact');
const { LpcEvent } = require('../models/LpcEvent');
const { LpcAction } = require('../models/LpcAction');
const service = require('../services/support/conversationService');
const routing = require('../services/support/mutationRoutingService');
const diagnosis = require('../services/lpcEvents/supportRoutingService').startEngineeringDiagnosisForIncident;
const founderNotification = require('../services/incidents/notificationService').notifyFounderSupportEngineeringIssue;
let user, conversation;
const reply = { reply: 'Your reported messaging problem has been sent to the team.', category: 'messaging', primaryAsk: 'general_support', activeTask: 'ANSWER', needsEscalation: true, escalationReason: 'messaging_should_be_available', confidence: 'high', grounded: true };
const send = (requestId = crypto.randomUUID(), extra = {}) => service.createConversationMessage({ conversationId: String(conversation._id), user, requestId, text: 'Messaging is broken and I cannot send. The Send button is stuck with an error.', assistantReplyOverride: reply, ...extra });
beforeAll(connect, 90000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  user = await User.create({ firstName: 'Synthetic', lastName: 'Reporter', email: `${crypto.randomUUID()}@routing.test`, password: 'Synthetic123!', role: 'paralegal', status: 'approved', emailVerified: true });
  conversation = await Conversation.create({ userId: user._id, role: user.role, status: 'open' });
});
afterEach(() => jest.restoreAllMocks());
test('an automatic escalation atomically saves a ticket, incident, alert and exact replay before provider work', async () => {
  const requestId = crypto.randomUUID();
  const first = await send(requestId), replay = await send(requestId);
  expect(replay.userMessage.id).toBe(first.userMessage.id); expect(replay.assistantMessage.id).toBe(first.assistantMessage.id);
  expect(first.conversation.escalation.requested).toBe(true);
  expect(first.conversation.escalation.engineeringReviewStarted).toBe(false);
  expect(await Ticket.countDocuments()).toBe(1); expect(await Incident.countDocuments()).toBe(1);
  expect(await LpcAction.countDocuments({ actionType: 'founder_alert' })).toBe(1);
  expect(await LpcEvent.countDocuments({ eventType: 'support.submission.created', 'routing.status': 'pending' })).toBe(1);
  expect(await Message.countDocuments({ sender: 'assistant' })).toBe(1);
  expect(diagnosis).not.toHaveBeenCalled();
});
test('a failed routing-intent write rolls back its whole handoff and the same request recovers once', async () => {
  const create = LpcEvent.create.bind(LpcEvent); let injected = false;
  jest.spyOn(LpcEvent, 'create').mockImplementation(async (...args) => {
    if (!injected && args[0][0]?.eventType === 'support.submission.created') { injected = true; throw Error('Synthetic routing intent failure'); }
    return create(...args);
  });
  const requestId = crypto.randomUUID(); await expect(send(requestId)).rejects.toThrow(); expect(injected).toBe(true);
  expect(await Ticket.countDocuments()).toBe(0); expect(await Incident.countDocuments()).toBe(0); expect(await IncidentArtifact.countDocuments()).toBe(0); expect(await LpcAction.countDocuments()).toBe(0);
  expect(await Message.countDocuments({ sender: 'assistant' })).toBe(0);
  await send(requestId); expect(await Ticket.countDocuments()).toBe(1); expect(await Incident.countDocuments()).toBe(1); expect(await Message.countDocuments({ sender: 'user' })).toBe(1);
});
test('the existing worker drains a committed handoff after the sending process is gone', async () => {
  await send(); const first = await routing.processPendingSupportRouting();
  expect(first).toMatchObject({ processed: 1, results: [{ ok: true }] });
  expect(diagnosis).toHaveBeenCalledTimes(1);
  expect(await LpcEvent.countDocuments({ eventType: 'support.submission.created', 'routing.status': 'routed' })).toBe(1);
  expect((await Conversation.findById(conversation._id)).metadata.support.engineeringReviewStarted).toBe(true);
  expect((await service.listConversationMessages({ conversationId: String(conversation._id), userId: user._id })).conversation.escalation.engineeringReviewStarted).toBe(true);
  expect((await routing.processPendingSupportRouting()).processed).toBe(0);
});
test('routing failure remains retryable without duplicating the saved incident or ticket', async () => {
  await send(); diagnosis.mockRejectedValueOnce(Error('Synthetic provider unavailable'));
  expect((await routing.processPendingSupportRouting()).results[0].ok).toBe(false);
  const event = await LpcEvent.findOne({ eventType: 'support.submission.created' }); expect(event.routing.status).toBe('failed'); expect(event.routing.error).toContain('Synthetic provider unavailable');
  expect((await routing.processPendingSupportRouting()).processed).toBe(0);
  await LpcEvent.updateOne({ _id: event._id }, { $set: { 'routing.nextAttemptAt': new Date(0) } });
  expect((await routing.processPendingSupportRouting()).results[0].ok).toBe(true);
  expect(await Ticket.countDocuments()).toBe(1); expect(await Incident.countDocuments()).toBe(1);
});
test('two workers claim one routing intent and a resolved ticket prevents delayed engineering work', async () => {
  await send(); let release, started; const held = new Promise(resolve => release = resolve), entered = new Promise(resolve => started = resolve);
  diagnosis.mockImplementationOnce(async () => { started(); await held; return { ok: true, started: true, runId: 'synthetic' }; });
  const first = routing.processPendingSupportRouting();
  try { await entered; expect((await routing.processPendingSupportRouting()).processed).toBe(0); }
  finally { release(); await first; }
  await LpcEvent.updateMany({ eventType: 'support.submission.created' }, { $set: { 'routing.status': 'pending' } });
  await Ticket.updateMany({}, { $set: { status: 'resolved' } });
  const before = diagnosis.mock.calls.length;
  expect((await routing.processPendingSupportRouting()).results[0].ok).toBe(true); expect(diagnosis).toHaveBeenCalledTimes(before);
});
test('reopening retains the earlier ticket and terminal incident while creating one new active incident', async () => {
  await send(); const ticket = await Ticket.findOne(); const oldIncident = await Incident.findOne();
  await Ticket.updateOne({ _id: ticket._id }, { $set: { status: 'resolved', resolvedAt: new Date(), resolutionIsStable: true } });
  await Incident.updateOne({ _id: oldIncident._id }, { $set: { state: 'resolved', userVisibleStatus: 'fixed_live' } });
  const requestId = crypto.randomUUID(); const extra = { assistantReplyOverride: { ...reply, primaryAsk: 'issue_reopen' }, promptAction: { intent: 'issue_reopen', ticketId: String(ticket._id), issueState: 'resolved' } };
  await send(requestId, extra); await send(requestId, extra);
  const refreshed = await Ticket.findById(ticket._id);
  expect(await Ticket.countDocuments()).toBe(1); expect(await Incident.countDocuments()).toBe(2);
  expect(refreshed.status).toBe('in_review'); expect(refreshed.resolvedAt).toBeNull(); expect(refreshed.linkedIncidentIds).toHaveLength(2);
});

const ordinaryReply = { ...reply, reply: 'Check your saved preferences.', category: 'general_support', needsEscalation: false, escalationReason: '' };
const ordinarySend = text => send(crypto.randomUUID(), { text, assistantReplyOverride: ordinaryReply });
const escalate = (messageId, extra = {}) => service.escalateConversation({ conversationId: String(conversation._id), user, messageId, ...extra });

test('an invalid explicit message ID cannot silently escalate a different reply', async () => {
  await ordinarySend('Account preferences question.');
  await expect(escalate('invalid-answer-id')).rejects.toMatchObject({ code: 'SUPPORT_MESSAGE_INVALID', statusCode: 400 });
  expect(await Ticket.countDocuments()).toBe(0); expect(await LpcAction.countDocuments()).toBe(0);
});

test('manual escalation replays the saved acknowledgment with one ticket and operator alert', async () => {
  const sent = await ordinarySend('My saved preferences do not match.');
  const first = await escalate(sent.assistantMessage.id), replay = await escalate(sent.assistantMessage.id);
  expect(replay.ticket.id).toBe(first.ticket.id); expect(replay.systemMessage.id).toBe(first.systemMessage.id);
  expect(await Ticket.countDocuments()).toBe(1); expect(await LpcAction.countDocuments({ actionType: 'founder_alert' })).toBe(1);
  expect(await Message.countDocuments({ 'metadata.kind': 'support_escalation' })).toBe(1);
  expect(first.conversation.escalation.engineeringReviewStarted).toBe(false); expect(diagnosis).not.toHaveBeenCalled();
});

test('manual escalation rolls back a failed acknowledgment and safely retries the same button', async () => {
  const sent = await ordinarySend('My preferences need review.'); const create = Message.create.bind(Message);
  jest.spyOn(Message, 'create').mockImplementationOnce(async (...args) => {
    expect(args[0][0].metadata.kind).toBe('support_escalation'); throw Error('Synthetic acknowledgment failure');
  });
  await expect(escalate(sent.assistantMessage.id)).rejects.toThrow();
  expect(await Ticket.countDocuments()).toBe(0); expect(await LpcAction.countDocuments()).toBe(0);
  Message.create.mockImplementation(create);
  const recovered = await escalate(sent.assistantMessage.id); expect(recovered.ticket.id).toBeTruthy(); expect(await Ticket.countDocuments()).toBe(1);
});

test('concurrent manual escalations share the original question instead of the latest unrelated turn', async () => {
  const first = await ordinarySend('First question about preferences.');
  await ordinarySend('Later question about my biography.');
  const results = await Promise.allSettled([escalate(first.assistantMessage.id), escalate(first.assistantMessage.id)]);
  expect(results.filter(result => result.status === 'fulfilled').length).toBeGreaterThan(0);
  expect(await Ticket.countDocuments()).toBe(1); expect((await Ticket.findOne()).latestUserMessage).toBe('First question about preferences.');
  expect(await Message.countDocuments({ 'metadata.kind': 'support_escalation' })).toBe(1);
});

test('manual escalation cannot mutate an archived thread after restart', async () => {
  const sent = await ordinarySend('Preferences question before restarting.');
  await service.restartConversation({ conversationId: String(conversation._id), user, requestId: crypto.randomUUID() });
  await expect(escalate(sent.assistantMessage.id)).rejects.toMatchObject({ code: 'SUPPORT_CONVERSATION_CHANGED' });
  expect(await Ticket.countDocuments()).toBe(0); expect(await LpcAction.countDocuments()).toBe(0);
});

test('the actual incident runner drains support routing even with no incident job claim', async () => {
  await send(); const claimJob = jest.fn(async () => null);
  const run = await require('../scripts/incident-runner').runIncidentRunnerOnce({ maxJobs: 2 }, { claimJob });
  expect(run.ok).toBe(true); expect(claimJob).toHaveBeenCalled(); expect(diagnosis).toHaveBeenCalledTimes(1);
  expect(run.processed).toBe(1); expect(run.results[0].jobType).toBe('support_routing');
  expect(await LpcEvent.countDocuments({ eventType: 'support.submission.created', 'routing.status': 'routed' })).toBe(1);
});

test('email retry reuses confirmed engineering work instead of starting it again', async () => {
  await send(); founderNotification.mockResolvedValueOnce([{ status: 'failed' }]);
  expect((await routing.processPendingSupportRouting()).results[0].ok).toBe(false);
  const event = await LpcEvent.findOne({ eventType: 'support.submission.created' });
  expect(event.routing.supportKickoff.runId).toBe('synthetic-diagnosis');
  await LpcEvent.updateOne({ _id: event._id }, { $set: { 'routing.nextAttemptAt': new Date(0) } });
  expect((await routing.processPendingSupportRouting()).results[0].ok).toBe(true);
  expect(diagnosis).toHaveBeenCalledTimes(1); expect(founderNotification).toHaveBeenCalledTimes(2);
});

test('a superseded worker cannot notify or mark a new owners routing receipt complete', async () => {
  await send(); let release, entered;
  const hold = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  diagnosis.mockImplementationOnce(async () => { entered(); await hold; return { ok: true, started: true, runId: 'superseded-diagnosis' }; });
  const work = routing.processPendingSupportRouting();
  try {
    await started;
    await LpcEvent.updateOne({ eventType: 'support.submission.created' }, { $set: { 'routing.claimToken': 'replacement-worker', 'routing.leaseExpiresAt': new Date(Date.now() + 900000) } });
  } finally { release(); }
  expect((await work).results[0].ok).toBe(false); expect(founderNotification).not.toHaveBeenCalled();
  const event = await LpcEvent.findOne({ eventType: 'support.submission.created' });
  expect(event.routing.claimToken).toBe('replacement-worker'); expect(event.routing.status).toBe('pending');
  expect(event.routing.supportKickoff).toBeNull();
});

test('expired routing claims recover but direct event routing cannot bypass the worker lease', async () => {
  await send(); const event = await LpcEvent.findOne({ eventType: 'support.submission.created' });
  await expect(require('../services/lpcEvents/routerService').routeEvent(event)).rejects.toThrow('worker claim');
  expect(diagnosis).not.toHaveBeenCalled();
  await LpcEvent.updateOne({ _id: event._id }, { $set: { 'routing.claimToken': 'stopped-worker', 'routing.leaseExpiresAt': new Date(0) } });
  expect((await routing.processPendingSupportRouting()).results[0].ok).toBe(true); expect(diagnosis).toHaveBeenCalledTimes(1);
});
