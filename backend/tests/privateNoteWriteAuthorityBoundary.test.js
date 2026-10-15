const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), Case = require('../models/Case'), WeeklyNote = require('../models/WeeklyNote'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
const { legacyStorageWeek } = require('../services/weeklyNotes');
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_private_note_boundary';
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async (_userId, _type, _payload, options = {}) => options.deferDispatch ? async () => ({}) : {}) }));
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/cases', require('../routes/cases'));
app.use('/api/users', require('../routes/users'));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message, code: error.publicCode || error.code }));
const operations = ['case-save', 'weekly-update', 'weekly-create'];
const week = '2026-10-12', emptyWeek = '2026-10-19';
const savedText = 'Private original paragraphs.\n\nKeep this retained note.';
const newText = 'Private new paragraphs.\n\nOnly the intended owner can save these notes.';
const blank = () => Array(7).fill('');
let owner, other, paralegal, admin, matter, weekly, priorCsrf;
beforeAll(async () => { priorCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); await WeeklyNote.init(); });
afterAll(async () => { if (priorCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = priorCsrf; await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
async function actor(role) {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Private note boundary', email: `${role}-${crypto.randomUUID()}@private-note-boundary.test`, password: 'Synthetic private note boundary password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Actual private note write boundary API' }, ip: '192.0.2.29' });
  const sessionRecord = await AuthSession.collection.findOne({ sessionId: session.sessionId, userId: user._id }); expect(sessionRecord).not.toBeNull();
  const token = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', token); expect(csrf.status).toBe(200);
  return { user, session, sessionRecordId: String(sessionRecord._id), cookie: [token, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
beforeEach(async () => {
  await clearDatabase(); owner = await actor('attorney'); other = await actor('attorney'); paralegal = await actor('paralegal'); admin = await actor('admin');
  matter = await Case.create({ title: 'Private note boundary Matter', details: 'Shared work and finances must remain unchanged by private notes.', attorney: owner.user._id, attorneyId: owner.user._id, paralegal: paralegal.user._id, paralegalId: paralegal.user._id, status: 'in progress', tasks: [{ title: 'Agreed work stays unchanged', completed: false }], internalNotes: { text: savedText, futureMetadata: { keep: true, label: 'retained' } }, totalAmount: 40000, currency: 'usd' });
  // The strict current schema cannot create an unknown historical field.
  // Seed it in the actual raw record, as the original retained-note suite does.
  await Case.collection.updateOne({ _id: matter._id }, { $set: { 'internalNotes.futureMetadata': { keep: true, label: 'retained' } } });
  expect((await Case.collection.findOne({ _id: matter._id })).internalNotes.futureMetadata).toEqual({ keep: true, label: 'retained' });
  weekly = await WeeklyNote.create({ userId: owner.user._id, weekStart: legacyStorageWeek(week), calendarWeek: week, notes: [savedText, ...blank().slice(1)], revision: 4 });
  await WeeklyNote.collection.updateOne({ _id: weekly._id }, { $set: { retainedEvidence: { unknownField: 42, source: 'earlier-record' } } });
});
const keyFor = operation => operation === 'weekly-create' ? emptyWeek : week;
const read = (operation, person = owner) => request(app).get(operation === 'case-save' ? `/api/cases/${matter._id}/notes` : `/api/users/me/weekly-notes?weekStart=${keyFor(operation)}`).set('Cookie', person.cookie);
async function bodyFor(operation, person = owner) {
  const result = await read(operation, person); expect(result.status).toBe(200);
  return operation === 'case-save' ? { note: newText, revision: result.body.revision, expectedOwnerId: String(person.user._id) } : { weekStart: keyFor(operation), notes: [newText, ...blank().slice(1)], revision: result.body.revision };
}
function save(operation, body, person = owner, token = person.csrf) {
  const call = request(app).put(operation === 'case-save' ? `/api/cases/${matter._id}/notes` : '/api/users/me/weekly-notes').set('Cookie', person.cookie).send(body);
  if (token) call.set('X-CSRF-Token', token); return call;
}
const readCases = () => Case.collection.find({}).sort({ _id: 1 }).toArray();
const readWeeks = () => WeeklyNote.collection.find({}).sort({ _id: 1 }).toArray();
const readUsers = () => User.collection.find({}, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1, __v: 1 } }).sort({ _id: 1 }).toArray();
const readSessions = () => AuthSession.collection.find({}, { projection: { userId: 1, createdAt: 1, updatedAt: 1, expiresAt: 1, revokedAt: 1, revokedReason: 1, __v: 1 } }).sort({ _id: 1 }).toArray();
const readAudit = () => AuditLog.collection.find({}).sort({ _id: 1 }).toArray();
async function snapshot() { return { cases: await readCases(), weeklyNotes: await readWeeks(), users: await readUsers(), sessions: await readSessions(), audit: await readAudit() }; }
async function evidence(record) {
  if (!process.env.LPC_PRIVATE_NOTE_AUTHORITY_EVIDENCE) return;
  const title = expect.getState().currentTestName, filename = crypto.createHash('sha256').update(title).digest('hex') + '.json';
  const value = { title, ...record, after: await snapshot(), actorIds: { owner: String(owner.user._id), other: String(other.user._id), paralegal: String(paralegal.user._id), admin: String(admin.user._id) }, managedSessionRecordIds: [owner, other, paralegal, admin].map(person => person.sessionRecordId) };
  await fs.mkdir(process.env.LPC_PRIVATE_NOTE_AUTHORITY_EVIDENCE, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.LPC_PRIVATE_NOTE_AUTHORITY_EVIDENCE, filename), JSON.stringify(value, null, 2), { mode: 0o600 });
}
function winningWriteHook(operation, inject) {
  const collection = operation === 'case-save' ? Case.collection : WeeklyNote.collection;
  const method = operation === 'case-save' ? 'updateOne' : operation === 'weekly-update' ? 'findOneAndUpdate' : 'insertOne';
  const original = collection[method].bind(collection);
  jest.spyOn(collection, method).mockImplementation(async (...args) => {
    const selected = operation === 'case-save' ? args[1]?.$set?.internalNotes?.text === newText : operation === 'weekly-update' ? args[1]?.$set?.notes?.[0] === newText : args[0]?.notes?.[0] === newText;
    if (selected) await inject({ method, filterOrDocument: args[0], options: args[operation === 'weekly-create' ? 1 : 2] });
    return original(...args);
  });
}
function winningAuthorityReadHook(operation, inject) {
  const original = mongoose.Query.prototype.exec;
  jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function (...args) {
    // Return the actual query result without synthesizing an account or ACL
    // verdict. Hold its return only after authentication has completed and
    // before the handler can acquire any future final-write authority lock.
    const result = await original.apply(this, args);
    const fields = this._fields || {}, query = this.getQuery();
    const selected = operation === 'case-save'
      ? this.model?.modelName === 'Case' && this.op === 'findOne' && String(query._id) === String(matter._id) && fields.internalNotes === 1
      : this.model?.modelName === 'User' && this.op === 'findOne' && String(query._id) === String(owner.user._id) && fields.status === 1 && fields.role === 1 && Object.keys(fields).length === 2;
    if (selected && result) await inject({ stage: operation === 'case-save' ? 'after-actual-Case-ACL-query-before-return' : 'after-actual-User-approval-query-before-return', query, fields, options: this.getOptions(), actualRead: operation === 'case-save' ? { id: String(result._id), attorney: String(result.attorney), attorneyId: String(result.attorneyId) } : { id: String(result._id), role: result.role, status: result.status } });
    return result;
  });
}
async function verifySaved(operation, person = owner) {
  if (operation === 'case-save') {
    const raw = await Case.collection.findOne({ _id: matter._id }); expect(raw.internalNotes.text).toBe(newText); expect(raw.internalNotes.updatedBy).toEqual(person.user._id); expect(raw.internalNotes.futureMetadata).toEqual({ keep: true, label: 'retained' });
  } else {
    const raw = await WeeklyNote.collection.findOne({ userId: person.user._id, calendarWeek: keyFor(operation) }); expect(raw.notes).toEqual([newText, ...blank().slice(1)]); expect(raw.userId).toEqual(person.user._id);
    if (person === owner && operation === 'weekly-update') { expect(raw._id).toEqual(weekly._id); expect(raw.revision).toBe(5); expect(raw.retainedEvidence).toEqual({ unknownField: 42, source: 'earlier-record' }); }
  }
}
test.each(operations)('valid managed authority retains %s, private isolation and actual CSRF protections', async operation => {
  const body = await bodyFor(operation), record = { operation, before: await snapshot(), controls: [] };
  try {
    for (const token of [null, other.csrf]) { const response = await save(operation, body, owner, token); record.controls.push({ kind: token ? 'foreign-CSRF' : 'missing-CSRF', status: response.status, body: response.body }); expect(response.status).toBe(403); }
    const outsider = await save(operation, body, other); record.controls.push({ kind: 'other-owner', status: outsider.status, body: outsider.body }); expect([403, 404, 409]).toContain(outsider.status); expect(JSON.stringify(outsider.body)).not.toContain(savedText);
    if (operation === 'case-save') {
      for (const method of ['read', 'save']) { const result = method === 'read' ? await read(operation, paralegal) : await save(operation, { ...body, expectedOwnerId: String(paralegal.user._id) }, paralegal); record.controls.push({ kind: 'opposite-participant-' + method, status: result.status, body: result.body }); expect([403, 404]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain(savedText); }
    } else { const otherRead = await read(operation, other); expect(otherRead.status).toBe(200); expect(otherRead.body.notes).toEqual(blank()); }
    expect(await readCases()).toEqual(record.before.cases); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit);
    const response = await save(operation, body); record.response = { status: response.status, body: response.body }; expect(response.status).toBe(200); await verifySaved(operation);
    if (operation === 'case-save') {
      const saved = await snapshot(); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(saved.cases[0].updatedAt).toEqual(record.before.cases[0].updatedAt);
      const adminBody = await bodyFor(operation, admin); const adminResponse = await save(operation, adminBody, admin); record.controls.push({ kind: 'approved-Admin-Case-note', status: adminResponse.status, body: adminResponse.body }); expect(adminResponse.status).toBe(200); await verifySaved(operation, admin);
    } else {
      expect(await readCases()).toEqual(record.before.cases);
      for (const person of [paralegal, admin]) {
        // requireApprovedUser already admits approved Paralegals and bypasses
        // approval for active Admins. This is API compatibility, not new UI.
        if (person === admin) await User.collection.updateOne({ _id: person.user._id }, { $set: { status: 'pending' } });
        if (operation === 'weekly-update') await WeeklyNote.create({ userId: person.user._id, weekStart: legacyStorageWeek(week), calendarWeek: week, notes: ['Own retained week', ...blank().slice(1)], revision: 2 });
        const compatibleBody = await bodyFor(operation, person); const compatible = await save(operation, compatibleBody, person); record.controls.push({ kind: person === admin ? 'active-pending-Admin-own-weekly' : 'approved-Paralegal-own-weekly', status: compatible.status, body: compatible.body }); expect(compatible.status).toBe(200); await verifySaved(operation, person);
      }
    }
    expect(await readAudit()).toEqual(record.before.audit);
  } finally { await evidence(record); }
});
const losses = [
  ...['case-save', 'weekly-update', 'weekly-create'].flatMap(operation => ['authVersion', 'disabled', 'deleted', 'status', 'session-revoked', 'session-expired', 'session-foreign-owner', 'session-record-deleted'].map(loss => ({ operation, loss }))),
  { operation: 'case-save', loss: 'role' },
];
test.each(losses)('winning actual account or managed-session loss %j cannot persist a private note', async scenario => {
  const body = await bodyFor(scenario.operation), record = { scenario, before: await snapshot(), injection: null }; let injected = false;
  try {
    winningAuthorityReadHook(scenario.operation, async point => {
      if (injected) return; injected = true;
      let result;
      if (scenario.loss === 'session-record-deleted') result = await AuthSession.collection.deleteOne({ sessionId: owner.session.sessionId });
      else if (scenario.loss.startsWith('session-')) result = await AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: scenario.loss === 'session-revoked' ? { revokedAt: new Date() } : scenario.loss === 'session-expired' ? { expiresAt: new Date(Date.now() - 1) } : { userId: other.user._id } });
      else result = await User.collection.updateOne({ _id: owner.user._id }, { $set: { [scenario.loss]: scenario.loss === 'authVersion' ? 1 : scenario.loss === 'role' ? 'paralegal' : scenario.loss === 'status' ? 'pending' : true } });
      expect(scenario.loss === 'session-record-deleted' ? result.deletedCount : result.modifiedCount).toBe(1);
      record.injection = { stage: point.stage, originalQuery: point.query, originalProjection: point.fields, actualReadBeforeLoss: point.actualRead, transactionPresent: Boolean(point.options?.session?.inTransaction()), beforeAnyFinalWriteAuthorityLock: true, independentlyCommitted: true, realWriteResult: { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, deletedCount: result.deletedCount }, afterWinningLossBeforeOriginalWrite: await snapshot() };
    });
    const response = await save(scenario.operation, body); record.response = { status: response.status, body: response.body };
    expect(injected).toBe(true); expect([401, 403, 409]).toContain(response.status); expect(await readCases()).toEqual(record.before.cases); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit);
  } finally { await evidence(record); }
});
test.each(['weekly-update', 'weekly-create'])('an approved Attorney-to-Paralegal transition preserves existing own %s authority without changed credentials', async operation => {
  const body = await bodyFor(operation), record = { operation, before: await snapshot(), injection: null }; let injected = false;
  try {
    winningAuthorityReadHook(operation, async point => {
      if (injected) return; injected = true; const result = await User.collection.updateOne({ _id: owner.user._id }, { $set: { role: 'paralegal' } }); expect(result.modifiedCount).toBe(1);
      record.injection = { stage: point.stage, originalQuery: point.query, originalProjection: point.fields, actualReadBeforeTransition: point.actualRead, beforeAnyFinalWriteAuthorityLock: true, independentlyCommitted: true, realWriteResult: { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }, afterRoleTransitionBeforeOriginalWrite: await snapshot(), policy: 'requireApprovedUser admits this active approved role with unchanged authVersion and managed SID' };
    });
    const response = await save(operation, body); record.response = { status: response.status, body: response.body }; expect(injected).toBe(true); expect(response.status).toBe(200); await verifySaved(operation);
    const current = await read(operation); expect(current.status).toBe(200); expect(current.body.notes[0]).toBe(newText); expect(await readCases()).toEqual(record.before.cases); expect(await readAudit()).toEqual(record.before.audit);
  } finally { await evidence(record); }
});
test.each(['owner', 'revision'])('Case-note existing %s compare-and-swap preserves an actual winning Matter change', async loss => {
  const body = await bodyFor('case-save'), record = { operation: 'case-save', loss, before: await snapshot(), injection: null }; let injected = false;
  try {
    winningWriteHook('case-save', async point => {
      if (injected) return; injected = true; const result = await Case.collection.updateOne({ _id: matter._id }, { $set: loss === 'owner' ? { attorney: other.user._id, attorneyId: other.user._id } : { internalNotes: { text: 'Independent saved Matter version', futureMetadata: { keep: true, label: 'retained' }, updatedBy: owner.user._id, updatedAt: new Date() } } }); expect(result.modifiedCount).toBe(1);
      record.injection = { stage: 'original-' + point.method, independentlyCommitted: true, originalFilter: point.filterOrDocument, realWriteResult: { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }, actualWinningSnapshot: await snapshot() };
    });
    const response = await save('case-save', body); record.response = { status: response.status, body: response.body }; expect(injected).toBe(true); expect([403, 409]).toContain(response.status); expect(await readCases()).toEqual(record.injection.actualWinningSnapshot.cases); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit); expect(JSON.stringify(response.body)).not.toContain('Independent saved Matter version');
  } finally { await evidence(record); }
});
test.each(['owner', 'revision'])('weekly-update existing %s compare-and-swap preserves an actual winning private record change', async loss => {
  const body = await bodyFor('weekly-update'), record = { operation: 'weekly-update', loss, before: await snapshot(), injection: null }; let injected = false;
  try {
    winningWriteHook('weekly-update', async point => {
      if (injected) return; injected = true; const result = await WeeklyNote.collection.updateOne({ _id: weekly._id }, loss === 'owner' ? { $set: { userId: other.user._id } } : { $set: { notes: ['Independent saved weekly version', ...blank().slice(1)] }, $inc: { revision: 1 } }); expect(result.modifiedCount).toBe(1);
      record.injection = { stage: 'original-' + point.method, independentlyCommitted: true, originalFilter: point.filterOrDocument, realWriteResult: { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }, actualWinningSnapshot: await snapshot() };
    });
    const response = await save('weekly-update', body); record.response = { status: response.status, body: response.body }; expect(injected).toBe(true); expect(response.status).toBe(409); expect(await readWeeks()).toEqual(record.injection.actualWinningSnapshot.weeklyNotes); expect(await readCases()).toEqual(record.before.cases); expect(await readAudit()).toEqual(record.before.audit); expect(JSON.stringify(response.body)).not.toContain('Independent saved weekly version');
  } finally { await evidence(record); }
});
test('weekly-create uniqueness preserves a different actual first-save winner and its private text', async () => {
  const body = await bodyFor('weekly-create'), record = { operation: 'weekly-create', before: await snapshot(), injection: null }; let injected = false;
  try {
    winningWriteHook('weekly-create', async point => {
      if (injected) return; injected = true;
      const saved = await WeeklyNote.create({ userId: owner.user._id, weekStart: legacyStorageWeek(emptyWeek), calendarWeek: emptyWeek, notes: ['Independent first weekly save', ...blank().slice(1)], revision: 1 });
      record.injection = { stage: 'original-' + point.method, independentlyCommitted: true, independentlyInsertedId: String(saved._id), actualWinningSnapshot: await snapshot() };
    });
    const response = await save('weekly-create', body); record.response = { status: response.status, body: response.body }; expect(injected).toBe(true); expect(response.status).toBe(409); expect(await readWeeks()).toEqual(record.injection.actualWinningSnapshot.weeklyNotes); expect(await readCases()).toEqual(record.before.cases); expect(await readAudit()).toEqual(record.before.audit); expect(JSON.stringify(response.body)).not.toContain('Independent first weekly save');
  } finally { await evidence(record); }
});

