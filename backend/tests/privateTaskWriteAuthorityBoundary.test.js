const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), ChecklistTask = require('../models/ChecklistTask'), Case = require('../models/Case'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/checklist', require('../routes/checklist'));
let owner, paralegal, other, task, matter, previousCsrf;
beforeAll(async () => { previousCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); });
afterAll(async () => { if (previousCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = previousCsrf; await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
async function actor(role = 'attorney') {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Private task authority', email: `${role}-${crypto.randomUUID()}@private-task-authority.test`, password: 'Synthetic private task authority password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Private actual task write boundary API' }, ip: '192.0.2.22' });
  const cookie = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', cookie); expect(csrf.status).toBe(200);
  return { user, session, cookie: [cookie, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
beforeEach(async () => {
  await clearDatabase(); owner = await actor(); paralegal = await actor('paralegal'); other = await actor();
  matter = await Case.create({ title: 'Private task authority Matter', details: 'Shared work stays unchanged by private planning.', attorney: owner.user._id, attorneyId: owner.user._id, paralegal: paralegal.user._id, paralegalId: paralegal.user._id, status: 'in progress', hiredAt: new Date(), tasksLocked: true, tasks: [{ title: 'Agreed work', completed: false }], escrowIntentId: 'pi_synthetic_private_task_authority', escrowStatus: 'funded', totalAmount: 40000, currency: 'usd' });
  task = await ChecklistTask.create({ owner: owner.user._id, caseId: matter._id, title: 'Owner-only retained planning', notes: 'Private paragraphs.\n\nKeep this original note.', due: new Date('2026-12-21T16:00:00Z') });
  await ChecklistTask.collection.updateOne({ _id: task._id }, { $set: { retainedEvidence: { source: 'earlier-record', unknownField: 42 } } });
});
const readTasks = () => ChecklistTask.collection.find({}).sort({ _id: 1 }).toArray();
const readTask = () => ChecklistTask.collection.findOne({ _id: task._id });
const readCase = () => Case.collection.findOne({ _id: matter._id });
const readUser = () => User.collection.findOne({ _id: owner.user._id }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1, __v: 1 } });
const readSession = () => AuthSession.collection.findOne({ sessionId: owner.session.sessionId }, { projection: { userId: 1, createdAt: 1, expiresAt: 1, revokedAt: 1, __v: 1 } });
const readAudit = () => AuditLog.find({ action: { $in: ['task.create', 'task.delete'] } }).sort({ _id: 1 }).select('actor actorRole targetType targetId action method path meta createdAt').lean();
const fields = () => ({ title: 'New private planning', notes: 'New private paragraphs.\n\nKeep these details owner-only.', due: '2026-12-22T16:00:00.000Z', caseId: String(matter._id) });
function mutate(operation, person = owner, token = person.csrf) {
  const result = operation === 'create' ? request(app).post('/api/checklist').send(fields()) : request(app).delete(`/api/checklist/${task._id}`);
  result.set('Cookie', person.cookie); if (token) result.set('X-CSRF-Token', token); return result;
}
async function beforeRecord(operation) { return { operation, beforeTasks: await readTasks(), beforeCase: await readCase(), beforeUser: await readUser(), beforeSession: await readSession(), beforeAudit: await readAudit(), injection: null }; }
async function evidence(record) {
  if (!process.env.LPC_PRIVATE_TASK_AUTHORITY_EVIDENCE) return;
  const title = expect.getState().currentTestName, file = crypto.createHash('sha256').update(title).digest('hex') + '.json';
  const value = { title, ...record, afterTasks: await readTasks(), afterCase: await readCase(), afterUser: await readUser(), afterSession: await readSession(), afterAudit: await readAudit() };
  await fs.mkdir(process.env.LPC_PRIVATE_TASK_AUTHORITY_EVIDENCE, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.LPC_PRIVATE_TASK_AUTHORITY_EVIDENCE, file), JSON.stringify(value, null, 2), { mode: 0o600 });
}
test.each(['create', 'delete'])('unchanged managed Attorney authority can %s private planning while opposite-role and other-owner controls remain denied', async operation => {
  const record = await beforeRecord(operation);
  try {
    record.denialControls = [];
    for (const person of [paralegal, other]) {
      // The other Attorney owns their own planning; only another owner's
      // retained task is denied. Paralegals have no private checklist authority.
      const result = await mutate(person === other ? 'delete' : operation, person);
      record.denialControls.push({ role: person.user.role, status: result.status, body: result.body });
      expect(result.status).toBe(person === other ? 404 : 403); expect(JSON.stringify(result.body)).not.toContain(task.title); expect(JSON.stringify(result.body)).not.toContain(task.notes);
    }
    for (const token of [null, other.csrf]) { const result = await mutate(operation, owner, token); record.denialControls.push({ csrf: token ? 'foreign' : 'missing', status: result.status }); expect(result.status).toBe(403); }
    expect(await readTasks()).toEqual(record.beforeTasks); expect(await readAudit()).toEqual(record.beforeAudit);
    const response = await mutate(operation); record.response = { status: response.status, body: response.body };
    if (operation === 'create') {
      expect(response.status).toBe(201); const saved = await ChecklistTask.collection.findOne({ _id: new (require('mongoose').Types.ObjectId)(response.body.id) });
      expect(saved).toMatchObject({ owner: owner.user._id, caseId: matter._id, title: fields().title, notes: fields().notes, done: false, due: new Date(fields().due) });
      expect(await readTask()).toEqual(record.beforeTasks.find(value => String(value._id) === String(task._id)));
      expect((await readTasks()).length).toBe(record.beforeTasks.length + 1);
    } else { expect(response.status).toBe(200); expect(await readTask()).toBeNull(); expect((await readTasks()).length).toBe(record.beforeTasks.length - 1); }
    expect((await readAudit()).length).toBe(record.beforeAudit.length + 1); expect(await readCase()).toEqual(record.beforeCase);
  } finally { await evidence(record); }
});
test.each([
  { operation: 'create', field: 'authVersion', value: 1 },
  { operation: 'create', field: 'role', value: 'paralegal' },
  { operation: 'create', field: 'disabled', value: true },
  { operation: 'create', field: 'status', value: 'pending' },
  { operation: 'create', field: 'sessionRevoked', value: true },
  { operation: 'delete', field: 'authVersion', value: 1 },
  { operation: 'delete', field: 'role', value: 'paralegal' },
  { operation: 'delete', field: 'disabled', value: true },
  { operation: 'delete', field: 'status', value: 'pending' },
  { operation: 'delete', field: 'sessionRevoked', value: true },
])('actual private Task final-write authority loss %j cannot persist Task or audit changes', async scenario => {
  const record = await beforeRecord(scenario.operation); record.scenario = scenario;
  const writeUser = User.collection.updateOne.bind(User.collection), writeSession = AuthSession.collection.updateOne.bind(AuthSession.collection); let injected = false;
  try {
    async function loseAuthority(stage, options) {
      if (injected) return; injected = true;
      const result = scenario.field === 'sessionRevoked' ? await writeSession({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } }) : await writeUser({ _id: owner.user._id }, { $set: { [scenario.field]: scenario.value } });
      expect(result.modifiedCount).toBe(1);
      record.injection = { stage, relocatedBeforeNewAuthorityArbitration: true, independentlyCommitted: true, transactionPresent: Boolean(options?.session?.inTransaction()), realWriteResult: { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }, userAfterInjection: await readUser(), sessionAfterInjection: await readSession(), tasksAfterInjectionBeforeOriginalWrite: await readTasks() };
    }
    // The original failed13 remains frozen at the real Task insert/delete.
    // Winning losses on the corrected transaction must precede its new locks.
    jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (scenario.field !== 'sessionRevoked' && options?.session && change?.$inc?.__v && String(filter._id) === String(owner.user._id)) await loseAuthority('actor-lock', options);
      return writeUser(filter, change, options);
    });
    jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (scenario.field === 'sessionRevoked' && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) await loseAuthority('session-lock', options);
      return writeSession(filter, change, options);
    });
    const response = await mutate(scenario.operation); record.response = { status: response.status, body: response.body };
    expect(injected).toBe(true); expect(await readTasks()).toEqual(record.beforeTasks); expect([401, 403, 409]).toContain(response.status); expect(await readAudit()).toEqual(record.beforeAudit); expect(await readCase()).toEqual(record.beforeCase);
  } finally { await evidence(record); }
});
test('an actual Task owner move winning before original deletion preserves the transferred record and unrelated private metadata', async () => {
  const record = await beforeRecord('delete'), original = ChecklistTask.collection.deleteOne.bind(ChecklistTask.collection); let moved = false;
  try {
    jest.spyOn(ChecklistTask.collection, 'deleteOne').mockImplementation(async (filter, options) => {
      if (!moved && String(filter._id) === String(task._id)) {
        moved = true; const result = await ChecklistTask.collection.updateOne({ _id: task._id }, { $set: { owner: other.user._id } }); expect(result.modifiedCount).toBe(1);
        record.injection = { stage: 'original-Task-deleteOne', independentlyCommitted: true, realWriteResult: { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }, newOwnerId: String(other.user._id), originalDeletionFilter: filter, transferredTaskBeforeOriginalDeletion: await readTask() };
      }
      return original(filter, options);
    });
    const response = await mutate('delete'); record.response = { status: response.status, body: response.body };
    expect(moved).toBe(true); expect(await readTask()).toEqual({ ...record.beforeTasks.find(value => String(value._id) === String(task._id)), owner: other.user._id });
    expect([404, 409]).toContain(response.status); expect(await readAudit()).toEqual(record.beforeAudit); expect(await readCase()).toEqual(record.beforeCase);
  } finally { await evidence(record); }
});

