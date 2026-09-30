jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
jest.mock('../utils/stripe', () => ({}));
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken'), mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.S3_BUCKET = 'synthetic-pre-engagement-notices';
const mockS3Send = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-s3', () => ({ ...jest.requireActual('@aws-sdk/client-s3'), S3Client: jest.fn(() => ({ send: mockS3Send })) }));
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const User = require('../models/User'), Case = require('../models/Case'), Notification = require('../models/Notification');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/cases', require('../routes/cases'));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); require('../utils/email').mockClear(); mockS3Send.mockClear(); }); afterEach(() => jest.restoreAllMocks());
async function seed(kind) {
  const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@pre-engagement-notice.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const matter = await Case.create({ title: 'River Street pre-engagement', details: 'Prepare the filing package after review.', attorney: attorney._id, attorneyId: attorney._id, status: 'open', totalAmount: 60000, tasks: [{ title: 'Prepare filing package' }], applicants: [{ paralegalId: para._id, status: 'pending' }], preEngagement: { revision: 2, status: kind === 'changes_requested' ? 'submitted' : 'requested', requestedParalegalId: para._id, requestedBy: attorney._id, requestedAt: new Date(), confidentialityAgreementRequired: false, conflictsCheckRequired: true, conflictsDetails: 'Check the listed parties and witnesses.', ...(kind === 'changes_requested' ? { conflictsResponseType: 'none_known', submittedBy: para._id, submittedAt: new Date() } : {}) } });
  return { attorney, para, matter };
}
async function act(fixture, kind, strict) {
  const { attorney, para, matter } = fixture;
  if (kind === 'submitted') return request(app).post(`/api/cases/${matter._id}/pre-engagement/respond`).set('Cookie', cookie(para)).send({ conflictsResponseType: 'none_known', ...(strict ? { expectedPreEngagementRevision: 2 } : {}) });
  let review = {};
  if (strict) {
    const response = await request(app).get(`/api/cases/${matter._id}/pre-engagement/review/${para._id}?expectedOwnerId=${attorney._id}`).set('Cookie', cookie(attorney));
    expect(response.status).toBe(200); expect(response.body[kind === 'requested' ? 'canRequest' : 'canReview']).toBe(true);
    review = { expectedOwnerId: String(attorney._id), reviewedRevision: response.body.revision, applicantId: String(para._id) };
  }
  const path = kind === 'requested' ? `${para._id}/request` : 'review';
  return request(app).post(`/api/cases/${matter._id}/pre-engagement/${path}`).set('Cookie', cookie(attorney)).send({ ...review, ...(kind === 'requested' ? { conflictsCheckRequired: true, conflictsDetails: 'Check the parties before this engagement proceeds.' } : { action: 'request_changes' }) });
}
const queue = () => mongoose.connection.db.collection('matterpreengagementnotifications');
for (const kind of ['requested', 'submitted', 'changes_requested']) for (const strict of [false, true]) {
  test(`${strict ? 'reviewed' : 'compatible'} ${kind} rolls back if its original recipient notice cannot be retained`, async () => {
    const fixture = await seed(kind), before = await Case.collection.findOne({ _id: fixture.matter._id });
    const create = Notification.create.bind(Notification); let injected = false;
    jest.spyOn(Notification, 'create').mockImplementation(async (...args) => {
      const record = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (!injected && record.type === `pre_engagement_${kind}`) { injected = true; throw Error('Synthetic pre-engagement notice unavailable'); }
      return create(...args);
    });
    const response = await act(fixture, kind, strict), after = await Case.collection.findOne({ _id: fixture.matter._id });
    console.info('PRE_ENGAGEMENT_NOTICE_BASELINE', { kind, strict, injected, status: response.status, before: before.preEngagement.revision, after: after.preEngagement.revision, notices: await Notification.countDocuments(), queued: await queue().countDocuments({}) });
    expect(injected).toBe(true); expect(response.status).toBe(503); expect(after).toEqual(before);
    expect(await Notification.countDocuments()).toBe(0); expect(await queue().countDocuments({})).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${strict ? 'reviewed' : 'compatible'} ${kind} retains the original recipient email before sending`, async () => {
    const fixture = await seed(kind), response = await act(fixture, kind, strict);
    const observation = { status: response.status, notices: await Notification.countDocuments({ type: `pre_engagement_${kind}` }), queued: await queue().countDocuments({}), emails: require('../utils/email').mock.calls.length };
    console.info('PRE_ENGAGEMENT_EMAIL_BASELINE', { kind, strict, ...observation });
    expect(observation).toEqual({ status: 200, notices: 1, queued: 1, emails: 0 });
    const notice = await Notification.findOne(); expect(String(notice.userId)).toBe(String(kind === 'submitted' ? fixture.attorney._id : fixture.para._id));
    const saved = await Case.findById(fixture.matter._id); expect(saved.paralegalId).toBeFalsy(); expect(saved.paymentReleased).toBe(false);
  });
}

const Notice = require('../models/MatterPreEngagementNotification'), delivery = require('../services/matterPreEngagementNotifications');
for (const kind of ['requested', 'submitted', 'changes_requested']) {
  test.each(['queue', 'indexes'])(`${kind} rolls back the saved change and in-app notice when %s is unavailable`, async failure => {
    const fixture = await seed(kind), before = await Case.collection.findOne({ _id: fixture.matter._id });
    if (failure === 'queue') jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic queue failure'));
    else jest.spyOn(Notice.collection, 'indexes').mockResolvedValueOnce([]);
    const response = await act(fixture, kind, true);
    expect(response.status).toBe(503); expect(response.body.code).toBe('PRE_ENGAGEMENT_NOTICE_UNAVAILABLE');
    expect(await Case.collection.findOne({ _id: fixture.matter._id })).toEqual(before);
    expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
  test(`${kind} delivers once to its current original recipient without disclosing confidential fields`, async () => {
    const fixture = await seed(kind); expect((await act(fixture, kind, true)).status).toBe(200);
    const recipient = kind === 'submitted' ? fixture.attorney : fixture.para;
    await User.updateOne({ _id: recipient._id }, { $set: { email: 'current@pre-engagement.test' } });
    await Case.updateOne({ _id: fixture.matter._id }, { $set: { title: 'Current <filing> & evidence' } });
    expect(await delivery.processNotices()).toBe(1); expect(await delivery.processNotices()).toBe(0);
    expect(await Notice.countDocuments({ status: 'accepted' })).toBe(1);
    const sent = require('../utils/email').mock.calls; expect(sent).toHaveLength(1); expect(sent[0][0]).toBe('current@pre-engagement.test');
    expect(sent[0][2]).toContain('Current &lt;filing&gt; &amp; evidence'); expect(sent[0][2]).not.toContain('Check the parties'); expect(sent[0][2]).not.toContain('witnesses');
    expect(JSON.stringify(await Notice.findOne().lean())).not.toContain('Check the parties');
  });
  test.each(['email', 'emailCase', 'inApp', 'inAppCase'])(`${kind} respects the recipient's %s preference`, async preference => {
    const fixture = await seed(kind), recipient = kind === 'submitted' ? fixture.attorney : fixture.para;
    await User.updateOne({ _id: recipient._id }, { $set: { [`notificationPrefs.${preference}`]: false } });
    expect((await act(fixture, kind, true)).status).toBe(200);
    expect(await Notice.countDocuments()).toBe(preference.startsWith('email') ? 0 : 1);
    expect(await Notification.countDocuments()).toBe(preference.startsWith('inApp') ? 0 : 1); expect(require('../utils/email')).not.toHaveBeenCalled();
  });
}
test.each(['revision', 'owner_changed', 'owner_conflict', 'owner_disabled', 'paralegal_disabled', 'blocked', 'email_disabled', 'assigned', 'closed', 'purged', 'application_rejected'])('%s suppresses an obsolete queued pre-engagement notice', async change => {
  const fixture = await seed('requested'); expect((await act(fixture, 'requested', true)).status).toBe(200);
  let update;
  if (change === 'revision') update = { 'preEngagement.revision': 4 };
  if (change === 'owner_changed') { const owner = new mongoose.Types.ObjectId(); update = { attorney: owner, attorneyId: owner }; }
  if (change === 'owner_conflict') update = { attorneyId: new mongoose.Types.ObjectId() };
  if (change.endsWith('_disabled') && change !== 'email_disabled') await User.updateOne({ _id: change === 'owner_disabled' ? fixture.attorney._id : fixture.para._id }, { $set: { disabled: true } });
  if (change === 'blocked') await require('../models/Block').create({ blockerId: fixture.para._id, blockedId: fixture.attorney._id, active: true });
  if (change === 'email_disabled') await User.updateOne({ _id: fixture.para._id }, { $set: { 'notificationPrefs.emailCase': false } });
  if (change === 'assigned') update = { paralegalId: fixture.para._id };
  if (change === 'closed') update = { status: 'closed' };
  if (change === 'purged') update = { purgedAt: new Date() };
  if (change === 'application_rejected') update = { 'applicants.0.status': 'rejected' };
  if (update) await Case.collection.updateOne({ _id: fixture.matter._id }, { $set: update });
  expect(await delivery.processNotices()).toBe(1); expect(await Notice.countDocuments({ status: 'skipped' })).toBe(1); expect(require('../utils/email')).not.toHaveBeenCalled();
});
test('a newer submission supersedes the unsent request, and changes supersede that submission', async () => {
  const fixture = await seed('requested'); expect((await act(fixture, 'requested', true)).status).toBe(200);
  expect((await act(fixture, 'submitted', false)).status).toBe(200);
  expect((await act(fixture, 'changes_requested', true)).status).toBe(200);
  expect(await Notice.countDocuments()).toBe(3); expect(await delivery.processNotices()).toBe(3);
  expect(await Notice.countDocuments({ status: 'skipped' })).toBe(2); expect(await Notice.countDocuments({ status: 'accepted', kind: 'changes_requested' })).toBe(1); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});