function observeActualDataWrite(operation, afterWrite) {
  const collection = operation === 'case-save' ? Case.collection : WeeklyNote.collection;
  const method = operation === 'case-save' ? 'updateOne' : operation === 'weekly-update' ? 'findOneAndUpdate' : 'insertOne';
  const original = collection[method].bind(collection);
  jest.spyOn(collection, method).mockImplementation(async (...args) => {
    const selected = operation === 'case-save' ? args[1]?.$set?.internalNotes?.text === newText : operation === 'weekly-update' ? args[1]?.$set?.notes?.[0] === newText : args[0]?.notes?.[0] === newText;
    const result = await original(...args);
    if (selected) await afterWrite({ method, options: args[operation === 'weekly-create' ? 1 : 2], actualResult: result });
    return result;
  });
}

test.each(operations.flatMap(operation => ['account', 'session'].map(authority => ({ operation, authority }))))('the actual authorized private-note commit serializes a later queued loss %j', async scenario => {
  const body = await bodyFor(scenario.operation), record = { scenario, before: await snapshot(), injection: null }; let queued, writes = 0;
  try {
    winningWriteHook(scenario.operation, async point => {
      writes++; expect(point.options?.session?.inTransaction()).toBe(true);
      if (queued) return;
      record.injection = { stage: 'actual-' + point.method + '-after-User-and-SID-locks', independentLossQueued: true, queuedAt: new Date().toISOString(), transactionPresent: true };
      const change = scenario.authority === 'account' ? User.collection.updateOne({ _id: owner.user._id }, { $set: { authVersion: 1 } }) : AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } });
      // This real competing write waits for the current actor/SID lock. Never
      // await it inside the transaction that must release that lock.
      queued = change.then(async result => {
        record.injection.resolvedAt = new Date().toISOString();
        record.injection.realWriteResult = { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
        record.injection.actualSnapshotAtLossResolution = await snapshot(); return result;
      });
    });
    const response = await save(scenario.operation, body); record.response = { status: response.status, body: response.body }; expect(queued).toBeDefined(); expect((await queued).modifiedCount).toBe(1); expect(response.status).toBe(200); expect(writes).toBe(1); await verifySaved(scenario.operation);
    const atLoss = record.injection.actualSnapshotAtLossResolution;
    if (scenario.operation === 'case-save') { expect(atLoss.cases[0].internalNotes.text).toBe(newText); expect(atLoss.weeklyNotes).toEqual(record.before.weeklyNotes); }
    else { expect(atLoss.cases).toEqual(record.before.cases); expect(atLoss.weeklyNotes.some(note => String(note.userId) === String(owner.user._id) && note.calendarWeek === keyFor(scenario.operation) && note.notes[0] === newText)).toBe(true); }
    expect(atLoss.audit).toEqual(record.before.audit);
    record.dataWrites = writes;
  } finally { if (queued) await queued; record.dataWrites = writes; await evidence(record); }
});

