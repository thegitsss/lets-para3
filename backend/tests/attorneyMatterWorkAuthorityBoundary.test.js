const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), Case = require('../models/Case'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/cases', require('../routes/cases'));
let owner, matter, previousCsrf;
beforeAll(async () => { previousCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); });
afterAll(async () => { if (previousCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = previousCsrf; await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
async function actor(role) {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Work authority', email: `${role}-${crypto.randomUUID()}@work-authority.test`, password: 'Synthetic work authority password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Private actual work boundary API' }, ip: '192.0.2.21' });
  const cookie = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', cookie);
  expect(csrf.status).toBe(200);
  return { user, session, cookie: [cookie, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
beforeEach(async () => {
  await clearDatabase(); owner = await actor('attorney'); const para = await actor('paralegal');
  matter = await Case.create({ title: 'Actual work authority boundary', practiceArea: 'contract law', state: 'New York', details: 'Synthetic agreed exhibit review.', attorney: owner.user._id, attorneyId: owner.user._id, paralegal: para.user._id, paralegalId: para.user._id, tasks: [{ title: 'Review exhibit', completed: false }, { title: 'Review exhibit', completed: false }], tasksLocked: true, hiredAt: new Date(), status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_work_authority', totalAmount: 40000 });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { 'tasks.0.retainedEvidence': { source: 'original', unknownField: 42 }, 'tasks.1.retainedEvidence': 'Keep the other position' } });
});
const readCase = () => Case.collection.findOne({ _id: matter._id });
const readUser = () => User.collection.findOne({ _id: owner.user._id }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1, __v: 1 } });
const readSession = () => AuthSession.collection.findOne({ sessionId: owner.session.sessionId }, { projection: { userId: 1, createdAt: 1, expiresAt: 1, revokedAt: 1, __v: 1 } });
const readAudit = () => AuditLog.find({ targetId: matter._id }).select('action actorId targetId meta createdAt').lean();
const review = () => request(app).get(`/api/cases/${matter._id}/work-review`).query({ expectedOwnerId: String(owner.user._id) }).set('Cookie', owner.cookie);
function update(endpoint, view, before) {
  const req = endpoint === 'current'
    ? request(app).post(`/api/cases/${matter._id}/work-review`).send({ expectedOwnerId: String(owner.user._id), reviewedRevision: view.revision, index: 0, completed: true })
    : request(app).patch(`/api/cases/${matter._id}`).send({ tasks: before.tasks.map((task, index) => ({ title: task.title, completed: index === 0 })), expectedTaskRevision: Number(before.taskRevision || 0) });
  return req.set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf);
}
async function evidence(record) {
  if (!process.env.LPC_WORK_AUTHORITY_EVIDENCE) return;
  const title = expect.getState().currentTestName, file = crypto.createHash('sha256').update(title).digest('hex') + '.json';
  const data = { title, ...record, afterCase: await readCase(), afterUser: await readUser(), afterSession: await readSession(), afterAudit: await readAudit() };
  await fs.mkdir(process.env.LPC_WORK_AUTHORITY_EVIDENCE, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.LPC_WORK_AUTHORITY_EVIDENCE, file), JSON.stringify(data, null, 2), { mode: 0o600 });
}
test.each(['current', 'retained'])('%s work decision with unchanged managed authority changes only the selected position', async endpoint => {
  const before = await readCase(), record = { endpoint, beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(); expect(current.status).toBe(200);
    const response = await update(endpoint, current.body, before); record.response = { status: response.status, body: response.body };
    expect(response.status).toBe(200); const after = await readCase();
    expect(after.tasks).toEqual(before.tasks.map((task, index) => index === 0 ? { ...task, completed: true } : task));
    expect(after.taskRevision).toBe(Number(before.taskRevision || 0) + 1);
    for (const key of ['attorney', 'attorneyId', 'paralegal', 'paralegalId', 'status', 'escrowStatus', 'escrowIntentId', 'totalAmount', 'paymentReleased', 'tasksLocked', 'hiredAt']) expect(after[key]).toEqual(before[key]);
    const latest = await review(); expect(latest.status).toBe(200); const auditAfterSave = await readAudit();
    if (endpoint === 'current') {
      const unchanged = await update('current', latest.body, after);
      expect(unchanged.status).toBe(200); expect(unchanged.body.changed).toBe(false);
      expect(await readCase()).toEqual(after); expect(await readAudit()).toEqual(auditAfterSave);
      record.validNoOpCaseRevisionAndAuditConserved = true;
    }
    const other = await actor('attorney'); record.csrfDenialStatuses = [];
    for (const token of [null, other.csrf]) {
      const denied = endpoint === 'current'
        ? request(app).post(`/api/cases/${matter._id}/work-review`).send({ expectedOwnerId: String(owner.user._id), reviewedRevision: latest.body.revision, index: 0, completed: true })
        : request(app).patch(`/api/cases/${matter._id}`).send({ tasks: after.tasks.map(task => ({ title: task.title, completed: task.completed })), expectedTaskRevision: Number(after.taskRevision || 0) });
      denied.set('Cookie', owner.cookie); if (token) denied.set('X-CSRF-Token', token);
      const result = await denied; record.csrfDenialStatuses.push(result.status); expect(result.status).toBe(403);
      expect(await readCase()).toEqual(after); expect(await readAudit()).toEqual(auditAfterSave);
    }
  } finally { await evidence(record); }
});
test.each([
  { endpoint: 'current', field: 'authVersion', value: 1 },
  { endpoint: 'current', field: 'role', value: 'paralegal' },
  { endpoint: 'current', field: 'disabled', value: true },
  { endpoint: 'current', field: 'status', value: 'pending' },
  { endpoint: 'current', field: 'sessionRevoked', value: true },
  { endpoint: 'retained', field: 'authVersion', value: 1 },
  { endpoint: 'retained', field: 'role', value: 'paralegal' },
  { endpoint: 'retained', field: 'disabled', value: true },
  { endpoint: 'retained', field: 'status', value: 'pending' },
  { endpoint: 'retained', field: 'sessionRevoked', value: true },
])('actual final-work-CAS authority loss %j cannot persist an unauthorized completion', async scenario => {
  const before = await readCase(), record = { scenario, beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(); expect(current.status).toBe(200);
    const writeUser = User.collection.updateOne.bind(User.collection), writeSession = AuthSession.collection.updateOne.bind(AuthSession.collection); let injected = false;
    async function loseAuthority(stage, options) {
      if (!injected) {
        injected = true;
        const changed = scenario.field === 'sessionRevoked'
          ? await writeSession({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } })
          : await writeUser({ _id: owner.user._id }, { $set: { [scenario.field]: scenario.value } });
        expect(changed.modifiedCount).toBe(1);
        record.injection = { committedIndependentRecord: true, stage, transactionPresentAtAuthorityBoundary: Boolean(options?.session?.inTransaction()), userAfterInjection: await readUser(), sessionAfterInjection: await readSession() };
      }
    }
    // The corrected write owns these records before its Case CAS. A loss that
    // wins must commit before the respective arbitration lock; an independent
    // revocation after that lock must wait for the authorized commit instead.
    jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (scenario.field !== 'sessionRevoked' && options?.session && change?.$inc?.__v && String(filter._id) === String(owner.user._id)) await loseAuthority('actor-lock', options);
      return writeUser(filter, change, options);
    });
    jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (scenario.field === 'sessionRevoked' && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) await loseAuthority('session-lock', options);
      return writeSession(filter, change, options);
    });
    const response = await update(scenario.endpoint, current.body, before); record.response = { status: response.status, body: response.body };
    expect(injected).toBe(true);
    // The authoritative record is checked even when the API returns an error
    // after a late write; an HTTP denial by itself cannot certify no mutation.
    expect(await readCase()).toEqual(before);
    expect([401, 403, 409]).toContain(response.status);
    expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(record); }
});

