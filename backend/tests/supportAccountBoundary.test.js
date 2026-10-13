const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: async () => { throw new Error('Unexpected synthetic storage call'); } }) }));
jest.mock('../utils/stripe', () => ({}));
jest.mock('../services/support/conversationService', () => ({
  getOrCreateOpenConversation: jest.fn(async () => ({ id: 'cccccccccccccccccccccccc', status: 'open' })),
  findConversationForUser: jest.fn(async () => null),
  listConversationMessages: jest.fn(async () => ({ conversation: { id: 'cccccccccccccccccccccccc' }, messages: [] })),
  createConversationMessage: jest.fn(async () => ({ conversation: { id: 'cccccccccccccccccccccccc' }, userMessage: { id: 'dddddddddddddddddddddddd' }, assistantMessage: { id: 'eeeeeeeeeeeeeeeeeeeeeeee' } })),
  recordConversationMessageFeedback: jest.fn(async () => ({ id: 'eeeeeeeeeeeeeeeeeeeeeeee' })),
  restartConversation: jest.fn(async () => ({ conversation: { id: 'cccccccccccccccccccccccc' }, messages: [] })),
  escalateConversation: jest.fn(async () => ({ conversation: { id: 'cccccccccccccccccccccccc' } })),
}));
jest.mock('../services/support/liveUpdateService', () => ({ subscribeToConversationEvents: jest.fn(() => () => {}) }));
const User = require('../models/User');
const { createAuthSession } = require('../services/authSessionService');
const service = require('../services/support/conversationService');
const email = require('../utils/email');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/support', require('../routes/support')); app.use('/api/auth', require('../routes/auth')); app.use('/api/users', require('../routes/users'));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
let owner, other, ownerCookie, otherCookie;
const token = (user, sid = '') => require('jsonwebtoken').sign({ id: String(user._id), role: user.role, av: user.authVersion || 0, ...(sid ? { sid } : {}) }, process.env.JWT_SECRET, { expiresIn: '1h' });
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other] = await User.create(['owner', 'other'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@assistant-boundary.test`, password: 'Synthetic123!', role: 'attorney', status: 'approved' })));
  ownerCookie = `token=${token(owner, (await createAuthSession(owner, {})).sessionId)}`;
  otherCookie = `token=${token(other, (await createAuthSession(other, {})).sessionId)}`;
});
const fields = (user = owner) => ({ expectedOwnerId: String(user._id), expectedRole: user.role });
const calls = () => Object.values(service).reduce((total, fn) => total + fn.mock.calls.length, 0);
const endpoints = [
  ['get', '/conversation', {}], ['get', '/conversation/cccccccccccccccccccccccc/messages', {}],
  ['post', '/conversation/cccccccccccccccccccccccc/messages', { text: 'Synthetic private question' }],
  ['post', '/conversation/cccccccccccccccccccccccc/messages/eeeeeeeeeeeeeeeeeeeeeeee/feedback', { rating: 'helpful' }],
  ['post', '/conversation/cccccccccccccccccccccccc/restart', {}],
  ['post', '/conversation/cccccccccccccccccccccccc/escalate', { messageId: 'eeeeeeeeeeeeeeeeeeeeeeee' }],
];
async function call(method, path, body, binding, cookie = ownerCookie) {
  let operation = request(app)[method](`/api/support${path}`).set('Cookie', cookie).timeout({ response: 3000, deadline: 5000 });
  return method === 'get' ? operation.query(binding || {}) : operation.send({ ...body, ...(binding || {}) });
}
test.each(endpoints)('guarded %s %s accepts its verified owner and retains omitted legacy compatibility', async (method, path, body) => {
  for (const binding of [fields(), null]) { const before = calls(); const result = await call(method, path, body, binding); expect(result.status).toBeGreaterThanOrEqual(200); expect(result.status).toBeLessThan(300); expect(calls()).toBe(before + 1); }
});
test.each(endpoints)('guarded %s %s rejects a replacement cookie before any conversation service work', async (method, path, body) => {
  const result = await call(method, path, body, fields(), otherCookie); expect(result.status).toBe(403); expect(result.body.code).toBe('SUPPORT_ACCOUNT_CHANGED'); expect(calls()).toBe(0);
});
test('guarded reads reject same-ID role changes based on the current database user, not stale JWT claims', async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { role: 'paralegal' } });
  const result = await call('get', '/conversation', {}, fields()); expect(result.status).toBe(403); expect(result.body.code).toBe('SUPPORT_ACCOUNT_CHANGED'); expect(calls()).toBe(0);
});
test.each(['missing-owner', 'missing-role', 'bad-owner', 'bad-role', 'duplicate-owner', 'wrong-location'])('malformed supplied %s bindings fail before conversation work', async kind => {
  let binding = fields();
  if (kind === 'missing-owner') delete binding.expectedOwnerId;
  if (kind === 'missing-role') delete binding.expectedRole;
  if (kind === 'bad-owner') binding.expectedOwnerId = 'invalid';
  if (kind === 'bad-role') binding.expectedRole = 'Attorney';
  if (kind === 'duplicate-owner') binding.expectedOwnerId = [String(owner._id), String(other._id)];
  const result = kind === 'wrong-location' ? await request(app).post('/api/support/conversation/cccccccccccccccccccccccc/restart').query(binding).set('Cookie', ownerCookie).send({}) : await call('get', '/conversation', {}, binding);
  expect(result.status).toBe(400); expect(result.body.code).toBe('SUPPORT_ACCOUNT_INVALID'); expect(calls()).toBe(0);
});
test('the event stream rejects foreign guarded identity before writing headers or subscribing', async () => {
  const result = await call('get', '/conversation/cccccccccccccccccccccccc/events', {}, fields(), otherCookie);
  expect(result.status).toBe(403); expect(result.headers['content-type']).toContain('application/json'); expect(require('../services/support/liveUpdateService').subscribeToConversationEvents).not.toHaveBeenCalled(); expect(calls()).toBe(0);
});
const reset = (body, cookie) => { const operation = request(app).post('/api/auth/request-password-reset').send(body); return cookie ? operation.set('Cookie', cookie) : operation; };
const resetState = async () => { const user = await User.collection.findOne({ _id: owner._id }); return { hash: user.resetPasswordTokenHash, expires: user.resetPasswordExpiresAt, requested: user.resetPasswordRequestedAt }; };
test('legacy anonymous reset remains available and a nonexistent email stays opaque', async () => {
  expect((await reset({ email: owner.email })).status).toBe(200); expect(email).toHaveBeenCalledTimes(1); expect(email.mock.calls[0][0]).toBe(owner.email);
  expect((await reset({ email: 'missing@assistant-boundary.test' })).body).toEqual({ ok: true }); expect(email).toHaveBeenCalledTimes(1);
});
test('an own guarded reset uses its managed cookie and writes the existing reset fields', async () => {
  const before = await resetState(); const result = await reset({ email: owner.email, ...fields() }, ownerCookie);
  expect(result.status).toBe(200); expect(result.body.ok).toBe(true); expect(email).toHaveBeenCalledTimes(1); expect(email.mock.calls[0][0]).toBe(owner.email); expect((await resetState()).hash).not.toEqual(before.hash);
});
test.each(['replacement', 'anonymous', 'unmanaged', 'wrong-role', 'wrong-email', 'malformed'])('guarded reset %s refuses before token mutation or email send', async kind => {
  const before = await resetState(); let body = { email: owner.email, ...fields() }, cookie = ownerCookie;
  if (kind === 'replacement') cookie = otherCookie;
  if (kind === 'anonymous') cookie = undefined;
  if (kind === 'unmanaged') cookie = `token=${token(owner)}`;
  if (kind === 'wrong-role') body.expectedRole = 'paralegal';
  if (kind === 'wrong-email') body.email = other.email;
  if (kind === 'malformed') delete body.expectedRole;
  const result = await reset(body, cookie); expect(result.status).toBe(kind === 'anonymous' ? 401 : kind === 'wrong-email' ? 409 : kind === 'malformed' ? 400 : 403); expect(email).not.toHaveBeenCalled(); expect(await resetState()).toEqual(before);
});
test('guarded reset requires its cookie even when a managed bearer token is otherwise valid', async () => {
  const result = await request(app).post('/api/auth/request-password-reset').set('Authorization', `Bearer ${ownerCookie.slice(6)}`).send({ email: owner.email, ...fields() });
  expect(result.status).toBe(401); expect(email).not.toHaveBeenCalled();
});
test('users/me already rejects a foreign expected owner without adding a new role-query contract', async () => {
  const own = await request(app).get('/api/users/me').set('Cookie', ownerCookie).query({ expectedOwnerId: String(owner._id) }); expect(own.status).toBe(200); expect(own.body.email).toBe(owner.email);
  const otherResult = await request(app).get('/api/users/me').set('Cookie', otherCookie).query({ expectedOwnerId: String(owner._id) }); expect(otherResult.status).toBe(403); expect(otherResult.body.email).toBeUndefined();
});
