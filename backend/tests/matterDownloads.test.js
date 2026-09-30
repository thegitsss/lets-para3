const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Readable } = require("stream"), { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
process.env.S3_BUCKET = "synthetic-downloads";
process.env.S3_MALWARE_SCAN_REQUIRED = "true";
const mockSend = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockSend }) }));
jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn(async () => "https://synthetic-storage.test/recorded-file") }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/stripe", () => ({}));
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), User = require("../models/User"), AuditLog = require("../models/AuditLog");
const { revision } = require("../services/matterDownloads");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const bytes = Buffer.from("Synthetic file bytes\n");
let owner, other, para, admin, matter, file, tag;
const get = (suffix = "", actor = owner, query = {}) => request(app).get(`/api/cases/${matter._id}/downloads${suffix}`).query({ expectedOwnerId: String(actor._id), ...query }).set("Cookie", authCookieFor(actor));
const list = async () => { const res = await get(); expect(res.status).toBe(200); return res.body; };
const download = async (record = file, actor = owner, overrides = {}) => get(`/${record._id}`, actor, { revision: revision(await CaseFile.collection.findOne({ _id: record._id })), ...overrides }).buffer(true);
const set = fields => Case.collection.updateOne({ _id: matter._id }, { $set: fields });
const storage = async command => command.constructor.name === "GetObjectTaggingCommand" ? { TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: tag }] } : { Body: Readable.from([bytes]), ContentLength: bytes.length };
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); mockSend.mockReset(); tag = "NO_THREATS_FOUND"; mockSend.mockImplementation(storage);
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@downloads.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Synthetic file Matter", details: "Public scope", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, practiceArea: "contract law", internalNotes: { text: "PRIVATE_NOTE" } });
  file = await CaseFile.create({ caseId: matter._id, userId: owner._id, originalName: "Agreement — draft.txt", storageKey: `cases/${matter._id}/documents/synthetic.txt`, mimeType: "text/plain", size: 999, securityStatus: "pending", revisionNotes: "PRIVATE_REVISION_NOTE" });
});

