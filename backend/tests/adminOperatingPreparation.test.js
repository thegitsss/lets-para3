const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const mongoose = require('mongoose');
jest.mock('../utils/email', () => jest.fn());
const email = require('../utils/email');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { readReadyState } = require('./helpers/mongoHarnessState');
const User = require('../models/User'), Case = require('../models/Case'), Ticket = require('../models/SupportTicket');
const Work = require('../models/AdminWorkPreparation'), State = require('../models/AutomationCycleState');
const service = require('../services/adminOperatingPreparation');
const maintenanceOff = { readMaintenanceMode: async () => false };
let applicant;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); email.mockClear();
  applicant = await User.create({ firstName: 'Synthetic', lastName: 'Applicant', email: 'preparation@example.test', password: 'Synthetic test password', role: 'paralegal', status: 'pending', emailVerified: true, state: 'NY', paralegalQualification: 'law_firm_experience', yearsExperience: 3, resumeURL: '/protected/resume' });
});
const run = options => service.runAdminPreparationCycle({ ...options, dependencies: { ...maintenanceOff, ...(options?.dependencies || {}) } });

test('browser-independent preparation is encrypted, revision bound and does not decide or contact', async () => {
  const now = new Date();
  expect(await run({ now })).toMatchObject({ ok: true, prepared: 1 });
  const result = await service.readCurrentPreparation('application', String(applicant._id), { now });
  expect(result).toMatchObject({ status: 'prepared', current: true, result: { requiresOwner: true, title: 'Admission review ready', missing: [] } });
  expect((await User.findById(applicant._id)).status).toBe('pending'); expect(email).not.toHaveBeenCalled();
  expect((await Work.findOne().select('+encryptedResult')).encryptedResult).toMatch(/^enc:v1:/);
  expect(await Work.findOne().lean()).not.toHaveProperty('encryptedResult');
  expect(await run({ now })).toMatchObject({ ok: true, prepared: 0 });
  expect((await Work.findOne()).attempts).toBe(1);
});
test('application corrections invalidate old prepared facts and are refreshed automatically', async () => {
  await User.updateOne({ _id: applicant._id }, { $unset: { resumeURL: '' } }); await run();
  expect((await service.readCurrentPreparation('application', String(applicant._id))).result.missing.join(' ')).toContain('résumé');
  await User.updateOne({ _id: applicant._id }, { $set: { resumeURL: '/protected/new-resume' } });
  expect(await service.readCurrentPreparation('application', String(applicant._id))).toMatchObject({ current: false, status: 'stale' });
  await run(); await run(); // The rotating bounded scan wraps without losing old records.
  expect((await service.readCurrentPreparation('application', String(applicant._id))).result.missing).toEqual([]);
});
test('overlapping workers take one lease and cannot prepare the same revision twice', async () => {
  const epoch = await service.knowledgeEpoch(new Date());
  await service.stage('application', applicant.toObject(), new Date(), epoch);
  let finish, calls = 0;
  const prepare = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = service.execute(`application:${applicant._id}`, { prepareOperation: prepare });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  expect(await service.execute(`application:${applicant._id}`, { prepareOperation: prepare })).toBe('skipped');
  finish({ requiresOwner: true, title: 'Prepared' }); expect(await first).toBe('prepared'); expect(calls).toBe(1);
});
test('a source change during preparation cannot commit stale advice', async () => {
  const now = new Date(); await service.stage('application', applicant.toObject(), now);
  expect(await service.execute(`application:${applicant._id}`, { now, prepareOperation: async () => { await User.updateOne({ _id: applicant._id }, { $set: { state: 'CA' } }); return { requiresOwner: true, title: 'Old state' }; } })).toBe('obsolete');
  expect(await service.readCurrentPreparation('application', String(applicant._id))).toMatchObject({ current: false });
  expect((await Work.findOne().select('+encryptedResult')).encryptedResult).toBe('');
});
test('expired read-only claims recover, retries are bounded and a source change restores eligibility', async () => {
  const now = new Date(); await service.stage('application', applicant.toObject(), now);
  await Work.updateOne({}, { $set: { status: 'running', leaseUntil: new Date(now.getTime() - 1), claimId: 'dead-worker' } });
  expect(await service.execute(`application:${applicant._id}`, { now })).toBe('prepared');
  await User.updateOne({ _id: applicant._id }, { $set: { state: 'CA' } });
  await service.stage('application', (await User.findById(applicant._id)).toObject(), now);
  const failure = async () => { throw Error('private provider text must not leak'); };
  for (let attempt = 0; attempt < 3; attempt++) {
    await Work.updateOne({}, { $set: { nextAttemptAt: now } });
    expect(await service.execute(`application:${applicant._id}`, { now, prepareOperation: failure })).toBe('failed');
  }
  expect(await service.execute(`application:${applicant._id}`, { now, prepareOperation: failure })).toBe('skipped');
  const result = await service.readCurrentPreparation('application', String(applicant._id), { now });
  expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('private provider');
  expect((await service.readAdminOperatingStatus({ now })).blocked).toBe(1);
  await User.updateOne({ _id: applicant._id }, { $set: { state: 'NY' } });
  await service.stage('application', (await User.findById(applicant._id)).toObject(), now);
  expect(await service.execute(`application:${applicant._id}`, { now })).toBe('prepared');
});
test('maintenance, stopped passes and active competing leases do not claim new work', async () => {
  expect(await run({ dependencies: { readMaintenanceMode: async () => true } })).toMatchObject({ ok: true, paused: true });
  expect(await Work.countDocuments()).toBe(0);
  const now = new Date(); await State.create({ _id: 'admin-preparation', status: 'running', startedAt: now, runId: 'other', leaseUntil: new Date(now.getTime() + 120000) });
  expect(await run({ now })).toMatchObject({ skipped: 'already_running' }); expect(await Work.countDocuments()).toBe(0);
});
test('bounded cursor scanning eventually prepares every account, beyond the first page', async () => {
  await User.collection.insertMany(Array.from({ length: 6 }, (_, i) => ({ firstName: 'Synthetic', lastName: String(i), email: `cursor-${i}@example.test`, role: 'attorney', status: 'pending', updatedAt: new Date() })));
  for (let i = 0; i < 5; i++) await run({ limit: 2 });
  expect(await Work.countDocuments({ kind: 'application', status: 'prepared' })).toBe(7);
  expect((await Work.find()).every(row => row.attempts === 1)).toBe(true);
});
test('human inquiries stay owner decisions and marketplace exceptions get factual preparation', async () => {
  const ticket = await Ticket.create({ subject: 'Human help', message: 'I want Samantha to review this', requestKind: 'human', requesterRole: 'paralegal' });
  const matter = await Case.create({ title: 'Preparation matters', details: 'Synthetic case', attorney: new mongoose.Types.ObjectId(), totalAmount: 40000, status: 'open', fundingIntegrityStatus: 'failed' });
  await run();
  expect((await service.readCurrentPreparation('inquiry', String(ticket._id))).result).toMatchObject({ requiresOwner: true, title: 'Human reply requested' });
  expect((await service.readCurrentPreparation('matter', String(matter._id))).result).toMatchObject({ requiresOwner: true, reasons: ['Funding needs review.'] });
  expect(email).not.toHaveBeenCalled();
});
test('stale worker evidence is not reported as healthy', async () => {
  expect((await service.readAdminOperatingStatus()).status).toBe('unknown'); await run();
  expect((await service.readAdminOperatingStatus()).status).toBe('completed');
  expect((await service.readAdminOperatingStatus({ now: new Date(Date.now() + 16 * 60000) })).status).toBe('stale');
});
test('a fresh Node process prepares pending work while no browser is open', async () => {
  const uri = readReadyState().uri.replace(/\/$/, '') + '/jest';
  const result = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../scripts/run-admin-preparation.js')], { env: { ...process.env, NODE_ENV: 'test', MONGO_URI: uri, EMAIL_DISABLE: 'true', SMTP_HOST: '' }, timeout: 60000 });
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true, prepared: 1 });
  expect((await Work.findOne()).status).toBe('prepared'); expect((await User.findById(applicant._id)).status).toBe('pending');
}, 70000);

