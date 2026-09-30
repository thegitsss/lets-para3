const express = require("express"), cookieParser = require("cookie-parser"), jwt = require("jsonwebtoken"), request = require("supertest");
const fs = require("fs/promises"), os = require("os"), path = require("path");
const { Types } = require("mongoose");
const User = require("../models/User"), Case = require("../models/Case"), Message = require("../models/Message"), CaseFile = require("../models/CaseFile");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/stripe", () => ({}));
jest.mock("../services/caseLifecycle", () => ({ buildArchiveZipFile: jest.fn() }));
const lifecycle = require("../services/caseLifecycle");
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use("/api/cases", require("../routes/cases"));
let attorney, other, paralegal, caseId, artifacts;
const bytes = Buffer.from("PK\x03\x04synthetic-route-stream");
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const url = suffix => `/api/cases/${caseId}/archive/${suffix}`;
const review = (user = attorney, expectedOwnerId = String(user._id)) => request(app).get(url("export")).query({ expectedOwnerId }).set("Cookie", cookie(user));
const download = (revision, user = attorney) => request(app).get(url("download")).query(revision === undefined ? {} : { revision, expectedOwnerId: String(user._id) }).set("Cookie", cookie(user)).buffer(true).parse((res, callback) => { const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const body = Buffer.concat(chunks); callback(null, res.headers["content-type"]?.includes("application/zip") ? body : JSON.parse(body.toString())); }); });
const change = fields => Case.collection.updateOne({ _id: caseId }, { $set: fields });
const raw = () => Case.collection.findOne({ _id: caseId });
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); artifacts = []; jest.clearAllMocks();
  [attorney, other, paralegal] = await User.create([
    { firstName: "Avery", lastName: "Lane", email: "archive-owner@example.test", password: "SyntheticPassword123!", role: "attorney", status: "approved" },
    { firstName: "Blair", lastName: "Other", email: "archive-other@example.test", password: "SyntheticPassword123!", role: "attorney", status: "approved" },
    { firstName: "Casey", lastName: "Payee", email: "archive-payee@example.test", password: "SyntheticPassword123!", role: "paralegal", status: "approved" },
  ]);
  caseId = new Types.ObjectId(); await Case.collection.insertOne({ _id: caseId, attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, title: "Receipt of service & agreement", status: "open", archived: true, tasks: [{ title: "Review agreement", completed: false }], internalNotes: "PRIVATE_NOTE", unknownField: "PRESERVE", archiveZipKey: `cases/${caseId}/archive-v2.zip` });
  lifecycle.buildArchiveZipFile.mockReset().mockImplementation(async (_doc, options) => {
    await options.validate();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lpc-export-route-test-")), file = path.join(directory, "archive.zip"); await fs.writeFile(file, bytes);
    let cleaned; const cleanupComplete = new Promise(resolve => { cleaned = resolve; });
    const artifact = { path: file, size: bytes.length, cleanupComplete, cleanup: jest.fn(async () => { await fs.rm(directory, { recursive: true, force: true }); cleaned(); }) }; artifacts.push(artifact); return artifact;
  });
});
afterEach(async () => { for (const artifact of artifacts) await artifact.cleanup(); });
test("review is projected and read-only; direct downloads prepare fresh bytes and remove only their own temporary files", async () => {
  const before = await raw(), response = await review(); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body).toMatchObject({ caseId: String(caseId), ownerId: String(attorney._id), access: "available", retentionEndsAt: null, counts: { messages: 0, documents: 0, priorVersions: 0, confidentialityDocuments: 0 } });
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_NOTE|unknownField|archive-v2|email/); expect(lifecycle.buildArchiveZipFile).not.toHaveBeenCalled();
  const result = await download(response.body.revision); expect(result.status).toBe(200); expect(result.body).toEqual(bytes); expect(result.headers["content-length"]).toBe(String(bytes.length)); expect(result.headers["content-disposition"]).toContain("Receipt%20of%20service"); expect(result.headers["x-content-type-options"]).toBe("nosniff");
  await artifacts[0].cleanupComplete; expect(artifacts[0].cleanup).toHaveBeenCalled(); expect(await raw()).toEqual(before);
});
test("anonymous, nonowners and paralegals cannot read an archive; admin compatibility remains", async () => {
  expect((await request(app).get(url("export"))).status).toBe(401); expect((await review(other)).status).toBe(404); expect((await review(paralegal)).status).toBe(403);
  expect((await review(attorney, String(other._id))).status).toBe(403);
  await User.collection.updateOne({ _id: other._id }, { $set: { role: "admin" } }); other.role = "admin"; expect((await download(undefined, other)).status).toBe(200);
});
test.each([{ disabled: true }, { deleted: true }, { status: "pending" }, { authVersion: 1 }])("account restrictions deny archive access: %j", async fields => { await User.collection.updateOne({ _id: attorney._id }, { $set: fields }); expect((await review()).status).toBe(403); expect(lifecycle.buildArchiveZipFile).not.toHaveBeenCalled(); });
test("historical string owners remain readable and contradictory aliases are rejected", async () => {
  await change({ attorney: String(attorney._id), attorneyId: String(attorney._id) }); expect((await review()).status).toBe(200);
  await change({ attorneyId: String(other._id) }); expect([403, 409]).toContain((await review()).status); expect(lifecycle.buildArchiveZipFile).not.toHaveBeenCalled();
});
test.each([
  [{ archived: false }, "not_archived", 409], [{ purgedAt: new Date() }, "purged", 410],
  [{ purgeScheduledFor: new Date(0) }, "expired", 410], [{ purgeScheduledFor: "invalid" }, "retention_unconfirmed", 409],
  [{ status: "completed", completedAt: null }, "retention_unconfirmed", 409], [{ status: "closed", completedAt: new Date("2000-01-01") }, "expired", 410],
  [{ status: "unknown" }, "needs_review", 409],
])("%j has accurate availability and cannot produce a ZIP", async (fields, access, status) => { await change(fields); const result = await review(); expect(result.status).toBe(200); expect(result.body).toMatchObject({ access, counts: null, revision: null }); expect((await download()).status).toBe(status); expect(lifecycle.buildArchiveZipFile).not.toHaveBeenCalled(); });
test("completed retention derives from completion and an explicit deadline takes precedence", async () => {
  await change({ status: "completed", completedAt: new Date() }); const response = await review(); expect(response.body.access).toBe("available"); expect(new Date(response.body.retentionEndsAt) > new Date()).toBe(true);
  await change({ purgeScheduledFor: new Date("2099-01-01") }); expect((await review()).body.retentionEndsAt).toBe("2099-01-01T00:00:00.000Z");
});
test("review counts retained sources and never excludes a legal receipt of service", async () => {
  await CaseFile.collection.insertOne({ _id: new Types.ObjectId(), caseId, storageKey: `cases/${caseId}/service.pdf`, originalName: "Receipt of service.pdf", history: [{ storageKey: `cases/${caseId}/prior.pdf` }] });
  await Message.collection.insertMany([{ _id: new Types.ObjectId(), caseId, senderId: attorney._id, text: "Retained", type: "text" }, { _id: new Types.ObjectId(), caseId, text: "DELETED_PRIVATE", deleted: true, fileKey: "bad-key" }]);
  await change({ preEngagement: { confidentialityDocument: { key: `cases/${caseId}/nda.pdf`, name: "NDA.pdf" } }, files: [{ key: `cases/${caseId}/receipt-attorney-v2.pdf`, name: "Platform receipt.pdf" }] });
  const response = await review(); expect(response.body.counts).toEqual({ messages: 1, documents: 3, priorVersions: 1, confidentialityDocuments: 1, receipts: 0, notes: 1 }); await download(response.body.revision);
  const source = lifecycle.buildArchiveZipFile.mock.calls[0][1].contents; expect(source.summary.attorneyName).toBe("Avery Lane"); expect(source.messages[0].text).toBe("Retained"); expect(JSON.stringify(source)).not.toMatch(/DELETED_PRIVATE|archive-owner@example/); expect(source.attorneyNotes).toBe("PRIVATE_NOTE");
});
test("stale revisions reject source changes before preparation", async () => { const before = await review(); await change({ title: "Changed title" }); expect((await download(before.body.revision)).status).toBe(409); expect(lifecycle.buildArchiveZipFile).not.toHaveBeenCalled(); expect((await download("invalid")).status).toBe(400); });
test.each(["owner", "account", "retention", "message"])("%s changes during preparation suppress delivery", async kind => {
  lifecycle.buildArchiveZipFile.mockImplementation(async (_doc, options) => {
    if (kind === "owner") await change({ attorney: other._id, attorneyId: other._id });
    if (kind === "account") await User.collection.updateOne({ _id: attorney._id }, { $set: { disabled: true } });
    if (kind === "retention") await change({ purgeScheduledFor: new Date(0) });
    if (kind === "message") await Message.collection.insertOne({ _id: new Types.ObjectId(), caseId, text: "New message" });
    await options.validate(); throw new Error("Validation should have failed");
  }); const result = await download(); expect([403, 404, 409, 410]).toContain(result.status); expect(result.headers["content-type"]).not.toContain("zip");
});
test.each([[{ name: "NoSuchKey" }, "EXPORT_SOURCE_MISSING", 404], [{ name: "PreconditionFailed" }, "EXPORT_SOURCE_CHANGED", 409], [{ code: "FILE_SCAN_PENDING", statusCode: 423 }, "EXPORT_SCAN_PENDING", 423], [{ code: "FILE_SECURITY_BLOCKED", statusCode: 422 }, "EXPORT_BLOCKED", 422], [{ code: "FILE_SCAN_ERROR", statusCode: 503 }, "EXPORT_SCAN_ERROR", 503]])("preparation failure %j is explicit", async (error, code, status) => { lifecycle.buildArchiveZipFile.mockRejectedValue(Object.assign(new Error("PRIVATE_STORAGE_FAILURE"), error)); const result = await download(); expect(result.status).toBe(status); expect(result.body.code).toBe(code); expect(JSON.stringify(result.body)).not.toContain("PRIVATE_STORAGE_FAILURE"); });
test("concurrent archive requests use separate artifacts", async () => { const results = await Promise.all([download(), download()]); expect(results.map(result => result.status)).toEqual([200, 200]); expect(artifacts).toHaveLength(2); expect(artifacts[0].path).not.toBe(artifacts[1].path); });
test("a managed session revoked during preparation cannot receive its archive", async () => {
  const { createAuthSession, revokeSession } = require("../services/authSessionService");
  const { sessionId } = await createAuthSession(attorney, {});
  const token = jwt.sign({ id: String(attorney._id), role: attorney.role, av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  lifecycle.buildArchiveZipFile.mockImplementation(async (_doc, options) => { await revokeSession(sessionId, attorney._id); await options.validate(); throw new Error("Revoked session passed validation"); });
  const result = await request(app).get(url("download")).set("Cookie", `token=${token}`); expect(result.status).toBe(403); expect(result.body.code).toBe("EXPORT_ACCOUNT_CHANGED");
});
test("renewed sign-ins use the verified token version and a later security change interrupts preparation", async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $set: { authVersion: 1 } }); attorney.authVersion = 1;
  const response = await review(); expect(response.status).toBe(200); expect((await download(response.body.revision)).status).toBe(200);
  lifecycle.buildArchiveZipFile.mockImplementation(async (_doc, options) => { await User.collection.updateOne({ _id: attorney._id }, { $set: { authVersion: 2 } }); await options.validate(); throw new Error("Changed token version passed validation"); });
  const result = await download(); expect(result.status).toBe(403); expect(result.body.code).toBe("EXPORT_ACCOUNT_CHANGED");
});
test("a disconnected browser aborts archive preparation", async () => {
  let started, stopped; const preparing = new Promise(resolve => { started = resolve; }), canceled = new Promise(resolve => { stopped = resolve; });
  lifecycle.buildArchiveZipFile.mockImplementation(async (_doc, options) => { started(); await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true })); stopped(); options.signal.throwIfAborted(); });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const operation = request(server).get(url("download")).set("Cookie", cookie(attorney)); const result = operation.then(() => null, error => error);
    await preparing; operation.abort(); await canceled; expect((await result).code).toBe("ABORTED");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('attorney notes and verified receipts are included and their changes invalidate the download', async () => {
  const exportReceipts = require('../services/matterExportReceipts');
  const receipt = { selectionId: 'payment', revision: 'original', path: 'Receipts/payment-payment.pdf', payload: { title: 'Payment receipt' } };
  const spy = jest.spyOn(exportReceipts, 'read').mockResolvedValue([receipt]);
  try {
    const first = await review();
    expect(first.body.counts).toMatchObject({ receipts: 1, notes: 1 });
    expect((await download(first.body.revision)).status).toBe(200);
    expect(lifecycle.buildArchiveZipFile.mock.calls[0][1].contents).toMatchObject({ attorneyNotes: 'PRIVATE_NOTE', receipts: [receipt] });
    spy.mockResolvedValue([{ ...receipt, revision: 'changed' }]);
    expect((await download(first.body.revision)).status).toBe(409);
    const next = await review(); await change({ internalNotes: 'Updated note' });
    expect((await download(next.body.revision)).status).toBe(409);
  } finally { spy.mockRestore(); }
});
