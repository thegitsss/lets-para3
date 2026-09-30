const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
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
const legacy = (action, body = {}, user = owner) => request(app).post(`/api/cases/${matter._id}/${action}`).set("Cookie", cookie(user)).send(body);
const raw = () => Case.collection.findOne({ _id: matter._id }), change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });

const providerTransfer = (payload, patch = {}) => ({ id: "tr_withdrawal", object: "transfer", ...payload, livemode: false, reversed: false, amount_reversed: 0, created: Math.floor(Date.now() / 1000), ...patch });
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Job.init(), Payout.init(), Operation.init(), Income.init(), AuditLog.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); mockStripe.transfers.create.mockReset(); mockStripe.paymentIntents.retrieve.mockReset();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@withdrawal.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved", ...(name === "para" ? { stripeAccountId: "acct_withdrawal", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "River Street lease review", practiceArea: "Real Estate Law", details: "Review retained lease exhibits.", attorney: owner._id, attorneyId: owner._id, status: "paused", pausedReason: "paralegal_withdrew", pausedAt: new Date("2026-09-01"), withdrawnParalegalId: para._id, escrowStatus: "funded", escrowIntentId: "pi_withdrawal", paymentIntentId: "pi_withdrawal", fundingIntegrityStatus: "verified", totalAmount: 100000, lockedTotalAmount: 100000, remainingAmount: 100000, feeParalegalPct: 18, feeAttorneyPct: 22, feeAttorneyAmount: 22000, currency: "usd", stripeMode: "test", tasks: [{ title: "Review lease exhibits", completed: true }, { title: "Review renewal terms", completed: false }] });
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_withdrawal", status: "succeeded", amount: 122000, amount_received: 122000, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id) }, latest_charge: { id: "ch_withdrawal", transfer_group: `case_${matter._id}` } });
  mockStripe.isTransferablePaymentIntent.mockReturnValue({ transferable: true, charge: { id: "ch_withdrawal" } }); mockStripe.transfers.create.mockImplementation(async payload => providerTransfer(payload));
});

