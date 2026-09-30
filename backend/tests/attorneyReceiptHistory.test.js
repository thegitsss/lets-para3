const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
jest.mock("../utils/stripe", () => ({ paymentIntents: { retrieve: jest.fn() }, refunds: { list: jest.fn() } }));
jest.mock("../services/caseLifecycle", () => ({ buildReceiptPdfBuffer: jest.fn(), uploadPdfToS3: jest.fn(), getReceiptKey: jest.fn() }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Payout = require("../models/Payout"), stripe = require("../utils/stripe"), renderer = require("../services/caseLifecycle");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/payments", require("../routes/payments"));
let owner, para, other, matter, intent;
const pdf = Buffer.from("%PDF-1.4\nEarlier withdrawal receipt\n");
const cookie = actor => `token=${require("jsonwebtoken").sign({ id: String(actor._id), role: actor.role, av: actor.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const base = () => `/api/payments/receipt/attorney/${matter._id}`;
const get = (suffix, query = {}, actor = owner) => request(app).get(`${base()}${suffix}`).set("Cookie", cookie(actor)).query({ expectedOwnerId: String(actor._id), ...query });
const change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });
const list = async query => { const response = await get("/history", query); expect(response.status).toBe(200); return response.body; };
const event = (index, patch = {}) => ({ withdrawnParalegalId: new Types.ObjectId(), paralegalNameSnapshot: `Earlier paralegal ${index}`, payoutFinalizedAt: new Date(1700000000000 + index * 86400000), payoutFinalizedType: "zero_auto", partialPayoutAmount: 0, ...patch });
const ledger = record => Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter._id, paralegalId: record.withdrawnParalegalId, status: "paid", amountPaid: 8100, transferId: record.payoutTransferId || "tr_earlier", createdAt: record.payoutFinalizedAt, stripeMode: "test" });
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Payout.init()]); }); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@receipt-history.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = { _id: new Types.ObjectId(), attorney: owner._id, attorneyId: owner._id, title: "River Street lease records", status: "in progress", totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, escrowIntentId: "pi_history", paymentIntentId: "pi_history", escrowStatus: "funded", fundingIntegrityStatus: "verified", currency: "usd", stripeMode: "test", withdrawalHistory: [], privateNotes: "PRIVATE_MATTER" };
  await Case.collection.insertOne(matter);
  intent = { id: "pi_history", status: "succeeded", amount_received: 48800, currency: "usd", livemode: false, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: { id: "ch_history", payment_intent: "pi_history", amount_captured: 48800, amount_refunded: 0, currency: "usd", paid: true, captured: true, disputed: false } };
  stripe.paymentIntents.retrieve.mockReset().mockImplementation(async () => structuredClone(intent)); stripe.refunds.list.mockReset().mockResolvedValue({ data: [], has_more: false }); renderer.buildReceiptPdfBuffer.mockReset().mockResolvedValue(pdf);
});
test("receipt choices list actual funding and withdrawal records without provider reads or private source fields", async () => {
  const older = event(1, { withdrawnParalegalId: para._id, privateNote: "PRIVATE_WITHDRAWAL", payoutTransferId: "tr_private_pointer" });
  await change({ withdrawalHistory: [older] }); const before = await Case.collection.findOne({ _id: matter._id }), response = await get("/history");
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store"); expect(response.body).toMatchObject({ total: 2, currency: "USD", entries: [{ id: "payment", type: "payment", amount: null }, { type: "withdrawal", amount: 0, paralegalName: "Synthetic para" }] });
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|tr_private_pointer|withdrawnParalegalId|payoutTransferId|pi_history/); expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(renderer.buildReceiptPdfBuffer).not.toHaveBeenCalled(); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test("sixty earlier decisions are fully paged and exact choices stay stable when history is reordered", async () => {
  const history = Array.from({ length: 60 }, (_, i) => event(i)); await change({ withdrawalHistory: history }); const first = await list(); expect(first.total).toBe(61); expect(first.entries).toHaveLength(25);
  const second = await list({ cursor: first.nextCursor, revision: first.revision }), third = await list({ cursor: second.nextCursor, revision: second.revision }); expect(third.nextCursor).toBeNull(); const all = [...first.entries, ...second.entries, ...third.entries]; expect(new Set(all.map(item => item.id)).size).toBe(61);
  const selected = third.entries.at(-1); expect((await list({ receiptId: selected.id })).selected).toEqual(selected); await change({ withdrawalHistory: [...history].reverse() }); expect((await list({ receiptId: selected.id })).selected).toEqual(selected); expect((await get("/history", { cursor: first.nextCursor, revision: first.revision })).status).toBe(409);
});
test("explicit original funding remains available after a withdrawal and preserves captured amounts and refunds", async () => {
  await change({ ...event(2, { withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_partial" }), paymentReleased: false, remainingAmount: 30000 }); await ledger({ withdrawnParalegalId: para._id, payoutFinalizedAt: event(2).payoutFinalizedAt, payoutTransferId: "tr_partial" });
  expect((await get("/review")).body.receipt.type).toBe("withdrawal"); intent.latest_charge.amount_refunded = 10000; stripe.refunds.list.mockResolvedValue({ data: [{ id: "re_history", payment_intent: intent.id, charge: intent.latest_charge.id, amount: 10000, currency: "usd", status: "succeeded" }], has_more: false });
  const review = await get("/review", { receiptId: "payment" }); expect(review.body).toMatchObject({ selectionId: "payment", receipt: { type: "payment", status: "partially_refunded", total: { amount: 38800 }, lines: expect.arrayContaining([{ label: "Matter amount", amount: 40000 }]) } });
  const download = await get("", { receiptId: "payment", revision: review.body.revision }).buffer(true); expect(download.status).toBe(200); expect(download.body).toEqual(pdf);
});
test("each earlier withdrawal selects its own paid ledger even after the Matter completes with another paralegal", async () => {
  const records = [event(1, { partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_first" }), event(2, { partialPayoutAmount: 15000, payoutFinalizedType: "admin", payoutTransferId: "tr_second" })];
  await change({ withdrawalHistory: records, paymentReleased: true, paralegal: para._id }); for (const record of records) await ledger(record);
  for (const choice of (await list()).entries.filter(item => item.type === "withdrawal")) {
    const review = await get("/review", { receiptId: choice.id }); expect(review.status).toBe(200); expect(review.body.receipt.total.amount).toBe(choice.amount); expect(review.body.receipt.lines).toEqual([{ label: "Amount released from Matter", amount: choice.amount }]); expect(review.body.receipt.id).toBe(records.find(record => record.partialPayoutAmount === choice.amount).payoutTransferId); const result = await get("", { receiptId: choice.id, revision: review.body.revision }).buffer(true); expect(result.status).toBe(200); expect(result.body).toEqual(pdf);
  }
  expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(renderer.uploadPdfToS3).not.toHaveBeenCalled();
});
test("repeated assignments without an exact payout pointer cannot borrow the latest paid transfer", async () => {
  const first = event(1, { withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney" }), second = event(2, { withdrawnParalegalId: para._id, partialPayoutAmount: 15000, payoutFinalizedType: "admin" }); await change({ withdrawalHistory: [first, second] }); await ledger(first);
  for (const row of (await list()).entries.slice(1)) expect((await get("/review", { receiptId: row.id })).body.reason).toBe("needs_review");
  first.payoutTransferId = "tr_earlier"; second.payoutTransferId = "tr_second"; await ledger(second); await change({ withdrawalHistory: [first, second] });
  for (const row of (await list()).entries.slice(1)) expect((await get("/review", { receiptId: row.id })).body.receipt.total.amount).toBe(row.amount);
});
test("one stored transfer cannot prove two different withdrawal decisions", async () => {
  const first = event(1, { withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_shared" }), second = { ...first, payoutFinalizedAt: event(2).payoutFinalizedAt, partialPayoutAmount: 15000 }; await change({ withdrawalHistory: [first, second] }); await ledger(first);
  for (const row of (await list()).entries.slice(1)) expect((await get("/review", { receiptId: row.id })).body.reason).toBe("needs_review");
});
test("duplicate mirrors are deduplicated, while conflicting decision amounts require review", async () => {
  const first = event(1); await change({ ...first, withdrawalHistory: [first, { ...first }] }); const choices = await list(); expect(choices.total).toBe(2); expect(choices.entries[1].needsReview).toBe(false);
  await change({ partialPayoutAmount: 1000 }); const conflict = await list(); expect(conflict.total).toBe(2); expect(conflict.entries[1].needsReview).toBe(true); expect((await get("/review", { receiptId: conflict.entries[1].id })).body.reason).toBe("needs_review");
});
test.each(["pending", "failed", "reversed", "needs_reconciliation"])("a historical %s payout cannot issue a paid receipt", async status => {
  const record = event(1, { partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_older" }); await change({ withdrawalHistory: [record] }); await ledger(record); await Payout.collection.updateMany({}, { $set: { status } }); const choice = (await list()).entries[1];
  expect((await get("/review", { receiptId: choice.id })).body.reason).toBe("payout_unconfirmed"); expect((await get("", { receiptId: choice.id })).status).toBe(409); expect(renderer.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test("a matching transfer in another Matter or belonging to another paralegal cannot issue a receipt", async () => {
  const record = event(1, { partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_older" }); await change({ withdrawalHistory: [record] }); await ledger(record); const choice = (await list()).entries[1];
  await Payout.collection.updateMany({}, { $set: { caseId: new Types.ObjectId() } }); expect((await get("/review", { receiptId: choice.id })).body.reason).toBe("payout_unconfirmed"); await Payout.collection.updateMany({}, { $set: { caseId: matter._id, paralegalId: para._id } }); expect((await get("/review", { receiptId: choice.id })).body.reason).toBe("payout_unconfirmed");
});
test("an earlier zero decision stays explicit and malformed historical data cannot become an empty list", async () => {
  await change({ withdrawalHistory: [event(1)] }); const choice = (await list()).entries[1], review = await get("/review", { receiptId: choice.id }); expect(review.body.receipt).toMatchObject({ status: "no_payout", total: { amount: 0 } });
  await change({ withdrawalHistory: { invalid: true } }); expect((await get("/history")).status).toBe(409); expect((await get("/review", { receiptId: "payment" })).body.receipt.type).toBe("payment");
  await change({ withdrawalHistory: Array.from({ length: 4001 }, (_, index) => event(index)) }); expect((await get("/history")).status).toBe(413);
});
test("missing payout dates are not replaced with the withdrawal decision date", async () => {
  const record = event(1, { partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_dated", pausedAt: new Date(1600000000000) }); await change({ withdrawalHistory: [record] }); await ledger(record); await Payout.collection.updateMany({}, { $unset: { createdAt: "" } });
  const choice = (await list()).entries[1], review = await get("/review", { receiptId: choice.id }); expect(review.body.receipt).toMatchObject({ status: "payout_recorded", issuedAt: null }); expect((await get("", { receiptId: choice.id, revision: review.body.revision })).status).toBe(200); expect(renderer.buildReceiptPdfBuffer).toHaveBeenCalledWith(expect.objectContaining({ issuedAt: "Date unavailable" }));
});
test("a malformed gross amount, provider-mode disagreement or earlier-assignment transfer cannot issue a receipt", async () => {
  const record = event(1, { partialPayoutAmount: 40001, payoutFinalizedType: "full", payoutTransferId: "tr_invalid", pausedAt: new Date(1600000000000) }); await change({ withdrawalHistory: [record] }); await ledger(record); const choice = (await list()).entries[1]; expect((await get("/review", { receiptId: choice.id })).body.reason).toBe("needs_review");
  record.partialPayoutAmount = 40000; await change({ withdrawalHistory: [record] }); await Payout.collection.updateMany({}, { $set: { stripeMode: "live" } }); expect((await get("/review", { receiptId: choice.id })).body.reason).toBe("needs_review");
  await Payout.collection.updateMany({}, { $set: { stripeMode: "test", createdAt: new Date(1500000000000) } }); expect((await get("/review", { receiptId: choice.id })).body.reason).toBe("needs_review"); expect(renderer.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test("removed selections and invalid query pages never fall back to an unrelated receipt", async () => {
  expect((await get("/review", { receiptId: "f".repeat(64) })).status).toBe(404); expect((await get("/history", { receiptId: "f".repeat(64) })).body.selection).toBe("unavailable");
  for (const query of [{ receiptId: "latest" }, { cursor: "25" }, { cursor: "-1", revision: "a".repeat(64) }, { unrelated: "private" }]) expect((await get("/history", query)).status).toBe(400);
  expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(renderer.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test("account and ownership changes deny history before exposing financial metadata", async () => {
  expect((await get("/history", {}, para)).status).toBe(403); expect([403, 404]).toContain((await get("/history", {}, other)).status); expect((await get("/history", { expectedOwnerId: String(other._id) })).status).toBe(403);
  await change({ attorneyId: other._id });
  const before = await Case.collection.findOne({ _id: matter._id }), rejected = await get("/history");
  expect({ status: rejected.status, body: rejected.body }).toEqual({ status: 409, body: { code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." } });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  expect(renderer.buildReceiptPdfBuffer).not.toHaveBeenCalled();
  await change({ attorneyId: owner._id }); await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); expect((await get("/history")).status).toBe(403);
});
test.each(["reversal", "decision", "account"])("%s during earlier-receipt rendering suppresses PDF delivery", async mode => {
  const record = event(1, { partialPayoutAmount: 10000, payoutFinalizedType: "partial_attorney", payoutTransferId: "tr_older" }); await change({ withdrawalHistory: [record] }); await ledger(record); const choice = (await list()).entries[1], reviewed = await get("/review", { receiptId: choice.id });
  renderer.buildReceiptPdfBuffer.mockImplementation(async () => { if (mode === "reversal") await Payout.collection.updateMany({}, { $set: { status: "reversed", reversedAt: new Date() } }); if (mode === "decision") await change({ withdrawalHistory: [{ ...record, partialPayoutAmount: 20000 }] }); if (mode === "account") await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return pdf; });
  const result = await get("", { receiptId: choice.id, revision: reviewed.body.revision }); expect([403, 409]).toContain(result.status); expect(result.headers["content-type"]).not.toContain("application/pdf");
});
