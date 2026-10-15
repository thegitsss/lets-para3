const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const User = require("../models/User"), Case = require("../models/Case"), Message = require("../models/Message");
const account = require("../services/attorneyAccountBoundary"), { decryptMessagePayload } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/messages", require("../routes/messages"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, para, other, matter;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); await Message.init();
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@conversation.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Lease review conversation", details: "Review the lease exhibits.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_conversation", totalAmount: 40000 });
});
const read = (query = {}, user = owner) => request(app).get(`/api/messages/${matter._id}`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const write = (method, path = "", body = {}, user = owner) => request(app)[method](`/api/messages/${matter._id}${path}`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const seed = (text = "Review the lease exhibits.", extras = {}) => Message.create({ caseId: matter._id, senderId: owner._id, senderRole: "attorney", text, content: text, type: "text", ...extras });
test("equal-date paging covers 125 messages exactly once and legacy readers still receive the full conversation", async () => {
  await Message.insertMany(Array.from({ length: 125 }, (_, i) => ({ caseId: matter._id, senderId: para._id, senderRole: "paralegal", type: "text", text: `Exhibit ${i}`, createdAt: new Date("2026-09-01T12:00:00Z") })));
  const ids = []; let cursor; do { const result = await read(cursor ? { cursor } : {}); expect(result.status).toBe(200); expect(result.body.messages.length).toBeLessThanOrEqual(50); ids.push(...result.body.messages.map(m => m._id)); cursor = result.body.nextCursor; } while (cursor);
  expect(ids).toHaveLength(125); expect(new Set(ids).size).toBe(125);
  expect((await request(app).get(`/api/messages/${matter._id}`).set("Cookie", cookie(owner))).body.messages).toHaveLength(125);
});
test("a linked old message is included without loading a long intervening conversation; missing links are explicit", async () => {
  const first = await seed("Original instruction", { createdAt: new Date("2026-08-01") });
  await Message.insertMany(Array.from({ length: 70 }, (_, i) => ({ caseId: matter._id, senderId: para._id, text: `Later ${i}`, createdAt: new Date("2026-09-01") })));
  const linked = await read({ messageId: String(first._id) }); expect(linked.status).toBe(200); expect(linked.body.messages.map(m => m._id)).toEqual([String(first._id)]); expect(linked.body.targetMissing).toBe(false);
  expect((await read({ messageId: "f".repeat(24) })).body.targetMissing).toBe(true);
});
test("reads omit storage keys and email, disclose only the attorney's request IDs, and do not acknowledge unread messages", async () => {
  await seed("Audio note", { type: "audio", transcript: "Exhibit two", fileKey: "private/attorney/audio", clientMessageId: "attorney-client-0001" });
  await seed("Paralegal text", { senderId: para._id, senderRole: "paralegal", clientMessageId: "paralegal-client-0001" });
  const response = await read(); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(JSON.stringify(response.body)).not.toMatch(/private\/attorney|conversation\.test|paralegal-client-0001/); expect(response.body.messages[0].clientMessageId).toBe("attorney-client-0001");
  expect((await User.findById(owner._id)).messageLastViewedAt?.get(String(matter._id))).toBeUndefined(); expect(await Message.countDocuments({ readBy: owner._id })).toBe(0);
});
test("a lost response can be recovered by exact request ID and retried without duplicating the message", async () => {
  const body = { text: "Confirm the exhibit list.", clientMessageId: "attorney-request-0001" };
  const first = await write("post", "", body); expect(first.status).toBe(201);
  const retry = await write("post", "", body); expect(retry.status).toBe(200); expect(retry.body.message._id).toBe(first.body.message._id);
  const recovered = await read({ clientMessageId: body.clientMessageId }); expect(recovered.body.messages.map(m => m._id)).toEqual([first.body.message._id]); expect(await Message.countDocuments()).toBe(1);
  expect((await read({ clientMessageId: "different-request-0001" })).body.messages).toEqual([]);
});
test("reviewed editing preserves unrelated message fields and a stale tab cannot overwrite the saved text", async () => {
  const msg = await seed("Original", { threadRoot: new (require("mongoose").Types.ObjectId)() }); const first = (await read()).body.messages[0];
  const saved = await write("patch", `/${msg._id}`, { content: "Reviewed wording", reviewedRevision: first.revision }); expect(saved.status).toBe(200);
  const stale = await write("patch", `/${msg._id}`, { content: "Old tab", reviewedRevision: first.revision }); expect(stale.status).toBe(409);
  const stored = decryptMessagePayload(await Message.findById(msg._id)); expect(stored.text).toBe("Reviewed wording"); expect(String(stored.threadRoot)).toBe(String(msg.threadRoot));
});
test("reactions, pinning and soft deletion use current revisions and converge with legacy reads", async () => {
  const msg = await seed(); const current = async () => (await read()).body.messages[0].revision;
  expect((await write("post", `/${msg._id}/react`, { emoji: "👍", reviewedRevision: await current() })).status).toBe(201);
  expect((await write("patch", `/${msg._id}`, { pin: true, reviewedRevision: await current() })).status).toBe(200);
  expect((await write("delete", `/${msg._id}/react`, { emoji: "👍", reviewedRevision: await current() })).status).toBe(200);
  expect((await write("delete", `/${msg._id}`, { reviewedRevision: await current() })).status).toBe(200);
  expect((await Message.findById(msg._id)).deleted).toBe(true); expect((await read()).body.messages).toEqual([]);
});
test.each(['attorney', 'paralegal'])('%s reaction input cannot make the shared conversation unreadable', async role => {
  const user = role === 'attorney' ? owner : para;
  const msg = await seed();
  for (const emoji of ['x'.repeat(31), {}, '$value', 'a.b', '__proto__', '']) {
    for (const method of ['post', 'delete']) {
      const response = await request(app)[method](`/api/messages/${matter._id}/${msg._id}/react`).set('Cookie', cookie(user)).send({ emoji });
      expect(response.status).toBe(400);
    }
  }
  expect((await Message.findById(msg._id)).reactions.size).toBe(0);
  expect((await read()).status).toBe(200);
});
test("only the author's message can be edited or deleted, and forged Matter or account references cannot read it", async () => {
  const msg = await seed("Paralegal evidence", { senderId: para._id }); const revision = (await read()).body.messages[0].revision;
  expect((await write("patch", `/${msg._id}`, { content: "Changed", reviewedRevision: revision })).status).toBe(403);
  expect((await write("delete", `/${msg._id}`, { reviewedRevision: revision })).status).toBe(403);
  expect((await read({}, other)).status).toBe(403); expect((await read({}, para)).status).toBe(403); expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403);
});
test.each(["paused", "completed", "disputed"])("a %s Matter cannot send, edit, acknowledge or read through the active conversation contract", async status => {
  await seed(); await Case.collection.updateOne({ _id: matter._id }, { $set: { status } });
  expect((await read()).status).toBe(403); expect((await write("post", "", { text: "Unavailable", clientMessageId: "attorney-request-0002" })).status).toBe(403); expect((await write("post", "/read", { upTo: new Date().toISOString() })).status).toBe(403);
});
test("account revocation during a read withholds the confidential response", async () => {
  await seed("Confidential draft instructions"); const original = account.read; let calls = 0;
  jest.spyOn(account, "read").mockImplementation(async (...args) => { if (++calls === 2) await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return original(...args); });
  const response = await read(); expect(response.status).toBe(403); expect(response.body.code).toBe("WORKSPACE_ACCOUNT_CHANGED"); expect(JSON.stringify(response.body)).not.toContain("Confidential draft");
});
test("read acknowledgement is bounded by its reviewed date and invalid cursors cannot widen reads", async () => {
  const at = new Date(Date.now() - 10000); await seed("Read", { createdAt: at }); await seed("Not yet read", { createdAt: new Date() });
  expect((await write("post", "/read", { upTo: at.toISOString() })).status).toBe(200); expect(await Message.countDocuments({ readBy: owner._id })).toBe(1);
  expect((await write("post", "/read", { upTo: "invalid" })).status).toBe(400);
  for (const query of [{ cursor: "../../private" }, { limit: "100000" }, { cursor: "e30", messageId: "f".repeat(24) }]) expect((await read(query)).status).toBe(400);
});

test.each(["attorney", "paralegal"])("existing %s edits and reactions retain funded access and deny unfunded Matters", async role => {
  const user = role === "attorney" ? owner : para;
  const msg = await seed("Existing client message", { senderId: user._id, senderRole: user.role });
  const legacy = (method, suffix, body) => request(app)[method](`/api/messages/${matter._id}/${msg._id}${suffix}`).set("Cookie", cookie(user)).send(body);
  expect((await legacy("patch", "", { content: "Updated by existing client" })).status).toBe(200);
  expect((await legacy("post", "/react", { emoji: "👍" })).status).toBe(201);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { escrowStatus: "unfunded" } });
  expect((await legacy("patch", "", { content: "Not authorized" })).status).toBe(403);
  expect(decryptMessagePayload(await Message.findById(msg._id)).text).toBe("Updated by existing client");
});
test("a known request ID cannot silently change its recorded text and oversized text is rejected", async () => {
  const clientMessageId = "attorney-exact-request-0001";
  expect((await write("post", "", { text: "Original", clientMessageId })).status).toBe(201);
  expect((await write("post", "", { text: "Different", clientMessageId })).status).toBe(409);
  expect((await write("post", "", { text: "x".repeat(2001), clientMessageId: "attorney-exact-request-0002" })).status).toBe(400);
  expect(await Message.countDocuments()).toBe(1);
});

test("revocation after initial authorization prevents a late message from being recorded", async () => {
  const original = account.read; let calls = 0;
  jest.spyOn(account, "read").mockImplementation(async (...args) => { if (++calls === 2) await User.collection.updateOne({ _id: owner._id }, { $set: { disabled: true } }); return original(...args); });
  const response = await write("post", "", { text: "Do not record after revocation", clientMessageId: "revoked-request-0001" });
  expect(response.status).toBe(403); expect(await Message.countDocuments()).toBe(0);
});
test("paging uses an initialized Matter/date/id index", async () => {
  const indexes = await Message.collection.indexes(); expect(indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ caseId: 1, createdAt: -1, _id: -1 }))).toBe(true);
});
