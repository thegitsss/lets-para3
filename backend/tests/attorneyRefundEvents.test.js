const express = require("express"), request = require("supertest"), mongoose = require("mongoose");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_refund_events";
const mockStripe = { webhooks: { constructEvent: jest.fn() }, refunds: { retrieve: jest.fn(), list: jest.fn() }, paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let owner, para, matter, refundOperation, event, currentRefunds, currentRefund, currentCharge;
const raw = () => Case.collection.findOne({ _id: matter._id });
const send = () => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set("Content-Type", "application/json").send("{}");
const refund = (patch = {}) => ({ id: "re_refund_event", object: "refund", status: "succeeded", amount: 61000, currency: "usd", charge: "ch_refund_event", payment_intent: "pi_refund_event", created: 1788951600, balance_transaction: "txn_refund_event", metadata: { caseId: String(matter._id) }, ...patch });
const charge = (patch = {}) => ({ id: "ch_refund_event", object: "charge", payment_intent: "pi_refund_event", amount: 122000, amount_captured: 122000, amount_refunded: 61000, paid: true, captured: true, refunded: false, disputed: false, status: "succeeded", currency: "usd", livemode: false, metadata: { caseId: String(matter._id) }, ...patch });
const intent = (patch = {}) => ({ id: "pi_refund_event", object: "payment_intent", status: "succeeded", amount: 122000, amount_received: 122000, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: currentCharge, ...patch });
const select = (type = "refund.updated", object = currentRefund) => { event = { id: `evt_${new mongoose.Types.ObjectId()}`, type, livemode: false, created: 1788955200, data: { object } }; mockStripe.webhooks.constructEvent.mockReturnValue(event); };
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Audit.init(), Delivery.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para] = await User.create(["owner", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@refund-events.test`, password: "Synthetic123!", role: name === "owner" ? "attorney" : "paralegal", status: "approved" })));
  matter = await Case.create({ title: "River Street completed lease review", details: "Retained payout and subsequent refund events.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "completed", archived: true, readOnly: true, totalAmount: 100000, lockedTotalAmount: 100000, remainingAmount: 0, feeAttorneyPct: 22, feeAttorneyAmount: 22000, currency: "usd", stripeMode: "test", paymentIntentId: "pi_refund_event", escrowIntentId: "pi_refund_event", escrowStatus: "released", paymentStatus: "succeeded", paymentReleased: true, payoutStatus: "paid", payoutTransferId: "tr_refund_event", paidOutAt: new Date("2026-09-08T12:00:00Z"), completedAt: new Date("2026-09-08T12:00:00Z") });
  await Operation.create({ caseId: matter._id, kind: "case_payout", operationKey: `case_payout:${matter._id}`, fingerprint: "synthetic-payout", status: "succeeded", amount: 82000, transferAmount: 82000, stripeTransferId: "tr_refund_event", stripeObjectId: "tr_refund_event", currency: "usd", stripeMode: "test" });
  await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: `case_payout:${matter._id}`, amountPaid: 82000, transferId: "tr_refund_event", status: "paid", stripeMode: "test" });
  refundOperation = await Operation.create({ caseId: matter._id, kind: "refund", operationKey: `refund:${matter._id}:retained`, fingerprint: "synthetic-refund", status: "pending", amount: 61000, refundAmount: 61000, stripeRefundId: "re_refund_event", stripePaymentIntentId: "pi_refund_event", stripeChargeId: "ch_refund_event", currency: "usd", stripeMode: "test" });
  currentCharge = charge(); currentRefund = refund(); currentRefunds = [currentRefund]; select();
  mockStripe.paymentIntents.retrieve.mockImplementation(async () => intent()); mockStripe.charges.retrieve.mockImplementation(async () => currentCharge); mockStripe.refunds.retrieve.mockImplementation(async () => currentRefund); mockStripe.refunds.list.mockImplementation(async () => ({ data: currentRefunds, has_more: false }));
});
test("a refund callback audit failure rolls back its financial projections", async () => {
  const before = await raw(), operation = await Operation.findById(refundOperation._id).lean(); jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic refund audit unavailable"));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Operation.findById(refundOperation._id).lean()).toEqual(operation);
});
test("a full attorney refund cannot erase a separately paid paralegal payout", async () => {
  currentRefund = refund({ amount: 122000 }); currentRefunds = [currentRefund]; currentCharge = charge({ amount_refunded: 122000, refunded: true }); await Operation.updateOne({ _id: refundOperation._id }, { $set: { amount: 122000, refundAmount: 122000 } }); select();
  const payout = await Payout.findOne().lean(); expect((await send()).status).toBe(200); expect((await raw()).paymentReleased).toBe(true); expect((await raw()).payoutStatus).toBe("paid"); expect(await Payout.findOne().lean()).toEqual(payout);
});
test("an old failed snapshot uses the current successful refund outcome", async () => {
  select("refund.failed", refund({ status: "failed" })); expect((await send()).status).toBe(200); expect((await raw()).paymentStatus).toBe("partially_refunded");
});
test("two successful partial refunds are reconciled against the full original charge", async () => {
  currentRefunds = [refund({ id: "re_prior_refund_event", created: 1788948000 }), currentRefund]; currentCharge = charge({ amount_refunded: 122000, refunded: true });
  expect((await send()).status).toBe(200); expect((await raw()).paymentStatus).toBe("refunded"); expect((await raw()).remainingAmount).toBe(0);
});
test("refund metadata cannot attribute another PaymentIntent to this Matter", async () => {
  const before = await raw(); currentRefund = refund({ payment_intent: "pi_other", amount: 122000 }); select(); mockStripe.paymentIntents.retrieve.mockResolvedValue(intent({ id: "pi_other" }));
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("an unavailable provider read remains retryable instead of acknowledging an unchecked refund", async () => {
  const before = await raw(); mockStripe.paymentIntents.retrieve.mockRejectedValueOnce(new Error("Synthetic provider unavailable"));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("failed");
});
test("a charge refund event cannot certify refunds that are still pending", async () => {
  currentRefund = refund({ status: "pending" }); currentRefunds = [currentRefund]; select("charge.refunded", currentCharge);
  expect((await send()).status).toBe(200); expect((await raw()).paymentStatus).toBe("refund_pending"); expect((await raw()).status).toBe("completed");
});
test("current refund evidence is retained independently from the payout operation", async () => {
  const payout = await Operation.findOne({ kind: "case_payout" }).lean(); expect((await send()).status).toBe(200);
  expect(await Operation.findById(refundOperation._id).lean()).toMatchObject({ status: "succeeded", refundStatus: "succeeded", refundEvidenceStatus: "verified", refundVerifiedAt: expect.any(Date), refundCreatedAt: new Date(1788951600000), refundAmount: 61000 });
  expect(await Operation.findOne({ kind: "case_payout" }).lean()).toEqual(payout); expect((await raw()).escrowStatus).toBe("released"); expect((await raw()).remainingAmount).toBe(0);
});
test("a current failed refund records its failure without reversing a paralegal payout", async () => {
  currentRefund = refund({ status: "failed" }); currentRefunds = [currentRefund]; currentCharge = charge({ amount_refunded: 0 }); select("refund.failed", currentRefund);
  expect((await send()).status).toBe(200); expect((await raw()).paymentStatus).toBe("refund_failed"); expect((await raw()).paymentReleased).toBe(true); expect((await Payout.findOne()).status).toBe("paid");
  expect(await Operation.findById(refundOperation._id).lean()).toMatchObject({ status: "failed", refundStatus: "failed", refundEvidenceStatus: "verified" });
});
test("a failed later operation write rolls back earlier refund observations", async () => {
  currentRefunds = [refund({ id: "re_prior_refund_event" }), currentRefund]; currentCharge = charge({ amount_refunded: 122000, refunded: true }); const before = await raw(), count = await Operation.countDocuments();
  jest.spyOn(Operation.collection, "updateOne").mockRejectedValueOnce(new Error("Synthetic refund operation unavailable"));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Operation.countDocuments()).toBe(count); expect(await Audit.countDocuments()).toBe(0);
});
test("a lost refund commit acknowledgement preserves a complete processed receipt", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false;
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic refund commit acknowledgement lost"); } }; return session; });
  expect((await send()).status).toBe(500); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("processed"); const before = await raw();
  expect((await send()).body.deduped).toBe(true); expect(await raw()).toEqual(before); expect(await Audit.countDocuments()).toBe(1);
});
test("a replaced refund delivery cannot commit after its replacement", async () => {
  let arrive, release; const waiting = new Promise(resolve => { arrive = resolve; }), held = new Promise(resolve => { release = resolve; });
  mockStripe.paymentIntents.retrieve.mockImplementationOnce(async () => { arrive(); await held; return intent(); }); const first = send().then(response => response);
  try { await waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } }); expect((await send()).status).toBe(200); const before = await raw(); release(); expect((await first).status).toBe(500); expect(await raw()).toEqual(before); }
  finally { release(); await first; }
  expect(await Audit.countDocuments()).toBe(1); expect((await Delivery.findOne({ eventId: event.id })).attempts).toBe(2);
});
test("retained refund events survive delivery expiry without provider reads or duplicate records", async () => {
  expect((await send()).status).toBe(200); const before = await raw(); await Delivery.deleteOne({ eventId: event.id }); mockStripe.refunds.retrieve.mockClear();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.refunds.retrieve).not.toHaveBeenCalled(); expect(await Audit.countDocuments()).toBe(1);
});
test("a changed event cannot reuse an expired refund delivery's business identity", async () => {
  expect((await send()).status).toBe(200); const before = await raw(); await Delivery.deleteOne({ eventId: event.id }); event.data.object.amount = 1;
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Audit.countDocuments()).toBe(1);
});
test("incomplete or repeating refund pages cannot certify a total", async () => {
  const before = await raw(); mockStripe.refunds.list.mockResolvedValue({ data: [currentRefund], has_more: true });
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(mockStripe.refunds.list).toHaveBeenCalledTimes(2);
});
test("all refund pages contribute once to the confirmed total", async () => {
  const prior = refund({ id: "re_prior_refund_event" }); currentCharge = charge({ amount_refunded: 122000, refunded: true });
  mockStripe.refunds.list.mockResolvedValueOnce({ data: [prior], has_more: true }).mockResolvedValueOnce({ data: [currentRefund], has_more: false });
  expect((await send()).status).toBe(200); expect((await raw()).paymentStatus).toBe("refunded"); expect(mockStripe.refunds.list).toHaveBeenLastCalledWith({ charge: "ch_refund_event", limit: 100, starting_after: prior.id });
});
test("a changed Matter during the provider read cannot be overwritten", async () => {
  mockStripe.paymentIntents.retrieve.mockImplementationOnce(async () => { await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 12345 } }); return intent(); });
  expect((await send()).status).toBe(500); expect((await raw()).remainingAmount).toBe(12345); expect((await Operation.findById(refundOperation._id)).refundVerifiedAt).toBeNull();
});
test("another account's duplicate refund reference cannot be attributed to this Matter", async () => {
  await Operation.create({ operationKey: "synthetic_refund_other_case", caseId: new mongoose.Types.ObjectId(), kind: "refund", fingerprint: "other", status: "pending", amount: 61000, stripeRefundId: "re_refund_event" }); const before = await raw();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect((await Audit.findOne()).meta.associationProblem).toBe("ambiguous_refund");
});
test.each([true, false])("only the signed original request key can recover an unknown refund: matching=%s", async matching => {
  await Operation.deleteMany({ caseId: matter._id }); await Payout.deleteMany({ caseId: matter._id });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "disputed", archived: false, readOnly: false, paymentReleased: false, payoutStatus: "not_started", payoutTransferId: null, paidOutAt: null, completedAt: null, remainingAmount: 100000 } });
  matter = await Case.findById(matter._id); currentCharge = charge({ amount_refunded: 0 });
  const input = { operationKey: `dispute_settlement:${matter._id}:synthetic`, caseId: matter._id, kind: "dispute_settlement", fingerprint: { action: "release_partial", payoutAmountCents: 41000 }, amount: 41000 };
  const service = require("../services/paymentOperationService"), claim = await service.claimPaymentOperation(input), create = jest.fn(async () => { throw new Error("Synthetic unknown Stripe refund response"); });
  const requestKey = "synthetic_original_refund_key";
  await expect(require("../services/refundRequestService").requestRefund({ operation: claim.operation, caseDoc: matter, disputeId: "synthetic", action: "release_partial", targetRefundTotal: 61000, stripe: { ...mockStripe, stripeIdempotencyKey: () => requestKey, refunds: { ...mockStripe.refunds, create } } })).rejects.toMatchObject({ publicCode: "REFUND_RESULT_UNKNOWN" });
  currentCharge = charge(); currentRefund = refund({ metadata: { caseId: String(matter._id), disputeId: "synthetic", operationKey: input.operationKey } }); currentRefunds = [currentRefund]; select("refund.created", currentRefund); event.request = { id: "req_synthetic", idempotency_key: matching ? requestKey : "synthetic_other_key" };
  const before = await raw(); expect((await send()).status).toBe(200); const operation = await Operation.findById(claim.operation._id);
  if (matching) { expect(operation.stripeRefundId).toBe(currentRefund.id); expect(operation.refundStatus).toBe("succeeded"); expect(operation.status).toBe("needs_reconciliation"); expect((await service.claimPaymentOperation(input)).acquired).toBe(true); }
  else { expect(operation.stripeRefundId).toBe(""); expect(await raw()).toEqual(before); }
  expect(create).toHaveBeenCalledTimes(1); expect((await raw()).status).toBe("disputed");
});
