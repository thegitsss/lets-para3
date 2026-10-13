const mongoose = require("mongoose");
const crypto = require("crypto");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require("../utils/email");
const Notice = require("../models/MatterFileNotification");
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Upload = require("../models/MatterFileUpload");
const AuditLog = require("../models/AuditLog");
const Alert = require("../models/AdminCommunicationAlert");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { processNotices, stage, noticeStatus } = require("../services/matterFileNotifications");
const { revision, retry } = require("../services/communicationRetry");
let attorney, paralegal, admin, matter, file, upload;
beforeAll(connect, 120000);
afterAll(closeDatabase);
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); sendEmail.mockReset(); sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  [attorney, paralegal, admin] = await User.create(["attorney", "paralegal", "admin"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@file-notices.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, title: "Private lease review", details: "Synthetic records", practiceArea: "contract law", state: "New York", paralegal: paralegal._id, paralegalId: paralegal._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_file_notice" });
  file = await CaseFile.create({ caseId: matter._id, userId: attorney._id, originalName: "Private exhibit.txt", storageKey: `cases/${matter._id}/documents/synthetic.txt`, mimeType: "text/plain", size: 16, uploadedByRole: "attorney", status: "pending_review", version: 1 });
  upload = await Upload.create({ caseId: matter._id, ownerId: attorney._id, requestId: crypto.randomUUID(), fingerprint: "a".repeat(64), fileId: file._id, kind: "upload", status: "recorded", claimToken: crypto.randomUUID(), leaseUntil: new Date(), recordedAt: new Date() });
  const session = await mongoose.startSession();
  try { await session.withTransaction(() => stage({ uploadId: upload._id, userId: paralegal._id, actorUserId: attorney._id, caseId: matter._id, fileId: file._id, fileVersion: 1 }, session)); }
  finally { await session.endSession(); }
});
const read = () => Notice.findById(upload._id).lean();
const due = () => Notice.updateOne({ _id: upload._id }, { $set: { nextAttemptAt: new Date(0) } });
const retryRequest = row => ({ params: { id: String(row._id) }, body: { confirmed: true, revision: revision(row) }, user: { id: String(admin._id), role: "admin" }, headers: {}, method: "POST", originalUrl: `/api/admin/workspace/communications/files/${row._id}/retry` });