test.each(operations)('an actual Mongo data-write failure rolls back %s and its actor/session lock nonces', async operation => {
  const body = await bodyFor(operation), record = { operation, before: await snapshot(), injection: null }; let failed = false;
  try {
    winningAuthorityReadHook(operation, async point => {
      if (!record.beforeArbitration) record.beforeArbitration = { stage: point.stage, actualSnapshot: await snapshot() };
    });
    winningWriteHook(operation, async point => {
      if (failed) return; failed = true; expect(point.options?.session?.inTransaction()).toBe(true);
      try {
        // Send a real invalid Mongo update inside the actual transaction; no
        // mock model verdict or successful persistence is fabricated.
        await Case.collection.updateOne({ _id: matter._id }, { $lpc_invalid_private_note_test_operation: { text: 'Synthetic failure command' } }, { session: point.options.session });
        throw Error('The actual Mongo failure command unexpectedly succeeded');
      } catch (error) {
        record.injection = { stage: 'actual-' + point.method + '-after-locks', transactionPresent: true, realMongoFailure: { name: error.name, code: error.code, message: error.message } }; throw error;
      }
    });
    const response = await save(operation, body); record.response = { status: response.status, body: response.body }; expect(failed).toBe(true); expect(record.injection.realMongoFailure.code).toBe(9); expect(response.status).toBe(500);
    expect(await readCases()).toEqual(record.before.cases); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit);
    expect(await readUsers()).toEqual(record.beforeArbitration.actualSnapshot.users); expect(await readSessions()).toEqual(record.beforeArbitration.actualSnapshot.sessions);
  } finally { await evidence(record); }
});