test('a worker restart retains unknown delivery and retries only a confirmed rejection', async () => {
  const fixture = await seed('requested'); expect((await act(fixture, 'requested', true)).status).toBe(200);
  require('../utils/email').mockRejectedValueOnce(Object.assign(Error('Rejected before delivery'), { responseCode: 550, command: 'RCPT TO' }));
  await delivery.processNotices(); expect((await Notice.findOne()).status).toBe('failed');
  await Notice.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  require('../utils/email').mockRejectedValueOnce(Error('Connection lost after DATA'));
  await delivery.processNotices(); expect((await Notice.findOne()).status).toBe('unknown');
  await delivery.processNotices(); expect(require('../utils/email')).toHaveBeenCalledTimes(2);
});
for (const kind of ['requested', 'submitted']) for (const outcome of ['rollback', 'unknown_commit']) test(`${kind} upload ${outcome} preserves retained documents and cleans only a confirmed failed new upload`, async () => {
  const fixture = await seed(kind), oldKey = `cases/${fixture.matter._id}/pre-engagement/original.pdf`, signedKey = `cases/${fixture.matter._id}/pre-engagement/original-signed.pdf`;
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'preEngagement.confidentialityAgreementRequired': true, 'preEngagement.confidentialityDocument': { key: oldKey, name: 'original.pdf', mimeType: 'application/pdf', size: 30 }, 'preEngagement.paralegalConfidentialityDocument': { key: signedKey, name: 'original-signed.pdf', mimeType: 'application/pdf', size: 30 } } });
  const before = await Case.collection.findOne({ _id: fixture.matter._id });
  if (outcome === 'rollback') jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic queue failure'));
  else {
    const start = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw Object.assign(Error('Unknown commit'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); }; return session; });
  }
  const response = await request(app).post(`/api/cases/${fixture.matter._id}/pre-engagement/${kind === 'submitted' ? 'respond' : `${fixture.para._id}/request`}`).set('Cookie', cookie(kind === 'submitted' ? fixture.para : fixture.attorney)).field(kind === 'submitted' ? 'confidentialityAcknowledged' : 'confidentialityAgreementRequired', 'true').field('conflictsResponseType', 'none_known').attach(kind === 'submitted' ? 'paralegalConfidentialityFile' : 'confidentialityFile', Buffer.from('%PDF-1.4\nSynthetic confidential agreement\n%%EOF'), { filename: 'replacement.pdf', contentType: 'application/pdf' });
  expect(response.status).toBe(503);
  const commands = mockS3Send.mock.calls.map(([command]) => command), upload = commands.find(command => command instanceof PutObjectCommand), deletes = commands.filter(command => command instanceof DeleteObjectCommand);
  expect(upload).toBeDefined(); expect(upload.input.Key).not.toBe(oldKey); expect(upload.input.Key).not.toBe(signedKey);
  if (outcome === 'rollback') { expect(await Case.collection.findOne({ _id: fixture.matter._id })).toEqual(before); expect(deletes).toHaveLength(1); expect(deletes[0].input.Key).toBe(upload.input.Key); expect(await Notice.countDocuments()).toBe(0); }
  else { expect(deletes).toHaveLength(0); expect(await Notice.countDocuments()).toBe(1); const saved = await Case.findById(fixture.matter._id); expect(saved.preEngagement[kind === 'submitted' ? 'paralegalConfidentialityDocument' : 'confidentialityDocument'].key).toBe(upload.input.Key); expect(await delivery.processNotices()).toBe(1); }
});
test('notice rollback does not delete a reused confidentiality document', async () => {
  const fixture = await seed('requested'), key = `cases/${fixture.matter._id}/pre-engagement/retained.pdf`;
  await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'preEngagement.confidentialityAgreementRequired': true, 'preEngagement.confidentialityDocument': { key, name: 'retained.pdf' } } });
  jest.spyOn(Notice, 'create').mockRejectedValueOnce(Error('Synthetic queue failure'));
  const response = await request(app).post(`/api/cases/${fixture.matter._id}/pre-engagement/${fixture.para._id}/request`).set('Cookie', cookie(fixture.attorney)).send({ confidentialityAgreementRequired: true });
  expect(response.status).toBe(503); expect(mockS3Send).not.toHaveBeenCalled(); expect((await Case.findById(fixture.matter._id)).preEngagement.confidentialityDocument.key).toBe(key);
});

