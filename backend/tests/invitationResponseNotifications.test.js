jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
jest.mock('../utils/stripe', () => ({}));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken'), mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Notification = require('../models/Notification');
const app = express(); app.use(cookieParser(), express.json());
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode === 401) console.info('INVITATION_RESPONSE_AUTH_FAILURE', {
      method: req.method, path: req.originalUrl,
      cookieHeaderPresent: Boolean(req.headers.cookie), parsedTokenPresent: Boolean(req.cookies?.token),
      actorResolved: Boolean(req.user?.id), verifiedPayloadPresent: Boolean(req.auth?.payload),
    });
  });
  next();
});
app.use('/api/cases', require('../routes/cases'));
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode }));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); }); afterEach(() => jest.restoreAllMocks());
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
async function seed() {
  const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@invitation-response.test`, password: 'Synthetic123!', role, status: 'approved', ...(role === 'paralegal' ? { stripeAccountId: 'acct_invitation_response', stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  const at = new Date();
  const matter = await Case.create({ title: 'River Street invitation response', details: 'Prepare filing evidence for review.', practiceArea: 'immigration', attorney: attorney._id, attorneyId: attorney._id, status: 'open', totalAmount: 60000, lockedTotalAmount: 60000, amountLockedAt: at, pendingParalegalId: para._id, pendingParalegalInvitedAt: at, invites: [{ paralegalId: para._id, status: 'pending', invitedAt: at, syncStatus: 'synced' }], tasks: [{ title: 'Review filing', completed: false }] });
  const job = await Job.create({ title: matter.title, description: matter.details, practiceArea: matter.practiceArea, status: 'open', attorneyId: attorney._id, caseId: matter._id, budget: 600 });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
  return { attorney, para, matter, job };
}
const respond = (fixture, entry, decision) => request(app).post(`/api/cases/${fixture.matter._id}/${entry === 'combined' ? 'respond-invite' : `invite/${decision}`}`).set('Cookie', cookie(fixture.para)).send(entry === 'combined' ? { decision } : {});
const queue = () => mongoose.connection.db.collection('matterinvitationnotifications');
const cases = [['combined','accept'],['combined','decline'],['dedicated','accept'],['dedicated','decline'],['dedicated','revoke']];
const Notice = require('../models/MatterInvitationNotification'), delivery = require('../services/matterInvitationNotifications');
for (const [entry, decision] of cases) {
  async function ready() {
    const fixture = await seed();
    if (decision === 'revoke') {
      expect((await respond(fixture, 'dedicated', 'accept')).status).toBe(200);
      await Notification.deleteMany({}); await queue().deleteMany({}); require('../utils/email').mockClear();
    }
    return fixture;
  }
  test(`${entry} ${decision} cannot succeed after losing an original recipient notice`, async () => {
    const fixture = await ready(), before = await Case.collection.findOne({ _id: fixture.matter._id }), create = Notification.create.bind(Notification); let injected = false;
    jest.spyOn(Notification, 'create').mockImplementation(async (...args) => { const record = Array.isArray(args[0]) ? args[0][0] : args[0]; if (!injected && record.type === 'case_invite_response') { injected = true; throw Error('Synthetic invitation response notice unavailable'); } return create(...args); });
    const response = await respond(fixture, entry, decision), saved = await Case.collection.findOne({ _id: fixture.matter._id });
    console.info('INVITATION_RESPONSE_NOTICE_BASELINE', { entry, decision, status: response.status, before: before.invites[0].status, after: saved.invites[0].status, notices: await Notification.countDocuments(), queued: await queue().countDocuments({}) });
    expect(injected).toBe(true); expect(response.status).toBe(503); expect(saved.invites).toEqual(before.invites); expect(await Notification.countDocuments()).toBe(0); expect(await queue().countDocuments({})).toBe(0);
  });
  test(`${entry} ${decision} retains each original recipient email before sending`, async () => {
    const fixture = await ready(), response = await respond(fixture, entry, decision), expected = decision === 'accept' ? 1 : 2;
    const observations = { status: response.status, notices: await Notification.countDocuments({ type: 'case_invite_response' }), queued: await queue().countDocuments({}), emails: require('../utils/email').mock.calls.length };
    console.info('INVITATION_RESPONSE_EMAIL_BASELINE', { entry, decision, ...observations }); expect(observations).toEqual({ status: 200, notices: expected, queued: expected, emails: 0 });
    expect((await Case.findById(fixture.matter._id)).paralegalId).toBeFalsy();
  });
  test.each(['queue', 'indexes'])(`${entry} ${decision} rolls back every response write when %s fails`, async failure => {
    const fixture = await ready(), before = await Case.collection.findOne({ _id: fixture.matter._id });
    const applications = await require('../models/Application').find().lean();
    if (failure === 'queue') jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic response queue failure'));
    else jest.spyOn(Notice.collection, 'indexes').mockResolvedValueOnce([]);
    const response = await respond(fixture, entry, decision);
    expect(response.status).toBe(503); expect(response.body.code).toBe('INVITATION_RESPONSE_NOTICE_UNAVAILABLE');
    expect(await Case.collection.findOne({ _id: fixture.matter._id })).toEqual(before);
    expect(await require('../models/Application').find().lean()).toEqual(applications);
    expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
    expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${entry} ${decision} retries an uncertain committed response without repeating its notices`, async () => {
    const fixture = await ready(), start = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      const session = await start(...args), commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => { await commit(); throw Object.assign(Error('Synthetic unknown commit'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); }; return session;
    });
    expect((await respond(fixture, entry, decision)).status).toBe(503);
    const original = await Notice.find().lean(), notifications = await Notification.find().lean();
    expect(original).toHaveLength(decision === 'accept' ? 1 : 2);
    expect((await delivery.processNotices())).toBe(original.length); expect(require('../utils/email')).not.toHaveBeenCalled();
    expect(await Notice.countDocuments({ status: 'failed' })).toBe(original.length);
    const retried = await respond(fixture, entry, decision); expect(retried.status).toBe(200); expect(retried.body.reconciliationPending).toBe(false);
    expect(await Notice.countDocuments()).toBe(original.length); expect(await Notification.find().lean()).toEqual(notifications);
    await Notice.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    expect(await delivery.processNotices()).toBe(original.length); expect(await delivery.processNotices()).toBe(0);
    expect(await Notice.countDocuments({ status: 'accepted' })).toBe(original.length);
    expect(require('../utils/email')).toHaveBeenCalledTimes(original.length);
  });
  test(`${entry} ${decision} sends current recipient-specific text and retains the original actor`, async () => {
    const fixture = await ready(), response = await respond(fixture, entry, decision); expect({ status: response.status, body: response.body }).toMatchObject({ status: 200 });
    expect((await Notification.find({ type: 'case_invite_response' }).lean()).every(item => item.payload.paralegalName === 'Synthetic paralegal')).toBe(true);
    await Case.updateOne({ _id: fixture.matter._id }, { $set: { title: 'Current <filing> & evidence' } });
    await User.updateOne({ _id: fixture.attorney._id }, { $set: { email: 'current-owner@invitation-response.test' } });
    expect(await delivery.processNotices()).toBe(decision === 'accept' ? 1 : 2);
    const sent = require('../utils/email').mock.calls, owner = sent.find(([to]) => to === 'current-owner@invitation-response.test');
    expect(owner[2]).toContain('Current &lt;filing&gt; &amp; evidence');
    expect(owner[2]).toContain(decision === 'revoke' ? 'withdrew from consideration' : decision === 'accept' ? 'accepted your invitation' : 'declined your invitation');
    expect(owner[2]).toContain(String(fixture.matter._id));
    if (decision === 'accept') expect(owner[2]).toContain(String(fixture.para._id));
    else {
      const self = sent.find(([to]) => to === fixture.para.email);
      expect(self[2]).toContain(decision === 'revoke' ? 'You withdrew from consideration' : 'You declined the invitation');
      expect(self[2]).not.toContain('declined your invitation'); expect(self[2]).toContain('/browse-jobs.html');
    }
    expect((await Notice.find().lean()).every(item => String(item.actorUserId) === String(fixture.para._id))).toBe(true);
  });
}

