const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { Types } = require("mongoose");
const User = require("../models/User");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/stripe", () => ({ paymentIntents: { retrieve: jest.fn() }, refunds: { list: jest.fn() }, disputes: { list: jest.fn() } }));
jest.mock("../services/caseLifecycle", () => ({ buildReceiptPdfBuffer: jest.fn(), uploadPdfToS3: jest.fn(), getReceiptKey: jest.fn() }));
const stripe = require("../utils/stripe");
const lifecycle = require("../services/caseLifecycle");
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use("/api/payments", require("../routes/payments"));
const pdf = Buffer.from("%PDF-1.4\nSynthetic receipt\n");
let attorney, other, paralegal, caseId, intent;
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const path = () => `/api/payments/receipt/attorney/${caseId}`;
const review = (user = attorney, expectedOwnerId = String(user._id)) => request(app).get(`${path()}/review`).query({ expectedOwnerId }).set("Cookie", cookie(user));
const download = (revision, user = attorney) => request(app).get(path()).query(revision === undefined ? {} : { revision, expectedOwnerId: String(user._id) }).set("Cookie", cookie(user)).buffer(true);
const raw = () => Case.collection.findOne({ _id: caseId });
const change = fields => Case.collection.updateOne({ _id: caseId }, { $set: fields });
const refund = (n, amount, status = "succeeded") => ({ id: `re_${n}`, amount, status, currency: "usd", payment_intent: intent.id, charge: intent.latest_charge.id });
const recoveredDispute = (id = "dp_receipt") => ({
  id, object: "dispute", amount: 48800, currency: "usd", livemode: false,
  charge: "ch_receipt", payment_intent: "pi_receipt", status: "won",
  balance_transactions: [
    { id: `txn_${id}_debit`, object: "balance_transaction", source: id, amount: -48800, fee: 1500, net: -50300, currency: "usd", reporting_category: "dispute" },
    { id: `txn_${id}_credit`, object: "balance_transaction", source: id, amount: 48800, fee: 0, net: 48800, currency: "usd", reporting_category: "dispute_reversal" },
  ],
});
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [attorney, other, paralegal] = await User.create([
    { firstName: "Avery", lastName: "Lane", email: "receipt-owner@example.test", password: "SyntheticPassword123!", role: "attorney", status: "approved", stripeCustomerId: "cus_owner" },
    { firstName: "Blair", lastName: "Other", email: "receipt-other@example.test", password: "SyntheticPassword123!", role: "attorney", status: "approved" },
    { firstName: "Casey", lastName: "Payee", email: "receipt-payee@example.test", password: "SyntheticPassword123!", role: "paralegal", status: "approved" },
  ]);
  caseId = new Types.ObjectId();
  await Case.collection.insertOne({ _id: caseId, attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, title: "Agreement review", status: "in progress", totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, escrowIntentId: "pi_receipt", paymentIntentId: "pi_receipt", escrowStatus: "funded", fundingIntegrityStatus: "verified", currency: "usd", stripeMode: "test", notes: { private: "preserve this" }, unknownField: { version: 71 } });
  intent = { id: "pi_receipt", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, customer: "cus_owner", metadata: { caseId: String(caseId), attorneyId: String(attorney._id) }, transfer_group: `case_${caseId}`, latest_charge: { id: "ch_receipt", payment_intent: "pi_receipt", amount_captured: 48800, amount_refunded: 0, currency: "usd", paid: true, captured: true, disputed: false, created: 1788566400, payment_method_details: { card: { brand: "visa", last4: "4242", fingerprint: "PRIVATE_PROCESSOR_VALUE" } } } };
  stripe.paymentIntents.retrieve.mockReset().mockImplementation(async () => structuredClone(intent));
  stripe.refunds.list.mockReset().mockResolvedValue({ data: [], has_more: false });
  stripe.disputes.list.mockReset().mockResolvedValue({ data: [], has_more: false });
  lifecycle.buildReceiptPdfBuffer.mockReset().mockResolvedValue(pdf);
});

