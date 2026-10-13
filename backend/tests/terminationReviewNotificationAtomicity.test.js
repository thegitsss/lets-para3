process.env.STRIPE_SECRET_KEY = "sk_test_stub";
// Failure and retained-destination checks for the existing termination request.
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Notification = require('../models/Notification'), AuditLog = require('../models/AuditLog'), Notice = require('../models/MatterReviewNotification');
const app = express(); app.use(cookieParser(), express.json());
app.use((req, res, next) => {
  const json = res.json;
  res.json = function (body) {
    if (this.statusCode === 401) console.info('TERMINATION_AUTH_OBSERVATION', { method: req.method, path: req.originalUrl, hasCookieHeader: Boolean(req.headers.cookie), hasParsedToken: Boolean(req.cookies?.token), userPresent: Boolean(req.user), body });
    return json.call(this, body);
  };
  next();
});
app.use('/api/cases', require('../routes/cases')); app.use('/api/notifications', require('../routes/notifications'));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); }); afterEach(() => jest.restoreAllMocks());
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, status: 'approved' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
async function seed() {
  const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@termination-review.test`, password: 'Synthetic123!', role, status: 'approved', state: 'CA' })));
  const matter = await Case.create({ title: 'River Street termination review', details: 'Synthetic scope record.', attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: 'in progress', hiredAt: new Date(), escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_termination', fundingIntegrityStatus: 'verified', totalAmount: 70000, currency: 'usd', tasks: [{ title: 'Review agreement', completed: false }] });
  return { attorney, para, matter };
}
const reason = 'The remaining scope needs an LPC review.\n\nRetain both paragraphs.';
const terminate = ({ attorney, matter }) => request(app).post(`/api/cases/${matter._id}/terminate`).set('Cookie', cookie(attorney)).send({ reason });
test.each(['notification', 'audit', 'queued email'])('termination review rolls back access revocation if its %s record fails', async failure => {
  const fixture = await seed(), before = await Case.collection.findOne({ _id: fixture.matter._id });
  jest.spyOn(failure === 'notification' ? Notification : failure === 'audit' ? AuditLog : Notice, 'create').mockRejectedValueOnce(Error('Synthetic termination record unavailable'));
  const response = await terminate(fixture), after = await Case.collection.findOne({ _id: fixture.matter._id });
  const fields = ['status', 'disputes', 'paralegalAccessRevokedAt', 'terminationDisputeId', 'terminationStatus', 'totalAmount', 'escrowIntentId', 'escrowStatus'];
  const select = value => Object.fromEntries(fields.map(name => [name, value[name]]));
  expect({ status: response.status, matter: select(after), notices: await Notification.countDocuments({ type: 'dispute_opened' }), audits: await AuditLog.countDocuments({ action: 'case.terminate' }), queued: await Notice.countDocuments() }).toEqual({ status: 503, matter: select(before), notices: 0, audits: 0, queued: 0 });
});
test('termination review retains only its affected paralegal notice and defers email', async () => {
  const fixture = await seed(); await User.create({ firstName: 'Synthetic', lastName: 'Administrator', email: 'admin@termination-review.test', password: 'Synthetic123!', role: 'admin', status: 'approved' });
  const response = await terminate(fixture); expect(response.status).toBe(202);
  const notices = await Notification.find({ type: 'dispute_opened' }).lean(), queued = await Notice.find().lean();
  expect(notices).toHaveLength(1); expect(String(notices[0].userId)).toBe(String(fixture.para._id));
  expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ kind: 'opened', userRole: 'paralegal', status: 'pending', attempts: 0 });
  expect(String(queued[0].userId)).toBe(String(fixture.para._id)); expect(require('../utils/email')).not.toHaveBeenCalled();
});
test('termination review notice reaches retained review status without restoring workspace access', async () => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  const notes = await request(app).get('/api/notifications/').set('Cookie', cookie(fixture.para)); expect(notes.status).toBe(200);
  const item = notes.body.find(row => row.type === 'dispute_opened');
  expect(item.action.href).toBe(`/dashboard-paralegal.html?highlightCase=${fixture.matter._id}#cases-completed`);
  const history = await request(app).get('/api/cases/my-completed').query({ expectedOwnerId: String(fixture.para._id), reviewContexts: '1' }).set('Cookie', cookie(fixture.para));
  expect(history.status).toBe(200); expect(history.body.items.find(row => row.caseId === String(fixture.matter._id))).toMatchObject({ reviewState: 'open', receiptAvailable: false, paymentAmount: null });
  const workspace = await request(app).get(`/api/cases/${fixture.matter._id}`).set('Cookie', cookie(fixture.para)); expect(workspace.status).toBe(404);
});

