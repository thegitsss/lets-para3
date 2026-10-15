jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
jest.mock('../utils/stripe', () => ({}));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application'), Notification = require('../models/Notification'), Notice = require('../models/MatterApplicationNotification');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/applications', require('../routes/applications')); app.use('/api/cases', require('../routes/cases'));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); }); afterEach(() => jest.restoreAllMocks());
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
async function seed(source = 'canonical') {
  const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@application-withdrawal.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const at = new Date('2026-09-01');
  const matter = await Case.create({ title: 'River Street application withdrawal', details: 'Synthetic withdrawal scope.', practiceArea: 'immigration', attorney: attorney._id, attorneyId: attorney._id, status: 'open', totalAmount: 60000, lockedTotalAmount: 60000, tasks: [{ title: 'Review filing', completed: false }], applicants: [{ paralegalId: para._id, status: 'pending', note: 'Retain my original application letter.', appliedAt: at }] });
  const job = await Job.create({ title: matter.title, description: matter.details, practiceArea: 'immigration', attorneyId: attorney._id, caseId: matter._id, status: 'open', budget: 600, applicantsCount: 1 });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
  const application = source === 'canonical' ? await Application.create({ jobId: job._id, paralegalId: para._id, status: 'submitted', syncStatus: 'synced', coverLetter: 'Retain my original application letter.', scopeSnapshot: { title: matter.title, caseId: String(matter._id), capturedAt: at }, statusHistory: [{ to: 'submitted', reason: 'applied', actorId: para._id, at }] }) : null;
  const own = await request(app).get('/api/applications/my').set('Cookie', cookie(para)); expect(own.status).toBe(200);
  const record = source === 'canonical' ? own.body.find(row => String(row._id) === String(application._id)) : own.body.find(row => String(row.caseId) === String(matter._id));
  return { attorney, para, matter, job, application, record, source };
}
const withdraw = fixture => request(app).post(fixture.application ? `/api/applications/${fixture.application._id}/revoke` : `/api/applications/earlier/${fixture.matter._id}/revoke`).set('Cookie', cookie(fixture.para)).send(fixture.application ? {} : { expectedOwnerId: String(fixture.para._id), expectedRevision: fixture.record.withdrawal.revision });

test('a failed canonical withdrawal notice cannot report a saved withdrawal and keeps the mirror repair explicit', async () => {
  const fixture = await seed(); jest.spyOn(Notification, 'create').mockRejectedValueOnce(Error('Synthetic withdrawal notice unavailable'));
  const response = await withdraw(fixture), application = await Application.findById(fixture.application._id).lean(), matter = await Case.findById(fixture.matter._id).lean();
  const observation = { status: response.status, applicationStatus: application.status, syncStatus: application.syncStatus, mirrorCount: matter.applicants.length, notices: await Notification.countDocuments(), queued: await Notice.collection.countDocuments({ kind: 'withdrawn' }), emails: require('../utils/email').mock.calls.length };
  console.info('APPLICATION_WITHDRAWAL_NOTICE_BASELINE', observation);
  expect(observation).toEqual({ status: 503, applicationStatus: 'submitted', syncStatus: 'needs_reconciliation', mirrorCount: 0, notices: 0, queued: 0, emails: 0 });
});

test.each(['canonical', 'earlier'])('%s withdrawal retains its original attorney email before sending', async source => {
  const fixture = await seed(source), response = await withdraw(fixture);
  const observation = { status: response.status, notices: await Notification.countDocuments({ userId: fixture.attorney._id }), queued: await Notice.collection.countDocuments({ kind: 'withdrawn' }), emails: require('../utils/email').mock.calls.length };
  console.info('APPLICATION_WITHDRAWAL_EMAIL_BASELINE', { source, ...observation });
  expect(observation).toEqual({ status: 200, notices: 1, queued: 1, emails: 0 });
});

