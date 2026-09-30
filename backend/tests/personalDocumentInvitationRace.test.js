process.env.S3_BUCKET = 'invitation-document-race-test';
process.env.S3_REGION = 'us-east-1';
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { Types } = require('mongoose');
const mockSend = jest.fn(), mockRetrieve = jest.fn();
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: mockSend }) }));
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async (_id, _type, _payload, options = {}) => options.deferDispatch ? async () => {} : ({})) }));
jest.mock('../utils/stripe', () => ({ accounts: { retrieve: (...args) => mockRetrieve(...args) } }));
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application');
const { processPersonalStorageDeletionTasks } = require('../services/personalStorageDeletion');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/uploads', require('../routes/uploads')); app.use('/api/cases', require('../routes/cases'));
const env = { S3_BUCKET: process.env.S3_BUCKET, S3_REGION: process.env.S3_REGION };
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); mockRetrieve.mockReset(); mockSend.mockReset(); });
afterEach(() => jest.restoreAllMocks());

async function fixture(kind) {
  const owner = await User.create({ firstName: 'Dana', lastName: 'Young', email: 'invite-resume-race@example.test', password: 'Password123!', role: 'paralegal', status: 'approved', profileImage: 'synthetic-approved-photo', stripeAccountId: 'acct_synthetic', stripeOnboarded: false, stripeChargesEnabled: false, stripePayoutsEnabled: false });
  const oldKey = `paralegal-resumes/${owner._id}/resume-1700000000000.pdf`, objects = new Set([oldKey]);
  await User.updateOne({ _id: owner._id }, { $set: { resumeURL: oldKey } });
  const attorneyId = new Types.ObjectId(), caseId = new Types.ObjectId();
  await Case.collection.insertOne({ _id: caseId, attorney: attorneyId, attorneyId, status: 'open', title: 'Synthetic invitation document race', totalAmount: 10000, tasks: [{ _id: new Types.ObjectId(), title: 'Prepare exhibits', completed: false }], invites: [{ _id: new Types.ObjectId(), paralegalId: owner._id, status: 'pending' }], applicants: [] });
  let jobId;
  if (kind !== 'embedded') {
    jobId = new Types.ObjectId();
    await Job.collection.insertOne({ _id: jobId, attorneyId, caseId, status: 'open', title: 'Synthetic invitation document race', description: 'Prepare exhibits', budget: 100 });
    if (kind === 'reapply') await Application.create({ jobId, paralegalId: owner._id, status: 'withdrawn', resumeURL: '', coverLetter: 'Earlier withdrawn application without a résumé.' });
  }
  mockRetrieve.mockResolvedValue({ details_submitted: true, charges_enabled: true, payouts_enabled: true });
  mockSend.mockImplementation(async command => { if (command.constructor.name === 'PutObjectCommand') objects.add(command.input.Key); if (command.constructor.name === 'DeleteObjectCommand') objects.delete(command.input.Key); return {}; });
  const accept = route => request(app).post(`/api/cases/${caseId}/${route}`).set('Cookie', cookie(owner)).send({ decision: 'accept' });
  const replace = () => request(app).post('/api/uploads/paralegal-resume').set('Cookie', cookie(owner)).field('expectedOwnerId', String(owner._id)).field('expectedDocumentKey', oldKey).attach('file', Buffer.from('%PDF-1.7\nSynthetic new résumé\n%%EOF\n'), { filename: 'resume.pdf', contentType: 'application/pdf' });
  return { owner, oldKey, objects, caseId, jobId, accept, replace };
}

