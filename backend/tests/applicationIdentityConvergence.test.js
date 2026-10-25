const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const mongoose = require('mongoose'), { MongoMemoryReplSet } = require('mongodb-memory-server'), { randomUUID } = require('crypto');
const { clearDatabase } = require('./helpers/db');
jest.mock('../utils/stripe', () => ({}));
jest.mock('../utils/email', () => jest.fn(async () => ({})));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async () => async () => {}) }));
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application'), Decision = require('../models/ApplicationDecision');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/cases', require('../routes/cases')); app.use('/api/applications', require('../routes/applications'));
const id = value => String(value).toLowerCase(), upper = value => id(value).toUpperCase();
const savedProfile = { bio: 'Saved application bio', location: 'New York', availability: 'Recorded availability', yearsExperience: 7, languages: ['English'], specialties: ['Immigration'], profileImage: '' };
const cookie = user => `token=${require('jsonwebtoken').sign({ id: id(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let mongo, owner, para, other, admin, caseId, jobId, applicationId;
const get = (path, actor = owner, query = {}) => request(app).get(path).query(query).set('Cookie', cookie(actor));
const read = (surface, query = {}, actor = owner) => get(`/api/cases/${caseId}/${surface}`, actor, { expectedOwnerId: id(actor._id), ...query });
const decisionPath = () => `/api/cases/${caseId}/application-review/${para._id}/decision`;
const reviewDecision = () => get(decisionPath(), owner, { expectedOwnerId: id(owner._id) });
const sendDecision = input => request(app).post(decisionPath()).set('Cookie', cookie(owner)).send({ expectedOwnerId: id(owner._id), ...input });
const stored = () => Promise.all([Case.collection.find({}).sort({ _id: 1 }).toArray(), Job.collection.find({}).sort({ _id: 1 }).toArray(), Application.collection.find({}).sort({ _id: 1 }).toArray()]);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' } }); await mongoose.connect(mongo.getUri('application-identity-convergence'));
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para, other, admin] = await User.create(['owner', 'para', 'other', 'admin'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@identity.example`, password: 'Password123!', role: name === 'para' ? 'paralegal' : name === 'admin' ? 'admin' : 'attorney', status: 'approved' })));
  caseId = new mongoose.Types.ObjectId(); jobId = new mongoose.Types.ObjectId(); applicationId = new mongoose.Types.ObjectId();
  await Case.collection.insertOne({ _id: caseId, attorney: owner._id, attorneyId: owner._id, title: 'Application identity agreement', details: 'Private synthetic review.', status: 'open', totalAmount: 60001, jobId, applicants: [{ paralegalId: para._id, status: 'pending', note: 'Preserved letter', profileSnapshot: savedProfile, starredBy: [owner._id, other._id] }], __v: 0 });
  await Job.collection.insertOne({ _id: jobId, attorneyId: owner._id, caseId, title: 'Application identity agreement', description: 'Private synthetic review.', practiceArea: 'Immigration', budget: 600.01, status: 'open', applicantsCount: 1 });
  await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: 'submitted', coverLetter: 'Preserved letter', profileSnapshot: savedProfile, syncStatus: 'synced', starredBy: [owner._id, other._id], createdAt: new Date('2026-01-01') });
});
afterEach(() => jest.restoreAllMocks());
async function referenceForm(kind) {
  if (kind === 'object') return;
  const ref = kind === 'lowercase' ? id : upper;
  await Case.collection.updateOne({ _id: caseId }, { $set: { attorney: ref(owner._id), attorneyId: id(owner._id), jobId: ref(jobId), 'applicants.0.paralegalId': ref(para._id), 'applicants.0.starredBy': [ref(owner._id), other._id] } });
  if (kind === 'uppercase_owners') await Case.collection.updateOne({ _id: caseId }, { $set: { attorneyId: upper(owner._id) } });
  await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: ref(owner._id), caseId: ref(caseId) } });
  await Application.collection.updateOne({ _id: applicationId }, { $set: { jobId: ref(jobId), paralegalId: ref(para._id), starredBy: [ref(owner._id), other._id] } });
  if (kind === 'string_primary') {
    const record = await Application.collection.findOne({ _id: applicationId }); await Application.collection.deleteOne({ _id: applicationId });
    await Application.collection.insertOne({ ...record, _id: upper(applicationId) });
  }
}
test.each(['object', 'lowercase', 'uppercase', 'uppercase_owners', 'string_primary'])('%s account application remains one normalized selected and paginated Matter record without writes', async kind => {
  await referenceForm(kind); const before = await stored();
  const account = await get('/api/applications/my-postings'); expect(account.status).toBe(200); expect(account.body).toHaveLength(1);
  const detail = await get(`/api/cases/${caseId}`, owner, { expectedOwnerId: id(owner._id) });
  expect({ status: detail.status, error: detail.status === 200 ? null : detail.body }).toEqual({ status: 200, error: null });
  expect(detail.body.applicants[0].profileSnapshot).toEqual(savedProfile);
  const legacyReview = await get(`/api/cases/${caseId}/applicants`);
  expect(legacyReview.status).toBe(200); expect(legacyReview.body.applicants[0].profileSnapshot).toEqual(savedProfile);
  for (const actor of [owner, admin]) for (const surface of ['application-review', 'application-inventory']) {
    const response = await read(surface, { applicantId: upper(para._id) }, actor);
    expect({ status: response.status, error: response.status === 200 ? null : response.body }).toEqual({ status: 200, error: null });
    expect(response.body).toMatchObject({ caseId: id(caseId), selectedApplicantId: id(para._id), applications: [{ applicationId: id(applicationId), applicantId: id(para._id), name: 'Synthetic para', coverLetter: 'Preserved letter', warnings: [] }] });
    expect(response.body.applications).toHaveLength(1);
    if (actor === owner) expect(response.body.applications[0].starred).toBe(true);
  }
  const inventory = await read('application-inventory'); expect(inventory.status).toBe(200); expect(inventory.body).toMatchObject({ total: 1, counts: { submitted: 1 } });
  expect(await stored()).toEqual(before); expect(require('../utils/notifyUser').notifyUser).not.toHaveBeenCalled();
});
test.each(['owner', 'admin', 'para'])('%s reads an earlier saved profile without database internals or another viewer star list', async kind => {
  await Application.collection.deleteMany({});
  const before = await stored(), actor = { owner, admin, para }[kind];
  // Admin uses the existing administrative Case read; the account-bound
  // workspace query is reserved for the attorney owner or paralegal actor.
  for (const suffix of ['', '/applicants']) {
    const response = await get(`/api/cases/${caseId}${suffix}`, actor, kind === 'admin' ? {} : { expectedOwnerId: id(actor._id) });
    expect({ status: response.status, error: response.status === 200 ? null : response.body }).toEqual({ status: 200, error: null });
    expect(response.body.applicants).toHaveLength(1);
    expect(response.body.applicants[0].profileSnapshot).toEqual(savedProfile);
    expect(response.body.applicants[0].appliedAt).toBeNull();
    expect(JSON.stringify(response.body.applicants[0].profileSnapshot)).not.toMatch(/\$__|_doc|starredBy/);
    if (kind === 'para') expect(response.body.applicants[0].starred).toBe(false);
  }
  expect(await stored()).toEqual(before);
  const recordedAt = new Date('2026-02-03T14:15:00Z');
  await Case.collection.updateOne({ _id: caseId }, { $set: { 'applicants.0.appliedAt': recordedAt } });
  for (const suffix of ['', '/applicants']) {
    const response = await get(`/api/cases/${caseId}${suffix}`, actor, kind === 'admin' ? {} : { expectedOwnerId: id(actor._id) });
    expect(response.status).toBe(200); expect(response.body.applicants[0].appliedAt).toBe(recordedAt.toISOString());
  }
});
test('an uppercase earlier-only application remains selected and has no invented canonical record', async () => {
  await referenceForm('uppercase'); await Application.collection.deleteMany({});
  await Case.collection.updateOne({ _id: caseId }, { $set: { invites: [{ paralegalId: upper(para._id), status: 'accepted', invitedAt: new Date('2026-01-01') }] } });
  const before = await stored(); expect((await get('/api/applications/my-postings')).body).toHaveLength(1);
  for (const surface of ['application-review', 'application-inventory']) {
    const response = await read(surface, { applicantId: upper(para._id) }); expect(response.status).toBe(200);
    expect(response.body.applications).toHaveLength(1); expect(response.body.applications[0]).toMatchObject({ applicationId: null, applicantId: id(para._id), warnings: ['earlier_record'] });
  }
  expect(await stored()).toEqual(before);
});
test.each(['uppercase', 'string_primary'])('%s reviewed decisions preserve exact records, other stars, counts and replay receipts', async kind => {
  await referenceForm(kind);
  for (const action of ['unstar', 'shortlist', 'reject']) {
    const review = await reviewDecision(); expect(review.status).toBe(200); expect(review.body.reason).toBe('ready');
    const input = { revision: review.body.revision, requestId: randomUUID(), action }, response = await sendDecision(input);
    expect(response.status).toBe(200); expect(response.body.receipt).toMatchObject({ applicantId: id(para._id), applicationId: id(applicationId), action });
    const before = await stored(); expect((await sendDecision(input)).body).toEqual(response.body); expect(await stored()).toEqual(before);
    const saved = await get(`${decisionPath()}/${input.requestId}`, owner, { expectedOwnerId: id(owner._id) }); expect(saved.body.receipt).toEqual(response.body.receipt);
    const [matters, jobs, applications] = before, record = applications[0];
    expect(record._id).toEqual(kind === 'string_primary' ? upper(applicationId) : applicationId);
    expect(record.paralegalId).toBe(upper(para._id)); expect(record.coverLetter).toBe('Preserved letter');
    expect(record.starredBy.map(id)).toEqual([id(other._id)]); expect(matters[0].applicants[0].starredBy.map(id)).toEqual([id(other._id)]);
    expect(jobs[0].applicantsCount).toBe(action === 'reject' ? 0 : 1);
  }
  expect(await Decision.countDocuments()).toBe(3);
});
test.each(['duplicate_person', 'duplicate_primary', 'duplicate_profile'])('%s is unavailable in selected review and inventory without choosing one identity', async kind => {
  if (kind === 'duplicate_profile') { const profile = await User.collection.findOne({ _id: para._id }); await User.collection.insertOne({ ...profile, _id: upper(para._id), email: 'duplicate@identity.example' }); }
  else { const record = await Application.collection.findOne({ _id: applicationId }); await Application.collection.insertOne({ ...record, _id: kind === 'duplicate_primary' ? upper(applicationId) : new mongoose.Types.ObjectId(), jobId: upper(jobId), paralegalId: upper(para._id), coverLetter: 'PRIVATE_DUPLICATE' }); }
  const before = await stored();
  for (const surface of ['application-review', 'application-inventory']) {
    const response = await read(surface, { applicantId: id(para._id) }); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_REVIEW_SOURCE_INVALID'); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DUPLICATE');
  }
  const decision = await reviewDecision(); expect(decision.status).toBe(409); expect(await stored()).toEqual(before);
});
test.each(['object', 'uppercase', 'string_primary'])('%s own withdrawal retains the record and removes the same Matter entry', async kind => {
  await referenceForm(kind);
  const response = await request(app).post(`/api/applications/${applicationId}/revoke`).set('Cookie', cookie(para)).send({});
  expect({ status: response.status, body: response.body }).toEqual({ status: 200, body: { success: true } });
  const [matters, jobs, applications] = await stored(); expect(applications).toHaveLength(1); expect(applications[0]).toMatchObject({ status: 'withdrawn', syncStatus: 'synced', coverLetter: 'Preserved letter' });
  expect(matters[0].applicants).toEqual([]); expect(jobs[0].applicantsCount).toBe(0);
  expect((await get('/api/applications/my-postings')).body).toEqual([]);
  const own = await get('/api/applications/my', para); expect(own.status).toBe(200); expect(own.body[0]).toMatchObject({ _id: id(applicationId), status: 'withdrawn' });
});
test('mixed physical application IDs page once in logical order and keep selected history reachable', async () => {
  const records = Array.from({ length: 60 }, (_, n) => {
    const value = new mongoose.Types.ObjectId();
    return { _id: n % 3 === 0 ? upper(value) : n % 3 === 1 ? id(value) : value, jobId: n % 2 ? upper(jobId) : jobId, paralegalId: new mongoose.Types.ObjectId(), status: 'rejected', coverLetter: `Historical record ${n}` };
  });
  await Application.collection.insertMany(records);
  const before = await stored(); let cursor = '', seen = [];
  do {
    const response = await read('application-review', cursor ? { cursor } : {}); expect(response.status).toBe(200);
    seen.push(...response.body.applications.map(row => row.applicationId)); cursor = response.body.next;
  } while (cursor);
  const expected = [id(applicationId), ...records.map(row => id(row._id))].sort().reverse();
  expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(61);
  const inventory = await read('application-inventory'); expect(inventory.status).toBe(200); expect(inventory.body.total).toBe(61);
  expect(await stored()).toEqual(before);
});
test('a duplicate application primary identity belonging to another person is rejected before counts or selected evidence', async () => {
  const record = await Application.collection.findOne({ _id: applicationId });
  await Application.collection.insertOne({ ...record, _id: upper(applicationId), paralegalId: new mongoose.Types.ObjectId(), createdAt: new Date('2000-01-01') });
  for (const surface of ['application-review', 'application-inventory']) {
    const response = await read(surface, { applicantId: id(para._id) }); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_REVIEW_SOURCE_INVALID');
  }
});
test('string posting and candidate primary identities retain the same available profile and reviewed decision', async () => {
  await referenceForm('uppercase');
  for (const [Model, value] of [[Job, jobId], [User, para._id]]) {
    const record = await Model.collection.findOne({ _id: value }); await Model.collection.deleteOne({ _id: value }); await Model.collection.insertOne({ ...record, _id: upper(value) });
  }
  const response = await read('application-inventory', { q: 'Synthetic para' }); expect(response.status).toBe(200); expect(response.body.total).toBe(1); expect(response.body.applications[0]).toMatchObject({ name: 'Synthetic para', profileAvailable: true });
  const review = await reviewDecision(); expect(review.status).toBe(200); expect(review.body.reason).toBe('ready');
  expect((await sendDecision({ revision: review.body.revision, action: 'reject', requestId: randomUUID() })).status).toBe(200);
});
test.each([{ status: 'pending' }, { role: 'attorney' }])('unavailable candidate %j does not expose current identity in decision review', async change => {
  await User.collection.updateOne({ _id: para._id }, { $set: change });
  const response = await reviewDecision(); expect(response.status).toBe(200); expect(response.body).toMatchObject({ name: 'Paralegal applicant', reason: 'profile_unavailable', actions: [] });
});
test.each(['funded', 'owner_conflict', 'duplicate', 'account_changed'])('raw identity withdrawal keeps the existing %s guard and changes no application records', async kind => {
  await referenceForm('string_primary');
  if (kind === 'funded') {
    await Case.collection.updateOne({ _id: caseId }, { $set: { escrowStatus: 'funded', paralegalId: upper(para._id) } });
    await Application.collection.updateOne({ _id: upper(applicationId) }, { $set: { status: 'accepted' } });
  }
  if (kind === 'owner_conflict') await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: other._id } });
  if (kind === 'duplicate') { const record = await Application.collection.findOne({ _id: upper(applicationId) }); await Application.collection.insertOne({ ...record, _id: applicationId, jobId, paralegalId: para._id }); }
  if (kind === 'account_changed') await User.collection.updateOne({ _id: para._id }, { $set: { authVersion: 1 } });
  const before = await stored(), response = await request(app).post(`/api/applications/${applicationId}/revoke`).set('Cookie', cookie(para)).send({});
  expect([400, 401, 403, 409]).toContain(response.status); expect(await stored()).toEqual(before); expect(require('../utils/notifyUser').notifyUser).not.toHaveBeenCalled();
});
