const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), Case = require('../models/Case'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/cases', require('../routes/cases'));
let attorney, administrator, matter, previousCsrf;
beforeAll(async () => { previousCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); });
afterAll(async () => { if (previousCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = previousCsrf; await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
async function actor(role) {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Archive authority', email: `${role}-${crypto.randomUUID()}@archive-authority.test`, password: 'Synthetic archive authority password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Private actual archive boundary API' }, ip: '192.0.2.22' });
  const authCookie = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', authCookie); expect(csrf.status).toBe(200);
  return { user, session, cookie: [authCookie, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
beforeEach(async () => {
  await clearDatabase(); attorney = await actor('attorney'); administrator = await actor('admin');
  matter = await Case.create({ title: 'Actual archive authority boundary', practiceArea: 'contract law', state: 'New York', details: 'Synthetic unassigned agreed exhibit review.', attorney: attorney.user._id, attorneyId: attorney.user._id, tasks: [{ title: 'Review exhibit', completed: false }], status: 'open', totalAmount: 40000 });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { retainedArchiveEvidence: { source: 'original', unknownField: 42 } } });
});
const subject = role => role === 'admin' ? administrator : attorney;
const readCase = () => Case.collection.findOne({ _id: matter._id });
const readUser = owner => User.collection.findOne({ _id: owner.user._id }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1, __v: 1 } });
const readSession = owner => AuthSession.collection.findOne({ sessionId: owner.session.sessionId }, { projection: { userId: 1, createdAt: 1, expiresAt: 1, revokedAt: 1, __v: 1 } });
const readAudit = () => AuditLog.find({ targetId: matter._id }).select('action actor actorRole targetId case meta createdAt').lean();
const review = owner => request(app).get(`/api/cases/${matter._id}/archive`).query({ expectedOwnerId: String(owner.user._id) }).set('Cookie', owner.cookie);
const update = (owner, view, requestId) => request(app).patch(`/api/cases/${matter._id}/archive`).send({ expectedOwnerId: String(owner.user._id), revision: view.revision, archived: true, requestId }).set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf);
async function evidence(owner, record) {
  if (!process.env.LPC_ARCHIVE_AUTHORITY_EVIDENCE) return;
  const title = expect.getState().currentTestName, file = crypto.createHash('sha256').update(title).digest('hex') + '.json';
  const data = { title, ...record, afterCase: await readCase(), afterUser: await readUser(owner), afterSession: await readSession(owner), afterAudit: await readAudit() };
  await fs.mkdir(process.env.LPC_ARCHIVE_AUTHORITY_EVIDENCE, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.LPC_ARCHIVE_AUTHORITY_EVIDENCE, file), JSON.stringify(data, null, 2), { mode: 0o600 });
}
test.each(['attorney', 'admin'])('%s archive with unchanged managed authority preserves Matter data and the exact replay receipt', async role => {
  const owner = subject(role), before = await readCase(), record = { role, beforeCase: before, beforeUser: await readUser(owner), beforeSession: await readSession(owner), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(owner); record.review = { status: current.status, body: current.body }; expect(current.status).toBe(200); expect(current.body.canChange).toBe(true);
    const requestId = crypto.randomUUID(), response = await update(owner, current.body, requestId); record.response = { status: response.status, body: response.body }; expect(response.status).toBe(200);
    const after = await readCase(); expect(after.archived).toBe(true); expect(after.archiveReceipt.requestId).toBe(requestId); expect(String(after.archiveReceipt.by)).toBe(String(owner.user._id));
    const withoutArchiveChange = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !['archived', 'archiveReceipt', 'updatedAt'].includes(key)));
    expect(withoutArchiveChange(after)).toEqual(withoutArchiveChange(before));
    const auditAfterSave = await readAudit(); expect(auditAfterSave).toHaveLength(record.beforeAudit.length + 1);
    const replay = await update(owner, current.body, requestId); record.replay = { status: replay.status, body: replay.body }; expect(replay.status).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(await readCase()).toEqual(after); expect(await readAudit()).toEqual(auditAfterSave);
    record.validReplayCaseAndAuditConserved = true;
    const foreign = await actor('attorney'); record.csrfDenialStatuses = [];
    for (const token of [null, foreign.csrf]) {
      const denied = request(app).patch(`/api/cases/${matter._id}/archive`).send({ expectedOwnerId: String(owner.user._id), revision: current.body.revision, archived: true, requestId }).set('Cookie', owner.cookie); if (token) denied.set('X-CSRF-Token', token);
      const result = await denied; record.csrfDenialStatuses.push(result.status); expect(result.status).toBe(403); expect(await readCase()).toEqual(after); expect(await readAudit()).toEqual(auditAfterSave);
    }
  } finally { await evidence(owner, record); }
});
test.each([
  { role: 'attorney', field: 'authVersion', value: 1 },
  { role: 'attorney', field: 'role', value: 'paralegal' },
  { role: 'attorney', field: 'disabled', value: true },
  { role: 'attorney', field: 'status', value: 'pending' },
  { role: 'attorney', field: 'sessionRevoked', value: true },
  { role: 'admin', field: 'authVersion', value: 1 },
  { role: 'admin', field: 'role', value: 'paralegal' },
  { role: 'admin', field: 'disabled', value: true },
  { role: 'admin', field: 'status', value: 'pending' },
  { role: 'admin', field: 'sessionRevoked', value: true },
])('actual final-archive-CAS authority loss %j cannot persist an unauthorized archive', async scenario => {
  const owner = subject(scenario.role), before = await readCase(), record = { scenario, beforeCase: before, beforeUser: await readUser(owner), beforeSession: await readSession(owner), beforeAudit: await readAudit(), injection: null };
  try {
    const current = await review(owner); record.review = { status: current.status, body: current.body }; expect(current.status).toBe(200); expect(current.body.canChange).toBe(true);
    const writeUser = User.collection.updateOne.bind(User.collection), writeSession = AuthSession.collection.updateOne.bind(AuthSession.collection); let injected = false;
    async function loseAuthority(stage, options) {
      if (injected) return;
      injected = true;
      const result = scenario.field === 'sessionRevoked'
        ? await writeSession({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } })
        : await writeUser({ _id: owner.user._id }, { $set: { [scenario.field]: scenario.value } });
      expect(result.modifiedCount).toBe(1);
      record.injection = { committedIndependentRecord: true, stage, transactionPresentAtBoundary: Boolean(options?.session?.inTransaction()), userAfterInjection: await readUser(owner), sessionAfterInjection: await readSession(owner) };
    }
    // A real authority loss must win before the corresponding arbitration
    // lock. Awaiting a revocation after that lock would deadlock this fixture.
    jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (scenario.field !== 'sessionRevoked' && options?.session && change?.$inc?.__v && String(filter._id) === String(owner.user._id)) await loseAuthority('actor-lock', options);
      return writeUser(filter, change, options);
    });
    jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (scenario.field === 'sessionRevoked' && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) await loseAuthority('session-lock', options);
      return writeSession(filter, change, options);
    });
    const response = await update(owner, current.body, crypto.randomUUID()); record.response = { status: response.status, body: response.body }; expect(injected).toBe(true);
    // An HTTP denial after a write cannot prove safety. Preserve the actual
    // committed records on both success and failure of these strict assertions.
    expect(await readCase()).toEqual(before); expect([401, 403, 409]).toContain(response.status); expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(owner, record); }
});

