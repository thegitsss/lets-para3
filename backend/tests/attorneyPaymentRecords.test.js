jest.mock("../utils/stripe", () => ({}));
const mongoose = require("mongoose"), request = require("supertest"), express = require("express"), cookieParser = require("cookie-parser");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const Case = require("../models/Case"), User = require("../models/User");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/payments", require("../routes/payments"));
let owner, para, other, caseId;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const read = (query = {}, user = owner) => request(app).get("/api/payments/attorney-records").query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const change = values => Case.collection.updateOne({ _id: caseId }, { $set: values });
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@payment-records.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  caseId = new mongoose.Types.ObjectId(); await Case.collection.insertOne({ _id: caseId, title: "Lease [original]", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", currency: "usd", totalAmount: 70000, lockedTotalAmount: 60001, escrowIntentId: "pi_synthetic_original", escrowStatus: "funded", fundingVerifiedAt: new Date("2026-01-02"), updatedAt: new Date("2026-09-01"), feeAttorneyAmount: 1200, internalNotes: "PRIVATE_NOTE", unknownRecord: "PRESERVE" });
});
test("payment records preserve exact Matter cents and recorded dates without provider calls or changes", async () => {
  const before = await Case.collection.findOne({ _id: caseId }), result = await read(); expect(result.status).toBe(200); expect(result.headers["cache-control"]).toContain("no-store"); expect(result.body).toMatchObject({ ownerId: String(owner._id), total: 1, nextCursor: null, selection: "none", selected: null });
  expect(result.body.items[0]).toMatchObject({ title: "Lease [original]", matterAmount: 60001, currency: "USD", funding: "recorded", release: "not_recorded", paralegalName: "Synthetic para", fundingVerifiedAt: "2026-01-02T00:00:00.000Z", releasedAt: null }); expect(JSON.stringify(result.body)).not.toMatch(/pi_synthetic|PRIVATE_NOTE|unknownRecord|@payment-records|feeAttorneyAmount/); expect(await Case.collection.findOne({ _id: caseId })).toEqual(before);
});
test("275 payment Matters page without a silent cap, retain raw string ownership and expose an exact earlier link", async () => {
  await Case.deleteMany({}); const docs = Array.from({ length: 275 }, (_, n) => ({ _id: new mongoose.Types.ObjectId(), title: `Lease ${n}`, attorney: n % 2 ? String(owner._id) : owner._id, attorneyId: n % 2 ? String(owner._id) : owner._id, paralegalId: n % 2 ? String(para._id) : para._id, status: "in progress", totalAmount: n + 1, currency: "usd", escrowStatus: "funded", escrowIntentId: `pi_test_${n}` })); await Case.collection.insertMany(docs);
  const seen = new Set(); let cursor; do { const result = await read(cursor ? { cursor } : {}); expect(result.status).toBe(200); expect(result.body.total).toBe(275); expect(result.body.items.length).toBeLessThanOrEqual(50); for (const row of result.body.items) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); } cursor = result.body.nextCursor; } while (cursor); expect(seen.size).toBe(275);
  const selected = await read({ caseId: String(docs[0]._id) }); expect(selected.body.selection).toBe("found"); expect(selected.body.selected.id).toBe(String(docs[0]._id)); expect(selected.body.items.some(row => row.id === String(docs[0]._id))).toBe(false);
});
test("filters count actual matching records and search punctuation literally", async () => {
  expect((await read({ q: "[original]" })).body.total).toBe(1); expect((await read({ q: ".*" })).body.total).toBe(0); expect((await read({ view: "released" })).body.total).toBe(0); await change({ paymentReleased: true }); expect((await read({ view: "released" })).body.total).toBe(1); expect((await read({ view: "unreleased" })).body.total).toBe(0);
  await change({ withdrawnParalegalId: para._id, payoutFinalizedAt: new Date("2026-02-01"), partialPayoutAmount: 25001, payoutFinalizedType: "partial_attorney" }); const result = await read({ view: "withdrawal" }); expect(result.body.total).toBe(1); expect(result.body.items[0].withdrawal).toEqual({ at: "2026-02-01T00:00:00.000Z", amount: 25001, decision: "partial_attorney" }); expect(result.body.items[0].matterAmount).toBe(60001); expect(result.body.items[0].releasedAt).toBeNull();
});
test.each([{ lockedTotalAmount: "600.01" }, { lockedTotalAmount: -1 }, { lockedTotalAmount: 1.5 }])("invalid stored cents are not coerced into money: %j", async patch => { await change(patch); expect((await read()).body.items[0].matterAmount).toBeNull(); });
test.each(["JPY", "BHD", "invalid"])("unconfirmed %s currency is not displayed as dollars", async currency => { await change({ currency }); expect((await read()).body.items[0].currency).toBeNull(); });
test("funding mismatch and reversed payout remain distinct from recorded funding and release", async () => {
  await change({ paymentIntentId: "pi_different", paymentReleased: true, payoutStatus: "reversed", paidOutAt: new Date("2026-03-01") }); expect((await read()).body.items[0]).toMatchObject({ funding: "needs_review", release: "reversed", releasedAt: "2026-03-01T00:00:00.000Z" });
});
test("earlier withdrawals remain in their filter after the latest assignment fields are cleared", async () => {
  await change({ paralegal: null, paralegalId: null, escrowIntentId: null, escrowStatus: null, withdrawalHistory: [{ withdrawnParalegalId: para._id, payoutFinalizedType: "full", partialPayoutAmount: 60001, payoutFinalizedAt: new Date("2026-03-01") }] });
  const result = await read({ view: "withdrawal" }); expect(result.status).toBe(200); expect(result.body.total).toBe(1); expect(result.body.items[0]).toMatchObject({ withdrawal: null, earlierWithdrawals: 1 });
});
test("unfunded assigned Matters load without creating checkout sessions; unrelated drafts stay out of the list", async () => {
  await change({ escrowIntentId: null, escrowStatus: "awaiting_funding", fundingVerifiedAt: null }); expect((await read()).body.items[0].funding).toBe("not_recorded");
  await Case.collection.insertOne({ _id: new mongoose.Types.ObjectId(), title: "Unpublished", attorney: owner._id, status: "draft", totalAmount: 80000 }); expect((await read()).body.total).toBe(1);
});
test("owner, role, alias and account boundaries prevent payment disclosure", async () => {
  expect((await read({}, other)).body.total).toBe(0); expect((await read({ caseId: String(caseId) }, other)).body.selection).toBe("unavailable"); expect((await read({}, para)).status).toBe(403); expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403);
  await change({ attorneyId: other._id }); expect((await read()).status).toBe(409); await change({ attorneyId: owner._id, paralegalId: other._id }); expect((await read()).status).toBe(409);
});
test.each(["account", "owner", "payment"])("a late %s change suppresses the payment list", async kind => {
  const find = User.collection.find.bind(User.collection); jest.spyOn(User.collection, "find").mockImplementationOnce((...args) => ({ toArray: async () => { if (kind === "account") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); if (kind === "owner") await change({ attorney: other._id, attorneyId: other._id }); if (kind === "payment") await change({ paymentReleased: true }); return find(...args).toArray(); } }));
  const result = await read(); expect([403, 409]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("Lease [original]");
});
test("malformed requests fail before loading private records", async () => { for (const query of [{ cursor: "bad" }, { caseId: "bad" }, { view: "held" }, { q: "a".repeat(101) }, { unexpected: "field" }]) expect((await read(query)).status).toBe(400); });
