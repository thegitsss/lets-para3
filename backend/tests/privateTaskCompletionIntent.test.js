const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), AuthSession = require('../models/AuthSession'), ChecklistTask = require('../models/ChecklistTask'), Case = require('../models/Case'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken } = require('../utils/csrf');
const app = express(); app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/checklist', require('../routes/checklist'));
let owner, task, previousCsrf;
beforeAll(async () => { previousCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); });
afterAll(async () => { if (previousCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = previousCsrf; await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
async function actor(role = 'attorney') {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Task intent', email: `${role}-${require('crypto').randomUUID()}@intent.test`, password: 'Synthetic task intent password!', role, status: 'approved', emailVerified: true });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Private task intent API' }, ip: '192.0.2.20' });
  const cookie = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', cookie);
  return { user, session, cookie: [cookie, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
const read = () => ChecklistTask.collection.findOne({ _id: task._id });
const review = (value, done) => ({ done, revision: value.updatedAt ? value.updatedAt.toISOString() : null, expectedOwnerId: String(owner.user._id) });
const write = (body, person = owner, id = task._id) => request(app).post(`/api/checklist/${id}/toggle`).set('Cookie', person.cookie).set('X-CSRF-Token', person.csrf).send(body);
const audits = () => AuditLog.countDocuments({ action: 'task.toggle', targetId: task._id });
beforeEach(async () => {
  await clearDatabase(); owner = await actor();
  task = await ChecklistTask.create({ owner: owner.user._id, title: 'Owner-only intent', notes: 'Preserve private notes.', due: new Date('2026-12-21T16:00:00Z') });
  await ChecklistTask.collection.updateOne({ _id: task._id }, { $set: { retainedEvidence: { source: 'earlier-record', unknownField: 42 } } });
});

test('explicit completion and same-desired retries retain the completion actor, time, revision and unrelated metadata', async () => {
  const para = await actor('paralegal');
  const matter = await Case.create({ title: 'Shared filing', details: 'Prepare the shared filing.', status: 'in_progress', attorney: owner.user._id, attorneyId: owner.user._id, paralegal: para.user._id, paralegalId: para.user._id, hiredAt: new Date(), tasksLocked: true, escrowIntentId: 'pi_synthetic_private_intent', escrowStatus: 'funded', totalAmount: 120000, currency: 'usd', tasks: [{ title: 'Agreed work', completed: false }] });
  await ChecklistTask.collection.updateOne({ _id: task._id }, { $set: { caseId: matter._id } });
  const before = await read(), matterBefore = await Case.collection.findOne({ _id: matter._id }), body = review(before, true);
  const result = await write(body); expect(result.status).toBe(200); expect(result.body.done).toBe(true);
  const completed = await read(); expect(completed.done).toBe(true); expect(completed.completedBy).toEqual(owner.user._id); expect(completed.completedAt).toBeInstanceOf(Date); expect(completed.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  for (const key of ['owner', 'caseId', 'title', 'notes', 'due', 'createdAt', 'retainedEvidence']) expect(completed[key]).toEqual(before[key]);
  expect((await write(body)).status).toBe(200); expect(await read()).toEqual(completed); expect(await audits()).toBe(1);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(matterBefore);
});
test('explicit reopening and same-desired retries clear only completion fields without changing their retry revision', async () => {
  expect((await write(review(await read(), true))).status).toBe(200);
  const completed = await read(), body = review(completed, false);
  expect((await write(body)).status).toBe(200); const reopened = await read();
  expect(reopened.done).toBe(false); expect(reopened.completedAt).toBeNull(); expect(reopened.completedBy).toBeNull();
  expect((await write(body)).status).toBe(200); expect(await read()).toEqual(reopened); expect(await audits()).toBe(2);
});
test('a stale contradictory decision and an open-complete-open ABA history cannot overwrite the current revision', async () => {
  const initial = await read(), oldComplete = review(initial, true);
  expect((await write(oldComplete)).status).toBe(200); const completed = await read();
  expect((await write(review(initial, false))).status).toBe(409); expect(await read()).toEqual(completed);
  expect((await write(review(completed, false))).status).toBe(200); const reopened = await read();
  expect((await write(oldComplete)).status).toBe(409); expect(await read()).toEqual(reopened); expect(await audits()).toBe(2);
});
test('two changes in the same clock millisecond still receive distinct monotonic CAS revisions', async () => {
  const instant = Date.now(); await ChecklistTask.collection.updateOne({ _id: task._id }, { $set: { updatedAt: new Date(instant) } });
  jest.spyOn(Date, 'now').mockReturnValue(instant);
  expect((await write(review(await read(), true))).status).toBe(200); const completed = await read(); expect(completed.updatedAt.getTime()).toBe(instant + 1);
  expect((await write(review(completed, false))).status).toBe(200); expect((await read()).updatedAt.getTime()).toBe(instant + 2);
});
test('concurrent identical decisions never invert and an explicit retry preserves the single committed completion', async () => {
  const body = review(await read(), true), responses = await Promise.all([write(body), write(body)]);
  expect(responses.some(result => result.status === 200)).toBe(true); responses.forEach(result => expect([200, 409]).toContain(result.status));
  const completed = await read(); expect(completed.done).toBe(true); expect(completed.completedBy).toEqual(owner.user._id);
  expect((await write(body)).status).toBe(200); expect(await read()).toEqual(completed); expect(await audits()).toBe(1);
});
function beforeTaskCas(work) {
  const original = ChecklistTask.collection.updateOne.bind(ChecklistTask.collection); let called = false;
  jest.spyOn(ChecklistTask.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
    if (!called && options?.session && typeof change?.$set?.done === 'boolean') { called = true; await work(original); }
    return original(filter, change, options);
  });
}
test('a real newer task revision winning at the write boundary preserves its notes and completion state', async () => {
  const initial = await read(); beforeTaskCas(writeRaw => writeRaw({ _id: task._id }, { $set: { notes: 'Current reviewed notes.', updatedAt: new Date(initial.updatedAt.getTime() + 500) } }));
  expect((await write(review(initial, true))).status).toBe(409); const current = await read(); expect(current.notes).toBe('Current reviewed notes.'); expect(current.done).toBe(false); expect(await audits()).toBe(0);
});
test('a changed owner winning at the write boundary prevents a late decision from mutating the transferred record', async () => {
  const other = await actor(), initial = await read(); beforeTaskCas(writeRaw => writeRaw({ _id: task._id }, { $set: { owner: other.user._id } }));
  expect([404, 409]).toContain((await write(review(initial, true))).status); const current = await read(); expect(current.owner).toEqual(other.user._id); expect(current.done).toBe(false); expect(current.completedBy).toBeNull(); expect(await audits()).toBe(0);
});
test('a removed task winning at the write boundary is never recreated by a late completion', async () => {
  const initial = await read(); beforeTaskCas(() => ChecklistTask.collection.deleteOne({ _id: task._id }));
  expect([404, 409]).toContain((await write(review(initial, true))).status); expect(await read()).toBeNull(); expect(await audits()).toBe(0);
});
function beforeAccountLock(change) {
  const original = User.collection.updateOne.bind(User.collection); let called = false;
  jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, update, options) => {
    if (!called && options?.session && update?.$inc?.__v) { called = true; await original({ _id: owner.user._id }, { $set: change }); }
    return original(filter, update, options);
  });
}
test.each([{ role: 'paralegal' }, { status: 'pending' }, { disabled: true }, { deleted: true }, { authVersion: 1 }])('current account authority winning at the mutation lock rejects %j without changing the Task', async change => {
  const initial = await read(); beforeAccountLock(change);
  expect((await write(review(initial, true))).status).toBe(403); expect(await read()).toEqual(initial); expect(await audits()).toBe(0);
});
test.each(['revoked', 'expired'])('a managed session that becomes %s at its mutation lock cannot change the Task', async mode => {
  const initial = await read(), original = AuthSession.collection.updateOne.bind(AuthSession.collection); let called = false;
  jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (filter, change, options) => {
    if (!called && options?.session && change?.$inc?.__v) { called = true; await original({ sessionId: owner.session.sessionId }, { $set: mode === 'revoked' ? { revokedAt: new Date() } : { expiresAt: new Date(0) } }); }
    return original(filter, change, options);
  });
  expect([403, 409]).toContain((await write(review(initial, true))).status); expect(await read()).toEqual(initial); expect(await audits()).toBe(0);
});
test.each(['session', 'account'])('an already-satisfied no-op rechecks current %s authority without changing the Task revision', async mode => {
  expect((await write(review(await read(), true))).status).toBe(200); const completed = await read(), original = ChecklistTask.collection.findOne.bind(ChecklistTask.collection); let called = false;
  jest.spyOn(ChecklistTask.collection, 'findOne').mockImplementation(async (...args) => {
    const value = await original(...args);
    if (!called && value) { called = true; if (mode === 'session') await AuthSession.collection.updateOne({ sessionId: owner.session.sessionId }, { $set: { revokedAt: new Date() } }); else await User.collection.updateOne({ _id: owner.user._id }, { $set: { authVersion: 1 } }); }
    return value;
  });
  expect((await write(review(completed, true))).status).toBe(403); expect(await read()).toEqual(completed); expect(await audits()).toBe(1);
});
test('older records without a timestamp accept an exact null revision and compatible no-body callers still toggle', async () => {
  await ChecklistTask.collection.updateOne({ _id: task._id }, { $unset: { updatedAt: '' } }); const old = await read();
  expect((await write(review(old, true))).status).toBe(200); const completed = await read();
  expect((await write(review(old, true))).status).toBe(200); expect(await read()).toEqual(completed);
  expect((await write({})).status).toBe(200); const reopened = await read(); expect(reopened.done).toBe(false); expect(reopened.retainedEvidence).toEqual(old.retainedEvidence); expect(await audits()).toBe(2);
});
test('malformed, foreign-owner and unreviewed explicit completion bodies never write', async () => {
  const initial = await read(), valid = review(initial, true), other = await actor();
  for (const body of [{ ...valid, done: 'true' }, { done: true, expectedOwnerId: valid.expectedOwnerId }, { ...valid, revision: 'old' }, { ...valid, expectedOwnerId: 'bad' }, { ...valid, unsupported: true }]) expect((await write(body)).status).toBe(400);
  expect((await write({ ...valid, expectedOwnerId: String(other.user._id) })).status).toBe(403); expect(await read()).toEqual(initial); expect(await audits()).toBe(0);
});
test('other Attorney owners and Paralegal/Admin roles cannot inspect or mutate private completion', async () => {
  const initial = await read();
  for (const role of ['attorney', 'paralegal', 'admin']) {
    const other = await actor(role), result = await write({ ...review(initial, true), expectedOwnerId: String(other.user._id) }, other);
    expect(result.status).toBe(role === 'attorney' ? 404 : 403); expect(JSON.stringify(result.body)).not.toContain(initial.title);
  }
  expect(await read()).toEqual(initial); expect(await audits()).toBe(0);
});
test('the actual managed-session completion request requires its own CSRF token', async () => {
  const initial = await read(), other = await actor();
  expect((await request(app).post(`/api/checklist/${task._id}/toggle`).set('Cookie', owner.cookie).send(review(initial, true))).status).toBe(403);
  expect((await request(app).post(`/api/checklist/${task._id}/toggle`).set('Cookie', owner.cookie).set('X-CSRF-Token', other.csrf).send(review(initial, true))).status).toBe(403);
  expect(await read()).toEqual(initial); expect(await audits()).toBe(0);
});