test("Matter GET cannot finalize an expired window during a claimed administrator payout", async () => {
  await change({ disputeDeadlineAt: new Date(Date.now() - 1000) }); let release, arrived;
  const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  mockStripe.transfers.create.mockImplementationOnce(async payload => { arrived(); await gate; return providerTransfer(payload); });
  const running = legacy("partial-payout", { amountCents: 20000 }, admin).then(value => value);
  try { await waiting; const viewed = await request(app).get(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)); expect(viewed.status).toBe(200); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(await Job.countDocuments()).toBe(0); }
  finally { release(); await running; }
  expect((await raw()).partialPayoutAmount).toBe(20000); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("completed-history expiry reads the full balance instead of finalizing from its narrow display fields", async () => {
  await change({ disputeDeadlineAt: new Date(Date.now() - 1000) });
  const viewed = await request(app).get("/api/cases/my-completed").set("Cookie", cookie(para)); expect(viewed.status).toBe(200); expect((await raw()).remainingAmount).toBe(100000); expect((await raw()).payoutFinalizedType).toBe("expired_zero");
});
const withdrawal = require("../services/attorneyWithdrawal"), lifecycle = require("../services/withdrawalLifecycle"), receipt = require("../services/caseLifecycle");
async function due(patch = {}) { await change({ disputeDeadlineAt: new Date(Date.now() - 1000), ...patch }); }
test("the scheduled expiry commits the zero decision, full remaining amount, posting and system audit once", async () => {
  await due(); expect(await lifecycle.processExpiredWithdrawalWindows()).toMatchObject({ scanned: 1, finalized: 1, failed: 0 }); const saved = await raw(); expect(saved).toMatchObject({ payoutFinalizedType: "expired_zero", partialPayoutAmount: 0, remainingAmount: 100000, postingSyncStatus: "synced" }); expect((await Job.findById(saved.jobId)).budget).toBe(1000); expect(await AuditLog.countDocuments({ action: "case.withdrawal.expired", actorRole: "system" })).toBe(1); expect((await lifecycle.processExpiredWithdrawalWindows()).finalized).toBe(0); expect(await Payout.countDocuments()).toBe(0); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("two expiry callers cannot record the decision or create its posting twice", async () => {
  await due(); const outcomes = await Promise.allSettled([withdrawal.expire(String(matter._id)), withdrawal.expire(String(matter._id))]); expect(outcomes.some(result => result.status === "fulfilled" && result.value.changed)).toBe(true); for (const result of outcomes.filter(item => item.status === "rejected")) expect(result.reason.status).toBe(409); expect(await AuditLog.countDocuments({ action: "case.withdrawal.expired" })).toBe(1); expect(await Job.countDocuments()).toBe(1); expect((await raw()).remainingAmount).toBe(100000);
});
test("a previous finalized withdrawal is preserved and deducted once from the remaining assignment", async () => {
  await due({ remainingAmount: 80000, withdrawalHistory: [{ withdrawnParalegalId: other._id, pausedAt: new Date("2026-08-01"), payoutFinalizedAt: new Date("2026-08-02"), payoutFinalizedType: "partial_attorney", partialPayoutAmount: 20000, payoutTransferId: "tr_previous" }] }); await Payout.create({ caseId: matter._id, paralegalId: other._id, amountPaid: 16400, transferId: "tr_previous", status: "paid" }); const before = await raw(); expect((await withdrawal.expire(String(matter._id))).changed).toBe(true); const saved = await raw(); expect(saved.remainingAmount).toBe(80000); expect(saved.withdrawalHistory).toEqual(before.withdrawalHistory); expect((await Job.findById(saved.jobId)).budget).toBe(1000); expect(await Payout.countDocuments()).toBe(1);
});
test.each([{ status: "disputed" }, { archived: true }, { readOnly: true }, { paralegalId: new mongoose.Types.ObjectId() }, { withdrawalClaimStatus: "claimed" }, { withdrawalClaimToken: "active-request" }, { hiringClaimStatus: "claimed" }, { completionClaimStatus: "claimed" }])("expiry cannot change a closed, assigned or claimed Matter %j", async patch => {
  await due(patch); expect((await withdrawal.expire(String(matter._id))).changed).toBe(false); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(await Job.countDocuments()).toBe(0);
});
test.each([{ remainingAmount: 90000 }, { partialPayoutAmount: 1000 }, { payoutStatus: "reversed" }, { jobId: new mongoose.Types.ObjectId() }])("uncertain money or posting %j remains unfinalized", async patch => {
  await due(patch); await expect(withdrawal.expire(String(matter._id))).rejects.toMatchObject({ status: 409 }); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(await AuditLog.countDocuments({ action: "case.withdrawal.expired" })).toBe(0);
});
test("an unfinalized retained payout prevents an automatic zero outcome", async () => {
  await due(); await Payout.create({ caseId: matter._id, paralegalId: para._id, amountPaid: 16400, transferId: "tr_unfinalized", status: "paid" }); await expect(withdrawal.expire(String(matter._id))).rejects.toMatchObject({ status: 409 }); expect((await raw()).payoutFinalizedAt).toBeNull();
});
test("a refund request leaves relisting for financial review", async () => {
  await due(); await Operation.create({ operationKey: "refund:synthetic", caseId: matter._id, kind: "refund", fingerprint: "synthetic", status: "succeeded", amount: 10000, stripeRefundId: "re_pending" }); await expect(withdrawal.expire(String(matter._id))).rejects.toMatchObject({ status: 409 }); expect((await raw()).relistRequestedAt).toBeNull();
});
test("a failure to record the audit rolls back the posting and expiry decision", async () => {
  await due(); jest.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable")); await expect(withdrawal.expire(String(matter._id))).rejects.toMatchObject({ status: 503 }); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(await Job.countDocuments()).toBe(0);
});
test("a dispute opened after the expiry read prevents its older decision from committing", async () => {
  await due(); const update = Case.collection.findOneAndUpdate.bind(Case.collection); jest.spyOn(Case.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => { await change({ status: "disputed", disputes: [{ status: "open", message: "Payment review requested" }] }); return update(...args); }); await expect(withdrawal.expire(String(matter._id))).rejects.toMatchObject({ status: 409 }); expect((await raw()).status).toBe("disputed"); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(await Job.countDocuments()).toBe(0);
});
test("receipt work after a committed expiry cannot reopen a posting closed by a later hire", async () => {
  await due(); receipt.buildReceiptPdfBuffer.mockImplementationOnce(async () => { const saved = await raw(); await Job.collection.updateOne({ _id: saved.jobId }, { $set: { status: "closed" } }); await change({ paralegal: other._id, paralegalId: other._id, status: "in progress" }); return Buffer.from("%PDF-1.4\n%synthetic"); }); const stale = await Case.findById(matter._id); expect(await lifecycle.finalizeExpiredDisputeWindow(stale)).toBe(true); expect(stale.payoutFinalizedAt).toBeNull(); expect((await raw()).status).toBe("in progress"); expect((await Job.findOne()).status).toBe("closed");
});
test("raw owner aliases and unrendered fields survive the automatic decision", async () => {
  await due({ attorney: String(owner._id), attorneyId: String(owner._id), privateLegacyEvidence: { preserve: true }, "tasks.0.privateEvidence": "KEEP" }); const before = await raw(); expect((await withdrawal.expire(String(matter._id))).changed).toBe(true); const saved = await raw(); expect(saved.attorney).toEqual(before.attorney); expect(saved.tasks).toEqual(before.tasks); expect(saved.privateLegacyEvidence).toEqual(before.privateLegacyEvidence);
});
test("completed-history expiry preserves cents when a posting already exists", async () => {
  const job = await Job.create({ caseId: matter._id, attorneyId: owner._id, title: "River Street lease review", description: "Existing Matter posting", practiceArea: "Real Estate Law", budget: 1000, status: "closed" }); await due({ jobId: job._id });
  const viewed = await request(app).get("/api/cases/my-completed").set("Cookie", cookie(para)); expect(viewed.status).toBe(200); expect((await raw()).remainingAmount).toBe(100000); expect((await raw()).payoutFinalizedType).toBe("expired_zero"); expect((await Job.findById(job._id)).status).toBe("open"); expect(await Job.countDocuments()).toBe(1);
});
