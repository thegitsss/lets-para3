const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY = 'sk_test_support_admin_race';
process.env.EMAIL_DISABLE = 'true';
const User = require('../models/User');
const Conversation = require('../models/SupportConversation');
const Ticket = require('../models/SupportTicket');
const Mutation = require('../models/SupportMutation');
const Incident = require('../models/Incident');
const { LpcEvent } = require('../models/LpcEvent');
const service = require('../services/support/conversationService');
let user, conversation;
const reply = { reply: 'Your reported messaging problem has been sent to the team.', category: 'messaging', primaryAsk: 'general_support', activeTask: 'ANSWER', needsEscalation: true, escalationReason: 'messaging_should_be_available', confidence: 'high', grounded: true };
const send = (extra = {}) => service.createConversationMessage({ conversationId: String(conversation._id), user, requestId: crypto.randomUUID(), text: 'Messaging is still broken and the Send button fails.', assistantReplyOverride: reply, ...extra });
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); user = await User.create({ firstName: 'Synthetic', lastName: 'Reporter', email: `${crypto.randomUUID()}@admin-race.test`, password: 'Synthetic123!', role: 'attorney', status: 'approved', emailVerified: true });
  conversation = await Conversation.create({ userId: user._id, role: user.role, status: 'open' });
});
afterEach(() => jest.restoreAllMocks());

test.each([true, false])('a requester reply cancels an answered reminder (escalation: %s)', async escalating => {
  await send();
  const ticket = await Ticket.findOne();
  await Ticket.updateOne({ _id: ticket._id }, { $set: { status: 'waiting_on_info', followUpAt: new Date(Date.now() + 86400000), nextAction: 'Review new details' } });
  await send(escalating ? {} : { text: 'Here are the requested account details.', assistantReplyOverride: { ...reply, reply: 'Thank you for the details.', needsEscalation: false, escalationReason: '' } });
  const current = await Ticket.findById(ticket._id);
  expect(current.followUpAt).toBeNull();
  expect(current.nextAction).toBe('Review new details');
  expect(current.status).toBe('in_review');
});

for (const escalating of [true, false]) test.each(['resolved', 'closed'])(`${escalating ? 'Escalation' : 'Ordinary reply'} preserves a later admin %s decision without a duplicate handoff`, async status => {
  await send(); const ticket = await Ticket.findOne();
  const initialIncidents = await Incident.countDocuments();
  expect(ticket).toBeTruthy();
  let release, entered, held = false, timer;
  const hold = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  const exec = mongoose.Query.prototype.exec;
  jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function (...args) {
    const value = await exec.apply(this, args);
    if (this.model === Mutation && this.op === 'findOneAndUpdate' && this.getUpdate()?.$set?.phase === 'prepared' && !held) { held = true; entered(); await hold; }
    return value;
  });
  const work = send(escalating ? {} : { text: 'Explain my account preferences.', assistantReplyOverride: { ...reply, reply: 'Check your Preferences page.', needsEscalation: false, escalationReason: '' } }).then(value => ({ value }), error => ({ error: error.code }));
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Prepared boundary was not reached')), 8000); })]);
    await Ticket.updateOne({ _id: ticket._id }, { $set: { status, lastAdminReplyAt: new Date(), resolvedAt: new Date() } });
    await Conversation.updateOne({ _id: conversation._id }, { $set: { status } });
  } finally { clearTimeout(timer); release(); }
  const outcome = await work; expect(outcome.error).toBeUndefined();
  expect(await Ticket.countDocuments()).toBe(1); expect(await Incident.countDocuments()).toBe(initialIncidents);
  expect(await LpcEvent.countDocuments({ eventType: 'support.submission.created' })).toBe(1);
  expect((await Conversation.findById(conversation._id)).status).toBe(status);
  expect(outcome.value.conversation.status).toBe(status);
});