test("fresh owner-only pages expose explicit file metadata without storage keys, user identities or read-side writes", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), beforeFile = await CaseFile.collection.findOne({ _id: file._id });
  const res = await get(); expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toMatchObject({ caseId: String(matter._id), ownerId: String(owner._id), access: "available", files: [{ id: String(file._id), name: "Agreement — draft.txt", size: 999, version: 1, securityStatus: "pending" }], nextCursor: null });
  expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE_|storageKey|documents\/|userId|email|previewKey/);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before); expect(await CaseFile.collection.findOne({ _id: file._id })).toEqual(beforeFile); expect(mockSend).not.toHaveBeenCalled();
});
test("other attorneys, applicants, participants and admins cannot use attorney file downloads", async () => {
  await set({ paralegal: para._id, paralegalId: para._id, applicants: [{ paralegalId: other._id }] });
  for (const actor of [other, para, admin]) { expect([403, 404]).toContain((await get("", actor)).status); expect([403, 404]).toContain((await download(file, actor)).status); }
  expect((await request(app).get(`/api/cases/${matter._id}/downloads`)).status).toBe(401);
  expect((await get("", owner, { expectedOwnerId: String(other._id) })).body.code).toBe("DOWNLOAD_ACCOUNT_CHANGED"); expect(mockSend).not.toHaveBeenCalled();
});
test("legacy text references and missing dates remain readable without normalization", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorneyId: String(owner._id), files: [{ key: "historical-key" }] }, $unset: { attorney: "" } });
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { caseId: String(matter._id) }, $unset: { createdAt: "", version: "", size: "", securityStatus: "" } });
  const before = await CaseFile.collection.findOne({ _id: file._id }), result = await list();
  expect(result.legacyAttachments).toBe(true); expect(result.files[0]).toMatchObject({ uploadedAt: null, version: null, size: null, securityStatus: "unknown" }); expect(await CaseFile.collection.findOne({ _id: file._id })).toEqual(before);
  expect((await download()).status).toBe(200);
});
test("contradictory owner aliases are unavailable without exposing file names", async () => {
  await set({ attorneyId: other._id }); const result = await get(); expect(result.status).toBe(409); expect(result.body.code).toBe("CASE_IDENTITY_CONFLICT"); expect(JSON.stringify(result.body)).not.toContain("Agreement"); expect(mockSend).not.toHaveBeenCalled();
});
test.each([{ status: "completed" }, { status: "closed" }, { status: "disputed" }, { paymentReleased: true }, { purgedAt: new Date() }, { status: "unknown_old_state" }])("closed, purged and unknown lifecycle evidence blocks individual files: %j", async fields => {
  await set(fields); const result = await list(); expect(result.access).not.toBe("available"); expect(result.files).toEqual([]); expect((await download()).status).toBe(403); expect(mockSend).not.toHaveBeenCalled();
});
test.each([{ archived: true }, { status: "paused" }, { status: "in progress", readOnly: true }])("existing owner signed-file access remains available without a lifecycle transition: %j", async fields => {
  await set(fields); expect((await list()).access).toBe("available"); expect((await download()).status).toBe(200); for (const [key, value] of Object.entries(fields)) expect((await Case.collection.findOne({ _id: matter._id }))[key]).toEqual(value);
});
test("file pagination covers more than fifty records without overlap, includes legacy case references and rejects invalid cursors", async () => {
  const records = Array.from({ length: 54 }, (_, index) => ({ _id: new Types.ObjectId(), caseId: index % 2 ? matter._id : String(matter._id), originalName: `File ${index}`, storageKey: `cases/${matter._id}/documents/${index}`, size: index }));
  await CaseFile.collection.insertMany(records);
  const first = await list(); expect(first.files).toHaveLength(50); expect(first.nextCursor).toBe(first.files.at(-1).id);
  const second = await get("", owner, { cursor: first.nextCursor }); expect(second.status).toBe(200); expect(second.body.files).toHaveLength(5); expect(second.body.nextCursor).toBeNull(); expect(new Set([...first.files, ...second.body.files].map(entry => entry.id)).size).toBe(55);
  expect((await get("", owner, { cursor: "invalid" })).status).toBe(400);
});
test("a reviewed download streams exact bytes with attachment headers and retains the Case and unknown file fields", async () => {
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { futureField: { preserve: true } } }); const before = await Case.collection.findOne({ _id: matter._id });
  const result = await download(); expect(result.status).toBe(200); expect(result.body).toEqual(bytes); expect(result.headers["content-length"]).toBe(String(bytes.length)); expect(result.headers["content-type"]).toBe("application/octet-stream"); expect(result.headers["x-content-type-options"]).toBe("nosniff"); expect(result.headers["content-disposition"]).toContain("filename*=UTF-8''Agreement%20");
  const after = await Case.collection.findOne({ _id: matter._id }); expect(after).toEqual({ ...before, __v: Number(before.__v || 0) + 1, updatedAt: after.updatedAt }); expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime()); expect(await CaseFile.collection.findOne({ _id: file._id })).toMatchObject({ securityStatus: "clean", futureField: { preserve: true } });
  expect(mockSend.mock.calls.map(([cmd]) => cmd.constructor.name)).toEqual(["GetObjectTaggingCommand", "GetObjectCommand"]);
  await new Promise(resolve => setImmediate(resolve)); expect(await AuditLog.countDocuments({ action: "file_downloaded" })).toBe(1);
});
test("a changed file revision, malformed request and another Matter's file cannot trigger storage access", async () => {
  const original = (await list()).files[0]; await CaseFile.updateOne({ _id: file._id }, { $set: { originalName: "A newer file.txt" } });
  expect((await get(`/${file._id}`, owner, { revision: original.revision })).status).toBe(409);
  expect((await get(`/${file._id}`, owner, { revision: "bad" })).status).toBe(400);
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { caseId: new Types.ObjectId() } }); expect((await download()).status).toBe(404); expect(mockSend).not.toHaveBeenCalled();
});
test.each([["THREATS_FOUND", 422, "DOWNLOAD_BLOCKED"], ["PENDING", 423, "DOWNLOAD_SCAN_PENDING"], ["FAILED", 503, "DOWNLOAD_SCAN_ERROR"]])("fresh security result %s prevents a binary download", async (scan, status, code) => {
  tag = scan; const result = await download(); expect(result.status).toBe(status); expect(result.body.code).toBe(code); expect(mockSend.mock.calls.some(([cmd]) => cmd.constructor.name === "GetObjectCommand")).toBe(false);
});
test("malformed stored keys cannot sign or fetch another object's data", async () => {
  await CaseFile.updateOne({ _id: file._id }, { $set: { storageKey: "cases/foreign/documents/secret" } }); expect((await download()).status).toBe(409); expect(mockSend).not.toHaveBeenCalled();
});
test("missing objects and storage failures return errors rather than apparent file content", async () => {
  for (const failure of [Object.assign(new Error("missing"), { name: "NoSuchKey" }), new Error("unavailable")]) {
    mockSend.mockImplementation(async command => { if (command.constructor.name === "GetObjectCommand") throw failure; return storage(command); });
    const result = await download(); expect(result.status).toBe(failure.name === "NoSuchKey" ? 404 : 503); expect(result.headers["content-type"]).toContain("application/json");
  }
});
test("an ownership transfer during listing prevents the old owner from seeing the names", async () => {
  const find = CaseFile.collection.find.bind(CaseFile.collection);
  jest.spyOn(CaseFile.collection, "find").mockImplementationOnce((...args) => { const cursor = find(...args), toArray = cursor.toArray.bind(cursor); cursor.toArray = async () => { const rows = await toArray(); await set({ attorney: other._id, attorneyId: other._id }); return rows; }; return cursor; });
  const result = await get(); expect(result.status).toBe(404); expect(JSON.stringify(result.body)).not.toContain("Agreement");
});
test.each(["ownership", "completion", "replacement", "deletion"])("a %s change during storage access cancels the file stream", async change => {
  let stream;
  mockSend.mockImplementation(async command => {
    if (command.constructor.name !== "GetObjectCommand") return storage(command);
    if (change === "ownership") await set({ attorney: other._id, attorneyId: other._id });
    if (change === "completion") await set({ paymentReleased: true });
    if (change === "replacement") await CaseFile.updateOne({ _id: file._id }, { $set: { storageKey: `cases/${matter._id}/documents/new-file.txt`, version: 2 } });
    if (change === "deletion") await CaseFile.deleteOne({ _id: file._id });
    stream = Readable.from([bytes]); return { Body: stream, ContentLength: bytes.length };
  });
  const result = await download(); expect([403, 404, 409]).toContain(result.status); expect(stream.destroyed).toBe(true); expect(result.headers["content-type"]).toContain("application/json");
});
test("a lifecycle change during scanning prevents even the object fetch", async () => {
  mockSend.mockImplementation(async command => { await set({ status: "completed" }); return storage(command); });
  expect((await download()).status).toBe(403); expect(mockSend).toHaveBeenCalledTimes(1);
});
test("a broken stream fails the request and never records a completed download", async () => {
  mockSend.mockImplementation(async command => command.constructor.name === "GetObjectCommand" ? { Body: new Readable({ read() { this.destroy(new Error("Synthetic stream interruption")); } }) } : storage(command));
  await expect(download()).rejects.toThrow(); await new Promise(resolve => setImmediate(resolve)); expect(await AuditLog.countDocuments({ action: "file_downloaded" })).toBe(0);
});