test.each([
  { role: 'attorney', authority: 'account' }, { role: 'attorney', authority: 'session' },
  { role: 'admin', authority: 'account' }, { role: 'admin', authority: 'session' },
])('an authorized archive winning its real lock serializes the later loss %j after its commit', async scenario => {
  const owner = subject(scenario.role), before = await readCase(), record = { scenario, beforeCase: before, beforeUser: await readUser(owner), beforeSession: await readSession(owner), beforeAudit: await readAudit() };
  let queued;
  try {
    const current = await review(owner); expect(current.status).toBe(200);
    const original = Case.collection.updateOne.bind(Case.collection);
    jest.spyOn(Case.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (!queued && change?.$set?.archived === true && String(filter._id) === String(matter._id)) {
        expect(options?.session?.inTransaction()).toBe(true);
        record.injection = { stage: 'case-cas-after-authority-lock', queuedAt: new Date().toISOString(), independentlyResolvedAt: null };
        const loss = scenario.authority === 'account'
          ? User.collection.updateOne({ _id: owner.user._id }, { $set: { authVersion: 1 } })
          : AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } });
        queued = loss.then(async result => {
          record.injection.independentlyResolvedAt = new Date().toISOString();
          record.injection.modifiedCount = result.modifiedCount;
          // This reader has no transaction session and cannot see an
          // uncommitted Case from the transaction that owns the authority lock.
          record.injection.caseAtIndependentLossResolution = await readCase();
          record.injection.authorityAtIndependentLossResolution = scenario.authority === 'account' ? await readUser(owner) : await readSession(owner);
          return result;
        });
      }
      return original(filter, change, options);
    });
    const response = await update(owner, current.body, crypto.randomUUID()); record.response = { status: response.status, body: response.body };
    expect(response.status).toBe(200); expect(queued).toBeDefined(); expect((await queued).modifiedCount).toBe(1);
    const after = await readCase(); expect(after.archived).toBe(true); expect(record.injection.caseAtIndependentLossResolution).toEqual(after);
    expect(await readAudit()).toHaveLength(record.beforeAudit.length+1);
  } finally { if (queued) await queued; await evidence(owner, record); }
});

