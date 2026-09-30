const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const { clearDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_deletion_consistency';
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const AuditLog = require('../models/AuditLog');
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/cases', require('../routes/cases'));
app.use('/api/admin', require('../routes/admin'));
let mongo, owner, other, para, admin;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' } });
  await mongoose.connect(mongo.getUri('matter-deletion-consistency'));
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
}, 60000);
beforeEach(async () => {
  await clearDatabase();
  [owner, other, para] = await User.create(['owner', 'other', 'para'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@deletion.test`, password: 'Synthetic123!', role: name === 'para' ? 'paralegal' : 'attorney', status: 'approved' })));
  admin = await User.create({ firstName: 'Synthetic', lastName: 'Admin', email: 'admin-route@deletion.test', password: 'Synthetic123!', role: 'admin', status: 'approved' });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
async function fixture(attorney = owner) {
  const matter = await Case.create({ title: 'Synthetic eligible posting', details: 'Synthetic deletion consistency review.', status: 'open', attorney: attorney._id, attorneyId: attorney._id, totalAmount: 40001, currency: 'usd' });
  const job = await Job.create({ attorneyId: attorney._id, caseId: matter._id, title: matter.title, description: matter.details, practiceArea: 'contract law', budget: 400.01 });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId: job._id, job: job._id } });
  const application = await Application.create({ jobId: job._id, paralegalId: para._id, coverLetter: 'Synthetic application evidence.', status: 'submitted' });
  return { matter, job, application };
}
async function remove(surface, value, actor = surface === 'admin' ? admin : owner, extra = {}) {
  const path = surface === 'admin' ? `/api/admin/cases/${value.matter._id}` : surface === 'current' ? `/api/cases/${value.matter._id}` : `/api/cases/posting/${value.matter._id}`;
  const body = { expectedOwnerId: String(actor._id) };
  if (surface === 'reviewed') {
    const review = await request(app).get(path).set('Cookie', authCookieFor(actor));
    expect(review.status).toBe(200); body.revision = review.body.posting.revision;
  }
  return request(app).delete(path).set('Cookie', authCookieFor(actor)).send({ ...body, ...extra });
}
async function retained(value) {
  return { matter: Boolean(await Case.collection.findOne({ _id: value.matter._id })), job: Boolean(await Job.collection.findOne({ _id: value.job._id })), application: Boolean(await Application.collection.findOne({ _id: value.application._id })) };
}
async function applicant() {
  jest.spyOn(require('../utils/stripe').accounts, 'retrieve').mockResolvedValue({ details_submitted: true, payouts_enabled: true, charges_enabled: true });
  return User.create({ firstName: 'Synthetic', lastName: 'Late applicant', email: 'late@deletion.test', password: 'Synthetic123!', role: 'paralegal', status: 'approved', profileImage: 'https://example.test/synthetic.jpg', stripeAccountId: 'acct_synthetic', stripeOnboarded: true, stripePayoutsEnabled: true });
}
const apply = (value, user) => require('../routes/applications').createApplicationForJob(String(value.job._id), { ...user.toObject(), id: String(user._id) }, 'I can prepare and organize the agreement and its exhibits.');
for (const surface of ['current', 'reviewed', 'admin']) {
  test(`${surface} deletion preserves a hiring claim committed after its snapshot was read`, async () => {
    const value = await fixture(), original = Case.collection.deleteOne.bind(Case.collection); let changed = false;
    jest.spyOn(Case.collection, 'deleteOne').mockImplementationOnce(async (...args) => {
      changed = true; await Case.collection.updateOne({ _id: value.matter._id }, { $set: { hiringClaimStatus: 'claimed', hiringClaimToken: 'synthetic_later_claim' } });
      return original(...args);
    });
    expect((await remove(surface, value)).status).toBe(409); expect(changed).toBe(true);
    expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
    expect((await Case.collection.findOne({ _id: value.matter._id })).hiringClaimToken).toBe('synthetic_later_claim');
  });
  test(`${surface} deletion rolls back when a new application commits after its snapshot`, async () => {
    const value = await fixture(), user = await applicant(), original = Case.collection.deleteOne.bind(Case.collection); let application;
    jest.spyOn(Case.collection, 'deleteOne').mockImplementationOnce(async (...args) => { application = await apply(value, user); return original(...args); });
    expect((await remove(surface, value)).status).toBe(409);
    expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
    expect((await Application.findById(application._id)).status).toBe('submitted');
  });
  test(`${surface} deletion prevents a previously read application from restoring removed records`, async () => {
    const value = await fixture(), user = await applicant(), original = Job.collection.updateOne.bind(Job.collection);
    let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
    jest.spyOn(Job.collection, 'updateOne').mockImplementationOnce(async (...args) => { arrived(); await gate; return original(...args); });
    const applying = apply(value, user).then(result => ({ result }), error => ({ error }));
    try { await waiting; expect((await remove(surface, value)).status).toBe(200); } finally { release(); }
    const outcome = await applying; expect(outcome.error).toBeDefined(); expect(outcome.result).toBeUndefined();
    expect(await retained(value)).toEqual({ matter: false, job: false, application: false });
    expect(await Application.countDocuments({ jobId: value.job._id })).toBe(0);
  });
  test.each([
    ['an unresolved Checkout session', { escrowSessionId: 'cs_synthetic_unresolved' }],
    ['a recorded hiring payment', { hiringClaimPaymentIntentId: 'pi_synthetic_retained' }],
    ['a completion claim', { completionClaimStatus: 'needs_reconciliation' }],
    ['a completion claim token', { completionClaimToken: 'synthetic_completion' }],
    ['a withdrawal claim', { withdrawalClaimStatus: 'needs_reconciliation' }],
    ['a withdrawal claim token', { withdrawalClaimToken: 'synthetic_withdrawal' }],
    ['previous withdrawal history', { withdrawalHistory: [{ reason: 'Retained synthetic engagement' }] }],
    ['a previously withdrawn paralegal', { withdrawnParalegalId: new mongoose.Types.ObjectId() }],
    ['a read-only Matter', { readOnly: true }],
  ])(`${surface} deletion retains %s even when the posting status is open`, async (_label, history) => {
    const value = await fixture(); await Case.collection.updateOne({ _id: value.matter._id }, { $set: history });
    expect((await remove(surface, value)).status).toBe(409);
    expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
  });
  for (const [label, model] of [['Job', Job], ['Application', Application]]) test(`${surface} deletion rolls back every record if ${label} cleanup fails`, async () => {
    const value = await fixture();
    jest.spyOn(model.collection, 'deleteMany').mockRejectedValueOnce(new Error('Synthetic deletion cleanup failure'));
    const response = await remove(surface, value);
    expect({ status: response.status, ...await retained(value) }).toEqual({ status: 503, matter: true, job: true, application: true });
  });
  for (const differentOwner of [false, true]) test(`${surface} deletion rejects a reference to another ${differentOwner ? "attorney's" : 'same-owner'} Matter and retains both record sets`, async () => {
    const value = await fixture(), foreign = await fixture(differentOwner ? other : owner);
    await Case.collection.updateOne({ _id: value.matter._id }, { $set: { job: foreign.job._id } });
    const response = await remove(surface, value);
    expect({ status: response.status, own: await retained(value), foreign: await retained(foreign) }).toEqual({ status: 409, own: { matter: true, job: true, application: true }, foreign: { matter: true, job: true, application: true } });
  });
  test(`${surface} deletion includes earlier BSON string Job and Application references without leaving discoverable records`, async () => {
    const value = await fixture();
    await Job.collection.updateOne({ _id: value.job._id }, { $set: { attorneyId: String(owner._id), caseId: String(value.matter._id) } });
    await Application.collection.updateOne({ _id: value.application._id }, { $set: { jobId: String(value.job._id) } });
    const response = await remove(surface, value);
    expect({ status: response.status, ...await retained(value) }).toEqual({ status: 200, matter: false, job: false, application: false });
  });
  test(`${surface} deletion includes duplicate earlier related listings and applications with mixed-case string references`, async () => {
    const value = await fixture(), jobId = new mongoose.Types.ObjectId(), applicationId = new mongoose.Types.ObjectId();
    const mixed = value => String(value).split('').map((letter, index) => index % 2 ? letter.toUpperCase() : letter).join('');
    await Job.collection.insertOne({ _id: jobId, caseId: mixed(value.matter._id), attorneyId: mixed(owner._id), status: 'open', title: value.matter.title });
    await Application.collection.insertOne({ _id: applicationId, jobId: mixed(jobId), paralegalId: String(para._id), status: 'submitted' });
    expect((await remove(surface, value)).status).toBe(200);
    expect(await retained(value)).toEqual({ matter: false, job: false, application: false });
    expect(await Job.collection.findOne({ _id: jobId })).toBeNull(); expect(await Application.collection.findOne({ _id: applicationId })).toBeNull();
  });
  test(`${surface} deletion preserves a posting whose linked Job is missing instead of deleting unverifiable application history`, async () => {
    const value = await fixture(); await Job.collection.deleteOne({ _id: value.job._id });
    expect((await remove(surface, value)).status).toBe(409);
    expect(await retained(value)).toEqual({ matter: true, job: false, application: true });
  });
  test(`${surface} deletion detects another Matter's reverse reference to its Job`, async () => {
    const value = await fixture(), foreign = await fixture();
    await Case.collection.updateOne({ _id: foreign.matter._id }, { $set: { job: value.job._id } });
    expect((await remove(surface, value)).status).toBe(409);
    expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
    expect(await retained(foreign)).toEqual({ matter: true, job: true, application: true });
  });
  test(`${surface} deletion rejects conflicting Matter owner aliases`, async () => {
    const value = await fixture(); await Case.collection.updateOne({ _id: value.matter._id }, { $set: { attorneyId: other._id } });
    expect((await remove(surface, value)).status).toBe(409);
    expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
  });
  test(`${surface} deletion rechecks account availability inside the write transaction`, async () => {
    const value = await fixture(), original = User.collection.updateOne.bind(User.collection); let changed = false;
    const actor = surface === 'admin' ? admin : owner;
    jest.spyOn(User.collection, 'updateOne').mockImplementation(async (...args) => {
      if (!changed && args[2]?.session) { changed = true; await original({ _id: actor._id }, { $set: { disabled: true } }); }
      return original(...args);
    });
    expect((await remove(surface, value)).status).toBe(403); expect(changed).toBe(true);
    expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
  });
}

test('current administrator deletion retains its existing permission while using the verified Matter owner for related records', async () => {
  const value = await fixture(), admin = await User.create({ firstName: 'Synthetic', lastName: 'Admin', email: 'admin@deletion.test', password: 'Synthetic123!', role: 'admin', status: 'approved' });
  expect((await remove('current', value, admin)).status).toBe(200);
  expect(await retained(value)).toEqual({ matter: false, job: false, application: false });
});

test('admin deletion review is read-only, account-bound and retains the actual posting identity', async () => {
  const value = await fixture(), path = `/api/admin/cases/${value.matter._id}/deletion`;
  const before = await Case.collection.findOne({ _id: value.matter._id });
  const response = await request(app).get(path).query({ expectedOwnerId: String(admin._id) }).set('Cookie', authCookieFor(admin));
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body.deletion).toMatchObject({ ownerId: String(admin._id), caseId: String(value.matter._id), title: value.matter.title, canDelete: true, reason: '', revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await Case.collection.findOne({ _id: value.matter._id })).toEqual(before);
  expect(await AuditLog.countDocuments({ action: 'admin.case.delete' })).toBe(0);
  expect((await request(app).get(path).query({ expectedOwnerId: String(owner._id) }).set('Cookie', authCookieFor(admin))).status).toBe(403);
  expect((await request(app).get(path).set('Cookie', authCookieFor(owner))).status).toBe(403);
  await Case.collection.updateOne({ _id: value.matter._id }, { $set: { escrowSessionId: 'cs_synthetic_retained' } });
  const retainedReview = await request(app).get(path).set('Cookie', authCookieFor(admin));
  expect(retainedReview.status).toBe(200); expect(retainedReview.body.deletion.canDelete).toBe(false); expect(retainedReview.body.deletion.reason).toMatch(/retained/);
});

test('admin deletion rejects a posting changed after its review, even without a version or timestamp update', async () => {
  const value = await fixture();
  const review = await request(app).get(`/api/admin/cases/${value.matter._id}/deletion`).set('Cookie', authCookieFor(admin));
  expect(review.status).toBe(200);
  await Case.collection.updateOne({ _id: value.matter._id }, { $set: { title: 'Changed synthetic posting' } });
  expect((await remove('admin', value, admin, { revision: review.body.deletion.revision })).status).toBe(409);
  expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
  expect(await AuditLog.countDocuments({ action: 'admin.case.delete' })).toBe(0);
});

test('admin deletion rejects changed account context, a nonadmin and a malformed revision', async () => {
  const value = await fixture();
  expect((await remove('admin', value, owner)).status).toBe(403);
  expect((await remove('admin', value, admin, { expectedOwnerId: String(owner._id) })).status).toBe(403);
  expect((await remove('admin', value, admin, { revision: 'unverified' })).status).toBe(400);
  expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
});

test('admin deletion verifies the initiating role inside the same write transaction', async () => {
  const value = await fixture(), original = User.collection.updateOne.bind(User.collection); let changed = false;
  jest.spyOn(User.collection, 'updateOne').mockImplementation(async (...args) => {
    if (!changed && args[2]?.session) { changed = true; await original({ _id: admin._id }, { $set: { role: 'attorney' } }); }
    return original(...args);
  });
  expect((await remove('admin', value)).status).toBe(403); expect(changed).toBe(true);
  expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
});

test('admin deletion retains every record if its mandatory audit entry cannot be written', async () => {
  const value = await fixture(); jest.spyOn(AuditLog.collection, 'insertOne').mockRejectedValueOnce(new Error('Synthetic audit persistence failure'));
  expect((await remove('admin', value, admin, { reason: 'Duplicate posting', message: 'Reviewed removal' })).status).toBe(503);
  expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
  expect(await AuditLog.countDocuments({ action: 'admin.case.delete' })).toBe(0);
});

test('admin deletion commits one exact audit entry with its acknowledgement and does not invent a second success', async () => {
  const value = await fixture();
  const response = await remove('admin', value, admin, { reason: 'Duplicate posting', message: 'Reviewed removal' });
  expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true, caseId: String(value.matter._id), ownerId: String(admin._id) });
  expect(await retained(value)).toEqual({ matter: false, job: false, application: false });
  const logs = await AuditLog.find({ action: 'admin.case.delete' }).lean(); expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ actor: admin._id, actorRole: 'admin', targetType: 'case', targetId: String(value.matter._id), case: value.matter._id, method: 'DELETE', path: `/api/admin/cases/${value.matter._id}`, meta: { reason: 'Duplicate posting', message: 'Reviewed removal' } });
  expect((await remove('admin', value)).status).toBe(404); expect(await AuditLog.countDocuments({ action: 'admin.case.delete' })).toBe(1);
});

