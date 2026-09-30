jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
jest.mock('../utils/stripe', () => ({}));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken'), mongoose = require('mongoose'), { randomUUID } = require('crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Notification = require('../models/Notification');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/cases', require('../routes/cases')); app.use('/api/case-drafts', require('../routes/caseDrafts')); app.use('/api/notifications', require('../routes/notifications'));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const queue = () => mongoose.connection.db.collection('matterpostingnotifications');
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); }); afterEach(() => jest.restoreAllMocks());
async function actors() {
  const [owner, para, admin] = await User.create(['attorney', 'paralegal', 'admin'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@posting-notice.test`, password: 'Synthetic123!', role, status: 'approved' })));
  return { owner, para, admin };
}
async function seed(kind) {
  const fixture = await actors();
  const matter = await Case.create({ title: 'River Street posting notices', details: 'Prepare the filing package and organize exhibits.', attorney: fixture.owner._id, attorneyId: fixture.owner._id, status: 'open', practiceArea: 'contract law', state: 'CA', totalAmount: 40000, tasks: [{ title: 'Prepare filing package' }], applicants: [{ paralegalId: fixture.para._id, status: 'pending' }] });
  const job = await Job.create({ title: matter.title, description: matter.details, attorneyId: fixture.owner._id, caseId: matter._id, practiceArea: matter.practiceArea, status: 'open', budget: 400 });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
  Object.assign(fixture, { matter, job });
  if (kind === 'review_requested') {
    expect((await request(app).post(`/api/cases/${matter._id}/flags/request-edits`).set('Cookie', cookie(fixture.admin)).send({ message: 'Clarify the public scope before requesting review.' })).status).toBe(200);
    await Case.updateOne({ _id: matter._id }, { $set: { title: 'Clarified River Street scope' } });
    await Notification.deleteMany({}); await queue().deleteMany({}); require('../utils/email').mockClear();
  }
  return fixture;
}
async function act(fixture, kind) {
  const { matter, owner, admin } = fixture, base = `/api/cases/${matter._id}`;
  if (kind === 'updated_original') return request(app).patch(base).set('Cookie', cookie(owner)).send({ title: 'Updated River Street scope' });
  if (kind === 'updated_reviewed') {
    const read = await request(app).get(`/api/cases/posting/${matter._id}`).set('Cookie', cookie(owner)); expect(read.status).toBe(200);
    return request(app).patch(`/api/cases/posting/${matter._id}`).set('Cookie', cookie(owner)).send({ expectedOwnerId: String(owner._id), revision: read.body.posting.revision, changes: { title: 'Updated River Street scope' } });
  }
  if (kind === 'edits_requested') return request(app).post(`${base}/flags/request-edits`).set('Cookie', cookie(admin)).send({ message: 'Clarify the public scope before requesting review.' });
  if (kind === 'review_requested') {
    const read = await request(app).get(`${base}/flags/review`).set('Cookie', cookie(owner)); expect(read.status).toBe(200); expect(read.body.canRequestReview).toBe(true);
    return request(app).post(`${base}/flags/mark-resolved`).set('Cookie', cookie(owner)).send({ expectedOwnerId: String(owner._id), revision: read.body.revision, requestId: randomUUID() });
  }
  return request(app).delete(base).set('Cookie', cookie(admin)).send({ expectedOwnerId: String(admin._id), reason: 'Outside the permitted posting scope', message: 'Review the scope before posting again.' });
}
for (const kind of ['updated_original', 'updated_reviewed', 'edits_requested', 'review_requested', 'deleted']) {
  test(`${kind} cannot succeed after losing its original recipient notice`, async () => {
    const fixture = await seed(kind), before = await Case.collection.findOne({ _id: fixture.matter._id }), jobBefore = await Job.collection.findOne({ _id: fixture.job._id });
    const create = Notification.create.bind(Notification); let injected = false;
    jest.spyOn(Notification, 'create').mockImplementation(async (...args) => { const notice = Array.isArray(args[0]) ? args[0][0] : args[0]; if (!injected && notice.type === (kind === 'deleted' ? 'case_deleted' : 'case_update')) { injected = true; throw Error('Synthetic posting notice unavailable'); } return create(...args); });
    const response = await act(fixture, kind), after = await Case.collection.findOne({ _id: fixture.matter._id });
    console.info('POSTING_NOTICE_BASELINE', { kind, injected, status: response.status, retained: !!after, notices: await Notification.countDocuments(), queued: await queue().countDocuments({}) });
    expect(injected).toBe(true); expect(response.status).toBe(503); expect(after).toEqual(before); expect(await Job.collection.findOne({ _id: fixture.job._id })).toEqual(jobBefore);
    expect(await Notification.countDocuments()).toBe(0); expect(await queue().countDocuments({})).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${kind} retains its original recipient email before delivery`, async () => {
    const fixture = await seed(kind), response = await act(fixture, kind);
    const observation = { status: response.status, notices: await Notification.countDocuments(), queued: await queue().countDocuments({}), emails: require('../utils/email').mock.calls.length };
    console.info('POSTING_EMAIL_BASELINE', { kind, ...observation });
    expect(observation).toEqual({ status: 200, notices: 1, queued: 1, emails: 0 });
    const recipient = kind.startsWith('updated') ? fixture.para : kind === 'review_requested' ? fixture.admin : fixture.owner;
    const notices = await request(app).get('/api/notifications/').set('Cookie', cookie(recipient));
    expect(notices.status).toBe(200); expect(notices.body).toHaveLength(1);
    expect(notices.body[0].available).toBe(true); expect(notices.body[0].message).toContain('River Street');
  });
}
for (const entry of ['original', 'reviewed']) test(`${entry} publication retains the existing administrator email obligation`, async () => {
  const { owner } = await actors(); let response;
  const fields = { title: 'New River Street posting', practiceArea: 'contract law', state: 'CA', experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence.', tasks: [{ title: 'Prepare filing package' }] };
  if (entry === 'original') response = await request(app).post('/api/cases').set('Cookie', cookie(owner)).send({ ...fields, totalAmount: 400 });
  else {
    const draft = await request(app).post('/api/case-drafts').set('Cookie', cookie(owner)).send({ ...fields, compAmount: '400' }); expect(draft.status).toBe(201);
    response = await request(app).post('/api/cases/posting/publications').set('Cookie', cookie(owner)).send({ expectedOwnerId: String(owner._id), requestId: randomUUID(), draftId: draft.body.draft.id, revision: draft.body.draft.revision, practiceArea: 'contract law' });
  }
  console.info('POSTING_CREATED_EMAIL_BASELINE', { entry, status: response.status, matters: await Case.countDocuments(), queued: await queue().countDocuments({}), emails: require('../utils/email').mock.calls.length });
  expect(response.status).toBe(201); expect(await Case.countDocuments()).toBe(1); expect(await queue().countDocuments({})).toBe(1); expect(await Notification.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
});

const Notice = require('../models/MatterPostingNotification'), delivery = require('../services/matterPostingNotifications'), Audit = require('../models/AuditLog');
for (const kind of ['updated_original', 'updated_reviewed', 'edits_requested', 'review_requested', 'deleted']) {
  test.each(['queue', 'indexes', 'audit'])(`${kind} rolls back its whole write when %s retention fails`, async failure => {
    const fixture = await seed(kind), before = await Case.collection.findOne({ _id: fixture.matter._id }), job = await Job.collection.findOne({ _id: fixture.job._id }), audit = await Audit.find().lean();
    if (failure === 'queue') jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic posting queue failure'));
    if (failure === 'indexes') jest.spyOn(Notice.collection, 'indexes').mockResolvedValueOnce([]);
    if (failure === 'audit') jest.spyOn(Audit, 'create').mockRejectedValueOnce(Error('Synthetic posting audit failure'));
    const response = await act(fixture, kind); expect(response.status).toBe(503); expect(response.body.code).toBe('POSTING_NOTICE_UNAVAILABLE');
    expect(await Case.collection.findOne({ _id: fixture.matter._id })).toEqual(before); expect(await Job.collection.findOne({ _id: fixture.job._id })).toEqual(job);
    expect(await Audit.find().lean()).toEqual(audit); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${kind} delivers once to the original recipient's current address with its own delivery reference`, async () => {
    const fixture = await seed(kind); expect((await act(fixture, kind)).status).toBe(200);
    const recipient = kind.startsWith('updated') ? fixture.para : kind === 'review_requested' ? fixture.admin : fixture.owner;
    await User.updateOne({ _id: recipient._id }, { $set: { email: 'current-recipient@posting-notice.test' } });
    const notice = await Notice.findOne();
    expect(await delivery.processNotices()).toBe(1); expect(await delivery.processNotices()).toBe(0);
    expect((await Notice.findById(notice._id)).status).toBe('accepted'); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
    const [to, subject, html, options] = require('../utils/email').mock.calls[0]; expect(to).toBe('current-recipient@posting-notice.test'); expect(subject).toBeTruthy(); expect(html).toContain('River Street');
    expect(options.messageId).toBe(`<lpc-posting.${notice._id}@lets-paraconnect.com>`);
    if (kind.startsWith('updated')) expect(html).toContain(`/dashboard-paralegal.html?jobId=${fixture.job._id}#cases`);
    if (kind === 'deleted') { expect(html).toContain('Outside the permitted posting scope'); expect(html).toContain('Review the scope before posting again.'); expect(html).not.toContain('/case-detail.html'); }
  });
}
test.each(['email', 'emailCase', 'inApp', 'inAppCase'])('posting updates preserve the recipient %s preference', async preference => {
  const fixture = await seed('updated_original'); await User.updateOne({ _id: fixture.para._id }, { $set: { [`notificationPrefs.${preference}`]: false } });
  expect((await act(fixture, 'updated_original')).status).toBe(200);
  expect(await Notice.countDocuments()).toBe(preference.startsWith('email') ? 0 : 1); expect(await Notification.countDocuments()).toBe(preference.startsWith('inApp') ? 0 : 1); expect(require('../utils/email')).not.toHaveBeenCalled();
});
test('admin removal keeps mandatory owner email even when ordinary Matter email is disabled', async () => {
  const fixture = await seed('deleted'); await User.updateOne({ _id: fixture.owner._id }, { $set: { 'notificationPrefs.email': false, 'notificationPrefs.emailCase': false } });
  expect((await act(fixture, 'deleted')).status).toBe(200); expect(await Notice.countDocuments()).toBe(1);
  expect(await delivery.processNotices()).toBe(1); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});
test.each(['admin_update', 'owner_removal', 'admin_removal_without_message'])('%s preserves its original no-notice audience', async action => {
  const fixture = await seed('deleted');
  const response = action === 'admin_update'
    ? await request(app).patch(`/api/cases/${fixture.matter._id}`).set('Cookie', cookie(fixture.admin)).send({ title: 'Admin-adjusted scope' })
    : await request(app).delete(`/api/cases/${fixture.matter._id}`).set('Cookie', cookie(action === 'owner_removal' ? fixture.owner : fixture.admin)).send({});
  expect(response.status).toBe(200); expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
});
test.each(['posting_changed', 'application_rejected', 'owner_changed', 'owner_disabled', 'recipient_disabled', 'owner_role_changed', 'blocked', 'assigned', 'deleted'])('%s suppresses an obsolete posting update before email delivery', async change => {
  const fixture = await seed('updated_original'); expect((await act(fixture, 'updated_original')).status).toBe(200);
  if (change === 'posting_changed') await Case.updateOne({ _id: fixture.matter._id }, { $set: { details: 'A later, different posting scope' } });
  if (change === 'application_rejected') await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'applicants.0.status': 'rejected' } });
  if (change === 'owner_changed') { const owner = new mongoose.Types.ObjectId(); await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { attorney: owner, attorneyId: owner } }); }
  if (change === 'owner_disabled' || change === 'recipient_disabled') await User.updateOne({ _id: change === 'owner_disabled' ? fixture.owner._id : fixture.para._id }, { $set: { disabled: true } });
  if (change === 'owner_role_changed') await User.updateOne({ _id: fixture.owner._id }, { $set: { role: 'paralegal' } });
  if (change === 'blocked') await require('../models/Block').create({ blockerId: fixture.para._id, blockedId: fixture.owner._id, active: true });
  if (change === 'assigned') await Case.updateOne({ _id: fixture.matter._id }, { $set: { paralegalId: fixture.para._id } });
  if (change === 'deleted') await Case.deleteOne({ _id: fixture.matter._id });
  expect(await delivery.processNotices()).toBe(1); expect((await Notice.findOne()).status).toBe('skipped'); expect(require('../utils/email')).not.toHaveBeenCalled();
});
test('an internal note does not supersede a public posting change', async () => {
  const fixture = await seed('updated_original'); expect((await act(fixture, 'updated_original')).status).toBe(200);
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'internalNotes.text': 'Private preparation that is not a posting edit.' } });
  expect(await delivery.processNotices()).toBe(1); expect((await Notice.findOne()).status).toBe('accepted'); expect(require('../utils/email').mock.calls[0][2]).not.toContain('Private preparation');
});
test('unknown posting email delivery stays retained without automatic resend', async () => {
  const fixture = await seed('updated_original'); expect((await act(fixture, 'updated_original')).status).toBe(200);
  require('../utils/email').mockRejectedValueOnce(Error('Lost SMTP acknowledgement'));
  await delivery.processNotices(); expect((await Notice.findOne()).status).toBe('unknown');
  await delivery.processNotices(); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});