test.each(['respond-invite', 'invite/accept'].flatMap(route => ['create', 'reapply', 'embedded'].map(kind => [route, kind])))('%s %s never commits a deleted résumé after its route snapshot', async (route, kind) => {
  const value = await fixture(kind), started = latch(), release = latch();
  mockRetrieve.mockImplementationOnce(async () => { started.resolve(); await release.promise; return { details_submitted: true, charges_enabled: true, payouts_enabled: true }; });
  const pending = value.accept(route).then(response => response);
  let replacement, cleanup;
  try {
    await started.promise;
    replacement = await value.replace(); expect(replacement.status).toBe(200);
    cleanup = await processPersonalStorageDeletionTasks({}, { env, s3: { send: mockSend } });
    expect(cleanup.deleted).toBe(1);
  } finally { release.resolve(); }
  const response = await pending;
  const application = value.jobId ? await Application.findOne({ jobId: value.jobId }).lean() : null;
  const matter = await Case.findById(value.caseId).lean();
  const dangling = !value.objects.has(value.oldKey) && (application?.resumeURL === value.oldKey || matter.applicants.some(item => item.resumeURL === value.oldKey));
  console.log(JSON.stringify({ route, kind, replacement: replacement.status, deleted: cleanup.deleted, acceptance: response.status, reconciliationPending: response.body.reconciliationPending, canonical: application?.status, embedded: matter.applicants.length, dangling }));
  expect(dangling).toBe(false);
  expect(response.status).toBe(409);
  expect(response.body.error).toMatch(/résumé changed/);
  expect(matter.invites[0].status).toBe('pending');
  expect(matter.applicants).toHaveLength(0);
  if (kind === 'reapply') expect(application.status).toBe('withdrawn');
  else expect(application).toBeNull();
});

test.each(['respond-invite', 'invite/accept'].flatMap(route => ['create', 'reapply', 'embedded'].map(kind => [route, kind])))('%s %s retains the first snapshot before a waiting replacement can finish', async (route, kind) => {
  const value = await fixture(kind), locked = latch(), release = latch(), replacing = latch();
  const original = User.collection.updateOne.bind(User.collection);
  let finished = false;
  jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, update, options) => {
    if (options?.session && update.$inc?.__v === 1) {
      const result = await original(filter, update, options); expect(result.modifiedCount).toBe(1);
      locked.resolve(); await release.promise; return result;
    }
    if (update.$set?.resumeURL && update.$set.resumeURL !== value.oldKey) replacing.resolve();
    return original(filter, update, options);
  });
  const pending = value.accept(route).then(response => response);
  let replacement;
  try {
    await locked.promise;
    replacement = value.replace().then(response => { finished = true; return response; });
    await replacing.promise; await new Promise(resolve => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    expect((await Case.findById(value.caseId)).invites[0].status).toBe('pending');
  } finally { release.resolve(); }
  const response = await pending;
  expect(response.status).toBe(200); expect(response.body.reconciliationPending).toBe(false);
  expect((await replacement).status).toBe(200);
  const cleanup = await processPersonalStorageDeletionTasks({}, { env, s3: { send: mockSend } });
  expect(cleanup.deleted).toBe(0); expect(value.objects.has(value.oldKey)).toBe(true);
  const matter = await Case.findById(value.caseId).lean();
  expect(matter.invites[0].status).toBe('accepted');
  expect(matter.applicants[0]).toMatchObject({ resumeURL: value.oldKey, status: 'pending' });
  if (value.jobId) expect((await Application.findOne({ jobId: value.jobId })).resumeURL).toBe(value.oldKey);
  expect(matter.totalAmount).toBe(10000); expect(matter.lockedTotalAmount).toBe(10000);
});

test.each(['respond-invite', 'invite/accept'])('%s rolls back acceptance, money locking and User increment when its first reference fails', async route => {
  const value = await fixture('embedded'), original = Case.collection.updateOne.bind(Case.collection);
  const before = await Case.collection.findOne({ _id: value.caseId });
  let attempted = false;
  jest.spyOn(Case.collection, 'updateOne').mockImplementation(async (filter, update, options) => {
    if (options?.session && update.$push?.applicants) { attempted = true; throw new Error('synthetic retained snapshot failure'); }
    return original(filter, update, options);
  });
  const response = await value.accept(route);
  expect(response.status).toBe(500); expect(attempted).toBe(true);
  expect(await Case.collection.findOne({ _id: value.caseId })).toEqual(before);
  expect((await User.collection.findOne({ _id: value.owner._id })).__v).toBeUndefined();
  expect(await Application.countDocuments()).toBe(0);
});

