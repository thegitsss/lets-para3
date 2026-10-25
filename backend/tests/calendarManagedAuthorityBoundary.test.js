const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), Case = require('../models/Case'), Event = require('../models/Event'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/events', require('../routes/events'));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message, code: error.publicCode || error.code }));
const roles = ['attorney', 'paralegal'];
const values = role => ({ title: `Private ${role} calendar entry`, start: '2027-03-13T12:00:00.000Z', end: '2027-03-13T12:00:00.000Z', type: 'deadline', isAllDay: true, timezone: 'America/New_York' });
let people, matter, readonlyMatter, priorCsrf, priorManaged;
beforeAll(async () => { priorCsrf = process.env.ENABLE_CSRF; priorManaged = process.env.REQUIRE_AUTH_SESSION; process.env.ENABLE_CSRF = 'true'; process.env.REQUIRE_AUTH_SESSION = 'true'; await connect(); await Promise.all([Event.init(), AuditLog.init(), User.init(), AuthSession.init(), Case.init()]); });
afterAll(async () => { for (const [key, prior] of [['ENABLE_CSRF', priorCsrf], ['REQUIRE_AUTH_SESSION', priorManaged]]) { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; } await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
async function actor(role, suffix) {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Calendar boundary', email: `${role}-${suffix}-${crypto.randomUUID()}@calendar-boundary.test`, password: 'Synthetic actual calendar boundary password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Actual calendar managed authority baseline' }, ip: '192.0.2.37' });
  const stored = await AuthSession.collection.findOne({ sessionId: session.sessionId, userId: user._id }); expect(stored).not.toBeNull();
  const token = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', token); expect(csrf.status).toBe(200);
  return { user, session, sessionRecordId: String(stored._id), cookie: [token, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
beforeEach(async () => {
  await clearDatabase(); people = { attorney: await actor('attorney', 'owner'), paralegal: await actor('paralegal', 'assigned'), otherAttorney: await actor('attorney', 'unrelated'), otherParalegal: await actor('paralegal', 'unrelated') };
  const fields = { title: 'Actual private calendar authority Matter', details: 'Agreed work and financial facts remain separate from private dates.', attorney: people.attorney.user._id, attorneyId: people.attorney.user._id, paralegal: people.paralegal.user._id, paralegalId: people.paralegal.user._id, status: 'in progress', tasks: [{ title: 'Agreed shared work', completed: false }], totalAmount: 90000, currency: 'usd', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_calendar_no_provider', deadlineDate: '2027-03-14', deadline: new Date('2027-03-14T00:00:00.000Z') };
  matter = await Case.create(fields); readonlyMatter = await Case.create({ ...fields, title: 'Existing read-only reminder compatibility', readOnly: true });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { retainedCalendarEvidence: { preserve: true, source: 'historical-shared-Matter' } } });
  for (const role of roles) {
    const event = await Event.create({ ...values(role), owner: people[role].user._id, caseId: matter._id, visibility: 'private', color: '#123456', source: 'system', rrule: 'FREQ=WEEKLY;BYDAY=MO', attendees: [{ email: `${role}@calendar-boundary.test`, response: 'accepted' }], reminders: [{ minutesBefore: 10, method: 'none' }] });
    await Event.collection.updateOne({ _id: event._id }, { $set: { retainedUnknown: { label: `${role} historical private metadata`, number: 37 }, 'attendees.0.unknownEvidence': 'KEEP', 'reminders.0.unknownEvidence': 'KEEP' } });
  }
});
const pathFor = (role, selectedMatter = matter) => `/api/events/${role === 'paralegal' ? 'paralegal/' : ''}matters/${selectedMatter._id}`;
const read = (role, query = {}, person = people[role], selectedMatter = matter) => request(app).get(pathFor(role, selectedMatter) + '/review').query({ expectedOwnerId: String(person.user._id), ...query }).set('Cookie', person.cookie);
const send = (role, body, person = people[role], csrf = person.csrf, selectedMatter = matter) => {
  const call = request(app).post(pathFor(role, selectedMatter) + '/reviewed-action').set('Cookie', person.cookie).send({ expectedOwnerId: String(person.user._id), ...body });
  if (csrf) call.set('X-CSRF-Token', csrf); return call;
};
async function command(role, action = 'create', event = null, changes = values(role), selectedMatter = matter) {
  const review = await read(role, {}, people[role], selectedMatter); expect(review.status).toBe(200);
  return { action, values: changes, requestId: crypto.randomUUID(), reviewedMatterRevision: review.body.revision, ...(event ? { eventId: event.id, reviewedRevision: event.revision } : {}) };
}
const readCases = () => Case.collection.find({}).sort({ _id: 1 }).toArray();
const readEvents = () => Event.collection.find({}).sort({ _id: 1 }).toArray();
const readAudit = () => AuditLog.collection.find({}).sort({ _id: 1 }).toArray();
const readUsers = () => User.collection.find({}, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1, __v: 1 } }).sort({ _id: 1 }).toArray();
const readSessions = () => AuthSession.collection.find({}, { projection: { userId: 1, createdAt: 1, updatedAt: 1, expiresAt: 1, revokedAt: 1, revokedReason: 1, __v: 1, authWriteNonce: 1 } }).sort({ _id: 1 }).toArray();
async function snapshot() { return { cases: await readCases(), events: await readEvents(), audit: await readAudit(), users: await readUsers(), sessions: await readSessions() }; }
async function evidence(record) {
  if (!process.env.LPC_CALENDAR_AUTHORITY_EVIDENCE) return;
  const title = expect.getState().currentTestName, filename = crypto.createHash('sha256').update(title).digest('hex') + '.json';
  const value = { title, ...record, after: await snapshot(), modelScope: { full: ['Case', 'Event', 'AuditLog'], sanitized: ['User', 'AuthSession'], financialProviderModelsExported: false }, actorIds: Object.fromEntries(Object.entries(people).map(([key, person]) => [key, String(person.user._id)])), managedSessionRecordIds: Object.fromEntries(Object.entries(people).map(([key, person]) => [key, person.sessionRecordId])) };
  await fs.mkdir(process.env.LPC_CALENDAR_AUTHORITY_EVIDENCE, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(process.env.LPC_CALENDAR_AUTHORITY_EVIDENCE, filename), JSON.stringify(value, null, 2), { mode: 0o600 });
}
function observeActualHandler(role, record) {
  const service = require(`../services/${role}MatterDates`), original = service.save;
  jest.spyOn(service, 'save').mockImplementation(async function (req, ...args) {
    record.invocations ||= [];
    record.invocations.push({ verifiedActorId: req.user.id, verifiedCurrentRole: req.user.role, verifiedCurrentStatus: req.user.status, authenticatedAV: req.auth.payload.av, managedSIDMatchesStoredFixture: req.authSessionId === people[role].session.sessionId, method: req.method, caseId: req.params.caseId, requestedAction: req.body.action, afterActualVerifyTokenRoleAndApproval: true });
    return original.call(this, req, ...args);
  });
}
function observeActualTransaction(record) {
  const state = { audited: false, session: null };
  const original = AuditLog.create.bind(AuditLog);
  jest.spyOn(AuditLog, 'create').mockImplementation(async (...args) => {
    const result = await original(...args);
    const row = args[0]?.[0];
    if (row?.meta?.kind === `${record.role}_calendar_action` && String(row.case) === String(matter._id)) {
      expect(args[1]?.session?.inTransaction()).toBe(true); state.audited = true; state.session = args[1].session;
      record.actualCalendarReceiptWrite = { stage: 'after-original-AuditLog.create-resolves-in-transaction', auditId: String(result[0]._id), actorId: String(result[0].actor), actorRole: result[0].actorRole, targetId: result[0].targetId, operation: result[0].meta.operation, transactionPresent: true };
    }
    return result;
  });
  return state;
}
function beforeActualCalendarActorLock(inject) {
  const original = Case.collection.findOne.bind(Case.collection);
  jest.spyOn(Case.collection, 'findOne').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (result && String(args[0]?._id) === String(matter._id) && args[1]?.session?.inTransaction()) await inject({ stage: 'after-actual-transaction-Case-read-before-new-calendar-User-and-SID-locks', actualRead: { id: String(result._id), attorney: String(result.attorney), attorneyId: String(result.attorneyId), paralegal: String(result.paralegal), paralegalId: String(result.paralegalId) }, originalFilter: args[0], transactionPresent: true, actualTransactionReceiptAlreadyWritten: false, beforeNewActorAndSidLocks: true });
    return result;
  });
}
async function injectWinningLoss(role, loss, point, record) {
  const person = people[role]; let result;
  if (loss === 'session-record-deleted') result = await AuthSession.collection.deleteOne({ _id: new mongoose.Types.ObjectId(person.sessionRecordId) });
  else if (loss.startsWith('session-')) result = await AuthSession.collection.updateOne({ _id: new mongoose.Types.ObjectId(person.sessionRecordId) }, { $set: loss === 'session-revoked' ? { revokedAt: new Date(), revokedReason: 'actual-calendar-winning-loss' } : loss === 'session-expired' ? { expiresAt: new Date(Date.now() - 1) } : { userId: people[role === 'attorney' ? 'otherAttorney' : 'otherParalegal'].user._id } });
  else result = await User.collection.updateOne({ _id: person.user._id }, { $set: { [loss]: loss === 'authVersion' ? 1 : loss === 'role' ? role === 'attorney' ? 'paralegal' : 'attorney' : loss === 'status' ? 'pending' : true } });
  expect(loss === 'session-record-deleted' ? result.deletedCount : result.modifiedCount).toBe(1);
  record.injection = { stage: point.stage, originalFilter: point.originalFilter, actualReadBeforeLoss: point.actualRead, transactionPresent: point.transactionPresent, actualTransactionReceiptAlreadyWritten: point.actualTransactionReceiptAlreadyWritten, independentlyCommittedBeforeOriginalReadReturns: true, notSyntheticAuthorityVerdict: true, beforeNewActorAndSidLocks: point.beforeNewActorAndSidLocks === true, realWriteResult: { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, deletedCount: result.deletedCount }, atWinningLossBeforeOriginalReadReturn: await snapshot() };
}
function caseFacts(raw) { const next = { ...raw }; delete next.__v; delete next.updatedAt; return next; }

test.each(roles)('valid actual managed %s calendar CRUD preserves private ownership, legacy metadata and shared Matter facts', async role => {
  const record = { role, before: await snapshot(), controls: [] }; observeActualHandler(role, record);
  try {
    const body = await command(role), other = people[role === 'attorney' ? 'otherAttorney' : 'otherParalegal'];
    for (const csrf of [null, other.csrf]) { const response = await send(role, body, people[role], csrf); record.controls.push({ kind: csrf ? 'foreign-CSRF' : 'missing-CSRF', status: response.status, body: response.body }); expect(response.status).toBe(403); }
    const foreign = await read(role, { expectedOwnerId: String(other.user._id) }); record.controls.push({ kind: 'unexpected-owner', status: foreign.status, body: foreign.body }); expect(foreign.status).toBe(403);
    const unrelated = await read(role, {}, other); record.controls.push({ kind: 'unrelated-same-role-Matter-read', status: unrelated.status, body: unrelated.body }); expect(unrelated.status).toBe(403); expect(JSON.stringify(unrelated.body)).not.toContain('historical private metadata');
    const opposite = roles.find(value => value !== role), oppositeRead = await read(role, {}, people[opposite]); record.controls.push({ kind: 'opposite-participant-role-denial', status: oppositeRead.status, body: oppositeRead.body }); expect(oppositeRead.status).toBe(403);
    const readonly = await read(role, {}, people[role], readonlyMatter); record.controls.push({ kind: 'existing-readOnly-read-compatibility', status: readonly.status, body: readonly.body }); expect(readonly.status).toBe(200);
    if (role === 'paralegal') { const readonlyWrite = await send(role, await command(role, 'create', null, values(role), readonlyMatter), people[role], people[role].csrf, readonlyMatter); record.controls.push({ kind: 'existing-Paralegal-readOnly-create-denial', status: readonlyWrite.status, body: readonlyWrite.body }); expect(readonlyWrite.status).toBe(409); }
    expect(await readEvents()).toEqual(record.before.events); expect(await readCases()).toEqual(record.before.cases); expect(await readAudit()).toEqual(record.before.audit);
    const created = await send(role, body); record.responses = [{ action: 'create', status: created.status, body: created.body }]; expect(created.status).toBe(200); const event = created.body.operation.event; expect(event.title).toBe(values(role).title);
    const repeated = await send(role, body); record.responses.push({ action: 'repeat-create', status: repeated.status, body: repeated.body }); expect(repeated.status).toBe(200); expect(repeated.body.operation.eventId).toBe(event.id);
    const legacy = record.before.events.find(row => String(row.owner) === String(people[role].user._id));
    const selected = (await read(role)).body.items.find(item => item.id === String(legacy._id));
    const updated = await send(role, await command(role, 'update', selected, { title: 'Actual revised private calendar title' })); record.responses.push({ action: 'update', status: updated.status, body: updated.body }); expect(updated.status).toBe(200);
    const storedLegacy = await Event.collection.findOne({ _id: legacy._id });
    for (const key of Object.keys(legacy).filter(key => !['title', 'updatedAt'].includes(key))) expect(storedLegacy[key]).toEqual(legacy[key]);
    expect(storedLegacy.title).toBe('Actual revised private calendar title');
    const current = (await read(role)).body.items.find(item => item.id === event.id);
    const removed = await send(role, await command(role, 'delete', current, {})); record.responses.push({ action: 'delete', status: removed.status, body: removed.body }); expect(removed.status).toBe(200);
    const olderReceipt = await send(role, body); record.responses.push({ action: 'repeat-deleted-create', status: olderReceipt.status, body: olderReceipt.body }); expect(olderReceipt.status).toBe(200); expect(olderReceipt.body.operation).toMatchObject({ status: 'recorded', event: null, changedSinceSave: true });
    expect(await readEvents()).toEqual(record.before.events.map(row => String(row._id) === String(legacy._id) ? storedLegacy : row));
    const afterCases = await readCases(); expect(afterCases.map(caseFacts)).toEqual(record.before.cases.map(caseFacts)); expect(afterCases.find(row => String(row._id) === String(readonlyMatter._id))).toEqual(record.before.cases.find(row => String(row._id) === String(readonlyMatter._id)));
    const receipts = await readAudit(); expect(receipts).toHaveLength(3); expect(receipts.map(row => row.meta.operation).sort()).toEqual(['create', 'delete', 'update']); expect(receipts.every(row => String(row.actor) === String(people[role].user._id) && String(row.case) === String(matter._id) && row.actorRole === role)).toBe(true);
  } finally { await evidence(record); }
});

async function operationCommand(role, operation) {
  if (operation === 'create') return command(role);
  const review = await read(role); expect(review.status).toBe(200);
  const selected = review.body.items.find(event => event.title === values(role).title);
  expect(selected).toBeDefined();
  return command(role, operation, selected, operation === 'delete' ? {} : { title: `Guarded ${role} private calendar change` });
}
async function assertWinningLoss(scenario) {
  const operation = scenario.operation || 'create', body = await operationCommand(scenario.role, operation);
  const record = { ...scenario, operation, before: await snapshot(), controls: [], originalBaselineStageRelocated: true }; observeActualHandler(scenario.role, record); let injected = false;
  try {
    beforeActualCalendarActorLock(async point => { if (injected) return; injected = true; await injectWinningLoss(scenario.role, scenario.loss, point, record); });
    const response = await send(scenario.role, body); record.response = { status: response.status, body: response.body };
    expect(injected).toBe(true); expect([401, 403, 409]).toContain(response.status); expect(await readEvents()).toEqual(record.before.events); expect(await readCases()).toEqual(record.before.cases); expect(await readAudit()).toEqual(record.before.audit);
    const after = await snapshot(); expect(after.users).toEqual(record.injection.atWinningLossBeforeOriginalReadReturn.users); expect(after.sessions).toEqual(record.injection.atWinningLossBeforeOriginalReadReturn.sessions);
  } finally { await evidence(record); }
}
const userLosses = roles.flatMap(role => ['authVersion', 'role', 'disabled', 'deleted', 'status'].map(loss => ({ role, loss })));
test.each(userLosses)('an independently winning current User loss %j cannot commit a private calendar write', assertWinningLoss);
const sidLosses = roles.flatMap(role => ['session-revoked', 'session-expired', 'session-foreign-owner', 'session-record-deleted'].map(loss => ({ role, loss })));
test.each(sidLosses)('an independently winning managed SID loss %j cannot commit a private calendar write', assertWinningLoss);
const laterOperationLosses = roles.flatMap(role => ['update', 'delete'].flatMap(operation => ['authVersion', 'role', 'disabled', 'deleted', 'status', 'session-revoked', 'session-expired', 'session-foreign-owner', 'session-record-deleted'].map(loss => ({ role, operation, loss }))));
test.each(laterOperationLosses)('an actual reviewed calendar operation rejects an already-winning authority loss %j', assertWinningLoss);

async function lockedAuthority(person, session, before) {
  expect(session?.inTransaction()).toBe(true);
  const user = await User.collection.findOne({ _id: person.user._id }, { session, projection: { _id: 1, role: 1, status: 1, authVersion: 1, __v: 1 } });
  const sid = await AuthSession.collection.findOne({ _id: new mongoose.Types.ObjectId(person.sessionRecordId) }, { session, projection: { _id: 1, userId: 1, expiresAt: 1, revokedAt: 1, __v: 1 } });
  expect(user).not.toBeNull(); expect(sid).not.toBeNull(); expect(user.role).toBe(person.user.role); expect(user.status).toBe('approved'); expect(Number(user.authVersion || 0)).toBe(0); expect(String(sid.userId)).toBe(String(person.user._id)); expect(sid.revokedAt).toBeNull();
  expect(user.__v).toBe((before.users.find(row => String(row._id) === String(person.user._id)).__v || 0) + 1);
  expect(sid.__v).toBe((before.sessions.find(row => String(row._id) === person.sessionRecordId).__v || 0) + 1);
  return { user, sid, transactionPresent: true, actualLockedFieldsRead: true };
}
function beforeActualEventWrite(role, operation, body, callback) {
  const method = operation === 'create' ? 'insertOne' : operation === 'update' ? 'updateOne' : 'deleteOne';
  const original = Event.collection[method].bind(Event.collection);
  jest.spyOn(Event.collection, method).mockImplementation(async (...args) => {
    const selected = operation === 'create' ? String(args[0]?.caseId) === String(matter._id) && String(args[0]?.owner) === String(people[role].user._id) : String(args[0]?._id) === body.eventId;
    if (selected) await callback({ stage: 'before-actual-Event-' + method + '-after-calendar-User-SID-locks', method, actualFilterOrDocument: args[0], session: args[operation === 'update' ? 2 : 1]?.session });
    return original(...args);
  });
}
function afterActualReceiptWrite(record, callback) {
  const original = AuditLog.create.bind(AuditLog);
  jest.spyOn(AuditLog, 'create').mockImplementation(async (...args) => {
    const result = await original(...args), row = args[0]?.[0];
    if (row?.meta?.kind === `${record.role}_calendar_action` && String(row.case) === String(matter._id)) {
      expect(args[1]?.session?.inTransaction()).toBe(true);
      record.actualCalendarReceiptWrite = { stage: 'after-original-AuditLog.create-resolves-in-transaction', auditId: String(result[0]._id), targetId: result[0].targetId, operation: result[0].meta.operation, actorId: String(result[0].actor), actorRole: result[0].actorRole, transactionPresent: true };
      await callback({ session: args[1].session, actualReceipt: record.actualCalendarReceiptWrite });
    }
    return result;
  });
}
async function verifyOneOperation(record, body, snapshotValue = null) {
  const actual = snapshotValue || await snapshot(), role = record.role, operation = record.operation, before = record.before;
  const audit = actual.audit.filter(row => !before.audit.some(old => String(old._id) === String(row._id)));
  expect(audit).toHaveLength(1); expect(audit[0].meta.operation).toBe(operation); expect(audit[0].actorRole).toBe(role); expect(String(audit[0].actor)).toBe(String(people[role].user._id)); expect(String(audit[0].case)).toBe(String(matter._id));
  const target = actual.events.find(row => String(row._id) === audit[0].targetId);
  if (operation === 'delete') { expect(target).toBeUndefined(); expect(audit[0].targetId).toBe(body.eventId); }
  else { expect(target).toBeDefined(); expect(String(target.owner)).toBe(String(people[role].user._id)); expect(String(target.caseId)).toBe(String(matter._id)); expect(target.title).toBe(body.values.title); }
  const old = before.events.find(row => String(row._id) === body.eventId);
  if (operation === 'update') for (const key of Object.keys(old).filter(key => !['title', 'updatedAt'].includes(key))) expect(target[key]).toEqual(old[key]);
  for (const prior of before.events.filter(row => String(row._id) !== body.eventId)) expect(actual.events.find(row => String(row._id) === String(prior._id))).toEqual(prior);
  expect(actual.events.length).toBe(before.events.length + (operation === 'create' ? 1 : operation === 'delete' ? -1 : 0));
  expect(actual.cases.map(caseFacts)).toEqual(before.cases.map(caseFacts));
  expect(actual.cases.find(row => String(row._id) === String(matter._id)).__v).toBe((before.cases.find(row => String(row._id) === String(matter._id)).__v || 0) + 1);
}
const operations = roles.flatMap(role => ['create', 'update', 'delete'].map(operation => ({ role, operation })));
const lateLosses = operations.flatMap(scenario => ['account', 'session'].map(authority => ({ ...scenario, authority })));
test.each(lateLosses)('an authorized actual calendar commit precedes the later queued loss %j', async scenario => {
  const body = await operationCommand(scenario.role, scenario.operation), record = { ...scenario, before: await snapshot() }; observeActualHandler(scenario.role, record); let queued, writes = 0;
  try {
    beforeActualEventWrite(scenario.role, scenario.operation, body, async point => {
      writes++; expect(writes).toBe(1); const locks = await lockedAuthority(people[scenario.role], point.session, record.before);
      record.laterLoss = { stage: point.stage, queuedUtc: new Date().toISOString(), actualUserAndSidLocks: locks, independentLossQueuedNotAwaitedInsideLock: true };
      const person = people[scenario.role];
      const loss = scenario.authority === 'account' ? User.collection.updateOne({ _id: person.user._id }, { $set: { authVersion: 1 } }) : AuthSession.collection.updateOne({ _id: new mongoose.Types.ObjectId(person.sessionRecordId) }, { $set: { revokedAt: new Date(), revokedReason: 'actual-later-calendar-loss' } });
      queued = loss.then(async result => { record.laterLoss.resolvedUtc = new Date().toISOString(); record.laterLoss.realWriteResult = { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }; record.laterLoss.actualCommittedModelsAtLossResolution = await snapshot(); return result; });
    });
    const response = await send(scenario.role, body); record.response = { status: response.status, body: response.body }; expect(queued).toBeDefined(); expect((await queued).modifiedCount).toBe(1); expect([200, 403]).toContain(response.status); expect(writes).toBe(1);
    await verifyOneOperation(record, body, record.laterLoss.actualCommittedModelsAtLossResolution); await verifyOneOperation(record, body);
    record.responseQualification = 'Business and receipt commit while actor/SID are locked; later loss resolves afterward. A postcommit403 may legitimately withhold the current read once that later loss has committed. No status-only success or instantaneous-expiry claim.';
  } finally { if (queued) await queued; await evidence(record); }
});
test.each(operations)('an actual post-insert Audit failure rolls back all calendar and authority writes %j', async scenario => {
  const body = await operationCommand(scenario.role, scenario.operation), record = { ...scenario, before: await snapshot() }; observeActualHandler(scenario.role, record); let written = false;
  try {
    afterActualReceiptWrite(record, async point => { written = true; record.rollbackPoint = { actualReceipt: point.actualReceipt, actualLockedAuthority: await lockedAuthority(people[scenario.role], point.session, record.before), syntheticFailureAfterRealAuditInsert: true }; throw new Error('Synthetic failure after actual calendar audit insert'); });
    const response = await send(scenario.role, body); record.response = { status: response.status, body: response.body }; expect(written).toBe(true); expect(response.status).toBe(503);
    const after = await snapshot(); for (const model of ['cases', 'events', 'audit', 'users', 'sessions']) expect(after[model]).toEqual(record.before[model]);
  } finally { await evidence(record); }
});
test.each(operations)('actual SID clock expiry after calendar data and audit work rolls back before commit %j', async scenario => {
  const body = await operationCommand(scenario.role, scenario.operation), person = people[scenario.role], expiresAt = new Date(Date.now() + 600);
  expect((await AuthSession.collection.updateOne({ _id: new mongoose.Types.ObjectId(person.sessionRecordId) }, { $set: { expiresAt } })).modifiedCount).toBe(1);
  const record = { ...scenario, before: await snapshot(), expiryBound: expiresAt }; observeActualHandler(scenario.role, record); let reached = false;
  try {
    afterActualReceiptWrite(record, async point => { reached = true; record.expiryPoint = { actualReceipt: point.actualReceipt, actualLockedAuthority: await lockedAuthority(person, point.session, record.before), waitBegunUtc: new Date().toISOString(), realStoredExpiry: expiresAt }; await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 2))); record.expiryPoint.actualAfterWaitUtc = new Date().toISOString(); expect(Date.now()).toBeGreaterThanOrEqual(expiresAt.getTime()); });
    const response = await send(scenario.role, body); record.response = { status: response.status, body: response.body }; expect(reached).toBe(true); expect(response.status).toBe(403);
    const after = await snapshot(); for (const model of ['cases', 'events', 'audit', 'users', 'sessions']) expect(after[model]).toEqual(record.before[model]);
  } finally { await evidence(record); }
});
test.each(operations)('a real committed calendar action with unknown acknowledgement is recovered without another write %j', async scenario => {
  const body = await operationCommand(scenario.role, scenario.operation), record = { ...scenario, before: await snapshot() }; observeActualHandler(scenario.role, record); let committed = false;
  try {
    const original = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementation(async (...args) => { const session = await original(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); committed = true; record.actualCommit = { committedUtc: new Date().toISOString(), transactionStillOpen: session.inTransaction(), modelsAfterRealCommitBeforeThrow: await snapshot() }; throw new Error('Synthetic acknowledgement lost after actual calendar commit'); }; return session; });
    const response = await send(scenario.role, body); record.response = { status: response.status, body: response.body }; expect(committed).toBe(true); expect(response.status).toBe(503); expect(record.actualCommit.transactionStillOpen).toBe(false); await verifyOneOperation(record, body, record.actualCommit.modelsAfterRealCommitBeforeThrow);
    const committedSnapshot = await snapshot(); const checked = await read(scenario.role, { requestId: body.requestId }); record.recoveryRead = { status: checked.status, body: checked.body }; expect(checked.status).toBe(200); expect(checked.body.operation).toMatchObject({ status: 'recorded', action: scenario.operation, changedSinceSave: false });
    const repeat = await send(scenario.role, body); record.repeat = { status: repeat.status, body: repeat.body }; expect(repeat.status).toBe(200); expect(repeat.body.operation.eventId).toBe(checked.body.operation.eventId);
    const after = await snapshot(); for (const model of ['cases', 'events', 'audit', 'users', 'sessions']) expect(after[model]).toEqual(committedSnapshot[model]);
  } finally { await evidence(record); }
});
