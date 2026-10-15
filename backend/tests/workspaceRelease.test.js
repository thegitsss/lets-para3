process.env.ENABLE_CSRF = 'true';
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), WorkspaceRelease = require('../models/WorkspaceRelease'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
const { defaults } = require('../services/workspaceRelease');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/auth', require('../routes/auth')); app.use('/api/admin', require('../routes/admin'));
let admin, attorney, paralegal;
async function actor(role, status = 'approved') {
  const user = await User.create({ firstName: 'Release', lastName: role, email: `${role}-${status}@example.test`, password: 'Synthetic release passphrase!', role, status, emailVerified: true, state: 'CA' });
  const session = await createAuthSession(user, { headers: {}, ip: '192.0.2.30' });
  const agent = request.agent(app);
  const token = jwt.sign({ id: String(user._id), role, status, sid: session.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const csrf = await agent.get('/api/csrf').set('Cookie', `token=${token}`);
  return { user, get: path => agent.get(path).set('Cookie', `token=${token}`), put: (body, withCsrf = true) => {
    const req = agent.put('/api/admin/workspace-release').set('Cookie', `token=${token}`);
    return (withCsrf ? req.set('X-CSRF-Token', csrf.body.csrfToken) : req).send(body);
  } };
}
const input = (extra = {}) => { const value = defaults(); delete value.revision; return { expectedRevision: 0, ...value, reason: 'Local synthetic release drill.', ...extra }; };
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); admin = await actor('admin'); attorney = await actor('attorney'); paralegal = await actor('paralegal'); });
afterEach(() => jest.restoreAllMocks());
test('member decisions are owner-bound, private, unactivated and read-only', async () => {
  for (const person of [attorney, paralegal]) {
    const result = await person.get('/api/auth/workspace-release'); expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body.workspace).toMatchObject({ ownerId: String(person.user._id), role: person.user.role, revision: 0, version: 'baseline' });
    expect(result.body.workspace).not.toHaveProperty('overrides');
  }
  expect(await WorkspaceRelease.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ action: 'workspace.release.changed' })).toBe(0);
});
test('only approved administrators can inspect or change policy; mutation requires CSRF', async () => {
  expect((await request(app).get('/api/admin/workspace-release')).status).toBe(401);
  for (const person of [attorney, paralegal]) {
    expect((await person.get('/api/admin/workspace-release')).status).toBe(403); expect((await person.put(input())).status).toBe(403);
  }
  expect((await admin.put(input(), false)).status).toBe(403);
  expect(await WorkspaceRelease.countDocuments()).toBe(0);
});
test('activation, account overrides and global rollback publish immediately without changing account or Matter data', async () => {
  const before = JSON.stringify(await User.find().sort({ _id: 1 }).lean());
  const config = input({ enabled: true }); config.attorney.overrides[String(attorney.user._id)] = 'v2';
  expect((await admin.put(config)).status).toBe(200);
  expect((await attorney.get('/api/auth/workspace-release')).body.workspace).toMatchObject({ version: 'v2', revision: 1 });
  expect((await paralegal.get('/api/auth/workspace-release')).body.workspace.version).toBe('legacy');
  expect((await admin.put({ ...config, expectedRevision: 1, killSwitch: true })).status).toBe(200);
  expect((await attorney.get('/api/auth/workspace-release')).body.workspace).toMatchObject({ version: 'legacy', reason: 'global_rollback', revision: 2 });
  expect(JSON.stringify(await User.find().sort({ _id: 1 }).lean())).toBe(before);
  const logs = await AuditLog.find({ action: 'workspace.release.changed' }).sort({ createdAt: 1, _id: 1 }).lean();
  expect(logs).toHaveLength(2); expect(logs[0].meta.before).toEqual(defaults());
  expect(logs[1].meta.before).toMatchObject({ revision: 1, enabled: true, killSwitch: false });
  expect(logs[1].meta.after).toMatchObject({ revision: 2, killSwitch: true }); expect(String(logs[1].actor)).toBe(String(admin.user._id));
});
test('stale or concurrent administrator edits cannot silently overwrite the reviewed policy', async () => {
  const results = await Promise.all([admin.put(input({ enabled: true })), admin.put(input({ killSwitch: true }))]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await AuditLog.countDocuments({ action: 'workspace.release.changed' })).toBe(1);
  const before = (await admin.get('/api/admin/workspace-release')).body.settings;
  const stale = await admin.put(input()); expect(stale.status).toBe(409); expect(stale.body.code).toBe('WORKSPACE_RELEASE_CHANGED');
  expect((await admin.get('/api/admin/workspace-release')).body.settings).toEqual(before);
});
test('an audit failure rolls back the policy update as well', async () => {
  expect((await admin.put(input())).status).toBe(200);
  jest.spyOn(AuditLog, 'logFromReq').mockRejectedValueOnce(new Error('Synthetic audit unavailable'));
  expect((await admin.put(input({ expectedRevision: 1, enabled: true }))).status).toBe(500);
  expect((await admin.get('/api/admin/workspace-release')).body.settings).toMatchObject({ revision: 1, enabled: false });
  expect(await AuditLog.countDocuments({ action: 'workspace.release.changed' })).toBe(1);
});
test('wrong-role and nonexistent account overrides are rejected before persistence', async () => {
  for (const id of [String(paralegal.user._id), 'f'.repeat(24)]) {
    const config = input(); config.attorney.overrides[id] = 'v2';
    const result = await admin.put(config); expect(result.status).toBe(400); expect(result.body.code).toBe('WORKSPACE_RELEASE_ACCOUNT_MISMATCH');
  }
  expect(await WorkspaceRelease.countDocuments()).toBe(0);
});
test('a selected but subsequently disabled account loses access to the decision endpoint', async () => {
  const config = input({ enabled: true }); config.attorney.basisPoints = 10000;
  expect((await admin.put(config)).status).toBe(200);
  await User.updateOne({ _id: attorney.user._id }, { $set: { disabled: true } });
  expect((await attorney.get('/api/auth/workspace-release')).status).toBe(403);
  expect((await admin.get('/api/auth/workspace-release')).status).toBe(403);
});
