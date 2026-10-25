const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, fallback) => fallback), stripeIdempotencyKey: jest.fn((kind, ...values) => `${kind}:${values.join(":")}`), caseTransferGroup: jest.fn(value => `case_${value}`) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/caseLifecycle", () => ({ generateArchiveZip: jest.fn(async () => ({ key: "cases/synthetic/archive.zip", readyAt: new Date() })), buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%synthetic")), uploadPdfToS3: jest.fn(async () => ({ key: "synthetic/receipt.pdf" })), getReceiptKey: jest.fn(() => "synthetic/receipt.pdf") }));
const User = require("../models/User"), Case = require("../models/Case"), Payout = require("../models/Payout"), PaymentOperation = require("../models/PaymentOperation");
const evidence = require("../services/completionPayoutEvidence"), lifecycle = require("../services/caseLifecycle");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, para, matter;
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Payout.init(), PaymentOperation.init()]); });
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); lifecycle.generateArchiveZip.mockResolvedValue({ key: "cases/synthetic/archive.zip", readyAt: new Date() });
  [owner, para] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@completion-evidence.test`, password: "Synthetic123!", status: "approved", role })));
  matter = await Case.create({ title: "River Street lease review", details: "Review completion payment evidence.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_completion", totalAmount: 100000, lockedTotalAmount: 100000, currency: "usd", tasks: [{ title: "Review lease exhibits", completed: true }] });
});
const payout = (changes = {}) => Payout.create({ stripeMode: "test", caseId: matter._id, paralegalId: para._id, amountPaid: 82000, transferId: "tr_synthetic_completion", ...changes });
const operation = (changes = {}) => PaymentOperation.create({ stripeMode: "test", operationKey: `case_payout:${matter._id}`, caseId: matter._id, kind: "case_payout", fingerprint: "synthetic-original-request", amount: 82000, transferAmount: 82000, currency: "usd", status: "succeeded", stripeTransferId: "tr_synthetic_completion", stripeObjectId: "tr_synthetic_completion", ...changes });
const raw = () => Case.collection.findOne({ _id: matter._id });
const complete = () => request(app).post(`/api/cases/${matter._id}/complete`).set("Cookie", `token=${require("jsonwebtoken").sign({ id: String(owner._id), role: owner.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`).send({});

test("an unpaid Matter has no recorded completion transfer", async () => { expect((await evidence.inspect(await raw())).state).toBe("none"); });
test.each(["pending", "failed", "reversed", "needs_reconciliation"])("a %s payout cannot complete the Matter or trigger another transfer", async status => {
  const row = await payout({ status }); const before = await raw(); const result = await complete();
  expect(result.status).toBe(409); expect(result.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED"); expect(await raw()).toEqual(before); expect((await Payout.findById(row._id)).status).toBe(status); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(lifecycle.generateArchiveZip).not.toHaveBeenCalled();
});
test("a legacy payout without status is not made paid by schema defaults", async () => {
  const row = await payout(); await Payout.collection.updateOne({ _id: row._id }, { $unset: { status: "" } }); expect((await complete()).status).toBe(409); expect((await Payout.collection.findOne({ _id: row._id })).status).toBeUndefined();
});
test("reversal evidence blocks a payout whose status still says paid", async () => { await payout({ reversedAt: new Date() }); expect((await complete()).status).toBe(409); });
test.each([{ amountPaid: 32800 }, { transferId: "not_a_transfer" }, { operationKey: "partial_payout:previous_assignment" }])("a conflicting payout %j is not reclassified as completion", async changes => {
  await payout(changes); await Case.collection.updateOne({ _id: matter._id }, { $set: { payoutTransferId: changes.transferId || "tr_synthetic_completion" } }); expect((await complete()).status).toBe(409); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("an earlier partial payout does not impersonate the current completion payout", async () => { await payout({ operationKey: "partial_payout:previous_assignment", amountPaid: 32800 }); expect((await evidence.inspect(await raw())).state).toBe("none"); });
test("two unexplained legacy payouts require reconciliation", async () => { await payout(); await payout({ transferId: "tr_second" }); expect((await complete()).status).toBe(409); });
test("a known transfer assigned to another Matter cannot be adopted", async () => {
  const other = await Case.create({ title: "Another Matter", details: "Separate evidence", attorney: owner._id }); await payout({ caseId: other._id }); await Case.collection.updateOne({ _id: matter._id }, { $set: { payoutTransferId: "tr_synthetic_completion" } }); expect((await complete()).status).toBe(409);
});
test.each([{ amount: 82001 }, { currency: "eur" }, { kind: "partial_payout" }, { status: "needs_reconciliation" }, { stripeTransferId: "tr_different" }, { transferAmount: 1 }])("conflicting operation %j cannot be overwritten as succeeded", async changes => {
  await payout(); const op = await operation(changes), before = await PaymentOperation.collection.findOne({ _id: op._id }); expect((await complete()).status).toBe(409); expect(await PaymentOperation.collection.findOne({ _id: op._id })).toEqual(before);
});
test("an operation transfer reference alone cannot fabricate paid ledgers", async () => {
  const op = await operation({ status: "needs_reconciliation" }), before = await PaymentOperation.collection.findOne({ _id: op._id }); expect((await complete()).status).toBe(409); expect(await Payout.countDocuments()).toBe(0); expect(await PaymentOperation.collection.findOne({ _id: op._id })).toEqual(before); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("a completed Matter with reversed evidence does not return false payment success or clear its claim", async () => {
  await payout({ status: "reversed" }); await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "completed", paymentReleased: true, payoutTransferId: "tr_synthetic_completion", payoutStatus: "reversed", completionClaimStatus: "needs_reconciliation" } }); const before = await raw(); expect((await complete()).status).toBe(409); expect(await raw()).toEqual(before);
});
test("consistent paid evidence can finish a Matter without another transfer", async () => {
  await payout(); await operation(); const result = await complete(); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { ok: true } }); expect((await raw()).status).toBe("completed"); expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect((await complete()).body.alreadyClosed).toBe(true);
});
test("reversal arriving during archive preparation prevents completion", async () => {
  const row = await payout(); lifecycle.generateArchiveZip.mockImplementationOnce(async () => { await Payout.collection.updateOne({ _id: row._id }, { $set: { status: "reversed", reversedAt: new Date() } }); return { key: "cases/synthetic/archive.zip", readyAt: new Date() }; });
  expect((await complete()).status).toBe(409); expect((await raw()).status).toBe("in progress"); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});
test("raw earlier-format references remain readable and unrelated evidence is preserved", async () => {
  const row = await payout(); await Payout.collection.updateOne({ _id: row._id }, { $set: { caseId: String(matter._id), paralegalId: String(para._id), retainedEvidence: { preserve: true } } }); await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: String(owner._id), attorneyId: String(owner._id), paralegal: String(para._id), paralegalId: String(para._id) } }); const before = await Payout.collection.findOne({ _id: row._id }); expect((await evidence.inspect(await raw())).state).toBe("recorded"); expect(await Payout.collection.findOne({ _id: row._id })).toEqual(before);
});
test("the current remaining amount and retained fee percentage determine the completion amount", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 60000, feeParalegalPct: 15 } }); await payout({ amountPaid: 51000 }); expect((await evidence.inspect(await raw())).state).toBe("recorded");
});
test.each([{ attorneyId: "012345678901234567890123" }, { paralegalId: "012345678901234567890123" }, { feeParalegalPct: -5 }, { remainingAmount: 1.5 }])("ambiguous assignment or amount %j cannot be completed", async changes => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: changes }); expect((await evidence.inspect(await raw())).state).toBe("needs_review");
});

test.each(["pending", "failed", "reversed", "needs_reconciliation"])("the shared ledger writer cannot promote an existing %s transfer to paid", async status => {
  const row = await payout({ status, failureReason: "Retained payment evidence" }), before = await Payout.collection.findOne({ _id: row._id });
  await expect(require("../services/paymentLedgerService").upsertPayoutLedger({ operationKey: `case_payout:${matter._id}`, caseId: matter._id, paralegalId: para._id, amountPaid: 82000, transferId: row.transferId, stripeMode: "test" })).rejects.toThrow(/conflict/);
  expect(await Payout.collection.findOne({ _id: row._id })).toEqual(before);
});
test("the shared ledger writer preserves a reversal arriving after its first lookup", async () => {
  const row = await payout(), original = Payout.findOneAndUpdate.bind(Payout);
  jest.spyOn(Payout, "findOneAndUpdate").mockImplementationOnce(async (...args) => { await Payout.collection.updateOne({ _id: row._id }, { $set: { status: "reversed", reversedAt: new Date(), failureReason: "Concurrent reversal" } }); return original(...args); });
  await expect(require("../services/paymentLedgerService").upsertPayoutLedger({ operationKey: `case_payout:${matter._id}`, caseId: matter._id, paralegalId: para._id, amountPaid: 82000, transferId: row.transferId, stripeMode: "test" })).rejects.toThrow(/changed/);
  expect((await Payout.findById(row._id)).status).toBe("reversed");
});
test("the shared ledger writer cannot adopt another operation's transfer", async () => {
  const row = await payout({ operationKey: "partial_payout:retained_operation" });
  await expect(require("../services/paymentLedgerService").upsertPayoutLedger({ operationKey: `case_payout:${matter._id}`, caseId: matter._id, paralegalId: para._id, amountPaid: 82000, transferId: row.transferId, stripeMode: "test" })).rejects.toThrow(/conflict/);
  expect((await Payout.findById(row._id)).operationKey).toBe("partial_payout:retained_operation");
});
