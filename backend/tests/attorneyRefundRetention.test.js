const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
const mockStripe = { refunds: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() }, paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, message) => message), stripeIdempotencyKey: jest.fn((operation, ...parts) => `synthetic_${operation}_${parts.join("_")}`) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Income = require("../models/PlatformIncome"), Audit = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/payments", require("../routes/payments")); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
let owner, para, admin, matter, disputeId;
const raw = () => Case.collection.findOne({ _id: matter._id });
const send = (action = "refund", body = {}) => request(app).post(`/api/payments/dispute/settle/${matter._id}`).set("Cookie", `token=${require("jsonwebtoken").sign({ id: String(admin._id), role: "admin", av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`).send({ action, disputeId, ...body });
const charge = (patch = {}) => ({ id: "ch_refund_retention", object: "charge", payment_intent: "pi_refund_retention", amount: 122000, amount_captured: 122000, amount_refunded: 0, paid: true, captured: true, refunded: false, disputed: false, status: "succeeded", currency: "usd", livemode: false, balance_transaction: { id: "txn_refund_capture", type: "charge", amount: 122000, fee: 3500, net: 118500, currency: "usd", source: "ch_refund_retention" }, ...patch });
const intent = () => ({ id: "pi_refund_retention", object: "payment_intent", status: "succeeded", amount: 122000, amount_received: 122000, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: charge() });
const refund = (patch = {}) => ({ id: "re_refund_retention", object: "refund", status: "succeeded", amount: 122000, currency: "usd", charge: "ch_refund_retention", payment_intent: "pi_refund_retention", balance_transaction: "txn_refund_retention", metadata: { caseId: String(matter._id), disputeId, action: "refund" }, ...patch });
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Income.init(), Audit.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); for (const group of Object.values(mockStripe)) if (group && typeof group === "object") for (const fn of Object.values(group)) fn.mockReset?.();
  [owner, para, admin] = await User.create(["owner", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@refund-retention.test`, password: "Synthetic123!", role: name === "owner" ? "attorney" : name === "para" ? "paralegal" : "admin", status: "approved", ...(name === "para" ? { stripeAccountId: "acct_refund_retention", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "River Street disputed lease work", details: "Refund outcome and retained reference checks.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "disputed", totalAmount: 100000, lockedTotalAmount: 100000, remainingAmount: 100000, feeAttorneyPct: 22, feeAttorneyAmount: 22000, currency: "usd", stripeMode: "test", paymentIntentId: "pi_refund_retention", escrowIntentId: "pi_refund_retention", escrowStatus: "funded", paymentStatus: "succeeded", disputes: [{ message: "Review the refund request.", raisedBy: owner._id, status: "open" }] });
  disputeId = matter.disputes[0].disputeId || String(matter.disputes[0]._id);
  mockStripe.paymentIntents.retrieve.mockImplementation(async () => intent()); mockStripe.charges.retrieve.mockImplementation(async () => charge()); mockStripe.refunds.create.mockImplementation(async () => refund()); mockStripe.refunds.retrieve.mockImplementation(async () => refund()); mockStripe.refunds.list.mockResolvedValue({ data: [], has_more: false }); mockStripe.isTransferablePaymentIntent.mockImplementation(() => ({ transferable: true, charge: charge() }));
});
test("an unknown refund request remains protected past ordinary retry and provider-key expiry", async () => {
  mockStripe.refunds.create.mockRejectedValueOnce(new Error("Synthetic unknown refund result")); expect((await send()).status).toBeGreaterThanOrEqual(400);
  await Operation.updateMany({}, { $set: { lastAttemptAt: new Date(Date.now() - 172800000) } });
  expect((await send()).status).toBeGreaterThanOrEqual(400); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1); expect((await raw()).status).toBe("disputed");
});
test("already-refunded errors cannot invent a refund identifier or close the dispute", async () => {
  mockStripe.refunds.create.mockRejectedValueOnce(Object.assign(new Error("Synthetic already refunded"), { code: "charge_already_refunded" }));
  expect((await send()).status).toBeGreaterThanOrEqual(400); expect((await raw()).status).toBe("disputed"); expect(JSON.stringify(await Operation.find().lean())).not.toContain("already_refunded_");
});
test("a pending Stripe refund is not a completed dispute settlement", async () => {
  mockStripe.refunds.create.mockResolvedValueOnce(refund({ status: "pending", balance_transaction: null })); mockStripe.refunds.retrieve.mockResolvedValue(refund({ status: "pending", balance_transaction: null }));
  await send(); const saved = await raw(); expect(saved.status).toBe("disputed"); expect(saved.disputeSettlement.resolvedAt).toBeNull(); expect((await Operation.findOne()).status).not.toBe("succeeded"); expect((await Operation.findOne()).stripeRefundId).toBe("re_refund_retention");
});
test("a known refund reference survives interruption of its operation evidence write", async () => {
  const write = Operation.collection.findOneAndUpdate.bind(Operation.collection); let interrupted = false;
  jest.spyOn(Operation.collection, "findOneAndUpdate").mockImplementation((key, patch, options) => { if (!interrupted && patch.$set?.stripeRefundId) { interrupted = true; return Promise.reject(new Error("Synthetic reference write unavailable")); } return write(key, patch, options); });
  await send(); const operations = await Operation.find().lean(), audits = await Audit.find().lean();
  expect(interrupted).toBe(true);
  expect(JSON.stringify([operations, audits])).toContain("re_refund_retention");
});
test("a confirmed full refund closes the matching dispute with its exact original charge amount", async () => {
  const response = await send(); expect({ status: response.status, body: response.body }).toMatchObject({ status: 200, body: { ok: true, refundId: "re_refund_retention", refundAmount: 122000 } });
  expect((await raw()).status).toBe("closed"); expect((await raw()).paymentStatus).toBe("refunded"); expect((await raw()).escrowStatus).toBe("refunded");
  expect(await Operation.findOne().lean()).toMatchObject({ status: "succeeded", stripeRefundId: "re_refund_retention", refundAmount: 122000 }); expect(await Audit.countDocuments({ action: "dispute.settlement.refund" })).toBe(1);
  expect(mockStripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_refund_retention", amount: 122000 }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
  expect((await send()).body.alreadySettled).toBe(true); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
});
test("a retained pending refund can be checked after Stripe completes it without another refund", async () => {
  mockStripe.refunds.create.mockResolvedValueOnce(refund({ status: "pending" })); expect((await send()).status).toBe(409); expect((await raw()).status).toBe("disputed");
  expect((await send()).status).toBe(200); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1); expect(mockStripe.refunds.retrieve).toHaveBeenCalledWith("re_refund_retention");
});
test("the retained audit reference recovers an interrupted operation write", async () => {
  const write = Operation.collection.findOneAndUpdate.bind(Operation.collection); let interrupted = false;
  jest.spyOn(Operation.collection, "findOneAndUpdate").mockImplementation((filter, patch, options) => { if (!interrupted && patch.$set?.stripeRefundId) { interrupted = true; return Promise.reject(new Error("Synthetic operation reference interruption")); } return write(filter, patch, options); });
  expect((await send()).status).toBe(409); expect(interrupted).toBe(true); expect((await send()).status).toBe(200); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
});
test("settlement audit failure rolls back closure while retaining the actual provider refund", async () => {
  const create = Audit.create.bind(Audit); jest.spyOn(Audit, "create").mockImplementation((rows, options) => (Array.isArray(rows) ? rows : [rows]).some(row => row.action === "dispute.settlement.refund") ? Promise.reject(new Error("Synthetic settlement audit unavailable")) : create(rows, options));
  expect((await send()).status).toBe(503); const saved = await raw(); expect(saved.status).toBe("disputed"); expect(saved.disputes[0].status).toBe("open"); expect(saved.disputeSettlement.refundId).toBe(""); expect((await Operation.findOne()).stripeRefundId).toBe("re_refund_retention"); expect((await Operation.findOne()).status).toBe("needs_reconciliation");
});
test("a lost pre-request commit acknowledgement prevents an unverified provider retry", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false;
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic request commit acknowledgement lost"); } }; return session; });
  expect((await send()).status).toBe(503); expect(mockStripe.refunds.create).not.toHaveBeenCalled(); expect((await send()).status).toBe(409); expect(mockStripe.refunds.create).not.toHaveBeenCalled(); expect((await raw()).status).toBe("disputed");
});
test("a lost settlement acknowledgement preserves the complete result and verifies it on replay", async () => {
  const start = mongoose.startSession.bind(mongoose), create = Audit.create.bind(Audit); let targetSession, interrupted = false;
  jest.spyOn(Audit, "create").mockImplementation((rows, options) => { if (rows?.[0]?.action === "dispute.settlement.refund") targetSession = options.session; return create(rows, options); });
  jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted && session === targetSession) { interrupted = true; throw new Error("Synthetic settlement commit acknowledgement lost"); } }; return session; });
  expect((await send()).status).toBe(503); expect(interrupted).toBe(true); expect((await raw()).status).toBe("closed"); expect((await Operation.findOne()).status).toBe("succeeded");
  expect((await send()).body.alreadySettled).toBe(true); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1); expect(await Audit.countDocuments({ action: "dispute.settlement.refund" })).toBe(1);
});
test("a historical completed marker cannot overwrite later negative refund evidence", async () => {
  expect((await send()).status).toBe(200); await Operation.updateOne({}, { $set: { status: "needs_reconciliation", evidenceStatus: "quarantined", lastError: "Synthetic later refund failure" } }); const before = await Operation.findOne().lean();
  expect((await send()).status).toBe(409); expect(await Operation.findOne().lean()).toEqual(before); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
});
test("a replaced operation attempt cannot receive a late refund reference", async () => {
  mockStripe.refunds.create.mockImplementationOnce(async () => { await Operation.updateOne({}, { $inc: { attempts: 1 }, $set: { status: "needs_reconciliation" } }); return refund(); });
  expect((await send()).status).toBe(409); expect((await raw()).status).toBe("disputed"); expect((await Operation.findOne()).stripeRefundId).toBe(""); expect(JSON.stringify(await Audit.find().lean())).toContain("re_refund_retention");
});
test("legacy unknown refund attempts are held instead of receiving a new provider key", async () => {
  const service = require("../services/paymentOperationService"), claim = await service.claimPaymentOperation({ operationKey: `dispute_settlement:${matter._id}:${disputeId}`, caseId: matter._id, kind: "dispute_settlement", fingerprint: { action: "refund", grossAmountCents: null, payoutAmountCents: null, paymentIntentId: "pi_refund_retention", paralegalId: String(para._id) }, amount: 100000 });
  await Operation.updateOne({ _id: claim.operation._id }, { $set: { status: "failed" } }); expect((await send()).status).toBe(409); expect(mockStripe.refunds.create).not.toHaveBeenCalled();
});
test.each(["requires_action", "failed", "canceled"])("a %s refund retains its reference without settling or repeating the request", async status => {
  mockStripe.refunds.create.mockResolvedValueOnce(refund({ status })); mockStripe.refunds.retrieve.mockResolvedValue(refund({ status }));
  expect((await send()).status).toBe(409); expect((await send()).status).toBe(409); expect((await raw()).status).toBe("disputed"); expect((await Operation.findOne()).stripeRefundId).toBe("re_refund_retention"); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
});
test("a changed Matter after Stripe responds preserves the refund reference without overwriting the new state", async () => {
  mockStripe.refunds.create.mockImplementationOnce(async () => { await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "paused", remainingAmount: 12345 } }); return refund(); });
  expect((await send()).status).toBe(409); expect((await raw()).status).toBe("paused"); expect((await raw()).remainingAmount).toBe(12345); expect((await Operation.findOne()).stripeRefundId).toBe("re_refund_retention");
});
test.each([{ amount: 10000 }, { currency: "eur" }, { charge: "ch_other" }, { payment_intent: "pi_other" }])("mismatched returned refund evidence %j is retained for review and cannot settle", async patch => {
  mockStripe.refunds.create.mockResolvedValueOnce(refund(patch)); mockStripe.refunds.retrieve.mockResolvedValue(refund(patch));
  expect((await send()).status).toBe(409); expect((await raw()).status).toBe("disputed"); expect((await Operation.findOne()).status).toBe("needs_reconciliation"); expect((await Operation.findOne()).stripeRefundId).toBe("re_refund_retention");
  expect((await send()).status).toBe(409); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
});
test("a failed refund callback cannot be overwritten by the in-flight settlement producer", async () => {
  const Delivery = require("../models/WebhookEvent"); await Delivery.init(); const update = Operation.collection.updateOne.bind(Operation.collection); let interrupted = false;
  jest.spyOn(Operation.collection, "updateOne").mockImplementation(async (filter, patch, options) => {
    const saved = await update(filter, patch, options);
    if (!interrupted && patch.$set?.refundStatus === "succeeded") {
      interrupted = true; const failed = refund({ status: "failed" }); mockStripe.refunds.retrieve.mockResolvedValue(failed); mockStripe.refunds.list.mockResolvedValue({ data: [failed], has_more: false });
      const event = { id: "evt_inflight_refund_failure", type: "refund.failed", livemode: false, created: 1788955200, data: { object: failed } };
      const receipt = await Delivery.create({ eventId: event.id, type: event.type, status: "processing", attempts: 1, lastAttemptAt: new Date(), stripeMode: "test" });
      await require("../services/attorneyRefundEvents").record({ event, receiptFilter: { _id: receipt._id, eventId: event.id, status: "processing", attempts: 1, lastAttemptAt: receipt.lastAttemptAt }, stripe: mockStripe });
    }
    return saved;
  });
  expect((await send()).status).toBe(409); expect(interrupted).toBe(true); expect((await raw()).status).toBe("disputed"); expect((await raw()).paymentStatus).toBe("refund_failed");
  expect(await Operation.findOne().lean()).toMatchObject({ status: "needs_reconciliation", evidenceStatus: "quarantined", refundStatus: "failed" });
  expect((await send()).status).toBe(409); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
});