const delivery = require('../services/matterApplicationNotifications');
const queueFor = fixture => Notice.findOne({ kind: 'withdrawn', userId: fixture.attorney._id }).lean();
const savedFor = async fixture => fixture.application ? Application.findById(fixture.application._id).lean() : (await Case.findById(fixture.matter._id).lean()).applicants.find(entry => String(entry.paralegalId) === String(fixture.para._id));
for (const source of ['canonical', 'earlier']) {
  test(`${source} queue failure rolls back the withdrawal and its in-app notice`, async () => {
    const fixture = await seed(source); jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic queue unavailable'));
    expect((await withdraw(fixture)).status).toBe(source === 'canonical' ? 503 : 500);
    expect((await savedFor(fixture)).status).toBe(source === 'canonical' ? 'submitted' : 'pending');
    expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
    if (source === 'canonical') { expect((await savedFor(fixture)).syncStatus).toBe('needs_reconciliation'); expect((await Case.findById(fixture.matter._id)).applicants).toHaveLength(0); }
    expect((await withdraw(fixture)).status).toBe(200); expect(await Notice.countDocuments()).toBe(1); expect(await Notification.countDocuments()).toBe(1);
  });
  test.each(['email', 'emailCase', 'inApp', 'inAppCase'])(`${source} respects disabled %s preferences without losing the saved withdrawal`, async preference => {
    const fixture = await seed(source); await User.updateOne({ _id: fixture.attorney._id }, { $set: { [`notificationPrefs.${preference}`]: false } });
    expect((await withdraw(fixture)).status).toBe(200); expect((await savedFor(fixture)).status).toBe('withdrawn');
    expect(await Notice.countDocuments()).toBe(preference.startsWith('email') ? 0 : 1);
    expect(await Notification.countDocuments()).toBe(preference.startsWith('inApp') ? 0 : 1); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${source} retains one event on replay and resolves current email details only at delivery`, async () => {
    const fixture = await seed(source); expect((await withdraw(fixture)).status).toBe(200);
    const first = await queueFor(fixture); expect(first.source).toBe(source); expect(first.status).toBe('pending');
    expect(first.applicationId ? String(first.applicationId) : null).toBe(fixture.application ? String(fixture.application._id) : null);
    expect((await withdraw(fixture)).body.alreadyRevoked).toBe(true); expect(await Notice.countDocuments()).toBe(1); expect(await Notification.countDocuments()).toBe(1);
    await User.updateOne({ _id: fixture.attorney._id }, { $set: { email: 'current-owner@application-withdrawal.test' } });
    await User.updateOne({ _id: fixture.para._id }, { $set: { firstName: 'River', lastName: 'Quinn' } });
    await Case.updateOne({ _id: fixture.matter._id }, { $set: { title: 'Current River Street Matter' } });
    expect(await delivery.processNotices()).toBe(1); expect(await delivery.processNotices()).toBe(0);
    expect((await queueFor(fixture)).status).toBe('accepted');
    const [[to, subject, html, options]] = require('../utils/email').mock.calls;
    expect(to).toBe('current-owner@application-withdrawal.test'); expect(subject).toBe('Application withdrawn: Current River Street Matter');
    expect(html).toContain('River Quinn'); expect(html).toContain(`caseId=${fixture.matter._id}&amp;applicantId=${fixture.para._id}&amp;openApplicant=1&amp;applicationHistory=1#cases:inquiries`);
    expect(html).not.toContain('Retain my original application letter.'); expect(html.match(/<a\s/g)).toHaveLength(1);
    expect(options.messageId).toBe(`<lpc-application.${first._id}@lets-paraconnect.com>`);
    const projected = require('../services/notificationPresentation').presentNotification(await Notification.findOne().lean(), { viewer: fixture.attorney, caseDoc: await Case.findById(fixture.matter._id).lean() });
    expect(projected.message).toBe('Synthetic withdrew their application for Current River Street Matter');
    expect(projected.action.href).toContain(`applicantId=${fixture.para._id}`);
  });
  test.each(['reapplied', 'different_withdrawal', 'owner_changed', 'owner_disabled', 'applicant_disabled', 'email_disabled', 'blocked', 'purged'])(`${source} skips a ${'%s'} event before sending`, async change => {
    const fixture = await seed(source); expect((await withdraw(fixture)).status).toBe(200);
    if (change === 'reapplied') {
      if (fixture.application) await Application.updateOne({ _id: fixture.application._id }, { $set: { status: 'submitted' } });
      else await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { 'applicants.0.status': 'pending' } });
    } else if (change === 'different_withdrawal') {
      if (fixture.application) await Application.updateOne({ _id: fixture.application._id }, { $set: { withdrawnAt: new Date(Date.now() + 1000) } });
      else await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { 'applicants.0.withdrawnAt': new Date(Date.now() + 1000) } });
    } else if (change === 'owner_changed') await Case.updateOne({ _id: fixture.matter._id }, { $set: { attorneyId: new (require('mongoose').Types.ObjectId)() } });
    else if (change === 'owner_disabled' || change === 'applicant_disabled') await User.updateOne({ _id: change === 'owner_disabled' ? fixture.attorney._id : fixture.para._id }, { $set: { disabled: true } });
    else if (change === 'email_disabled') await User.updateOne({ _id: fixture.attorney._id }, { $set: { 'notificationPrefs.emailCase': false } });
    else if (change === 'blocked') await require('../models/Block').create({ blockerId: fixture.attorney._id, blockedId: fixture.para._id });
    else if (change === 'purged') await Case.updateOne({ _id: fixture.matter._id }, { $set: { purgedAt: new Date() } });
    expect(await delivery.processNotices()).toBe(1); expect((await queueFor(fixture)).status).toBe('skipped'); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${source} missing indexes cannot accept a withdrawal without its email obligation`, async () => {
    const fixture = await seed(source); jest.spyOn(Notice.collection, 'indexes').mockResolvedValueOnce([]);
    expect((await withdraw(fixture)).status).toBe(source === 'canonical' ? 503 : 500);
    expect((await savedFor(fixture)).status).toBe(source === 'canonical' ? 'submitted' : 'pending'); expect(await Notification.countDocuments()).toBe(0);
  });
  test(`${source} unknown commit keeps one notice and replay completes any pending count without resending`, async () => {
    const fixture = await seed(source), mongoose = require('mongoose'), start = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      const session = await start(...args), commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => { await commit(); throw Object.assign(Error('Synthetic unknown commit'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); }; return session;
    });
    const first = await withdraw(fixture); expect(first.status).toBe(503); expect(first.body.code).toBe('ACCOUNT_WRITE_UNCONFIRMED');
    expect((await savedFor(fixture)).status).toBe('withdrawn'); expect(await Notification.countDocuments()).toBe(1); expect(await Notice.countDocuments()).toBe(1); expect(require('../utils/email')).not.toHaveBeenCalled();
    const repeat = await withdraw(fixture); expect(repeat.status).toBe(200); expect(repeat.body.alreadyRevoked).toBe(true);
    if (source === 'canonical') expect((await savedFor(fixture)).syncStatus).toBe('synced');
    expect(await delivery.processNotices()).toBe(1); expect((await queueFor(fixture)).status).toBe('accepted'); expect(require('../utils/email')).toHaveBeenCalledTimes(1); expect(await Notice.countDocuments()).toBe(1);
  });
}

test('a deferred canonical recount holds email until an ordinary replay reconciles the same withdrawal', async () => {
  const fixture = await seed(); jest.spyOn(require('../services/applicationWithdrawalInterlock'), 'syncCount').mockRejectedValueOnce(Error('Synthetic count unavailable'));
  expect((await withdraw(fixture)).status).toBe(200); expect((await savedFor(fixture)).syncStatus).toBe('needs_reconciliation');
  expect(await delivery.processNotices()).toBe(1); expect((await queueFor(fixture)).status).toBe('failed'); expect(require('../utils/email')).not.toHaveBeenCalled();
  expect((await withdraw(fixture)).body.alreadyRevoked).toBe(true); expect((await savedFor(fixture)).syncStatus).toBe('synced');
  await Notice.updateMany({}, { $set: { nextAttemptAt: new Date(0) } }); expect(await delivery.processNotices()).toBe(1); expect((await queueFor(fixture)).status).toBe('accepted'); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});

test('earlier unlinked withdrawal retains its own email without inventing an Application or Job', async () => {
  const fixture = await seed('earlier'); await Job.deleteOne({ _id: fixture.job._id }); await Case.collection.updateOne({ _id: fixture.matter._id }, { $unset: { jobId: '', job: '' } });
  // The stored application entry is unchanged, so its reviewed revision remains valid.
  expect((await withdraw(fixture)).status).toBe(200); expect(await Job.countDocuments()).toBe(0); expect(await Application.countDocuments()).toBe(0);
  expect(await delivery.processNotices()).toBe(1); expect((await queueFor(fixture)).status).toBe('accepted');
});

test('an earlier withdrawal email is superseded when a canonical application appears', async () => {
  const fixture = await seed('earlier'); expect((await withdraw(fixture)).status).toBe(200);
  await Application.create({ jobId: fixture.job._id, paralegalId: fixture.para._id, status: 'submitted', coverLetter: 'New application.' });
  expect(await delivery.processNotices()).toBe(1); expect((await queueFor(fixture)).status).toBe('skipped'); expect(require('../utils/email')).not.toHaveBeenCalled();
});

test('withdrawal suppresses its queued submission email while retaining the separate withdrawal email', async () => {
  const fixture = await seed(), application = await savedFor(fixture);
  await Notice.create({ applicationId: application._id, submissionKey: delivery.submissionKey(application), jobId: fixture.job._id, caseId: fixture.matter._id, userId: fixture.attorney._id, paralegalId: fixture.para._id });
  expect((await withdraw(fixture)).status).toBe(200); expect(await delivery.processNotices()).toBe(2);
  expect((await Notice.findOne({ kind: 'submitted' }).lean()).status).toBe('skipped'); expect((await queueFor(fixture)).status).toBe('accepted'); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});

test.each(['canonical', 'earlier'])('%s withdrawal links the existing retained inventory while its old active preview stays restricted', async source => {
  const fixture = await seed(source); expect((await withdraw(fixture)).status).toBe(200);
  const legacyPreview = await request(app).get(`/api/cases/${fixture.matter._id}/applications/${fixture.para._id}/preview`).set('Cookie', cookie(fixture.attorney)); expect(legacyPreview.status).toBe(404);
  const path = `/api/cases/${fixture.matter._id}/application-inventory?expectedOwnerId=${fixture.attorney._id}&applicantId=${fixture.para._id}`;
  const inventory = await request(app).get(path).set('Cookie', cookie(fixture.attorney)); expect(inventory.status).toBe(200);
  expect(inventory.body.applications).toHaveLength(1); expect(inventory.body.applications[0]).toMatchObject({ status: 'withdrawn', coverLetter: 'Retain my original application letter.' });
  // requireCaseAccess hides the protected Matter before the inventory role guard.
  expect((await request(app).get(path).set('Cookie', cookie(fixture.para))).status).toBe(404);
  const presented = require('../services/notificationPresentation').presentNotification(await Notification.findOne().lean(), { viewer: fixture.attorney, caseDoc: await Case.findById(fixture.matter._id).lean() });
  expect(presented.action).toEqual({ label: 'View application', href: `/dashboard-attorney.html?caseId=${fixture.matter._id}&applicantId=${fixture.para._id}&openApplicant=1&applicationHistory=1#cases:inquiries` });
});