test.each([
  { operation: 'create', authority: 'account' }, { operation: 'create', authority: 'session' },
  { operation: 'delete', authority: 'account' }, { operation: 'delete', authority: 'session' },
])('an actual private Task transaction winning its authority lock serializes later loss %j after the authorized commit', async scenario => {
  const record = await beforeRecord(scenario.operation); record.scenario = scenario;
  const method = scenario.operation === 'create' ? 'insertOne' : 'deleteOne', original = ChecklistTask.collection[method].bind(ChecklistTask.collection); let queued;
  try {
    jest.spyOn(ChecklistTask.collection, method).mockImplementation(async (...args) => {
      if (!queued) {
        expect(args[1].session.inTransaction()).toBe(true);
        record.injection = { stage: 'Task-' + method + '-after-authority-lock', independentLossQueued: true, queuedAt: new Date().toISOString() };
        const loss = scenario.authority === 'account' ? User.collection.updateOne({ _id: owner.user._id }, { $set: { authVersion: 1 } }) : AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } });
        // Awaiting this competing write inside our transaction would deadlock.
        queued = loss.then(async result => {
          record.injection.resolvedAt = new Date().toISOString(); record.injection.realWriteResult = { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
          record.injection.tasksAtLossResolution = await readTasks(); record.injection.auditAtLossResolution = await readAudit();
          record.injection.authorityAtLossResolution = scenario.authority === 'account' ? await readUser() : await readSession(); return result;
        });
      }
      return original(...args);
    });
    const response = await mutate(scenario.operation); record.response = { status: response.status, body: response.body };
    expect(queued).toBeDefined(); expect((await queued).modifiedCount).toBe(1); expect(response.status).toBe(scenario.operation === 'create' ? 201 : 200);
    expect(record.injection.tasksAtLossResolution.length).toBe(scenario.operation === 'create' ? record.beforeTasks.length + 1 : record.beforeTasks.length - 1);
    expect(record.injection.auditAtLossResolution.length).toBe(record.beforeAudit.length + 1); expect(await readCase()).toEqual(record.beforeCase);
  } finally { if (queued) await queued; await evidence(record); }
});
test.each(['create', 'delete'])('a private Task %s audit-storage failure rolls back actual Task and authority-lock changes', async operation => {
  const record = await beforeRecord(operation);
  try {
    jest.spyOn(AuditLog, 'logFromReq').mockRejectedValueOnce(new Error('Synthetic private Task audit storage unavailable'));
    const response = await mutate(operation); record.response = { status: response.status, body: response.body };
    expect(response.status).toBe(500); expect(await readTasks()).toEqual(record.beforeTasks); expect(await readUser()).toEqual(record.beforeUser); expect(await readSession()).toEqual(record.beforeSession); expect(await readAudit()).toEqual(record.beforeAudit); expect(await readCase()).toEqual(record.beforeCase);
  } finally { await evidence(record); }
});
test.each([
  { operation: 'create', loss: 'expired' }, { operation: 'create', loss: 'foreign-owner' }, { operation: 'create', loss: 'record-deleted' },
  { operation: 'delete', loss: 'expired' }, { operation: 'delete', loss: 'foreign-owner' }, { operation: 'delete', loss: 'record-deleted' },
])('a real managed SID loss winning before private Task arbitration %j cannot write Task or Audit', async scenario => {
  const record = await beforeRecord(scenario.operation); record.scenario = scenario; const original = AuthSession.collection.updateOne.bind(AuthSession.collection); let lost = false;
  try {
    jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
      if (!lost && options?.session && change?.$inc?.__v && filter.sessionId === owner.session.sessionId) {
        lost = true;
        const result = scenario.loss === 'record-deleted' ? await AuthSession.collection.deleteOne({ sessionId: owner.session.sessionId }) : await original({ sessionId: owner.session.sessionId }, { $set: scenario.loss === 'expired' ? { expiresAt: new Date(Date.now() - 1) } : { userId: other.user._id } });
        expect(scenario.loss === 'record-deleted' ? result.deletedCount : result.modifiedCount).toBe(1);
        record.injection = { stage: 'session-lock', independentlyCommitted: true, realWriteResult: { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, deletedCount: result.deletedCount }, actualSessionAfterInjection: await readSession() };
      }
      return original(filter, change, options);
    });
    const response = await mutate(scenario.operation); record.response = { status: response.status, body: response.body }; expect(lost).toBe(true);
    expect([403, 409]).toContain(response.status); expect(await readTasks()).toEqual(record.beforeTasks); expect(await readUser()).toEqual(record.beforeUser); expect(await readAudit()).toEqual(record.beforeAudit); expect(await readCase()).toEqual(record.beforeCase);
  } finally { await evidence(record); }
});
test.each(['create', 'delete'])('existing private Task reads and invalid %s requests do not allocate writes or authority nonces', async operation => {
  const record = await beforeRecord(operation);
  try {
    const read = await request(app).get('/api/checklist').query({ status: 'all', caseId: String(matter._id) }).set('Cookie', owner.cookie);
    expect(read.status).toBe(200); expect(read.body.items).toHaveLength(1); expect(read.body.items[0].notes).toBe(task.notes);
    const invalid = operation === 'create' ? [
      await request(app).post('/api/checklist').set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf).send({ ...fields(), title: '' }),
      await request(app).post('/api/checklist').set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf).send({ ...fields(), due: '2026-12-22' }),
      await request(app).post('/api/checklist').set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf).send({ ...fields(), owner: String(other.user._id) }),
    ] : [
      await request(app).delete('/api/checklist/invalid').set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf),
      await request(app).delete(`/api/checklist/${task._id}?unexpected=true`).set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf),
    ];
    record.invalidStatuses = invalid.map(value => value.status); invalid.forEach(value => expect(value.status).toBe(400));
    expect(await readTasks()).toEqual(record.beforeTasks); expect(await readUser()).toEqual(record.beforeUser); expect(await readSession()).toEqual(record.beforeSession); expect(await readAudit()).toEqual(record.beforeAudit); expect(await readCase()).toEqual(record.beforeCase);
  } finally { await evidence(record); }
});
test('compatible older Attorney tokens and missing account versions preserve default private Task create and delete contracts', async () => {
  await User.collection.updateOne({ _id: owner.user._id }, { $unset: { authVersion: '' } });
  const token = `token=${jwt.sign({ id: String(owner.user._id), role: 'attorney' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', token);
  const legacy = { ...owner, cookie: [token, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
  const record = await beforeRecord('create-and-delete-compatible-token');
  try {
    const created = await mutate('create', legacy); record.createdResponse = { status: created.status, body: created.body }; expect(created.status).toBe(201);
    expect((await ChecklistTask.findById(created.body.id).lean()).owner).toEqual(owner.user._id);
    const deleted = await mutate('delete', legacy); record.deletedResponse = { status: deleted.status, body: deleted.body }; expect(deleted.status).toBe(200);
    expect(await readTask()).toBeNull(); expect(await readCase()).toEqual(record.beforeCase); expect((await readAudit()).length).toBe(record.beforeAudit.length + 2);
  } finally { await evidence(record); }
});
