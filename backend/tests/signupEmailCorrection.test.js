const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Proof = require('../models/EmailVerificationToken');
const AuditLog = require('../models/AuditLog');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async email => ({ accepted: [email] })));
const sendEmail = require('../utils/email');
const { sendVerificationEmail } = require('../utils/emailVerification');
const app = express(); app.set('trust proxy', 1);
app.use(cookieParser(), express.json()); app.use('/api/auth', require('../routes/auth'));
const password = 'An isolated signup correction passphrase';
let ip = 1;
const post = (path, body) => request(app).post('/api/auth/' + path).set('X-Forwarded-For', `192.0.2.${ip}`).send(body);
const change = (email, newEmail = 'corrected@example.test', extra = {}) => post('signup-email', { email, password, newEmail, ...extra });
const tokenFrom = mail => decodeURIComponent(mail[2].match(/token=([^&\s"'<>]+)/)[1]);
const verify = token => post('verify-email', { token });
async function fixture(role = 'attorney', extra = {}) {
  return User.create({ firstName: 'Signup', lastName: 'Correction', email: `${role}.typo@example.test`, password,
    role, status: 'pending', emailVerified: false, state: 'CA', resumeURL: 'retained/resume.pdf', barNumber: 'CA-1234', ...extra });
}
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { ip++; await clearDatabase(); sendEmail.mockReset().mockImplementation(async email => ({ accepted: [email] })); });
afterEach(() => { jest.restoreAllMocks(); process.env.ENABLE_CSRF = 'false'; });

test.each(['attorney', 'paralegal'])('%s corrects an unverified signup, invalidates prior links, keeps its identity and admission state', async role => {
  const user = await fixture(role);
  await sendVerificationEmail({ user }); const old = tokenFrom(sendEmail.mock.calls.at(-1));
  const legacy = jwt.sign({ purpose: 'verify-email', uid: String(user._id), email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const response = await change(user.email);
  expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true, email: 'corrected@example.test' });
  const staged = await User.findById(user._id);
  expect(staged).toMatchObject({ email: user.email, pendingEmail: 'corrected@example.test', emailVerified: false, status: 'pending', emailVerificationVersion: 1 });
  expect((await verify(old)).status).toBe(400); expect((await verify(legacy)).status).toBe(400);
  expect(sendEmail.mock.calls.at(-1)[0]).toBe('corrected@example.test');
  const latest = tokenFrom(sendEmail.mock.calls.at(-1));
  expect((await verify(latest)).body).toMatchObject({ ok: true, accountStatus: 'pending' });
  const saved = await User.findById(user._id);
  expect(saved).toMatchObject({ email: 'corrected@example.test', pendingEmail: null, status: 'pending', emailVerified: true, resumeURL: user.resumeURL, barNumber: user.barNumber });
  expect(await User.countDocuments({ role })).toBe(1);
  expect((await post('login', { email: saved.email, password })).status).toBe(403);
  expect(await AuditLog.countDocuments({ action: 'auth.signup.email_change_requested', targetId: user._id })).toBe(1);
});

test('a verification link alone cannot authorize correction, and unknown and wrong-password requests look the same', async () => {
  const user = await fixture(); await sendVerificationEmail({ user });
  const token = tokenFrom(sendEmail.mock.calls.at(-1)); sendEmail.mockClear();
  const wrong = await change(user.email, undefined, { password: 'incorrect' });
  const unknown = await change('missing@example.test');
  const bearer = await change(user.email, undefined, { password: '', token });
  expect(wrong.status).toBe(401); expect(unknown.status).toBe(401); expect(bearer.status).toBe(401);
  expect(wrong.body).toEqual(unknown.body); expect(wrong.body).toEqual(bearer.body);
  expect((await User.findById(user._id)).pendingEmail).toBeNull(); expect(sendEmail).not.toHaveBeenCalled();
});

test.each([{ emailVerified: true }, { status: 'approved' }, { status: 'denied' }, { disabled: true }])('closed signups cannot use correction: %j', async extra => {
  const user = await fixture('attorney', extra); const response = await change(user.email);
  expect([401, 409]).toContain(response.status); expect((await User.findById(user._id)).pendingEmail).toBeNull();
});

test('existing and reserved addresses cannot be claimed; repeated requests are throttled', async () => {
  const user = await fixture(); await fixture('paralegal', { email: 'occupied@example.test', pendingEmail: 'reserved@example.test' });
  expect((await change(user.email, 'occupied@example.test')).status).toBe(409);
  expect((await change(user.email, 'reserved@example.test')).status).toBe(409);
  expect((await change(user.email, user.email)).status).toBe(400);
  expect((await change(user.email, 'invalid')).status).toBe(400);
  expect((await change(user.email)).status).toBe(200);
  const cooldown = await change(user.email, 'another@example.test');
  expect(cooldown.status).toBe(429); expect(cooldown.headers['retry-after']).toBe('60');
});

test('resending from either address sends only to the pending new inbox and cannot revive the old address', async () => {
  const user = await fixture(); await change(user.email); sendEmail.mockClear();
  await post('resend-verification', { email: user.email });
  await post('resend-verification', { email: 'corrected@example.test' });
  expect(sendEmail.mock.calls).toHaveLength(2); expect(sendEmail.mock.calls.every(mail => mail[0] === 'corrected@example.test')).toBe(true);
  expect((await verify(tokenFrom(sendEmail.mock.calls[0]))).status).toBe(200);
});

test('an unconfirmed delivery retains the change and can recover by resending', async () => {
  const user = await fixture(); sendEmail.mockRejectedValueOnce(new Error('Synthetic delivery failure'));
  const response = await change(user.email); expect(response.status).toBe(503);
  expect(response.body).toMatchObject({ saved: true, email: 'corrected@example.test' });
  expect((await User.findById(user._id)).pendingEmail).toBe('corrected@example.test');
  expect((await post('resend-verification', { email: user.email })).status).toBe(200);
  expect((await verify(tokenFrom(sendEmail.mock.calls.at(-1)))).status).toBe(200);
});

test('transaction failure rolls back pending email, invalidation and audit together', async () => {
  const user = await fixture(); await sendVerificationEmail({ user }); const token = tokenFrom(sendEmail.mock.calls.at(-1));
  const fail = jest.spyOn(AuditLog, 'logFromReq').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  expect((await change(user.email)).status).toBe(503); fail.mockRestore();
  expect(await User.findById(user._id)).toMatchObject({ emailVerificationVersion: 0, pendingEmail: null });
  expect((await verify(token)).status).toBe(200);
});

test('recent provider signup proof is browser-bound and scoped; it expires and cannot change a verified account', async () => {
  const user = await fixture('attorney', { authProviders: [{ provider: 'microsoft', providerAccountId: 'synthetic-provider' }] });
  let cookie;
  require('../routes/signupEmail').rememberSignup({}, { cookie: (name, token, options) => { cookie = `${name}=${token}`;
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/api/auth/signup-email' }); } }, user);
  expect((await request(app).get('/api/auth/signup-email')).body).toEqual({ recentSignup: false });
  expect((await request(app).get('/api/auth/signup-email').set('Cookie', cookie)).body).toMatchObject({ recentSignup: true, email: user.email });
  const response = await request(app).post('/api/auth/signup-email').set('X-Forwarded-For', `192.0.2.${ip}`).set('Cookie', cookie).send({ newEmail: 'provider.corrected@example.test' });
  expect(response.status).toBe(200);
  expect((await request(app).get('/api/auth/signup-email').set('Cookie', cookie)).body).toEqual({ recentSignup: false });
  const expired = jwt.sign({ purpose: 'signup-email-correction', uid: String(user._id), av: 0, ev: 1 }, process.env.JWT_SECRET, { expiresIn: -1 });
  expect((await request(app).get('/api/auth/signup-email').set('Cookie', `lpc_signup_email=${expired}`)).body).toEqual({ recentSignup: false });
});

test('CSRF is required and credential guessing shares the existing account lock', async () => {
  const user = await fixture(); process.env.ENABLE_CSRF = 'true';
  expect((await change(user.email)).status).toBe(403); process.env.ENABLE_CSRF = 'false';
  for (let i = 0; i < 5; i++) expect((await change(user.email, undefined, { password: 'wrong' })).status).toBe(401);
  expect((await change(user.email)).status).toBe(401);
  expect((await User.findById(user._id)).lockedUntil.getTime()).toBeGreaterThan(Date.now());
});

test('simultaneous verification and correction cannot both commit conflicting addresses', async () => {
  const user = await fixture(); await sendVerificationEmail({ user }); const old = tokenFrom(sendEmail.mock.calls.at(-1));
  const [correction, confirmation] = await Promise.all([change(user.email), verify(old)]);
  const saved = await User.findById(user._id);
  if (saved.emailVerified) {
    expect(confirmation.status).toBe(200); expect(correction.status).toBe(409);
    expect(saved.pendingEmail).toBeNull(); expect(saved.emailVerificationVersion).toBe(0);
  } else {
    expect(correction.status).toBe(200); expect(confirmation.status).toBe(400);
    expect(saved.pendingEmail).toBe('corrected@example.test'); expect(saved.emailVerificationVersion).toBe(1);
  }
});

test('each subsequent correction invalidates the earlier corrected-inbox proof too', async () => {
  const user = await fixture(); await change(user.email); const first = tokenFrom(sendEmail.mock.calls.at(-1));
  await User.updateOne({ _id: user._id }, { $set: { pendingEmailRequestedAt: new Date(0) } });
  expect((await change(user.email, 'second@example.test')).status).toBe(200);
  expect((await verify(first)).status).toBe(400);
  expect((await verify(tokenFrom(sendEmail.mock.calls.at(-1)))).status).toBe(200);
  expect((await User.findById(user._id)).email).toBe('second@example.test');
});

test('IP throttling also protects unknown-account requests', async () => {
  for (let n = 0; n < 10; n++) expect((await change('unknown@example.test')).status).toBe(401);
  expect((await change('unknown@example.test')).status).toBe(429);
});