test('publication email preserves the existing admin audience independently of notification preferences', async () => {
  const { owner, admin } = await actors(); await User.updateOne({ _id: admin._id }, { $set: { 'notificationPrefs.email': false, 'notificationPrefs.emailCase': false } });
  const response = await request(app).post('/api/cases').set('Cookie', cookie(owner)).send({ title: 'River Street filing', practiceArea: 'contract law', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and review supporting materials.', tasks: [{ title: 'Prepare filing' }] });
  expect(response.status).toBe(201); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(1);
  expect(await delivery.processNotices()).toBe(1); expect((await Notice.findOne()).status).toBe('accepted'); expect(require('../utils/email').mock.calls[0][2]).toMatch(/href="https?:\/\/[^"\s]+\/admin-dashboard.html#posts"/);
});

test('retained deletion is visible only to its original owner and grants no deleted-Matter access', async () => {
  const fixture = await seed('deleted'); expect((await act(fixture, 'deleted')).status).toBe(200);
  const owner = await request(app).get('/api/notifications').set('Cookie', cookie(fixture.owner)); expect(owner.status).toBe(200);
  expect(owner.body).toHaveLength(1); expect(owner.body[0]).toMatchObject({ available: true, type: 'case_deleted', context: {}, action: { label: 'View Matters', href: '/dashboard-attorney.html#cases:inquiries' } });
  expect(owner.body[0].message).toContain(fixture.matter.title);
  const para = await request(app).get('/api/notifications').set('Cookie', cookie(fixture.para)); expect(para.body).toEqual([]);
  expect((await request(app).get(`/api/cases/${fixture.matter._id}`).set('Cookie', cookie(fixture.owner))).status).toBe(404);
});
test('earlier application notices keep the real Job destination in the notification API projection', async () => {
  const fixture = await seed('updated_original'); expect((await act(fixture, 'updated_original')).status).toBe(200);
  await Notification.create({ userId: fixture.para._id, type: 'pre_engagement_requested', payload: { caseId: String(fixture.matter._id), applicantId: String(fixture.para._id) }, message: 'Synthetic retained pre-engagement request' });
  const response = await request(app).get('/api/notifications').set('Cookie', cookie(fixture.para)); expect(response.status).toBe(200); expect(response.body).toHaveLength(2);
  expect(response.body.every(row => row.available && row.action.href === `/dashboard-paralegal.html?jobId=${fixture.job._id}#cases`)).toBe(true);
});