const reviewNotices = require('../services/matterReviewNotifications');
const mongoose = require('mongoose');
test('concurrent termination requests retain one linked review, audit and recipient obligation', async () => {
  const fixture = await seed(), results = await Promise.all([terminate(fixture), terminate(fixture)]);
  expect(results.map(value => value.status)).toEqual([202, 202]);
  expect(results.filter(value => value.body.alreadyRequested)).toHaveLength(1);
  const matter = await Case.findById(fixture.matter._id).lean();
  expect(matter.disputes).toHaveLength(1); expect(matter.terminationDisputeId).toBe(matter.disputes[0].disputeId);
  expect(matter.terminationReason).toBe(reason); expect(matter.disputes[0].message).toBe(`Attorney requested termination: ${reason}`);
  expect(matter.totalAmount).toBe(70000); expect(matter.escrowStatus).toBe('funded'); expect(matter.escrowIntentId).toBe('pi_synthetic_termination');
  expect(await Notification.countDocuments({ type: 'dispute_opened' })).toBe(1); expect(await Notice.countDocuments({ reviewContext: 'termination' })).toBe(1); expect(await AuditLog.countDocuments({ action: 'case.terminate' })).toBe(1);
});
test.each([
  [{ email: false }, 1, 0], [{ inApp: false }, 0, 1], [{ email: false, inApp: false }, 0, 0], [{ emailCase: false, inAppCase: false }, 1, 1],
])('termination preserves participant preferences %j', async (prefs, inApp, emails) => {
  const fixture = await seed(); await User.updateOne({ _id: fixture.para._id }, { $set: Object.fromEntries(Object.entries(prefs).map(([key, value]) => [`notificationPrefs.${key}`, value])) });
  expect((await terminate(fixture)).status).toBe(202);
  expect(await Notification.countDocuments()).toBe(inApp); expect(await Notice.countDocuments()).toBe(emails); expect(require('../utils/email')).not.toHaveBeenCalled();
});
test('a missing delivery index prevents the request without revoking access', async () => {
  const fixture = await seed(); jest.spyOn(Notice.collection, 'indexes').mockResolvedValue([]);
  expect((await terminate(fixture)).status).toBe(503);
  expect((await Case.findById(fixture.matter._id)).paralegalAccessRevokedAt).toBeNull(); expect(await AuditLog.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});
test('an actor disabled after the initial read cannot open the termination review', async () => {
  const fixture = await seed(), ready = reviewNotices.ready.bind(reviewNotices);
  jest.spyOn(reviewNotices, 'ready').mockImplementationOnce(async () => { await ready(); await User.updateOne({ _id: fixture.attorney._id }, { $set: { disabled: true } }); });
  expect((await terminate(fixture)).status).toBe(403);
  expect((await Case.findById(fixture.matter._id)).status).toBe('in progress'); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
});
test('a changed assignment after review preparation receives no stale termination request', async () => {
  const fixture = await seed(), ready = reviewNotices.ready.bind(reviewNotices), next = new mongoose.Types.ObjectId();
  jest.spyOn(reviewNotices, 'ready').mockImplementationOnce(async () => { await ready(); await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { paralegal: next, paralegalId: next } }); });
  expect((await terminate(fixture)).status).toBe(409);
  const matter = await Case.findById(fixture.matter._id).lean(); expect(matter.status).toBe('in progress'); expect(String(matter.paralegal)).toBe(String(next)); expect(matter.disputes).toEqual([]); expect(await Notice.countDocuments()).toBe(0);
});
test('deferred termination email uses current identity and title without private request details', async () => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { title: 'Current <b>River Street</b> scope' } });
  await User.updateOne({ _id: fixture.para._id }, { $set: { email: 'current@termination-review.test' } });
  const sendEmail = require('../utils/email'); sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  await reviewNotices.processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
  const [to, subject, html] = sendEmail.mock.calls[0]; expect(to).toBe('current@termination-review.test'); expect(subject).toContain('Current'); expect(html).toContain('Current &lt;b&gt;River Street&lt;/b&gt; scope'); expect(html).not.toContain('Retain both paragraphs'); expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain(`/dashboard-paralegal.html?highlightCase=${fixture.matter._id}#cases-completed`); expect(await Notice.countDocuments({ status: 'accepted' })).toBe(1);
  await reviewNotices.processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each(['resolved', 'request_replaced', 'request_date_changed', 'access_restored', 'revocation_changed', 'second_open_review', 'reassigned', 'disabled', 'role_changed', 'email_disabled'])('%s suppresses a stale termination email', async state => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  const notice = await Notice.findOne().lean(), next = new mongoose.Types.ObjectId(), changes = {
    resolved: { 'disputes.0.status': 'resolved' }, request_replaced: { terminationDisputeId: String(next) }, request_date_changed: { terminationRequestedAt: new Date(notice.terminationRequestedAt.getTime() + 1) }, access_restored: { paralegalAccessRevokedAt: null }, revocation_changed: { paralegalAccessRevokedAt: new Date(notice.accessRevokedAt.getTime() + 1) }, reassigned: { paralegal: next, paralegalId: next },
  };
  if (changes[state]) await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: changes[state] });
  if (state === 'second_open_review') await Case.collection.updateOne({ _id: fixture.matter._id }, { $push: { disputes: { disputeId: String(next), status: 'open', createdAt: new Date() } } });
  const userChanges = { disabled: { disabled: true }, role_changed: { role: 'attorney' }, email_disabled: { 'notificationPrefs.email': false } };
  if (userChanges[state]) await User.collection.updateOne({ _id: fixture.para._id }, { $set: userChanges[state] });
  await reviewNotices.processNotices(); expect(require('../utils/email')).not.toHaveBeenCalled(); expect((await Notice.findById(notice._id)).status).toBe('skipped');
});

