const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const AuthChallenge = require('../models/AuthChallenge');
const { createAuthSession } = require('../services/authSessionService');
const { generateTotpToken } = require('../services/mfaService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/account', require('../routes/account'));
app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Server error' }));
const password = 'A secure current test passphrase';
let user, cookie, sessionId;
async function session(account = user) {
  const session = await createAuthSession(account, { headers: { 'user-agent': 'Synthetic browser' } });
  const fresh = await User.findById(account._id).select('+authVersion');
  return { id: session.sessionId, cookie: `token=${jwt.sign({ id: String(account._id), role: account.role, status: account.status, sid: session.sessionId, av: fresh.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };
}
const read = () => request(app).get(`/api/account/2fa?expectedOwnerId=${user._id}`).set('Cookie', cookie);
const change = (path, values) => request(app).post(`/api/account/${path}`).set('Cookie', cookie).send({ expectedOwnerId: String(user._id), ...values });
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  user = await User.create({ firstName: 'Security', lastName: 'Counsel', email: 'security-boundary@example.test', password, role: 'attorney', status: 'approved', emailVerified: true });
  const current = await session(); cookie = current.cookie; sessionId = current.id;
});
afterEach(() => jest.restoreAllMocks());

test.each(['/2fa', '/passkeys', '/sessions'])('security read %s rejects a changed expected owner before returning records', async path => {
  const response = await request(app).get(`/api/account${path}?expectedOwnerId=64b000000000000000000099`).set('Cookie', cookie);
  expect(response.status).toBe(403); expect(response.body.code).toBe('ACCOUNT_CHANGED');
});

test.each([
  ['post', '/update-password', { currentPassword: password, newPassword: 'An entirely newer secure passphrase' }],
  ['post', '/2fa-toggle', { currentPassword: password, enabled: true, method: 'email' }],
  ['post', '/2fa/authenticator/setup', { currentPassword: password }],
  ['post', '/2fa/authenticator/confirm', { challengeId: 'synthetic', code: '123456' }],
  ['post', '/2fa-backup-codes', { currentPassword: password }],
  ['post', '/passkeys/registration-options', { currentPassword: password }],
  ['post', '/passkeys/register', { challengeId: 'synthetic', response: {} }],
  ['delete', '/passkeys/64b000000000000000000010', { currentPassword: password }],
  ['delete', '/sessions/synthetic-session', {}],
  ['post', '/sessions/revoke-others', {}],
])('security mutation %s %s rejects a replaced account before password/challenge/session effects', async (method, path, body) => {
  const response = await request(app)[method](`/api/account${path}`).set('Cookie', cookie).send({ ...body, expectedOwnerId: '64b000000000000000000099' });
  expect(response.status).toBe(403); expect(response.body.code).toBe('ACCOUNT_CHANGED');
  expect((await User.findById(user._id)).twoFactorEnabled).toBe(false);
  expect(await AuthChallenge.countDocuments()).toBe(0);
  expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(1);
});

test('private security state has an opaque revision and identifies the managed-session boundary', async () => {
  const response = await read(); expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ enabled: false, hasBackupCodes: false, sessionManaged: true });
  expect(response.body.securityRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body).not.toHaveProperty('password'); expect(response.body).not.toHaveProperty('totpSecretEncrypted');
});

test('MFA changes reject a stale security snapshot while unrelated profile changes remain allowed', async () => {
  const initial = (await read()).body.securityRevision;
  await User.updateOne({ _id: user._id }, { $set: { lawFirm: 'Independent firm' } });
  const enabled = await change('2fa-toggle', { enabled: true, method: 'email', currentPassword: password, expectedSecurityRevision: initial });
  expect(enabled.status).toBe(200);
  const stale = await change('2fa-toggle', { enabled: false, currentPassword: password, expectedSecurityRevision: initial });
  expect(stale.status).toBe(409); expect(stale.body.code).toBe('ACCOUNT_CONFLICT');
  expect((await User.findById(user._id)).twoFactorEnabled).toBe(true);
});

test('a concurrent backup-code rotation cannot be overwritten by an older tab', async () => {
  await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true, twoFactorMethod: 'email' } });
  const revision = (await read()).body.securityRevision;
  const first = await change('2fa-backup-codes', { currentPassword: password, expectedSecurityRevision: revision });
  expect(first.status).toBe(200); expect(first.body.codes).toHaveLength(8);
  const firstCodes = (await User.findById(user._id).select('+twoFactorBackupCodes')).twoFactorBackupCodes;
  const second = await change('2fa-backup-codes', { currentPassword: password, expectedSecurityRevision: revision });
  expect(second.status).toBe(409);
  expect((await User.findById(user._id).select('+twoFactorBackupCodes')).twoFactorBackupCodes).toEqual(firstCodes);
});

test('a guarded MFA write catches an intervening update at the database save', async () => {
  const revision = (await read()).body.securityRevision;
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    await update({ _id: user._id }, { $set: { twoFactorEnabled: true, twoFactorMethod: 'authenticator' } });
    return update(...args);
  });
  const response = await change('2fa-toggle', { enabled: true, method: 'email', currentPassword: password, expectedSecurityRevision: revision });
  expect(response.status).toBe(409);
  expect((await User.findById(user._id)).twoFactorMethod).toBe('authenticator');
});

test('authenticator confirmation cannot replace security settings changed after setup began', async () => {
  const revision = (await read()).body.securityRevision;
  const setup = await change('2fa/authenticator/setup', { currentPassword: password, expectedSecurityRevision: revision });
  expect(setup.status).toBe(200);
  await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true, twoFactorMethod: 'email' } });
  const latest = (await read()).body.securityRevision;
  const response = await change('2fa/authenticator/confirm', { challengeId: setup.body.challengeId, code: generateTotpToken(setup.body.manualSecret).token, expectedSecurityRevision: latest });
  expect(response.status).toBe(409);
  expect((await User.findById(user._id)).twoFactorMethod).toBe('email');
});

test('revoke-others requires a known managed current session for guarded callers', async () => {
  const legacy = `token=${jwt.sign({ id: String(user._id), role: user.role, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const response = await request(app).post('/api/account/sessions/revoke-others').set('Cookie', legacy).send({ expectedOwnerId: String(user._id) });
  expect(response.status).toBe(409); expect(response.body.code).toBe('SECURITY_SESSION_REQUIRED');
  expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(1);
});
