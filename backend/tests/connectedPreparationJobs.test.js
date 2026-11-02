"use strict";
const mongoose = require("mongoose"), crypto = require("node:crypto");
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), jwt = require("jsonwebtoken");
jest.mock("../ai/config", () => ({ createStructuredResponse: jest.fn(), isAiEnabled: jest.fn(() => true) }));
const ai = require("../ai/config");
const User = require("../models/User"), Case = require("../models/Case"), File = require("../models/CaseFile");
const Job = require("../models/MatterPreparationJob"), Preparation = require("../models/MatterPreparation");
const jobs = require("../services/connectedWorkspace/preparationJobs"), prep = require("../services/connectedWorkspace/preparation");
const { decryptString } = require("../utils/dataEncryption");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { generateCsrfToken } = require("../utils/csrf");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/matter-preparation", require("../routes/matterPreparation"));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code, error: error.message }));
const oid = () => new mongoose.Types.ObjectId(), quote = "Prepare a chronology for attorney review.";
let owner, para, outsider, matter, file;
const req = (body, user = owner, jobId) => ({ user: { id: String(user._id), role: user.role }, auth: { payload: { av: 0 } }, params: { caseId: String(matter._id), ...(jobId ? { jobId } : {}) }, body });
const input = patch => ({ fileIds: [String(file._id)], kind: "preparation", requestId: crypto.randomUUID(), ...patch });
const sourceReader = jest.fn(async () => ({ byteHash: "synthetic-source-hash", pages: [{ page: 1, section: null, text: "SYNTHETIC PRIVATE SOURCE TEXT" }], unreadablePages: [] }));
const propose = jest.fn(async () => ({ data: { summary: "", items: [{ title: "Prepare chronology", citations: [{ sourceId: "scope", quote }] }], questions: [], observations: [] } }));
const actualGenerate = (request, options) => prep.generate(request, { ...options, propose });
async function claim(jobId) {
  return Job.findOneAndUpdate({ _id: jobId, status: "queued" }, { $set: { status: "running", leaseToken: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true }).select("+encryptedContext").lean();
}
async function runQueuedJob(jobId, options = {}) { return jobs.processJob(await claim(jobId), { generate: actualGenerate, sourceReader, ...options }); }
const unchanged = value => Object.fromEntries(["title", "details", "tasks", "deadlineDate", "status", "attorney", "paralegal", "escrowStatus", "totalAmount", "paymentReleased"].map(field => [field, value[field]]));
beforeAll(connect); afterAll(async () => { jobs.stop(); await closeDatabase(); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); ai.isAiEnabled.mockReturnValue(true);
  [owner, para, outsider] = ["owner", "para", "outsider"].map(name => ({ _id: oid(), role: name === "para" ? "paralegal" : "attorney", status: "approved", authVersion: 0, email: name + "@preparation-jobs.test" }));
  await User.collection.insertMany([owner, para, outsider]);
  matter = { _id: oid(), title: "Synthetic durable preparation", details: quote, tasks: [{ title: "Prepare chronology", completed: false }], attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_job", totalAmount: 100000, hiredAt: new Date("2026-01-01"), __v: 0 };
  await Case.collection.insertOne(matter);
  file = await File.create({ caseId: matter._id, userId: para._id, originalName: "SYNTHETIC PRIVATE source.txt", storageKey: "cases/" + matter._id + "/documents/source.txt", mimeType: "text/plain", size: 32, uploadedByRole: "paralegal", status: "pending_review", securityStatus: "not_required" });
});
test("the job endpoint requires the current account and returns durable queued progress without running a provider", async () => {
  const token = jwt.sign({ id: String(owner._id), role: owner.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const cookie = "token=" + token, requestContext = { cookies: { token } }, responseContext = { cookie() {} };
  const csrf = generateCsrfToken(requestContext, responseContext);
  const response = await request(app).post("/api/matter-preparation/matters/" + matter._id + "/jobs").set("Cookie", cookie + "; _csrf=" + csrf).set("X-CSRF-Token", csrf).set("X-LPC-Owner-Id", String(owner._id)).send(input());
  expect(response.status).toBe(202); expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body.job).toMatchObject({ status: "queued", stage: "queued", processedFiles: 0, totalFiles: 1 });
  expect(propose).not.toHaveBeenCalled(); expect(sourceReader).not.toHaveBeenCalled();
  expect((await request(app).get("/api/matter-preparation/matters/" + matter._id + "/jobs/" + response.body.job.id)).status).toBe(401);
  expect((await request(app).get("/api/matter-preparation/matters/" + matter._id + "/jobs/" + response.body.job.id).set("Cookie", cookie).set("X-LPC-Owner-Id", String(outsider._id))).status).toBe(403);
});
test("durable context is encrypted and public progress omits source contents, storage keys, credentials and leases", async () => {
  const { job } = await jobs.create(req(input()));
  const stored = await Job.collection.findOne({ _id: new mongoose.Types.ObjectId(job.id) });
  expect(stored.encryptedContext).toMatch(/^enc:v1:/); expect(stored.encryptedContext).not.toContain("PRIVATE");
  const context = JSON.parse(decryptString(stored.encryptedContext));
  expect(context.actor.user.id).toBe(String(owner._id)); expect(context.files[0].name).toContain("PRIVATE");
  for (const key of ["encryptedContext", "leaseToken", "leaseUntil", "requestHash", "activeKey", "actor"]) expect(job).not.toHaveProperty(key);
  expect(JSON.stringify(job)).not.toContain("PRIVATE");
});
test("concurrent and fresh-identity double presses reuse one active job rather than dispatching parallel work", async () => {
  const body = input();
  const results = await Promise.all([jobs.create(req(body)), jobs.create(req(body)), jobs.create(req(input()))]);
  expect(new Set(results.map(value => value.job.id)).size).toBe(1); expect(await Job.countDocuments()).toBe(1);
  expect(propose).not.toHaveBeenCalled();
});
test("an existing request identity cannot be reassigned to different selected documents", async () => {
  const body = input(); await jobs.create(req(body));
  await expect(jobs.create(req({ ...body, fileIds: [] }))).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_REQUEST_CHANGED" });
});
test("a queued job survives reloading from storage and completes one encrypted proposal without changing authoritative work or money", async () => {
  const { job } = await jobs.create(req(input())), before = await Case.collection.findOne({ _id: matter._id });
  await runQueuedJob(job.id);
  expect((await jobs.get(req({}, owner, job.id))).job).toMatchObject({ status: "complete", stage: "complete", processedFiles: 1, retryable: false, preparationId: expect.stringMatching(/^[a-f0-9]{24}$/) });
  expect(await Preparation.countDocuments()).toBe(1); expect(sourceReader).toHaveBeenCalledTimes(1); expect(propose).toHaveBeenCalledTimes(1);
  expect(unchanged(await Case.collection.findOne({ _id: matter._id }))).toEqual(unchanged(before));
  const stored = await Job.findById(job.id).lean(); expect(stored).not.toHaveProperty("activeKey"); expect(stored).not.toHaveProperty("leaseToken");
});
test("a lost generation acknowledgement recovers the same stored proposal on deliberate retry without calling the provider again", async () => {
  const { job } = await jobs.create(req(input()));
  await runQueuedJob(job.id, { generate: async (request, options) => { await actualGenerate(request, options); throw new Error("Synthetic acknowledgement lost after persistence"); } });
  expect((await jobs.get(req({}, owner, job.id))).job).toMatchObject({ status: "failed", retryable: true, code: "PREPARATION_UNCONFIRMED" });
  const retried = await jobs.retry(req({}, owner, job.id)); expect(retried.job.id).toBe(job.id); expect(retried.job.status).toBe("queued");
  await runQueuedJob(job.id);
  expect((await jobs.get(req({}, owner, job.id))).job.status).toBe("complete");
  expect(await Preparation.countDocuments()).toBe(1); expect(propose).toHaveBeenCalledTimes(1); expect(sourceReader).toHaveBeenCalledTimes(1);
});
test("the other participant and unrelated actors cannot read a participant's durable job or reuse its retry action", async () => {
  const { job } = await jobs.create(req(input()));
  await expect(jobs.get(req({}, para, job.id))).rejects.toMatchObject({ status: 404 });
  await expect(jobs.retry(req({}, para, job.id))).rejects.toMatchObject({ status: 404 });
  await expect(jobs.get(req({}, outsider, job.id))).rejects.toMatchObject({ status: 403 });
});
test("a replaced source invalidates queued progress and fails the worker before source reading or provider dispatch", async () => {
  const { job } = await jobs.create(req(input()));
  await File.collection.updateOne({ _id: file._id }, { $set: { version: 2 } });
  await expect(jobs.get(req({}, owner, job.id))).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_SOURCE_CHANGED" });
  await runQueuedJob(job.id);
  const stored = await Job.findById(job.id).lean(); expect(stored).toMatchObject({ status: "failed", retryable: false });
  expect(sourceReader).not.toHaveBeenCalled(); expect(propose).not.toHaveBeenCalled(); expect(await Preparation.countDocuments()).toBe(0);
});
test.each([{ authVersion: 1 }, { disabled: true }])("authority revoked after queueing cannot be restored by the worker's recorded account context: %j", async patch => {
  const { job } = await jobs.create(req(input()));
  await User.collection.updateOne({ _id: owner._id }, { $set: patch }); await runQueuedJob(job.id);
  expect(await Job.findById(job.id).lean()).toMatchObject({ status: "failed", retryable: false, errorCode: "FILE_WRITE_ACCOUNT_CHANGED" });
  expect(sourceReader).not.toHaveBeenCalled(); expect(propose).not.toHaveBeenCalled(); expect(await Preparation.countDocuments()).toBe(0);
});
test("revocation while the proposal is running denies the late result instead of saving a checklist", async () => {
  const { job } = await jobs.create(req(input()));
  const lateProposal = async options => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return propose(options); };
  await runQueuedJob(job.id, { generate: (request, options) => prep.generate(request, { ...options, propose: lateProposal }) });
  expect(await Job.findById(job.id).lean()).toMatchObject({ status: "failed", retryable: false });
  expect(await Preparation.countDocuments()).toBe(0);
});
test("a lease replaced before work starts prevents the obsolete worker from generating or overwriting progress", async () => {
  const { job } = await jobs.create(req(input())), old = await claim(job.id);
  await Job.updateOne({ _id: job.id }, { $set: { leaseToken: "replacement-lease", stage: "ocr" } });
  const generate = jest.fn(); await jobs.processJob(old, { generate });
  expect(generate).not.toHaveBeenCalled();
  expect(await Job.findById(job.id).lean()).toMatchObject({ status: "running", stage: "ocr", leaseToken: "replacement-lease" });
});
test("a lease replaced during provider work cannot be marked complete or failed by the old worker", async () => {
  const { job } = await jobs.create(req(input())), old = await claim(job.id);
  await jobs.processJob(old, { generate: async () => { await Job.updateOne({ _id: job.id }, { $set: { leaseToken: "replacement-lease", stage: "ocr" } }); return { preparation: { id: String(oid()) } }; } });
  const result = await Job.findById(job.id).lean(); expect(result).toMatchObject({ status: "running", stage: "ocr", leaseToken: "replacement-lease" }); expect(result.preparationId).toBeUndefined();
});
test("OCR checkpoint storage is encrypted and retry reuses the pinned provider checkpoint", async () => {
  const { job } = await jobs.create(req(input()));
  const checkpoint = { jobId: "synthetic-provider-job", versionId: "synthetic-source-version", etag: '"synthetic-etag"' };
  const reader = jest.fn(async (_file, _s3, options) => { await options.ocr.onCheckpoint(checkpoint); throw Object.assign(new Error("Waiting for synthetic OCR"), { status: 422, publicCode: "PREPARATION_OCR_WAITING", retryable: true }); });
  await runQueuedJob(job.id, { sourceReader: reader });
  const stored = await Job.collection.findOne({ _id: new mongoose.Types.ObjectId(job.id) });
  expect(stored.encryptedContext).not.toContain(checkpoint.jobId); expect(JSON.parse(decryptString(stored.encryptedContext)).ocr[String(file._id)]).toEqual(checkpoint);
  await jobs.retry(req({}, owner, job.id));
  const resume = jest.fn(async (_file, _s3, options) => { expect(options.ocr.checkpoint).toEqual(checkpoint); return sourceReader(); });
  await runQueuedJob(job.id, { sourceReader: resume });
  expect((await jobs.get(req({}, owner, job.id))).job.status).toBe("complete"); expect(propose).toHaveBeenCalledTimes(1);
});
test("failed terminal or exhausted jobs cannot be requeued, and an in-progress retry is only a status replay", async () => {
  const { job } = await jobs.create(req(input()));
  expect((await jobs.retry(req({}, owner, job.id))).reused).toBe(true);
  await Job.updateOne({ _id: job.id }, { $set: { status: "failed", retryable: false }, $unset: { activeKey: 1 } });
  await expect(jobs.retry(req({}, owner, job.id))).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_RETRY_UNAVAILABLE" });
  await Job.updateOne({ _id: job.id }, { $set: { retryable: true, attempts: 4 } });
  expect((await jobs.get(req({}, owner, job.id))).job.retryable).toBe(false);
  await expect(jobs.retry(req({}, owner, job.id))).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_RETRY_UNAVAILABLE" });
});
test("AI unavailable and unsafe sources fail before creating a durable job", async () => {
  ai.isAiEnabled.mockReturnValue(false);
  await expect(jobs.create(req(input()))).rejects.toMatchObject({ status: 503, publicCode: "PREPARATION_AI_UNAVAILABLE" });
  ai.isAiEnabled.mockReturnValue(true); await File.collection.updateOne({ _id: file._id }, { $set: { securityStatus: "blocked" } });
  await expect(jobs.create(req(input()))).rejects.toMatchObject({ status: 423, publicCode: "PREPARATION_SOURCE_SECURITY" });
  expect(await Job.countDocuments()).toBe(0);
});
