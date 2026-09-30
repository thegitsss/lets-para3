const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({}));
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application'), Notification = require('../models/Notification');
const { presentNotification } = require('../services/notificationPresentation');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/applications', require('../routes/applications'));
app.get('/test-csrf', (req, res) => res.json({ token: require('../utils/csrf').generateCsrfToken(req, res) }));
app.use((error, _req, res, next) => { if (!require('../utils/csrf').respondToCsrfError(error, res)) next(error); });
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let attorney, para, other, matter, job;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [attorney, para, other] = await User.create(['attorney', 'paralegal', 'paralegal'].map((role, index) => ({ firstName: 'Earlier', lastName: `Applicant${index}`, role, status: 'approved', email: `earlier-${index}@history.example`, password: 'Password123!' })));
  matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, title: 'Earlier application withdrawal', details: 'Prepare a chronology for review.', practiceArea: 'Civil Litigation', status: 'open', totalAmount: 50000, applicants: [
    { paralegalId: para._id, status: 'pending', note: 'My original submitted note.', appliedAt: new Date('2026-08-01'), linkedInURL: 'https://linkedin.com/in/earlier-applicant', profileSnapshot: { bio: 'My saved profile.' } },
    { paralegalId: other._id, status: 'pending', note: 'Another applicant stays available.' },
  ], preEngagement: { revision: 7, status: 'requested', requestedParalegalId: para._id, conflictsCheckRequired: true, conflictsDetails: 'The selected parties.' } });
  job = await Job.create({ attorneyId: attorney._id, caseId: matter._id, title: matter.title, description: matter.details, practiceArea: 'Civil Litigation', budget: 500, status: 'open', applicantsCount: 2 });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
  await Application.create({ jobId: job._id, paralegalId: other._id, status: 'submitted', coverLetter: 'Another applicant stays available.' });
  await Notification.init();
});
afterEach(() => jest.restoreAllMocks());
async function own(actor = para) {
  const response = await request(app).get('/api/applications/my').set('Cookie', cookie(actor)); expect(response.status).toBe(200);
  return response.body.find(row => String(row.caseId) === String(matter._id));
}
const withdraw = (revision, actor = para, body = {}) => request(app).post(`/api/applications/earlier/${matter._id}/revoke`).set('Cookie', cookie(actor)).send({ expectedOwnerId: String(actor._id), expectedRevision: revision, ...body });

for (const status of ['pending', 'accepted']) test(`an earlier ${status} application withdraws atomically and keeps its own history`, async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { 'applicants.0.status': status } });
  const source = await own(), before = await Case.collection.findOne({ _id: matter._id });
  const response = await withdraw(source.withdrawal?.revision || 'a'.repeat(64));
  expect(response.status).toBe(200);
  expect(source.withdrawal).toMatchObject({ available: true, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(response.body).toMatchObject({ success: true, caseId: String(matter._id), status: 'withdrawn', alreadyRevoked: false });
  const after = await Case.collection.findOne({ _id: matter._id });
  expect(after.applicants[0]).toMatchObject({ note: before.applicants[0].note, linkedInURL: before.applicants[0].linkedInURL, profileSnapshot: before.applicants[0].profileSnapshot, status: 'withdrawn', withdrawnAt: expect.any(Date) });
  expect(after.applicants[0].statusHistory).toEqual([expect.objectContaining({ from: status, to: 'withdrawn', reason: 'revoked_by_paralegal', actorId: para._id })]);
  expect(after.applicants[1]).toEqual(before.applicants[1]);
  expect(after.preEngagement.revision).toBe(8);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(1);
  expect(await Application.countDocuments({ paralegalId: para._id })).toBe(0);
  expect(await own()).toMatchObject({ status: 'withdrawn', pending: false, preEngagement: null, coverLetter: 'My original submitted note.', withdrawal: { available: false } });
  const notices = await Notification.find({ userId: attorney._id }).lean(); expect(notices).toHaveLength(1);
  const notice = presentNotification(notices[0], { viewer: attorney, caseDoc: after });
  expect(notice.action.href).toContain('applicationHistory=1');
  expect(notice.action.href).toContain(`applicantId=${para._id}`);
  const reloaded = await Case.findById(matter._id); await reloaded.save();
  expect((await Case.findById(matter._id).lean()).applicants[0].status).toBe('withdrawn');
});

test('an exact repeated earlier withdrawal does not duplicate history or its notification', async () => {
  const source = await own(), revision = source.withdrawal?.revision || 'a'.repeat(64);
  expect((await withdraw(revision)).status).toBe(200);
  const repeat = await withdraw(revision); expect(repeat.status).toBe(200); expect(repeat.body.alreadyRevoked).toBe(true);
  expect((await Case.findById(matter._id).lean()).applicants[0].statusHistory).toHaveLength(1);
  expect(await Notification.countDocuments({ userId: attorney._id })).toBe(1);
});

