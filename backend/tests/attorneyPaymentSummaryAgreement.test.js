const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), { Types } = require('mongoose');
jest.mock('../utils/stripe', () => ({ paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, refunds: { list: jest.fn() }, transfers: { create: jest.fn() } }));
jest.mock('../services/lpcEvents/publishEventService', () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require('../models/User'), Case = require('../models/Case'), Operation = require('../models/PaymentOperation'), Payout = require('../models/Payout');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/payments', require('../routes/payments'));
app.use('/api/attorney/dashboard', require('../routes/attorneyDashboard'));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ code: error.publicCode || error.code, error: error.message }));
let owner, paralegal, other;
beforeAll(connect, 90000); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, paralegal, other] = await User.create(['owner', 'paralegal', 'other'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@payment-agreement.test`, password: 'Synthetic123!', role: name === 'paralegal' ? name : 'attorney', status: 'approved' })));
});
const cookie = actor => `token=${require('jsonwebtoken').sign({ id: String(actor._id), role: actor.role, av: actor.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const get = (suffix, actor = owner) => request(app).get(`/api/payments/${suffix}`).set('Cookie', cookie(actor)).query({ expectedOwnerId: String(actor._id) });
async function matter(patch = {}, { recorded = true } = {}) {
  const _id = new Types.ObjectId(), suffix = String(_id);
  const doc = { _id, attorney: owner._id, attorneyId: owner._id, paralegal: paralegal._id, paralegalId: paralegal._id, title: `Payment agreement ${suffix}`, status: 'in progress', archived: false, paymentReleased: false, totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, feeParalegalPct: 19, currency: 'usd', stripeMode: 'test', paymentIntentId: `pi_${suffix}`, escrowIntentId: `pi_${suffix}`, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', withdrawalHistory: [], createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-10'), ...patch };
  await Case.collection.insertOne(doc);
  if (recorded) await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: _id, kind: 'funding', operationKey: `funding:${_id}:${doc.paymentIntentId}`, status: 'succeeded', amount: 48800, currency: doc.currency, stripeObjectId: doc.paymentIntentId, stripePaymentIntentId: doc.paymentIntentId, stripeChargeId: `ch_${suffix}`, stripeBalanceTransactionId: `txn_${suffix}`, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: 'test', livemode: false, evidenceVerifiedAt: new Date('2026-01-03'), createdAt: new Date('2026-01-02') });
  return doc;
}
async function summary() { const response = await get('summary'); expect(response.status).toBe(200); return response.body; }
async function history() { const response = await get('attorney-financial-history'); expect({ status: response.status, body: response.body }).toMatchObject({ status: 200 }); return response.body; }

test('an empty account has zero recorded amounts and cannot inherit another owner\'s funds', async () => {
  await matter({ attorney: other._id, attorneyId: other._id });
  expect(await summary()).toMatchObject({ activeFunds: 0, pendingCharges: 0, totalSpent: 0 });
  expect((await history()).total).toBe(0);
});

test('funded Case flags without a retained funding record cannot become a confirmed active balance', async () => {
  await matter({}, { recorded: false });
  expect((await history()).entries[0]).toMatchObject({ type: 'funding', state: 'needs_review' });
  expect((await summary()).activeFunds).toBeNull();
});

test('active totals and their Matter row retain the remaining balance after a verified earlier partial payout', async () => {
  const at = new Date('2026-01-05');
  const doc = await matter({ remainingAmount: 30000, withdrawalHistory: [{ withdrawnParalegalId: paralegal._id, pausedAt: new Date('2026-01-04'), payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', partialPayoutAmount: 10000, payoutTransferId: 'tr_partial_agreement' }] });
  await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, amountPaid: 8100, transferId: 'tr_partial_agreement', stripeMode: 'test', status: 'paid', createdAt: at });
  expect((await history()).summary.currencies[0]).toMatchObject({ originalFunding: 48800, paralegalPayouts: 8100 });
  expect((await summary()).activeFunds).toBe(30000);
  const active = await get('escrow/active'); expect(active.status).toBe(200); expect(active.body.items.find(row => String(row.caseId) === String(doc._id)).amountHeld).toBe(30000);
});

test('USD legacy totals do not relabel verified EUR funds as dollars', async () => {
  await matter(); await matter({ currency: 'eur' });
  expect((await history()).summary.currencies.map(group => [group.currency, group.originalFunding])).toEqual([['EUR', 48800], ['USD', 48800]]);
  expect((await summary()).activeFunds).toBe(40000);
});

test('assigned work with no payment attempt is funding needed, not a pending Stripe charge', async () => {
  await matter({ paymentIntentId: null, escrowIntentId: null, escrowStatus: 'unfunded', fundingIntegrityStatus: 'pending' }, { recorded: false });
  const value = await summary(); expect(value.pendingCharges).toBe(0); expect(value.fundingNeeded).toBe(48800);
});

test.each([{ status: 'closed' }, { archived: true }, { readOnly: true }, { purgedAt: new Date('2026-01-05') }])('unfunded work closed to further activity does not ask for new funding: %j', async patch => {
  await matter({ paymentIntentId: null, escrowIntentId: null, escrowStatus: 'unfunded', fundingIntegrityStatus: 'pending', ...patch }, { recorded: false });
  expect(await summary()).toMatchObject({ fundingNeeded: 0, activeFunds: 0, requiresReview: 0 });
  expect((await get('escrow/pending')).body.items).toEqual([]);
});

test('completion flags without retained payment evidence cannot invent a total spent amount', async () => {
  await matter({ status: 'completed', paymentReleased: true, payoutStatus: 'paid' }, { recorded: false });
  expect((await history()).summary.currencies[0].originalFunding).toBe(0);
  expect((await summary()).totalSpent).toBeNull();
});

test('conflicting persisted attorney aliases cannot disclose the other owner\'s money', async () => {
  await matter({ attorneyId: other._id });
  expect((await get('attorney-financial-history')).status).toBe(409);
  const value = await get('summary'); expect(value.status).toBe(409); expect(value.body.activeFunds).toBeUndefined();
});

test('the actual dashboard and summary agree on verified original funding and remaining funds without changing records', async () => {
  const doc = await matter(), before = await Case.collection.findOne({ _id: doc._id });
  const value = await summary(), dashboard = await request(app).get('/api/attorney/dashboard').set('Cookie', cookie(owner));
  expect(dashboard.status).toBe(200); expect(dashboard.body.metrics.escrowTotal).toBe(40000);
  expect(value).toMatchObject({ activeFunds: 40000, totalSpent: 48800, pendingCharges: 0, fundingNeeded: 0, requiresReview: 0 });
  expect(await Case.collection.findOne({ _id: doc._id })).toEqual(before);
  expect(require('../utils/stripe').paymentIntents.retrieve).not.toHaveBeenCalled();
});

test('a matching recorded pending funding attempt keeps its requested amount distinct from confirmed funds', async () => {
  const doc = await matter({ escrowStatus: 'pending', paymentStatus: 'processing' });
  await Operation.collection.updateOne({ caseId: doc._id }, { $set: { status: 'pending', stripeChargeId: null, stripeBalanceTransactionId: null, evidenceVerifiedAt: null } });
  expect(await summary()).toMatchObject({ pendingCharges: 48800, activeFunds: null, totalSpent: null, fundingNeeded: 0, requiresReview: 0 });
  const pending = await get('escrow/pending'); expect(pending.status).toBe(200); expect(pending.body.items[0]).toMatchObject({ status: 'pending', amountDue: 48800, amountHeld: null });
});

test.each(['missing', 'failed', 'reversed'])('a %s earlier payout cannot verify the reduced active balance', async status => {
  const doc = await matter({ remainingAmount: 30000, withdrawalHistory: [{ withdrawnParalegalId: paralegal._id, payoutFinalizedAt: new Date('2026-01-05'), payoutFinalizedType: 'partial_attorney', partialPayoutAmount: 10000, payoutTransferId: 'tr_unconfirmed_earlier' }] });
  if (status !== 'missing') await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, amountPaid: 8100, transferId: 'tr_unconfirmed_earlier', stripeMode: 'test', status, createdAt: new Date('2026-01-05') });
  expect(await summary()).toMatchObject({ activeFunds: null, requiresReview: 1 });
});

test('a paid completion has zero remaining funds while original funding remains recorded independently', async () => {
  const doc = await matter({ status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_completed_agreement' });
  await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, operationKey: `case_payout:${doc._id}`, amountPaid: 32400, transferId: 'tr_completed_agreement', stripeMode: 'test', status: 'paid', createdAt: new Date('2026-01-05') });
  expect(await summary()).toMatchObject({ activeFunds: 0, totalSpent: 48800, completedJobsCount: 1, requiresReview: 0 });
});

test('raw string ownership is retained and a foreign duplicate funding pointer cannot verify either balance', async () => {
  const doc = await matter({ attorney: String(owner._id), attorneyId: String(owner._id) });
  expect((await summary()).activeFunds).toBe(40000);
  await Case.collection.insertOne({ _id: new Types.ObjectId(), attorney: other._id, attorneyId: other._id, title: 'PRIVATE_FOREIGN_FUNDING', paymentIntentId: doc.paymentIntentId });
  const value = await summary(); expect(value.activeFunds).toBeNull(); expect(value.requiresReview).toBe(1); expect(JSON.stringify(value)).not.toContain('PRIVATE_FOREIGN');
});

test('source changes between the two inventory reads cannot return an earlier balance', async () => {
  const doc = await matter(); const financial = require('../services/attorneyFinancialHistory'), original = financial.loadFinancialInventory;
  jest.spyOn(financial, 'loadFinancialInventory').mockImplementationOnce(async (...args) => { const value = await original(...args); await Case.collection.updateOne({ _id: doc._id }, { $set: { remainingAmount: 35000 } }); return value; });
  const response = await get('summary'); expect(response.status).toBe(409); expect(response.body.activeFunds).toBeUndefined();
});

test('an account disabled during the read loses all summary amounts', async () => {
  await matter(); const financial = require('../services/attorneyFinancialHistory'), original = financial.loadFinancialInventory;
  jest.spyOn(financial, 'loadFinancialInventory').mockImplementationOnce(async (...args) => { const value = await original(...args); await User.collection.updateOne({ _id: owner._id }, { $set: { disabled: true } }); return value; });
  const response = await get('summary'); expect(response.status).toBe(403); expect(response.body.activeFunds).toBeUndefined();
});

test('an unavailable ledger returns an error rather than zero money', async () => {
  jest.spyOn(Operation.collection, 'find').mockImplementationOnce(() => { throw Error('Synthetic unavailable ledger'); });
  const response = await get('summary'); expect(response.status).toBe(503); expect(response.body.activeFunds).toBeUndefined();
});

test('active pages report the full count and bind later pages to the reviewed financial inventory', async () => {
  const original = await matter();
  await Case.collection.insertMany(Array.from({ length: 505 }, (_, index) => ({ ...original, _id: new Types.ObjectId(), title: `Earlier financial Matter ${index}`, escrowIntentId: `pi_page_${index}`, paymentIntentId: `pi_page_${index}` })));
  const first = await get('escrow/active'); expect(first.status).toBe(200); expect(first.body.count).toBe(506); expect(first.body.items).toHaveLength(200);
  const second = await get(`escrow/active?cursor=${first.body.nextCursor}&revision=${first.body.revision}`); expect(second.status).toBe(200); expect(second.body.count).toBe(506); expect(new Set([...first.body.items, ...second.body.items].map(row => row.id)).size).toBe(400);
  await Case.collection.updateOne({ _id: original._id }, { $set: { title: 'Changed during page review' } });
  expect((await get(`escrow/active?cursor=${first.body.nextCursor}&revision=${first.body.revision}`)).status).toBe(409);
});

test('a verified won card dispute with an explicitly cleared hold no longer obscures remaining funds', async () => {
  const doc = await matter();
  await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, kind: 'chargeback', operationKey: 'chargeback:dp_summary_won', amount: 48800, currency: 'usd', stripeMode: 'test', stripeDisputeId: 'dp_summary_won', stripeChargeId: `ch_${doc._id}`, evidenceStatus: 'verified', processorStatus: 'won', administrativeStatus: 'hold_cleared', payoutPosition: 'pre_payout', status: 'succeeded', payoutHoldClearedAt: new Date('2026-01-06'), createdAt: new Date('2026-01-04') });
  expect((await require('../services/payoutHoldService').getPayoutHold(doc._id)).held).toBe(false);
  expect(await summary()).toMatchObject({ activeFunds: 40000, requiresReview: 0 });
});