test.each([
  { endpoint: 'current', authority: 'account' },
  { endpoint: 'current', authority: 'session' },
  { endpoint: 'retained', authority: 'account' },
  { endpoint: 'retained', authority: 'session' },
])('a work transaction winning its actual authority lock serializes the later loss %j after its authorized commit', async scenario => {
  const before = await readCase(), record = { scenario, beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  let queued;
  try {
    const current = await review(); expect(current.status).toBe(200);
    const original = Case.collection.updateOne.bind(Case.collection);
    jest.spyOn(Case.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      const decision = scenario.endpoint === 'current' ? change?.$set?.['tasks.0'] : change?.$set?.tasks;
      if (!queued && decision) {
        expect(options.session.inTransaction()).toBe(true);
        // Do not await a competing write while this transaction owns its lock.
        // The real Mongo operation must finish only after our commit releases it.
        record.injection = { stage: 'case-cas-after-authority-lock', independentLossQueued: true, queuedAt: new Date().toISOString(), resolvedAt: null };
        const loss = scenario.authority === 'account'
          ? User.collection.updateOne({ _id: owner.user._id }, { $set: { authVersion: 1 } })
          : AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } });
        queued = loss.then(async result => {
          record.injection.resolvedAt = new Date().toISOString();
          record.injection.realWriteResult = { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
          // An independent read cannot see the Case's uncommitted transaction.
          // Save that exact read at the real competing operation's completion.
          record.injection.savedCaseAtLossResolution = await readCase();
          record.injection.authorityAtLossResolution = scenario.authority === 'account' ? await readUser() : await readSession();
          return result;
        });
      }
      return original(filter, change, options);
    });
    const response = await update(scenario.endpoint, current.body, before); record.response = { status: response.status, body: response.body };
    expect(queued).toBeDefined(); expect((await queued).modifiedCount).toBe(1);
    record.lossCommittedAfterAuthorizedMutation = record.injection.savedCaseAtLossResolution.tasks[0].completed === true && record.injection.savedCaseAtLossResolution.taskRevision === Number(before.taskRevision || 0) + 1;
    expect(record.lossCommittedAfterAuthorizedMutation).toBe(true);
    expect(response.status).toBe(200); const saved = await readCase();
    expect(saved.tasks).toEqual(before.tasks.map((task, index) => index === 0 ? { ...task, completed: true } : task));
    expect(saved.taskRevision).toBe(Number(before.taskRevision || 0) + 1);
    expect((await readAudit()).length).toBe(record.beforeAudit.length + 1);
    if (scenario.authority === 'account') expect((await readUser()).authVersion).toBe(1);
    else expect((await readSession()).revokedAt).toBeInstanceOf(Date);
  } finally { if (queued) await queued; await evidence(record); }
});