for (const [name, update] of Object.entries({
  changedNote: { 'applicants.0.note': 'New submission text' },
  rejected: { 'applicants.0.status': 'rejected' },
  assigned: () => ({ paralegalId: para._id }),
  assignedElsewhere: () => ({ paralegalId: other._id }),
  funded: { escrowStatus: 'funded' },
  paymentReleased: { paymentReleased: true },
  paymentUnconfirmed: { escrowIntentId: 'pi_unconfirmed' },
  claim: { hiringClaimToken: 'hire-in-progress' },
  reconciliation: { hiringClaimStatus: 'needs_reconciliation' },
  closed: { status: 'closed' },
  archived: { archived: true },
  relisted: { relistPending: true },
  acceptedInvite: () => ({ invites: [{ paralegalId: para._id, status: 'accepted' }] }),
  inviteSync: () => ({ invites: [{ paralegalId: para._id, status: 'pending', syncStatus: 'needs_reconciliation' }] }),
})) test(`${name} cannot be withdrawn from an earlier snapshot`, async () => {
  const source = await own();
  await Case.collection.updateOne({ _id: matter._id }, { $set: typeof update === 'function' ? update() : update });
  const before = await Case.collection.findOne({ _id: matter._id });
  expect((await withdraw(source.withdrawal.revision)).status).toBe(409);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(2);
  expect(await Notification.countDocuments()).toBe(0);
});

test('a newly canonical application retains authority over an earlier snapshot', async () => {
  const source = await own();
  await Application.create({ jobId: job._id, paralegalId: para._id, coverLetter: 'New canonical submission' });
  expect((await withdraw(source.withdrawal.revision)).status).toBe(409);
  expect((await Case.findById(matter._id).lean()).applicants[0].status).toBe('pending');
});

test('another applicant cannot use the selected owner or revision', async () => {
  const source = await own();
  expect((await withdraw(source.withdrawal.revision, other, { expectedOwnerId: String(para._id) })).status).toBe(403);
  expect((await withdraw(source.withdrawal.revision, other)).status).toBe(409);
  expect((await withdraw(source.withdrawal.revision, attorney)).status).toBe(403);
  expect(await Notification.countDocuments()).toBe(0);
});

test('fresh account loss prevents a saved withdrawal', async () => {
  const source = await own();
  await User.updateOne({ _id: para._id }, { $set: { disabled: true } });
  expect((await withdraw(source.withdrawal.revision)).status).toBe(403);
  expect((await Case.findById(matter._id).lean()).applicants[0].status).toBe('pending');
});

for (const stage of ['posting', 'notification']) test(`${stage} failure rolls the complete withdrawal back`, async () => {
  const source = await own(), before = await Case.collection.findOne({ _id: matter._id });
  if (stage === 'posting') jest.spyOn(Job.collection, 'updateOne').mockRejectedValueOnce(new Error('Synthetic posting failure'));
  else jest.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('Synthetic notification failure'));
  expect((await withdraw(source.withdrawal.revision)).status).toBe(500);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(2);
  expect(await Notification.countDocuments()).toBe(0);
});

test('the count includes unrepresented earlier candidates once and ignores retained outcomes', async () => {
  const third = new (require('mongoose').Types.ObjectId)();
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: { $each: [{ paralegalId: third, status: 'pending' }, { paralegalId: new (require('mongoose').Types.ObjectId)(), status: 'rejected' }] } } });
  const source = await own(); expect((await withdraw(source.withdrawal.revision)).status).toBe(200);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(2);
});

test('concurrent withdrawals produce a single history and notification', async () => {
  const source = await own();
  const results = await Promise.all([withdraw(source.withdrawal.revision), withdraw(source.withdrawal.revision)]);
  expect(results.some(result => result.status === 200)).toBe(true);
  expect(results.every(result => [200, 409].includes(result.status))).toBe(true);
  expect((await Case.findById(matter._id).lean()).applicants[0].statusHistory).toHaveLength(1);
  expect(await Notification.countDocuments()).toBe(1);
});

test('enabled CSRF rejects missing and foreign-session tokens before withdrawal', async () => {
  const previous = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true';
  try {
    const source = await own();
    expect((await withdraw(source.withdrawal.revision)).body.code).toBe('CSRF_INVALID');
    const foreign = await request(app).get('/test-csrf').set('Cookie', cookie(other));
    expect((await withdraw(source.withdrawal.revision).set('X-CSRF-Token', foreign.body.token).set('Cookie', `${cookie(para)}; _csrf=${foreign.body.token}`)).status).toBe(403);
    const sessionCookie = cookie(para), token = await request(app).get('/test-csrf').set('Cookie', sessionCookie);
    expect((await withdraw(source.withdrawal.revision).set('X-CSRF-Token', token.body.token).set('Cookie', `${sessionCookie}; _csrf=${token.body.token}`)).status).toBe(200);
  } finally { process.env.ENABLE_CSRF = previous; }
});