test('a post-payout card dispute preserves the recorded payout and zero remaining principal', async () => {
  const doc = await matter({ status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_completed_card_dispute' });
  await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, amountPaid: 32400, transferId: 'tr_completed_card_dispute', operationKey: `case_payout:${doc._id}`, stripeMode: 'test', status: 'paid', createdAt: new Date('2026-01-04') });
  await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, kind: 'chargeback', operationKey: 'chargeback:dp_summary_after', amount: 48800, currency: 'usd', stripeMode: 'test', stripeDisputeId: 'dp_summary_after', stripeChargeId: `ch_${doc._id}`, evidenceStatus: 'verified', processorStatus: 'under_review', administrativeStatus: 'pending_review', payoutPosition: 'post_payout', status: 'needs_reconciliation', createdAt: new Date('2026-01-05') });
  expect((await require('../services/payoutHoldService').getPayoutHold(doc._id)).held).toBe(false);
  expect(await summary()).toMatchObject({ activeFunds: 0, totalSpent: 48800, requiresReview: 0 });
});

test.each(['failed', 'missing-amount'])('a settlement with a paid partial transfer and a %s refund does not claim all funds settled', async condition => {
  const doc = await matter({ status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_summary_settlement', disputeSettlement: { payoutAmount: 8100, transferId: 'tr_summary_settlement', refundAmount: 36600, refundId: 're_summary_settlement' } });
  await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, amountPaid: 8100, transferId: 'tr_summary_settlement', stripeMode: 'test', status: 'paid', createdAt: new Date('2026-01-05') });
  await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, operationKey: 'refund_summary_settlement', kind: 'refund', status: 'failed', amount: 36600, refundAmount: 36600, stripeRefundId: 're_summary_settlement', stripePaymentIntentId: doc.paymentIntentId, stripeChargeId: `ch_${doc._id}`, currency: 'usd', stripeMode: 'test', refundStatus: 'failed', refundEvidenceStatus: 'verified', refundVerifiedAt: new Date('2026-01-06'), refundCreatedAt: new Date('2026-01-05'), createdAt: new Date('2026-01-05') });
  const financial = await history(); expect(financial.entries.find(row => row.type === 'refund').state).toBe('failed'); expect(financial.summary.currencies[0].paralegalPayouts).toBe(8100);
  if (condition === 'missing-amount') await Case.collection.updateOne({ _id: doc._id }, { $unset: { 'disputeSettlement.refundAmount': '' } });
  expect(await summary()).toMatchObject({ activeFunds: null, requiresReview: 1 });
});