test.each(['accept', 'decline'])('an administrator %s response keeps its actual actor and unknown historical invitation date', async decision => {
  const fixture = await seed(), admin = await User.create({ firstName: 'Morgan', lastName: 'Admin', email: 'admin@invitation-response.test', password: 'Synthetic123!', role: 'admin', status: 'approved' });
  await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { invites: [], pendingParalegalInvitedAt: null } });
  expect((await request(app).post(`/api/cases/${fixture.matter._id}/respond-invite`).set('Cookie', cookie(admin)).send({ decision, paralegalId: String(fixture.para._id) })).status).toBe(200);
  const saved = await Case.findById(fixture.matter._id); expect(saved.invites[0].invitedAt).toBeNull();
  expect((await Notice.find().lean()).every(item => String(item.actorUserId) === String(admin._id))).toBe(true);
  expect((await Notification.find().lean()).every(item => String(item.actorUserId) === String(admin._id))).toBe(true);
  expect(await delivery.processNotices()).toBe(decision === 'accept' ? 1 : 2);
  expect(require('../utils/email').mock.calls.every(([, , html]) => html.includes('LPC administrator Morgan Admin recorded'))).toBe(true);
});

test.each(['email', 'emailCase', 'inApp', 'inAppCase'])('response recipients independently control the %s preference', async preference => {
  const fixture = await seed(); await User.updateOne({ _id: fixture.attorney._id }, { $set: { [`notificationPrefs.${preference}`]: false } });
  expect((await respond(fixture, 'dedicated', 'decline')).status).toBe(200);
  expect(await Notice.countDocuments({ userId: fixture.attorney._id })).toBe(preference.startsWith('email') ? 0 : 1);
  expect(await Notification.countDocuments({ userId: fixture.attorney._id })).toBe(preference.startsWith('inApp') ? 0 : 1);
  expect(await Notice.countDocuments({ userId: fixture.para._id })).toBe(1);
  expect(await Notification.countDocuments({ userId: fixture.para._id })).toBe(1); expect(require('../utils/email')).not.toHaveBeenCalled();
});

