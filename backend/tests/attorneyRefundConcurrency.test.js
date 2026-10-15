"use strict";
const mongoose = require("mongoose");
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Income = require("../models/PlatformIncome"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { record } = require("../services/attorneyRefundEvents");
let matter, owner, para, settlement, stripe, refund, charge, intent;
const conflict = (labels = ["TransientTransactionError"]) => new mongoose.mongo.MongoServerError({ message: "Synthetic aborted write conflict", code: 112, codeName: "WriteConflict", errorLabels: labels });
const receipt = async (type = "refund.created") => {
  const event = { id: `evt_${new mongoose.Types.ObjectId()}`, type, livemode: false, created: 1788955200, data: { object: type === "charge.refunded" ? charge : refund } };
  const row = await Delivery.create({ eventId: event.id, type, stripeMode: "test", status: "processing", attempts: 1, lastAttemptAt: new Date(), attentionRequired: true, attentionCategory: "processing" });
  return { event, receiptFilter: { _id: row._id, eventId: event.id, status: "processing", attempts: 1, lastAttemptAt: row.lastAttemptAt }, stripe };
};
const raw = () => Case.collection.findOne({ _id: matter._id });
const protectedCase = value => { const { __v, updatedAt, ...rest } = value; return rest; };
const financialSnapshot = async () => ({ matter: protectedCase(await raw()), payout: await Payout.findOne().lean(), income: await Income.findOne().lean() });
const assertNoProviderMutation = () => { expect(stripe.refunds.create).not.toHaveBeenCalled(); expect(stripe.transfers.create).not.toHaveBeenCalled(); };
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Income.init(), Audit.init(), Delivery.init()]); });
afterAll(closeDatabase);
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase();
  [owner, para] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@refund-conflict.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ title: "Synthetic protected partial settlement", details: "Concurrent authoritative refund observations.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "closed", archived: true, readOnly: true, totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 0, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: "usd", stripeMode: "test", paymentIntentId: "pi_refund_conflict", escrowIntentId: "pi_refund_conflict", escrowStatus: "released", paymentStatus: "partially_refunded", paymentReleased: true, payoutStatus: "paid", payoutTransferId: "tr_refund_conflict", partialPayoutAmount: 20000, paidOutAt: new Date("2026-09-08T12:00:00Z") });
  settlement = await Operation.create({ caseId: matter._id, kind: "dispute_settlement", operationKey: `dispute_settlement:${matter._id}:partial`, fingerprint: "synthetic-partial-settlement", status: "succeeded", amount: 20000, transferAmount: 16400, stripeTransferId: "tr_refund_conflict", stripeRefundId: "re_refund_conflict", stripePaymentIntentId: "pi_refund_conflict", stripeChargeId: "ch_refund_conflict", refundAmount: 24400, currency: "usd", stripeMode: "test" });
  await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: settlement.operationKey, amountPaid: 16400, transferId: "tr_refund_conflict", status: "paid", stripeMode: "test" });
  await Income.create({ caseId: matter._id, attorneyId: owner._id, paralegalId: para._id, operationKey: settlement.operationKey, feeAmount: 8000, stripeMode: "test" });
  refund = { id: "re_refund_conflict", object: "refund", status: "succeeded", amount: 24400, currency: "usd", charge: "ch_refund_conflict", payment_intent: "pi_refund_conflict", created: 1788951600, metadata: { caseId: String(matter._id) } };
  charge = { id: "ch_refund_conflict", object: "charge", payment_intent: "pi_refund_conflict", amount: 48800, amount_captured: 48800, amount_refunded: 24400, paid: true, captured: true, refunded: false, disputed: false, status: "succeeded", currency: "usd", livemode: false, metadata: { caseId: String(matter._id) } };
  intent = { id: "pi_refund_conflict", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: charge };
  stripe = { refunds: { retrieve: jest.fn(async () => refund), list: jest.fn(async () => ({ data: [refund], has_more: false })), create: jest.fn() }, charges: { retrieve: jest.fn(async () => charge) }, paymentIntents: { retrieve: jest.fn(async () => intent) }, transfers: { create: jest.fn() } };
});