test.each(['account', 'session'])('an already-complete current work no-op freshly checks %s authority without a Case revision or audit change', async mode => {
  const first = await review(); expect(first.status).toBe(200); expect((await update('current', first.body, await readCase())).status).toBe(200);
  const current = await review(); expect(current.status).toBe(200);
  const before = await readCase(), record = { mode, beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const account = require('../services/attorneyAccountBoundary'), original = account.read; let calls = 0;
    jest.spyOn(account, 'read').mockImplementation(async (...args) => {
      if (++calls === 2) {
        if (mode === 'account') await User.collection.updateOne({ _id: owner.user._id }, { $set: { authVersion: 1 } });
        else await AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } });
        record.injection = { stage: 'fresh-no-op-authority-read', committedIndependentRecord: true };
      }
      return original(...args);
    });
    const response = await update('current', current.body, before); record.response = { status: response.status, body: response.body };
    expect(record.injection).not.toBeNull(); expect(response.status).toBe(403); expect(await readCase()).toEqual(before); expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(record); }
});

test('a current work audit-storage failure aborts its actual Case revision and authority-lock changes', async () => {
  const before = await readCase(), record = { beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(); expect(current.status).toBe(200);
    jest.spyOn(AuditLog, 'logFromReq').mockRejectedValueOnce(new Error('Synthetic audit storage unavailable'));
    const response = await update('current', current.body, before); record.response = { status: response.status, body: response.body };
    expect(response.status).toBe(503); expect(await readCase()).toEqual(before); expect(await readUser()).toEqual(record.beforeUser); expect(await readSession()).toEqual(record.beforeSession); expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(record); }
});