test('an earlier paid completion cannot settle a different current payout reference', async () => {
  const doc = await matter({ status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_current_unknown' });
  await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, amountPaid: 32400, transferId: 'tr_earlier_reference', operationKey: `case_payout:${doc._id}`, stripeMode: 'test', status: 'paid', createdAt: new Date('2026-01-04') });
  expect(await summary()).toMatchObject({ activeFunds: null, requiresReview: 1 });
});

test.each(['full-refund', 'settlement'])('a verified completed %s retains original funding and confirms no remaining Matter funds', async kind => {
  const refundAmount = kind === 'full-refund' ? 48800 : 36600;
  const doc = await matter(kind === 'full-refund' ? { status: 'closed', escrowStatus: 'refunded' } : { status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_summary_settlement_paid', disputeSettlement: { payoutAmount: 8100, transferId: 'tr_summary_settlement_paid', refundAmount, refundId: 're_summary_paid' } });
  if (kind === 'settlement') await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, paralegalId: paralegal._id, amountPaid: 8100, transferId: 'tr_summary_settlement_paid', stripeMode: 'test', status: 'paid', createdAt: new Date('2026-01-05') });
  await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: doc._id, operationKey: 'refund_summary_paid', kind: 'refund', status: 'succeeded', amount: refundAmount, refundAmount, stripeRefundId: 're_summary_paid', stripePaymentIntentId: doc.paymentIntentId, stripeChargeId: `ch_${doc._id}`, currency: 'usd', stripeMode: 'test', refundStatus: 'succeeded', refundEvidenceStatus: 'verified', refundVerifiedAt: new Date('2026-01-06'), refundCreatedAt: new Date('2026-01-05'), createdAt: new Date('2026-01-05') });
  expect((await history()).entries.find(row => row.type === 'refund')).toMatchObject({ state: 'recorded', amount: refundAmount });
  expect(await summary()).toMatchObject({ activeFunds: 0, totalSpent: 48800, requiresReview: 0, currencies: [expect.objectContaining({ refunds: refundAmount })] });
});