test("three real concurrent sibling refund transactions retry actual aborted Mongo conflicts without changing the partial settlement", async () => {
  const inputs = await Promise.all(["refund.created", "refund.updated", "charge.refunded"].map(receipt)), before = await financialSnapshot();
  const update = Operation.collection.updateOne.bind(Operation.collection), arrived = new Set(), actualConflicts = [];
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(release, 3000);
  jest.spyOn(Operation.collection, "updateOne").mockImplementation(async (...args) => {
    const session = args[2]?.session;
    if (session && !arrived.has(session)) { arrived.add(session); if (arrived.size === 3) release(); await barrier; }
    try { return await update(...args); }
    catch (error) { actualConflicts.push({ code: error.code, transient: error.hasErrorLabel?.("TransientTransactionError") }); throw error; }
  });
  let results;
  try { results = await Promise.all(inputs.map(input => record(input))); }
  finally { clearTimeout(timer); release(); }
  expect(arrived.size).toBeGreaterThan(3); expect(arrived.size).toBeLessThanOrEqual(9);
  expect(actualConflicts.length).toBeGreaterThanOrEqual(2); expect(actualConflicts.every(value => value.code === 112 && value.transient)).toBe(true);
  expect(results).toHaveLength(3); expect(results.every(result => result.outcome === "partially_refunded" && !result.needsReview)).toBe(true);
  expect(stripe.charges.retrieve).toHaveBeenCalledTimes(arrived.size); expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(arrived.size); expect(stripe.refunds.list).toHaveBeenCalledTimes(arrived.size);
  expect(await financialSnapshot()).toEqual(before); expect(await Operation.countDocuments()).toBe(1);
  expect(await Operation.findById(settlement._id).lean()).toMatchObject({ status: "succeeded", transferAmount: 16400, refundAmount: 24400, refundEvidenceStatus: "verified", refundStatus: "succeeded" });
  expect(await Audit.countDocuments({ "meta.kind": "refund_observation" })).toBe(3);
  for (const input of inputs) { expect(await Audit.countDocuments({ "meta.eventId": input.event.id })).toBe(1); expect(await Delivery.findOne({ eventId: input.event.id }).lean()).toMatchObject({ status: "processed", attempts: 1, attentionRequired: false, attentionCategory: "" }); }
  assertNoProviderMutation();
});

test("known transient precommit conflicts stop after three acknowledged aborts and retain all financial records", async () => {
  const input = await receipt(), before = await financialSnapshot();
  jest.spyOn(Operation.collection, "updateOne").mockRejectedValue(conflict());
  await expect(record(input)).rejects.toMatchObject({ code: 112 });
  expect(stripe.charges.retrieve).toHaveBeenCalledTimes(3); expect(await financialSnapshot()).toEqual(before); expect(await Audit.countDocuments()).toBe(0);
  expect((await Delivery.findById(input.receiptFilter._id)).status).toBe("processing"); assertNoProviderMutation();
});

test.each([["missing transient label", []], ["unknown commit label", ["TransientTransactionError", "UnknownTransactionCommitResult"]]])("a precommit conflict with %s is never replayed", async (_, labels) => {
  const input = await receipt(), before = await financialSnapshot(); jest.spyOn(Operation.collection, "updateOne").mockRejectedValueOnce(conflict(labels));
  await expect(record(input)).rejects.toMatchObject({ code: 112 }); expect(stripe.charges.retrieve).toHaveBeenCalledTimes(1); expect(await financialSnapshot()).toEqual(before); expect(await Audit.countDocuments()).toBe(0); assertNoProviderMutation();
});

test("a nontransient later audit failure rolls back and is never replayed", async () => {
  const input = await receipt(), before = await financialSnapshot(), operation = await Operation.findById(settlement._id).lean();
  jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic audit write unavailable"));
  await expect(record(input)).rejects.toThrow("Synthetic audit write unavailable"); expect(stripe.charges.retrieve).toHaveBeenCalledTimes(1); expect(await financialSnapshot()).toEqual(before); expect(await Operation.findById(settlement._id).lean()).toEqual(operation); expect(await Audit.countDocuments()).toBe(0); assertNoProviderMutation();
});

test("an unconfirmed abort is never used as permission to replay a write conflict", async () => {
  const input = await receipt(), start = mongoose.startSession.bind(mongoose), before = await financialSnapshot();
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), abort = session.abortTransaction.bind(session); session.abortTransaction = async () => { await abort(); throw new Error("Synthetic abort acknowledgement lost"); }; return session; });
  jest.spyOn(Operation.collection, "updateOne").mockRejectedValueOnce(conflict());
  await expect(record(input)).rejects.toMatchObject({ code: 112 }); expect(stripe.charges.retrieve).toHaveBeenCalledTimes(1); expect(await financialSnapshot()).toEqual(before); expect(await Audit.countDocuments()).toBe(0); assertNoProviderMutation();
});

test("a committed transaction with an unknown acknowledgement is not retried or duplicated", async () => {
  const input = await receipt(), start = mongoose.startSession.bind(mongoose), before = await financialSnapshot();
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw conflict(["TransientTransactionError", "UnknownTransactionCommitResult"]); }; return session; });
  await expect(record(input)).rejects.toMatchObject({ code: 112 }); expect(stripe.charges.retrieve).toHaveBeenCalledTimes(1); expect(await financialSnapshot()).toEqual(before); expect(await Audit.countDocuments()).toBe(1); expect((await Delivery.findById(input.receiptFilter._id)).status).toBe("processed"); assertNoProviderMutation();
});

test("record remains pending until its actual transaction commit has completed", async () => {
  const input = await receipt(), start = mongoose.startSession.bind(mongoose); let reached, release, settled = false;
  const waiting = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { reached(); await held; return commit(); }; return session; });
  const pending = record(input).finally(() => { settled = true; });
  try { await waiting; expect(settled).toBe(false); expect((await Delivery.findById(input.receiptFilter._id)).status).toBe("processing"); expect(await Audit.countDocuments()).toBe(0); }
  finally { release(); await pending; }
  expect(settled).toBe(true); expect((await Delivery.findById(input.receiptFilter._id)).status).toBe("processed"); assertNoProviderMutation();
});