test.each(['attorney', 'admin'])('%s archive audit persistence failure rolls back Case and all authority locks', async role => {
  const owner = subject(role), before = await readCase(), record = { role, beforeCase: before, beforeUser: await readUser(owner), beforeSession: await readSession(owner), beforeAudit: await readAudit() };
  try {
    const current = await review(owner); expect(current.status).toBe(200);
    jest.spyOn(AuditLog, 'logFromReq').mockImplementationOnce(async (_req, action, options) => {
      expect(options.session.inTransaction()).toBe(true); expect(action).toBe('case.archive');
      record.stagedCase = await Case.collection.findOne({ _id: matter._id }, { session: options.session });
      record.independentCaseBeforeAuditFailure = await readCase();
      throw new Error('Synthetic archive audit persistence outage');
    });
    const response = await update(owner, current.body, crypto.randomUUID()); record.response = { status: response.status, body: response.body };
    expect(response.status).toBe(503); expect(record.stagedCase.archived).toBe(true); expect(record.independentCaseBeforeAuditFailure).toEqual(before);
    expect(await readCase()).toEqual(before); expect(await readUser(owner)).toEqual(record.beforeUser); expect(await readSession(owner)).toEqual(record.beforeSession); expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(owner, record); }
});

test.each([
  { role: 'attorney', loss: 'expired' }, { role: 'attorney', loss: 'foreign-owner' }, { role: 'attorney', loss: 'deleted' },
  { role: 'admin', loss: 'expired' }, { role: 'admin', loss: 'foreign-owner' }, { role: 'admin', loss: 'deleted' },
])('actual archive SID loss %j before its winning lock conserves Matter and audit', async scenario => {
  const owner = subject(scenario.role), foreign = await actor('attorney'), before = await readCase(), record = { scenario, beforeCase: before, beforeUser: await readUser(owner), beforeSession: await readSession(owner), beforeAudit: await readAudit() };
  try {
    const current = await review(owner); expect(current.status).toBe(200); let injected = false;
    const original = AuthSession.collection.updateOne.bind(AuthSession.collection);
    jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (!injected && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) {
        injected = true;
        const changed = scenario.loss === 'deleted'
          ? await AuthSession.collection.deleteOne({ sessionId: owner.session.sessionId })
          : await original({ sessionId: owner.session.sessionId }, { $set: scenario.loss === 'expired' ? { expiresAt: new Date(Date.now()-1000) } : { userId: foreign.user._id } });
        expect(scenario.loss === 'deleted' ? changed.deletedCount : changed.modifiedCount).toBe(1);
        record.injection = { committedIndependentRecord: true, stage: 'session-lock', sessionAfterInjection: await readSession(owner) };
      }
      return original(filter, change, options);
    });
    const response = await update(owner, current.body, crypto.randomUUID()); record.response = { status: response.status, body: response.body };
    expect(injected).toBe(true); expect([401,403,409]).toContain(response.status); expect(await readCase()).toEqual(before); expect(await readAudit()).toEqual(record.beforeAudit); expect(await readUser(owner)).toEqual(record.beforeUser);
  } finally { await evidence(owner, record); }
});

test.each([
  { role: 'attorney', field: 'authVersion' }, { role: 'attorney', field: 'role' }, { role: 'attorney', field: 'disabled' }, { role: 'attorney', field: 'sessionRevoked' },
  { role: 'admin', field: 'authVersion' }, { role: 'admin', field: 'role' }, { role: 'admin', field: 'disabled' }, { role: 'admin', field: 'sessionRevoked' },
])('an exact archive receipt replay with late real authority loss %j cannot claim an authorized result', async scenario => {
  const owner = subject(scenario.role), record = { scenario };
  try {
    const current = await review(owner); expect(current.status).toBe(200); const requestId = crypto.randomUUID();
    expect((await update(owner,current.body,requestId)).status).toBe(200);
    record.beforeCase = await readCase(); record.beforeUser = await readUser(owner); record.beforeSession = await readSession(owner); record.beforeAudit = await readAudit();
    const writeUser = User.collection.updateOne.bind(User.collection), writeSession = AuthSession.collection.updateOne.bind(AuthSession.collection); let injected = false;
    async function lose(stage) {
      if (injected) return; injected = true;
      const result = scenario.field === 'sessionRevoked'
        ? await writeSession({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } })
        : await writeUser({ _id: owner.user._id }, { $set: { [scenario.field]: scenario.field === 'authVersion' ? Number(record.beforeUser.authVersion||0)+1 : scenario.field === 'role' ? 'paralegal' : true } });
      expect(result.modifiedCount).toBe(1); record.injection = { committedIndependentRecord: true, stage, userAfterInjection: await readUser(owner), sessionAfterInjection: await readSession(owner) };
    }
    jest.spyOn(User.collection,'updateOne').mockImplementation(async (filter,change,options) => {
      if (scenario.field !== 'sessionRevoked' && options?.session && change?.$inc?.__v && String(filter._id) === String(owner.user._id)) await lose('actor-lock');
      return writeUser(filter,change,options);
    });
    jest.spyOn(AuthSession.collection,'updateOne').mockImplementation(async (filter,change,options) => {
      if (scenario.field === 'sessionRevoked' && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) await lose('session-lock');
      return writeSession(filter,change,options);
    });
    const response = await update(owner,current.body,requestId); record.response = { status: response.status, body: response.body };
    expect(injected).toBe(true); expect([401,403,409]).toContain(response.status); expect(await readCase()).toEqual(record.beforeCase); expect(await readAudit()).toEqual(record.beforeAudit);
  } finally { await evidence(owner,record); }
});
