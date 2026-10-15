const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, fallback) => fallback), stripeIdempotencyKey: jest.fn((kind, ...values) => `${kind}:${values.join(":")}`), caseTransferGroup: jest.fn(value => `case_${value}`) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/caseLifecycle", () => ({ generateArchiveZip: jest.fn(async () => ({ key: "cases/synthetic/archive.zip", readyAt: new Date() })), buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%synthetic")), uploadPdfToS3: jest.fn(async () => ({ key: "synthetic/receipt.pdf" })), getReceiptKey: jest.fn(() => "synthetic/receipt.pdf") }));
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Payout = require("../models/Payout"), PaymentOperation = require("../models/PaymentOperation"), PlatformIncome = require("../models/PlatformIncome"), AuditLog = require("../models/AuditLog");
const service = require("../services/attorneyCompletion"), lifecycle = require("../services/caseLifecycle");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/disputes", require("../routes/disputes"));
let owner, other, para, matter;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), CaseFile.init(), Payout.init(), PlatformIncome.init(), PaymentOperation.init(), AuditLog.init()]); }, 60000);
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); lifecycle.generateArchiveZip.mockResolvedValue({ key: "cases/synthetic/archive.zip", readyAt: new Date() });
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@completion.test`, password: "Synthetic123!", status: "approved", role: name === "para" ? "paralegal" : "attorney", ...(name === "para" ? { stripeAccountId: "acct_synthetic_completion", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "River Street lease review", details: "Review completion payment evidence.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_completion", totalAmount: 100000, lockedTotalAmount: 100000, currency: "usd", tasks: [{ title: "Review lease exhibits", completed: true }] });
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ livemode: false, id: "pi_synthetic_completion", status: "succeeded", amount: 122000, currency: "usd", transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id) }, latest_charge: { id: "ch_synthetic", transfer_group: `case_${matter._id}` } }); mockStripe.isTransferablePaymentIntent.mockReturnValue({ transferable: true, charge: { id: "ch_synthetic" } }); mockStripe.transfers.create.mockResolvedValue({ id: "tr_synthetic_completion" });
});
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${matter._id}/completion-review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(app).post(`/api/cases/${matter._id}/complete`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
async function command() { const review = await read(); expect(review.status).toBe(200); return { requestId: crypto.randomUUID(), confirmation: service.confirmation(review.body) }; }
const raw = () => Case.collection.findOne({ _id: matter._id });
const paid = () => Payout.create({ stripeMode: "test", caseId: matter._id, paralegalId: para._id, amountPaid: 82000, transferId: "tr_synthetic_completion", status: "paid" });
const file = (changes = {}) => CaseFile.create({ caseId: matter._id, userId: para._id, originalName: "Lease review.txt", storageKey: `cases/${matter._id}/documents/private-key-${crypto.randomUUID()}.txt`, mimeType: "text/plain", size: 9, status: "pending_review", uploadedByRole: "paralegal", securityStatus: "not_required", ...changes });

test("review exposes actual work, document counts and cents without creating provider calls or leaking keys", async () => {
  await file(); await file({ status: "attorney_revision" }); await file({ status: "approved", securityStatus: "pending" }); const result = await read(); expect(result.status).toBe(200); expect(result.body).toMatchObject({ canComplete: true, payoutCents: 82000, grossCents: 100000, feeCents: 18000, work: { total: 1, complete: 1 }, documents: { total: 3, awaitingReview: 1, revisions: 1, approved: 1, securityPending: 1 } }); expect(JSON.stringify(result.body)).not.toMatch(/private-key|acct_|storageKey/); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(result.headers["cache-control"]).toBe("private, no-store");
});
test("reviewed completion records the Matter and exact confirmation together and never transfers twice", async () => {
  const body = await command(), result = await send(body); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { completionRecorded: true, requestId: body.requestId } }); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect((await raw()).status).toBe("completed");
  const recovered = await read({ requestId: body.requestId }); expect(recovered.body.operation.status).toBe("recorded"); expect((await send(body)).body.review.operation.status).toBe("recorded"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(1); expect(await Payout.countDocuments()).toBe(1);
});
test("previously paid evidence completes without another transfer", async () => { await paid(); const review = await read(); expect(review.body.mode).toBe("finish_completion"); expect((await send(await command())).status).toBe(200); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); });
test("an ended assignment identifies withdrawal as the current workflow until another paralegal is assigned", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "paused", paralegal: null, paralegalId: null, withdrawnParalegalId: para._id, pausedReason: "paralegal_withdrew" } });
  let review = await read(); expect(review.status).toBe(200);
  expect(review.body).toMatchObject({ withdrawalActive: true, canComplete: false, paralegalId: null });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: para._id, paralegalId: para._id } });
  review = await read(); expect(review.status).toBe(200);
  expect(review.body.withdrawalActive).toBe(false);
  expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test.each([[false, "refunded"], [true, "refunded"], [true, "funded"]])("closed Matters cannot begin another completion (workComplete=%s, escrow=%s)", async (complete, escrowStatus) => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "closed", "tasks.0.completed": complete, escrowStatus } });
  const review = await read();
  expect(review.status).toBe(200);
  expect(review.body).toMatchObject({ closed: true, canComplete: false, blockers: expect.arrayContaining(["active_matter_required"]), work: { total: 1, complete: Number(complete) }, payoutState: "none" });
  const result = await send({ requestId: crypto.randomUUID(), confirmation: service.confirmation(review.body) });
  expect(result.status).toBe(409); expect(result.body.code).toBe("WORKSPACE_COMPLETION_BLOCKED");
  expect((await request(app).post(`/api/cases/${matter._id}/complete`).set("Cookie", cookie(owner)).send({})).status).toBe(409);
  expect(lifecycle.generateArchiveZip).not.toHaveBeenCalled();
  expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  expect(await Payout.countDocuments()).toBe(0); expect(await PlatformIncome.countDocuments()).toBe(0);
  expect((await raw()).status).toBe("closed");
});
test.each([{ "tasks.0.completed": false }, { status: "paused" }, { archived: true }, { escrowStatus: "pending" }, { hiringClaimStatus: "claimed" }, { completionClaimStatus: "claimed" }, { payoutStatus: "reversed" }, { currency: "JPY" }, { fundingIntegrityStatus: "failed" }])("blocked review %j cannot offer completion", async changes => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: changes }); const review = await read(); expect(review.status).toBe(200); expect(review.body.canComplete).toBe(false); expect((await send(await command())).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("a payment chargeback hold remains distinct from a work-quality dispute", async () => {
  await PaymentOperation.create({ operationKey: "chargeback:synthetic", kind: "chargeback", caseId: matter._id, fingerprint: "synthetic", payoutPosition: "pre_payout", administrativeStatus: "pending_review" }); const result = await read(); expect(result.body.blockers).toContain("payment_review"); expect(result.body.blockers).not.toContain("open_dispute"); expect(result.body.canComplete).toBe(false);
});
test.each([{ totalAmount: 110000 }, { "tasks.0.title": "Revised agreed scope" }, { paralegalNameSnapshot: "Changed name" }, { title: "Revised Matter" }])("a changed reviewed Matter %j cannot start completion", async changes => {
  const body = await command(); await Case.collection.updateOne({ _id: matter._id }, { $set: changes }); expect((await send(body)).status).toBe(409); expect(lifecycle.generateArchiveZip).not.toHaveBeenCalled(); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("a new or reviewed document invalidates the earlier confirmation", async () => { const body = await command(); await file(); expect((await send(body)).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); });
test("a change after the claim and during archive preparation is checked before any transfer", async () => {
  const body = await command(); lifecycle.generateArchiveZip.mockImplementationOnce(async () => { await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.0.completed": false } }); return { key: "synthetic/archive.zip", readyAt: new Date() }; }); expect((await send(body)).status).not.toBe(200); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect((await raw()).status).toBe("in progress");
});
test("account changes before submission or during archive preparation cannot release money", async () => {
  const body = await command(); lifecycle.generateArchiveZip.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return { key: "synthetic/archive.zip", readyAt: new Date() }; }); expect((await send(body)).status).not.toBe(200); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect((await read()).status).toBe(403);
});
test("foreign accounts and conflicting owner aliases cannot read or confirm completion", async () => {
  const body = await command(); for (const user of [other, para]) { expect([403, 404]).toContain((await read({}, user)).status); expect([403, 404]).toContain((await send(body, user)).status); }
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorneyId: other._id } }); expect((await read()).status).toBe(403);
});
test("a changed confirmation or reused request cannot change its Matter or payout amount", async () => {
  const body = await command(); expect((await send({ ...body, confirmation: { ...body.confirmation, payoutCents: 1 } })).status).toBe(409); expect((await send(body)).status).toBe(200); expect((await send({ ...body, confirmation: { ...body.confirmation, payoutCents: 1 } })).status).toBe(409); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("competing confirmations can start only one transfer", async () => {
  const a = await command(), b = await command(), results = await Promise.all([send(a), send(b)]); expect(results.map(value => value.status).sort()).toEqual([200, 409]); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(1);
});
test("an archive failure can be checked and is never automatically resubmitted", async () => {
  const body = await command(); lifecycle.generateArchiveZip.mockRejectedValueOnce(new Error("Synthetic archive unavailable")); expect((await send(body)).status).toBe(503); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("not_completed"); expect((await send(body)).body.review.operation.status).toBe("not_completed"); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(lifecycle.generateArchiveZip).toHaveBeenCalledTimes(1);
});
test("a lost final transaction acknowledgement recovers its committed confirmation", async () => {
  const create = AuditLog.create.bind(AuditLog); let interrupted = false;
  jest.spyOn(AuditLog, "create").mockImplementation(async (...args) => {
    const result = await create(...args);
    if (!interrupted && args[0]?.[0]?.action === "case.completion.recorded") {
      interrupted = true; const session = args[1].session, commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost acknowledgement"); };
    }
    return result;
  });
  const body = await command(); expect((await send(body)).status).toBe(200); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("recorded"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a missing claim acknowledgement is recoverable without sending a transfer", async () => {
  const original = mongoose.startSession.bind(mongoose); jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await original(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost claim acknowledgement"); }; return session; });
  const body = await command(); expect((await send(body)).status).toBe(503); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("processing"); expect((await send(body)).body.review.operation.status).toBe("processing"); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("a failed final transaction retains transfer evidence without claiming Matter completion", async () => {
  const original = AuditLog.create.bind(AuditLog); jest.spyOn(AuditLog, "create").mockImplementation((...args) => args[0]?.[0]?.action === "case.completion.recorded" ? Promise.reject(new Error("Synthetic completion record unavailable")) : original(...args));
  const body = await command(); expect((await send(body)).status).toBe(503); expect((await raw()).status).toBe("in progress"); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("needs_review"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(0);
});
test("a post-transfer bookkeeping failure retains the completion claim and blocks another payout", async () => {
  const body = await command();
  jest.spyOn(PaymentOperation, "updateMany").mockRejectedValueOnce(new Error("Synthetic bookkeeping unavailable"));
  expect((await send(body)).status).toBe(409);
  const saved = await raw(), operation = await PaymentOperation.findOne({ kind: "case_payout" }).lean();
  expect(saved.completionClaimTransferId).toBe("tr_synthetic_completion");
  expect(saved.completionClaimStatus).toBe("needs_reconciliation");
  expect(saved.status).toBe("in progress"); expect(saved.paymentReleased).toBe(false);
  expect(operation.stripeTransferId).toBe("tr_synthetic_completion"); expect(operation.status).toBe("needs_reconciliation");
  expect(await Payout.countDocuments()).toBe(0);
  expect((await send(body)).body.review.operation.status).toBe("needs_review");
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});

test.each([true, false])("a reversal before ledger creation blocks completion and both ledgers (reviewed=%s)", async reviewed => {
  // The synthetic transfer event is test-mode evidence; its Matter must carry
  // matching known mode evidence before that event can be associated.
  await Case.updateOne({ _id: matter._id }, { $set: { stripeMode: "test" } });
  const update = PaymentOperation.findByIdAndUpdate.bind(PaymentOperation); let reversed = false, reversalOutcome = null;
  jest.spyOn(PaymentOperation, "findByIdAndUpdate").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (!reversed && args[1]?.$set?.stripeTransferId === "tr_synthetic_completion") {
      reversed = true;
      const Delivery = require("../models/WebhookEvent"); await Delivery.init();
      const payload = mockStripe.transfers.create.mock.calls[0][0];
      const event = { id: "evt_completion_reversal", type: "transfer.reversed", created: 1788955200, livemode: false, data: { object: { ...payload, id: "tr_synthetic_completion", object: "transfer", livemode: false, reversed: true, amount_reversed: payload.amount } } };
      const receipt = await Delivery.create({ eventId: event.id, type: event.type, status: "processing", attempts: 1, lastAttemptAt: new Date(), stripeMode: "test" });
      reversalOutcome = await require("../services/attorneyTransferEvents").record({ event, receiptFilter: { _id: receipt._id, eventId: event.id, status: "processing", attempts: 1, lastAttemptAt: receipt.lastAttemptAt } });
    }
    return result;
  });
  const result = reviewed ? await send(await command()) : await request(app).post(`/api/cases/${matter._id}/complete`).set("Cookie", cookie(owner)).send({});
  expect(reversed).toBe(true);
  expect(reversalOutcome).toMatchObject({ needsReview: true, outcome: "reversed" });
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(await Payout.countDocuments()).toBe(0); expect(await PlatformIncome.countDocuments()).toBe(0);
  expect((await raw()).status).toBe("in progress"); expect((await raw()).payoutStatus).toBe("reversed");
  expect((await PaymentOperation.findOne({ kind: "case_payout" })).evidenceStatus).toBe("quarantined");
  expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("a reversal between the final evidence read and the payout guard aborts closure", async () => {
  const row = await paid(), original = Payout.collection.updateOne.bind(Payout.collection); jest.spyOn(Payout.collection, "updateOne").mockImplementationOnce(async (...args) => { await original({ _id: row._id }, { $set: { status: "reversed", reversedAt: new Date() } }); return original(...args); });
  const body = await command(); expect((await send(body)).status).toBe(503); expect((await raw()).status).toBe("in progress"); expect((await Payout.findById(row._id)).status).toBe("reversed"); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(0);
});
test("completion preserves earlier raw aliases and unrendered Matter evidence", async () => {
  await paid(); await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: String(owner._id), attorneyId: String(owner._id), paralegal: String(para._id), paralegalId: String(para._id), privateLegacyEvidence: { preserve: true }, "tasks.0.retainedUnknown": "KEEP" } }); const before = await raw(); expect((await send(await command())).status).toBe(200); const after = await raw(); expect(after.privateLegacyEvidence).toEqual(before.privateLegacyEvidence); expect(after.tasks).toEqual(before.tasks); expect(after.attorney).toBe(before.attorney); expect(after.paralegal).toBe(before.paralegal);
});
test("transaction support is required before a completion request can release money", async () => {
  const body = await command(); jest.spyOn(mongoose, "startSession").mockResolvedValue({ startTransaction() { throw new Error("Transactions unavailable"); }, inTransaction: () => false, endSession: async () => {} }); expect((await send(body)).status).toBe(503); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect((await raw()).completionClaimStatus).toBeFalsy();
});

test("a matching transfer-created projection can arrive before the response without blocking closure or changing its recorded timestamp", async () => {
  const at = new Date("2026-09-07T12:34:56.000Z");
  mockStripe.transfers.create.mockImplementationOnce(async () => {
    await Case.updateOne({ _id: matter._id }, { $set: { payoutTransferId: "tr_synthetic_completion", payoutStatus: "paid", payoutFailureReason: "", paidOutAt: at } });
    await PaymentOperation.updateMany({ caseId: matter._id, status: "pending" }, { $set: { stripeObjectId: "tr_synthetic_completion", status: "needs_reconciliation", lastError: "Stripe transfer exists; waiting for the local payout ledger to finalize." } });
    return { id: "tr_synthetic_completion" };
  });
  const body = await command(), result = await send(body); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { completionRecorded: true } }); expect((await raw()).paidOutAt).toEqual(at); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test.each(["reversed", "failed", "needs_reconciliation"])("a negative %s Case projection during transfer cannot be overwritten by completion", async status => {
  mockStripe.transfers.create.mockImplementationOnce(async () => { await Case.updateOne({ _id: matter._id }, { $set: { payoutTransferId: "tr_synthetic_completion", payoutStatus: status, payoutFailureReason: "Retained processor evidence" } }); return { id: "tr_synthetic_completion" }; });
  const body = await command(); expect((await send(body)).status).toBe(409); expect((await raw()).payoutStatus).toBe(status); expect((await raw()).payoutFailureReason).toBe("Retained processor evidence"); expect(await Payout.countDocuments()).toBe(0); expect((await raw()).status).toBe("in progress"); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(0); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("account revocation after transfer leaves a reconciliation record instead of completing for the former session", async () => {
  mockStripe.transfers.create.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return { id: "tr_synthetic_completion" }; });
  expect((await send(await command())).status).toBe(403); expect((await raw()).status).toBe("in progress"); expect((await raw()).completionClaimStatus).toBe("needs_reconciliation"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(0);
});

test("an ordinary unassigned posting is not mislabeled as a payment-record disagreement", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "open", paralegal: null, paralegalId: null, escrowIntentId: null, escrowStatus: "none" } });
  const result = await read(); expect(result.status).toBe(200); expect(result.body.canComplete).toBe(false); expect(result.body.blockers).toContain("hire_required"); expect(result.body.blockers).not.toContain("payout_reconciliation"); expect(result.body.payoutState).toBe("none");
});
test("a stranded completion claim stops presenting itself as still processing", async () => {
  const body = await command(); lifecycle.generateArchiveZip.mockImplementationOnce(async () => { throw new Error("Synthetic archive unavailable"); }); await send(body);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { completionClaimStatus: "claimed", completionClaimToken: body.requestId, completionClaimedAt: new Date(Date.now() - 11 * 60 * 1000) } });
  const result = await read({ requestId: body.requestId }); expect(result.body.operation.status).toBe("needs_review"); expect(result.body.blockers).toContain("completion_reconciliation"); expect(result.body.canComplete).toBe(false); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});

test("a claimed completion blocks legacy work edits, disputes, withdrawal and another completion", async () => {
  const body = await command(); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }); lifecycle.generateArchiveZip.mockImplementationOnce(async () => { arrived(); await gate; return { key: "synthetic/archive.zip", readyAt: new Date() }; });
  const running = send(body).then(result => result); let finished;
  try {
    await waiting;
    const work = await request(app).patch(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)).send({ tasks: [{ title: "Review lease exhibits", completed: false }] }); expect(work.status).toBe(409);
    const dispute = await request(app).post(`/api/disputes/${matter._id}`).set("Cookie", cookie(owner)).send({ message: "Review completion before release" }); expect(dispute.status).toBe(409);
    const withdraw = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", cookie(para)).send({ reason: "Unable to continue the assignment" }); expect(withdraw.status).toBe(400); expect(withdraw.body.error).toMatch(/All tasks are complete/);
    const again = await request(app).post(`/api/cases/${matter._id}/complete`).set("Cookie", cookie(owner)).send({}); expect(again.status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  } finally { release(); finished = await running; }
  expect(finished.status).toBe(200); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});

test.each(["pending", "failed"])("an earlier %s payment attempt without transfer evidence cannot authorize another money action", async status => {
  await PaymentOperation.create({ operationKey: `case_payout:${matter._id}`, caseId: matter._id, kind: "case_payout", fingerprint: "earlier-attempt", amount: 82000, currency: "usd", status, lastError: "No authoritative provider outcome" });
  const result = await read(); expect(result.body.canComplete).toBe(false); expect(result.body.blockers).toContain(status === "pending" ? "payout_processing" : "payout_reconciliation"); expect((await send(await command())).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});

test("a withdrawal already underway cannot overwrite later work approval and reviewed completion", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.0.completed": false, hiredAt: new Date() } });
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), original = Case.findOneAndUpdate.bind(Case);
  jest.spyOn(Case, "findOneAndUpdate").mockImplementation((...args) => { const query = original(...args); if (args[1]?.$set?.pausedReason === "paralegal_withdrew") { const exec = query.exec.bind(query); query.exec = async (...values) => { arrived(); await gate; return exec(...values); }; } return query; });
  const withdrawing = request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", cookie(para)).send({}).then(result => result); let withdrawn;
  try { await waiting; const work = await request(app).patch(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)).send({ tasks: [{ title: "Review lease exhibits", completed: true }] }); expect(work.status).toBe(200); expect((await send(await command())).status).toBe(200); }
  finally { release(); withdrawn = await withdrawing; }
  expect(withdrawn.status).toBe(409); expect(withdrawn.body.code).toBe("WITHDRAWAL_CONFLICT"); expect((await raw()).status).toBe("completed"); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});

test.each(['missing','malformed','conflicting'])('completion verifies the provider mode before transferring money: %s',async scenario=>{
 await Case.collection.updateOne({_id:matter._id},{$set:{stripeMode:'test'}});
 const provider=await mockStripe.paymentIntents.retrieve();if(scenario==='missing')delete provider.livemode;else provider.livemode=scenario==='malformed'?'false':true;
 mockStripe.paymentIntents.retrieve.mockResolvedValue(provider);const response=await send(await command());
 expect(response.status).toBeGreaterThanOrEqual(400);expect(mockStripe.transfers.create).not.toHaveBeenCalled();expect(await Payout.countDocuments()).toBe(0);expect(await PlatformIncome.countDocuments()).toBe(0);expect((await raw()).stripeMode).toBe('test');expect((await raw()).status).toBe('in progress');
});