test("receipt review is account-bound, projected and read-only; existing direct downloads use fresh evidence", async () => {
  const before = await raw(), response = await review(); expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body).toMatchObject({ caseId: String(caseId), ownerId: String(attorney._id), reason: "available", receipt: { type: "payment", status: "received", currency: "USD", partyName: "Avery Lane", total: { label: "Total paid", amount: 48800 } } });
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_PROCESSOR_VALUE|cus_owner|unknownField|notes|ch_receipt/);
  expect(await raw()).toEqual(before); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
  const result = await download(); expect(result.status).toBe(200); expect(result.body).toEqual(pdf); expect(result.headers["content-type"]).toContain("application/pdf"); expect(result.headers["x-content-type-options"]).toBe("nosniff"); expect(result.headers["content-disposition"]).toContain("Agreement%20review-payment-receipt.pdf");
  expect(lifecycle.uploadPdfToS3).not.toHaveBeenCalled(); expect(await raw()).toEqual(before);
  expect(lifecycle.buildReceiptPdfBuffer).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: "$488.00", paymentStatus: "Payment confirmed", dateLabel: "Payment date" }));
});
test("renewed sign-ins can obtain receipts and a security change during rendering suppresses delivery", async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $set: { authVersion: 1 } }); attorney.authVersion = 1;
  const response = await review(); expect(response.status).toBe(200); expect((await download(response.body.revision)).status).toBe(200);
  lifecycle.buildReceiptPdfBuffer.mockImplementation(async () => { await User.collection.updateOne({ _id: attorney._id }, { $set: { authVersion: 2 } }); return pdf; });
  const result = await download(); expect(result.status).toBe(403); expect(result.body.code).toBe("RECEIPT_ACCOUNT_CHANGED");
});
test("a historically disputed payment retains its receipt after the provider confirms recovery", async () => {
  intent.latest_charge.disputed = true;
  stripe.disputes.list.mockResolvedValue({ data: [recoveredDispute()], has_more: false });
  const before = await raw(), response = await review();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ reason: "available", receipt: { status: "received", total: { amount: 48800 } } });
  expect((await download(response.body.revision)).status).toBe(200);
  expect(await raw()).toEqual(before);
  expect(stripe.disputes.list).toHaveBeenCalledWith({ charge: "ch_receipt", limit: 100 }, { timeout: 10000, maxNetworkRetries: 0 });
});
test.each([
  ["active", value => { value.status = "under_review"; }],
  ["lost", value => { value.status = "lost"; }],
  ["another charge", value => { value.charge = "ch_other"; }],
  ["another intent", value => { value.payment_intent = "pi_other"; }],
  ["another currency", value => { value.currency = "eur"; }],
  ["another mode", value => { value.livemode = true; }],
  ["another Matter", value => { value.metadata = { caseId: String(new Types.ObjectId()) }; }],
  ["zero amount", value => { value.amount = 0; }],
  ["excess amount", value => { value.amount = 48801; }],
  ["missing balances", value => { value.balance_transactions = []; }],
  ["principal not recovered", value => { value.balance_transactions.pop(); }],
  ["partial recovery", value => { value.balance_transactions[1].amount--; value.balance_transactions[1].net--; }],
  ["unrelated balance", value => { value.balance_transactions[1].source = "dp_other"; }],
  ["balance currency", value => { value.balance_transactions[1].currency = "eur"; }],
  ["balance arithmetic", value => { value.balance_transactions[1].net--; }],
  ["duplicate balance", value => { value.balance_transactions.push(value.balance_transactions[1]); }],
  ["unknown balance category", value => { value.balance_transactions[1].reporting_category = "unverified"; }],
])("%s card-dispute evidence cannot produce a recovered payment receipt", async (_label, edit) => {
  intent.latest_charge.disputed = true;
  const dispute = recoveredDispute(); edit(dispute);
  stripe.disputes.list.mockResolvedValue({ data: [dispute], has_more: false });
  const before = await raw();
  expect((await review()).body).toMatchObject({ reason: "needs_review", receipt: null, revision: null });
  expect((await download()).status).toBe(409);
  expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled(); expect(await raw()).toEqual(before);
});
test.each(["warning_closed", "prevented"])("a %s dispute with no withdrawn funds preserves the original receipt", async status => {
  intent.latest_charge.disputed = true;
  stripe.disputes.list.mockResolvedValue({ data: [{ ...recoveredDispute(), status, balance_transactions: [] }], has_more: false });
  expect((await review()).body).toMatchObject({ reason: "available", receipt: { total: { amount: 48800 } } });
});
test("every card-dispute page must be complete and recovered before a receipt is available", async () => {
  intent.latest_charge.disputed = true;
  const first = recoveredDispute(), second = recoveredDispute("du_second");
  stripe.disputes.list.mockImplementation(async params => params.starting_after ? { data: [second], has_more: false } : { data: [first], has_more: true });
  expect((await review()).body.reason).toBe("available");
  expect(stripe.disputes.list.mock.calls[1][0].starting_after).toBe(first.id);
  second.status = "under_review";
  expect((await review()).body.reason).toBe("needs_review");
  stripe.disputes.list.mockResolvedValue({ data: [first], has_more: true });
  expect((await review()).body.reason).toBe("needs_review");
  stripe.disputes.list.mockResolvedValue({ data: [], has_more: true });
  expect((await review()).body.reason).toBe("needs_review");
});
test("a provider card-dispute failure stays unavailable and never supplies a cached receipt", async () => {
  intent.latest_charge.disputed = true;
  stripe.disputes.list.mockRejectedValue(new Error("Synthetic dispute read failed"));
  expect((await review()).status).toBe(503); expect((await download()).status).toBe(503);
  expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test("changed recovery evidence invalidates a reviewed receipt and blocks changes during PDF rendering", async () => {
  intent.latest_charge.disputed = true;
  const dispute = recoveredDispute();
  stripe.disputes.list.mockImplementation(async () => ({ data: [structuredClone(dispute)], has_more: false }));
  const before = await review(); expect(before.body.reason).toBe("available");
  dispute.balance_transactions[1].fee = -1500; dispute.balance_transactions[1].net = 50300;
  expect((await download(before.body.revision)).status).toBe(409);
  expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
  lifecycle.buildReceiptPdfBuffer.mockImplementation(async () => { dispute.status = "under_review"; return pdf; });
  expect((await download()).status).toBe(409);
});
test("anonymous, other owners, paralegals, admins and a changed expected account cannot inspect receipts", async () => {
  expect((await request(app).get(`${path()}/review`)).status).toBe(401);
  expect((await review(other)).status).toBe(403); expect((await review(paralegal)).status).toBe(403);
  await User.collection.updateOne({ _id: other._id }, { $set: { role: "admin" } }); other.role = "admin"; expect((await review(other)).status).toBe(403);
  expect((await review(attorney, String(other._id))).status).toBe(403); expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test.each([{ disabled: true }, { deleted: true }, { status: "pending" }, { authVersion: 1 }])("current account restrictions deny receipt access: %j", async fields => {
  await User.collection.updateOne({ _id: attorney._id }, { $set: fields }); expect((await review()).status).toBe(403); expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("historical text owners and missing fee snapshots remain readable without repairs or invented dates", async () => {
  await change({ attorney: String(attorney._id), attorneyId: String(attorney._id), feeAttorneyAmount: 0, fundingIntegrityStatus: "pending" }); delete intent.metadata; delete intent.transfer_group; delete intent.latest_charge.created;
  const before = await raw(), response = await review(); expect(response.status).toBe(200); expect(response.body.receipt.issuedAt).toBeNull(); expect(response.body.receipt.lines).toContainEqual({ label: "Platform fee (22%)", amount: 8800 });
  expect((await download(response.body.revision)).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls[0][0].issuedAt).toBe("Date unavailable"); expect(await raw()).toEqual(before);
});
test("contradictory owner or funding aliases never select an arbitrary receipt", async () => {
  await change({ attorneyId: other._id });
  const before = await raw(), rejected = await review();
  expect({ status: rejected.status, body: rejected.body }).toEqual({ status: 409, body: { code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." } });
  expect(await raw()).toEqual(before);
  expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
  await change({ attorneyId: attorney._id, paymentIntentId: "pi_other" }); expect((await review()).body.reason).toBe("needs_review"); expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test.each([
  ["processing", "payment_pending"], ["requires_action", "payment_pending"], ["requires_capture", "payment_pending"], ["requires_confirmation", "payment_pending"], ["requires_payment_method", "not_funded"], ["canceled", "payment_canceled"], ["unrecognized", "needs_review"],
])("%s cannot produce a paid PDF even when the Case says funded", async (status, reason) => {
  intent.status = status; const response = await review(); expect(response.body).toMatchObject({ reason, receipt: null, revision: null }); expect((await download()).status).toBe(409); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test("failed and missing funding are described without inferring a successful payment", async () => {
  intent.status = "requires_payment_method"; intent.last_payment_error = { message: "PRIVATE_PROCESSOR_ERROR" }; expect((await review()).body.reason).toBe("payment_failed");
  await change({ paymentIntentId: null, escrowIntentId: null, escrowStatus: null, fundingIntegrityStatus: null }); expect((await review()).body.reason).toBe("not_funded");
  await change({ escrowStatus: "funded" }); expect((await review()).body.reason).toBe("needs_review");
});
test.each([
  ["amount", value => { value.amount_received = 48799; }], ["currency", value => { value.currency = "eur"; }], ["metadata", value => { value.metadata.caseId = String(new Types.ObjectId()); }], ["customer", value => { value.customer = "cus_other"; }], ["mode", value => { value.livemode = true; }], ["capture", value => { value.latest_charge.captured = false; }], ["chargeback", value => { value.latest_charge.disputed = true; }], ["missing captured amount", value => { delete value.latest_charge.amount_captured; }],
])("%s disagreement prevents a receipt", async (_label, edit) => { edit(intent); expect((await review()).body.reason).toBe("needs_review"); expect((await download()).status).toBe(409); });
test("an intent referenced by another Matter, unsupported currency or failed funding integrity needs review", async () => {
  const duplicate = new Types.ObjectId(); await Case.collection.insertOne({ _id: duplicate, paymentIntentId: intent.id }); expect((await review()).body.reason).toBe("needs_review"); await Case.collection.deleteOne({ _id: duplicate });
  await change({ currency: "jpy" }); expect((await review()).body.reason).toBe("needs_review");
  await change({ currency: "usd", fundingIntegrityStatus: "failed" }); expect((await review()).body.reason).toBe("needs_review");
});
test("matching but invented processor currency evidence cannot produce a payment receipt", async () => {
  intent.currency = "zzz"; intent.latest_charge.currency = "zzz"; await change({ currency: "zzz" });
  expect((await review()).body.reason).toBe("needs_review"); expect((await download()).status).toBe(409); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test.each([
  ["succeeded", 10000, "partially_refunded", 38800], ["succeeded", 48800, "refunded", 0], ["pending", 10000, "refund_pending", 48800], ["requires_action", 10000, "refund_pending", 48800], ["failed", 10000, "refund_failed", 48800], ["canceled", 10000, "received", 48800],
])("%s refund of %i preserves original payment and accurate remaining amount", async (state, amount, status, remaining) => {
  intent.latest_charge.amount_refunded = ["succeeded", "pending", "requires_action"].includes(state) ? amount : 0;
  stripe.refunds.list.mockResolvedValue({ data: [refund(1, amount, state)], has_more: false });
  await change({ remainingAmount: 5000, disputeSettlement: { action: "release_partial", grossAmount: 5000 } });
  const response = await review(); expect(response.body.receipt).toMatchObject({ status, total: { amount: remaining } }); expect(response.body.receipt.lines[0].amount).toBe(40000);
  expect((await download(response.body.revision)).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls[0][0].paymentStatus).not.toBe("Paid in full");
});
test("refund paging reads all pages; incomplete, duplicate and inconsistent evidence never becomes zero refunds", async () => {
  intent.latest_charge.amount_refunded = 101;
  stripe.refunds.list.mockImplementation(async params => params.starting_after ? { data: [refund(101, 1)], has_more: false } : { data: Array.from({ length: 100 }, (_, i) => refund(i + 1, 1)), has_more: true });
  expect((await review()).body.receipt.total.amount).toBe(48699); expect(stripe.refunds.list.mock.calls[1][0].starting_after).toBe("re_100");
  stripe.refunds.list.mockResolvedValue({ data: [refund(1, 1)], has_more: true }); expect((await review()).body.reason).toBe("needs_review");
  stripe.refunds.list.mockResolvedValue({ data: [], has_more: false }); expect((await review()).body.reason).toBe("needs_review");
});
test("provider failures and invalid PDFs are explicit failures, with no stale cache or payment mutations", async () => {
  stripe.paymentIntents.retrieve.mockRejectedValueOnce(new Error("Synthetic connection failure")); expect((await review()).status).toBe(503);
  stripe.refunds.list.mockRejectedValueOnce(new Error("Synthetic refunds failure")); expect((await review()).status).toBe(503);
  lifecycle.buildReceiptPdfBuffer.mockResolvedValue(Buffer.from("<html>Error</html>")); expect((await download()).status).toBe(503); expect(lifecycle.uploadPdfToS3).not.toHaveBeenCalled();
});
test("receipt revisions bind the reviewed amount and reject a new refund before rendering", async () => {
  const before = await review(); intent.latest_charge.amount_refunded = 100;
  stripe.refunds.list.mockResolvedValue({ data: [refund(1, 100)], has_more: false });
  expect((await download(before.body.revision)).status).toBe(409); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
  expect((await download("invalid")).status).toBe(400);
});
test.each(["ownership", "disabled", "amount", "refund"])("%s changing while a PDF is built prevents delivery", async kind => {
  lifecycle.buildReceiptPdfBuffer.mockImplementation(async () => {
    if (kind === "ownership") await change({ attorney: other._id, attorneyId: other._id });
    if (kind === "disabled") await User.collection.updateOne({ _id: attorney._id }, { $set: { disabled: true } });
    if (kind === "amount") await change({ feeAttorneyAmount: 9000 });
    if (kind === "refund") { intent.latest_charge.amount_refunded = 100; stripe.refunds.list.mockResolvedValue({ data: [refund(1, 100)], has_more: false }); }
    return pdf;
  });
  const response = await download(); expect([403, 404, 409]).toContain(response.status); expect(response.headers["content-type"]).not.toContain("application/pdf");
});
test("ownership changes during provider retrieval clear the private review", async () => {
  stripe.paymentIntents.retrieve.mockImplementation(async () => { await change({ attorney: other._id, attorneyId: other._id }); return intent; });
  const response = await review(); expect(response.status).toBe(404); expect(JSON.stringify(response.body)).not.toContain("Agreement review");
});
async function withdraw(gross = 10000, status = "paid") {
  await change({ withdrawnParalegalId: paralegal._id, payoutFinalizedAt: new Date("2026-09-01T10:00:00Z"), payoutFinalizedType: gross ? "partial_attorney" : "zero_auto", partialPayoutAmount: gross, paymentReleased: false });
  if (gross) await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId, paralegalId: paralegal._id, stripeMode: "test", status, amountPaid: 8100, transferId: "tr_withdrawal", createdAt: new Date("2026-09-01T10:00:00Z") });
}
test("attorney withdrawal receipt uses the confirmed payout ledger and shows the gross amount released", async () => {
  await withdraw(); const before = await raw(), response = await review(); expect(response.body.receipt).toMatchObject({ type: "withdrawal", status: "payout_recorded", total: { amount: 10000 } });
  expect(response.body.receipt.lines).toEqual([{ label: "Amount released from Matter", amount: 10000 }]);
  expect((await download(response.body.revision)).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls[0][0]).toMatchObject({ testMode: true, paymentStatus: "Payout recorded" }); expect(await raw()).toEqual(before); expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("withdrawal receipts reject invented, non-monetary and unsupported minor-unit currencies", async () => {
  await withdraw();
  for (const currency of ["zzz", "xxx", "xau", "jpy", "bhd"]) { await change({ currency }); expect((await review()).body.reason).toBe("needs_review"); expect((await download()).status).toBe(409); }
  expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test.each(["pending", "failed", "reversed", "needs_reconciliation"])("a %s withdrawal payout cannot produce a released receipt", async status => {
  await withdraw(10000, status); expect((await review()).body.reason).toBe("payout_unconfirmed"); expect((await download()).status).toBe(409);
});
test("zero withdrawal decisions are explicit and a payout reversed during rendering cannot be delivered", async () => {
  await withdraw(0); const response = await review(); expect(response.body.receipt).toMatchObject({ status: "no_payout", total: { amount: 0 } }); expect((await download()).status).toBe(200);
  await withdraw(); lifecycle.buildReceiptPdfBuffer.mockImplementation(async () => { await Payout.collection.updateOne({ caseId }, { $set: { status: "reversed", reversedAt: new Date() } }); return pdf; }); expect((await download()).status).toBe(409);
});
