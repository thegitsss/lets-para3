jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Notification = require('../models/Notification');
const sendEmail = require('../utils/email');
const { processAdminOverdueDisputes } = require('../services/withdrawalLifecycle');
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); });
async function fixture() {
 const [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@overdue-review.test`, password: 'Synthetic123!', role, status: 'approved' })));
 const now = new Date();
 const matter = await Case.create({ title: 'River Street review still open', details: 'Synthetic review deadline.', status: 'disputed', pausedReason: 'dispute', attorney: attorney._id, attorneyId: attorney._id, withdrawnParalegalId: para._id, paralegalAccessRevokedAt: new Date(now - 3600000), adminDisputeDeadlineAt: new Date(now - 60000), escrowIntentId: 'pi_synthetic_overdue', escrowStatus: 'funded', disputes: [{ status: 'open', message: 'PRIVATE_REVIEW_DETAILS', raisedBy: para._id }] });
 return { attorney, para, matter, now };
}
test('an overdue-review second-recipient failure rolls back both notices with its claimed reminder', async () => {
 const f = await fixture(), create = Notification.create.bind(Notification); let count = 0;
 jest.spyOn(Notification, 'create').mockImplementation((...args) => { if (++count === 2) throw Error('Synthetic second reminder write unavailable'); return create(...args); });
 expect(await processAdminOverdueDisputes({ now: f.now })).toEqual({ scanned: 1, notified: 0, failed: 1 });
 expect((await Case.findById(f.matter._id)).adminDisputeOverdueNotifiedAt).toBeNull();
 expect(await Notification.countDocuments({ type: 'admin_review_overdue' })).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
});
test('retrying a failed overdue-review reminder creates one notification per recipient', async () => {
 const f = await fixture(), create = Notification.create.bind(Notification); let count = 0;
 const fault = jest.spyOn(Notification, 'create').mockImplementation((...args) => { if (++count === 2) throw Error('Synthetic second reminder write unavailable'); return create(...args); });
 await processAdminOverdueDisputes({ now: f.now }); fault.mockRestore();
 expect(await processAdminOverdueDisputes({ now: f.now })).toEqual({ scanned: 1, notified: 1, failed: 0 });
 const notices = await Notification.find({ type: 'admin_review_overdue' }).lean(); expect(notices).toHaveLength(2);
 expect(notices.map(row => String(row.userId)).sort()).toEqual([String(f.attorney._id), String(f.para._id)].sort());
 expect(await processAdminOverdueDisputes({ now: f.now })).toEqual({ scanned: 0, notified: 0, failed: 0 });
});

// Append to the original atomicity probes only after the baseline is retained.
const mongoose = require('mongoose');
const ReviewNotice = require('../models/MatterReviewNotification');
const reviewNotices = require('../services/matterReviewNotifications');

test.each([1, 2])('an overdue email obligation failure at recipient %s rolls back the whole reminder', async failAt => {
  const f = await fixture(), create = ReviewNotice.create.bind(ReviewNotice); let count = 0;
  const fault = jest.spyOn(ReviewNotice, 'create').mockImplementation((...args) => { if (++count === failAt) throw Error('Synthetic reminder queue unavailable'); return create(...args); });
  expect(await processAdminOverdueDisputes({ now: f.now })).toEqual({ scanned: 1, notified: 0, failed: 1 });
  expect((await Case.findById(f.matter._id)).adminDisputeOverdueNotifiedAt).toBeNull();
  expect(await Notification.countDocuments()).toBe(0); expect(await ReviewNotice.countDocuments()).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
  fault.mockRestore(); expect((await processAdminOverdueDisputes({ now: f.now })).notified).toBe(1);
  expect(await ReviewNotice.countDocuments({ kind: 'overdue' })).toBe(2);
});
test('competing overdue workers retain exactly one reminder for each original recipient', async () => {
  const f = await fixture();
  const results = await Promise.all([processAdminOverdueDisputes({ now: f.now }), processAdminOverdueDisputes({ now: f.now })]);
  expect(results.reduce((sum, value) => sum + value.notified, 0)).toBe(1);
  expect(await Notification.countDocuments({ type: 'admin_review_overdue' })).toBe(2);
  expect(await ReviewNotice.countDocuments({ kind: 'overdue' })).toBe(2);
  expect((await Case.findById(f.matter._id)).adminDisputeOverdueNotifiedAt).toEqual(f.now);
  expect(sendEmail).not.toHaveBeenCalled();
});
test('mandatory overdue notices preserve disabled preference policy, current title and exact destinations', async () => {
  const f = await fixture();
  await User.updateMany({}, { $set: { 'notificationPrefs.email': false, 'notificationPrefs.inApp': false, 'notificationPrefs.emailCase': false, 'notificationPrefs.inAppCase': false } });
  expect((await processAdminOverdueDisputes({ now: f.now })).notified).toBe(1);
  expect(await Notification.countDocuments()).toBe(2); expect(await ReviewNotice.countDocuments()).toBe(2); expect(sendEmail).not.toHaveBeenCalled();
  await Case.updateOne({ _id: f.matter._id }, { $set: { title: 'Current <b>Matter</b> review' } });
  await User.updateOne({ _id: f.attorney._id }, { $set: { email: 'current@overdue-review.test' } });
  sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  await reviewNotices.processNotices(); expect(sendEmail).toHaveBeenCalledTimes(2);
  for (const [to, subject, html] of sendEmail.mock.calls) {
    expect(subject).toContain('Review still open: Current'); expect(html).toContain('Current &lt;b&gt;Matter&lt;/b&gt; review');
    expect(html).not.toMatch(/PRIVATE_REVIEW_DETAILS|will follow up|Thank you for your patience|receipt|bank/);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(to === 'current@overdue-review.test' ? `/case-detail.html?caseId=${f.matter._id}&amp;tab=financials` : `/dashboard-paralegal.html?highlightCase=${f.matter._id}#cases-completed`);
  }
  expect(await ReviewNotice.countDocuments({ status: 'accepted' })).toBe(2);
  await reviewNotices.processNotices(); expect(sendEmail).toHaveBeenCalledTimes(2);
});
test.each(['resolved', 'different_review', 'reopened_date', 'deadline_changed', 'claim_changed', 'purged', 'conflicting_owner', 'withdrawn_payee_changed', 'disabled', 'deleted', 'suspended', 'unapproved', 'role_changed'])('%s prevents a stale overdue email to the withdrawn paralegal', async state => {
  const f = await fixture(); await processAdminOverdueDisputes({ now: f.now });
  const row = await ReviewNotice.findOne({ userId: f.para._id });
  const matterChanges = {
    resolved: { status: 'paused', pausedReason: 'paralegal_withdrew', 'disputes.0.status': 'resolved' },
    different_review: { 'disputes.0.disputeId': 'another-review' }, reopened_date: { 'disputes.0.createdAt': new Date('2020-01-01') },
    deadline_changed: { adminDisputeDeadlineAt: new Date(Date.now() + 86400000) }, claim_changed: { adminDisputeOverdueNotifiedAt: new Date('2020-01-01') },
    purged: { purgedAt: new Date() }, conflicting_owner: { attorneyId: new mongoose.Types.ObjectId() }, withdrawn_payee_changed: { withdrawnParalegalId: new mongoose.Types.ObjectId() },
  };
  const userChanges = { disabled: { disabled: true }, deleted: { deleted: true }, suspended: { suspended: true }, unapproved: { status: 'pending' }, role_changed: { role: 'attorney' } };
  if (matterChanges[state]) await Case.collection.updateOne({ _id: f.matter._id }, { $set: matterChanges[state] });
  if (userChanges[state]) await User.collection.updateOne({ _id: f.para._id }, { $set: userChanges[state] });
  await reviewNotices.processNotices(); expect((await ReviewNotice.findById(row._id)).status).toBe('skipped');
  expect(sendEmail.mock.calls.some(([to]) => to === f.para.email)).toBe(false);
});
test('missing review indexes leave an overdue reminder eligible without committing any notices', async () => {
  const f = await fixture(); jest.spyOn(ReviewNotice.collection, 'indexes').mockResolvedValue([]);
  expect(await processAdminOverdueDisputes({ now: f.now })).toEqual({ scanned: 1, notified: 0, failed: 1 });
  expect((await Case.findById(f.matter._id)).adminDisputeOverdueNotifiedAt).toBeNull();
  expect(await Notification.countDocuments()).toBe(0); expect(await ReviewNotice.countDocuments()).toBe(0);
});
test('a future review deadline does not issue a reminder or change its recorded decision fields', async () => {
  const f = await fixture(); await Case.updateOne({ _id: f.matter._id }, { $set: { adminDisputeDeadlineAt: new Date(Date.now() + 86400000) } });
  const before = await Case.collection.findOne({ _id: f.matter._id });
  expect(await processAdminOverdueDisputes({ now: f.now })).toEqual({ scanned: 0, notified: 0, failed: 0 });
  expect(await Case.collection.findOne({ _id: f.matter._id })).toEqual(before);
  expect(await Notification.countDocuments()).toBe(0); expect(await ReviewNotice.countDocuments()).toBe(0);
});
