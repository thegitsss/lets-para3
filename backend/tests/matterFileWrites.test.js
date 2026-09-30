const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto"), { Readable } = require("stream");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_file_interlocks"; process.env.S3_BUCKET = "synthetic-file-interlocks"; process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockStorage = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockStorage }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Upload = require("../models/MatterFileUpload"), Notification = require("../models/Notification"), AuditLog = require("../models/AuditLog");
const Notice = require("../models/MatterFileNotification"), sendEmail = require("../utils/email");
const { markWorkspacePresence, clearWorkspacePresence } = require("../utils/workspacePresence");
const writes = require("../services/matterFileWrites"), { decryptCaseFilePayload } = require("../utils/dataEncryption"), { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/uploads", require("../routes/uploads")); app.use("/api/cases", require("../routes/cases")); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, para, other, matter, file;
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), CaseFile.init(), Upload.init(), Notification.init(), AuditLog.init()]); }); afterAll(closeDatabase);
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); process.env.S3_MALWARE_SCAN_REQUIRED = "false";
  mockStorage.mockImplementation(async command => { if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 9, ContentType: "text/plain" }; if (command.constructor.name === "GetObjectCommand") return { Body: Readable.from(["new lease"]) }; return {}; });
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@file-interlocks.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "River Street lease review", details: "Review lease exhibits", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_file_interlocks", totalAmount: 100000, currency: "usd" });
  file = await CaseFile.create({ caseId: matter._id, userId: para._id, originalName: "Original.txt", storageKey: `cases/${matter._id}/documents/original.txt`, mimeType: "text/plain", size: 9, uploadedByRole: "paralegal", status: "pending_review", securityStatus: "not_required" });
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { futureMetadata: { keep: "ORIGINAL" } } });
});
const raw = () => Case.collection.findOne({ _id: matter._id });
const stored = target => CaseFile.collection.findOne({ _id: target || file._id });
const upload = (requestId = crypto.randomUUID(), user = para, bytes = "original lease", name = "Original submission.txt") => request(app).post(`/api/uploads/case/${matter._id}?presentation=matter`).set("Cookie", cookie(user)).field("clientUploadId", requestId).attach("file", Buffer.from(bytes), { filename: name, contentType: "text/plain" });
const replace = (target = file._id, key = `cases/${matter._id}/documents/replacement.txt`) => request(app).post(`/api/cases/${matter._id}/files/${target}/replace`).set("Cookie", cookie(owner)).send({ key, original: "Replacement.txt", mime: "text/plain", size: 9 });
const status = () => request(app).patch(`/api/cases/${matter._id}/files/${file._id}/status`).set("Cookie", cookie(owner)).send({ status: "approved" });
const deletes = () => mockStorage.mock.calls.filter(([command]) => command.constructor.name === "DeleteObjectCommand");
test.each([{ completionClaimStatus: "claimed" }, { completionClaimStatus: "needs_reconciliation" }, { completionClaimToken: "pending" }, { hiringClaimStatus: "claimed" }])("earlier upload and review routes reject processing state %j before storage or metadata writes", async patch => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: patch }); expect((await upload()).status).toBe(409); expect((await status()).status).toBe(409); expect((await replace()).status).toBe(409); expect(mockStorage).not.toHaveBeenCalled(); expect((await stored()).status).toBe("pending_review");
});
test.each([{ completionClaimStatus: "claimed" }, { status: "paused", pausedReason: "paralegal_withdrew", paralegalAccessRevokedAt: new Date() }])("a Matter decision during storage upload prevents the late metadata insert: %j", async patch => {
  const requestId = crypto.randomUUID(); mockStorage.mockImplementationOnce(async () => Case.collection.updateOne({ _id: matter._id }, { $set: patch })); const result = await upload(requestId); expect([403, 409]).toContain(result.status); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(1); const operation = await Upload.findOne({ requestId }); expect(operation.status).toBe("unconfirmed"); expect(operation.attempts).toHaveLength(1); expect(deletes()).toHaveLength(0);
});
test("account revocation during storage upload prevents the late file from being recorded", async () => {
  mockStorage.mockImplementationOnce(async () => User.collection.updateOne({ _id: para._id }, { $inc: { authVersion: 1 } })); expect((await upload()).status).toBe(403); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(1); expect(deletes()).toHaveLength(0);
});
test("a legacy review conflicts with a completion claim inside its transaction and preserves both records", async () => {
  const original = Case.collection.updateOne.bind(Case.collection); let once = false; jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (args[2]?.session && !once) { once = true; await original({ _id: matter._id }, { $set: { completionClaimStatus: "claimed", completionClaimToken: "winner" } }); } return original(...args); });
  expect((await status()).status).toBe(409); expect((await stored()).status).toBe("pending_review"); expect((await raw()).completionClaimToken).toBe("winner");
});
test("a legacy replacement cannot finish after a completion claim appears during the storage check", async () => {
  const original = mockStorage.getMockImplementation(); mockStorage.mockImplementation(async command => { if (command.constructor.name === "HeadObjectCommand") await Case.collection.updateOne({ _id: matter._id }, { $set: { completionClaimStatus: "claimed" } }); return original(command); });
  expect((await replace()).status).toBe(409); expect(decryptCaseFilePayload(await stored()).storageKey).toBe(`cases/${matter._id}/documents/original.txt`); expect((await stored()).history).toHaveLength(0); expect(deletes()).toHaveLength(0);
});
test("earlier status and revision writes preserve unknown metadata and advance the shared Matter revision", async () => {
  const before = await raw(); expect((await status()).status).toBe(200); const reviewed = await stored(); expect(reviewed.status).toBe("approved"); expect(reviewed.futureMetadata).toEqual({ keep: "ORIGINAL" }); expect((await raw()).__v).toBe(Number(before.__v || 0) + 1);
  const notes = "Review the <draft> exhibit references.\n\nRetain the original labels.";
  const response = await request(app).post(`/api/cases/${matter._id}/files/${file._id}/revision-request`).set("Cookie", cookie(owner)).send({ notes }); expect(response.status).toBe(200); expect((await stored()).status).toBe("pending_review"); expect(decryptCaseFilePayload(await stored()).revisionNotes).toBe(notes); expect((await stored()).futureMetadata).toEqual({ keep: "ORIGINAL" });
});
test("the same original upload after legacy replacement returns its current document without inserting another file", async () => {
  const requestId = crypto.randomUUID(), first = await upload(requestId); expect(first.status).toBe(201); const fileId = first.body.file.id; expect((await replace(fileId)).status).toBe(200); const repeat = await upload(requestId); expect(repeat.status).toBe(200); expect(repeat.body).toMatchObject({ idempotent: true, changedSinceUpload: true, file: { id: fileId, originalName: "Replacement.txt" } }); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(2); expect(await Upload.countDocuments({ requestId })).toBe(1); expect((await Upload.findOne({ requestId })).ownerId.toString()).toBe(para._id.toString()); expect(mockStorage.mock.calls.filter(([command]) => command.constructor.name === "PutObjectCommand")).toHaveLength(1);
});
test("the same original upload after V2 replacement keeps its original request and current document identity", async () => {
  const requestId = crypto.randomUUID(), first = await upload(requestId), fileId = first.body.file.id;
  const review = await request(app).get(`/api/uploads/case/${matter._id}/replacement-review/${fileId}`).set("Cookie", cookie(owner)).query({ expectedOwnerId: String(owner._id) }); expect(review.status).toBe(200);
  const replacement = await request(app).post(`/api/uploads/case/${matter._id}/reviewed-replacement/${fileId}`).set("Cookie", cookie(owner)).field("expectedOwnerId", String(owner._id)).field("requestId", crypto.randomUUID()).field("reviewedRevision", review.body.revision).field("reviewedFileRevision", review.body.target.reviewRevision).attach("file", Buffer.from("revised exhibits"), { filename: "Exhibits.txt", contentType: "text/plain" }); expect(replacement.status).toBe(200);
  const repeat = await upload(requestId); expect(repeat.status).toBe(200); expect(repeat.body).toMatchObject({ idempotent: true, changedSinceUpload: true, file: { id: fileId, originalName: "Exhibits.txt" } }); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(2);
});
test("a prior upload without content evidence retains identity at replacement and cannot be adopted from different bytes", async () => {
  const requestId = crypto.randomUUID(); await CaseFile.collection.updateOne({ _id: file._id }, { $set: { clientUploadId: requestId } }); expect((await replace()).status).toBe(200); const origin = await Upload.collection.findOne({ requestId }); expect(origin.fingerprint).toBe("legacy-unverified"); expect(String(origin.ownerId)).toBe(String(para._id)); const retry = await upload(requestId); expect(retry.status).toBe(409); expect(retry.body.code).toBe("FILE_WRITE_UPLOAD_CHANGED"); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(1); expect(mockStorage.mock.calls.filter(([command]) => command.constructor.name === "PutObjectCommand")).toHaveLength(0);
});
test("original upload retries reject changed names or bytes and never recreate a subsequently removed document", async () => {
  const requestId = crypto.randomUUID(), first = await upload(requestId); expect(first.status).toBe(201); expect((await upload(requestId, para, "different bytes")).status).toBe(409); expect((await upload(requestId, para, "original lease", "Different.txt")).status).toBe(409); await CaseFile.deleteOne({ _id: first.body.file.id }); const retry = await upload(requestId); expect(retry.status).toBe(409); expect(retry.body.code).toBe("FILE_WRITE_UPLOAD_REMOVED"); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(1);
});
test("competing copies of a pending upload create one attempt and one document", async () => {
  const requestId = crypto.randomUUID(); let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; }); mockStorage.mockImplementationOnce(async () => { arrived(); await gate; return {}; }); const first = upload(requestId).then(value => value);
  try { await waiting; expect((await upload(requestId)).status).toBe(409); } finally { release(); }
  expect((await first).status).toBe(201); expect(await Upload.countDocuments({ requestId })).toBe(1); expect((await Upload.findOne({ requestId })).attempts).toHaveLength(1); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(2);
});
test("unknown upload commit acknowledgements recover recorded metadata without deleting the winning object", async () => {
  const original = mongoose.startSession.bind(mongoose); jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await original(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost commit acknowledgement"); }; return session; });
  const requestId = crypto.randomUUID(), result = await upload(requestId); expect(result.status).toBe(200); expect(result.body.idempotent).toBe(true); expect((await Upload.findOne({ requestId })).status).toBe("recorded"); expect(await CaseFile.countDocuments({ caseId: matter._id })).toBe(2); expect(deletes()).toHaveLength(0);
  expect(await AuditLog.countDocuments({ action: 'file_uploaded' })).toBe(1);
  expect(await Notification.countDocuments({ type: 'case_file_uploaded' })).toBe(1);
  expect(await Notice.countDocuments({ status: 'pending' })).toBe(1);
  expect((await upload(requestId)).status).toBe(200);
  expect(await Notice.countDocuments()).toBe(1); expect(sendEmail).not.toHaveBeenCalled();
});
test("unknown replacement commit acknowledgements never delete the newly recorded object", async () => {
  const original = mongoose.startSession.bind(mongoose); jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await original(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost replacement acknowledgement"); }; return session; });
  expect((await replace()).status).toBe(503); expect(decryptCaseFilePayload(await stored()).storageKey).toBe(`cases/${matter._id}/documents/replacement.txt`); expect((await stored()).history).toHaveLength(1); expect(deletes()).toHaveLength(0);
});
test("a failed explicit upload retry uses another object key and retains both attempt records", async () => {
  const requestId = crypto.randomUUID(); mockStorage.mockRejectedValueOnce(new Error("Synthetic storage response lost")); expect((await upload(requestId)).status).toBe(500); expect((await Upload.findOne({ requestId })).status).toBe("failed"); expect((await upload(requestId)).status).toBe(201); const operation = await Upload.findOne({ requestId }); expect(operation.attempts).toHaveLength(2); const puts = mockStorage.mock.calls.filter(([command]) => command.constructor.name === "PutObjectCommand"); expect(puts[0][0].input.Key).not.toBe(puts[1][0].input.Key); expect(deletes()).toHaveLength(0);
});
test("foreign or invalid attachment keys cannot trigger storage deletion", async () => {
  const key = `cases/${new mongoose.Types.ObjectId()}/documents/foreign.txt`; const result = await request(app).post(`/api/cases/${matter._id}/files`).set("Cookie", cookie(owner)).send({ key, original: "Foreign.txt", mime: "text/plain", size: 9 }); expect(result.status).toBe(400); expect(mockStorage).not.toHaveBeenCalled(); expect((await replace(file._id, key)).status).toBe(400); expect(mockStorage).not.toHaveBeenCalled();
});
test("changed scanner outcomes serialize with the Matter and an old object cannot mark a replacement clean", async () => {
  const record = await stored(), before = await raw(); await writes.persistScan(record, decryptCaseFilePayload(record).storageKey, { status: "blocked", result: "THREATS_FOUND" }); expect((await stored()).securityStatus).toBe("blocked"); expect((await raw()).__v).toBe(Number(before.__v || 0) + 1); const checked = await stored(), unchanged = await raw(); await writes.persistScan(checked, decryptCaseFilePayload(checked).storageKey, { status: "blocked", result: "THREATS_FOUND" }); expect((await raw()).__v).toBe(unchanged.__v);
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { storageKey: `cases/${matter._id}/documents/newer.txt`, securityStatus: "pending", version: 2 } }); await expect(writes.persistScan(record, decryptCaseFilePayload(record).storageKey, { status: "clean", result: "NO_THREATS_FOUND" })).rejects.toMatchObject({ status: 409 }); expect((await stored()).securityStatus).toBe("pending");
});
test("a legacy mutation cannot fall back to separate metadata writes when transactions are unavailable", async () => {
  jest.spyOn(mongoose, "startSession").mockResolvedValue({ startTransaction() { throw new Error("Transactions unavailable"); }, inTransaction: () => false, endSession: async () => {} }); expect((await status()).status).toBe(503); expect((await stored()).status).toBe("pending_review");
});
const lockTimeout = () => { const error = new mongoose.mongo.MongoServerError({ errmsg: "Synthetic uncommitted lock timeout", code: 24, codeName: "LockTimeout" }); error.addErrorLabel("TransientTransactionError"); return error; };
test("an uncommitted file-save lock timeout retries its fresh guards without losing the intended fields", async () => {
  const original = CaseFile.collection.updateOne.bind(CaseFile.collection); let locks = 0;
  jest.spyOn(CaseFile.collection, "updateOne").mockImplementation(async (...args) => { if (args[2]?.session && locks++ === 0) throw lockTimeout(); return original(...args); });
  const before = await raw(); expect((await status()).status).toBe(200); expect(locks).toBe(2); expect((await stored()).status).toBe("approved"); expect((await stored()).futureMetadata).toEqual({ keep: "ORIGINAL" }); expect((await raw()).__v).toBe(Number(before.__v || 0) + 1);
});
test("an upload lock timeout can retry metadata while sending the file bytes only once", async () => {
  const original = Case.collection.updateOne.bind(Case.collection); let once = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (args[2]?.session && !once) { once = true; throw lockTimeout(); } return original(...args); });
  const requestId = crypto.randomUUID(); expect((await upload(requestId)).status).toBe(201); expect(mockStorage.mock.calls.filter(([command]) => command.constructor.name === "PutObjectCommand")).toHaveLength(1); expect(await Upload.countDocuments({ requestId })).toBe(1); expect((await Upload.findOne({ requestId })).attempts).toHaveLength(1);
});
test("a Matter change between lock attempts stops the earlier review instead of applying it to newer work", async () => {
  const original = Case.collection.updateOne.bind(Case.collection); let once = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (args[2]?.session && !once) { once = true; await original({ _id: matter._id }, { $set: { completionClaimStatus: "claimed" } }); throw lockTimeout(); } return original(...args); });
  expect((await status()).status).toBe(409); expect((await stored()).status).toBe("pending_review"); expect((await raw()).completionClaimStatus).toBe("claimed");
});
test("persistent lock timeouts stop after three uncommitted attempts", async () => {
  const original = Case.collection.updateOne.bind(Case.collection); let attempts = 0;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (args[2]?.session) { attempts++; throw lockTimeout(); } return original(...args); });
  expect((await status()).status).toBe(409); expect(attempts).toBe(3); expect((await stored()).status).toBe("pending_review");
});

