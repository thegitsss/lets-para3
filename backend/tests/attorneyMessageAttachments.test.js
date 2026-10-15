process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_message_attachments";
process.env.S3_BUCKET = "synthetic-message-attachments";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockStorage = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockStorage }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const { Readable } = require("node:stream"), mongoose = require("mongoose");
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const User = require("../models/User"), Case = require("../models/Case"), Message = require("../models/Message"), CaseFile = require("../models/CaseFile");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/messages", require("../routes/messages"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, para, other, matter, message;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => { jest.restoreAllMocks(); process.env.S3_MALWARE_SCAN_REQUIRED = "false"; });
beforeEach(async () => {
  await clearDatabase(); await Promise.all([User.init(), Case.init(), Message.init(), CaseFile.init()]);
  mockStorage.mockReset(); mockStorage.mockImplementation(async () => ({ Body: Readable.from(["EXACT_MESSAGE_CONTENTS"]), ContentLength: 22 }));
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@attachment.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Lease correspondence", details: "Review the exhibits.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_messages", totalAmount: 40000 });
  message = await Message.create({ caseId: matter._id, senderId: para._id, senderRole: "paralegal", type: "file", fileKey: `cases/${matter._id}/documents/original.txt`, fileName: "Original exhibit.txt", mimeType: "text/plain", fileSize: 22, text: "Original exhibit" });
});
const read = (user = owner) => request(app).get(`/api/messages/${matter._id}`).query({ expectedOwnerId: String(user._id) }).set("Cookie", cookie(user));
const download = (revision, query = {}, user = owner, messageId = message._id) => request(app).get(`/api/cases/${matter._id}/message-attachments/${messageId}`).query({ expectedOwnerId: String(user._id), revision, ...query }).set("Cookie", cookie(user));
const reviewed = async () => { const result = await read(); expect(result.status).toBe(200); return result.body.messages[0]; };
test("message downloads use the exact recorded object, no-store attachment headers and no storage URL in the DTO", async () => {
  const selected = await reviewed(); expect(selected.hasAttachment).toBe(true); expect(selected.audioMimeType).toBeNull(); expect(JSON.stringify(selected)).not.toMatch(/fileKey|cases\/|attachment\.test/);
  const result = await download(selected.revision); expect(result.status).toBe(200); expect(result.body.toString()).toBe("EXACT_MESSAGE_CONTENTS"); expect(result.headers["cache-control"]).toBe("private, no-store"); expect(result.headers["content-type"]).toMatch(/^application\/octet-stream/); expect(result.headers["content-disposition"]).toContain("Original%20exhibit.txt"); expect(result.headers["x-content-type-options"]).toBe("nosniff"); expect(mockStorage.mock.calls[0][0].input.Key).toBe(`cases/${matter._id}/documents/original.txt`);
});
test("a replaced document does not redirect earlier message contents or rewrite its current scan metadata", async () => {
  const file = await CaseFile.create({ caseId: matter._id, userId: owner._id, originalName: "Replacement.txt", storageKey: `cases/${matter._id}/documents/new.txt`, mimeType: "text/plain", version: 2, uploadedByRole: "attorney", securityStatus: "pending", history: [{ storageKey: `cases/${matter._id}/documents/original.txt`, replacedAt: new Date() }] });
  const before = await CaseFile.collection.findOne({ _id: file._id }); const result = await download((await reviewed()).revision); expect(result.status).toBe(200);
  expect(mockStorage.mock.calls[0][0].input.Key).toBe(`cases/${matter._id}/documents/original.txt`); expect(await CaseFile.collection.findOne({ _id: file._id })).toEqual(before);
});
test.each(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"])("recorded %s audio has a protected same-origin inline response and a separate download", async mimeType => {
  await Message.collection.updateOne({ _id: message._id }, { $set: { type: "audio", mimeType, transcript: "Review exhibit four." } });
  const selected = await reviewed(); expect(selected.audioMimeType).toBe(mimeType); expect(selected.transcript).toBe("Review exhibit four.");
  const play = await download(selected.revision, { play: "true" }); expect(play.status).toBe(200); expect(play.headers["content-type"]).toBe(mimeType); expect(play.headers["content-disposition"]).toMatch(/^inline/); expect((await download(selected.revision)).headers["content-type"]).toMatch(/^application\/octet-stream/);
});
test("unrecorded or unsafe audio MIME never becomes executable inline content", async () => {
  for (const mimeType of ["text/html", "image/svg+xml", "audio/not-a-format", ""]) {
    await Message.collection.updateOne({ _id: message._id }, { $set: { type: "audio", mimeType } }); const selected = await reviewed(); expect(selected.audioMimeType).toBeNull(); expect((await download(selected.revision, { play: "true" })).status).toBe(400);
  }
  expect(mockStorage).not.toHaveBeenCalled();
});
test.each([{ deleted: true }, { mimeType: "audio/wav" }, { fileSize: 40 }, { fileKey: "another-key" }])("a changed message %j invalidates the reviewed attachment", async patch => {
  const selected = await reviewed(); await Message.collection.updateOne({ _id: message._id }, { $set: patch }); expect([404, 409]).toContain((await download(selected.revision)).status); expect(mockStorage).not.toHaveBeenCalled();
});
test.each(["THREATS_FOUND", "FAILED", ""])("current object scan %s blocks attachment delivery", async tag => {
  process.env.S3_MALWARE_SCAN_REQUIRED = "true"; mockStorage.mockResolvedValue({ TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: tag }] });
  const result = await download((await reviewed()).revision); expect(result.status).toBe(tag === "THREATS_FOUND" ? 422 : tag === "FAILED" ? 503 : 423); expect(mockStorage).toHaveBeenCalledTimes(1); expect(mockStorage.mock.calls[0][0].constructor.name).toBe("GetObjectTaggingCommand");
});
test.each(["account", "message", "matter"])("a late %s change prevents private bytes from reaching the browser", async kind => {
  const selected = await reviewed(); mockStorage.mockImplementation(async () => {
    if (kind === "account") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } });
    if (kind === "message") await Message.collection.updateOne({ _id: message._id }, { $set: { deleted: true } });
    if (kind === "matter") await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "completed" } });
    return { Body: Readable.from(["PRIVATE_LATE_ATTACHMENT"]), ContentLength: 23 };
  }); const result = await download(selected.revision); expect([403, 404]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("PRIVATE_LATE_ATTACHMENT");
});
test("wrong owner, role, alias disagreement and changed account cannot download", async () => {
  const selected = await reviewed(); expect((await download(selected.revision, {}, other)).status).toBe(404); expect((await download(selected.revision, {}, para)).status).toBe(403); expect((await download(selected.revision, { expectedOwnerId: String(other._id) })).status).toBe(403);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorneyId: other._id } });
  const before = await Case.collection.findOne({ _id: matter._id }), rejected = await download(selected.revision);
  expect({ status: rejected.status, body: rejected.body }).toEqual({ status: 409, body: { code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." } });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect(mockStorage).not.toHaveBeenCalled();
});
test.each(["paused", "completed", "disputed"])("%s attachments retain the existing active-conversation boundary", async status => {
  const selected = await reviewed(); await Case.collection.updateOne({ _id: matter._id }, { $set: { status } }); expect((await download(selected.revision)).status).toBe(403); expect(mockStorage).not.toHaveBeenCalled();
});
test("missing, malformed, foreign and arbitrary URL references never reach storage", async () => {
  for (const fileKey of [null, "https://outside.test/file", `cases/${other._id}/documents/foreign`, `cases/${matter._id}/documents/../private`, `cases/${matter._id}/documents/bad\\file`]) {
    await Message.collection.updateOne({ _id: message._id }, { $set: { fileKey } }); const selected = await reviewed(); expect(selected.hasAttachment).toBe(false); expect((await download(selected.revision)).status).toBe(404);
  }
  expect(mockStorage).not.toHaveBeenCalled(); expect((await download("bad")).status).toBe(400); expect((await download("a".repeat(64), {}, owner, new mongoose.Types.ObjectId())).status).toBe(404);
});
