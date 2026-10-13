jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
jest.mock('../utils/stripe', () => ({}));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken'), mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Notification = require('../models/Notification');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/cases', require('../routes/cases'));
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode }));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); }); afterEach(() => jest.restoreAllMocks());
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
async function seed() {
  const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@invitation-notice.test`, password: 'Synthetic123!', role, status: 'approved', ...(role === 'paralegal' ? { stripeAccountId: 'acct_invitation_notice', stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  const matter = await Case.create({ title: 'River Street invitation', details: 'Prepare filing evidence for review.', practiceArea: 'immigration', attorney: attorney._id, attorneyId: attorney._id, status: 'open', totalAmount: 60000, tasks: [{ title: 'Review filing', completed: false }] });
  const review = await request(app).get(`/api/cases/${matter._id}/invitation-review/${para._id}?expectedOwnerId=${attorney._id}`).set('Cookie', cookie(attorney)); expect(review.status).toBe(200); expect(review.body.canInvite).toBe(true);
  return { attorney, para, matter, review: review.body };
}
const send = (fixture, entry) => request(app).post(`/api/cases/${fixture.matter._id}/invite${entry === 'matter' ? `/${fixture.para._id}` : ''}`).set('Cookie', cookie(fixture.attorney)).send({ expectedOwnerId: String(fixture.attorney._id), reviewedRevision: fixture.review.revision, ...(entry === 'profile' ? { paralegalId: String(fixture.para._id) } : {}) });
const queued = () => mongoose.connection.db.collection('matterinvitationnotifications').countDocuments({});
const Notice = require('../models/MatterInvitationNotification'), delivery = require('../services/matterInvitationNotifications');
for (const entry of ['matter', 'profile']) {
  test(`${entry} uncertain commit retains one invitation and cannot duplicate its notice on replay`, async () => {
    const fixture = await seed(), start = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      const session = await start(...args), commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => { await commit(); throw Object.assign(Error('Synthetic unknown commit'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); }; return session;
    });
    const response = await send(fixture, entry); expect(response.status).toBe(503); expect(response.body.code).toBe('ACCOUNT_WRITE_UNCONFIRMED');
    expect((await Case.findById(fixture.matter._id)).invites).toHaveLength(1); expect(await Notification.countDocuments()).toBe(2); expect(await Notice.countDocuments()).toBe(1);
    expect([400, 409]).toContain((await send(fixture, entry)).status); expect(require('../utils/email')).not.toHaveBeenCalled();
    expect(await delivery.processNotices()).toBe(1); expect(await delivery.processNotices()).toBe(0); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
  });
  for (const type of ['case_budget_locked', 'case_invite']) test(`${entry} invitation cannot succeed without its ${type} notice`, async () => {
    const fixture = await seed(), create = Notification.create.bind(Notification); let injected = false;
    jest.spyOn(Notification, 'create').mockImplementation(async (...args) => { const record = Array.isArray(args[0]) ? args[0][0] : args[0]; if (!injected && record.type === type) { injected = true; throw Error('Synthetic invitation notice unavailable'); } return create(...args); });
    const response = await send(fixture, entry), saved = await Case.findById(fixture.matter._id).lean();
    const observation = { status: response.status, invites: saved.invites.length, lockedTotalAmount: saved.lockedTotalAmount, notices: await Notification.countDocuments(), queued: await queued(), injected };
    console.info('INVITATION_NOTICE_BASELINE', { entry, type, ...observation });
    expect(observation).toEqual({ status: 503, invites: 0, lockedTotalAmount: null, notices: 0, queued: 0, injected: true });
  });
  test(`${entry} invitation retains the original invitee email before sending`, async () => {
    const fixture = await seed(), response = await send(fixture, entry);
    const observation = { status: response.status, notices: await Notification.countDocuments(), queued: await queued(), emails: require('../utils/email').mock.calls.length };
    console.info('INVITATION_EMAIL_BASELINE', { entry, ...observation }); expect(observation).toEqual({ status: 200, notices: 2, queued: 1, emails: 0 });
  });
}

for (const entry of ['matter', 'profile']) {
  test.each(['queue', 'indexes'])(`${entry} rolls back the invitation, amount lock and notices when %s is unavailable`, async failure => {
    const fixture = await seed();
    if (failure === 'queue') jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic queue failure'));
    else jest.spyOn(Notice.collection, 'indexes').mockResolvedValueOnce([]);
    expect((await send(fixture, entry)).status).toBe(503);
    const saved = await Case.findById(fixture.matter._id).lean(); expect(saved.invites).toHaveLength(0); expect(saved.lockedTotalAmount).toBeNull();
    expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
    expect((await send(fixture, entry)).status).toBe(200); expect(await Notice.countDocuments()).toBe(1); expect(await Notification.countDocuments()).toBe(2);
  });
  test.each(['email', 'emailCase', 'inApp', 'inAppCase'])(`${entry} respects the invitee's disabled %s preference`, async preference => {
    const fixture = await seed(); await User.updateOne({ _id: fixture.para._id }, { $set: { [`notificationPrefs.${preference}`]: false } });
    expect((await send(fixture, entry)).status).toBe(200);
    expect(await Notice.countDocuments()).toBe(preference.startsWith('email') ? 0 : 1);
    expect(await Notification.countDocuments({ userId: fixture.para._id })).toBe(preference.startsWith('inApp') ? 0 : 1);
    expect(await Notification.countDocuments({ userId: fixture.attorney._id })).toBe(1);
    expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${entry} replay retains one original-recipient obligation and delivery reads current details`, async () => {
    const fixture = await seed(); expect((await send(fixture, entry)).status).toBe(200);
    expect([400, 409]).toContain((await send(fixture, entry)).status); expect(await Notice.countDocuments()).toBe(1); expect(await Notification.countDocuments()).toBe(2);
    await User.updateOne({ _id: fixture.para._id }, { $set: { email: 'current-invitee@invitation-notice.test' } });
    await User.updateOne({ _id: fixture.attorney._id }, { $set: { firstName: 'River', lastName: 'Quinn' } });
    await Case.updateOne({ _id: fixture.matter._id }, { $set: { title: 'Updated River Street filing' } });
    expect(await delivery.processNotices()).toBe(1); expect(await delivery.processNotices()).toBe(0);
    expect((await Notice.findOne()).status).toBe('accepted');
    const [to, subject, html] = require('../utils/email').mock.calls[0]; expect(to).toBe('current-invitee@invitation-notice.test'); expect(subject).toBe('Matter invitation on LPC');
    expect(html).toContain('River Quinn'); expect(html).toContain('Updated River Street filing'); expect(html).toContain(`inviteCase=${fixture.matter._id}#home`); expect(html).toContain('Accepting an invitation does not assign the Matter to you.');
  });
}