test.each(['paralegal', 'attorney'])('the %s participant upload commits its audit and eligible notices once without calling email', async role => {
  const actor = role === 'paralegal' ? para : owner, recipient = role === 'paralegal' ? owner : para, requestId = crypto.randomUUID();
  const response = await upload(requestId, actor); expect(response.status).toBe(201);
  const operation = await Upload.findOne({ requestId });
  expect(await Notice.findById(operation._id)).toMatchObject({ userId: recipient._id, actorUserId: actor._id, fileId: operation.fileId, fileVersion: 1, status: 'pending' });
  const audit = await AuditLog.findOne({ action: 'file_uploaded' }).lean();
  expect(audit).toMatchObject({ actor: actor._id, targetId: String(matter._id), meta: { fileId: String(operation.fileId) } });
  expect(JSON.stringify(audit)).not.toContain('Original submission.txt');
  const notification = await Notification.findOne({ type: 'case_file_uploaded' }).lean();
  expect(String(notification.userId)).toBe(String(recipient._id)); expect(notification.link).toContain(`fileId=${operation.fileId}`);
  expect((await upload(requestId, actor)).status).toBe(200);
  expect(await AuditLog.countDocuments({ action: 'file_uploaded' })).toBe(1); expect(await Notification.countDocuments()).toBe(1); expect(await Notice.countDocuments()).toBe(1);
  expect(sendEmail).not.toHaveBeenCalled();
});

