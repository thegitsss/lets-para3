process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_retained_conversation";
process.env.S3_BUCKET = "synthetic-retained-conversation";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockStorage = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockStorage }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const { Readable } = require("node:stream"), mongoose = require("mongoose"), express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const User = require("../models/User"), Case = require("../models/Case"), Message = require("../models/Message");
const { encryptString } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/messages", require("../routes/messages"));
let owner, para, other, caseId, messageId;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${caseId}/retained-messages`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const download = (revision, query = {}) => request(app).get(`/api/cases/${caseId}/message-attachments/${messageId}`).query({ expectedOwnerId: String(owner._id), revision, retained: "true", ...query }).set("Cookie", cookie(owner));
const change = patch => Case.collection.updateOne({ _id: caseId }, { $set: patch });
const key = name => `cases/${caseId}/documents/${name}`;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => { jest.restoreAllMocks(); process.env.S3_MALWARE_SCAN_REQUIRED = "false"; });
beforeEach(async () => {
  await clearDatabase(); mockStorage.mockReset(); mockStorage.mockImplementation(async () => ({ Body: Readable.from(["RETAINED_BYTES"]), ContentLength: 14 }));
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@retained.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  caseId = new mongoose.Types.ObjectId(); messageId = new mongoose.Types.ObjectId();
  await Case.collection.insertOne({ _id: caseId, attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, title: "Retained lease correspondence", status: "completed", completedAt: new Date(), readOnly: true, tasks: [], unknownLegalMetadata: "PRESERVE" });
  await Message.collection.insertOne({ _id: messageId, caseId, senderId: para._id, senderRole: "paralegal", type: "text", content: { text: encryptString("Original correspondence"), fileKey: encryptString(key("original.txt")), fileName: encryptString("Original.txt"), files: [{ storageKey: key("exhibit.txt"), originalName: "Exhibit.txt" }, { key: "https://outside.test/private", name: "Unverified reference" }] }, createdAt: new Date("2026-01-02"), reactions: { "👍": [owner._id] }, readBy: [], unknownMessageMetadata: "PRESERVE", clientMessageId: "private-request-identifier" });
});
test("retained reads use archive authority without requiring a generated ZIP and make no record changes", async () => {
  const beforeCase = await Case.collection.findOne({ _id: caseId }), beforeMessage = await Message.collection.findOne({ _id: messageId });
  const result = await read(); expect(result.status).toBe(200); expect(result.headers["cache-control"]).toContain("no-store"); expect(result.body).toMatchObject({ caseId: String(caseId), writable: false, retained: true, targetMissing: false, nextCursor: null });
  expect(result.body.messages[0]).toMatchObject({ text: "Original correspondence", senderId: { firstName: "Synthetic", lastName: "para" }, attachments: [{ id: "primary", filename: "Original.txt", hasAttachment: true }, { id: "file-0", filename: "Exhibit.txt", hasAttachment: true }, { id: "file-1", filename: "Unverified reference", hasAttachment: false }] });
  expect(JSON.stringify(result.body)).not.toMatch(/fileKey|storageKey|outside.test|private-request|unknownMessage|unknownLegal|retained.test/);
  expect(await Case.collection.findOne({ _id: caseId })).toEqual(beforeCase); expect(await Message.collection.findOne({ _id: messageId })).toEqual(beforeMessage); expect(mockStorage).not.toHaveBeenCalled();
  expect((await request(app).get(`/api/messages/${caseId}`).query({ expectedOwnerId: String(owner._id) }).set("Cookie", cookie(owner))).status).toBe(403);
});
test("225 dated messages and undated earlier records remain bounded, unique and reachable with exact links", async () => {
  await Message.deleteMany({});
  const records = Array.from({ length: 237 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), caseId: index % 2 ? String(caseId) : caseId, senderId: index % 2 ? String(para._id) : para._id, type: index === 236 ? "system" : "text", text: `Retained ${index}`, ...(index < 225 ? { createdAt: index % 2 ? "2026-01-02T00:00:00.000Z" : new Date("2026-01-02") } : index === 225 ? { createdAt: "invalid" } : {}), reactions: {}, readBy: [] }));
  await Message.collection.insertMany(records); const seen = new Set(); let cursor;
  do { const result = await read(cursor ? { cursor } : {}); expect(result.status).toBe(200); expect(result.body.messages.length).toBeLessThanOrEqual(50); for (const row of result.body.messages) { expect(seen.has(row._id)).toBe(false); seen.add(row._id); } cursor = result.body.nextCursor; } while (cursor);
  expect(seen.size).toBe(237);
  for (const selected of [records[3], records[225], records[236]]) { const result = await read({ messageId: String(selected._id) }); expect(result.status).toBe(200); expect(result.body.messages.at(-1)._id).toBe(String(selected._id)); expect(result.body.messages.at(-1).createdAt).toBe(selected.createdAt === "invalid" || !selected.createdAt ? null : "2026-01-02T00:00:00.000Z"); }
  await Message.collection.updateOne({ _id: records[3]._id }, { $set: { deleted: true } }); expect((await read({ messageId: String(records[3]._id) })).body.targetMissing).toBe(true);
});
test.each([
  [{ status: "open", archived: true, readOnly: false, completedAt: null }, 200],
  [{ status: "paused", archived: true }, 200], [{ status: "disputed", archived: true }, 200],
  [{ status: "paused", archived: false }, 403], [{ status: "disputed", archived: false }, 403],
  [{ status: "in progress", readOnly: false, archived: false }, 403],
  [{ status: "completed", completedAt: null }, 403], [{ purgeScheduledFor: "invalid" }, 403],
  [{ purgedAt: new Date() }, 410], [{ purgeScheduledFor: new Date(0) }, 410], [{ completedAt: new Date(0) }, 410],
])("retained eligibility follows existing archive rules for %j", async (patch, status) => { await change(patch); expect((await read()).status).toBe(status); });
test("wrong account, role and contradictory aliases cannot read retained legal correspondence", async () => {
  expect((await read({}, other)).status).toBe(404); expect((await read({}, para)).status).toBe(403); expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403);
  await change({ attorney: String(owner._id), attorneyId: String(owner._id) }); expect((await read()).status).toBe(200);
  await change({ attorneyId: other._id });
  const beforeCase = await Case.collection.findOne({ _id: caseId }), beforeMessage = await Message.collection.findOne({ _id: messageId });
  const conflict = await read();
  // The shared participant guard rejects contradictory aliases before the
  // retained-reader permission check, using its existing no-data conflict.
  expect(conflict.status).toBe(409);
  expect(conflict.body).toEqual({ code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." });
  expect(conflict.headers["cache-control"]).toContain("no-store");
  expect(await Case.collection.findOne({ _id: caseId })).toEqual(beforeCase);
  expect(await Message.collection.findOne({ _id: messageId })).toEqual(beforeMessage);
});
test.each(["account", "retention", "message"])("a %s change during retained reads discards the response", async kind => {
  const find = User.collection.find.bind(User.collection);
  jest.spyOn(User.collection, "find").mockImplementationOnce((...args) => ({ toArray: async () => {
    if (kind === "account") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } });
    if (kind === "retention") await change({ purgeScheduledFor: new Date(0) });
    if (kind === "message") await Message.collection.updateOne({ _id: messageId }, { $set: { deleted: true } });
    return find(...args).toArray();
  } }));
  const result = await read(); expect([403, 409, 410]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("Original correspondence");
});
test("old attachment aliases retain their exact object and never redirect to an arbitrary stored URL", async () => {
  const selected = (await read()).body.messages[0];
  for (const [attachmentId, filename] of [["primary", "original.txt"], ["file-0", "exhibit.txt"]]) { const result = await download(selected.revision, { attachmentId }); expect(result.status).toBe(200); expect(result.body.toString()).toBe("RETAINED_BYTES"); expect(mockStorage.mock.calls.at(-1)[0].input.Key).toBe(key(filename)); }
  const calls = mockStorage.mock.calls.length; expect((await download(selected.revision, { attachmentId: "file-1" })).status).toBe(404); expect((await download(selected.revision, { attachmentId: "file-2" })).status).toBe(404); expect(mockStorage.mock.calls).toHaveLength(calls);
  await Message.collection.updateOne({ _id: messageId }, { $set: { "content.files.0.storageKey": key("changed.txt") } }); expect((await download(selected.revision, { attachmentId: "file-0" })).status).toBe(409);
});
test("retained audio and quarantine follow the same protected streaming policy", async () => {
  await Message.collection.updateOne({ _id: messageId }, { $set: { type: "audio", "content.mimeType": "audio/wav", "content.transcript": "Original audio transcript" } });
  const selected = (await read()).body.messages[0]; expect(selected.audioMimeType).toBe("audio/wav"); const result = await download(selected.revision, { play: "true" }); expect(result.status).toBe(200); expect(result.headers["content-type"]).toBe("audio/wav"); expect(result.headers["content-disposition"]).toMatch(/^inline/);
  process.env.S3_MALWARE_SCAN_REQUIRED = "true"; mockStorage.mockResolvedValue({ TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "THREATS_FOUND" }] }); expect((await download(selected.revision)).status).toBe(422);
});
test("an earlier array-only file message has no invented primary attachment", async () => {
  await Message.collection.updateOne({ _id: messageId }, { $set: { type: "file" }, $unset: { "content.fileKey": "", "content.fileName": "" } });
  const result = await read(); expect(result.status).toBe(200); expect(result.body.messages[0].attachments.map(item => item.id)).toEqual(["file-0", "file-1"]);
});
test.each(["retention", "owner", "message"])("a late %s change blocks retained attachment bytes", async kind => {
  const selected = (await read()).body.messages[0]; mockStorage.mockImplementation(async () => { if (kind === "retention") await change({ purgeScheduledFor: new Date(0) }); if (kind === "owner") await change({ attorney: other._id, attorneyId: other._id }); if (kind === "message") await Message.collection.updateOne({ _id: messageId }, { $set: { deleted: true } }); return { Body: Readable.from(["PRIVATE_LATE_CONTENTS"]), ContentLength: 21 }; });
  const result = await download(selected.revision); expect([403, 404, 410]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("PRIVATE_LATE_CONTENTS");
});
test("malformed links and unknown query fields fail explicitly", async () => {
  for (const query of [{ cursor: "bad" }, { messageId: "bad" }, { cursor: "x", messageId: String(messageId) }, { clientMessageId: "private-request-identifier" }]) expect((await read(query)).status).toBe(400);
});