test('admin deletion cannot outlive a managed-session revocation before its transaction lock', async () => {
  const value = await fixture(), sessionId = `synthetic-admin-delete-${admin._id}`;
  await AuthSession.create({ sessionId, userId: admin._id, expiresAt: new Date(Date.now() + 3600000) });
  const cookie = `token=${jwt.sign({ id: String(admin._id), role: 'admin', status: 'approved', av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const original = AuthSession.collection.updateOne.bind(AuthSession.collection); let revoked = false;
  jest.spyOn(AuthSession.collection, 'updateOne').mockImplementation(async (...args) => {
    if (!revoked && args[2]?.session) { revoked = true; await original({ sessionId }, { $set: { revokedAt: new Date() } }); }
    return original(...args);
  });
  const response = await request(app).delete(`/api/admin/cases/${value.matter._id}`).set('Cookie', cookie).send({ expectedOwnerId: String(admin._id) });
  expect([403, 409]).toContain(response.status); expect(revoked).toBe(true);
  expect(await retained(value)).toEqual({ matter: true, job: true, application: true });
});

test('admin deletion leaves a committed but unacknowledged result explicitly unconfirmed', async () => {
  const value = await fixture(), startSession = mongoose.startSession.bind(mongoose); let committed = false;
  jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
    const session = await startSession(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); committed = true; throw Object.assign(new Error('Synthetic unknown commit acknowledgement'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); };
    return session;
  });
  const response = await remove('admin', value);
  expect(response.status).toBe(503); expect(response.body.code).toBe('ACCOUNT_WRITE_UNCONFIRMED'); expect(response.body.ok).toBeUndefined(); expect(committed).toBe(true);
  expect(await retained(value)).toEqual({ matter: false, job: false, application: false });
  expect(await AuditLog.countDocuments({ action: 'admin.case.delete' })).toBe(1);
});