test.each(['reinvited', 'owner_changed', 'owner_disabled', 'invitee_disabled', 'blocked', 'email_disabled', 'assigned', 'closed', 'purged', 'duplicate'])('%s suppresses a queued invitation response before delivery', async change => {
  const fixture = await seed(); expect((await respond(fixture, 'dedicated', 'decline')).status).toBe(200);
  if (change === 'reinvited') await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'invites.0.status': 'pending', 'invites.0.invitedAt': new Date(Date.now() + 1000), 'invites.0.respondedAt': null } });
  if (change === 'owner_changed') { const owner = new mongoose.Types.ObjectId(); await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { attorney: owner, attorneyId: owner } }); }
  if (change === 'owner_disabled' || change === 'invitee_disabled') await User.updateOne({ _id: change === 'owner_disabled' ? fixture.attorney._id : fixture.para._id }, { $set: { disabled: true } });
  if (change === 'blocked') await require('../models/Block').create({ blockerId: fixture.para._id, blockedId: fixture.attorney._id, active: true });
  if (change === 'email_disabled') await User.updateMany({}, { $set: { 'notificationPrefs.emailCase': false } });
  if (change === 'assigned') await Case.updateOne({ _id: fixture.matter._id }, { $set: { paralegalId: fixture.para._id } });
  if (change === 'closed') await Case.updateOne({ _id: fixture.matter._id }, { $set: { status: 'closed' } });
  if (change === 'purged') await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: { purgedAt: new Date() } });
  if (change === 'duplicate') { const saved = await Case.findById(fixture.matter._id).lean(); await Case.collection.updateOne({ _id: fixture.matter._id }, { $push: { invites: saved.invites[0] } }); }
  expect(await delivery.processNotices()).toBe(2); expect(await Notice.countDocuments({ status: 'skipped' })).toBe(2); expect(require('../utils/email')).not.toHaveBeenCalled();
});

test('revocation supersedes its earlier undelivered acceptance without backfilling on replay', async () => {
  const fixture = await seed(); expect((await respond(fixture, 'combined', 'accept')).status).toBe(200);
  const accepted = await Notice.findOne();
  expect((await respond(fixture, 'dedicated', 'revoke')).status).toBe(200);
  expect((await respond(fixture, 'dedicated', 'revoke')).status).toBe(200);
  expect(await Notice.countDocuments()).toBe(3);
  expect(await delivery.processNotices()).toBe(3); expect((await Notice.findById(accepted._id)).status).toBe('skipped');
  expect(require('../utils/email')).toHaveBeenCalledTimes(2);
  await Notice.deleteMany({}); await Notification.deleteMany({});
  expect((await respond(fixture, 'dedicated', 'revoke')).status).toBe(200); expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});
