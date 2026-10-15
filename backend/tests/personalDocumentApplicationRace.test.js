process.env.S3_BUCKET = 'application-document-race-test'; process.env.S3_REGION = 'us-east-1';
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { Types } = require('mongoose');
const mockSend = jest.fn(), mockReadiness = jest.fn();
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: mockSend }) }));
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async () => async () => {}) }));
jest.mock('../services/paralegalReadinessService', () => ({ ...jest.requireActual('../services/paralegalReadinessService'), resolveLivePayoutReadiness: (...args) => mockReadiness(...args) }));
const User = require('../models/User'), Job = require('../models/Job'), Application = require('../models/Application');
const { createApplicationForJob } = require('../routes/applications');
const { processPersonalStorageDeletionTasks } = require('../services/personalStorageDeletion');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/uploads', require('../routes/uploads'));
const env = { S3_BUCKET: 'application-document-race-test', S3_REGION: 'us-east-1' };
beforeAll(connect, 90000); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); mockReadiness.mockReset(); }); afterEach(() => jest.restoreAllMocks());
test.each(['create', 'reapply'])('%s cannot record a résumé deleted after its profile snapshot was read', async kind => {
 Object.assign(process.env, env);
 const owner = await User.create({ firstName: 'Dana', lastName: 'Young', email: 'resume-race@example.test', password: 'Password123!', role: 'paralegal', status: 'approved', profileImage: 'synthetic-approved-photo', stripeAccountId: 'acct_synthetic', stripeOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true });
 const oldKey = `paralegal-resumes/${owner._id}/resume-1700000000000.pdf`, objects = new Set([oldKey]), jobId = new Types.ObjectId();
 await User.updateOne({ _id: owner._id }, { $set: { resumeURL: oldKey } });
 await Job.collection.insertOne({ _id: jobId, attorneyId: new Types.ObjectId(), status: 'open', title: 'Synthetic document race', description: 'Prepare legal exhibits', budget: 100 });
 if (kind === 'reapply') await Application.create({ jobId, paralegalId: owner._id, resumeURL: '', status: 'withdrawn', coverLetter: 'An earlier withdrawn application without a résumé.' });
 let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
 mockReadiness.mockImplementationOnce(async applicant => { expect(applicant.resumeURL).toBe(oldKey); entered(); await gate; return { ready: true, evidenceState: 'verified', devBypass: true, chargesEnabled: true, payoutsEnabled: true }; });
 mockSend.mockReset().mockImplementation(async command => { const name = command.constructor.name; if (name === 'PutObjectCommand') objects.add(command.input.Key); if (name === 'DeleteObjectCommand') objects.delete(command.input.Key); return {}; });
 const pending = createApplicationForJob(String(jobId), owner.toObject(), 'I can prepare and organize these exhibits for attorney review.').then(application => ({ application }), error => ({ error }));
 let cleanup, replacement;
 try {
  await started;
  const token = jwt.sign({ id: String(owner._id), role: owner.role, status: owner.status }, process.env.JWT_SECRET, { expiresIn: '1h' });
  replacement = await request(app).post('/api/uploads/paralegal-resume').set('Cookie', `token=${token}`).field('expectedOwnerId', String(owner._id)).field('expectedDocumentKey', oldKey).attach('file', Buffer.from('%PDF-1.7\nSynthetic new résumé\n%%EOF\n'), { filename: 'resume.pdf', contentType: 'application/pdf' });
  expect(replacement.status).toBe(200);
  cleanup = await processPersonalStorageDeletionTasks({}, { env, s3: { send: mockSend } });
 } finally { release(); }
 const result = await pending, recorded = await Application.findOne({ jobId, paralegalId: owner._id }).lean();
 const dangling = recorded?.resumeURL === oldKey && !objects.has(oldKey);
 console.log(JSON.stringify({ branch: kind, replacementStatus: replacement?.status, deletedObjects: cleanup?.deleted, applicationStatus: recorded?.status, applicationError: result.error?.message || null, applicationErrorStatus: result.error?.status || null, dangling }));
 if (result.error) expect(result.error.status).toBe(409);
 else expect(recorded?.status).toBe('submitted');
 expect(dangling).toBe(false);
});