test('the existing approved Admin retained-work override is preserved without granting the Attorney review service to Admin', async () => {
  const before = await readCase(), record = { beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(); expect(current.status).toBe(200); const admin = await actor('admin');
    record.adminActor = { id: String(admin.user._id), role: admin.user.role, status: admin.user.status, managedSession: true };
    const denied = await request(app).post(`/api/cases/${matter._id}/work-review`).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).send({ expectedOwnerId: String(admin.user._id), reviewedRevision: current.body.revision, index: 0, completed: true });
    expect(denied.status).toBe(403); expect(await readCase()).toEqual(before);
    const response = await request(app).patch(`/api/cases/${matter._id}`).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).send({ tasks: before.tasks.map((task, index) => ({ title: task.title, completed: index === 0 })), expectedTaskRevision: Number(before.taskRevision || 0) });
    record.response = { status: response.status, body: response.body }; expect(response.status).toBe(200);
    expect((await readCase()).tasks).toEqual(before.tasks.map((task, index) => index === 0 ? { ...task, completed: true } : task));
  } finally { await evidence(record); }
});

test.each(['current', 'retained'])('%s work cannot mutate a Case whose real owner changed before its final CAS', async endpoint => {
  const before = await readCase(), record = { endpoint, beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(); expect(current.status).toBe(200); const other = await actor('attorney'), original = Case.collection.updateOne.bind(Case.collection); let changed = false;
    jest.spyOn(Case.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      const decision = endpoint === 'current' ? change?.$set?.['tasks.0'] : change?.$set?.tasks;
      if (!changed && decision) {
        changed = true; expect((await original({ _id: matter._id }, { $set: { attorney: other.user._id, attorneyId: other.user._id } })).modifiedCount).toBe(1);
        record.injection = { stage: 'case-cas', independentNewOwnerId: String(other.user._id), committedIndependentRecord: true };
      }
      return original(filter, change, options);
    });
    const response = await update(endpoint, current.body, before); record.response = { status: response.status, body: response.body };
    expect(changed).toBe(true); expect([403, 409]).toContain(response.status); const after = await readCase();
    expect(after.attorney).toEqual(other.user._id); expect(after.attorneyId).toEqual(other.user._id); expect(after.tasks).toEqual(before.tasks); expect(after.taskRevision).toBe(before.taskRevision); expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(record); }
});

test.each([
  { endpoint: 'current', loss: 'expired' },
  { endpoint: 'current', loss: 'foreign-owner' },
  { endpoint: 'current', loss: 'record-deleted' },
  { endpoint: 'retained', loss: 'expired' },
  { endpoint: 'retained', loss: 'foreign-owner' },
  { endpoint: 'retained', loss: 'record-deleted' },
])('actual managed SID loss winning at its work lock %j cannot change Case work, revision or audit', async scenario => {
  const before = await readCase(), record = { scenario, beforeCase: before, beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(); expect(current.status).toBe(200);
    const other = scenario.loss === 'foreign-owner' ? await actor('attorney') : null;
    const original = AuthSession.collection.updateOne.bind(AuthSession.collection); let changed = false;
    jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (!changed && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) {
        changed = true;
        const result = scenario.loss === 'record-deleted'
          ? await AuthSession.collection.deleteOne({ sessionId: owner.session.sessionId })
          : await original({ sessionId: owner.session.sessionId }, { $set: scenario.loss === 'expired' ? { expiresAt: new Date(Date.now() - 1) } : { userId: other.user._id } });
        expect(scenario.loss === 'record-deleted' ? result.deletedCount : result.modifiedCount).toBe(1);
        record.injection = { stage: 'session-lock', committedIndependentRecord: true, loss: scenario.loss, foreignUserId: other ? String(other.user._id) : null, realWriteResult: { acknowledged: result.acknowledged, modifiedCount: result.modifiedCount, deletedCount: result.deletedCount }, sessionAfterInjection: await readSession() };
      }
      return original(filter, change, options);
    });
    const response = await update(scenario.endpoint, current.body, before); record.response = { status: response.status, body: response.body };
    expect(changed).toBe(true); expect([401, 403, 409]).toContain(response.status);
    expect(await readCase()).toEqual(before); expect(await readAudit()).toEqual(record.beforeAudit);
    const session = await readSession();
    if (scenario.loss === 'record-deleted') expect(session).toBeNull();
    else if (scenario.loss === 'foreign-owner') expect(session.userId).toEqual(other.user._id);
    else if (session) expect(session.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  } finally { await evidence(record); }
});
