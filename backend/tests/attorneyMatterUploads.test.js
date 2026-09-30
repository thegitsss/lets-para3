process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_uploads";
process.env.S3_BUCKET = "synthetic-upload-bucket";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockSend = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockSend }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server"), { clearDatabase } = require("./helpers/db");
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), User = require("../models/User"), Upload = require("../models/MatterFileUpload");
const account = require("../services/attorneyAccountBoundary"), { decryptCaseFilePayload } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/uploads", require("../routes/uploads"));
const Notification = require("../models/Notification");
const AuditLog = require("../models/AuditLog");
const Notice = require("../models/MatterFileNotification");
const sendEmail = require("../utils/email");
const { processNotices } = require("../services/matterFileNotifications");
const { markWorkspacePresence, clearWorkspacePresence } = require("../utils/workspacePresence");
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, owner, other, para, doc;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("attorney-uploads")); await Promise.all(Object.values(mongoose.models).map(model => model.init())); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); mockSend.mockReset(); mockSend.mockResolvedValue({});
  sendEmail.mockReset(); sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@uploads.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  doc = await Case.create({ attorney: owner._id, attorneyId: owner._id, title: "Lease documents", details: "Read the lease.", practiceArea: "contract law", state: "New York", paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_uploads" });
  await Case.collection.updateOne({ _id: doc._id }, { $set: { retainedUnknown: { evidence: "PRESERVE" } } });
});
const read = (requestId, user = owner, extra = {}) => request(app).get(`/api/uploads/case/${doc._id}/upload-review`).query({ expectedOwnerId: String(user._id), ...(requestId ? { requestId } : {}), ...extra }).set("Cookie", cookie(user));
const review = async () => { const response = await read(); expect(response.status).toBe(200); return response.body; };
const send = (revision, requestId = crypto.randomUUID(), { user = owner, name = "Lease.txt", bytes = Buffer.from("Lease exhibit B."), type = "text/plain", extra = {} } = {}) => {
  let result = request(app).post(`/api/uploads/case/${doc._id}/reviewed-upload`).set("Cookie", cookie(user)).field("expectedOwnerId", String(user._id)).field("reviewedRevision", revision).field("requestId", requestId);
  for (const [key, value] of Object.entries(extra)) result = result.field(key, value);
  return result.attach("file", bytes, { filename: name, contentType: type });
};
test("reviewed uploads suppress notices only while another paralegal file-view lease remains active", async () => {
  const first = { presenceId: crypto.randomUUID(), revision: 1 }, second = { presenceId: crypto.randomUUID(), revision: 1 };
  await markWorkspacePresence(para._id, doc._id, "files", first);
  await markWorkspacePresence(para._id, doc._id, "files", second);
  await clearWorkspacePresence(para._id, doc._id, "files", { ...first, revision: 2 });
  expect((await send((await review()).revision)).status).toBe(200);
  expect(await Notification.countDocuments({ userId: para._id })).toBe(0);
  expect(await Notice.countDocuments()).toBe(0);
  await clearWorkspacePresence(para._id, doc._id, "files", { ...second, revision: 2 });
  expect((await send((await review()).revision, crypto.randomUUID(), { name: "Next lease.txt" })).status).toBe(200);
  expect(await Notification.countDocuments({ userId: para._id })).toBe(1);
  expect(await Notice.countDocuments({ status: "pending" })).toBe(1);
});
test("a confirmed upload preserves Matter authority, is shared with both dashboards and exposes no private storage identifiers", async () => {
  const before = await Case.collection.findOne({ _id: doc._id }), state = await review(), requestId = crypto.randomUUID();
  const response = await send(state.revision, requestId); expect(response.status).toBe(200); expect(response.body).toMatchObject({ status: "recorded", retryAllowed: false, file: { name: "Lease.txt", uploadedByRole: "attorney", securityStatus: "not_required", version: 1 } });
  expect(JSON.stringify(response.body)).not.toMatch(/storageKey|claimToken|fingerprint|Lease exhibit B/);
  const saved = decryptCaseFilePayload(await CaseFile.collection.findOne({ _id: new mongoose.Types.ObjectId(response.body.file.id) })); expect(saved.storageKey).toMatch(new RegExp(`^cases/${doc._id}/documents/${saved._id}-[a-f0-9]{32}\\.txt$`));
  const after = await Case.collection.findOne({ _id: doc._id }); for (const field of ["retainedUnknown", "status", "escrowStatus", "escrowIntentId", "tasks", "paymentReleased"]) expect(after[field]).toEqual(before[field]);
  for (const user of [owner, para]) { const current = await request(app).get(`/api/uploads/case/${doc._id}?presentation=matter`).set("Cookie", cookie(user)); expect(current.status).toBe(200); expect(current.body.files[0].originalName).toBe("Lease.txt"); }
  const checked = await read(requestId); expect(checked.headers["cache-control"]).toBe("private, no-store"); expect(checked.body.upload.file.id).toBe(response.body.file.id);
  const duplicate = await send(state.revision, requestId); expect(duplicate.body.file.id).toBe(response.body.file.id); expect(mockSend).toHaveBeenCalledTimes(1); expect(await CaseFile.countDocuments()).toBe(1);
  expect(await Notification.countDocuments({ userId: para._id })).toBe(1);
  const audit = await AuditLog.findOne({ action: "file_uploaded" }).lean();
  expect(audit).toMatchObject({ actor: owner._id, actorRole: "attorney", targetType: "case", targetId: String(doc._id), case: doc._id, meta: { fileId: response.body.file.id } });
  expect(JSON.stringify(audit)).not.toContain("Lease.txt");
  expect(await AuditLog.countDocuments({ action: "file_uploaded" })).toBe(1);
  expect(await Notice.countDocuments({ status: "pending" })).toBe(1);
  expect(sendEmail).not.toHaveBeenCalled();
});
test("same request with different bytes or filename is rejected, and a recorded deleted file is never recreated", async () => {
  const state = await review(), requestId = crypto.randomUUID(); expect((await send(state.revision, requestId)).status).toBe(200);
  expect((await send(state.revision, requestId, { bytes: Buffer.from("Different exhibit") })).status).toBe(409); expect((await send(state.revision, requestId, { name: "Other.txt" })).status).toBe(409);
  await CaseFile.deleteMany({}); expect((await send(state.revision, requestId)).body).toEqual({ status: "recorded", file: null, retryAllowed: false }); expect(mockSend).toHaveBeenCalledTimes(1);
});
test("lost provider results retain evidence, require an explicit retry and use a different object key", async () => {
  const state = await review(), requestId = crypto.randomUUID(); mockSend.mockRejectedValueOnce(new Error("Lost response after synthetic storage"));
  expect((await send(state.revision, requestId)).status).toBe(503); expect(await CaseFile.countDocuments()).toBe(0); expect((await read(requestId)).body.upload).toEqual({ status: "failed", file: null, retryAllowed: true });
  expect((await send(state.revision, requestId)).status).toBe(200); expect(mockSend).toHaveBeenCalledTimes(2); expect(mockSend.mock.calls[0][0].input.Key).not.toBe(mockSend.mock.calls[1][0].input.Key); expect((await Upload.collection.findOne({ requestId })).attempts).toHaveLength(2);
});
test.each([{ status: "paused" }, { archived: true }, { readOnly: true }, { escrowStatus: "unfunded" }, { paymentReleased: true }, { completionClaimStatus: "claimed" }, { paralegalAccessRevokedAt: new Date() }])("restriction %j prevents upload before any provider call", async patch => {
  await Case.collection.updateOne({ _id: doc._id }, { $set: patch }); const state = await review(); expect(state.canUpload).toBe(false); expect((await send(state.revision)).status).toBe(403); expect(mockSend).not.toHaveBeenCalled();
});
test("changed assignment, account revocation and lifecycle writes during storage cannot create a document", async () => {
  for (const patch of [{ status: "paused" }, { paralegal: other._id, paralegalId: other._id }]) {
    const state = await review(); mockSend.mockImplementationOnce(async () => Case.collection.updateOne({ _id: doc._id }, { $set: patch })); expect((await send(state.revision)).status).toBe(409); expect(await CaseFile.countDocuments()).toBe(0); await Case.collection.updateOne({ _id: doc._id }, { $set: { status: "in progress", paralegal: para._id, paralegalId: para._id } });
  }
  const state = await review(); mockSend.mockImplementationOnce(async () => User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } })); expect((await send(state.revision)).status).toBe(403); expect(await CaseFile.countDocuments()).toBe(0);
});
test("a lifecycle write winning the transaction race rolls back upload and preserves the changed Matter", async () => {
  const state = await review(), original = Case.collection.updateOne.bind(Case.collection); let once = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, change, options) => { if (options?.session && !once) { once = true; await original({ _id: doc._id }, { $set: { status: "paused" } }); } return original(filter, change, options); });
  expect((await send(state.revision)).status).toBe(503); expect(await CaseFile.countDocuments()).toBe(0); expect((await Case.findById(doc._id)).status).toBe("paused"); expect(mockSend.mock.calls.every(([command]) => command.constructor.name !== "DeleteObjectCommand")).toBe(true);
});
test("revocation just before commit aborts both the upload record and Case write", async () => {
  const state = await review(), original = account.read; let calls = 0;
  jest.spyOn(account, "read").mockImplementation(async (...args) => { if (++calls === 3) await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return original(...args); });
  expect((await send(state.revision)).status).toBe(403); expect(await CaseFile.countDocuments()).toBe(0); expect((await Upload.findOne()).status).toBe("unconfirmed");
});
test("a lost commit response is reconciled from the recorded operation without deleting bytes or sending twice", async () => {
  const state = await review(), requestId = crypto.randomUUID(), start = mongoose.startSession.bind(mongoose);
  jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost commit acknowledgement"); }; return session; });
  expect((await send(state.revision, requestId)).status).toBe(503); const checked = await read(requestId); expect(checked.body.upload.status).toBe("recorded"); expect(checked.body.upload.file).toBeTruthy(); expect(await CaseFile.countDocuments()).toBe(1); expect(mockSend).toHaveBeenCalledTimes(1);
  expect(await AuditLog.countDocuments({ action: "file_uploaded" })).toBe(1);
  expect(await Notification.countDocuments({ userId: para._id })).toBe(1);
  expect(await Notice.countDocuments({ status: "pending" })).toBe(1);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(await processNotices()).toBe(1);
  expect(await processNotices()).toBe(0);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect((await Notice.findOne()).status).toBe("accepted");
  const replay = await send(state.revision, requestId);
  expect(replay.status).toBe(200); expect(replay.body.status).toBe("recorded");
  expect(await Notification.countDocuments({ userId: para._id })).toBe(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
});
test.each([["audit", AuditLog], ["in-app notice", Notification], ["email obligation", Notice]])("a failed %s write rolls back the saved file and all effects; an explicit retry records each once", async (_name, Model) => {
  const state = await review(), requestId = crypto.randomUUID();
  const failure = jest.spyOn(Model, "create").mockRejectedValueOnce(new Error("Synthetic persistence failure"));
  expect((await send(state.revision, requestId)).status).toBe(503);
  failure.mockRestore();
  expect(await CaseFile.countDocuments()).toBe(0);
  expect(await AuditLog.countDocuments({ action: "file_uploaded" })).toBe(0);
  expect(await Notification.countDocuments()).toBe(0);
  expect(await Notice.countDocuments()).toBe(0);
  expect((await Upload.findOne()).status).toBe("unconfirmed");
  expect(sendEmail).not.toHaveBeenCalled();
  expect((await send(state.revision, requestId)).status).toBe(200);
  expect(await CaseFile.countDocuments()).toBe(1);
  expect(await AuditLog.countDocuments({ action: "file_uploaded" })).toBe(1);
  expect(await Notification.countDocuments()).toBe(1);
  expect(await Notice.countDocuments()).toBe(1);
  expect(mockSend.mock.calls.every(([command]) => command.constructor.name !== "DeleteObjectCommand")).toBe(true);
});
test.each([
  [{ inApp: false }, 0, 1], [{ email: false }, 1, 0],
  [{ inAppCase: false, emailCase: false }, 0, 0],
])("upload effects respect notification preferences %j", async (prefs, inApp, emails) => {
  await User.updateOne({ _id: para._id }, { $set: { notificationPrefs: prefs } });
  expect((await send((await review()).revision)).status).toBe(200);
  expect(await Notification.countDocuments()).toBe(inApp);
  expect(await Notice.countDocuments()).toBe(emails);
  expect(await AuditLog.countDocuments({ action: "file_uploaded" })).toBe(1);
});
test("missing delivery indexes reject a new upload before storage", async () => {
  jest.spyOn(Notice.collection, "indexes").mockResolvedValue([{ key: { _id: 1 }, unique: true }]);
  expect((await send((await review()).revision)).status).toBe(503);
  expect(mockSend).not.toHaveBeenCalled();
});
test("a second tab cannot claim a running upload, and an expired old response cannot commit over a new claim", async () => {
  const state = await review(), requestId = crypto.randomUUID(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }); mockSend.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
  const first = send(state.revision, requestId).then(value => value); await ready;
  expect((await send(state.revision, requestId)).status).toBe(409); expect(mockSend).toHaveBeenCalledTimes(1);
  await Upload.collection.updateOne({ requestId }, { $set: { leaseUntil: new Date(0) } });
  const second = await send(state.revision, requestId); expect(second.status).toBe(200); release({}); expect((await first).status).toBe(409); expect(await CaseFile.countDocuments()).toBe(1); expect((await read(requestId)).body.upload.file.id).toBe(second.body.file.id); expect(mockSend).toHaveBeenCalledTimes(2);
});
test("wrong accounts, unsupported files, stale reviews and forged fields do not reach storage", async () => {
  const state = await review(); for (const user of [other, para]) expect((await send(state.revision, crypto.randomUUID(), { user })).status).toBe(403);
  expect((await read(null, owner, { expectedOwnerId: String(other._id) })).status).toBe(403);
  for (const options of [{ name: "Lease.pdf", type: "application/pdf" }, { name: "Lease.html", type: "text/html" }, { bytes: Buffer.alloc(0) }, { extra: { revisionOfFileId: String(other._id) } }]) expect((await send(state.revision, crypto.randomUUID(), options)).status).toBe(400);
  expect((await send("0".repeat(64))).status).toBe(409); expect(mockSend).not.toHaveBeenCalled();
});
test("a missing unique index fails closed without writing storage and restores cleanly", async () => {
  jest.spyOn(Upload.collection, "indexes").mockResolvedValue([{ key: { _id: 1 }, unique: true }]); expect((await read()).status).toBe(503); expect((await send("0".repeat(64))).status).toBe(503); expect(mockSend).not.toHaveBeenCalled();
});
