process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_earlier_files"; process.env.S3_BUCKET = "synthetic-earlier-files"; process.env.S3_MALWARE_SCAN_REQUIRED = "true";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), { Readable } = require("stream");
const mockStorage = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockStorage }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Removal = require("../models/MatterFileRemoval"), AuditLog = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db"), { encryptString } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, para, other, matter, scan;
const bytes = Buffer.from("Earlier lease exhibits\n");
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), CaseFile.init(), Removal.init(), AuditLog.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => { await clearDatabase(); mockStorage.mockReset(); scan = "NO_THREATS_FOUND"; mockStorage.mockImplementation(async command => command.constructor.name === "GetObjectTaggingCommand" ? { TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: scan }] } : { Body: Readable.from([bytes]), ContentLength: bytes.length });
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@earlier-files.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "River Street lease", details: "Review lease exhibits.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_earlier", totalAmount: 100000 });
  await change({ files: [{ _id: new mongoose.Types.ObjectId(), key: key("original.txt"), original: "Earlier lease.txt", size: 22, version: 1, createdAt: new Date("2026-01-02"), privateEvidence: "PRESERVE" }] });
});
const key = name => `cases/${matter._id}/${name}`;
const change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });
const list = (query = {}, actor = owner) => request(app).get(`/api/cases/${matter._id}/earlier-files`).set("Cookie", cookie(actor)).query({ expectedOwnerId: String(actor._id), ...query });
const listed = async () => { const response = await list(); expect(response.status).toBe(200); return response.body; };
const download = (entry, query = {}, actor = owner) => request(app).get(`/api/cases/${matter._id}/earlier-files/${entry.id}/download`).set("Cookie", cookie(actor)).query({ expectedOwnerId: String(actor._id), revision: entry.revision, ...query }).buffer(true);
test("earlier attachments expose only exact legal-file metadata and return their actual bytes", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), response = await list(); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store"); expect(response.body.entries[0]).toMatchObject({ name: "Earlier lease.txt", kind: "earlier_attachment", recordedAt: "2026-01-02T00:00:00.000Z", size: 22, version: 1, available: true }); expect(JSON.stringify(response.body)).not.toMatch(/storageKey|cases\/|PRESERVE|privateEvidence|snapshot|original\.txt/); expect(mockStorage).not.toHaveBeenCalled();
  const result = await download(response.body.entries[0]); expect(result.status).toBe(200); expect(result.body.equals(bytes)).toBe(true); expect(result.headers["content-type"]).toMatch(/^application\/octet-stream/); expect(result.headers["content-disposition"]).toMatch(/^attachment/); expect(mockStorage.mock.calls.at(-1)[0].input.Key).toBe(key("original.txt")); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test("more than fifty references page without omissions and exact older links are independently selectable", async () => {
  await change({ files: Array.from({ length: 65 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), key: key(`older-${index}.txt`), original: `Earlier exhibit ${index}.txt`, createdAt: new Date(1700000000000 + index * 1000) })) });
  const first = await listed(); expect(first.entries).toHaveLength(50); expect(first.total).toBe(65); const second = await list({ cursor: first.nextCursor, revision: first.revision }); expect(second.status).toBe(200); expect(second.body.entries).toHaveLength(15); expect(new Set([...first.entries, ...second.body.entries].map(row => row.id)).size).toBe(65); expect(second.body.nextCursor).toBeNull(); const selected = second.body.entries.at(-1); expect((await list({ referenceId: selected.id })).body.selected.id).toBe(selected.id); expect((await list({ cursor: "50" })).status).toBe(400);
});
test("reordering old arrays keeps reference identity while invalidating previously reviewed download revisions", async () => {
  const before = await listed(), raw = await Case.collection.findOne({ _id: matter._id }); await change({ files: [{ key: key("new-front.txt"), original: "New reference.txt" }, ...raw.files] });
  const current = await listed(); expect(current.entries.find(entry => entry.name === "Earlier lease.txt").id).toBe(before.entries[0].id); expect((await download(before.entries[0])).status).toBe(409); expect((await list({ referenceId: before.entries[0].id })).body.selected.name).toBe("Earlier lease.txt"); expect(mockStorage).not.toHaveBeenCalled();
});
test("new-format mirrors remain in current Files while root-format CaseFile contents and history are downloadable", async () => {
  const rootFile = await CaseFile.create({ caseId: matter._id, userId: owner._id, originalName: "Original matter record.txt", storageKey: key("root-format.txt"), mimeType: "text/plain", size: 5, history: [{ storageKey: key("root-prior.txt") }], securityStatus: "not_required" });
  const newKey = key("documents/current.txt"); await CaseFile.create({ caseId: matter._id, userId: para._id, originalName: "Current.txt", storageKey: newKey, history: [{ storageKey: key("documents/current-prior.txt") }], securityStatus: "not_required" });
  await change({ files: [{ key: newKey, original: "Current mirror.txt", history: [{ key: key("documents/current-prior.txt") }] }, { key: key("root-format.txt"), original: "Root mirror.txt" }] });
  const current = await listed(); expect(current.entries).toHaveLength(2); const old = current.entries.find(entry => entry.kind === "earlier_version"); expect(old).toMatchObject({ name: "Original matter record.txt", size: null, version: null }); expect((await download(old)).status).toBe(200); expect(mockStorage.mock.calls.at(-1)[0].input.Key).toBe(key("root-prior.txt")); expect(await CaseFile.findById(rootFile._id)).toBeTruthy();
});
test("removed document history is retained without restoring the removed current copy or exposing private removal metadata", async () => {
  await Removal.collection.insertOne({ _id: new mongoose.Types.ObjectId(), caseId: matter._id, ownerId: owner._id, requestId: "PRIVATE_REQUEST", snapshot: { originalName: encryptString("Removed lease.txt"), storageKey: encryptString(key("documents/removed-current.txt")), history: [{ storageKey: encryptString(key("documents/retained-prior.txt")), replacedAt: new Date("2026-01-04") }], privateNote: "PRIVATE_SNAPSHOT" }, removedMirrors: [{ original: "Mirror name.txt", key: key("documents/removed-current.txt"), history: [{ key: key("documents/mirror-prior.txt") }] }] });
  const result = await listed(), history = result.entries.filter(entry => entry.kind === "removed_document_history"); expect(history).toHaveLength(2); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|removed-current|retained-prior|mirror-prior|snapshot|removedMirrors/); expect(history.every(entry => entry.size === null && entry.version === null)).toBe(true); expect((await download(history[0])).status).toBe(200);
});
test.each(["cases/other/secret.txt", "cases/CASE/../escape.txt", "cases/CASE/previews/render.pdf", "https://outside.invalid/cases/CASE/other.txt", "cases/CASE/a%2fb.txt"])("unverified reference %s remains visible as unavailable and never reaches storage", async storedKey => {
  await change({ files: [{ key: storedKey.replaceAll("CASE", String(matter._id)), original: "Reference needs review.txt" }] }); const current = await listed(); expect(current.entries[0].available).toBe(false); expect((await download(current.entries[0])).status).toBe(409); expect(mockStorage).not.toHaveBeenCalled();
});
test("platform receipts and archive references stay with their existing controls while a legal document named receipt remains accessible", async () => {
  await change({ archiveZipKey: key("custom-archive.bin"), files: ["receipt-attorney-v2.pdf", "receipt-withdrawal-1788566400000.pdf", "archive-old.zip", "custom-archive.bin", "documents/receipt-of-service.pdf"].map(name => ({ key: key(name), original: name })) }); const current = await listed(); expect(current.entries).toHaveLength(1); expect(current.entries[0].name).toBe("documents/receipt-of-service.pdf"); expect(current.entries[0].available).toBe(true);
});
test.each([{ status: "completed" }, { status: "disputed" }, { paymentReleased: true }, { purgedAt: new Date() }])("restriction %j closes both retained lists and individual downloads", async patch => {
  const before = await listed(); await change(patch); const after = await listed(); expect(after.entries).toEqual([]); expect(after.total).toBe(0); expect(after.selected).toBeNull(); expect((await download(before.entries[0])).status).toBe(403); expect(mockStorage).not.toHaveBeenCalled();
});
test("fresh account, participant role, contradictory ownership and malformed queries are denied", async () => {
  const first = await listed(); for (const actor of [para, other]) expect([403, 404]).toContain((await list({}, actor)).status);
  expect((await list({ expectedOwnerId: String(other._id) })).status).toBe(403); expect((await list({ cursor: "-1" })).status).toBe(400); expect((await download(first.entries[0], { preview: "true" })).status).toBe(400);
  await change({ attorneyId: other._id });
  const before = await Case.collection.findOne({ _id: matter._id }), conflict = await list();
  expect(conflict.status).toBe(409);
  expect(conflict.body).toEqual({ code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  await change({ attorneyId: owner._id }); await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); expect((await list()).status).toBe(403); expect(mockStorage).not.toHaveBeenCalled();
});
test.each([["THREATS_FOUND", 422], ["FAILED", 503], ["", 423]])("current object scan %s controls historical byte access", async (value, status) => { const current = await listed(); scan = value; expect((await download(current.entries[0])).status).toBe(status); expect(mockStorage).toHaveBeenCalledTimes(1); });
test.each(["account", "reference"])("a changed %s while storage responds prevents the earlier bytes from being returned", async mode => {
  const current = await listed(), original = mockStorage.getMockImplementation(); mockStorage.mockImplementation(async command => { if (command.constructor.name === "GetObjectCommand") { if (mode === "account") await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); else await change({ files: [{ key: key("changed.txt"), original: "Changed.txt" }] }); } return original(command); });
  const result = await download(current.entries[0]); expect(result.status).toBe(mode === "account" ? 403 : 404); expect(JSON.stringify(result.body)).not.toContain("Earlier lease exhibits");
});
test("missing storage and incomplete or over-limit inventories never become a successful empty history", async () => {
  const current = await listed(); mockStorage.mockRejectedValueOnce(Object.assign(new Error("Synthetic missing file"), { name: "NoSuchKey" })); expect((await download(current.entries[0])).status).toBe(404);
  await change({ files: [{ key: key("original.txt"), original: "Earlier.txt", history: { unrecognized: true } }] }); expect((await list()).status).toBe(409);
  await change({ files: Array.from({ length: 4001 }, (_, index) => ({ key: key(`reference-${index}.txt`) })) }); expect((await list()).status).toBe(413);
});