test("the retained obligation contains references only and concurrent workers send the current notice once", async () => {
  expect(JSON.stringify(await read())).not.toMatch(/Private|exhibit|storageKey|fingerprint|file-notices\.test/);
  const counts = await Promise.all([processNotices(), processNotices()]);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail).toHaveBeenCalledWith(paralegal.email, expect.any(String), expect.stringContaining("Private exhibit.txt"), expect.objectContaining({ throwOnError: true, messageId: `<lpc-file.${upload._id}@lets-paraconnect.com>`, headers: { "Auto-Submitted": "auto-generated" } }));
  expect(await read()).toMatchObject({ status: "accepted", attempts: 1, acceptedAt: expect.any(Date) });
  expect(await processNotices()).toBe(0);
  expect(sendEmail.mock.calls[0][2]).toContain(`fileId=${file._id}`);
});
test.each([
  ["email preference", () => User.updateOne({ _id: paralegal._id }, { $set: { "notificationPrefs.email": false } })],
  ["case email preference", () => User.updateOne({ _id: paralegal._id }, { $set: { "notificationPrefs.emailCase": false } })],
  ["removed account", () => User.updateOne({ _id: paralegal._id }, { $set: { deleted: true } })],
  ["suspended actor", () => User.updateOne({ _id: attorney._id }, { $set: { status: "suspended" } })],
  ["withdrawal", () => Case.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } })],
  ["new assignment", () => Case.updateOne({ _id: matter._id }, { $set: { paralegal: admin._id, paralegalId: admin._id } })],
  ["inconsistent assignment", () => Case.updateOne({ _id: matter._id }, { $set: { paralegalId: admin._id } })],
  ["closed matter", () => Case.updateOne({ _id: matter._id }, { $set: { status: "completed" } })],
  ["replacement file", () => CaseFile.updateOne({ _id: file._id }, { $set: { version: 2 } })],
  ["deleted file", () => CaseFile.deleteOne({ _id: file._id })],
  ["unconfirmed operation", () => Upload.updateOne({ _id: upload._id }, { $set: { status: "unconfirmed" } })],
  ["inconsistent file role", () => CaseFile.updateOne({ _id: file._id }, { $set: { uploadedByRole: 'paralegal' } })],
  ["a later assignment of the same recipient", () => Case.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: paralegal._id, hiredAt: new Date(Date.now() + 60000) } })],
])("a queued email is skipped after %s changes its relevance", async (_name, change) => {
  await change(); expect(await processNotices()).toBe(1);
  expect((await read()).status).toBe("skipped"); expect(sendEmail).not.toHaveBeenCalled();
});
test("a failed read before SMTP retries without exposing database details", async () => {
  const lookup = jest.spyOn(Case.collection, "findOne").mockRejectedValueOnce(new Error("secret database URI"));
  await processNotices(); lookup.mockRestore();
  expect(await read()).toMatchObject({ status: "failed", attempts: 1 });
  expect(JSON.stringify(await noticeStatus())).not.toContain("secret database URI");
  expect(sendEmail).not.toHaveBeenCalled();
  await due(); expect(await processNotices()).toBe(1); expect((await read()).status).toBe("accepted");
});
test("definite SMTP rejection backs off and retries, while unknown acceptance never retries automatically", async () => {
  sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic rejection"), { responseCode: 451 }));
  await processNotices(); expect((await read()).status).toBe("failed"); expect(await processNotices()).toBe(0);
  await due(); sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic lost DATA acknowledgement"), { code: "ETIMEDOUT", command: "DATA" }));
  await processNotices(); expect((await read()).status).toBe("unknown");
  await due(); expect(await processNotices()).toBe(0); expect(sendEmail).toHaveBeenCalledTimes(2);
});
test("a connection-close error labelled CONN can follow DATA and remains unknown", async () => {
  sendEmail.mockRejectedValueOnce(Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION", command: "CONN" }));
  await processNotices(); expect((await read()).status).toBe("unknown");
  await due(); expect(await processNotices()).toBe(0); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each([{ disabled: true }, { accepted: ["someone-else@example.test"] }, { error: true }])("unconfirmed transport result %j cannot become accepted", async result => {
  sendEmail.mockResolvedValueOnce(result); await processNotices();
  expect((await read()).status).toBe(result.disabled ? "disabled" : "unknown");
  await due(); expect(await processNotices()).toBe(0);
});
test("a lost database write after SMTP acceptance becomes reviewable without another send", async () => {
  const save = jest.spyOn(Notice, "updateOne").mockRejectedValueOnce(new Error("Synthetic database interruption"));
  await expect(processNotices()).rejects.toThrow("Synthetic database interruption"); save.mockRestore();
  expect((await read()).status).toBe("sending");
  await Notice.updateOne({ _id: upload._id }, { $set: { claimedAt: new Date(Date.now() - 11 * 60000) } });
  expect(await processNotices()).toBe(0); expect((await read()).status).toBe("unknown"); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test("five definite rejections remain visible for review instead of an endless retry loop", async () => {
  sendEmail.mockRejectedValue(Object.assign(new Error("Synthetic rejection"), { responseCode: 550 }));
  for (let count = 0; count < 5; count++) { await due(); expect(await processNotices()).toBe(1); }
  await due(); expect(await processNotices()).toBe(0);
  expect(await noticeStatus()).toMatchObject({ counts: { failed: 1 }, recent: [expect.objectContaining({ attempts: 5, revision: expect.stringMatching(/^[a-f0-9]{64}$/) })] });
});
test("an explicit reviewed retry is atomic with its audit and cannot replay a stale decision", async () => {
  await Notice.updateOne({ _id: upload._id }, { $set: { status: "unknown" } });
  const req = retryRequest(await read());
  const auditFailure = jest.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit failure"));
  await expect(retry(req, Notice, "matter_file")).rejects.toThrow("Synthetic audit failure"); auditFailure.mockRestore();
  expect((await read()).status).toBe("unknown");
  expect(await retry(req, Notice, "matter_file")).toEqual({ ok: true });
  await expect(retry(req, Notice, "matter_file")).rejects.toMatchObject({ statusCode: 409 });
  expect(await AuditLog.countDocuments({ action: "admin.communication.retry_requested" })).toBe(1);
  expect(await AuditLog.findOne()).toMatchObject({ actor: admin._id, actorRole: "admin", targetType: "other", meta: { kind: "matter_file", previousStatus: "unknown" } });
  await processNotices(); expect((await read()).status).toBe("accepted");
});
test("owner alert retry uses the valid atomic audit boundary too", async () => {
  const alert = await Alert.create({ key: "synthetic-retry", kind: "signup", targetId: attorney._id, status: "unknown" });
  expect(await retry(retryRequest(alert), Alert, "owner_alert")).toEqual({ ok: true });
  expect((await Alert.findById(alert._id)).status).toBe("pending");
  expect(await AuditLog.findOne()).toMatchObject({ targetType: "other", meta: { kind: "owner_alert", previousStatus: "unknown" } });
});
test("retry requires the reviewed record and explicit delivery check", async () => {
  const req = retryRequest(await read());
  for (const body of [{}, { confirmed: true }, { confirmed: true, revision: "bad" }]) {
    await expect(retry({ ...req, body }, Notice, "matter_file")).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(retry(req, Notice, "matter_file")).rejects.toMatchObject({ statusCode: 409 });
  expect(await AuditLog.countDocuments()).toBe(0);
});

async function paralegalSubmission() {
  await CaseFile.updateOne({ _id: file._id }, { $set: { userId: paralegal._id, uploadedByRole: 'paralegal' } });
  await Upload.updateOne({ _id: upload._id }, { $set: { ownerId: paralegal._id } });
  await Notice.updateOne({ _id: upload._id }, { $set: { userId: attorney._id, actorUserId: paralegal._id } });
}
test('a retained paralegal submission emails its current attorney once with the direct file destination', async () => {
  await paralegalSubmission();
  expect(await processNotices()).toBe(1); expect((await read()).status).toBe('accepted');
  expect(sendEmail).toHaveBeenCalledWith(attorney.email, expect.any(String), expect.stringContaining(`/case-detail.html?caseId=${matter._id}&amp;tab=files&amp;fileId=${file._id}`), expect.any(Object));
  expect(await processNotices()).toBe(0); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each([
  ['attorney email preference', () => User.updateOne({ _id: attorney._id }, { $set: { 'notificationPrefs.emailCase': false } })],
  ['changed attorney', () => Case.updateOne({ _id: matter._id }, { $set: { attorney: admin._id, attorneyId: admin._id } })],
  ['conflicting attorney aliases', () => Case.updateOne({ _id: matter._id }, { $set: { attorneyId: admin._id } })],
  ['withdrawn sender', () => Case.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } })],
  ['replacement paralegal', () => Case.updateOne({ _id: matter._id }, { $set: { paralegal: admin._id, paralegalId: admin._id } })],
  ['same paralegal rehired later', () => Case.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: paralegal._id, hiredAt: new Date(Date.now() + 60000) } })],
  ['inconsistent file sender', () => CaseFile.updateOne({ _id: file._id }, { $set: { userId: attorney._id } })],
])('the paralegal submission email is skipped after %s', async (_name, change) => {
  await paralegalSubmission(); await change();
  expect(await processNotices()).toBe(1); expect((await read()).status).toBe('skipped'); expect(sendEmail).not.toHaveBeenCalled();
});
