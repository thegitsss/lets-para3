const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require('../utils/email'), Notice = require('../models/MatterReviewNotification');
const User = require('../models/User'), Case = require('../models/Case'), Operation = require('../models/PaymentOperation'), Payout = require('../models/Payout');
const { processNotices, ready } = require('../services/matterReviewNotifications');
const { ensureReviewNoticeIndexes } = require('../scripts/admin-communications-indexes');
let attorney, para, matter, operation, payout, resolvedAt, disputeId;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
 await clearDatabase(); sendEmail.mockClear();
 [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@resolution.test`, password: 'Synthetic123!', role, status: 'approved' })));
 resolvedAt = new Date(); disputeId = new mongoose.Types.ObjectId().toString();
 matter = await Case.create({ title: 'River Street lease review', details: 'Synthetic', attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: 'closed', payoutStatus: 'paid', payoutTransferId: 'tr_delivery_resolution', disputes: [{ disputeId, raisedBy: para._id, status: 'resolved', message: 'PRIVATE_REVIEW_MESSAGE' }], disputeSettlement: { disputeId, action: 'release_partial', resolvedAt, transferId: 'tr_delivery_resolution', refundId: 're_delivery_resolution', payoutAmount: 41000, refundAmount: 61000 } });
 operation = await Operation.create({ caseId: matter._id, kind: 'dispute_settlement', operationKey: `dispute_settlement:${matter._id}:${disputeId}`, fingerprint: 'synthetic', status: 'succeeded', evidenceStatus: 'verified', stripeTransferId: 'tr_delivery_resolution', transferAmount: 41000, stripeRefundId: 're_delivery_resolution', refundAmount: 61000, refundStatus: 'succeeded', refundEvidenceStatus: 'verified', refundVerifiedAt: resolvedAt });
 payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: operation.operationKey, transferId: 'tr_delivery_resolution', amountPaid: 41000, status: 'paid' });
});
const queue = (user = para) => Notice.create({ kind: 'resolved', caseId: matter._id, userId: user._id, userRole: user.role, disputeId, resolvedAt, action: 'release_partial', operationId: operation._id });
test.each(['attorney', 'paralegal', 'withdrawn'])('%s decision email uses current title and one protected destination without a receipt or bank-arrival claim', async role => {
 const user = role === 'attorney' ? attorney : para, notice = await queue(user);
 if (role === 'withdrawn') { await Operation.updateOne({ _id: operation._id }, { $set: { stripeRefundId: '', refundAmount: 0 } }); await Case.updateOne({ _id: matter._id }, { $unset: { paralegal: '', paralegalId: '' }, $set: { status: 'paused', pausedReason: 'paralegal_withdrew', withdrawnParalegalId: para._id, paralegalAccessRevokedAt: new Date(), 'disputeSettlement.refundId': '', 'disputeSettlement.refundAmount': 0 } }); }
 await User.updateOne({ _id: user._id }, { $set: { email: 'current@resolution.test' } }); await Case.updateOne({ _id: matter._id }, { $set: { title: 'Current <b>Matter</b> title' } });
 await processNotices(); expect((await Notice.findById(notice._id)).status).toBe('accepted');
 const [to, subject, html, options] = sendEmail.mock.calls[0]; expect(to).toBe('current@resolution.test'); expect(subject).toContain('Current'); expect(html).toContain('Current &lt;b&gt;Matter&lt;/b&gt; title'); expect(html).not.toMatch(/PRIVATE_REVIEW_MESSAGE|receipt|bank|\$410|\$610/); expect(html.match(/<a /g)).toHaveLength(1);
 expect(html).toContain(role === 'attorney' ? `/case-detail.html?caseId=${matter._id}&amp;tab=financials` : `/dashboard-paralegal.html?highlightCase=${matter._id}#cases-completed`); expect(options.messageId).toBe(`<lpc-review.${notice._id}@lets-paraconnect.com>`);
 await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each(['review_reopened', 'decision_replaced', 'purged', 'reassigned', 'contradictory_owner', 'disabled', 'suspended', 'deleted', 'unapproved', 'role_changed', 'email_disabled', 'emailCase_disabled', 'operation_missing', 'operation_pending', 'operation_reconciliation', 'operation_quarantined', 'transfer_changed', 'refund_changed', 'refund_pending', 'refund_unverified', 'payout_missing', 'payout_reversed', 'payout_wrong_payee', 'case_reconciliation'])( '%s suppresses stale or unverifiable decision email', async state => {
 const notice = await queue();
 const matterChanges = { review_reopened: { 'disputes.0.status': 'open' }, decision_replaced: { 'disputeSettlement.resolvedAt': new Date(resolvedAt.getTime() + 1) }, purged: { purgedAt: new Date() }, reassigned: { paralegal: new mongoose.Types.ObjectId(), paralegalId: null }, contradictory_owner: { attorneyId: new mongoose.Types.ObjectId() }, case_reconciliation: { payoutStatus: 'needs_reconciliation' } };
 if (matterChanges[state]) await Case.collection.updateOne({ _id: matter._id }, { $set: matterChanges[state] });
 const userChanges = { disabled: { disabled: true }, suspended: { suspended: true }, deleted: { deleted: true }, unapproved: { status: 'pending' }, role_changed: { role: 'attorney' }, email_disabled: { 'notificationPrefs.email': false }, emailCase_disabled: { 'notificationPrefs.emailCase': false } };
 if (userChanges[state]) await User.collection.updateOne({ _id: para._id }, { $set: userChanges[state] });
 const opChanges = { operation_pending: { status: 'pending' }, operation_reconciliation: { evidenceStatus: 'needs_reconciliation' }, operation_quarantined: { evidenceStatus: 'quarantined' }, transfer_changed: { stripeTransferId: 'tr_other' }, refund_changed: { stripeRefundId: 're_other' }, refund_pending: { refundStatus: 'pending' }, refund_unverified: { refundEvidenceStatus: 'needs_review' } };
 if (opChanges[state]) await Operation.updateOne({ _id: operation._id }, { $set: opChanges[state] });
 if (state === 'operation_missing') await Operation.deleteOne({ _id: operation._id });
 if (state === 'payout_missing') await Payout.deleteOne({ _id: payout._id });
 if (state === 'payout_reversed') await Payout.updateOne({ _id: payout._id }, { $set: { status: 'reversed' } });
 if (state === 'payout_wrong_payee') await Payout.updateOne({ _id: payout._id }, { $set: { paralegalId: new mongoose.Types.ObjectId() } });
 await processNotices(); expect(sendEmail).not.toHaveBeenCalled(); expect((await Notice.findById(notice._id)).status).toBe('skipped');
});
test('review index conversion preserves delivery receipts and permits one opening plus one resolution', async () => {
 await Notice.collection.createIndex({ caseId: 1, disputeId: 1, userId: 1 }, { unique: true });
 await Notice.collection.createIndex({ userId: 1 }, { name: 'synthetic_unrelated_owner' });
 const indexes = await Notice.collection.indexes(), expanded = indexes.find(index => Object.keys(index.key).length === 4 && index.key.kind);
 await Notice.collection.dropIndex(expanded.name);
 const old = { _id: new mongoose.Types.ObjectId(), caseId: matter._id, userId: para._id, userRole: 'paralegal', disputeId, openedAt: resolvedAt, status: 'accepted', acceptedAt: resolvedAt, attempts: 3, claim: 'synthetic-receipt', failure: '' };
 await Notice.collection.insertOne(old); await expect(ready()).rejects.toThrow('indexes');
 await ensureReviewNoticeIndexes(); await ensureReviewNoticeIndexes();
 expect(await Notice.collection.findOne({ _id: old._id })).toMatchObject({ ...old, kind: 'opened' }); await ready();
 await queue(); expect(await Notice.countDocuments()).toBe(2);
 await expect(Notice.collection.insertOne({ ...old, _id: new mongoose.Types.ObjectId(), kind: 'opened' })).rejects.toMatchObject({ code: 11000 });
 expect((await Notice.collection.indexes()).some(index => index.name === 'synthetic_unrelated_owner')).toBe(true);
 await Notice.collection.dropIndex('synthetic_unrelated_owner');
});
test('index conversion failure retains the original unique key and delivery state', async () => {
 await Notice.collection.createIndex({ caseId: 1, disputeId: 1, userId: 1 }, { unique: true });
 const notice = await queue(); await Notice.updateOne({ _id: notice._id }, { $set: { status: 'unknown', attempts: 1, claim: 'unknown-receipt' } });
 const fault = jest.spyOn(Notice, 'createIndexes').mockRejectedValueOnce(Error('Synthetic index creation failure'));
 await expect(ensureReviewNoticeIndexes()).rejects.toThrow('Synthetic');
 expect((await Notice.findById(notice._id)).status).toBe('unknown'); expect((await Notice.collection.indexes()).some(index => Object.keys(index.key).length === 3 && index.unique)).toBe(true);
 fault.mockRestore(); await ensureReviewNoticeIndexes(); await ready();
});
