const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { Types } = require('mongoose');

process.env.EMAIL_DISABLE = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_application_projections';
jest.mock('../utils/stripe', () => ({}));

const User = require('../models/User');
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const Block = require('../models/Block');
const projections = require('../services/accountApplicationProjections');
const { fingerprint } = require('../services/matterDraftRevision');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/applications', require('../routes/applications'));
app.use('/api/attorney/dashboard', require('../routes/attorneyDashboard'));
app.use('/api/paralegal/dashboard', require('../routes/paralegalDashboard'));
const pending = new Set(['submitted', 'viewed', 'shortlisted']);
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '2h' })}`;
const get = (path, user) => request(app).get(path).set('Cookie', cookie(user));

async function fixture(status = 'submitted', { earlier = false } = {}) {
  const people = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Application', lastName: role, email: `${role}@projection.example`, password: 'Password123!', role, status: 'approved' })));
  const [attorney, paralegal] = people;
  const matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, title: 'Pending application agreement', details: 'Prepare a filing for attorney review.', status: 'open', totalAmount: 60001, applicants: [{ paralegalId: paralegal._id, status: pending.has(status) || status === 'withdrawn' ? 'pending' : status, note: 'A retained application.' }], ...(earlier ? { invites: [{ paralegalId: paralegal._id, status: 'accepted', invitedAt: new Date(), respondedAt: new Date() }] } : {}) });
  const job = await Job.create({ practiceArea: 'Immigration', attorneyId: attorney._id, caseId: matter._id, title: matter.title, description: matter.details, budget: 600.01, status: 'open' });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
  const application = earlier ? null : await Application.create({ jobId: job._id, paralegalId: paralegal._id, status, coverLetter: 'A retained application.', scopeSnapshot: { caseId: matter._id, title: matter.title } });
  return { attorney, paralegal, matter, job, application };
}

async function surfaces(f) {
  const paths = [['own', '/api/applications/my', f.paralegal], ['received', '/api/applications/my-postings', f.attorney], ['attorney', '/api/attorney/dashboard', f.attorney], ['paralegal', '/api/paralegal/dashboard', f.paralegal]];
  const result = {};
  for (const [key, path, user] of paths) {
    const response = await get(path, user); expect(response.status).toBe(200); result[key] = response.body;
  }
  return result;
}
function expectCounts(result, count) {
  expect(result.received).toHaveLength(count);
  expect(result.attorney.metrics.pendingApplications).toBe(count);
  expect(result.attorney.pendingApplications).toHaveLength(Math.min(count, 10));
  expect(result.paralegal.metrics.pendingApplications).toBe(count);
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);
afterEach(() => jest.restoreAllMocks());

test.each(['submitted', 'viewed', 'shortlisted', 'accepted', 'rejected', 'withdrawn'])('%s has one shared pending meaning without removing retained own history', async status => {
  const f = await fixture(status); const result = await surfaces(f);
  expectCounts(result, pending.has(status) ? 1 : 0);
  expect(result.own).toHaveLength(1);
  expect(result.own[0].status).toBe(status);
  expect(result.paralegal.myApplications).toHaveLength(status === 'withdrawn' ? 0 : 1);
});

test('an accepted invitation with only an earlier application contributes once on both dashboards', async () => {
  const result = await surfaces(await fixture('submitted', { earlier: true }));
  expectCounts(result, 1);
  expect(result.own[0].applicationSource).toBe('invite_accept');
  expect(result.paralegal.myApplications).toHaveLength(1);
  expect(result.received[0].budget).toBe(600.01);
});

test.each(['accepted', 'rejected', 'withdrawn'])('a canonical %s outcome suppresses a stale pending mirror everywhere', async status => {
  const f = await fixture(status);
  await Case.updateOne({ _id: f.matter._id }, { $set: { 'applicants.0.status': 'pending' } });
  const result = await surfaces(f); expectCounts(result, 0); expect(result.own[0].status).toBe(status);
});

test.each([
  ['closed Matter', { status: 'closed' }], ['archived Matter', { archived: true }],
  ['assigned Matter', { paralegalId: new Types.ObjectId() }],
  ['funded Matter', { escrowStatus: 'funded' }], ['released Matter', { paymentReleased: true }],
])('%s keeps the application history without pending counts', async (_label, change) => {
  const f = await fixture(); await Case.collection.updateOne({ _id: f.matter._id }, { $set: change });
  const result = await surfaces(f); expectCounts(result, 0); expect(result.own).toHaveLength(1);
});

test('a closed posting cannot remain pending when its Matter still says open', async () => {
  const f = await fixture(); await Job.updateOne({ _id: f.job._id }, { $set: { status: 'closed' } });
  const result = await surfaces(f); expectCounts(result, 0); expect(result.own).toHaveLength(1);
});

test('a missing posting remains a titled historical application, not a pending count', async () => {
  const f = await fixture(); await Job.deleteOne({ _id: f.job._id });
  const result = await surfaces(f); expectCounts(result, 0);
  expect(result.own[0].jobId.title).toBe(f.matter.title);
  expect(result.paralegal.myApplications[0].jobTitle).toBe(f.matter.title);
});

test('blocked future interaction leaves own history but no received or pending queue', async () => {
  const f = await fixture(); await Block.create({ blockerId: f.attorney._id, blockedId: f.paralegal._id, blockerRole: 'attorney', blockedRole: 'paralegal', active: true });
  const result = await surfaces(f); expectCounts(result, 0); expect(result.own).toHaveLength(1);
});

test('dashboard preview stays bounded while the total and full queue include older applications', async () => {
  const f = await fixture();
  const jobs = await Job.insertMany(Array.from({ length: 256 }, (_, index) => ({ attorneyId: f.attorney._id, title: `Earlier posting ${index}`, practiceArea: 'Immigration', description: 'Retained posting.', budget: 100, status: 'open' })));
  await Application.insertMany(jobs.map((job, index) => ({ jobId: job._id, paralegalId: f.paralegal._id, coverLetter: 'A retained application.', status: index % 2 ? 'viewed' : 'shortlisted' })));
  const result = await surfaces(f); expectCounts(result, 257); expect(result.own).toHaveLength(257);
});

test.each(['attorney', 'paralegal'])('%s dashboard rejects an application change during its other reads', async role => {
  const f = await fixture(); const method = role === 'attorney' ? 'readReceived' : 'readOwn';
  const original = projections[method];
  jest.spyOn(projections, method).mockImplementationOnce(async req => {
    const result = await original(req);
    await Application.updateOne({ _id: f.application._id }, { $set: { status: 'rejected' } });
    return result;
  });
  const response = await get(`/api/${role}/dashboard`, f[role]);
  expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_SOURCE_CHANGED');
  expect(response.body.metrics).toBeUndefined();
});

test.each(['attorney', 'paralegal'])('%s dashboard cannot return protected applications after account loss', async role => {
  const f = await fixture(); const method = role === 'attorney' ? 'readReceived' : 'readOwn';
  const original = projections[method];
  jest.spyOn(projections, method).mockImplementationOnce(async req => {
    const result = await original(req);
    await User.updateOne({ _id: f[role]._id }, { $set: { disabled: true } });
    return result;
  });
  const response = await get(`/api/${role}/dashboard`, f[role]);
  expect(response.status).toBe(403); expect(response.body.metrics).toBeUndefined();
});

test.each([['attorney', 'my-postings'], ['paralegal', 'my']])('%s application feed rejects a different expected account', async (role, path) => {
  const f = await fixture(); const response = await get(`/api/applications/${path}?expectedOwnerId=${new Types.ObjectId()}`, f[role]);
  expect(response.status).toBe(403); expect(response.body.code).toBe('APPLICATION_ACCOUNT_CHANGED');
});

test('reading every projection leaves stored application and Matter outcomes unchanged', async () => {
  const f = await fixture('rejected');
  await Case.updateOne({ _id: f.matter._id }, { $set: { 'applicants.0.status': 'pending' } });
  const snapshot = () => Promise.all([Case.collection.find({}).toArray(), Job.collection.find({}).toArray(), Application.collection.find({}).toArray()]);
  const before = fingerprint(await snapshot()); await surfaces(f); expect(fingerprint(await snapshot())).toBe(before);
});

test.each(['lowercase', 'uppercase'])('raw %s string references retain the same canonical application and count', async casing => {
  const f = await fixture('viewed'); const ref = value => casing === 'uppercase' ? String(value).toUpperCase() : String(value);
  await Application.collection.updateOne({ _id: f.application._id }, { $set: { paralegalId: ref(f.paralegal._id), jobId: ref(f.job._id), starredBy: [ref(f.attorney._id)] } });
  await Job.collection.updateOne({ _id: f.job._id }, { $set: { attorneyId: ref(f.attorney._id), caseId: ref(f.matter._id) } });
  await Case.collection.updateOne({ _id: f.matter._id }, { $set: { attorney: ref(f.attorney._id), attorneyId: ref(f.attorney._id), jobId: ref(f.job._id), 'applicants.0.paralegalId': ref(f.paralegal._id) } });
  const result = await surfaces(f); expectCounts(result, 1);
  expect(result.own).toHaveLength(1); expect(String(result.own[0]._id)).toBe(String(f.application._id));
  expect(result.own[0].paralegalId).toBe(String(f.paralegal._id));
  expect(result.own[0].jobId._id).toBe(String(f.job._id));
  expect(result.received[0].id).toBe(String(f.application._id));
  expect(result.received[0].caseId).toBe(String(f.matter._id));
  expect(result.received[0].jobId).toBe(String(f.job._id));
  expect(result.received[0].starred).toBe(true);
});

test('raw string application IDs use the same normalized identity in account responses', async () => {
  const f = await fixture(); const original = await Application.collection.findOne({ _id: f.application._id });
  await Application.collection.deleteOne({ _id: f.application._id });
  await Application.collection.insertOne({ ...original, _id: String(original._id).toUpperCase() });
  const result = await surfaces(f); expectCounts(result, 1);
  expect(result.own[0]._id).toBe(String(original._id));
  expect(result.received[0].id).toBe(String(original._id));
});

test('raw accepted-invitation references remain one earlier application on both sides', async () => {
  const f = await fixture('submitted', { earlier: true }); const ref = value => String(value).toUpperCase();
  await Case.collection.updateOne({ _id: f.matter._id }, { $set: { attorney: ref(f.attorney._id), attorneyId: ref(f.attorney._id), jobId: ref(f.job._id), 'applicants.0.paralegalId': ref(f.paralegal._id), 'invites.0.paralegalId': ref(f.paralegal._id) } });
  const result = await surfaces(f); expectCounts(result, 1); expect(result.own).toHaveLength(1);
  expect(result.own[0].jobId._id).toBe(String(f.job._id));
  expect(result.own[0].jobId.id).toBe(String(f.job._id));
});

test.each(['owner aliases', 'foreign owner', 'foreign posting'])('raw %s conflict is unavailable instead of a plausible account queue', async kind => {
  const f = await fixture();
  const change = kind === 'owner aliases' ? { attorney: new Types.ObjectId() } : kind === 'foreign owner' ? { attorney: new Types.ObjectId(), attorneyId: new Types.ObjectId() } : { jobId: new Types.ObjectId() };
  if (kind === 'foreign owner') change.attorneyId = change.attorney;
  await Case.collection.updateOne({ _id: f.matter._id }, { $set: change });
  for (const [path, user] of [['/api/applications/my', f.paralegal], ['/api/applications/my-postings', f.attorney]]) {
    const response = await get(path, user); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_SOURCE_INVALID');
  }
});

test('raw duplicate canonical references cannot be collapsed into one apparently exact count', async () => {
  const f = await fixture();
  await Application.collection.insertOne({ _id: new Types.ObjectId(), jobId: String(f.job._id), paralegalId: String(f.paralegal._id), status: 'submitted', coverLetter: 'Duplicate retained application.' });
  for (const [path, user] of [['/api/applications/my', f.paralegal], ['/api/applications/my-postings', f.attorney]]) {
    const response = await get(path, user); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_SOURCE_INVALID');
  }
});

test('an earlier application cannot follow a posting owned by another attorney', async () => {
  const f = await fixture('submitted', { earlier: true });
  await Job.collection.updateOne({ _id: f.job._id }, { $set: { attorneyId: new Types.ObjectId() } });
  for (const [path, user] of [['/api/applications/my', f.paralegal], ['/api/applications/my-postings', f.attorney]]) {
    const response = await get(path, user); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_SOURCE_INVALID');
  }
});

test('an accepted invitation does not keep a closed posting pending', async () => {
  const f = await fixture('submitted', { earlier: true });
  await Job.updateOne({ _id: f.job._id }, { $set: { status: 'closed' } });
  const result = await surfaces(f); expectCounts(result, 0); expect(result.own).toHaveLength(1);
});

test('a non-invited Case-only application is retained for its paralegal and agrees with attorney pending counts', async () => {
  const f = await fixture('submitted', { earlier: true });
  await Case.updateOne({ _id: f.matter._id }, { $set: { invites: [], preEngagement: { revision: 7, status: 'requested', requestedParalegalId: f.paralegal._id, conflictsCheckRequired: true, conflictsDetails: 'Review the selected parties.' } } });
  const before = await Case.collection.findOne({ _id: f.matter._id });
  const result = await surfaces(f);
  expect(result.own).toHaveLength(1);
  expect(result.own[0]).toMatchObject({ caseId: String(f.matter._id), _id: '', status: 'submitted', applicationSource: 'case_applicant', coverLetter: 'A retained application.', preEngagement: { revision: 7, requestedParalegalId: String(f.paralegal._id) } });
  expectCounts(result, 1);
  expect(await Application.countDocuments()).toBe(0);
  const after = await Case.collection.findOne({ _id: f.matter._id });
  expect(after.applicants).toEqual(before.applicants);
  expect(after.invites).toEqual([]);
});

for (const storedStatus of ['accepted', 'rejected', 'withdrawn']) test(`a non-invited Case-only ${storedStatus} outcome remains own history without pending work`, async () => {
  const f = await fixture('submitted', { earlier: true });
  await Case.collection.updateOne({ _id: f.matter._id }, { $set: { invites: [], 'applicants.0.status': storedStatus } });
  const result = await surfaces(f);
  expect(result.own).toHaveLength(1);
  expect(result.own[0]).toMatchObject({ caseId: String(f.matter._id), _id: '', status: storedStatus, pending: false });
  expectCounts(result, 0);
  expect(await Application.countDocuments()).toBe(0);
});
