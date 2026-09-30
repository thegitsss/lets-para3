const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
jest.mock("../utils/stripe", () => ({ paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, refunds: { list: jest.fn(), retrieve: jest.fn() }, transfers: { create: jest.fn() } }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation"), Adjustment = require("../models/FinancialAdjustment"), stripe = require("../utils/stripe");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/payments", require("../routes/payments"));
let owner, para, other, matter, funding;
const cookie = actor => `token=${require("jsonwebtoken").sign({ id: String(actor._id), role: actor.role, av: actor.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const get = (query = {}, actor = owner, csv = false) => request(app).get(`/api/payments/attorney-financial-history${csv ? "/csv" : ""}`).set("Cookie", cookie(actor)).query({ expectedOwnerId: String(actor._id), ...query });
const list = async query => { const result = await get(query); expect(result.status).toBe(200); return result.body; };
const change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });
const funded = async (patch = {}) => { funding = { _id: new Types.ObjectId(), caseId: matter._id, kind: "funding", operationKey: `funding:${matter._id}:pi_history`, status: "succeeded", amount: 48800, currency: "usd", stripeObjectId: "pi_history", stripePaymentIntentId: "pi_history", stripeChargeId: "ch_history", stripeBalanceTransactionId: "txn_history", grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: "test", livemode: false, evidenceVerifiedAt: new Date("2026-01-03"), createdAt: new Date("2026-01-02"), privateError: "PRIVATE_OPERATION", ...patch }; await Operation.collection.insertOne(funding); };
const withdrawal = async (patch = {}) => {
  const record = { withdrawnParalegalId: para._id, payoutFinalizedAt: new Date("2026-01-05"), payoutFinalizedType: "partial_attorney", partialPayoutAmount: 10000, payoutTransferId: "tr_history", pausedAt: new Date("2026-01-04"), ...patch };
  await change({ withdrawalHistory: [record] }); const payout = { _id: new Types.ObjectId(), caseId: matter._id, paralegalId: para._id, amountPaid: 8100, transferId: "tr_history", stripeMode: "test", status: "paid", createdAt: new Date("2026-01-05") }; await Payout.collection.insertOne(payout); return { record, payout };
};
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Payout.init(), Operation.init(), Adjustment.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@financial-history.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = { _id: new Types.ObjectId(), attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, title: "River Street lease records", status: "in progress", totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, feeParalegalPct: 19, paymentIntentId: "pi_history", escrowIntentId: "pi_history", escrowStatus: "funded", fundingIntegrityStatus: "verified", currency: "usd", stripeMode: "test", withdrawalHistory: [], privateNote: "PRIVATE_MATTER" }; await Case.collection.insertOne(matter);
});
test("recorded funding and payout totals come from exact retained evidence without provider calls or repair writes", async () => {
  await funded(); await withdrawal(); const before = await Case.collection.findOne({ _id: matter._id }), response = await get(); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body).toMatchObject({ total: 3, summary: { currencies: [{ currency: "USD", originalFunding: 48800, paralegalPayouts: 8100, fundingRecords: 1, payoutRecords: 1, fundingUnverified: 0, payoutsUnverified: 0 }], requiresReview: 0 } });
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|operationKey|stripeChargeId|txn_history|grossAmount|processingFeeAmount|lastError/); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before); expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(stripe.transfers.create).not.toHaveBeenCalled();
});
test("funded and completed Matter flags do not invent paid funding or payout totals", async () => {
  await change({ paymentReleased: true, payoutStatus: "paid", paidOutAt: new Date() }); const value = await list(); expect(value.entries[0]).toMatchObject({ type: "funding", state: "needs_review", basis: "funding_to_verify" }); expect(value.summary.currencies[0]).toMatchObject({ originalFunding: 0, fundingRecords: 0, fundingUnverified: 1, paralegalPayouts: 0 });
});
test.each([{ amount: 48799 }, { grossAmount: 50000 }, { netAmount: 47399 }, { currency: "eur" }, { livemode: true }, { stripeMode: "live" }, { evidenceVerifiedAt: null }, { status: "needs_reconciliation" }, { stripeChargeId: null }])("inconsistent capture evidence %j is excluded from paid totals", async patch => {
  await funded(patch); const value = await list(); expect(value.entries[0].state).toBe("needs_review"); expect(value.summary.currencies[0]).toMatchObject({ originalFunding: 0, fundingRecords: 0, fundingUnverified: 1 }); if (patch.currency) expect(value.entries[0].amount).toBeNull();
});
test("duplicate funding pointers and duplicate capture records outside this account require review without exposing that account", async () => {
  await funded(); const foreign = new Types.ObjectId(); await Case.collection.insertOne({ _id: foreign, attorney: other._id, title: "PRIVATE_FOREIGN_MATTER", paymentIntentId: "pi_history" }); expect((await list()).entries[0].state).toBe("needs_review"); await Case.collection.deleteOne({ _id: foreign });
  await Operation.collection.insertOne({ ...funding, _id: new Types.ObjectId(), caseId: foreign, operationKey: "foreign-key", stripePaymentIntentId: "pi_other", stripeObjectId: "pi_other" }); const value = await list(); expect(value.entries[0].state).toBe("needs_review"); expect(JSON.stringify(value)).not.toMatch(/PRIVATE_FOREIGN|foreign-key|pi_other/);
});
test("multiple funding attempts are separate records and are never summed as received money", async () => {
  await funded({ status: "failed", stripeChargeId: null }); await Operation.collection.insertOne({ ...funding, _id: new Types.ObjectId(), operationKey: `funding:${matter._id}:pi_second`, stripePaymentIntentId: "pi_second", stripeObjectId: "pi_second", status: "pending" }); const value = await list(); expect(value.total).toBe(2); expect(value.entries.map(row => row.state).sort()).toEqual(["failed", "pending"]); expect(value.summary.currencies[0].originalFunding).toBe(0);
});
test.each(["pending", "failed", "reversed", "needs_reconciliation", null])("a %s payout is not included in recorded payout totals", async status => {
  await funded(); await withdrawal(); await Payout.collection.updateMany({}, { $set: { status } }); const value = await list({ view: "payout" }); expect(value.total).toBe(1); expect(value.entries[0].state).not.toBe("recorded"); expect(value.summary.currencies[0]).toMatchObject({ paralegalPayouts: 0, payoutRecords: 0, payoutsUnverified: 1 });
});
test("an unresolved matching operation prevents a paid ledger row from being presented as reconciled", async () => {
  await withdrawal(); await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter._id, kind: "partial_payout", operationKey: "partial_pending", status: "needs_reconciliation", stripeObjectId: "tr_history", amount: 8100, currency: "usd" }); const value = await list({ view: "payout" }); expect(value.total).toBe(1); expect(value.entries[0].state).toBe("needs_review"); expect(value.summary.currencies[0].paralegalPayouts).toBe(0);
});
test("a foreign retained transfer reference removes the verified payout claim and invalidates the old CSV", async () => {
  await withdrawal(); const before = await list({ view: "payout" }); expect(before.entries[0].state).toBe("recorded");
  await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: new Types.ObjectId(), operationKey: "PRIVATE_FOREIGN_TRANSFER", kind: "partial_payout", status: "succeeded", stripeTransferId: "tr_history", amount: 8100, currency: "usd" });
  const after = await list({ view: "payout" }); expect(after.entries[0].state).toBe("needs_review"); expect(after.summary.currencies[0].paralegalPayouts).toBe(0); expect(JSON.stringify(after)).not.toContain("PRIVATE_FOREIGN"); expect((await get({ view: "payout", revision: before.revision }, owner, true)).status).toBe(409);
});
test("a changed current Matter payout status cannot be overridden by a stale paid payout record", async () => {
  await withdrawal(); await change({ payoutTransferId: "tr_history", payoutStatus: "reversed" }); const value = await list({ view: "payout" }); expect(value.entries[0].state).toBe("needs_review"); expect(value.summary.currencies[0].paralegalPayouts).toBe(0);
});
test("withdrawal decisions remain individually listed when a payout exists and repeated assignments cannot borrow it", async () => {
  const { record } = await withdrawal({ payoutTransferId: null }); await change({ withdrawalHistory: [record, { ...record, payoutFinalizedAt: new Date("2026-02-05"), pausedAt: new Date("2026-02-04"), partialPayoutAmount: 20000 }] });
  const decisions = await list({ view: "withdrawal" }); expect(decisions.total).toBe(2); expect(new Set(decisions.entries.map(row => row.receiptId)).size).toBe(2); expect(decisions.entries.map(row => row.amount).sort()).toEqual([10000, 20000]);
  const payouts = await list({ view: "payout" }); expect(payouts.entries[0].state).toBe("needs_review"); expect(payouts.entries[0].receiptId).toBeNull(); expect(payouts.summary.currencies[0].paralegalPayouts).toBe(0);
});
test("a single pending payout request remains visible even before a transfer or payout record exists", async () => {
  await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter._id, kind: "case_payout", operationKey: `case_payout:${matter._id}`, status: "pending", amount: 32400, currency: "usd", createdAt: new Date("2026-01-02") }); const value = await list({ view: "payout" }); expect(value.entries).toHaveLength(1); expect(value.entries[0]).toMatchObject({ state: "pending", amount: 32400, basis: "payout_request", receiptId: null });
});
test("refund request success is not treated as a processed refund or silently deducted from original funding", async () => {
  await funded(); await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter._id, operationKey: "refund_request", kind: "refund", status: "succeeded", amount: 10000, refundAmount: 10000, stripeRefundId: "re_pending", currency: "usd", createdAt: new Date("2026-01-04") }); const value = await list(); expect(value.entries.find(row => row.type === "refund")).toMatchObject({ amount: 10000, state: "unconfirmed", basis: "refund_request", receiptId: "payment" }); expect(value.summary.currencies[0].originalFunding).toBe(48800); expect(value.summary.requiresReview).toBe(1);
});
test("currency disagreements never relabel a refund or payout request into the Matter currency", async () => {
  await Operation.collection.insertMany(["refund", "partial_payout"].map(kind => ({ _id: new Types.ObjectId(), caseId: matter._id, operationKey: kind, kind, status: "pending", amount: 10000, currency: "eur" }))); const value = await list(); for (const row of value.entries.filter(row => row.type !== "funding")) expect(row).toMatchObject({ amount: null, state: "needs_review" });
});
test("zero and unconfirmed positive withdrawal decisions remain distinct from actual payout records", async () => {
  await change({ withdrawalHistory: [{ withdrawnParalegalId: para._id, payoutFinalizedAt: new Date("2026-01-04"), payoutFinalizedType: "zero_auto", partialPayoutAmount: 0 }, { withdrawnParalegalId: new Types.ObjectId(), payoutFinalizedAt: new Date("2026-01-05"), payoutFinalizedType: "partial_attorney", partialPayoutAmount: 10000 }] }); const value = await list({ view: "withdrawal" }); expect(value.total).toBe(2); expect(value.entries.every(row => row.state === "decision_recorded" && row.basis === "withdrawal_decision")).toBe(true); expect(value.summary.currencies[0].paralegalPayouts).toBe(0);
});
test.each(["dp_history", "du_history"])("platform chargeback adjustments for %s never become additional attorney charges", async stripeDisputeId => {
  await funded(); const operation = { _id: new Types.ObjectId(), caseId: matter._id, operationKey: "chargeback_record", kind: "chargeback", status: "succeeded", amount: 10000, currency: "usd", evidenceStatus: "verified", stripeChargeId: "ch_history", stripeDisputeId, stripeMode: "test", createdAt: new Date("2026-01-04") }; await Operation.collection.insertOne(operation); await Adjustment.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter._id, paymentOperationId: operation._id, idempotencyKey: "processor_fee", amount: 2500, currency: "usd", direction: "debit", adjustmentType: "processor_dispute_fee" }); const value = await list(); expect(value.entries.find(row => row.type === "chargeback")).toMatchObject({ amount: 10000, basis: "card_dispute", state: "recorded" }); expect(value.summary.currencies[0].originalFunding).toBe(48800); expect(JSON.stringify(value)).not.toContain("2500");
});
test("different currencies stay in separate totals and unsupported minor units remain unverified", async () => {
  await funded(); const euroCase = { ...matter, _id: new Types.ObjectId(), title: "Euro contract", currency: "eur", paymentIntentId: "pi_eur", escrowIntentId: "pi_eur" }; await Case.collection.insertOne(euroCase); await Operation.collection.insertOne({ ...funding, _id: new Types.ObjectId(), caseId: euroCase._id, operationKey: `funding:${euroCase._id}:pi_eur`, stripePaymentIntentId: "pi_eur", stripeObjectId: "pi_eur", stripeChargeId: "ch_eur", stripeBalanceTransactionId: "txn_eur", currency: "eur" }); expect((await list()).summary.currencies.map(group => [group.currency, group.originalFunding])).toEqual([["EUR", 48800], ["USD", 48800]]);
  await change({ currency: "jpy" }); const value = await list({ caseId: String(matter._id) }); expect(value.entries[0]).toMatchObject({ currency: null, amount: null, state: "needs_review" }); expect(value.summary.currencies).toEqual([]);
});
test("paging and CSV include every filtered record beyond the old five-hundred-row export cap", async () => {
  await Case.collection.insertMany(Array.from({ length: 505 }, (_, index) => ({ ...matter, _id: new Types.ObjectId(), title: `Earlier funding ${index}`, paymentIntentId: `pi_older_${index}`, escrowIntentId: `pi_older_${index}` })));
  const first = await list({ q: "Earlier funding" }); expect(first.total).toBe(505); expect(first.entries).toHaveLength(50); const second = await list({ q: "Earlier funding", cursor: first.nextCursor, revision: first.revision }); expect(second.entries).toHaveLength(50); expect(new Set([...first.entries, ...second.entries].map(row => row.id)).size).toBe(100);
  const csv = await get({ q: "Earlier funding", revision: first.revision }, owner, true); expect(csv.status).toBe(200); expect(csv.headers["content-type"]).toContain("text/csv"); expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(506); expect(csv.text).toContain('"Earlier funding 504"'); expect(csv.headers["content-disposition"]).toContain("LPC-payment-history.csv"); expect(csv.headers["cache-control"]).toContain("no-store");
});
test("CSV preserves integer cents, quotes and line breaks while neutralizing spreadsheet formulas", async () => {
  await change({ title: '=HYPERLINK("https://example.invalid")\nMatter, exhibits' }); await funded(); const value = await list(), csv = await get({ revision: value.revision }, owner, true); expect(csv.status).toBe(200); expect(csv.text).toContain('"\'=HYPERLINK(""https://example.invalid"")\nMatter, exhibits"'); expect(csv.text).toContain('"488.00"'); expect(csv.text).toContain("Original payment before refunds"); expect(csv.text).not.toMatch(/PRIVATE_|processingFeeAmount/);
});
test("changed records and filter mismatches cannot produce an old or partial CSV", async () => {
  await funded(); const value = await list(); expect((await get({}, owner, true)).status).toBe(400); expect((await get({ revision: value.revision, q: "another" }, owner, true)).status).toBe(409); await Operation.collection.updateOne({ _id: funding._id }, { $set: { status: "needs_reconciliation" } }); expect((await get({ revision: value.revision }, owner, true)).status).toBe(409); expect((await get({ cursor: "50", revision: value.revision })).status).toBe(409);
});
test("fresh ownership, account and input checks protect global and exact Matter financial reads", async () => {
  expect((await get({}, para)).status).toBe(403); expect((await get({}, other)).body.total).toBe(0); expect([403, 404]).toContain((await get({ caseId: String(matter._id) }, other)).status); expect((await get({ expectedOwnerId: String(other._id) })).status).toBe(403);
  for (const query of [{ view: "paid" }, { q: "a".repeat(101) }, { cursor: "50" }, { arbitrary: "value" }]) expect((await get(query)).status).toBe(400); await change({ attorneyId: other._id }); expect((await get()).status).toBe(409); await change({ attorneyId: owner._id }); await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); expect((await get()).status).toBe(403);
});
test("read failures and malformed retained history are unavailable rather than an empty financial record", async () => {
  const spy = jest.spyOn(Operation.collection, "find").mockImplementationOnce(() => { throw new Error("Synthetic records unavailable"); }); expect((await get()).status).toBe(503); spy.mockRestore(); await change({ withdrawalHistory: { malformed: true } }); expect((await get()).status).toBe(409);
});
const retainedRefund = async (patch = {}) => {
  const operation = { _id: new Types.ObjectId(), caseId: matter._id, operationKey: "refund_history", kind: "refund", status: "succeeded", amount: 10000, refundAmount: 10000, stripeRefundId: "re_history", stripePaymentIntentId: "pi_history", stripeChargeId: "ch_history", currency: "usd", stripeMode: "test", refundStatus: "succeeded", refundEvidenceStatus: "verified", refundVerifiedAt: new Date("2026-01-06"), refundCreatedAt: new Date("2026-01-04"), createdAt: new Date("2026-01-02"), ...patch };
  await Operation.collection.insertOne(operation); return operation;
};
test("verified refund history records the completed refund separately from original funding and payouts", async () => {
  await funded(); await withdrawal(); await retainedRefund(); const value = await list();
  expect(value.entries.find(row => row.type === "refund")).toMatchObject({ state: "recorded", basis: "refund_processed", amount: 10000, recordedAt: "2026-01-04T00:00:00.000Z" });
  expect(value.summary.currencies[0]).toMatchObject({ originalFunding: 48800, paralegalPayouts: 8100, refunds: 10000, refundRecords: 1 });
});
test("verified refund history keeps a pending refund out of processed totals", async () => {
  await retainedRefund({ refundStatus: "pending" }); const value = await list({ view: "refund" });
  expect(value.entries[0]).toMatchObject({ state: "pending", basis: "refund_pending" }); expect(value.summary.currencies[0]).toMatchObject({ refunds: 0, refundRecords: 0, refundsUnverified: 1 });
});
test("verified refund history is independent of the combined settlement payout status", async () => {
  await retainedRefund({ kind: "dispute_settlement", status: "needs_reconciliation", evidenceStatus: "quarantined", stripeTransferId: "tr_other_leg", transferAmount: 8100 }); const value = await list({ view: "refund" });
  expect(value.entries[0]).toMatchObject({ state: "recorded", amount: 10000 }); expect(value.summary.currencies[0].refunds).toBe(10000);
});
test("verified refund history does not replace a missing provider date with the operation date", async () => {
  await retainedRefund({ refundCreatedAt: null }); const value = await list({ view: "refund" });
  expect(value.entries[0]).toMatchObject({ state: "recorded", recordedAt: null }); expect(value.summary.undated).toBe(1);
});
test.each([["requires_action", "requires_action", "refund_action"], ["failed", "failed", "refund_failed"], ["canceled", "canceled", "refund_canceled"]])("a verified %s refund retains its outcome and stays out of completed totals", async (refundStatus, state, basis) => {
  await retainedRefund({ refundStatus }); const value = await list({ view: "refund" });
  expect(value.entries[0]).toMatchObject({ state, basis, amount: 10000 }); expect(value.summary.currencies[0]).toMatchObject({ refunds: 0, refundRecords: 0, refundsUnverified: 1 });
  expect((await list({ view: "review" })).entries.some(row => row.type === "refund")).toBe(refundStatus === "requires_action");
});
test.each([{ refundEvidenceStatus: "needs_review" }, { refundVerifiedAt: null }, { refundStatus: null }, { refundAmount: 48801 }, { refundAmount: 0 }, { stripePaymentIntentId: "pi_other" }, { stripeChargeId: null }, { stripeMode: "live" }, { stripeMode: "unknown" }, { currency: "eur" }, { stripeObjectId: "re_other" }])("inconsistent refund evidence %j cannot become a completed refund amount", async patch => {
  await retainedRefund(patch); const value = await list({ view: "refund" }); expect(value.entries[0].state).toBe("needs_review"); expect(value.summary.currencies[0].refunds).toBe(0);
});
test("refund references retained on another Matter cannot enter this owner's totals or disclose that Matter", async () => {
  const operation = await retainedRefund(); await Operation.collection.insertOne({ ...operation, _id: new Types.ObjectId(), caseId: new Types.ObjectId(), operationKey: "PRIVATE_FOREIGN_REFUND" });
  const value = await list({ view: "refund" }); expect(value.entries[0].state).toBe("needs_review"); expect(value.summary.currencies[0].refunds).toBe(0); expect(JSON.stringify(value)).not.toContain("PRIVATE_FOREIGN");
});
test("unsupported refund minor units remain an unavailable amount with a consistent review description", async () => {
  await change({ currency: "jpy" }); await retainedRefund({ currency: "jpy" }); const value = await list({ view: "refund" });
  expect(value.entries[0]).toMatchObject({ state: "needs_review", basis: "refund_request", amount: null, currency: null }); expect(value.summary.currencies).toEqual([]);
});
test("conflicting original payment and captured-charge references prevent refund certification", async () => {
  await funded({ stripeChargeId: "ch_other" }); await retainedRefund(); expect((await list({ view: "refund" })).entries[0].state).toBe("needs_review");
  await Operation.collection.deleteOne({ _id: funding._id }); await change({ escrowIntentId: "pi_other" }); expect((await list({ view: "refund" })).entries[0].state).toBe("needs_review");
});
test("separate verified partial refunds are counted once and an impossible aggregate requires review", async () => {
  await retainedRefund({ refundAmount: 30000, amount: 30000 }); await retainedRefund({ operationKey: "second_refund", stripeRefundId: "re_second", refundAmount: 18800, amount: 18800 });
  expect((await list({ view: "refund" })).summary.currencies[0]).toMatchObject({ refunds: 48800, refundRecords: 2 });
  await Operation.collection.updateOne({ operationKey: "second_refund" }, { $set: { refundAmount: 18801, amount: 18801 } }); const value = await list({ view: "refund" });
  expect(value.entries.every(row => row.state === "needs_review")).toBe(true); expect(value.summary.currencies[0].refunds).toBe(0);
});
test("CSV reflects the exact refund evidence and rejects a previously reviewed refund after its status changes", async () => {
  const operation = await retainedRefund(); const value = await list({ view: "refund" }), csv = await get({ view: "refund", revision: value.revision }, owner, true);
  expect(csv.status).toBe(200); expect(csv.text).toContain('"Refund","Recorded","USD","100.00","Refund recorded by Stripe","2026-01-04T00:00:00.000Z"');
  await Operation.collection.updateOne({ _id: operation._id }, { $set: { refundStatus: "failed" } }); expect((await get({ view: "refund", revision: value.revision }, owner, true)).status).toBe(409);
});
test("an actual refund callback supplies the evidence displayed by history without a second provider read", async () => {
  const Delivery = require("../models/WebhookEvent"), Audit = require("../models/AuditLog"); await Promise.all([Delivery.init(), Audit.init()]);
  const refund = { id: "re_from_callback", object: "refund", status: "succeeded", amount: 10000, currency: "usd", charge: "ch_history", payment_intent: "pi_history", created: 1767484800 };
  const charge = { id: "ch_history", object: "charge", payment_intent: "pi_history", paid: true, captured: true, status: "succeeded", amount: 48800, amount_captured: 48800, amount_refunded: 10000, currency: "usd", livemode: false, disputed: false };
  stripe.refunds.retrieve.mockResolvedValue(refund); stripe.refunds.list.mockResolvedValue({ data: [refund], has_more: false }); stripe.charges.retrieve.mockResolvedValue(charge);
  stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_history", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, latest_charge: charge, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) } });
  const event = { id: "evt_refund_history", type: "refund.updated", livemode: false, created: 1788955200, data: { object: refund } };
  const receipt = await Delivery.create({ eventId: event.id, type: event.type, status: "processing", attempts: 1, lastAttemptAt: new Date(), stripeMode: "test" });
  await require("../services/attorneyRefundEvents").record({ event, receiptFilter: { _id: receipt._id, eventId: event.id, status: "processing", attempts: 1, lastAttemptAt: receipt.lastAttemptAt }, stripe });
  const value = await list({ view: "refund" }); expect(value.entries[0]).toMatchObject({ state: "recorded", amount: 10000, basis: "refund_processed" }); expect(value.summary.currencies[0].refunds).toBe(10000);
  expect(stripe.refunds.list).toHaveBeenCalledTimes(1); expect(stripe.refunds.retrieve).toHaveBeenCalledTimes(1); expect(stripe.transfers.create).not.toHaveBeenCalled();
  const reviewed = await request(app).get(`/api/payments/receipt/attorney/${matter._id}/review`).set("Cookie", cookie(owner)).query({ expectedOwnerId: String(owner._id) });
  expect({ status: reviewed.status, body: reviewed.body }).toMatchObject({ status: 200, body: { receipt: { status: "partially_refunded", total: { amount: 38800 } } } });
  expect(reviewed.body.receipt.lines).toEqual(expect.arrayContaining([{ label: "Original payment", amount: 48800 }, { label: "Refunds processed", amount: value.summary.currencies[0].refunds }]));
});

test("attorney CSV retains funding and gross decisions without disclosing paralegal net payout", async () => {
  await funded(); await withdrawal(); const value = await list();
  const response = await get({ revision: value.revision }, owner, true);
  expect(response.status).toBe(200);
  expect(response.text).toContain('"488.00"');
  expect(response.text).toContain('"100.00"');
  expect(response.text).not.toContain('"81.00"');
  expect(response.text).not.toContain('Net amount in payout record');
  expect(response.text).toContain('Payment release record; see Matter release amount');
});