test.each(['canonical', 'invitation'])('%s reconciliation delays pre-engagement email without discarding its obligation', async source => {
  const fixture = await seed('requested'); expect((await act(fixture, 'requested', true)).status).toBe(200);
  let application;
  if (source === 'canonical') {
    const job = await require('../models/Job').create({ title: fixture.matter.title, description: fixture.matter.details, practiceArea: 'contract law', attorneyId: fixture.attorney._id, caseId: fixture.matter._id, budget: 600, status: 'open' });
    await Case.updateOne({ _id: fixture.matter._id }, { $set: { jobId: job._id } });
    application = await require('../models/Application').create({ jobId: job._id, paralegalId: fixture.para._id, coverLetter: 'Synthetic application', syncStatus: 'pending' });
  } else await Case.updateOne({ _id: fixture.matter._id }, { $set: { invites: [{ paralegalId: fixture.para._id, status: 'accepted', invitedAt: new Date(), respondedAt: new Date(), syncStatus: 'pending' }] } });
  expect(await delivery.processNotices()).toBe(1); expect((await Notice.findOne()).status).toBe('failed'); expect(require('../utils/email')).not.toHaveBeenCalled();
  if (application) await require('../models/Application').updateOne({ _id: application._id }, { $set: { syncStatus: 'synced' } });
  else await Case.updateOne({ _id: fixture.matter._id }, { $set: { 'invites.0.syncStatus': 'synced' } });
  await Notice.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  expect(await delivery.processNotices()).toBe(1); expect((await Notice.findOne()).status).toBe('accepted'); expect(require('../utils/email')).toHaveBeenCalledTimes(1);
});