test.each(operations)('an acknowledgement error after the real %s commit reports uncertainty without another write', async operation => {
  const body = await bodyFor(operation), record = { operation, before: await snapshot(), injection: null };
  const start = mongoose.startSession.bind(mongoose); let commits = 0, writes = 0;
  try {
    observeActualDataWrite(operation, async point => { writes++; expect(point.options?.session?.inTransaction()).toBe(true); });
    jest.spyOn(mongoose, 'startSession').mockImplementation(async (...args) => {
      const session = await start(...args), commit = session.commitTransaction.bind(session);
      session.commitTransaction = async (...commitArgs) => {
        commits++; await commit(...commitArgs);
        record.injection = { stage: 'after-actual-commit-before-acknowledgement', actualCommitCompleted: true, committedAt: new Date().toISOString(), actualSavedSnapshotBeforeAcknowledgementError: await snapshot() };
        const error = new mongoose.mongo.MongoServerError({ message: 'Synthetic acknowledgement unavailable after actual private-note commit' }); error.addErrorLabel('UnknownTransactionCommitResult'); throw error;
      };
      return session;
    });
    const response = await save(operation, body); record.response = { status: response.status, body: response.body }; record.commitCalls = commits; record.dataWrites = writes;
    expect(commits).toBe(1); expect(writes).toBe(1); expect(record.injection.actualCommitCompleted).toBe(true); expect(response.status).toBe(503); expect(response.body.code).toBe('ACCOUNT_WRITE_UNCONFIRMED'); expect(response.body.error).toMatch(/could not be confirmed/); await verifySaved(operation);
    expect(await readCases()).toEqual(record.injection.actualSavedSnapshotBeforeAcknowledgementError.cases); expect(await readWeeks()).toEqual(record.injection.actualSavedSnapshotBeforeAcknowledgementError.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit);
  } finally { record.commitCalls = commits; record.dataWrites = writes; await evidence(record); }
});

