const express = require("express"), request = require("supertest"), mongoose = require("mongoose");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_funding_events";
const mockStripe = { webhooks: { constructEvent: jest.fn() }, paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, balanceTransactions: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(() => ({ transferable: true })) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_user, _type, _payload, options) => options?.deferDispatch ? async () => ({ ok: true }) : ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let owner, para, matter, event;
const raw = () => Case.collection.findOne({ _id: matter._id }), change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });
const send = () => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set("Content-Type", "application/json").send("{}");
const intent = (patch = {}) => ({ id: "pi_funding_event", object: "payment_intent", status: "succeeded", amount: 122001, amount_received: 122001, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: { id: "ch_funding_event", amount: 122001, amount_captured: 122001, amount_refunded: 0, paid: true, captured: true, refunded: false, disputed: false, status: "succeeded", currency: "usd", livemode: false, payment_intent: "pi_funding_event", balance_transaction: { id: "txn_funding_event", type: "charge", amount: 122001, fee: 3500, net: 118501, currency: "usd", source: "ch_funding_event" } }, ...patch });
const select = (type = "payment_intent.succeeded", object = intent()) => { event = { id: `evt_${new mongoose.Types.ObjectId()}`, type, livemode: false, created: 1788955200, data: { object } }; mockStripe.webhooks.constructEvent.mockReturnValue(event); mockStripe.paymentIntents.retrieve.mockResolvedValue(object); };
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Audit.init(), Delivery.init()]); });
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para] = await User.create(["owner", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@funding-events.test`, password: "Synthetic123!", role: name === "owner" ? "attorney" : "paralegal", status: "approved" })));
  matter = await Case.create({ title: "River Street lease review", details: "Original funding callback checks.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "open", totalAmount: 100001, lockedTotalAmount: 100001, remainingAmount: 100001, feeAttorneyPct: 22, feeAttorneyAmount: 22000, currency: "usd", stripeMode: "test", paymentIntentId: "pi_funding_event", escrowIntentId: "pi_funding_event" });
  select();
});
async function interruptedCapture(reason = "charge_unmatched") {
  const current = intent(), charge = { ...current.latest_charge, balance_transaction: null };
  current.latest_charge = "ch_funding_event";
  const provider = { charges: { retrieve: async () => {
    if (reason === "charge_unmatched") throw Error("Synthetic capture lookup unavailable");
    return charge;
  } } };
  await require("../services/fundingEvidenceBackfillService").reconcileFundingEvidence({
    caseDoc: await raw(), paymentIntent: current, stripeClient: provider, PaymentOperation: Operation,
  });
  const operation = await Operation.findOne({ caseId: matter._id, kind: "funding" }).lean();
  expect(operation).toMatchObject({ status: "needs_reconciliation", lastError: reason });
  return operation;
}
test.each(["charge_unmatched", "balance_transaction_unmatched"])("current verified capture finishes the same interrupted %s operation once", async reason => {
  const before = await interruptedCapture(reason);
  const backfill = await require("../services/fundingEvidenceBackfillService").inspectFundingCandidate({ caseDoc: await raw(), operations: [before], stripeClient: mockStripe, paymentIntent: intent() });
  expect(backfill).toMatchObject({ action: "review", reasons: ["existing_operation_conflict"] });
  expect((await send()).status).toBe(200);
  const recorded = await Operation.findById(before._id).lean();
  expect(recorded.caseId).toEqual(before.caseId);
  expect(recorded).toMatchObject({ status: "succeeded", lastError: "", grossAmount: 122001, processingFeeAmount: 3500, netAmount: 118501, stripeMode: "test", livemode: false });
  expect(recorded.evidenceVerifiedAt).toBeInstanceOf(Date);
  expect((await send()).body.deduped).toBe(true);
  expect(await Operation.findById(before._id).lean()).toEqual(recorded);
  expect(await Operation.countDocuments()).toBe(1);
});
test.each([
  { status: "failed" }, { status: "pending" }, { lastError: "case_amount_mismatch" },
  { evidenceStatus: "quarantined" }, { evidenceStatus: "needs_reconciliation" }, { administrativeStatus: "acknowledged" },
  { amount: 1 }, { currency: "eur" }, { stripeMode: "live" }, { livemode: false },
  { fingerprint: "changed-request" }, { attempts: 2 }, { grossAmount: 122001 }, { processingFeeAmount: 3500 },
  { stripeChargeId: "ch_conflicting" }, { stripeObjectId: "pi_conflicting" }, { stripeTransferId: "tr_prior" },
])("a changed or reviewed interrupted capture %j cannot be silently recovered", async patch => {
  const operation = await interruptedCapture(); await Operation.collection.updateOne({ _id: operation._id }, { $set: patch });
  const before = await Operation.collection.findOne({ _id: operation._id }), beforeMatter = await raw();
  expect((await send()).status).toBe(200);
  expect(await Operation.collection.findOne({ _id: operation._id })).toEqual(before);
  expect(await raw()).toEqual(beforeMatter);
  expect((await Audit.findOne({ "meta.eventId": event.id })).meta.outcome).toBe("needs_review");
});
test("recovery and its audit roll back together before a successful retry", async () => {
  const before = await interruptedCapture(), beforeMatter = await raw();
  jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic recovery audit unavailable"));
  expect((await send()).status).toBe(500);
  expect(await Operation.findById(before._id).lean()).toEqual(before);
  expect(await raw()).toEqual(beforeMatter);
  expect((await Delivery.findOne({ eventId: event.id })).status).toBe("failed");
  expect((await send()).status).toBe(200);
  expect((await Operation.findById(before._id)).status).toBe("succeeded");
  expect(await Operation.countDocuments()).toBe(1);
});
test("an interrupted operation changing during provider verification cannot be recovered from the old read", async () => {
  const operation = await interruptedCapture(), beforeMatter = await raw();
  mockStripe.paymentIntents.retrieve.mockImplementationOnce(async () => {
    await Operation.collection.updateOne({ _id: operation._id }, { $set: { evidenceStatus: "quarantined" } });
    return intent();
  });
  expect((await send()).status).toBe(500);
  expect(await raw()).toEqual(beforeMatter);
  expect(await Operation.findById(operation._id).lean()).toMatchObject({ status: "needs_reconciliation", evidenceStatus: "quarantined" });
});
test("an audit failure rolls back original funding and its ledger", async () => {
  const before = await raw(); jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Operation.countDocuments()).toBe(0);
});
test("a failed funding ledger write cannot be acknowledged as funded", async () => {
  const before = await raw(); jest.spyOn(Operation, "create").mockRejectedValueOnce(new Error("Synthetic funding ledger unavailable"));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("failed");
});
test("a delayed original success preserves released funds and the first verification date", async () => {
  const verifiedAt = new Date("2026-09-01T12:00:00Z"); await change({ status: "completed", escrowStatus: "released", paymentReleased: true, paymentStatus: "succeeded", remainingAmount: 12345, fundingVerifiedAt: verifiedAt });
  expect((await send()).status).toBe(200); const saved = await raw(); expect(saved.escrowStatus).toBe("released"); expect(saved.fundingVerifiedAt).toEqual(verifiedAt); expect(saved.status).toBe("completed"); expect(saved.remainingAmount).toBe(12345);
});
test("a stale pending update preserves a later refund", async () => {
  await change({ status: "closed", escrowStatus: "released", paymentStatus: "refunded" }); const before = await raw(); select("payment_intent.requires_action", intent({ status: "requires_action" }));
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("metadata cannot attach an unrelated intent to this Matter", async () => {
  const before = await raw(); select("payment_intent.processing", intent({ id: "pi_unrelated", status: "processing" }));
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("an old processing snapshot checks the current Stripe payment", async () => {
  select("payment_intent.processing", intent({ status: "processing", amount_received: 0, latest_charge: null })); mockStripe.paymentIntents.retrieve.mockResolvedValue(intent());
  expect((await send()).status).toBe(200); expect((await raw()).escrowStatus).toBe("funded"); expect(await Operation.countDocuments({ kind: "funding", status: "succeeded" })).toBe(1);
});
test("current capture produces one exact funding record and retry preserves the first verification", async () => {
  const before = await raw(); expect({ ready: require("../services/attorneyFunding").mayActivateFunding(before), settlement: before.disputeSettlement, state: before.status, payment: before.paymentStatus, pause: before.pausedReason }).toMatchObject({ ready: true });
  expect((await send()).status).toBe(200); const first = await raw();
  expect(first).toMatchObject({ escrowStatus: "funded", paymentStatus: "succeeded", status: "in progress", remainingAmount: 100001, fundingIntegrityStatus: "verified" });
  expect(await Operation.findOne({ kind: "funding" }).lean()).toMatchObject({ status: "succeeded", stripePaymentIntentId: "pi_funding_event", stripeChargeId: "ch_funding_event", stripeBalanceTransactionId: "txn_funding_event", grossAmount: 122001, processingFeeAmount: 3500, netAmount: 118501 });
  expect((await send()).body.deduped).toBe(true); expect(await raw()).toEqual(first); expect(await Operation.countDocuments()).toBe(1);
});
test.each([{ paid: false }, { captured: false }, { amount_captured: 120000 }, { payment_intent: "pi_other" }, { livemode: true }, { amount_refunded: 1 }, { disputed: true }, { balance_transaction: { id: "txn_other", amount: 122001, fee: 3500, net: 118501, currency: "usd", source: "ch_other" } }])("incomplete or mismatched capture %j remains under review", async patch => {
  const before = await raw(), current = intent(); Object.assign(current.latest_charge, patch); mockStripe.paymentIntents.retrieve.mockResolvedValue(current);
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(await Operation.countDocuments()).toBe(0);
  expect((await Audit.findOne({ "meta.eventId": event.id })).meta.outcome).toBe("needs_review");
});
test("a provider lookup failure leaves funding unchanged and retry can finish", async () => {
  const before = await raw(); mockStripe.paymentIntents.retrieve.mockRejectedValueOnce(new Error("Synthetic Stripe unavailable"));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Operation.countDocuments()).toBe(0);
  expect((await send()).status).toBe(200); expect(await Operation.countDocuments()).toBe(1);
});
test("a duplicate Matter reference cannot certify either Matter", async () => {
  await Case.collection.insertOne({ attorney: owner._id, escrowIntentId: "pi_funding_event" }); const before = await raw();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(await Operation.countDocuments()).toBe(0);
});
test("connected-account payment evidence cannot become platform funding", async () => {
  const before = await raw(); event.account = "acct_synthetic_external";
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("an unsigned account header cannot redirect an authenticated platform payment", async () => {
  const response = await request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set("Stripe-Account", "acct_untrusted_header").set("Content-Type", "application/json").send("{}");
  expect(response.status).toBe(200); expect((await raw()).escrowStatus).toBe("funded"); expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_funding_event", { expand: ["latest_charge.balance_transaction"] });
});
test.each(["pending", "failed", "reversed", "needs_reconciliation"])("original funding cannot clear a retained %s payout decision", async payoutStatus => {
  await change({ payoutStatus }); expect((await send()).status).toBe(200); const saved = await raw(); expect(saved.payoutStatus).toBe(payoutStatus); expect(saved.escrowStatus).not.toBe("funded"); expect(saved.status).toBe("open");
});
test("an unavailable paralegal cannot be opened for work by a funding callback", async () => {
  await User.collection.updateOne({ _id: para._id }, { $set: { disabled: true } }); expect((await send()).status).toBe(200); expect((await raw()).escrowStatus).not.toBe("funded"); expect((await raw()).status).toBe("open"); expect(await Operation.countDocuments({ kind: "funding" })).toBe(1);
});
test("a conflicting retained charge prevents new funding attribution", async () => {
  await Operation.create({ caseId: new mongoose.Types.ObjectId(), kind: "funding", operationKey: "funding:synthetic:other", fingerprint: "synthetic", status: "succeeded", amount: 122001, stripePaymentIntentId: "pi_other", stripeChargeId: "ch_funding_event" }); const before = await raw();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(await Operation.countDocuments()).toBe(1);
});
test("a notification dispatch failure after commit does not reopen payment processing", async () => {
  require("../utils/notifyUser").notifyUser.mockResolvedValueOnce(async () => { throw new Error("Synthetic notification dispatch unavailable"); });
  expect((await send()).status).toBe(200); expect((await raw()).escrowStatus).toBe("funded"); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("processed");
});
test("a changed Matter during the provider read prevents stale funding writes", async () => {
  mockStripe.paymentIntents.retrieve.mockImplementationOnce(async () => { await change({ status: "closed", paymentStatus: "refunded" }); return intent(); });
  expect((await send()).status).toBe(500); expect((await raw()).paymentStatus).toBe("refunded"); expect(await Operation.countDocuments()).toBe(0);
});
test("a later refund operation prevents a pending callback from changing current payment state", async () => {
  await Operation.create({ caseId: matter._id, kind: "refund", operationKey: `refund:${matter._id}`, fingerprint: "synthetic-refund", status: "pending", amount: 122001 });
  const before = await raw(); select("payment_intent.processing", intent({ status: "processing" }));
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("a hired claim can retain original funding without prematurely opening work", async () => {
  await change({ hiringClaimToken: "synthetic-claim", hiringClaimStatus: "claimed" });
  expect((await send()).status).toBe(200); const saved = await raw(); expect(saved.status).toBe("open"); expect(saved.escrowStatus).not.toBe("funded"); expect(saved.hiringClaimToken).toBe("synthetic-claim"); expect(await Operation.countDocuments({ kind: "funding" })).toBe(1);
});
test("failure to finalize the exact delivery rolls back its funding records", async () => {
  const before = await raw(), update = Delivery.updateOne.bind(Delivery);
  jest.spyOn(Delivery, "updateOne").mockImplementation((filter, patch, options) => patch.$set?.status === "processed" ? Promise.reject(new Error("Synthetic receipt unavailable")) : update(filter, patch, options));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Operation.countDocuments()).toBe(0); expect(await Audit.countDocuments()).toBe(0);
});
test("a lost commit acknowledgement leaves complete funding and a processed receipt", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false;
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic lost commit acknowledgement"); } }; return session; });
  expect((await send()).status).toBe(500); expect((await raw()).escrowStatus).toBe("funded"); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("processed");
  expect((await send()).body.deduped).toBe(true); expect(await Operation.countDocuments()).toBe(1); expect(await Audit.countDocuments()).toBe(1);
});
test("a replaced delivery cannot commit after its current replacement", async () => {
  let release, arrive; const waiting = new Promise(resolve => { arrive = resolve; }), held = new Promise(resolve => { release = resolve; });
  mockStripe.paymentIntents.retrieve.mockImplementationOnce(async () => { arrive(); await held; return intent(); }); const first = send().then(value => value);
  try {
    await waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } });
    expect((await send()).status).toBe(200); const committed = await raw(); release(); expect((await first).status).toBe(500); expect(await raw()).toEqual(committed);
  } finally { release(); await first; }
  expect(await Audit.countDocuments()).toBe(1); expect(await Operation.countDocuments()).toBe(1); expect((await Delivery.findOne({ eventId: event.id })).attempts).toBe(2);
});
test("retained business evidence survives receipt expiry without another provider lookup", async () => {
  expect((await send()).status).toBe(200); const before = await raw(); await Delivery.deleteOne({ eventId: event.id }); mockStripe.paymentIntents.retrieve.mockClear();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(await Audit.countDocuments()).toBe(1);
});
test("changed contents cannot reuse an expired delivery's retained business identity", async () => {
  expect((await send()).status).toBe(200); const before = await raw(); await Delivery.deleteOne({ eventId: event.id }); event.data.object.amount = 1;
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Audit.countDocuments()).toBe(1);
});
test("a later refunded charge preserves its original verified funding record", async () => {
  expect((await send()).status).toBe(200); await change({ status: "closed", escrowStatus: "released", paymentStatus: "refunded" }); const before = await raw(), operation = await Operation.findOne({ kind: "funding" }).lean();
  const refunded = intent(); refunded.latest_charge.amount_refunded = 122001; refunded.latest_charge.refunded = true; select("payment_intent.succeeded", refunded);
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(await Operation.findOne({ kind: "funding" }).lean()).toEqual(operation);
});