async function readyFixture(kind, resume = 'key') {
  const owner = await User.create({ firstName: 'Dana', lastName: 'Young', email: 'resume-lock@example.test', password: 'Password123!', role: 'paralegal', status: 'approved', profileImage: 'synthetic-approved-photo', stripeAccountId: 'acct_synthetic', stripeOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true });
  const oldKey = `paralegal-resumes/${owner._id}/resume-1700000000000.pdf`, jobId = new Types.ObjectId();
  await User.collection.updateOne({ _id: owner._id }, resume === 'missing' ? { $unset: { resumeURL: '' } } : { $set: { resumeURL: resume === 'key' ? oldKey : resume } });
  await Job.collection.insertOne({ _id: jobId, attorneyId: new Types.ObjectId(), status: 'open', title: 'Synthetic document locking', description: 'Prepare legal exhibits', budget: 100 });
  if (kind === 'reapply') await Application.create({ jobId, paralegalId: owner._id, resumeURL: '', status: 'withdrawn', coverLetter: 'The retained earlier application without a résumé.' });
  mockReadiness.mockResolvedValue({ ready: true, evidenceState: 'verified', devBypass: true, chargesEnabled: true, payoutsEnabled: true });
  const objects = new Set([oldKey]);
  mockSend.mockReset().mockImplementation(async command => { if (command.constructor.name === 'PutObjectCommand') objects.add(command.input.Key); if (command.constructor.name === 'DeleteObjectCommand') objects.delete(command.input.Key); return {}; });
  const token = jwt.sign({ id: String(owner._id), role: owner.role, status: owner.status }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const apply = () => createApplicationForJob(String(jobId), owner.toObject(), 'I can prepare and organize these exhibits for attorney review.');
  const replace = () => request(app).post('/api/uploads/paralegal-resume').set('Cookie', `token=${token}`).field('expectedOwnerId', String(owner._id)).field('expectedDocumentKey', oldKey).attach('file', Buffer.from('%PDF-1.7\nSynthetic new résumé\n%%EOF\n'), { filename: 'resume.pdf', contentType: 'application/pdf' });
  return { owner, oldKey, jobId, objects, apply, replace };
}

function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test.each(['create', 'reapply'])('%s commits a retained reference before a later replacement can finish', async kind => {
  const fixture = await readyFixture(kind), locked = latch(), release = latch(), replacing = latch();
  const original = User.collection.updateOne.bind(User.collection);
  const beforeVersion = (await User.findById(fixture.owner._id).lean()).__v;
  let replacementFinished = false;
  jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, update, options) => {
    if (options?.session && update.$inc?.__v === 1) {
      const result = await original(filter, update, options);
      expect(result.modifiedCount).toBe(1);
      locked.resolve(); await release.promise; return result;
    }
    if (update.$set?.resumeURL && update.$set.resumeURL !== fixture.oldKey) replacing.resolve();
    return original(filter, update, options);
  });
  const pending = fixture.apply();
  let replacement;
  try {
    await locked.promise;
    replacement = fixture.replace().then(response => { replacementFinished = true; return response; });
    await replacing.promise;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);
    expect(await Application.countDocuments({ jobId: fixture.jobId, status: 'submitted' })).toBe(0);
  } finally { release.resolve(); }
  const application = await pending;
  expect(application.$session()).toBeNull();
  expect((await replacement).status).toBe(200);
  const cleanup = await processPersonalStorageDeletionTasks({}, { env, s3: { send: mockSend } });
  const recorded = await Application.findById(application._id).lean();
  expect(recorded).toMatchObject({ status: 'submitted', resumeURL: fixture.oldKey, syncStatus: 'synced' });
  expect(fixture.objects.has(fixture.oldKey)).toBe(true);
  expect(cleanup.deleted).toBe(0);
  expect((await User.findById(fixture.owner._id).lean()).__v).toBe((beforeVersion || 0) + 1);
});

test.each(['create', 'reapply'])('%s rolls back its real User write when the Application write fails', async kind => {
  const fixture = await readyFixture(kind);
  const before = await User.findById(fixture.owner._id).lean();
  const previous = await Application.findOne({ jobId: fixture.jobId }).lean();
  const original = User.collection.updateOne.bind(User.collection);
  let locked = false;
  jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, update, options) => {
    const result = await original(filter, update, options);
    if (options?.session && update.$inc?.__v === 1) { locked = result.modifiedCount === 1; }
    return result;
  });
  jest.spyOn(Application.collection, kind === 'create' ? 'insertOne' : 'updateOne').mockRejectedValueOnce(new Error('synthetic application persistence failure'));
  await expect(fixture.apply()).rejects.toThrow('synthetic application persistence failure');
  expect(locked).toBe(true);
  expect((await User.findById(fixture.owner._id).lean()).__v).toBe(before.__v);
  expect(await Application.findOne({ jobId: fixture.jobId }).lean()).toEqual(previous);
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['missing', null, ''])('matches a raw %s résumé without manufacturing a retained reference', async resume => {
  const fixture = await readyFixture('create', resume);
  const application = await fixture.apply();
  expect(application.resumeURL).toBe('');
  expect(application.$session()).toBeNull();
  expect((await Application.findById(application._id)).syncStatus).toBe('synced');
});
