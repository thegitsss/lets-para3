jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({ accounts: { retrieve: jest.fn(async () => ({ details_submitted: true, charges_enabled: true, payouts_enabled: true })) } }));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application'), Notification = require('../models/Notification');
const Notice = require('../models/MatterApplicationNotification'), delivery = require('../services/matterApplicationNotifications');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/cases', require('../routes/cases')); app.use('/api/jobs', require('../routes/jobs')); app.use('/api/notifications', require('../routes/notifications'));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); }); afterEach(() => jest.restoreAllMocks());
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, status: 'approved' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
async function seed() {
  const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@application-submission.test`, password: 'Synthetic123!', role, status: 'approved', state: 'CA', ...(role === 'paralegal' ? { profileImage: 'https://example.test/synthetic.jpg', stripeAccountId: 'acct_synthetic_submission', stripeOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true } : {}) })));
  const matter = await Case.create({ title: 'River Street application review', details: 'Synthetic application scope.', practiceArea: 'immigration', attorney: attorney._id, attorneyId: attorney._id, status: 'open', totalAmount: 60000, currency: 'usd', tasks: [{ title: 'Review filing', completed: false }] });
  const job = await Job.create({ title: matter.title, description: matter.details, practiceArea: 'immigration', attorneyId: attorney._id, caseId: matter._id, status: 'open', budget: 600 });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
  return { attorney, para, matter, job };
}
const apply = (fixture, entry) => request(app).post(entry === 'job' ? `/api/jobs/${fixture.job._id}/apply` : `/api/cases/${fixture.matter._id}/apply`).set('Cookie', cookie(fixture.para)).send({ coverLetter: 'I can organize and check the filing documents.\n\nRetain this application paragraph.' });
async function state(fixture) {
  const matter = await Case.findById(fixture.matter._id).lean(), job = await Job.findById(fixture.job._id).lean();
  return { applications: await Application.countDocuments(), applicants: matter.applicants, lockedTotalAmount: matter.lockedTotalAmount, amountLockedAt: matter.amountLockedAt, applicantsCount: job.applicantsCount, notices: await Notification.countDocuments(), queued: await Notice.countDocuments() };
}
for (const entry of ['job', 'matter']) test.each(['case_budget_locked', 'application_submitted'])(`${entry} submission rolls back when its %s notice cannot be retained`, async type => {
  const fixture = await seed(), before = await state(fixture), create = Notification.create.bind(Notification);
  let injected = false;
  const spy = jest.spyOn(Notification, 'create').mockImplementation(async (...args) => {
    const record = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!injected && record.type === type) { injected = true; throw new Error('Synthetic submission notice unavailable'); }
    return create(...args);
  });
  const response = await apply(fixture, entry), after = await state(fixture);
  console.info('APPLICATION_SUBMISSION_NOTICE_BASELINE', { entry, type, status: response.status, before, after, injected });
  expect(injected).toBe(true); expect({ status: response.status, state: after }).toEqual({ status: 503, state: before });
  spy.mockRestore();
  const retry = await apply(fixture, entry); expect(retry.status).toBe(201);
  expect(await Notification.countDocuments({ userId: fixture.attorney._id, type: 'application_submitted' })).toBe(1);
  expect(await Notification.countDocuments({ userId: fixture.attorney._id, type: 'case_budget_locked' })).toBe(1);
  expect((await apply(fixture, entry)).status).toBe(400);
  expect(await Application.countDocuments()).toBe(1); expect(await Notification.countDocuments()).toBe(2); expect(await Notice.countDocuments()).toBe(1); expect(require('../utils/email')).not.toHaveBeenCalled();
});

test.each(['queued email', 'delivery index', 'amount lock'])('a failed %s keeps the application and recipient records unsaved', async failure => {
  const fixture = await seed(), before = await state(fixture);
  if (failure === 'queued email') jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic queue unavailable'));
  if (failure === 'delivery index') jest.spyOn(Notice.collection, 'indexes').mockResolvedValue([]);
  if (failure === 'amount lock') {
    const update = Case.collection.updateOne.bind(Case.collection);
    jest.spyOn(Case.collection, 'updateOne').mockImplementation((filter, change, options) => {
      if (options?.session && change.$set?.amountLockedAt) throw Object.assign(Error('Synthetic amount lock unavailable'), { status: 503 });
      return update(filter, change, options);
    });
  }
  expect((await apply(fixture, 'job')).status).toBe(503); expect(await state(fixture)).toEqual(before); expect(require('../utils/email')).not.toHaveBeenCalled();
});

test.each([
  [{}, 2, 1], [{ email: false }, 2, 0], [{ emailCase: false }, 2, 0],
  [{ inApp: false }, 0, 1], [{ inAppCase: false }, 1, 1], [{ inApp: false, email: false }, 0, 0],
])('application submission preserves recipient preferences %j', async (prefs, notices, queued) => {
  const fixture = await seed();
  await User.updateOne({ _id: fixture.attorney._id }, { $set: Object.fromEntries(Object.entries(prefs).map(([key, value]) => [`notificationPrefs.${key}`, value])) });
  expect((await apply(fixture, 'matter')).status).toBe(201);
  expect(await Notification.countDocuments()).toBe(notices); expect(await Notice.countDocuments()).toBe(queued); expect(require('../utils/email')).not.toHaveBeenCalled();
  expect(await Notification.countDocuments({ userId: fixture.para._id })).toBe(0);
});

test('an already locked Matter has one application notice and no new amount-lock notice', async () => {
  const fixture = await seed(), at = new Date('2026-01-01');
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { lockedTotalAmount: 60000, amountLockedAt: at } });
  expect((await apply(fixture, 'job')).status).toBe(201);
  expect(await Notification.countDocuments({ type: 'case_budget_locked' })).toBe(0); expect(await Notification.countDocuments({ type: 'application_submitted' })).toBe(1);
  expect((await Case.findById(fixture.matter._id)).amountLockedAt).toEqual(at);
});

test('the deferred email uses the current identity and exact application link without the private submission text', async () => {
  const fixture = await seed(); expect((await apply(fixture, 'matter')).status).toBe(201);
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { title: 'Current <b>River Street</b> filing' } });
  await User.updateOne({ _id: fixture.attorney._id }, { $set: { email: 'current@application-submission.test' } });
  await User.updateOne({ _id: fixture.para._id }, { $set: { firstName: 'Dana', lastName: 'Young' } });
  const mail = require('../utils/email'); mail.mockImplementation(async to => ({ accepted: [to] }));
  await delivery.processNotices(); expect(mail).toHaveBeenCalledTimes(1);
  const [to, subject, html] = mail.mock.calls[0]; expect(to).toBe('current@application-submission.test'); expect(subject).toContain('Current');
  expect(html).toContain('Current &lt;b&gt;River Street&lt;/b&gt; filing'); expect(html).toContain('Dana Young'); expect(html).not.toContain('Retain this application paragraph');
  expect(html.match(/<a /g)).toHaveLength(1); expect(html).toContain(`/case-detail.html?caseId=${fixture.matter._id}&amp;tab=applications&amp;applicantId=${fixture.para._id}`);
  expect(await Notice.countDocuments({ status: 'accepted' })).toBe(1); await delivery.processNotices(); expect(mail).toHaveBeenCalledTimes(1);
});

test.each(['withdrawn', 'rejected', 'accepted', 'closed_posting', 'archived', 'owner_changed', 'owner_conflict', 'applicant_changed', 'owner_disabled', 'applicant_disabled', 'email_disabled', 'blocked'])(
  '%s prevents a stale application email', async change => {
    const fixture = await seed(); expect((await apply(fixture, 'job')).status).toBe(201);
    const next = new (require('mongoose').Types.ObjectId)();
    if (['withdrawn', 'rejected', 'accepted'].includes(change)) await Application.updateOne({ jobId: fixture.job._id }, { $set: { status: change } });
    if (change === 'closed_posting') await Job.updateOne({ _id: fixture.job._id }, { $set: { status: 'closed' } });
    if (change === 'archived') await Case.updateOne({ _id: fixture.matter._id }, { $set: { archived: true } });
    if (change === 'owner_changed') await Job.updateOne({ _id: fixture.job._id }, { $set: { attorneyId: next } });
    if (change === 'owner_conflict') await Case.updateOne({ _id: fixture.matter._id }, { $set: { attorneyId: next } });
    if (change === 'applicant_changed') await Application.updateOne({ jobId: fixture.job._id }, { $set: { paralegalId: next } });
    if (change === 'owner_disabled') await User.updateOne({ _id: fixture.attorney._id }, { $set: { disabled: true } });
    if (change === 'applicant_disabled') await User.updateOne({ _id: fixture.para._id }, { $set: { disabled: true } });
    if (change === 'email_disabled') await User.updateOne({ _id: fixture.attorney._id }, { $set: { 'notificationPrefs.emailCase': false } });
    if (change === 'blocked') await require('../models/Block').create({ blockerId: fixture.attorney._id, blockedId: fixture.para._id });
    await delivery.processNotices(); expect(require('../utils/email')).not.toHaveBeenCalled(); expect(await Notice.countDocuments({ status: 'skipped' })).toBe(1);
  }
);

test('a deferred mirror failure keeps its email for retry after application reconciliation', async () => {
  const fixture = await seed(), update = Case.updateOne.bind(Case);
  jest.spyOn(Case, 'updateOne').mockImplementation((filter, changes, ...args) => {
    if (changes.$push?.applicants) throw Error('Synthetic mirror outage');
    return update(filter, changes, ...args);
  });
  expect((await apply(fixture, 'job')).status).toBe(201);
  let application = await Application.findOne({ jobId: fixture.job._id }); expect(application.syncStatus).toBe('needs_reconciliation');
  await delivery.processNotices(); expect(require('../utils/email')).not.toHaveBeenCalled(); expect(await Notice.countDocuments({ status: 'failed' })).toBe(1);
  jest.restoreAllMocks(); await require('../services/applicationService').syncApplicationMirror({ application, caseId: fixture.matter._id });
  await Notice.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  require('../utils/email').mockImplementation(async to => ({ accepted: [to] })); await delivery.processNotices();
  expect(require('../utils/email')).toHaveBeenCalledTimes(1); expect(await Notice.countDocuments({ status: 'accepted' })).toBe(1);
});

test('reapplying binds a new submission while the earlier email becomes stale', async () => {
  const fixture = await seed(); expect((await apply(fixture, 'job')).status).toBe(201);
  const before = await Notice.findOne().lean();
  await Application.updateOne({ jobId: fixture.job._id }, { $set: { status: 'withdrawn', withdrawnAt: new Date() }, $push: { statusHistory: { to: 'withdrawn', reason: 'withdrawn', actorId: fixture.para._id, at: new Date() } } });
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { applicants: [] } });
  expect((await apply(fixture, 'job')).status).toBe(201);
  const records = await Notice.find().lean(); expect(records).toHaveLength(2); expect(new Set(records.map(value => value.submissionKey)).size).toBe(2);
  require('../utils/email').mockImplementation(async to => ({ accepted: [to] })); await delivery.processNotices();
  expect((await Notice.findById(before._id)).status).toBe('skipped'); expect(await Notice.countDocuments({ status: 'accepted' })).toBe(1); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
  expect(await Notification.countDocuments({ type: 'case_budget_locked' })).toBe(1);
});

test.each(['amount', 'scope', 'owner', 'closed', 'assigned'])('a %s change during submission preparation cannot record a stale application notice', async change => {
  const fixture = await seed();
  require('../utils/stripe').accounts.retrieve.mockImplementationOnce(async () => {
    const next = new (require('mongoose').Types.ObjectId)();
    const values = { amount: { totalAmount: 80000 }, scope: { details: 'Changed filing scope' }, owner: { attorney: next, attorneyId: next }, closed: { status: 'closed' }, assigned: { paralegal: fixture.para._id, paralegalId: fixture.para._id } };
    await Case.updateOne({ _id: fixture.matter._id }, { $set: values[change] });
    return { details_submitted: true, charges_enabled: true, payouts_enabled: true };
  });
  expect((await apply(fixture, 'job')).status).toBe(409); expect(await Application.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});


test('amount-lock notifications use verified current amount evidence and a factual fallback for earlier notices', async () => {
  const fixture = await seed(); expect((await apply(fixture, 'job')).status).toBe(201);
  const notices = async () => { const response = await request(app).get('/api/notifications').set('Cookie', cookie(fixture.attorney)); expect(response.status).toBe(200); return response.body.items || response.body; };
  const current = (await notices()).find(row => row.type === 'case_budget_locked');
  expect(current.message).toBe('Matter amount locked for River Street application review');
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { lockedTotalAmount: null, amountLockedAt: null } });
  const earlier = (await notices()).find(row => row.type === 'case_budget_locked'); expect(earlier.message).toBe('Review the Matter amount for River Street application review');
});


test('a missing original attorney cannot leave a saved application without its notification recipient', async () => {
  const fixture = await seed(), before = await state(fixture); await User.deleteOne({ _id: fixture.attorney._id });
  expect((await apply(fixture, 'job')).status).toBe(503); expect(await state(fixture)).toEqual(before);
});