test('only the affected paralegal receives the pending termination History record', async () => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  const other = await User.create({ firstName: 'Other', lastName: 'Paralegal', email: 'other@termination-review.test', password: 'Synthetic123!', role: 'paralegal', status: 'approved' });
  const history = user => request(app).get('/api/cases/my-completed').query({ expectedOwnerId: String(user._id), reviewContexts: '1' }).set('Cookie', cookie(user));
  expect((await history(other)).body.items).toEqual([]);
  const response = await history(fixture.para); expect(response.status).toBe(200); expect(response.body.items[0]).toMatchObject({ workState: 'needs_review', reviewState: 'open', reviewKind: 'termination', completedAt: null, isWithdrawn: false, canDispute: false, paymentAmount: null, receiptAvailable: false, payoutState: 'unconfirmed' });
  expect(JSON.stringify(response.body)).not.toContain('Retain both paragraphs'); expect(JSON.stringify(response.body)).not.toContain('terminationReason');
});
test('a recorded termination decision clears open-review wording without inventing a payout', async () => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { status: 'closed', terminationStatus: 'resolved', 'disputes.0.status': 'resolved' } });
  const response = await request(app).get('/api/cases/my-completed').query({ expectedOwnerId: String(fixture.para._id), reviewContexts: '1' }).set('Cookie', cookie(fixture.para));
  expect(response.status).toBe(200); expect(response.body.items[0]).toMatchObject({ workState: 'closed', reviewState: null, reviewKind: null, receiptAvailable: false, paymentAmount: null });
});
test('an unlinked pending termination record is unavailable rather than an invented review', async () => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { terminationDisputeId: String(new mongoose.Types.ObjectId()) } });
  const response = await request(app).get('/api/cases/my-completed').set('Cookie', cookie(fixture.para));
  expect(response.status).toBe(409); expect(response.body.items).toBeUndefined();
});


test('cached History clients do not mislabel termination as withdrawal and cannot mix page formats', async () => {
  const fixture = await seed(); expect((await terminate(fixture)).status).toBe(202);
  const history = query => request(app).get('/api/cases/my-completed').query(query).set('Cookie', cookie(fixture.para));
  const earlier = await history({}), current = await history({ reviewContexts: '1' });
  expect(earlier.status).toBe(200); expect(current.status).toBe(200);
  expect(earlier.body.items[0]).toMatchObject({ reviewState: null, reviewKind: null, workState: 'needs_review', receiptAvailable: false });
  expect(current.body.items[0]).toMatchObject({ reviewState: 'open', reviewKind: 'termination' });
  expect(current.body.revision).not.toBe(earlier.body.revision);
  expect((await history({ reviewContexts: 'unknown' })).status).toBe(400);
});


test.each(['attorney', 'admin'])('%s token revoked after the initial access check cannot open a termination review', async role => {
  const fixture = await seed();
  if (role === 'admin') fixture.attorney = await User.create({ firstName: 'Synthetic', lastName: 'Administrator', email: 'actor-admin@termination-review.test', password: 'Synthetic123!', role, status: 'approved' });
  const ready = reviewNotices.ready.bind(reviewNotices);
  jest.spyOn(reviewNotices, 'ready').mockImplementationOnce(async () => { await ready(); await User.updateOne({ _id: fixture.attorney._id }, { $inc: { authVersion: 1 } }); });
  expect((await terminate(fixture)).status).toBe(403);
  expect((await Case.findById(fixture.matter._id)).status).toBe('in progress'); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
});
test('an administrator termination request retains the real actor and only the affected recipient', async () => {
  const fixture = await seed(), admin = await User.create({ firstName: 'Synthetic', lastName: 'Administrator', email: 'request-admin@termination-review.test', password: 'Synthetic123!', role: 'admin', status: 'approved' });
  expect((await terminate({ ...fixture, attorney: admin })).status).toBe(202);
  const matter = await Case.findById(fixture.matter._id).lean(); expect(String(matter.terminationRequestedBy)).toBe(String(admin._id)); expect(matter.disputes[0].message).toBe(`Administrator requested termination: ${reason}`);
  const audit = await AuditLog.findOne({ action: 'case.terminate' }).lean(); expect(String(audit.actor)).toBe(String(admin._id)); expect(audit.actorRole).toBe('admin');
  const notice = await Notice.findOne().lean(); expect(String(notice.userId)).toBe(String(fixture.para._id)); expect(await Notification.countDocuments()).toBe(1); expect(await Notice.countDocuments()).toBe(1);
});
