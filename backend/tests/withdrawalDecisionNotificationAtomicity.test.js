const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, fallback) => fallback), stripeIdempotencyKey: jest.fn((kind, ...values) => `${kind}:${values.join(":")}`), caseTransferGroup: jest.fn(value => `case_${value}`) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/caseLifecycle", () => ({ generateArchiveZip: jest.fn(), buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%synthetic")), uploadPdfToS3: jest.fn(async () => ({ key: "synthetic/receipt.pdf" })), getReceiptKey: jest.fn(() => "synthetic/receipt.pdf") }));
const User = require("../models/User"), Case = require("../models/Case"), Job = require("../models/Job"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation"), Income = require("../models/PlatformIncome"), AuditLog = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/disputes", require("../routes/disputes"));
let owner, other, para, admin, matter;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${matter._id}/withdrawal-review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(app).post(`/api/cases/${matter._id}/withdrawal-decision`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const raw = () => Case.collection.findOne({ _id: matter._id }), change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });
async function command(action = "partial", amountCents = 20000) { const review = await read(); expect({ status: review.status, body: review.body }).toMatchObject({ status: 200 }); return { requestId: crypto.randomUUID(), action, reviewedRevision: review.body.revision, ...(action === "partial" ? { amountCents } : {}) }; }
const providerTransfer = (payload, patch = {}) => ({ id: "tr_withdrawal", object: "transfer", ...payload, livemode: false, reversed: false, amount_reversed: 0, created: Math.floor(Date.now() / 1000), ...patch });
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Job.init(), Payout.init(), Operation.init(), Income.init(), AuditLog.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); mockStripe.transfers.create.mockReset(); mockStripe.paymentIntents.retrieve.mockReset();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@withdrawal.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved", ...(name === "para" ? { stripeAccountId: "acct_withdrawal", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "River Street lease review", practiceArea: "Real Estate Law", details: "Review retained lease exhibits.", attorney: owner._id, attorneyId: owner._id, status: "paused", pausedReason: "paralegal_withdrew", pausedAt: new Date("2026-09-01"), withdrawnParalegalId: para._id, escrowStatus: "funded", escrowIntentId: "pi_withdrawal", paymentIntentId: "pi_withdrawal", fundingIntegrityStatus: "verified", totalAmount: 100000, lockedTotalAmount: 100000, remainingAmount: 100000, feeParalegalPct: 18, feeAttorneyPct: 22, feeAttorneyAmount: 22000, currency: "usd", stripeMode: "test", tasks: [{ title: "Review lease exhibits", completed: true }, { title: "Review renewal terms", completed: false }] });
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_withdrawal", status: "succeeded", amount: 122000, amount_received: 122000, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id) }, latest_charge: { id: "ch_withdrawal", transfer_group: `case_${matter._id}` } });
  mockStripe.isTransferablePaymentIntent.mockReturnValue({ transferable: true, charge: { id: "ch_withdrawal" } }); mockStripe.transfers.create.mockImplementation(async payload => providerTransfer(payload));
});

const Notification = require("../models/Notification"), Notice = require("../models/MatterWithdrawalNotification");
const lifecycle = require("../services/withdrawalLifecycle");
test.each(["partial", "reject", "relist"])("%s cannot commit without both in-app notices and its durable email obligations", async action => {
  if (action === "relist") await change({ payoutFinalizedType: "expired_zero", payoutFinalizedAt: new Date("2026-09-02"), partialPayoutAmount: 0, relistRequestedAt: null });
  const before = await raw(), body = await command(action, 0);
  const unavailable = jest.spyOn(Notification, "create").mockRejectedValueOnce(new Error("Synthetic notice persistence interruption"));
  expect((await send(body)).status).toBeGreaterThanOrEqual(500);
  expect(await raw()).toEqual(before); expect(await Job.countDocuments()).toBe(0);
  expect(await AuditLog.countDocuments({ action: "case.withdrawal.recorded" })).toBe(0);
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
  unavailable.mockRestore();
  expect((await send(body)).status).toBe(200); expect((await send(body)).body.operation.status).toBe("recorded");
  expect(await Notification.countDocuments()).toBe(2); expect(await Notice.countDocuments({ status: "pending" })).toBe(2);
  expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("a positive transfer cannot be finalized without its retained notices or released a second time", async () => {
  const body = await command(); jest.spyOn(Notice, "create").mockRejectedValueOnce(new Error("Synthetic obligation persistence interruption"));
  expect((await send(body)).status).toBeGreaterThanOrEqual(500);
  expect(await raw()).toMatchObject({ payoutFinalizedAt: null, remainingAmount: 100000, withdrawalClaimStatus: "needs_reconciliation" });
  expect(await Payout.countDocuments()).toBe(0); expect(await Income.countDocuments()).toBe(0);
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
  expect((await send(body)).body.operation.status).toBe("needs_review"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a scheduled expiry with failed notice persistence remains eligible for the next run", async () => {
  await change({ disputeDeadlineAt: new Date(Date.now() - 1000) }); const before = await raw();
  jest.spyOn(Notification, "create").mockRejectedValueOnce(new Error("Synthetic expiry notice interruption"));
  expect(await lifecycle.processExpiredWithdrawalWindows()).toMatchObject({ scanned: 1, finalized: 0, failed: 1 });
  expect(await raw()).toEqual(before); expect(await Job.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
  expect(await lifecycle.processExpiredWithdrawalWindows()).toMatchObject({ scanned: 1, finalized: 1, failed: 0 });
  expect(await Notification.countDocuments()).toBe(2); expect(await Notice.countDocuments({ status: "pending" })).toBe(2);
  expect((await lifecycle.processExpiredWithdrawalWindows()).finalized).toBe(0); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("request-time expiry retains the same two recipient notices as scheduled expiry", async () => {
  await change({ disputeDeadlineAt: new Date(Date.now() - 1000) });
  expect((await request(app).get(`/api/cases/${matter._id}`).set("Cookie", cookie(owner))).status).toBe(200);
  expect((await raw()).payoutFinalizedType).toBe("expired_zero");
  expect(await Notification.countDocuments()).toBe(2); expect(await Notice.countDocuments({ status: "pending" })).toBe(2);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("an administrator decline records both notices without attributing it to the attorney", async () => {
  const response = await request(app).post(`/api/cases/${matter._id}/reject-payout`).set("Cookie", cookie(admin)).send({});
  expect(response.status).toBe(200); expect(await Notice.countDocuments({ kind: "reject", status: "pending" })).toBe(2);
  const paraNotice = await Notification.findOne({ userId: para._id });
  expect(paraNotice.payload.summary).toBe("Release was declined and a payment-review window was opened.");
  expect(require("../utils/email")).not.toHaveBeenCalled(); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