test.each(['paralegal', 'attorney'].flatMap(role => [['audit', AuditLog], ['in-app notice', Notification], ['email obligation', Notice]].map(([name, model]) => [role, name, model])))('%s upload rolls back a failed %s and an explicit retry records every effect once', async (role, _name, Model) => {
  const actor = role === 'paralegal' ? para : owner, requestId = crypto.randomUUID();
  const fail = jest.spyOn(Model, 'create').mockRejectedValueOnce(new Error('Synthetic durable effect failure'));
  expect((await upload(requestId, actor)).status).toBe(503); fail.mockRestore();
  expect(await CaseFile.countDocuments()).toBe(1); expect((await Upload.findOne({ requestId })).status).toBe('unconfirmed');
  expect(await AuditLog.countDocuments({ action: 'file_uploaded' })).toBe(0); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
  expect((await upload(requestId, actor)).status).toBe(201);
  expect(await CaseFile.countDocuments()).toBe(2); expect(await AuditLog.countDocuments({ action: 'file_uploaded' })).toBe(1); expect(await Notification.countDocuments()).toBe(1); expect(await Notice.countDocuments()).toBe(1);
  expect(deletes()).toHaveLength(0); expect(sendEmail).not.toHaveBeenCalled();
});

test.each([[{ inApp: false }, 0, 1], [{ email: false }, 1, 0], [{ inAppCase: false, emailCase: false }, 0, 0]])('participant effects respect the attorney recipient preferences %j', async (prefs, inApp, emails) => {
  await User.updateOne({ _id: owner._id }, { $set: { notificationPrefs: prefs } });
  expect((await upload()).status).toBe(201);
  expect(await Notification.countDocuments()).toBe(inApp); expect(await Notice.countDocuments()).toBe(emails); expect(await AuditLog.countDocuments({ action: 'file_uploaded' })).toBe(1);
});