test.each(['create', 'reapply'])('deferred %s canonical repair keeps the first accepted résumé after profile replacement', async kind => {
  const value = await fixture(kind);
  const method = kind === 'create' ? 'insertOne' : 'updateOne';
  jest.spyOn(Application.collection, method).mockRejectedValueOnce(new Error('synthetic deferred canonical failure'));
  const first = await value.accept('invite/accept');
  expect(first.status).toBe(200); expect(first.body.reconciliationPending).toBe(true);
  expect((await Case.findById(value.caseId)).applicants[0].resumeURL).toBe(value.oldKey);
  expect((await value.replace()).status).toBe(200);
  expect((await processPersonalStorageDeletionTasks({}, { env, s3: { send: mockSend } })).deleted).toBe(0);
  const repaired = await value.accept('invite/accept');
  expect(repaired.status).toBe(200); expect(repaired.body.reconciliationPending).toBe(false);
  expect((await Application.findOne({ jobId: value.jobId })).resumeURL).toBe(value.oldKey);
  expect((await Case.findById(value.caseId)).applicants[0].resumeURL).toBe(value.oldKey);
  expect(value.objects.has(value.oldKey)).toBe(true);
});

test('a committed accepted snapshot protects its source while the first canonical insert is delayed', async () => {
  const value = await fixture('create'), entered = latch(), release = latch();
  const original = Application.collection.insertOne.bind(Application.collection);
  jest.spyOn(Application.collection, 'insertOne').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
  const pending = value.accept('invite/accept').then(response => response);
  try {
    await entered.promise;
    const accepted = await Case.findById(value.caseId).lean();
    expect(accepted.invites[0]).toMatchObject({ status: 'accepted', syncStatus: 'pending' });
    expect(accepted.applicants[0].resumeURL).toBe(value.oldKey);
    expect((await value.replace()).status).toBe(200);
    expect((await processPersonalStorageDeletionTasks({}, { env, s3: { send: mockSend } })).deleted).toBe(0);
  } finally { release.resolve(); }
  expect((await pending).status).toBe(200);
  expect((await Application.findOne({ jobId: value.jobId })).resumeURL).toBe(value.oldKey);
  expect(value.objects.has(value.oldKey)).toBe(true);
});

test('a completed acceptance retry does not update User or replace the retained résumé', async () => {
  const value = await fixture('create'); expect((await value.accept('invite/accept')).status).toBe(200);
  expect((await value.replace()).status).toBe(200);
  const userBefore = await User.collection.findOne({ _id: value.owner._id });
  const applicationBefore = await Application.collection.findOne({ jobId: value.jobId });
  const response = await value.accept('invite/accept');
  expect(response.status).toBe(200); expect(response.body.alreadyProcessed).toBe(true);
  expect(await User.collection.findOne({ _id: value.owner._id })).toEqual(userBefore);
  expect(await Application.collection.findOne({ jobId: value.jobId })).toEqual(applicationBefore);
});

test('declining a pending invitation creates no fresh résumé reference or User lock', async () => {
  const value = await fixture('embedded'), before = await User.collection.findOne({ _id: value.owner._id });
  const response = await request(app).post(`/api/cases/${value.caseId}/respond-invite`).set('Cookie', cookie(value.owner)).send({ decision: 'decline' });
  expect(response.status).toBe(200);
  const matter = await Case.findById(value.caseId).lean(); expect(matter.invites[0].status).toBe('declined'); expect(matter.applicants).toHaveLength(0);
  expect(await User.collection.findOne({ _id: value.owner._id })).toEqual(before);
});
