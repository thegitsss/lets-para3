const express = require("express"), request = require("supertest"), mongoose = require("mongoose");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_chargeback_events";
const mockStripe = { webhooks: { constructEvent: jest.fn() }, disputes: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, paymentIntents: { retrieve: jest.fn() }, balanceTransactions: { retrieve: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Income = require("../models/PlatformIncome"), Adjustment = require("../models/FinancialAdjustment"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let owner, para, matter, event, currentDispute, currentCharge, currentIntent;
const send = (headers = {}) => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set(headers).set("Content-Type", "application/json").send("{}");
const select = (object = currentDispute) => { event = { id: `evt_${new mongoose.Types.ObjectId()}`, type: "charge.dispute.updated", created: 1788955200, livemode: false, data: { object: structuredClone(object) } }; mockStripe.webhooks.constructEvent.mockReturnValue(event); };
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Income.init(), Adjustment.init(), Audit.init(), Delivery.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); for (const group of Object.values(mockStripe)) for (const fn of Object.values(group)) fn.mockReset();
  [owner, para] = await User.create(["owner", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@chargeback-events.test`, password: "Synthetic123!", role: name === "owner" ? "attorney" : "paralegal", status: "approved" })));
  matter = await Case.create({ title: "River Street lease payment review", details: "Card-provider dispute and separate financial evidence.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: "usd", stripeMode: "test", paymentIntentId: "pi_chargeback_event", escrowIntentId: "pi_chargeback_event", escrowStatus: "funded", paymentStatus: "succeeded" });
  currentCharge = { id: "ch_chargeback_event", object: "charge", payment_intent: "pi_chargeback_event", amount: 48800, amount_captured: 48800, amount_refunded: 0, paid: true, captured: true, disputed: true, status: "succeeded", currency: "usd", livemode: false, metadata: { caseId: String(matter._id) } };
  currentIntent = { id: "pi_chargeback_event", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, latest_charge: currentCharge, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) } };
  currentDispute = { id: "dp_chargeback_event", object: "dispute", status: "under_review", amount: 48800, currency: "usd", livemode: false, charge: currentCharge.id, payment_intent: currentIntent.id, created: 1788951600, metadata: { caseId: String(matter._id) }, balance_transactions: [{ id: "txn_chargeback_debit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute", source: "dp_chargeback_event", amount: -48800, fee: 1500, net: -50300, currency: "usd", created: 1788951600 }] };
  mockStripe.disputes.retrieve.mockImplementation(async () => structuredClone(currentDispute)); mockStripe.charges.retrieve.mockImplementation(async () => structuredClone(currentCharge)); mockStripe.paymentIntents.retrieve.mockImplementation(async () => structuredClone(currentIntent)); mockStripe.balanceTransactions.retrieve.mockImplementation(async id => structuredClone(currentDispute.balance_transactions.find(value => value.id === id))); select();
});
test("a chargeback audit failure rolls back both the operation and platform adjustments", async () => {
  jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic chargeback audit unavailable"));
  expect((await send()).status).toBe(500); expect(await Operation.countDocuments({ kind: "chargeback" })).toBe(0); expect(await Adjustment.countDocuments()).toBe(0);
});
test("provider evidence unavailable during a chargeback remains retryable without partial financial records", async () => {
  mockStripe.charges.retrieve.mockRejectedValueOnce(new Error("Synthetic charge unavailable"));
  expect((await send()).status).toBe(500); expect(await Operation.countDocuments({ kind: "chargeback" })).toBe(0); expect(await Adjustment.countDocuments()).toBe(0);
});
test("an older card-dispute snapshot is checked against the current provider outcome", async () => {
  currentDispute.status = "won"; expect((await send()).status).toBe(200); expect((await Operation.findOne({ kind: "chargeback" })).processorStatus).toBe("won"); expect(mockStripe.disputes.retrieve).toHaveBeenCalled();
});
test("metadata alone cannot assign a card dispute to a Matter with no retained payment reference", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $unset: { paymentIntentId: "", escrowIntentId: "" } });
  expect((await send()).status).toBe(200); expect(await Operation.countDocuments({ kind: "chargeback", caseId: matter._id })).toBe(0); expect(await Adjustment.countDocuments({ caseId: matter._id })).toBe(0);
});
test("an unsigned account header cannot select the provider account for a card dispute", async () => {
  expect((await send({ "Stripe-Account": "acct_untrusted_header" })).status).toBe(200);
  expect(mockStripe.charges.retrieve.mock.calls.some(args => args.some(value => value?.stripeAccount))).toBe(false);
});
test("a payout row with no paid status does not remove the card-dispute payout hold", async () => {
  await Payout.collection.insertOne({ _id: new mongoose.Types.ObjectId(), caseId: matter._id, paralegalId: para._id, amountPaid: 32800, transferId: "tr_unverified_status", stripeMode: "test", status: null });
  expect((await send()).status).toBe(200); expect((await require("../services/payoutHoldService").getPayoutHold(matter._id)).held).toBe(true);
});
test("a missing balance-transaction date is not replaced by the event date", async () => {
  delete currentDispute.balance_transactions[0].created; select(); expect((await send()).status).toBe(200);
  const adjustments = await Adjustment.find().lean(); expect(adjustments.length).toBeGreaterThan(0); expect(adjustments.every(value => value.stripeEvidenceCreatedAt == null)).toBe(true);
});
test("the current prevented dispute outcome and du identifier remain recognizable", async () => {
  currentDispute.id = "du_prevented_event"; currentDispute.status = "prevented"; currentDispute.balance_transactions = []; select();
  expect((await send()).status).toBe(200); expect((await Operation.findOne({ kind: "chargeback" })).processorStatus).toBe("prevented");
});
test("a failed second adjustment write leaves no partial card-dispute ledger or audit", async () => {
  const create = Adjustment.create.bind(Adjustment); let writes = 0; jest.spyOn(Adjustment, "create").mockImplementation((rows, options) => ++writes === 2 ? Promise.reject(new Error("Synthetic second adjustment unavailable")) : create(rows, options));
  expect((await send()).status).toBe(500); expect(await Operation.countDocuments()).toBe(0); expect(await Adjustment.countDocuments()).toBe(0); expect(await Audit.countDocuments()).toBe(0);
});
test("receipt finalization failure rolls back the operation, adjustments and business audit", async () => {
  const update = Delivery.updateOne.bind(Delivery); jest.spyOn(Delivery, "updateOne").mockImplementation((filter, patch, options) => patch.$set?.status === "processed" ? Promise.reject(new Error("Synthetic receipt unavailable")) : update(filter, patch, options));
  expect((await send()).status).toBe(500); expect(await Operation.countDocuments()).toBe(0); expect(await Adjustment.countDocuments()).toBe(0); expect(await Audit.countDocuments()).toBe(0);
});
test("lost commit acknowledgement retains one complete card-dispute observation", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false;
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic card-dispute acknowledgement lost"); } }; return session; });
  expect((await send()).status).toBe(500); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("processed"); expect((await send()).body.deduped).toBe(true);
  expect(await Operation.countDocuments()).toBe(1); expect(await Adjustment.countDocuments()).toBe(2); expect(await Audit.countDocuments()).toBe(1);
});
test("the retained business event survives receipt expiry without a new provider read", async () => {
  expect((await send()).status).toBe(200); const before = await Operation.findOne().lean(); await Delivery.deleteOne({ eventId: event.id }); mockStripe.disputes.retrieve.mockClear();
  expect((await send()).status).toBe(200); expect(mockStripe.disputes.retrieve).not.toHaveBeenCalled(); expect(await Operation.findOne().lean()).toEqual(before); expect(await Adjustment.countDocuments()).toBe(2); expect(await Audit.countDocuments()).toBe(1);
  expect(require("../utils/opsAlerting").sendOwnerAlert).toHaveBeenCalledTimes(1);
});
test("changed contents cannot reuse an expired receipt's retained event identity", async () => {
  expect((await send()).status).toBe(200); const before = await Operation.findOne().lean(); await Delivery.deleteOne({ eventId: event.id }); event.data.object.amount = 1;
  expect((await send()).status).toBe(500); expect(await Operation.findOne().lean()).toEqual(before); expect(await Audit.countDocuments()).toBe(1);
});
test("a replaced callback attempt cannot commit after the replacement finishes", async () => {
  let arrive, release; const waiting = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  mockStripe.charges.retrieve.mockImplementationOnce(async () => { arrive(); await gate; return structuredClone(currentCharge); }); const first = send().then(response => response);
  try { await waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } }); expect((await send()).status).toBe(200); const before = await Operation.findOne().lean(); release(); expect((await first).status).toBe(500); expect(await Operation.findOne().lean()).toEqual(before); }
  finally { release(); await first; }
  expect(await Audit.countDocuments()).toBe(1); expect(await Adjustment.countDocuments()).toBe(2);
});
test("refund overlap remains attached to the retained Matter and holds its unpaid payout for review", async () => {
  currentCharge.amount_refunded = 1000; expect((await send()).status).toBe(200);
  expect(await Operation.findOne().lean()).toMatchObject({ caseId: matter._id, evidenceStatus: "quarantined", lastError: "refund_chargeback_overlap" }); expect(await Adjustment.countDocuments()).toBe(0); expect((await require("../services/payoutHoldService").getPayoutHold(matter._id)).held).toBe(true);
});
test("signed connected-account disputes are retained for review without platform provider calls", async () => {
  event.account = "acct_connected_dispute"; expect((await send()).status).toBe(200); expect(mockStripe.disputes.retrieve).not.toHaveBeenCalled(); expect(await Operation.countDocuments()).toBe(0); expect(await Adjustment.countDocuments()).toBe(0); expect((await Audit.findOne()).meta.reasons).toContain("unsupported_connected_account_dispute");
});
test.each(["dp_other", "dp_chargeback_event"])("a foreign or orphaned %s balance reference cannot create another loss entry", async stripeDisputeId => {
  const foreign = { _id: new mongoose.Types.ObjectId(), idempotencyKey: "foreign_balance", paymentOperationId: new mongoose.Types.ObjectId(), caseId: new mongoose.Types.ObjectId(), stripeDisputeId, stripeBalanceTransactionId: "txn_chargeback_debit", amount: 48800, direction: "debit", currency: "usd", adjustmentType: "chargeback_principal" }; await Adjustment.collection.insertOne(foreign);
  expect((await send()).status).toBe(200); expect(await Adjustment.countDocuments()).toBe(1); expect(await Adjustment.collection.findOne({ _id: foreign._id })).toEqual(foreign); expect((await Operation.findOne()).evidenceStatus).toBe("quarantined");
});
test("missing event dates stay missing while verification time remains separate", async () => {
  delete event.created; expect((await send()).status).toBe(200); const operation = await Operation.findOne(); expect(operation.processorEventCreatedAt).toBeNull(); expect(operation.evidenceVerifiedAt).toEqual(expect.any(Date));
});
test("a past partial payout does not release the remaining Matter balance from card-dispute review", async () => {
  const payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, amountPaid: 8200, operationKey: "partial_payout:old_assignment", transferId: "tr_old_assignment", stripeMode: "test", status: "paid" });
  await Case.updateOne({ _id: matter._id }, { $set: { remainingAmount: 30000, withdrawalHistory: [{ payoutTransferId: payout.transferId, partialPayoutAmount: 10000, payoutFinalizedAt: new Date(), payoutFinalizedType: "partial_attorney", withdrawnParalegalId: para._id }] } });
  expect((await send()).status).toBe(200); expect((await Operation.findOne({ kind: "chargeback" })).payoutPosition).toBe("post_payout");
  const before = await Payout.findById(payout._id).lean(); expect((await require("../services/payoutHoldService").getPayoutHold(matter._id)).held).toBe(true); expect(await Payout.findById(payout._id).lean()).toEqual(before);
});
test("conflicting retained chargeback evidence removes its verified claim without changing retained references", async () => {
  expect((await send()).status).toBe(200); const original = await Operation.findOne().lean(); currentDispute.amount = 48801; select();
  expect((await send()).status).toBe(200); const current = await Operation.findById(original._id).lean(); expect(current).toMatchObject({ evidenceStatus: "quarantined", administrativeStatus: "pending_review", lastError: "retained_dispute_conflict", amount: original.amount, stripeDisputeId: original.stripeDisputeId }); expect(await Adjustment.countDocuments()).toBe(2);
});
test("live card-dispute evidence cannot be adopted while the application uses test mode", async () => {
  currentDispute.livemode = true; select(); expect((await send()).status).toBe(200);
  expect((await Operation.findOne()).evidenceStatus).toBe("quarantined"); expect(await Adjustment.countDocuments()).toBe(0); expect(mockStripe.charges.retrieve).not.toHaveBeenCalled();
});