test.each(operations)('real managed-session expiry after the actual %s write aborts the private mutation', async operation => {
  const body = await bodyFor(operation), record = { operation, before: await snapshot(), injection: null }; let expiresAt, writes = 0;
  try {
    winningAuthorityReadHook(operation, async point => {
      if (expiresAt) return;
      expiresAt = new Date(Date.now() + 2000);
      const result = await AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { expiresAt } }); expect(result.modifiedCount).toBe(1);
      record.injection = { stage: point.stage, realStoredExpiresAt: expiresAt.toISOString(), expirySetBeforeAnyFinalWriteLock: true, independentlyCommitted: true, actualSnapshotBeforeArbitration: await snapshot() };
    });
    observeActualDataWrite(operation, async point => {
      writes++; expect(point.options?.session?.inTransaction()).toBe(true); expect(expiresAt).toBeDefined(); expect(Date.now()).toBeLessThan(expiresAt.getTime());
      const saved = operation === 'case-save' ? await Case.collection.findOne({ _id: matter._id }, { session: point.options.session }) : await WeeklyNote.collection.findOne({ userId: owner.user._id, calendarWeek: keyFor(operation) }, { session: point.options.session });
      expect(operation === 'case-save' ? saved.internalNotes.text : saved.notes[0]).toBe(newText);
      record.injection.actualUncommittedDataAfterWrite = saved; record.injection.actualWriteAt = new Date().toISOString();
      // This barrier waits only for the actual stored expiry being tested. It
      // changes no product clock or original30s deadline and performs no retry.
      await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt.getTime() - Date.now() + 1)));
      expect(Date.now()).toBeGreaterThan(expiresAt.getTime()); record.injection.actualExpiryCrossedAfterWriteAt = new Date().toISOString();
    });
    const response = await save(operation, body); record.response = { status: response.status, body: response.body }; record.dataWrites = writes; expect(writes).toBe(1); expect(response.status).toBe(403);
    expect(await readCases()).toEqual(record.before.cases); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit); expect(await readUsers()).toEqual(record.injection.actualSnapshotBeforeArbitration.users);
    const sid = await AuthSession.collection.findOne({ sessionId: owner.session.sessionId });
    if (sid) { expect(sid.expiresAt).toEqual(expiresAt); expect(sid.__v).toBe(record.injection.actualSnapshotBeforeArbitration.sessions.find(value => String(value._id) === owner.sessionRecordId).__v); }
    record.expiredSidDeletedByTtl = !sid;
  } finally { record.dataWrites = writes; await evidence(record); }
});

test('an active pending Admin remains denied private Case notes without acquiring write-lock nonces', async () => {
  const body = await bodyFor('case-save', admin);
  await User.collection.updateOne({ _id: admin.user._id }, { $set: { status: 'pending' } });
  const record = { operation: 'case-save', before: await snapshot(), controls: [] };
  try {
    for (const method of ['read', 'save']) {
      const response = method === 'read' ? await read('case-save', admin) : await save('case-save', body, admin); record.controls.push({ method, status: response.status, body: response.body }); expect(response.status).toBe(403); expect(JSON.stringify(response.body)).not.toContain(savedText);
    }
    expect(await readCases()).toEqual(record.before.cases); expect(await readWeeks()).toEqual(record.before.weeklyNotes); expect(await readAudit()).toEqual(record.before.audit); expect(await readUsers()).toEqual(record.before.users);
    expect((await readSessions()).map(value => ({ id: String(value._id), version: value.__v }))).toEqual(record.before.sessions.map(value => ({ id: String(value._id), version: value.__v })));
  } finally { await evidence(record); }
});
