const express = require("express"), request = require("supertest"), mongoose = require("mongoose");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_transfer_events";
const mockStripe = { webhooks: { constructEvent: jest.fn() } }, mockAlert = jest.fn(async () => ({ ok: true }));
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: (...args) => mockAlert(...args) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let owner, priorPara, currentPara, matter, previous, current, unrelated, event;
const raw = () => Case.collection.findOne({ _id: matter._id });
const send = () => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set("Content-Type", "application/json").send("{}");
const transfer = (operation = previous, patch = {}) => ({ id: operation.stripeTransferId, object: "transfer", amount: operation.transferAmount, currency: "usd", livemode: false, created: 1788264000, destination: operation === previous ? priorPara.stripeAccountId : currentPara.stripeAccountId, transfer_group: `case_${matter._id}`, source_transaction: "ch_transfer_events", metadata: { caseId: String(matter._id), attorneyId: String(owner._id), paralegalId: String(operation === previous ? priorPara._id : currentPara._id), operationKey: operation.operationKey }, reversed: false, amount_reversed: 0, ...patch });
const select = (type, object) => { event = { id: `evt_${new mongoose.Types.ObjectId()}`, type, livemode: false, created: 1788955200, data: { object } }; mockStripe.webhooks.constructEvent.mockReturnValue(event); };
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Payout.init(), Operation.init(), Audit.init(), Delivery.init()]); });
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, priorPara, currentPara] = await User.create(["owner", "prior", "current"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@transfer-events.test`, password: "Synthetic123!", role: name === "owner" ? "attorney" : "paralegal", status: "approved", ...(name !== "owner" ? { stripeAccountId: `acct_${name}_transfer_events`, stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "River Street retained lease review", details: "Earlier withdrawal and current completion payout.", attorney: owner._id, attorneyId: owner._id, paralegal: currentPara._id, paralegalId: currentPara._id, status: "completed", totalAmount: 100000, lockedTotalAmount: 100000, remainingAmount: 80000, currency: "usd", stripeMode: "test", paymentIntentId: "pi_transfer_events", escrowIntentId: "pi_transfer_events", escrowStatus: "released", paymentStatus: "succeeded", paymentReleased: true, payoutTransferId: "tr_current", payoutStatus: "paid", paidOutAt: new Date("2026-09-07T12:00:00Z"), completedAt: new Date("2026-09-07T12:00:00Z") });
  [previous, current, unrelated] = await Operation.create([
    { caseId: matter._id, kind: "partial_payout", operationKey: `partial_payout:${matter._id}:${priorPara._id}:earlier`, fingerprint: "prior", status: "succeeded", amount: 16400, transferAmount: 16400, currency: "usd", stripeMode: "test", stripeTransferId: "tr_prior", stripeObjectId: "tr_prior", stripeChargeId: "ch_transfer_events" },
    { caseId: matter._id, kind: "case_payout", operationKey: `case_payout:${matter._id}`, fingerprint: "current", status: "succeeded", amount: 65600, transferAmount: 65600, currency: "usd", stripeMode: "test", stripeTransferId: "tr_current", stripeObjectId: "tr_current", stripeChargeId: "ch_transfer_events" },
    { caseId: matter._id, kind: "refund", operationKey: `refund:${matter._id}`, fingerprint: "unrelated", status: "pending", amount: 1000, currency: "usd", stripeMode: "test" },
  ]);
  await Payout.create([
    { caseId: matter._id, paralegalId: priorPara._id, operationKey: previous.operationKey, amountPaid: 16400, transferId: "tr_prior", status: "paid", stripeMode: "test" },
    { caseId: matter._id, paralegalId: currentPara._id, operationKey: current.operationKey, amountPaid: 65600, transferId: "tr_current", status: "paid", stripeMode: "test" },
  ]);
});

test("an older transfer-created event cannot change the current Matter payout", async () => {
  const before = await raw(); select("transfer.created", transfer());
  expect((await send()).status).toBe(200);
  expect(await raw()).toEqual(before);
});

test("a transfer-created event cannot attach itself to an unrelated refund operation", async () => {
  const before = await Operation.findById(unrelated._id).lean(); select("transfer.created", transfer());
  expect((await send()).status).toBe(200);
  expect(await Operation.findById(unrelated._id).lean()).toEqual(before);
});

test("a reversal of an earlier withdrawal updates its payout without changing the current Matter", async () => {
  const before = await raw(), currentBefore = await Payout.findOne({ transferId: "tr_current" }).lean();
  select("transfer.reversed", transfer(previous, { reversed: true, amount_reversed: 16400 }));
  expect((await send()).status).toBe(200);
  expect((await Payout.findOne({ transferId: "tr_prior" }).lean()).status).toBe("reversed");
  expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(currentBefore);
  expect(await raw()).toEqual(before);
});

test("an audit failure rolls back the matching Case, payout and operation changes", async () => {
  const before = await raw(), payout = await Payout.findOne({ transferId: "tr_current" }).lean(), operation = await Operation.findById(current._id).lean();
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 }));
  jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
  expect((await send()).status).toBe(500);
  expect(await raw()).toEqual(before);
  expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(payout);
  expect(await Operation.findById(current._id).lean()).toEqual(operation);
});

test("a partial transfer reversal is not recorded as a full reversal", async () => {
  select("transfer.reversed", transfer(current, { reversed: false, amount_reversed: 1000 }));
  expect((await send()).status).toBe(200);
  const payout = await Payout.findOne({ transferId: "tr_current" }).lean();
  expect(payout.status).toBe("needs_reconciliation"); expect(payout.reversedAt).toBeNull();
});

test.each([
  { amount: 65601 }, { currency: "eur" }, { livemode: true }, { amount_reversed: 65601 },
  { reversed: true, amount_reversed: 1000 }, { transfer_group: "case_000000000000000000000099" },
  { source_transaction: "ch_another" }, { metadata: { operationKey: "another_operation" } },
])("mismatched transfer evidence %j never changes a Matter or payout", async patch => {
  const before = await raw(), payout = await Payout.findOne({ transferId: "tr_current" }).lean();
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600, ...patch }));
  expect((await send()).status).toBe(200);
  expect(await raw()).toEqual(before); expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(payout);
  expect((await Audit.findOne({ action: "transfer.reversed" }).lean()).meta.outcome).toBe("needs_review");
});

test("a transfer-created observation cannot invent a paid ledger or complete the Matter", async () => {
  await Payout.deleteOne({ transferId: "tr_current" });
  await Case.updateOne({ _id: matter._id }, { $set: { status: "in progress", paymentReleased: false, payoutTransferId: "", payoutStatus: "pending" } });
  await Operation.updateOne({ _id: current._id }, { $set: { status: "pending" } });
  const before = await raw(), operation = await Operation.findById(current._id).lean(); select("transfer.created", transfer(current));
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
  expect(await Operation.findById(current._id).lean()).toEqual(operation); expect(await Payout.countDocuments({ transferId: "tr_current" })).toBe(0);
});

test("a later positive event cannot clear a partial reversal", async () => {
  select("transfer.reversed", transfer(current, { amount_reversed: 1000 })); expect((await send()).status).toBe(200);
  const before = await raw(), payout = await Payout.findOne({ transferId: "tr_current" }).lean(), operation = await Operation.findById(current._id).lean();
  select("transfer.created", transfer(current)); expect((await send()).status).toBe(200);
  expect(await raw()).toEqual(before); expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(payout);
  expect(await Operation.findById(current._id).lean()).toEqual(operation);
});

test("an older partial reversal cannot downgrade a full reversal or its recorded date", async () => {
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 })); expect((await send()).status).toBe(200);
  const payout = await Payout.findOne({ transferId: "tr_current" }).lean();
  select("transfer.reversed", transfer(current, { amount_reversed: 1000 })); event.created -= 100;
  expect((await send()).status).toBe(200);
  expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(payout);
  expect((await raw()).payoutStatus).toBe("reversed");
});

test("two operations claiming the same transfer are held for review without financial writes", async () => {
  await Operation.updateOne({ _id: unrelated._id }, { $set: { stripeObjectId: "tr_current" } });
  const before = await raw(), payout = await Payout.findOne({ transferId: "tr_current" }).lean();
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 })); expect((await send()).status).toBe(200);
  expect(await raw()).toEqual(before); expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(payout);
  expect((await Audit.findOne({ action: "transfer.reversed" }).lean()).meta.associationProblem).toBe("ambiguous_transfer");
});

test("a lost transaction acknowledgement retains one complete financial outcome and dedupes retry", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false;
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic lost commit acknowledgement"); } }; return session; });
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 }));
  expect((await send()).status).toBe(500);
  expect((await Delivery.findOne({ eventId: event.id })).status).toBe("processed");
  expect((await raw()).payoutStatus).toBe("reversed");
  expect((await send()).body.deduped).toBe(true);
  expect(await Audit.countDocuments({ action: "transfer.reversed" })).toBe(1);
});

test("a replaced delivery cannot perform late financial or audit writes", async () => {
  const start = mongoose.startSession.bind(mongoose); let release, arrive, calls = 0;
  const waiting = new Promise(resolve => { arrive = resolve; }), held = new Promise(resolve => { release = resolve; });
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { if (++calls === 1) { arrive(); await held; } return start(); });
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 }));
  const first = send().then(value => value);
  try {
    await waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } });
    expect((await send()).status).toBe(200); const committed = await raw();
    release(); expect((await first).status).toBe(500); expect(await raw()).toEqual(committed);
  } finally { release(); await first; }
  expect(await Audit.countDocuments({ action: "transfer.reversed" })).toBe(1);
  expect(await Delivery.findOne({ eventId: event.id }).lean()).toMatchObject({ status: "processed", attempts: 2 });
});

test("a failed operation write rolls back the earlier payout update", async () => {
  const before = await raw(), payout = await Payout.findOne({ transferId: "tr_current" }).lean();
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 }));
  jest.spyOn(Operation.collection, "updateOne").mockRejectedValueOnce(new Error("Synthetic operation unavailable"));
  expect((await send()).status).toBe(500);
  expect(await raw()).toEqual(before); expect(await Payout.findOne({ transferId: "tr_current" }).lean()).toEqual(payout);
  expect(await Audit.countDocuments({ action: "transfer.reversed" })).toBe(0);
});

test("a reversed transfer cannot later create a paid local ledger", async () => {
  await Payout.deleteOne({ transferId: "tr_current" });
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 })); expect((await send()).status).toBe(200);
  await expect(require("../services/paymentLedgerService").upsertPayoutLedger({ operationKey: current.operationKey, caseId: matter._id, paralegalId: currentPara._id, amountPaid: 65600, transferId: "tr_current", stripeMode: "test" })).rejects.toThrow(/review|revers|conflict/);
  expect(await Payout.countDocuments({ transferId: "tr_current" })).toBe(0);
});

test("a payout completion cannot overwrite an operation quarantined by its reversal", async () => {
  select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 })); expect((await send()).status).toBe(200);
  await expect(require("../services/paymentOperationService").succeedPaymentOperation(current, "tr_current")).rejects.toThrow(/review|revers|conflict/);
  expect((await Operation.findById(current._id).lean()).status).toBe("needs_reconciliation");
});

test("a reversal racing an in-flight payout transaction retries without leaving mixed records", async () => {
  await Payout.deleteOne({ transferId: "tr_current" });
  await Operation.updateOne({ _id: current._id }, { $set: { status: "pending" } });
  await Case.updateOne({ _id: matter._id }, { $set: { status: "in progress", paymentReleased: false, payoutStatus: "pending" } });
  let release, ready, reversing;
  const held = new Promise(resolve => { release = resolve; }), staged = new Promise(resolve => { ready = resolve; }), callbackArrived = new Promise(resolve => { reversing = resolve; });
  const update = Operation.collection.updateOne.bind(Operation.collection);
  jest.spyOn(Operation.collection, "updateOne").mockImplementation((...args) => { if (args[1]?.$set?.evidenceStatus === "quarantined") reversing(); return update(...args); });
  const { withPayoutTransaction, upsertPayoutLedger } = require("../services/paymentLedgerService");
  const producer = withPayoutTransaction(async session => {
    await upsertPayoutLedger({ operationKey: current.operationKey, caseId: matter._id, paralegalId: currentPara._id, amountPaid: 65600, transferId: "tr_current", stripeMode: "test" }, { session });
    await require("../services/paymentOperationService").succeedPaymentOperation(current, "tr_current", { session });
    await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "completed", paymentReleased: true, payoutStatus: "paid" } }, { session });
    ready(); await held;
  });
  let callback;
  try {
    await staged; select("transfer.reversed", transfer(current, { reversed: true, amount_reversed: 65600 }));
    callback = send().then(value => value); await callbackArrived;
    release(); await producer;
    expect((await callback).status).toBe(500);
    expect((await Payout.findOne({ transferId: "tr_current" })).status).toBe("paid");
    expect((await raw()).paymentReleased).toBe(true);
    expect(await Audit.countDocuments({ action: "transfer.reversed" })).toBe(0);
    expect((await send()).status).toBe(200);
    expect((await Payout.findOne({ transferId: "tr_current" })).status).toBe("reversed");
    expect((await raw()).status).toBe("completed"); expect((await raw()).paymentReleased).toBe(false);
    expect((await Operation.findById(current._id)).evidenceStatus).toBe("quarantined");
    expect(await Payout.countDocuments({ transferId: "tr_current" })).toBe(1);
    expect(await Audit.countDocuments({ action: "transfer.reversed" })).toBe(1);
  } finally { release(); await producer; if (callback) await callback; }
});
