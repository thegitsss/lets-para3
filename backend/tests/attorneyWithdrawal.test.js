const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, fallback) => fallback), stripeIdempotencyKey: jest.fn((kind, ...values) => `${kind}:${values.join(":")}`), caseTransferGroup: jest.fn(value => `case_${value}`) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/caseLifecycle", () => ({ generateArchiveZip: jest.fn(), buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%synthetic")), uploadPdfToS3: jest.fn(async () => ({ key: "synthetic/receipt.pdf" })), getReceiptKey: jest.fn(() => "synthetic/receipt.pdf") }));
const User = require("../models/User"), Case = require("../models/Case"), Job = require("../models/Job"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation"), Income = require("../models/PlatformIncome"), AuditLog = require("../models/AuditLog");
const service = require("../services/attorneyWithdrawal"), { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/disputes", require("../routes/disputes"));
let owner, other, para, admin, matter;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${matter._id}/withdrawal-review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(app).post(`/api/cases/${matter._id}/withdrawal-decision`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const legacy = (action, body = {}, user = owner) => request(app).post(`/api/cases/${matter._id}/${action}`).set("Cookie", cookie(user)).send(body);
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
test("review shows retained work, amount, payee and cap without provider calls or private fields", async () => {
  const value = await read(); expect(value.status).toBe(200); expect(value.body).toMatchObject({ state: "decision_required", canDecide: true, canPay: true, canRelist: false, originalCents: 100000, remainingCents: 100000, maximumPayoutCents: 70000, feePct: 18, work: { complete: 1, total: 2 } }); expect(JSON.stringify(value.body)).not.toMatch(/acct_|operationKey|withdrawalClaim|fundingIntegrityFailure/); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(value.headers["cache-control"]).toBe("private, no-store");
});
test("a reviewed payout commits decision, exact net, remaining balance, posting and recovery together", async () => {
  const body = await command(), sent = await send(body); expect({ status: sent.status, body: sent.body }).toMatchObject({ status: 200, body: { operation: { requestId: body.requestId, status: "recorded" }, remainingCents: 80000, state: "finalized", decision: { type: "partial_attorney", amountCents: 20000, netCents: 16400, payoutState: "recorded" } } });
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); const saved = await raw(); expect(saved.withdrawalClaimStatus).toBeNull(); expect(saved.status).toBe("paused"); expect(saved.payoutTransferId).toBe("tr_withdrawal"); expect((await Job.findById(saved.jobId)).status).toBe("open"); expect(await Payout.countDocuments()).toBe(1); expect((await Payout.findOne()).amountPaid).toBe(16400); expect((await Income.findOne()).feeAmount).toBe(3600); expect((await Operation.findOne({ kind: "partial_payout" })).status).toBe("succeeded");
  expect((await send(body)).body.operation.status).toBe("recorded"); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("recorded"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(await AuditLog.countDocuments({ action: "case.withdrawal.recorded" })).toBe(1); expect((await send({ ...body, amountCents: 20001 })).status).toBe(409);
});
test("the existing zero-amount decision relists with no transfer and no fabricated paid record", async () => {
  const sent = await send(await command("partial", 0)); expect(sent.status).toBe(200); expect(sent.body).toMatchObject({ remainingCents: 100000, decision: { amountCents: 0, payoutState: "none", netCents: null } }); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(await Payout.countDocuments()).toBe(0);
});
test("declining release starts the actual 24-hour window and locks later attorney decisions", async () => {
  const before = Date.now(), body = await command("reject"), sent = await send(body); expect(sent.status).toBe(200); expect(sent.body.state).toBe("review_window"); expect(new Date(sent.body.reviewDeadline).getTime()).toBeGreaterThanOrEqual(before + 86400000); expect(new Date(sent.body.reviewDeadline).getTime()).toBeLessThanOrEqual(Date.now() + 86400000); expect((await raw()).payoutFinalizedAt).toBeNull(); expect((await raw()).relistRequestedAt).toBeNull(); expect((await legacy("partial-payout", { amountCents: 20000 })).status).toBe(409); expect((await legacy("reject-payout")).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect((await send(body)).body.operation.status).toBe("recorded");
});
test("an expired window stays awaiting finalization until the server actually records its outcome", async () => {
  await change({ disputeDeadlineAt: new Date(Date.now() - 1000) }); const value = await read(); expect(value.body.state).toBe("review_overdue"); expect(value.body.canDecide).toBe(false); expect(value.body.canRelist).toBe(false); expect((await raw()).payoutFinalizedAt).toBeNull();
});
test("a finalized zero outcome can be explicitly relisted without changing its decision or charging", async () => {
  const at = new Date("2026-09-02"); await change({ payoutFinalizedType: "expired_zero", payoutFinalizedAt: at, partialPayoutAmount: 0, relistRequestedAt: null }); const review = await read(); expect(review.body.canRelist).toBe(true); const value = await send(await command("relist")); expect(value.status).toBe(200); expect(value.body.relistedAt).toBeTruthy(); expect((await raw()).payoutFinalizedAt).toEqual(at); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("the legacy payout and rejection controls use the same guarded decisions", async () => {
  const sent = await legacy("partial-payout", { amountCents: 20000 }); expect(sent.status).toBe(200); expect(sent.body).toMatchObject({ ok: true, payout: 16400, remainingAmount: 80000 }); expect((await legacy("partial-payout", { amountCents: 20000 })).status).toBe(409); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("the attorney cap retains exact cent rounding and administrators retain their existing full-amount authority", async () => {
  await change({ totalAmount: 100001, lockedTotalAmount: 100001, remainingAmount: 100001 }); expect((await read()).body.maximumPayoutCents).toBe(70001); expect((await send(await command("partial", 70002))).status).toBe(409); await change({ totalAmount: 100000, lockedTotalAmount: 100000, remainingAmount: 100000 }); const sent = await legacy("partial-payout", { amountCents: 100000 }, admin); expect(sent.status).toBe(200); expect(sent.body.remainingAmount).toBe(0); expect((await raw()).relistRequestedAt).toBeNull(); expect((await raw()).payoutFinalizedType).toBe("admin");
});
test.each([{ archived: true }, { readOnly: true }, { status: "disputed" }, { status: "completed" }, { remainingAmount: 90000 }, { currency: "JPY" }, { feeParalegalPct: 150 }, { withdrawalClaimStatus: "needs_reconciliation" }, { completionClaimStatus: "claimed" }])("ineligible or inconsistent Matter %j cannot send a payout", async patch => {
  await change(patch); const value = await read(); expect(value.status).toBe(200); expect(value.body.canDecide).toBe(false); expect((await send(await command())).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("unfinished payout setup never finalizes a positive decision or reduces the Matter balance", async () => {
  await User.collection.updateOne({ _id: para._id }, { $set: { stripePayoutsEnabled: false } }); const value = await read(); expect(value.body.canDecide).toBe(true); expect(value.body.canPay).toBe(false); expect((await send(await command())).status).toBe(409); expect((await raw()).remainingAmount).toBe(100000); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("stale review, changed owner, changed session and foreign roles cannot act", async () => {
  const body = await command(); await change({ "tasks.1.title": "Changed instructions" }); expect((await send(body)).status).toBe(409); expect((await read({}, other)).status).toBe(403); expect((await read({}, para)).status).toBe(403); expect((await legacy("partial-payout", { amountCents: 20000 }, para)).status).toBe(404); await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); expect((await send(body)).status).toBe(403);
});
test("an interrupted transfer retains a reconciliation claim and cannot be sent again", async () => {
  const body = await command(); mockStripe.transfers.create.mockRejectedValueOnce(new Error("Synthetic connection lost")); expect((await send(body)).status).toBe(503); expect((await raw()).payoutFinalizedAt).toBeNull(); expect((await raw()).remainingAmount).toBe(100000); expect((await raw()).withdrawalClaimStatus).toBe("needs_reconciliation"); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("needs_review"); expect((await send(body)).body.operation.status).toBe("needs_review"); expect((await legacy("partial-payout", { amountCents: 20000 })).status).toBe(409); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test.each([{ amount: 1 }, { amount_reversed: 1 }, { reversed: true }, { currency: "eur" }, { destination: "acct_other" }, { livemode: true }, { source_transaction: "ch_other" }])("mismatched or reversed transfer %j never becomes a finalized payout", async patch => {
  mockStripe.transfers.create.mockImplementationOnce(async payload => providerTransfer(payload, patch)); expect((await send(await command())).status).toBe(503); expect((await raw()).payoutFinalizedAt).toBeNull(); expect((await raw()).withdrawalClaimStatus).toBe("needs_reconciliation"); expect(await Payout.countDocuments()).toBe(0); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a provider response followed by persistence failure leaves the decision unconfirmed without resending money", async () => {
  const body = await command(), original = Payout.create.bind(Payout); jest.spyOn(Payout, "create").mockImplementationOnce(async () => { throw new Error("Synthetic ledger unavailable"); }).mockImplementation(original); const response = await send(body); expect(response.status).toBe(503); expect((await raw()).withdrawalClaimTransferId).toBe("tr_withdrawal"); expect((await raw()).remainingAmount).toBe(100000); expect(await Income.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ action: "case.withdrawal.recorded" })).toBe(0); expect((await send(body)).body.operation.status).toBe("needs_review"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a matching transfer-created callback can precede the payout response without turning it into another payout", async () => {
  const at = new Date("2026-09-09T12:00:00Z"); mockStripe.transfers.create.mockImplementationOnce(async payload => { await change({ payoutTransferId: "tr_withdrawal", payoutStatus: "paid", payoutFailureReason: "", paidOutAt: at }); await Operation.updateMany({ caseId: matter._id, status: "pending" }, { $set: { status: "needs_reconciliation", stripeObjectId: "tr_withdrawal", lastError: "Stripe transfer exists; waiting for the local payout ledger to finalize." } }); return providerTransfer(payload); });
  const sent = await send(await command()); expect({ status: sent.status, body: sent.body }).toMatchObject({ status: 200, body: { decision: { payoutState: "recorded" } } }); expect((await raw()).paidOutAt).toEqual(at); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a reversal during the transfer is retained and never overwritten by the withdrawal decision", async () => {
  mockStripe.transfers.create.mockImplementationOnce(async payload => { await change({ payoutTransferId: "tr_withdrawal", payoutStatus: "reversed", payoutFailureReason: "Recorded reversal" }); return providerTransfer(payload); }); expect((await send(await command())).status).toBe(409); expect((await raw()).payoutStatus).toBe("reversed"); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(await Payout.countDocuments()).toBe(0);
});
test("a provider mode mismatch stops before the transfer request", async () => {
  await change({ stripeMode: "live" }); expect((await send(await command())).status).toBe(503); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect((await raw()).payoutFinalizedAt).toBeNull(); expect((await raw()).withdrawalClaimStatus).toBeNull();
});
test("a current owner losing access after the transfer leaves a retained reconciliation claim", async () => {
  mockStripe.transfers.create.mockImplementationOnce(async payload => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return providerTransfer(payload); }); expect((await send(await command())).status).toBe(403); expect((await raw()).withdrawalClaimStatus).toBe("needs_reconciliation"); expect((await raw()).payoutFinalizedAt).toBeNull(); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a payout claim blocks another tab, rejection, relisting and legacy dispute opening while the transfer is in flight", async () => {
  const body = await command(); let release, arrived; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; }); mockStripe.transfers.create.mockImplementationOnce(async payload => { arrived(); await gate; return providerTransfer(payload); }); const running = send(body).then(value => value);
  try { await waiting; expect((await send(body)).body.operation.status).toBe("processing"); expect((await legacy("reject-payout")).status).toBe(409); expect((await legacy("relist")).status).toBe(409); expect((await legacy("partial-payout", { amountCents: 15000 })).status).toBe(409); const dispute = await request(app).post(`/api/disputes/${matter._id}`).set("Cookie", cookie(owner)).send({ message: "Concurrent review" }); expect(dispute.status).toBe(409); } finally { release(); } expect((await running).status).toBe(200); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a broken posting is found before any transfer and read failures are not empty withdrawal histories", async () => {
  await change({ jobId: new mongoose.Types.ObjectId() }); const value = await read(); expect(value.body.blockers).toContain("posting_needs_review"); expect((await send(await command())).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); jest.spyOn(Payout.collection, "find").mockImplementationOnce(() => { throw new Error("Synthetic read unavailable"); }); expect((await read()).status).toBe(503);
});
test("raw legacy aliases and unrendered evidence survive the decision", async () => {
  await change({ attorney: String(owner._id), attorneyId: String(owner._id), privateLegacyEvidence: { preserve: true }, "tasks.0.extraEvidence": "KEEP" }); const before = await raw(); expect((await send(await command("reject"))).status).toBe(200); const after = await raw(); expect(after.attorney).toEqual(before.attorney); expect(after.tasks).toEqual(before.tasks); expect(after.privateLegacyEvidence).toEqual(before.privateLegacyEvidence);
});
test.each([false, true])("partial payout preserves the existing authority when all work is %s complete, while rejection stays limited", async completed => {
  await change({ "tasks.0.completed": completed, "tasks.1.completed": completed }); expect((await read()).body.canDecide).toBe(true); expect((await send(await command("reject"))).status).toBe(409); expect((await legacy("partial-payout", { amountCents: 20000 })).status).toBe(200);
});
test("administrators retain payout authority after an expired review window, without restarting it", async () => {
  await change({ disputeDeadlineAt: new Date(Date.now() - 1000) }); expect((await read()).body.canDecide).toBe(false); expect((await legacy("reject-payout", {}, admin)).status).toBe(409); expect((await legacy("partial-payout", { amountCents: 80000 }, admin)).status).toBe(200);
});
test("relisting an already relisted Matter returns its retained outcome without another write", async () => {
  await send(await command("partial", 0)); const before = await raw(), audits = await AuditLog.countDocuments(); const result = await legacy("relist"); expect(result.status).toBe(200); expect((await raw()).relistRequestedAt).toEqual(before.relistRequestedAt); expect(await AuditLog.countDocuments()).toBe(audits);
});
test.each([{ stripeMode: "live" }, { currency: "eur" }, { amount: 1 }, { kind: "case_payout" }, { stripeTransferId: "tr_other" }])("a changed retained operation %j cannot present a verified payout", async patch => {
  expect((await send(await command())).status).toBe(200); await Operation.collection.updateOne({ caseId: matter._id, kind: "partial_payout" }, { $set: patch }); const review = await read(); expect(review.body.decision.payoutState).toBe("needs_review"); expect(review.body.blockers).toContain("payout_needs_review");
});
test("a payee changing during transfer remains unfinalized with the known transfer retained", async () => {
  mockStripe.transfers.create.mockImplementationOnce(async payload => { await User.collection.updateOne({ _id: para._id }, { $set: { stripeAccountId: "acct_changed" } }); return providerTransfer(payload); }); expect((await send(await command())).status).toBe(409); expect((await raw()).withdrawalClaimTransferId).toBe("tr_withdrawal"); expect((await raw()).withdrawalClaimStatus).toBe("needs_reconciliation"); expect(await Payout.countDocuments()).toBe(0);
});
test("a post-transfer bookkeeping failure retains the withdrawal claim and blocks a second payout", async () => {
  const body = await command();
  jest.spyOn(Operation, "updateMany").mockRejectedValueOnce(new Error("Synthetic bookkeeping unavailable"));
  expect((await send(body)).status).toBe(503);
  const saved = await raw(), operation = await Operation.findOne({ kind: "partial_payout" }).lean();
  expect(saved.withdrawalClaimTransferId).toBe("tr_withdrawal");
  expect(saved.withdrawalClaimStatus).toBe("needs_reconciliation");
  expect(saved.payoutFinalizedAt).toBeNull(); expect(saved.remainingAmount).toBe(100000);
  expect(operation.stripeTransferId).toBe("tr_withdrawal"); expect(operation.status).toBe("needs_reconciliation");
  expect(await Payout.countDocuments()).toBe(0);
  expect((await send(body)).body.operation.status).toBe("needs_review");
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a posting appearing during transfer is not overwritten by the reviewed decision", async () => {
  mockStripe.transfers.create.mockImplementationOnce(async payload => { await Job.create({ caseId: matter._id, attorneyId: owner._id, title: "Updated posting", description: "Changed during transfer", practiceArea: "Real Estate Law", budget: 1000, status: "closed" }); return providerTransfer(payload); }); expect((await send(await command())).status).toBe(409); expect((await Job.findOne()).status).toBe("closed"); expect((await raw()).payoutFinalizedAt).toBeNull(); expect((await raw()).withdrawalClaimTransferId).toBe("tr_withdrawal");
});
test("a partial payout can lead to a replacement hire and later zero withdrawal without losing the first decision", async () => {
  expect((await send(await command())).status).toBe(200);
  const replacement = await User.create({ firstName: "Second", lastName: "Paralegal", email: "second@withdrawal.test", password: "Synthetic123!", role: "paralegal", status: "approved", stripeAccountId: "acct_second", stripeOnboarded: true, stripePayoutsEnabled: true });
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: { paralegalId: replacement._id, status: "pending" } } });
  const hire = await request(app).post(`/api/cases/${matter._id}/hire/${replacement._id}`).set("Cookie", cookie(owner)).send({}); if (hire.status !== 200) throw new Error(`Replacement hire: ${hire.status} ${JSON.stringify(hire.body)}`);
  expect((await read()).body.applicable).toBe(false); expect((await raw()).remainingAmount).toBe(80000);
  const withdraw = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", cookie(replacement)).send({}); expect({ status: withdraw.status, body: withdraw.body }).toMatchObject({ status: 200, body: { withdrawalOutcome: "zero_auto" } });
  const current = await read(); expect(current.body).toMatchObject({ remainingCents: 80000, balanceVerified: true, decision: { type: "zero_auto", amountCents: 0, payoutState: "none" } });
  const saved = await raw(); expect(saved.withdrawalHistory).toEqual(expect.arrayContaining([expect.objectContaining({ partialPayoutAmount: 20000, payoutTransferId: "tr_withdrawal" })])); expect(await Payout.countDocuments()).toBe(1); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});

async function replacementCandidate() {
  const replacement = await User.create({ firstName: "Replacement", lastName: "Paralegal", email: "replacement-handoff@withdrawal.test", password: "Synthetic123!", role: "paralegal", status: "approved", stripeAccountId: "acct_replacement", stripeOnboarded: true, stripePayoutsEnabled: true });
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: { paralegalId: replacement._id, status: "pending" } } });
  return replacement;
}
const hireReplacement = replacement => request(app).post(`/api/cases/${matter._id}/hire/${replacement._id}`).set("Cookie", cookie(owner)).send({});
test.each(["reversed", "unresolved", "wrong_payee", "duplicate_transfer", "missing_payout", "chargeback_hold", "contradictory_balance", "unmatched_pending_transfer", "missing_remaining"])("replacement hiring preserves a prior %s payout for review", async scenario => {
  expect((await send(await command())).status).toBe(200);
  const replacement = await replacementCandidate();
  if (scenario === "contradictory_balance") await change({ remainingAmount: 75000 });
  if (scenario === "missing_remaining") await Case.collection.updateOne({ _id: matter._id }, { $unset: { remainingAmount: "" } });
  if (scenario === "unmatched_pending_transfer") await Operation.collection.insertOne({ caseId: matter._id, operationKey: "unmatched-replacement-transfer", kind: "case_payout", status: "pending", amount: 65000 });
  if (scenario === "chargeback_hold") await Operation.collection.insertOne({ caseId: matter._id, operationKey: "held-replacement", kind: "chargeback", payoutPosition: "post_payout", administrativeStatus: "pending_review" });
  if (scenario === "reversed") await Payout.collection.updateOne({ caseId: matter._id }, { $set: { status: "reversed" } });
  if (scenario === "unresolved") await Operation.collection.updateOne({ caseId: matter._id, kind: "partial_payout" }, { $set: { status: "needs_reconciliation" } });
  if (scenario === "wrong_payee") await Payout.collection.updateOne({ caseId: matter._id }, { $set: { paralegalId: replacement._id } });
  if (scenario === "missing_payout") await Payout.collection.deleteMany({ caseId: matter._id });
  if (scenario === "duplicate_transfer") await Operation.create({ caseId: new mongoose.Types.ObjectId(), operationKey: "partial_payout:foreign_handoff", kind: "partial_payout", fingerprint: "foreign-handoff", status: "succeeded", amount: 16400, transferAmount: 16400, currency: "usd", stripeMode: "test", stripeTransferId: "tr_withdrawal" });
  const before = await raw(), payouts = await Payout.collection.find({ caseId: matter._id }).toArray();
  expect((await hireReplacement(replacement)).status).toBe(409);
  const current = await raw();
  for (const field of ["withdrawnParalegalId", "payoutFinalizedAt", "payoutFinalizedType", "payoutTransferId", "partialPayoutAmount", "remainingAmount", "withdrawalHistory", "paralegal", "paralegalId", "status"]) expect(current[field]).toEqual(before[field]);
  expect(await Payout.collection.find({ caseId: matter._id }).toArray()).toEqual(payouts);
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a failed replacement save leaves the earlier decision intact and retry archives it once", async () => {
  expect((await send(await command())).status).toBe(200);
  const replacement = await replacementCandidate(), before = await raw();
  const save = jest.spyOn(Case.prototype, "save").mockRejectedValueOnce(new Error("Synthetic replacement save unavailable"));
  expect((await hireReplacement(replacement)).status).toBe(500); save.mockRestore();
  const failed = await raw();
  for (const field of ["withdrawnParalegalId", "payoutFinalizedAt", "payoutTransferId", "partialPayoutAmount", "remainingAmount", "withdrawalHistory", "paralegalId"]) expect(failed[field]).toEqual(before[field]);
  expect((await hireReplacement(replacement)).status).toBe(200);
  const recorded = await raw();
  expect(recorded.withdrawalHistory).toHaveLength(1);
  expect(recorded.withdrawalHistory[0]).toMatchObject({ withdrawnParalegalId: para._id, partialPayoutAmount: 20000, payoutTransferId: "tr_withdrawal" });
  expect(recorded.payoutTransferId).toBe(""); expect(recorded.payoutFinalizedAt).toBeNull();
  expect(recorded.payoutStatus).toBe("not_started"); expect(recorded.remainingAmount).toBe(80000);
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a Matter changing during the transactional handoff prevents an older replacement assignment", async () => {
  expect((await send(await command())).status).toBe(200);
  const replacement = await replacementCandidate(), find = Payout.collection.find.bind(Payout.collection); let changed = false;
  jest.spyOn(Payout.collection, "find").mockImplementation((query, options) => {
    const cursor = find(query, options), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => {
      const values = await toArray();
      if (options?.session && !changed) { changed = true; await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.1.title": "Changed during replacement hiring" } }); }
      return values;
    };
    return cursor;
  });
  expect((await hireReplacement(replacement)).status).toBe(409); expect(changed).toBe(true);
  const current = await raw(); expect(current.paralegalId).toBeNull(); expect(current.withdrawalHistory).toEqual([]);
  expect(current.tasks[1].title).toBe("Changed during replacement hiring"); expect(current.payoutTransferId).toBe("tr_withdrawal");
});