test('a hiring claim written after the transaction read wins without a withdrawal', async () => {
  const source = await own(), original = Case.collection.updateOne.bind(Case.collection); let inserted = false;
  jest.spyOn(Case.collection, 'updateOne').mockImplementation(async (filter, update, options) => {
    if (!inserted && options?.session && update.$set?.applicants) {
      inserted = true;
      await original({ _id: matter._id }, { $set: { hiringClaimToken: 'concurrent-hire' } });
    }
    return original(filter, update, options);
  });
  expect((await withdraw(source.withdrawal.revision)).status).toBe(409);
  const after = await Case.findById(matter._id).lean();
  expect(after.hiringClaimToken).toBe('concurrent-hire'); expect(after.applicants[0].status).toBe('pending');
  expect(await Notification.countDocuments()).toBe(0);
});

test('a saved withdrawal invalidates an older requirements response without deleting its retained details', async () => {
  const source = await own(); expect((await withdraw(source.withdrawal.revision)).status).toBe(200);
  const changed = await Case.collection.updateOne({ _id: matter._id, 'preEngagement.revision': 7 }, { $set: { 'preEngagement.status': 'submitted' } });
  expect(changed.matchedCount).toBe(0);
  expect((await Case.findById(matter._id).lean()).preEngagement).toMatchObject({ revision: 8, status: 'requested', conflictsDetails: 'The selected parties.' });
  const exclusions = await request(app).get('/api/applications/recommendation-exclusions').set('Cookie', cookie(para));
  expect(exclusions.status).toBe(200); expect(JSON.stringify(exclusions.body)).toContain(String(matter._id));
});

test('disabled in-app case notifications do not prevent a confirmed withdrawal', async () => {
  await User.updateOne({ _id: attorney._id }, { $set: { 'notificationPrefs.inAppCase': false, 'notificationPrefs.emailCase': false } });
  const source = await own(); expect((await withdraw(source.withdrawal.revision)).status).toBe(200);
  expect(await Notification.countDocuments()).toBe(0);
});

test('unknown commit preserves the durable result for manual recovery and an exact retry', async () => {
  const source = await own(), mongoose = require('mongoose'), start = mongoose.startSession.bind(mongoose);
  jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
    const session = await start(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); throw Object.assign(new Error('Synthetic unknown commit'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); };
    return session;
  });
  const unconfirmed = await withdraw(source.withdrawal.revision);
  expect(unconfirmed.status).toBe(503); expect(unconfirmed.body.code).toBe('ACCOUNT_WRITE_UNCONFIRMED');
  expect(await own()).toMatchObject({ status: 'withdrawn', pending: false });
  const repeat = await withdraw(source.withdrawal.revision); expect(repeat.status).toBe(200); expect(repeat.body.alreadyRevoked).toBe(true);
  expect(await Notification.countDocuments()).toBe(1);
  expect((await Case.findById(matter._id).lean()).applicants[0].statusHistory).toHaveLength(1);
});

test('an unlinked earlier application withdraws without inventing a posting', async () => {
  await Application.deleteMany({ jobId: job._id }); await Job.deleteOne({ _id: job._id });
  await Case.collection.updateOne({ _id: matter._id }, { $unset: { jobId: '', job: '' } });
  const source = await own(); expect((await withdraw(source.withdrawal.revision)).status).toBe(200);
  expect(await Job.countDocuments()).toBe(0); expect(await Application.countDocuments()).toBe(0);
});

test('conflicting posting aliases cannot be resolved by choosing one', async () => {
  const source = await own();
  await Job.collection.insertOne({ _id: new (require('mongoose').Types.ObjectId)(), attorneyId: attorney._id, caseId: String(matter._id), title: 'Duplicate posting', description: matter.details, practiceArea: 'Civil Litigation', budget: 500, status: 'open' });
  expect((await withdraw(source.withdrawal.revision)).status).toBe(409);
  expect((await Case.findById(matter._id).lean()).applicants[0].status).toBe('pending');
});

test('canonical withdrawal still counts an unrepresented earlier pending applicant', async () => {
  const canonical = await Application.findOne({ jobId: job._id, paralegalId: other._id }).lean();
  const response = await request(app).post(`/api/applications/${canonical._id}/revoke`).set('Cookie', cookie(other)).send({});
  expect(response.status).toBe(200);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(1);
  expect((await own()).pending).toBe(true);
});

test('the shared application and invitation recount keeps earlier candidates with canonical precedence', async () => {
  const sync = require('../services/applicationService').syncApplicantsCount;
  expect(await sync(job._id)).toBe(2);
  await Application.updateOne({ jobId: job._id, paralegalId: other._id }, { $set: { status: 'rejected' } });
  expect(await sync(job._id)).toBe(1);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(1);
  await Case.updateOne({ _id: matter._id }, { $set: { 'applicants.0.status': 'withdrawn' } });
  expect(await sync(job._id)).toBe(0);
});

test('a failed shared recount rolls back its Case lock and leaves its count available for reconciliation', async () => {
  const before = await Case.collection.findOne({ _id: matter._id });
  jest.spyOn(Job.collection, 'updateOne').mockRejectedValueOnce(new Error('Synthetic recount failure'));
  await expect(require('../services/applicationService').syncApplicantsCount(job._id)).rejects.toThrow('Synthetic recount failure');
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect((await Job.findById(job._id).lean()).applicantsCount).toBe(2);
});
