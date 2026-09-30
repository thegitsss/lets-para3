const mongoose = require("mongoose"), User = require("../models/User"), Case = require("../models/Case"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation");
const { getParalegalEarnings } = require("../services/paymentProjectionService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const express = require("express"), request = require("supertest"), cookieParser = require("cookie-parser"), jwt = require("jsonwebtoken");
const app = express(); app.use(cookieParser()); app.use("/api/paralegal/dashboard", require("../routes/paralegalDashboard"));
const dashboard = person => request(app).get("/api/paralegal/dashboard").set("Cookie", `token=${jwt.sign({ id: String(person._id), role: person.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
let attorney, para, replacement, matter, payout, operation;
const now = new Date("2026-09-30T12:00:00Z"), paidAt = new Date("2026-09-05T12:00:00Z");
const totals = (person = para) => getParalegalEarnings(person._id, { now });
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Payout.init(), Operation.init(), require("../models/Application").init(), require("../models/Job").init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase();
  [attorney, para, replacement] = await User.create(["attorney", "para", "replacement"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@retained-payout.test`, password: "Synthetic123!", role: name === "attorney" ? "attorney" : "paralegal", status: "approved" })));
  matter = await Case.create({ title: "River Street lease records", details: "Recorded payouts across successive paralegal assignments.", attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: "completed", paymentReleased: true, payoutStatus: "paid", payoutTransferId: "tr_retained_payout", paidOutAt: paidAt, totalAmount: 40000, lockedTotalAmount: 40000, feeParalegalPct: 18, currency: "usd", stripeMode: "test" });
  payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: `case_payout:${matter._id}`, amountPaid: 32800, transferId: "tr_retained_payout", status: "paid", stripeMode: "test", createdAt: paidAt });
  operation = await Operation.create({ caseId: matter._id, operationKey: payout.operationKey, kind: "case_payout", fingerprint: "retained_payout", amount: 32800, transferAmount: 32800, currency: "usd", status: "succeeded", stripeTransferId: payout.transferId, stripeObjectId: payout.transferId, stripeMode: "test" });
});
test.each([null, "", "absent"])("a payout status of %s is not proof of paid earnings", async status => {
  await Payout.collection.updateOne({ _id: payout._id }, status === "absent" ? { $unset: { status: "" } } : { $set: { status } });
  expect(await totals()).toMatchObject({ month: 0, last30: 0, total: 0 });
});
test("a recorded withdrawal decision does not invent a payout when no paid record exists", async () => {
  await Payout.deleteMany({}); await Operation.deleteMany({}); await Case.updateOne({ _id: matter._id }, { $set: { status: "paused", paymentReleased: false, payoutTransferId: "", withdrawnParalegalId: para._id, partialPayoutAmount: 20000, payoutFinalizedAt: paidAt, payoutFinalizedType: "partial_attorney" } });
  expect(await totals()).toMatchObject({ month: 0, last30: 0, total: 0 });
});
test("a paid earlier assignment remains in its paralegal's earnings after a replacement starts work", async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { status: "in progress", paymentReleased: false, payoutTransferId: "", remainingAmount: 30000, paralegal: replacement._id, paralegalId: replacement._id, withdrawalHistory: [{ withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedAt: paidAt, payoutFinalizedType: "partial_attorney", payoutTransferId: payout.transferId, pausedAt: new Date("2026-09-04T12:00:00Z") }] } });
  const key = `partial_payout:${matter._id}:prior_assignment`; await Payout.updateOne({ _id: payout._id }, { $set: { operationKey: key, amountPaid: 8200 } }); await Operation.updateOne({ _id: operation._id }, { $set: { operationKey: key, kind: "partial_payout", amount: 8200, transferAmount: 8200 } });
  expect(await totals()).toMatchObject({ month: 82, last30: 82, total: 82 }); expect(await totals(replacement)).toMatchObject({ total: 0 });
});
test("an unresolved transfer operation prevents an older paid row from being counted as verified earnings", async () => {
  await Operation.updateOne({ _id: operation._id }, { $set: { status: "needs_reconciliation", evidenceStatus: "quarantined" } });
  expect(await totals()).toMatchObject({ total: 0 });
});
test("a reversed Matter payout cannot borrow an older paid ledger status", async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { payoutStatus: "reversed" } }); expect(await totals()).toMatchObject({ total: 0 });
});
test("a combined settlement's gross decision stays separate from the net payout actually transferred", async () => {
  await Operation.updateOne({ _id: operation._id }, { $set: { kind: "dispute_settlement", amount: 10000, transferAmount: 8200 } }); await Payout.updateOne({ _id: payout._id }, { $set: { amountPaid: 8200 } });
  await Case.updateOne({ _id: matter._id }, { $set: { disputeSettlement: { transferId: payout.transferId, payoutAmount: 8200 } } });
  expect(await totals()).toMatchObject({ total: 82 });
});
test("a reference retained under another Matter cannot verify this paralegal's payout", async () => {
  await Operation.create({ caseId: new mongoose.Types.ObjectId(), operationKey: "foreign_transfer_record", kind: "case_payout", fingerprint: "foreign_transfer", amount: 32800, status: "succeeded", stripeTransferId: payout.transferId });
  expect(await totals()).toMatchObject({ total: 0 });
});
test("separate currencies are retained without relabeling another currency as USD earnings", async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { currency: "eur" } }); await Operation.updateOne({ _id: operation._id }, { $set: { currency: "eur" } });
  const result = await require("../services/retainedPayoutProjection").read(para._id, { now }); expect(result.currencies).toEqual([{ currency: "EUR", month: 32800, last30: 32800, total: 32800 }]); expect(await totals()).toEqual({ month: 0, last30: 0, total: 0 });
});
test("missing payout dates remain missing and are not included in a month or thirty-day total", async () => {
  await Payout.collection.updateOne({ _id: payout._id }, { $unset: { createdAt: "" } });
  const result = await require("../services/retainedPayoutProjection").read(para._id, { now }); expect(result.rows[0].recordedAt).toBeNull(); expect(await totals()).toEqual({ month: 0, last30: 0, total: 328 });
});
test("a successful projection does not repair or otherwise change retained financial records", async () => {
  const before = { matter: await Case.findById(matter._id).lean(), payout: await Payout.findById(payout._id).lean(), operation: await Operation.findById(operation._id).lean() };
  expect(await totals()).toEqual({ month: 328, last30: 328, total: 328 }); expect({ matter: await Case.findById(matter._id).lean(), payout: await Payout.findById(payout._id).lean(), operation: await Operation.findById(operation._id).lean() }).toEqual(before);
});
test("a changed Matter during a payout read returns a conflict instead of stale earnings", async () => {
  const find = Case.collection.find.bind(Case.collection); let changed = false;
  jest.spyOn(Case.collection, "find").mockImplementation((...args) => { const cursor = find(...args), array = cursor.toArray.bind(cursor); cursor.toArray = async () => { const rows = await array(); if (!changed) { changed = true; await Case.collection.updateOne({ _id: matter._id }, { $set: { payoutStatus: "reversed" } }); } return rows; }; return cursor; });
  await expect(totals()).rejects.toMatchObject({ code: "PAYOUT_PROJECTION_CHANGED", statusCode: 409 });
});
test("the actual paralegal dashboard reads verified earnings and excludes another account's payout", async () => {
  const response = await dashboard(para); expect(response.status).toBe(200); expect(response.body.metrics).toMatchObject({ earnings: 328, earningsLast30Days: 328, earningsTotal: 328 });
  const other = await dashboard(replacement); expect(other.status).toBe(200); expect(other.body.metrics).toMatchObject({ earningsTotal: 0 }); expect(JSON.stringify(other.body)).not.toContain("River Street");
  expect((await dashboard(attorney)).status).toBe(403);
});
test("a failed payout read does not return an empty earnings dashboard", async () => {
  jest.spyOn(Payout.collection, "find").mockImplementationOnce(() => { throw new Error("Synthetic payout records unavailable"); });
  const response = await dashboard(para); expect(response.status).toBe(500); expect(response.body.metrics).toBeUndefined();
});
