const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server"), { clearDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), AuditLog = require("../models/AuditLog"), Notification = require("../models/Notification");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/disputes", require("../routes/disputes"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, owner, other, para, invited, admin, matter;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("attorney-disputes")); await Promise.all([User.init(), Case.init(), AuditLog.init(), Notification.init(), require("../models/MatterReviewNotification").init()]); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); [owner, other, para, invited, admin] = await User.create(["owner", "other", "para", "invited", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@disputes.test`, password: "Synthetic123!", role: name === "admin" ? "admin" : ["para", "invited"].includes(name) ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "River Street lease review", details: "Review lease exhibits", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_dispute", totalAmount: 100000, currency: "usd" });
});
const read = (query = {}, user = owner) => request(app).get(`/api/disputes/${matter._id}/attorney-review`).set("Cookie", cookie(user)).query({ expectedOwnerId: String(user._id), ...query });
const send = (body, user = owner) => request(app).post(`/api/disputes/${matter._id}/attorney-action`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const legacyRead = (user = owner) => request(app).get(`/api/disputes/${matter._id}`).set("Cookie", cookie(user));
const raw = () => Case.collection.findOne({ _id: matter._id });
async function seed(count = 1, comments = 0, extra = {}) {
  const values = Array.from({ length: count }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), disputeId: new mongoose.Types.ObjectId().toString(), message: `Recorded review ${index + 1}`, raisedBy: para._id, status: "resolved", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), adminNotes: "PRIVATE_ADMIN_REASON", adminNotesUpdatedBy: admin._id, retainedPrivateEvidence: "NEVER_EXPOSE", comments: Array.from({ length: comments }, (_, n) => ({ _id: new mongoose.Types.ObjectId(), by: para._id, text: `Recorded comment ${n + 1}`, createdAt: new Date("2026-01-02"), privateInternalDetail: "NEVER_EXPOSE_COMMENT" })), ...extra }));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { disputes: values } }); return values;
}
async function command(action = "open", text = "The exhibit references need administrator review.", disputeId) {
  const result = await read(disputeId ? { disputeId } : {}); expect(result.status).toBe(200); return { action, text, requestId: crypto.randomUUID(), reviewedRevision: result.body.revision, ...(action === "comment" ? { disputeId: result.body.selected.id, reviewedDisputeRevision: result.body.selected.revision } : {}) };
}
test("paged reviews and comments expose actual totals and exact older selections without private administrator fields", async () => {
  const values = await seed(80, 75); const ids = []; let cursor;
  do { const result = await read(cursor ? { cursor } : {}); expect(result.status).toBe(200); expect(result.body.total).toBe(80); expect(result.body.items.length).toBeLessThanOrEqual(25); ids.push(...result.body.items.map(value => value.id)); cursor = result.body.nextCursor; expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_ADMIN_REASON|NEVER_EXPOSE|adminNotes|privateInternalDetail/); } while (cursor);
  expect(new Set(ids).size).toBe(80); const linked = await read({ disputeId: values[0].disputeId, commentId: String(values[0].comments[0]._id) }); expect(linked.body.selected.id).toBe(values[0].disputeId); expect(linked.body.selected.selectedComment.text).toBe("Recorded comment 1"); expect(linked.body.selected.commentCount).toBe(75); const seen = []; let commentCursor;
  do { const result = await read({ disputeId: values[0].disputeId, ...(commentCursor ? { commentCursor } : {}) }); seen.push(...result.body.selected.comments.map(value => value.id)); commentCursor = result.body.selected.nextCommentCursor; } while (commentCursor); expect(new Set(seen).size).toBe(75); expect(linked.headers["cache-control"]).toBe("private, no-store");
});
test("invitation access never grants legacy dispute reads, while actual participants keep their public records", async () => {
  await seed(); await Case.collection.updateOne({ _id: matter._id }, { $set: { pendingParalegalId: invited._id, invites: [{ paralegalId: invited._id, status: "pending" }] } }); expect((await legacyRead(invited)).status).toBe(403);
  for (const user of [owner, para]) { const result = await legacyRead(user); expect(result.status).toBe(200); expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_ADMIN_REASON|NEVER_EXPOSE/); }
  expect(JSON.stringify((await legacyRead(admin)).body)).toContain("PRIVATE_ADMIN_REASON");
});
test("opening a reviewed dispute records its exact action and preserves existing participant/admin notifications", async () => {
  const body = await command(), result = await send(body); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { operation: { status: "recorded", action: "open", changedSinceSave: false } } }); const stored = await raw(); expect(stored.status).toBe("disputed"); expect(stored.pausedReason).toBe("dispute"); expect(stored.disputes).toHaveLength(1); expect(stored.disputes[0].message).toBe(body.text); expect(stored.paymentReleased).toBe(false); expect(stored.escrowStatus).toBe("funded");
  expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3); expect(require("../services/lpcEvents/publishEventService").publishEventSafe).toHaveBeenCalledTimes(1); expect((await send(body)).body.operation.disputeId).toBe(result.body.operation.disputeId); expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3); expect(await AuditLog.countDocuments({ "meta.kind": "attorney_dispute" })).toBe(1);
});
test("a changed request cannot reuse a saved action and a lost transaction acknowledgement recovers without a duplicate dispute", async () => {
  const original = mongoose.startSession.bind(mongoose); jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await original(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost commit acknowledgement"); }; return session; });
  const body = await command(), result = await send(body); expect(result.status).toBe(200); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("recorded"); expect((await send({ ...body, text: "Different request" })).status).toBe(409); expect((await raw()).disputes).toHaveLength(1); expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3);
});
test("comments preserve prior raw metadata and support earlier _id-only disputes and missing dates", async () => {
  const [value] = await seed(1, 1); await Case.collection.updateOne({ _id: matter._id }, { $unset: { "disputes.0.disputeId": "", "disputes.0.createdAt": "", "disputes.0.comments.0.createdAt": "" }, $set: { attorney: String(owner._id), attorneyId: String(owner._id), "disputes.0.raisedBy": String(para._id), "disputes.0.comments.0.by": String(para._id) } }); const before = await raw(), review = await read({ disputeId: String(value._id) }); expect(review.body.selected.createdAt).toBeNull(); expect(review.body.selected.comments[0].createdAt).toBeNull();
  const body = await command("comment", "The missing exhibit is attached to the Matter.", String(value._id)), result = await send(body); expect(result.status).toBe(200); const after = await raw(); expect(after.disputes[0].comments[0]).toEqual(before.disputes[0].comments[0]); expect(after.disputes[0].adminNotes).toBe(before.disputes[0].adminNotes); expect(after.disputes[0].retainedPrivateEvidence).toBe(before.disputes[0].retainedPrivateEvidence); expect(after.disputes[0].disputeId).toBeUndefined(); expect(after.attorney).toBe(before.attorney); expect((await send(body)).body.operation.commentId).toBe(result.body.operation.commentId); expect((await raw()).disputes[0].comments).toHaveLength(2);
});
test("a competing comment or administrator decision invalidates the earlier discussion version without erasing the draft", async () => {
  const [value] = await seed(), body = await command("comment", "Earlier draft", value.disputeId); const legacy = await request(app).post(`/api/disputes/${matter._id}/${value.disputeId}/comment`).set("Cookie", cookie(para)).send({ text: "New paralegal evidence" }); expect(legacy.status).toBe(201); expect((await send(body)).status).toBe(409); expect((await raw()).disputes[0].comments[0].text).toBe("New paralegal evidence");
});
test("two competing openings record only one dispute and one notification set", async () => {
  const a = await command(), b = await command("open", "Another opening"), results = await Promise.all([send(a), send(b)]); expect(results.map(value => value.status).sort()).toEqual([200, 409]); expect((await raw()).disputes).toHaveLength(1); expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3);
});
test("simultaneous copies of one request recover the winner without a second notification set", async () => {
  const body = await command(), original = Case.collection.findOneAndUpdate.bind(Case.collection); let entered = 0, bothEntered, winnerFinished;
  const both = new Promise(resolve => { bothEntered = resolve; }), winner = new Promise(resolve => { winnerFinished = resolve; });
  jest.spyOn(Case.collection, "findOneAndUpdate").mockImplementation(async (...args) => {
    if (args[1]?.$push?.disputes && args[2]?.session) { if (++entered === 1) await both; else { bothEntered(); await winner; } }
    return original(...args);
  });
  const run = () => send(body).then(result => { winnerFinished(); return result; });
  const results = await Promise.all([run(), run()]); expect(results.map(value => value.status)).toEqual([200, 200]); expect((await raw()).disputes).toHaveLength(1); expect(await AuditLog.countDocuments({ "meta.kind": "attorney_dispute" })).toBe(1); expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3); expect(require("../services/lpcEvents/publishEventService").publishEventSafe).toHaveBeenCalledTimes(1);
});
test.each([{ completionClaimStatus: "claimed" }, { completionClaimStatus: "needs_reconciliation" }, { hiringClaimStatus: "claimed" }, { escrowStatus: "none" }, { status: "open" }])("unavailable funded-work or processing state %j cannot open a dispute", async patch => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: patch }); const view = await read(); expect(view.body.canOpen).toBe(false); expect((await send(await command())).status).toBe(409); expect((await raw()).disputes).toHaveLength(0);
});
test("the attorney cannot take the withdrawn paralegal's review window or reopen its expired deadline", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "paused", pausedReason: "paralegal_withdrew", paralegal: null, paralegalId: null, withdrawnParalegalId: para._id, disputeDeadlineAt: new Date(Date.now() + 3600000) } }); expect((await read()).body.reason).toBe("paralegal_review_window"); expect((await send(await command())).status).toBe(409);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { disputeDeadlineAt: new Date(Date.now() - 3600000) } }); expect((await read()).body.reason).toBe("withdrawal_window_ended"); expect((await send(await command())).status).toBe(409);
});
test("recorded administrative settlement is shown only for its exact dispute without claiming a confirmed refund", async () => {
  const values = await seed(2); await Case.collection.updateOne({ _id: matter._id }, { $set: { disputeSettlement: { action: "release_partial", disputeId: values[0].disputeId, grossAmount: 100000, payoutAmount: 32800, refundAmount: 60000, transferId: "tr_PRIVATE", refundId: "re_PRIVATE", resolvedAt: new Date("2026-03-01") } } });
  const result = await read({ disputeId: values[0].disputeId }); expect(result.body.selected.decision).toMatchObject({ action: "release_partial", payoutCents: 32800, refundCents: 60000 }); expect(JSON.stringify(result.body)).not.toMatch(/tr_PRIVATE|re_PRIVATE/); expect((await read({ disputeId: values[1].disputeId })).body.selected.decision).toBeNull();
});
test("fresh ownership and account checks reject other attorneys, paralegals, admins, mismatched aliases and revoked tokens", async () => {
  const body = await command(); for (const user of [other, para, admin]) { expect([403, 404]).toContain((await read({}, user)).status); expect([403, 404]).toContain((await send(body, user)).status); }
  await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); expect((await read()).status).toBe(403); expect((await send(body)).status).toBe(403); expect((await raw()).disputes).toHaveLength(0);
});
test("account revocation before commit aborts the dispute and its exact action record", async () => {
  const body = await command(), boundary = require("../services/attorneyAccountBoundary"), original = boundary.read; let calls = 0;
  jest.spyOn(boundary, "read").mockImplementation(async (...args) => { if (++calls === 4) await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return original(...args); });
  expect((await send(body)).status).toBe(403); expect((await raw()).disputes).toHaveLength(0); expect(await AuditLog.countDocuments({ "meta.kind": "attorney_dispute" })).toBe(0);
});
test("unknown deep links and changed paging cursors are not empty dispute histories", async () => {
  await seed(30); const first = await read(); expect((await read({ disputeId: "missing_review" })).body.selection).toBe("unavailable"); await Case.collection.updateOne({ _id: matter._id }, { $push: { disputes: { disputeId: "later_review", raisedBy: owner._id, message: "Later", status: "resolved" } } }); expect((await read({ cursor: first.body.nextCursor })).status).toBe(409); expect((await read({ cursor: "invalid" })).status).toBe(400);
});
test.each(["", "   ", "x".repeat(20001), "Invalid\u0000details"])("invalid opening text cannot change a Matter", async text => { expect((await send(await command("open", text))).status).toBe(400); expect((await raw()).disputes).toHaveLength(0); });
test("missing transaction support cannot fall back to an unrecorded dispute write", async () => {
  const body = await command(); jest.spyOn(mongoose, "startSession").mockResolvedValue({ startTransaction() { throw new Error("Transactions unavailable"); }, inTransaction: () => false, endSession: async () => {} }); expect((await send(body)).status).toBe(503); expect((await raw()).disputes).toHaveLength(0);
});