test("a scan of a replaced object cannot mark the replacement clean", async () => {
  mockSend.mockImplementation(async command => {
    if (command.constructor.name === "GetObjectTaggingCommand") await CaseFile.collection.updateOne({ _id: file._id }, { $set: { storageKey: `cases/${matter._id}/documents/replacement.txt`, version: 2, securityStatus: "pending" } });
    return storage(command);
  });
  expect((await download()).status).toBe(409); const current = await CaseFile.collection.findOne({ _id: file._id }); expect(current.version).toBe(2); expect(current.securityStatus).toBe("pending"); expect(mockSend).toHaveBeenCalledTimes(1);
});
test("account revocation during the storage read prevents bytes reaching the browser", async () => {
  mockSend.mockImplementation(async command => {
    if (command.constructor.name === "GetObjectCommand") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return storage(command);
  });
  expect((await download()).status).toBe(403);
});

test("PDF preview retains byte and account guards with an inline PDF response and a distinct audit action", async () => {
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { mimeType: "application/pdf", originalName: "Agreement.pdf" } });
  const response = await download(file, owner, { preview: "true" }); expect(response.status).toBe(200); expect(response.headers["content-type"]).toBe("application/pdf"); expect(response.headers["content-disposition"]).toMatch(/^inline;/); expect(response.headers["x-content-type-options"]).toBe("nosniff");
  await new Promise(resolve => setImmediate(resolve)); expect(await AuditLog.countDocuments({ action: "file_viewed" })).toBe(1); expect(await AuditLog.countDocuments({ action: "file_downloaded" })).toBe(0);
});
test("HTML and other non-PDF types cannot be framed through the PDF preview option", async () => {
  for (const mimeType of ["text/html", "image/svg+xml", "text/plain"]) { await CaseFile.collection.updateOne({ _id: file._id }, { $set: { mimeType } }); expect((await download(file, owner, { preview: "true" })).status).toBe(400); }
  expect(mockSend).not.toHaveBeenCalled();
});

test("earlier files without a stored version retain the existing signed-file read contract", async () => {
  await CaseFile.collection.updateOne({ _id: file._id }, { $unset: { version: "" } });
  const response = await request(app).get(`/api/cases/${matter._id}/files/signed-get`).query({ key: `cases/${matter._id}/documents/synthetic.txt` }).set("Cookie", authCookieFor(owner));
  expect(response.status).toBe(200); expect(response.body.url).toBe("https://synthetic-storage.test/recorded-file"); const stored = await CaseFile.collection.findOne({ _id: file._id }); expect(stored.version).toBeUndefined(); expect(stored.securityStatus).toBe("clean");
});
