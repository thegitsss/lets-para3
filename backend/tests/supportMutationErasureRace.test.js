const crypto = require('node:crypto');
const mongoose = require('mongoose');
process.env.STRIPE_SECRET_KEY = 'sk_test_support_erasure_local_only';
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User');
const Conversation = require('../models/SupportConversation');
const Mutation = require('../models/SupportMutation');
const service = require('../services/support/conversationService');
const { deactivateUserAccount, finalizeAccountDataRemoval } = require('../services/userDeletion');
beforeAll(connect, 90000); afterAll(closeDatabase); beforeEach(clearDatabase); afterEach(() => jest.restoreAllMocks());

test('a request paused before receipt creation cannot recreate private input after account erasure', async () => {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Reporter', email: `${crypto.randomUUID()}@erasure-race.test`, password: 'Synthetic123!', role: 'attorney', status: 'approved', emailVerified: true });
  const conversation = await Conversation.create({ userId: user._id, role: user.role, status: 'open' });
  const exec = mongoose.Query.prototype.exec;
  let entered, release, held = false, timer;
  const started = new Promise(resolve => entered = resolve), hold = new Promise(resolve => release = resolve);
  jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function (...args) {
    const result = await exec.apply(this, args);
    if (!held && this.model === Conversation && this.op === 'findOne' && this.getFilter().userId && this.getFilter()._id && this._fields?._id === 1) {
      held = true; entered(); await hold;
    }
    return result;
  });
  const work = service.createConversationMessage({ conversationId: String(conversation._id), user, requestId: crypto.randomUUID(), text: 'Private question from the old account',
    assistantReplyOverride: { reply: 'Synthetic reply', category: 'general_support', primaryAsk: 'general_support', needsEscalation: false, grounded: true } }).then(value => ({ value }), error => ({ error: error.code }));
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Pre-receipt ownership read was not reached')), 8000); })]);
    await deactivateUserAccount(user._id); await finalizeAccountDataRemoval(user._id);
  } finally { clearTimeout(timer); release(); }
  await work;
  expect(await User.findById(user._id)).toBeNull();
  expect(await Conversation.countDocuments({ userId: user._id })).toBe(0);
  expect(await Mutation.countDocuments({ ownerId: user._id })).toBe(0);
});
