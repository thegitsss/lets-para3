jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/caseLifecycle", () => ({ ...jest.requireActual("../services/caseLifecycle"), buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("synthetic PDF")), uploadPdfToS3: jest.fn(async () => ({ key: "synthetic" })) }));
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "http://localhost:5050/stripe/connect/return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "http://localhost:5050/stripe/connect/refresh";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";

const mockStripe = {
  refunds: { create: jest.fn(), retrieve: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  transfers: { create: jest.fn() },
  isTransferablePaymentIntent: jest.fn(),
  sanitizeStripeError: jest.fn((_err, message) => message),
  stripeIdempotencyKey: jest.fn((operation, ...parts) => `test_${operation}_${parts.join("_")}`),
};

jest.mock("../utils/stripe", () => mockStripe);

jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));

const User = require("../models/User");
const Case = require("../models/Case");
const PaymentOperation = require("../models/PaymentOperation");
const Payout = require("../models/Payout");
const disputesRouter = require("../routes/disputes");
const paymentsRouter = require("../routes/payments");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/disputes", disputesRouter);
  instance.use("/api/payments", paymentsRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

function refundFixture(caseDoc, { chargeId, refundId, refunded = 0, amount } = {}) {
  const intentId = caseDoc.escrowIntentId, gross = require("../utils/paymentIntegrity").expectedCaseFunding(caseDoc).totalAmount;
  const charge = { id: chargeId, object: "charge", payment_intent: intentId, amount: gross, amount_captured: gross, amount_refunded: refunded, paid: true, captured: true, status: "succeeded", currency: "usd", livemode: false };
  const intent = { id: intentId, object: "payment_intent", status: "succeeded", amount: gross, amount_received: gross, currency: "usd", livemode: false, transfer_group: `case_${caseDoc._id}`, metadata: { caseId: String(caseDoc._id) }, latest_charge: charge };
  const refund = { id: refundId, object: "refund", status: "succeeded", amount, payment_intent: intentId, charge: chargeId, currency: "usd" };
  mockStripe.paymentIntents.retrieve.mockResolvedValue(intent);
  mockStripe.isTransferablePaymentIntent.mockReturnValue({ transferable: true, charge });
  mockStripe.refunds.create.mockResolvedValue(refund);
  mockStripe.refunds.retrieve.mockResolvedValue(refund);
}

beforeAll(async () => {
  await connect();
  await Promise.all([User.init(), Case.init(), PaymentOperation.init(), Payout.init(), require("../models/AuditLog").init(), require("../models/PlatformIncome").init(), require("../models/WebhookEvent").init()]);
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase(); require("../utils/email").mockClear();
  mockStripe.refunds.create.mockReset();
  mockStripe.refunds.retrieve.mockReset();
  mockStripe.paymentIntents.retrieve.mockReset();
  mockStripe.transfers.create.mockReset();
  mockStripe.isTransferablePaymentIntent.mockReset();
});


afterEach(() => jest.restoreAllMocks());
test.each(['refund', 'release_partial'])('%s must retain resolution notices with its final local financial record', async action => {
  const [admin, attorney, para] = await User.create(['admin', 'attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@resolution-notice.test`, password: 'Synthetic123!', role, status: 'approved', ...(role === 'paralegal' ? { stripeAccountId: 'acct_synthetic_resolution', stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  const caseDoc = await Case.create({ title: 'River Street review decision', details: 'Synthetic review resolution.', status: 'disputed', pausedReason: 'dispute', attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, escrowIntentId: 'pi_resolution_notice', escrowStatus: 'funded', totalAmount: 100000, currency: 'usd', disputes: [{ message: 'Review request', raisedBy: para._id, status: 'open' }] });
  const disputeId = caseDoc.disputes[0].disputeId;
  refundFixture(caseDoc, { chargeId: 'ch_resolution_notice', refundId: 're_resolution_notice', amount: action === 'refund' ? 122000 : 61000 });
  mockStripe.transfers.create.mockResolvedValue({ id: 'tr_resolution_notice' });
  jest.spyOn(require('../models/Notification'), 'create').mockRejectedValueOnce(new Error('Synthetic resolution notice unavailable'));
  const response = await request(app).post(`/api/payments/dispute/settle/${caseDoc._id}`).set('Cookie', authCookieFor(admin)).send({ action, disputeId, ...(action === 'release_partial' ? { payoutAmountCents: 41000 } : {}) });
  expect(response.status).toBe(503);
  const current = await Case.findById(caseDoc._id).lean(); expect(current.status).toBe('disputed'); expect(current.disputes[0].status).toBe('open');
  expect(await require('../models/Notification').countDocuments({ type: 'dispute_resolved' })).toBe(0);
  expect(await require('../models/AuditLog').countDocuments({ action: { $in: ['dispute.settlement.refund', 'dispute.settlement.release'] } })).toBe(0);
  expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(action === 'refund' ? 0 : 1);
});

const ReviewNotice = require('../models/MatterReviewNotification'), Notification = require('../models/Notification');
const outcomes = ['refund', 'release_partial', 'release_full', 'withdrawn_refund', 'withdrawn_release_partial', 'withdrawn_release_full'];
async function resolutionFixture(outcome) {
  const withdrawn = outcome.startsWith('withdrawn_'), action = outcome.replace('withdrawn_', '');
  const [admin, attorney, para] = await User.create(['admin', 'attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@resolution-notice.test`, password: 'Synthetic123!', role, status: 'approved', ...(role === 'paralegal' ? { stripeAccountId: 'acct_synthetic_resolution', stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  const matter = await Case.create({ title: 'River Street review decision', details: 'Synthetic review resolution.', status: 'disputed', pausedReason: 'dispute', attorney: attorney._id, attorneyId: attorney._id, ...(withdrawn ? { withdrawnParalegalId: para._id, paralegalAccessRevokedAt: new Date() } : { paralegal: para._id, paralegalId: para._id }), escrowIntentId: 'pi_resolution_notice', escrowStatus: 'funded', totalAmount: 100000, currency: 'usd', disputes: [{ message: 'PRIVATE_REVIEW_DETAILS', raisedBy: para._id, status: 'open' }] });
  const disputeId = matter.disputes[0].disputeId;
  refundFixture(matter, { chargeId: 'ch_resolution_notice', refundId: 're_resolution_notice', amount: action === 'refund' ? 122000 : 61000 });
  mockStripe.transfers.create.mockResolvedValue({ id: 'tr_resolution_notice' });
  const settle = () => request(app).post(`/api/payments/dispute/settle/${matter._id}`).set('Cookie', authCookieFor(admin)).send({ action, disputeId, ...(action === 'release_partial' ? { payoutAmountCents: 41000 } : {}) });
  return { matter, admin, attorney, para, action, disputeId, withdrawn, settle, refunds: !withdrawn && action !== 'release_full' ? 1 : 0, transfers: action === 'refund' ? 0 : 1 };
}
async function assertRecorded(f) {
  const current = await Case.findById(f.matter._id).lean(); expect(current.status).toBe(f.withdrawn ? 'paused' : 'closed'); expect(current.disputes[0].status).toBe('resolved');
  const records = await Notification.find({ type: 'dispute_resolved' }).lean(), emails = await ReviewNotice.find({ kind: 'resolved' }).lean();
  for (const rows of [records, emails]) { expect(rows).toHaveLength(2); expect(rows.map(row => String(row.userId)).sort()).toEqual([String(f.attorney._id), String(f.para._id)].sort()); }
  const operation = await PaymentOperation.findOne({ caseId: f.matter._id, kind: 'dispute_settlement' }).lean(); expect(operation.status).toBe('succeeded');
  for (const row of emails) expect(row).toMatchObject({ status: 'pending', operationId: operation._id, action: f.action, resolvedAt: current.disputeSettlement.resolvedAt });
  expect(await Payout.countDocuments({ caseId: f.matter._id })).toBe(f.transfers);
  expect(mockStripe.refunds.create).toHaveBeenCalledTimes(f.refunds); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(f.transfers);
  expect(require('../utils/email')).not.toHaveBeenCalled();
}
test.each(outcomes)('%s commits one decision notice for each party and does not duplicate on replay', async outcome => {
  const f = await resolutionFixture(outcome);
  // A recorded opening email and this resolution must coexist for the same review.
  await ReviewNotice.create({ caseId: f.matter._id, userId: f.attorney._id, userRole: 'attorney', disputeId: f.disputeId, openedAt: f.matter.disputes[0].createdAt, status: 'accepted', acceptedAt: new Date() });
  const result = await f.settle(); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 }); await assertRecorded(f);
  expect((await f.settle()).body.alreadySettled).toBe(true); await assertRecorded(f);
});
for (const failure of ['second_inapp', 'second_email']) test.each(outcomes)(`%s rolls back on ${failure} failure and retains provider references for local recovery`, async outcome => {
  const f = await resolutionFixture(outcome), Model = failure === 'second_inapp' ? Notification : ReviewNotice, original = Model.create.bind(Model);
  let calls = 0; const fault = jest.spyOn(Model, 'create').mockImplementation((...args) => { if (++calls === 2) throw Error('Synthetic second recipient failure'); return original(...args); });
  expect((await f.settle()).status).toBe(503);
  expect(calls).toBe(2); const current = await Case.findById(f.matter._id).lean(); expect(current.status).toBe('disputed'); expect(current.disputes[0].status).toBe('open');
  expect(await Notification.countDocuments()).toBe(0); expect(await ReviewNotice.countDocuments()).toBe(0); expect(await Payout.countDocuments()).toBe(0);
  expect(await require('../models/AuditLog').countDocuments({ action: /^dispute\.(settlement|withdrawal)/ })).toBe(0);
  const operation = await PaymentOperation.findOne({ caseId: f.matter._id, kind: 'dispute_settlement' }).lean();
  expect(operation.status).not.toBe('succeeded');
  if (f.refunds) expect(operation.stripeRefundId).toBe('re_resolution_notice'); if (f.transfers) expect(operation.stripeTransferId).toBe('tr_resolution_notice');
  expect(require('../utils/email')).not.toHaveBeenCalled(); fault.mockRestore();
  const recovered = await f.settle(); expect({ status: recovered.status, body: recovered.body }).toMatchObject({ status: 200 }); await assertRecorded(f);
});
test('unavailable review indexes prevent settlement before any provider action', async () => {
  const f = await resolutionFixture('release_partial'); jest.spyOn(require('../services/matterReviewNotifications'), 'ready').mockRejectedValueOnce(Error('Synthetic missing index'));
  const response = await f.settle(); expect(response.status).toBe(503); expect(response.body.code).toBe('REVIEW_NOTICE_UNAVAILABLE');
  expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(mockStripe.refunds.create).not.toHaveBeenCalled(); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(await PaymentOperation.countDocuments()).toBe(0);
});
test.each(['emailCase', 'email', 'inAppCase'])('%s preferences retain the existing resolution notification policy', async preference => {
  const f = await resolutionFixture('refund'); await User.updateMany({ role: { $in: ['attorney', 'paralegal'] } }, { $set: { [`notificationPrefs.${preference}`]: false } });
  expect((await f.settle()).status).toBe(200); expect(await ReviewNotice.countDocuments()).toBe(preference === 'inAppCase' ? 2 : 0); expect(await Notification.countDocuments()).toBe(preference === 'inAppCase' ? 0 : 2); expect(require('../utils/email')).not.toHaveBeenCalled();
});

async function withdrawalReviewFixture(outcome = 'withdrawn_release_partial') {
  const f = await resolutionFixture(outcome);
  await Case.updateOne({ _id: f.matter._id }, { $set: { pausedAt: new Date('2026-09-01'), practiceArea: 'Real Estate Law', lockedTotalAmount: 100000, remainingAmount: 100000, feeParalegalPct: 18, stripeMode: 'test', tasks: [{ title: 'Review lease exhibits', completed: true }, { title: 'Review renewal terms', completed: false }] } });
  const result = await f.settle(); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 });
  const req = { method: 'GET', params: { caseId: String(f.matter._id) }, query: { expectedOwnerId: String(f.attorney._id) }, user: { id: String(f.attorney._id), role: 'attorney' } };
  return { ...f, read: () => require('../services/attorneyWithdrawal').read(req) };
}
test.each(['withdrawn_refund', 'withdrawn_release_partial', 'withdrawn_release_full'])('settlement withdrawal review agrees with the recorded %s outcome', async outcome => {
  const f = await withdrawalReviewFixture(outcome), view = await f.read();
  expect(view.state).toBe('finalized'); expect(view.canDecide).toBe(false); expect(view.canPay).toBe(false);
  expect(view.blockers).not.toContain('payout_needs_review');
  expect(view.decision.payoutState).toBe(f.transfers ? 'recorded' : 'none');
  expect(view.decision.netCents).toBe(f.transfers ? outcome.endsWith('partial') ? 41000 : 82000 : null);
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(f.transfers); expect(mockStripe.refunds.create).not.toHaveBeenCalled();
});

test.each([
  ['operation', { transferAmount: 1 }], ['operation', { status: 'needs_reconciliation' }],
  ['operation', { evidenceStatus: 'quarantined' }], ['operation', { evidenceStatus: 'needs_reconciliation' }],
  ['operation', { currency: 'eur' }], ['operation', { stripeMode: 'live' }],
  ['operation', { stripeTransferId: 'tr_another' }], ['operation', { stripeRefundId: 're_unexpected' }],
  ['operation', { operationKey: 'dispute_settlement:another:review' }],
  ['matter', { 'disputeSettlement.disputeId': 'different-review' }],
  ['matter', { 'disputeSettlement.resolvedAt': new Date('2026-01-01') }],
  ['matter', { 'disputes.0.status': 'open' }],
  ['matter', { 'disputeSettlement.payoutAmount': 1 }],
  ['matter', { 'disputeSettlement.grossAmount': 1 }],
  ['matter', { 'disputeSettlement.feeParalegalAmount': 1 }],
  ['payout', { reversedAt: new Date() }], ['payout', { failureReason: 'Retained failure' }],
])('settlement withdrawal review retains a block for changed %s evidence %j', async (source, patch) => {
  const f = await withdrawalReviewFixture();
  if (source === 'matter') await Case.collection.updateOne({ _id: f.matter._id }, { $set: patch });
  else await (source === 'operation' ? PaymentOperation : Payout).collection.updateOne({ caseId: f.matter._id }, { $set: patch });
  const view = await f.read(); expect(view.decision.payoutState).not.toBe('recorded'); expect(view.decision.netCents).toBeNull();
  expect(view.blockers).toContain('payout_needs_review'); expect(view.canDecide).toBe(false); expect(view.canPay).toBe(false); expect(view.canRelist).toBe(false);
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(mockStripe.refunds.create).not.toHaveBeenCalled();
});