test('a paralegal upload respects independent attorney Files presence leases', async () => {
  const first = { presenceId: crypto.randomUUID(), revision: 1 }, second = { presenceId: crypto.randomUUID(), revision: 1 };
  await markWorkspacePresence(owner._id, matter._id, 'files', first); await markWorkspacePresence(owner._id, matter._id, 'files', second);
  await clearWorkspacePresence(owner._id, matter._id, 'files', { ...first, revision: 2 });
  expect((await upload()).status).toBe(201); expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
  await clearWorkspacePresence(owner._id, matter._id, 'files', { ...second, revision: 2 });
  expect((await upload(crypto.randomUUID(), para, 'More lease records', 'Next.txt')).status).toBe(201);
  expect(await Notification.countDocuments()).toBe(1); expect(await Notice.countDocuments()).toBe(1);
});

test('missing delivery indexes stop new bytes while a recorded retry remains readable', async () => {
  const requestId = crypto.randomUUID(); expect((await upload(requestId)).status).toBe(201); mockStorage.mockClear();
  jest.spyOn(Notice.collection, 'indexes').mockResolvedValue([{ key: { _id: 1 }, unique: true }]);
  expect((await upload()).status).toBe(503); expect(mockStorage).not.toHaveBeenCalled();
  expect((await upload(requestId)).status).toBe(200); expect(await Notice.countDocuments()).toBe(1); expect(await Upload.countDocuments()).toBe(1);
});

test('an uncommitted notice lock retries all metadata without duplicating the provider write or effects', async () => {
  const create = Notice.create.bind(Notice); let attempted = false;
  jest.spyOn(Notice, 'create').mockImplementation(async (...args) => { const result = await create(...args); if (!attempted) { attempted = true; throw lockTimeout(); } return result; });
  expect((await upload()).status).toBe(201);
  expect(await Notice.countDocuments()).toBe(1); expect(await Notification.countDocuments()).toBe(1); expect(await AuditLog.countDocuments({ action: 'file_uploaded' })).toBe(1);
  expect(mockStorage.mock.calls.filter(([command]) => command.constructor.name === 'PutObjectCommand')).toHaveLength(1); expect(sendEmail).not.toHaveBeenCalled();
});