test.each(['accepted', 'declined', 'reinvited', 'owner_changed', 'owner_disabled', 'invitee_disabled', 'blocked', 'email_disabled', 'assigned', 'closed', 'payment_released', 'purged', 'duplicate'])('%s invitation is not delivered as a current invitation', async change => {
  const fixture = await seed(); expect((await send(fixture, 'matter')).status).toBe(200);
  if (['accepted', 'declined'].includes(change)) await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'invites.0.status': change, 'invites.0.respondedAt': new Date() } });
  if (change === 'reinvited') await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'invites.0.invitedAt': new Date(Date.now() + 5000) } });
  if (change === 'owner_changed') { const owner = new mongoose.Types.ObjectId(); await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { attorney: owner, attorneyId: owner } }); }
  if (change === 'owner_disabled' || change === 'invitee_disabled') await User.updateOne({ _id: change === 'owner_disabled' ? fixture.attorney._id : fixture.para._id }, { $set: { disabled: true } });
  if (change === 'blocked') await require('../models/Block').collection.insertOne({ blockerId: fixture.para._id, blockedId: fixture.attorney._id, active: true });
  if (change === 'email_disabled') await User.updateOne({ _id: fixture.para._id }, { $set: { 'notificationPrefs.emailCase': false } });
  if (change === 'assigned') await Case.updateOne({ _id: fixture.matter._id }, { $set: { paralegalId: fixture.para._id } });
  if (change === 'closed') await Case.updateOne({ _id: fixture.matter._id }, { $set: { status: 'closed' } });
  if (change === 'payment_released') await Case.updateOne({ _id: fixture.matter._id }, { $set: { paymentReleased: true } });
  if (change === 'purged') await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { purgedAt: new Date() } });
  if (change === 'duplicate') { const saved = await Case.collection.findOne({ _id: fixture.matter._id }); await Case.collection.updateOne({ _id: fixture.matter._id }, { $push: { invites: saved.invites[0] } }); }
  expect(await delivery.processNotices()).toBe(1); expect((await Notice.findOne()).status).toBe('skipped'); expect(require('../utils/email')).not.toHaveBeenCalled();
});

test('a new invitation supersedes the queued email for an earlier declined invitation', async () => {
  const fixture = await seed(); expect((await send(fixture, 'matter')).status).toBe(200);
  const previous = await Notice.findOne().lean();
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'invites.0.status': 'declined', 'invites.0.respondedAt': new Date() } });
  fixture.review = (await request(app).get(`/api/cases/${fixture.matter._id}/invitation-review/${fixture.para._id}?expectedOwnerId=${fixture.attorney._id}`).set('Cookie', cookie(fixture.attorney))).body;
  expect((await send(fixture, 'profile')).status).toBe(200); expect(await Notice.countDocuments()).toBe(2);
  expect(await Notification.countDocuments({ type: 'case_budget_locked' })).toBe(1);
  expect(await delivery.processNotices()).toBe(2); expect((await Notice.findById(previous._id)).status).toBe('skipped');
  expect(await Notice.countDocuments({ status: 'accepted' })).toBe(1); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});

test('an attorney may disable their in-app notices without preventing the invitee notice', async () => {
  const fixture = await seed(); await User.updateOne({ _id: fixture.attorney._id }, { $set: { 'notificationPrefs.inApp': false } });
  expect((await send(fixture, 'matter')).status).toBe(200); expect(await Notification.countDocuments({ userId: fixture.attorney._id })).toBe(0);
  expect(await Notification.countDocuments({ userId: fixture.para._id })).toBe(1); expect(await Notice.countDocuments()).toBe(1);
});

test('a missing deferred recipient cannot leave a saved invitation behind', async () => {
  const fixture = await seed(); jest.spyOn(require('../utils/notifyUser'), 'notifyUser').mockResolvedValueOnce(undefined);
  expect((await send(fixture, 'matter')).status).toBe(503); expect((await Case.findById(fixture.matter._id)).invites).toHaveLength(0);
  expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});