test('approved members are not repeatedly scanned and departed work is retired', async () => {
  await User.collection.insertMany(Array.from({ length: 100 }, (_, i) => ({ firstName: 'Existing', lastName: 'Member', email: `idle-${i}@example.test`, role: 'attorney', status: 'approved', updatedAt: new Date() })));
  expect(await run({ limit: 2 })).toMatchObject({ scanned: 1, prepared: 1 });
  expect(await Work.countDocuments()).toBe(1);
  await User.updateOne({ _id: applicant._id }, { $set: { status: 'approved' } });
  await run({ limit: 2 }); await run({ limit: 2 });
  expect((await Work.findOne().select('+encryptedResult'))).toMatchObject({ status: 'obsolete', encryptedResult: '' });
});
test('System recovery only schedules the reviewed current failed preparation and joins its transaction', async () => {
  await run(); const job = await Work.findOne();
  await Work.updateOne({ _id: job._id }, { $set: { status: 'failed', attempts: 3, failure: 'Preparation unavailable.' } });
  const status = await service.readAdminOperatingStatus();
  expect(status).toMatchObject({ healthy: false, blocked: 1 });
  expect(status.failedItems).toHaveLength(1);
  expect(status.failedItems[0]).toMatchObject({ kind: 'application', id: String(applicant._id), status: 'failed', sourceRevision: job.sourceRevision });
  const session = await mongoose.startSession();
  try { await expect(session.withTransaction(async () => { await service.retryPreparation('application', String(applicant._id), { reviewedRevision: job.sourceRevision, session }); throw Error('Rollback rehearsal'); })).rejects.toThrow('Rollback rehearsal'); } finally { await session.endSession(); }
  expect((await Work.findOne()).status).toBe('failed');
  expect(await service.retryPreparation('application', String(applicant._id), { reviewedRevision: job.sourceRevision })).toMatchObject({ recorded: true, status: 'pending' });
  expect((await Work.findOne()).attempts).toBe(0);
  await User.updateOne({ _id: applicant._id }, { $set: { state: 'CA' } });
  await expect(service.retryPreparation('application', String(applicant._id), { reviewedRevision: job.sourceRevision })).rejects.toMatchObject({ statusCode: 409 });
});
test('retry rejects query operators and arrays before changing a failed preparation', async () => {
  await run(); const job = await Work.findOne();
  await Work.updateOne({ _id: job._id }, { $set: { status: 'failed', attempts: 3 } });
  for (const reviewedRevision of [{ $ne: null }, [job.sourceRevision]]) {
    await expect(service.retryPreparation('application', String(applicant._id), { reviewedRevision })).rejects.toMatchObject({ statusCode: 400 });
  }
  expect((await Work.findById(job._id)).status).toBe('failed');
  expect((await Work.findById(job._id)).attempts).toBe(3);
});
test('withdrawn approved knowledge invalidates a cached support draft before it can be returned', async () => {
  const Collection = require('../models/KnowledgeCollection'), Item = require('../models/KnowledgeItem'), Revision = require('../models/KnowledgeRevision');
  const collection = await Collection.create({ key: 'preparation-support', title: 'Preparation support', audienceScopes: ['support_safe'] });
  const item = await Item.create({ key: 'preparation-notification-help', title: 'Notification preferences', collectionId: collection._id, recordType: 'objection_card', approvalState: 'approved', audienceScopes: ['support_safe'], tags: ['paralegal'], nextReviewAt: new Date(Date.now() + 7 * 86400000) });
  const question = 'How do I change notification preferences?';
  const revision = await Revision.create({ knowledgeItemId: item._id, revisionNumber: 1, fingerprint: 'preparation-answer', approvalState: 'approved', content: { objection: question, approvedResponse: 'Open Settings and select Notifications.' } });
  await Item.updateOne({ _id: item._id }, { $set: { currentApprovedRevisionId: revision._id } });
  const ticket = await Ticket.create({ subject: question, message: question, requesterRole: 'paralegal' });
  await run();
  const result = await service.readCurrentPreparation('inquiry', String(ticket._id));
  expect(result.current).toBe(true); expect(result.result.text).toContain('Notifications');
  await Revision.updateOne({ _id: revision._id }, { $set: { approvalState: 'rejected' } });
  expect(await service.readCurrentPreparation('inquiry', String(ticket._id))).toMatchObject({ current: false, status: 'stale' });
});

test('a worker without a protected-storage key fails closed without storing plaintext', async () => {
  const uri = readReadyState().uri.replace(/\/$/, '') + '/jest';
  const error = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../scripts/run-admin-preparation.js')], { env: { ...process.env, NODE_ENV: 'test', MONGO_URI: uri, EMAIL_DISABLE: 'true', SMTP_HOST: '', DATA_ENCRYPTION_KEY: '' }, timeout: 60000 }).catch(error => error);
  expect(error.code).toBe(1); expect(JSON.parse(error.stdout.trim())).toMatchObject({ ok: false, failed: 1 });
  expect(await Work.findOne().select('+encryptedResult')).toMatchObject({ status: 'failed', encryptedResult: '' });
}, 70000);
