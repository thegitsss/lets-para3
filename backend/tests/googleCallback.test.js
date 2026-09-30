const request = require('supertest');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../services/authProviderClient', () => ({
  ...jest.requireActual('../services/authProviderClient'), createGoogleOAuthClient: jest.fn(),
}));
const { createGoogleOAuthClient } = require('../services/authProviderClient');
const { buildTestApp } = require('./helpers/testApp');
const app = buildTestApp();
const sendEmail = require('../utils/email');
const previous = Object.fromEntries(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'].map(key => [key, process.env[key]]));
beforeAll(async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'isolated-client', GOOGLE_CLIENT_SECRET: 'isolated-secret', GOOGLE_REDIRECT_URI: 'https://lpc.invalid/api/auth/google/callback' });
  await connect();
});
beforeEach(async () => { await clearDatabase(); jest.clearAllMocks(); sendEmail.mockResolvedValue({ ok: true }); });
afterAll(async () => {
  await closeDatabase();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
async function callback({ profile = {}, fail = false, next = '/attorney-v2.html#/matters?view=active' } = {}) {
  const start = await request(app).get('/api/auth/google').query({ intent: 'login', next });
  expect(start.status).toBe(302);
  const authorization = new URL(start.headers.location);
  const cookie = start.headers['set-cookie'].find(value => value.startsWith('lpc_google_oauth=')).split(';')[0];
  const provider = {
    getToken: jest.fn(async () => { if (fail) throw new Error('Synthetic provider secret'); return { tokens: { id_token: 'isolated-token' } }; }),
    verifyIdToken: jest.fn(async () => ({ getPayload: () => ({ sub: 'provider-user-123', email: 'google@example.com', email_verified: true, given_name: 'Jordan', family_name: 'Lee', nonce: authorization.searchParams.get('nonce'), ...profile }) })),
  };
  createGoogleOAuthClient.mockReturnValue(provider);
  const response = await request(app).get('/api/auth/google/callback').query({ state: authorization.searchParams.get('state'), code: 'isolated-code' }).set('Cookie', cookie);
  return { response, provider };
}
async function account(overrides = {}) {
  return User.create({ firstName: 'Jordan', lastName: 'Lee', email: 'google@example.com', password: 'A unique isolated passphrase', role: 'attorney', status: 'approved', emailVerified: true, authProviders: [{ provider: 'google', providerAccountId: 'provider-user-123' }], ...overrides });
}
test('a verified linked account establishes a managed session and preserves its permitted return', async () => {
  const user = await account();
  const { response, provider } = await callback();
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe('/attorney-v2.html#/matters?view=active');
  expect(provider.verifyIdToken).toHaveBeenCalledWith({ idToken: 'isolated-token', audience: 'isolated-client' });
  const cookie = response.headers['set-cookie'].find(value => value.startsWith('token=')).split(';')[0];
  const session = await request(app).get('/api/auth/me').set('Cookie', cookie);
  expect(session.body.user.id).toBe(String(user._id));
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(1);
});
test.each([
  [{ status: 'pending' }, 'pending'],
  [{ disabled: true }, 'disabled'],
  [{ emailVerified: false }, 'email_unverified'],
])('linked account restrictions remain authoritative: %j', async (overrides, error) => {
  await account(overrides);
  const { response } = await callback();
  expect(new URL(response.headers.location, 'https://lpc.invalid').searchParams.get('google_error')).toBe(error);
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('a matching email alone cannot link an existing account or establish a session', async () => {
  const user = await account({ authProviders: [] });
  const { response } = await callback();
  expect(response.headers.location).toContain('google_error=matching_email_unlinked');
  expect((await User.findById(user._id).select('+authProviders')).authProviders).toHaveLength(0);
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('a new verified identity receives signup context without platform access', async () => {
  const { response } = await callback();
  expect(response.headers.location).toBe('/signup.html?google=1&role=attorney');
  const cookies = response.headers['set-cookie'].map(value => value.split(';')[0]);
  const context = await request(app).get('/api/auth/google/signup-profile').set('Cookie', cookies);
  expect(context.body.profile).toMatchObject({ firstName: 'Jordan', lastName: 'Lee', email: 'google@example.com', emailVerified: true });
  expect(await User.countDocuments({})).toBe(0);
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test.each([{ nonce: 'wrong-nonce' }, { email_verified: false }])('invalid provider identity grants no access: %j', async profile => {
  await account();
  const { response } = await callback({ profile });
  expect(response.headers.location).toContain('google_error=identity_invalid');
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('provider failure returns to sign-in without exposing provider details', async () => {
  const { response } = await callback({ fail: true });
  expect(response.headers.location).toContain('google_error=oauth_failed');
  expect(JSON.stringify(response.headers)).not.toContain('Synthetic provider secret');
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('Google two-step sign-in creates no session until the emailed code is verified', async () => {
  const user = await account({ twoFactorEnabled: true, twoFactorMethod: 'email' });
  const { response } = await callback();
  expect(response.headers.location).toContain('google_2fa=1');
  expect(await AuthSession.countDocuments({})).toBe(0);
  const context = await request(app).get('/api/auth/google/2fa-context').set('Cookie', response.headers['set-cookie'].map(value => value.split(';')[0]));
  expect(context.body.method).toBe('email');
  const mail = sendEmail.mock.calls.find(call => call[1] === 'Your verification code');
  const code = mail[3].text.match(/code is (\d{6})/)[1];
  const verified = await request(app).post('/api/auth/2fa-verify').send({ challengeToken: context.body.challengeToken, code });
  expect(verified.status).toBe(200);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(1);
  const reused = await request(app).post('/api/auth/2fa-verify').send({ challengeToken: context.body.challengeToken, code });
  expect(reused.status).toBe(400);
});
for (const method of ['google', 'password']) test.each([{ error: true }, { disabled: true }, { accepted: [] }])(`${method} two-step delivery failure does not claim a code was sent: %j`, async delivery => {
  const user = await account({ twoFactorEnabled: true, twoFactorMethod: 'email' });
  sendEmail.mockResolvedValue(delivery);
  if (method === 'google') {
    const { response } = await callback();
    expect(response.headers.location).toContain('google_error=two_factor_unavailable');
  } else {
    const response = await request(app).post('/api/auth/login').send({ email: user.email, password: 'A unique isolated passphrase' });
    expect(response.status).toBe(500);
    expect(response.body.twoFactorRequired).toBeUndefined();
  }
  const saved = await User.findById(user._id).select('+twoFactorChallengeHash +twoFactorTempCode');
  expect(saved.twoFactorChallengeHash).toBeFalsy();
  expect(saved.twoFactorTempCode).toBeFalsy();
  expect(await AuthSession.countDocuments({})).toBe(0);
});
