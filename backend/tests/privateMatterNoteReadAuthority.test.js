const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), Case = require('../models/Case'), AuditLog = require('../models/AuditLog');
const verifyToken = require('../utils/verifyToken');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_note_read_boundary';
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async (_userId, _type, _payload, options = {}) => options.deferDispatch ? async () => ({}) : {}) }));
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.get('/fixture/current-actor', verifyToken, (req, res) => res.json({ id: req.user.id, role: req.user.role, status: req.user.status, authVersion: req.authVersion, managedSession: Boolean(req.authSessionId) }));
app.use('/api/cases', require('../routes/cases'));
const privateText = 'PRIVATE_ROLE_NOTE_SENTINEL\n\nRetained Attorney-only paragraphs.';
let owner, other, paralegal, admin, matter, previousCsrf;
beforeAll(async () => { previousCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); });
afterAll(async () => { if (previousCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = previousCsrf; await closeDatabase(); });
beforeEach(async () => {
  await clearDatabase(); owner = await actor('attorney'); other = await actor('attorney'); paralegal = await actor('paralegal'); admin = await actor('admin');
  matter = await Case.create({ title: 'Retained private-role note Matter', details: 'Shared records remain available only under their existing boundaries.', attorney: owner.user._id, attorneyId: owner.user._id, paralegal: paralegal.user._id, paralegalId: paralegal.user._id, status: 'in progress', totalAmount: 40000, internalNotes: { text: privateText, updatedBy: owner.user._id, updatedAt: new Date('2026-09-01T12:00:00Z') } });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { 'internalNotes.futureMetadata': { source: 'retained-note', keep: true } } });
});
async function actor(role) {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Note read boundary', email: `${role}-${crypto.randomUUID()}@private-note-read.test`, password: 'Synthetic private note read password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Actual private Matter note read boundary' }, ip: '192.0.2.31' });
  const token = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', token); expect(csrf.status).toBe(200);
  return { user, session, cookie: [token, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
async function snapshot() {
  return {
    cases: await Case.collection.find({}).sort({ _id: 1 }).toArray(),
    users: await User.collection.find({}, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1, __v: 1 } }).sort({ _id: 1 }).toArray(),
    sessions: await AuthSession.collection.find({}, { projection: { userId: 1, createdAt: 1, updatedAt: 1, expiresAt: 1, revokedAt: 1, __v: 1 } }).sort({ _id: 1 }).toArray(),
    audit: await AuditLog.collection.find({}).sort({ _id: 1 }).toArray(),
  };
}
async function evidence(record) {
  if (!process.env.LPC_PRIVATE_NOTE_READ_EVIDENCE) return;
  const title = expect.getState().currentTestName;
  await fs.mkdir(process.env.LPC_PRIVATE_NOTE_READ_EVIDENCE, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.LPC_PRIVATE_NOTE_READ_EVIDENCE, crypto.createHash('sha256').update(title).digest('hex') + '.json'), JSON.stringify({ title, ...record, after: await snapshot(), actorIds: { owner: String(owner.user._id), other: String(other.user._id), paralegal: String(paralegal.user._id), admin: String(admin.user._id) } }, null, 2), { mode: 0o600 });
}
test.each(['owner-Attorney', 'approved-Admin', 'unrelated-Attorney', 'opposite-Paralegal', 'settled-owner-to-Paralegal'])('private Matter note GET preserves retained owner-only access for %s without changing records', async scenario => {
  let person = scenario === 'approved-Admin' ? admin : scenario === 'unrelated-Attorney' ? other : scenario === 'opposite-Paralegal' ? paralegal : owner;
  const record = { scenario, beforeRoleChange: await snapshot(), injection: null };
  try {
    if (scenario === 'settled-owner-to-Paralegal') {
      const result = await User.collection.updateOne({ _id: owner.user._id }, { $set: { role: 'paralegal' } }); expect(result.modifiedCount).toBe(1);
      record.injection = { actualRoleChangeBeforeRequest: true, independentlyCommitted: true, realWriteResult: { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }, retainedCaseOwnerAliasesUnchanged: true, authVersionAndManagedSidUnchanged: true };
    }
    record.beforeRead = await snapshot();
    const observed = await request(app).get('/fixture/current-actor').set('Cookie', person.cookie); record.actualAuthenticatedActor = { status: observed.status, body: observed.body }; expect(observed.status).toBe(200); expect(observed.body.managedSession).toBe(true);
    expect(observed.body.id).toBe(String(person.user._id)); expect(observed.body.role).toBe(scenario === 'settled-owner-to-Paralegal' ? 'paralegal' : person.user.role);
    const response = await request(app).get(`/api/cases/${matter._id}/notes`).set('Cookie', person.cookie); record.response = { status: response.status, body: response.body, cacheControl: response.headers['cache-control'] };
    if (scenario === 'owner-Attorney' || scenario === 'approved-Admin' || scenario === 'settled-owner-to-Paralegal') {
      expect(response.status).toBe(200); expect(response.body).toMatchObject({ caseId: String(matter._id), note: privateText }); expect(response.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(response.body)).not.toContain('futureMetadata');
    } else { expect([403, 404]).toContain(response.status); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_ROLE_NOTE_SENTINEL'); expect(JSON.stringify(response.body)).not.toContain('futureMetadata'); }
    if (scenario === 'settled-owner-to-Paralegal') {
      // Retained ownership permits reading one's old note. It does not retain
      // the former current-role mutation privilege verified by the write suite.
      const denied = await request(app).put(`/api/cases/${matter._id}/notes`).set('Cookie', person.cookie).set('X-CSRF-Token', person.csrf).send({ note: 'A settled Paralegal cannot change this retained Attorney note.', revision: response.body.revision, expectedOwnerId: String(person.user._id) });
      record.actualDeniedWrite = { status: denied.status, body: denied.body }; expect(denied.status).toBe(403); expect(denied.body.code).not.toBe('CSRF_INVALID');
      expect((await snapshot()).sessions.map(value => ({ id: String(value._id), version: value.__v }))).toEqual(record.beforeRead.sessions.map(value => ({ id: String(value._id), version: value.__v })));
    }
    expect((await snapshot()).cases).toEqual(record.beforeRead.cases); expect((await snapshot()).users).toEqual(record.beforeRead.users); expect((await snapshot()).audit).toEqual(record.beforeRead.audit);
  } finally { await evidence(record); }
});
