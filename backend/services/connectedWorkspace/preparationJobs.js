"use strict";
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Job = require("../../models/MatterPreparationJob");
const writes = require("../matterFileWrites");
const prep = require("./preparation");
const { isAiEnabled } = require("../../ai/config");
const { encryptString, decryptString } = require("../../utils/dataEncryption");
const id = value => String(value?._id || value || "");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status, suffix, message) => { throw Object.assign(new Error(message), { status, publicCode: "PREPARATION_" + suffix }); };
const encode = value => encryptString(JSON.stringify(value), { plaintext: true });
const decode = record => JSON.parse(decryptString(record.encryptedContext));
const active = new Set();
let timer, ticking = false;
function shape(record) {
  if (!record) return null;
  return { id: id(record), kind: record.kind, status: record.status, stage: record.stage, processedFiles: record.processedFiles, totalFiles: record.totalFiles, preparationId: record.preparationId ? id(record.preparationId) : null, error: record.errorMessage || null, code: record.errorCode || null, retryable: Boolean(record.retryable && record.attempts < 4), createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function actorContext(req) { return { user: { id: id(req.user.id), role: req.user.role }, auth: { payload: { av: Number(req.auth?.payload?.av || 0) } }, authSessionId: req.authSessionId ? id(req.authSessionId) : null }; }
function ownQuery(req, matter) { return { caseId: matter._id, assignmentKey: prep.assignmentKey(matter), createdBy: req.user.id }; }
function activeKey(record) { return [id(record.caseId), record.assignmentKey, id(record.createdBy)].join(":"); }
async function snapshot(req, context) {
  const matter = await writes.read(req);
  if (prep.scopeHash(matter) !== context.scopeHash) fail(409, "SOURCE_CHANGED", "The agreed scope or assignment changed. Start a fresh preparation.");
  await prep.assertSnapshot(req, matter, context.files);
  return matter;
}
async function latest(req, matter) {
  return shape(await Job.findOne(ownQuery(req, matter)).sort({ createdAt: -1 }).lean());
}
async function create(req) {
  const input = prep.requestSchema.safeParse(req.body);
  if (!input.success) fail(400, "INVALID", "Choose up to eight documents and start a new preparation request.");
  if (!isAiEnabled()) fail(503, "AI_UNAVAILABLE", "Document preparation is not available yet. Your documents remain available in Files.");
  const matter = await writes.read(req), all = await prep.fileRecords(req, matter);
  const selected = input.data.fileIds.map(fileId => all.find(file => id(file) === fileId));
  if (new Set(input.data.fileIds).size !== selected.length || selected.some(file => !file)) fail(404, "SOURCE_UNAVAILABLE", "A selected document is no longer available.");
  if (selected.some(file => !["clean", "not_required"].includes(file.securityStatus))) fail(423, "SOURCE_SECURITY", "Selected documents must pass their security checks before preparation.");
  const files = selected.map(prep.fileShape), scopeHash = prep.scopeHash(matter);
  const requestHash = hash([input.data.kind, input.data.fileIds, files.map(file => file.revision), scopeHash]);
  const query = { ...ownQuery(req, matter), requestId: input.data.requestId };
  await Job.init();
  let record = await Job.findOne(query).lean();
  if (!record) {
    // One active request per participant and Matter keeps double presses and
    // lost acknowledgements from opening parallel provider jobs.
    const running = await Job.findOne({ ...ownQuery(req, matter), status: { $in: ["queued", "running"] } }).lean();
    if (running) { await snapshot(req, { scopeHash, files }); return { job: shape(running), reused: true }; }
    try {
      record = (await Job.create({ ...query, activeKey: activeKey(query), requestHash, kind: input.data.kind, totalFiles: files.length, encryptedContext: encode({ actor: actorContext(req), input: input.data, scopeHash, files, ocr: {} }) })).toObject();
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await Job.findOne(query).lean();
      if (!record) { const running = await Job.findOne({ activeKey: activeKey(query) }).lean(); if (running) return { job: shape(running), reused: true }; }
    }
  }
  if (!record || record.requestHash !== requestHash) fail(409, "REQUEST_CHANGED", "This request belongs to different source documents. Start a new preparation.");
  await snapshot(req, { scopeHash, files });
  kick();
  return { job: shape(record), reused: record.status !== "queued" };
}
async function get(req) {
  const matter = await writes.read(req);
  if (!/^[a-f0-9]{24}$/i.test(req.params.jobId || "")) fail(404, "JOB_UNAVAILABLE", "This preparation request is unavailable.");
  const record = await Job.findOne({ ...ownQuery(req, matter), _id: req.params.jobId }).select("+encryptedContext").lean();
  if (!record) fail(404, "JOB_UNAVAILABLE", "This preparation request is unavailable.");
  await snapshot(req, decode(record));
  if (["queued", "running"].includes(record.status)) kick();
  return { job: shape(record) };
}
async function retry(req) {
  const matter = await writes.read(req);
  if (!/^[a-f0-9]{24}$/i.test(req.params.jobId || "")) fail(404, "JOB_UNAVAILABLE", "This preparation request is unavailable.");
  const record = await Job.findOne({ ...ownQuery(req, matter), _id: req.params.jobId }).select("+encryptedContext").lean();
  if (!record) fail(404, "JOB_UNAVAILABLE", "This preparation request is unavailable.");
  const context = decode(record); await snapshot(req, context);
  if (record.status !== "failed") return { job: shape(record), reused: true };
  if (!record.retryable || record.attempts >= 4) fail(409, "RETRY_UNAVAILABLE", "Choose fresh source documents and start a new preparation.");
  context.actor = actorContext(req);
  let saved;
  try { saved = await Job.findOneAndUpdate({ _id: record._id, status: "failed", attempts: record.attempts }, { $set: { status: "queued", stage: "queued", activeKey: activeKey(record), encryptedContext: encode(context), retryable: false }, $unset: { errorCode: 1, errorMessage: 1, leaseToken: 1, leaseUntil: 1 } }, { new: true }).lean(); }
  catch (error) { if (error.code !== 11000) throw error; fail(409, "JOB_ACTIVE", "Another preparation is already running. Check its progress before retrying."); }
  kick(); return { job: shape(saved || await Job.findById(record._id).lean()) };
}
async function processJob(record, { generate = prep.generate, sourceReader = prep.readSource, s3 } = {}) {
  const context = decode(record), req = { ...context.actor, params: { caseId: id(record.caseId) }, body: context.input };
  const token = record.leaseToken, guarded = { _id: record._id, leaseToken: token, status: "running" };
  let stopped = false;
  async function progress(value = {}) {
    if (stopped) fail(409, "JOB_REPLACED", "This preparation is continuing in another worker.");
    await snapshot(req, context);
    const result = await Job.updateOne(guarded, { $set: { ...value, leaseUntil: new Date(Date.now() + 120000) } });
    if (result.matchedCount !== 1) { stopped = true; fail(409, "JOB_REPLACED", "This preparation is continuing in another worker."); }
  }
  const heartbeat = setInterval(() => { void progress().catch(() => { stopped = true; }); }, 30000); heartbeat.unref?.();
  try {
    await progress({ stage: "reading", processedFiles: 0 });
    const result = await generate(req, {
      onProgress: progress,
      sourceReader: file => sourceReader(file, s3, { ocr: { requestKey: id(record), checkpoint: context.ocr?.[id(file)], onPoll: () => progress({ stage: "ocr" }), onCheckpoint: async checkpoint => { context.ocr ||= {}; context.ocr[id(file)] = checkpoint; await progress({ stage: "ocr", encryptedContext: encode(context) }); } }, onOcr: () => progress({ stage: "ocr" }) }),
    });
    await progress();
    await Job.updateOne(guarded, { $set: { status: "complete", stage: "complete", processedFiles: record.totalFiles, preparationId: result.preparation.id, retryable: false }, $unset: { leaseUntil: 1, leaseToken: 1, activeKey: 1 } });
  } catch (error) {
    const authorityLost = error.status === 403 || error.status === 404 || /(?:SOURCE_CHANGED|CHANGED|ACCOUNT_CHANGED|RESTRICTED)$/.test(error.publicCode || "");
    const retryable = !authorityLost && (error.retryable === true || !error.publicCode || error.status >= 500 || error.status === 429);
    await Job.updateOne(guarded, { $set: { status: "failed", stage: "failed", retryable, errorCode: error.publicCode || "PREPARATION_UNCONFIRMED", errorMessage: error.publicCode ? error.message : "The preparation could not be confirmed. Retry to recover the same request." }, $unset: { leaseUntil: 1, leaseToken: 1, activeKey: 1 } });
  } finally { clearInterval(heartbeat); }
}
async function tick() {
  if (ticking || mongoose.connection.readyState !== 1) return;
  ticking = true;
  try {
    while (active.size < 2) {
      const record = await Job.findOneAndUpdate({ $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lt: new Date() } }] }, { $set: { status: "running", leaseToken: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } }).select("+encryptedContext").lean();
      if (!record) break;
      const key = id(record); active.add(key);
      void processJob(record).catch(() => { /* The expired lease remains recoverable after a database interruption. */ }).finally(() => { active.delete(key); kick(); });
    }
  } finally { ticking = false; }
}
function kick() { if (process.env.NODE_ENV !== "test") void tick().catch(() => {}); }
function start() { if (!timer) { timer = setInterval(kick, 15000); timer.unref(); kick(); } }
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { create, get, retry, latest, shape, processJob, tick, start, stop };
