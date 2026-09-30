const { reportOperationalFailure } = require("../utils/operationalFailure");
const retirement = require("./matterStorageRetirement");
const crypto = require("crypto"), mongoose = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User"), CaseFile = require("../models/CaseFile"), Upload = require("../models/MatterFileUpload");
const { findActiveSession } = require("./authSessionService"), { fingerprint } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState"), { decryptCaseFilePayload } = require("../utils/dataEncryption");
const { isRecordVisibleToCurrentAssignment } = require("../utils/matterAssignmentVisibility");
const id = value => String(value?._id || value || ""), valid = value => /^[a-f0-9]{24}$/i.test(id(value));
const fields = ["attorney", "attorneyId", "paralegal", "paralegalId", "status", "escrowIntentId", "escrowStatus", "paymentReleased", "archived", "readOnly", "purgedAt", "paralegalAccessRevokedAt", "withdrawnParalegalId", "hiredAt", "completionClaimStatus", "completionClaimToken", "hiringClaimStatus", "hiringClaimToken", "__v"];
const exact = raw => ({ _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : { $eq: raw[key] }])) });
const revision = raw => fingerprint(fields.map(key => raw[key]));
function fail(status, suffix, message = "The document or Matter changed. Refresh Files before continuing.", cause) { throw Object.assign(new Error(message, { cause }), { status, publicCode: `FILE_WRITE_${suffix}` }); }
async function actor(req) {
  const userId = id(req.user?.id), role = req.user?.role;
  if (!valid(userId) || !["attorney", "paralegal"].includes(role)) fail(403, "RESTRICTED");
  const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.role !== role || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, userId)) fail(403, "ACCOUNT_CHANGED");
  return user;
}
async function read(req, session) {
  await actor(req); if (!valid(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { session }); if (!raw) fail(404, "NOT_FOUND");
  for (const pair of [[raw.attorney, raw.attorneyId], [raw.paralegal, raw.paralegalId]]) if (pair.every(Boolean) && id(pair[0]) !== id(pair[1])) fail(409, "CHANGED");
  const refs = req.user.role === "attorney" ? [raw.attorney, raw.attorneyId] : [raw.paralegal, raw.paralegalId];
  if (!refs.some(value => id(value) === id(req.user.id))) fail(403, "RESTRICTED");
  if (normalizeCaseStatus(raw.status) !== "in progress" || !(raw.paralegal || raw.paralegalId) || !raw.escrowIntentId || String(raw.escrowStatus || "").toLowerCase() !== "funded" || raw.paymentReleased || raw.archived || raw.readOnly || raw.purgedAt || raw.paralegalAccessRevokedAt) fail(403, "RESTRICTED");
  if (raw.completionClaimStatus || raw.completionClaimToken || raw.hiringClaimStatus || raw.hiringClaimToken) fail(409, "PROCESSING");
  return raw;
}
async function ready() {
  let timer;
  try { await Promise.race([Promise.all([CaseFile.init(), Upload.init()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("File record initialization incomplete")), 8000); })]); }
  finally { clearTimeout(timer); }
  const indexes = await Upload.collection.indexes();
  if (!indexes.some(value => value.unique && JSON.stringify(value.key) === JSON.stringify({ caseId: 1, ownerId: 1, requestId: 1 }))) fail(503, "UNAVAILABLE");
}
async function transact(operation) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await mongoose.startSession(); let operationFinished = false;
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      const value = await operation(session); operationFinished = true; await session.commitTransaction(); return value;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.matterFileWrites.transaction_abort"));
      // Mongo has rejected this transaction before commit. Retry only a lock
      // timeout, with fresh guards. Storage and provider dispatch stay outside;
      // audit rows and notification obligations may join the transaction.
      // A commit attempt, changed record or unknown result is never replayed.
      if (!operationFinished && error.code === 24 && error.hasErrorLabel?.("TransientTransactionError") && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1))); continue; }
      throw error;
    } finally { await session.endSession(); }
  }
}
async function run(req, initial, operation) {
  await ready(); await retirement.ready();
  try { return await transact(async session => {
    const raw = await read(req, session); if (revision(raw) !== revision(initial)) fail(409, "CHANGED");
    const guard = await Case.collection.updateOne(exact(raw), { $inc: { __v: 1 }, $set: { updatedAt: new Date() } }, { session }); if (guard.matchedCount !== 1) fail(409, "CHANGED");
    const value = await operation(session, raw); await actor(req); return value;
  }); } catch (error) {
    if (error.publicCode || error.code === 11000 || error.name === "VersionError") throw error;
    if (error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED", undefined, error);
    fail(503, "UNCONFIRMED", "The document change could not be confirmed. Refresh Files to check the saved record.", error);
  }
}
const uploadQuery = (req, requestId) => ({ caseId: new mongoose.Types.ObjectId(req.params.caseId), ownerId: new mongoose.Types.ObjectId(req.user.id), requestId });
const keyFor = (operation, token, extension) => `cases/${operation.caseId}/documents/${operation.fileId}-${token}${extension}`;
async function recorded(req, operation, doc) {
  const raw = await CaseFile.collection.findOne({ _id: operation.fileId, caseId: { $in: [doc._id, id(doc._id)] } });
  if (!raw || !isRecordVisibleToCurrentAssignment(raw, doc, { role: req.user.role, userId: req.user.id })) fail(409, "UPLOAD_REMOVED", "This upload was recorded earlier, but its document is no longer available. Refresh Files before continuing.");
  const attempt = operation.attempts?.find(value => value.token === operation.claimToken), changed = !attempt || decryptCaseFilePayload(raw).storageKey !== keyFor(operation, operation.claimToken, attempt.extension);
  return { file: raw, idempotent: true, changedSinceUpload: changed };
}
async function prepareUpload(req, doc, { name, clientUploadId = "", revisionOfFileId = "", revisionRequestAt = "", onlyRecorded = false }) {
  if (onlyRecorded && !clientUploadId) return {};
  await ready(); const requestId = clientUploadId || crypto.randomUUID(), query = uploadQuery(req, requestId), mimeType = String(req.file.mimetype || "").toLowerCase();
  const hash = crypto.createHash("sha256").update(JSON.stringify(["legacy-upload", name, mimeType, req.file.buffer.length, revisionOfFileId, revisionRequestAt])).update(req.file.buffer).digest("hex");
  let operation = await Upload.collection.findOne(query, { readConcern: { level: "majority" } });
  if (operation && (operation.fingerprint !== hash || (operation.kind || "upload") !== "upload")) fail(409, "UPLOAD_CHANGED", "This upload request already belongs to different or unverified contents. Refresh Files to review the earlier document.");
  if (operation?.status === "recorded") { const result = await recorded(req, operation, doc); await read(req); return { recorded: result }; }
  if (onlyRecorded) return {};
  if (!operation && clientUploadId) {
    const prior = await CaseFile.collection.find({ caseId: { $in: [doc._id, id(doc._id)] }, clientUploadId }).toArray();
    if (prior.some(value => id(value.userId) === id(req.user.id) || value.replacedAt || value.history?.length)) fail(409, "UPLOAD_CHANGED", "The earlier upload has no verified record of its original contents. Refresh Files before trying another upload.");
  }
  const now = new Date(), token = crypto.randomBytes(16).toString("hex"), leaseUntil = new Date(now.getTime() + 90000), suffix = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "", extension = /^\.[a-z0-9]{1,12}$/.test(suffix) ? suffix : "";
  const attempt = { token, extension, startedAt: now };
  if (!operation) {
    try { operation = (await Upload.create({ ...query, fingerprint: hash, fileId: new mongoose.Types.ObjectId(), kind: "upload", status: "uploading", claimToken: token, leaseUntil, attempts: [attempt] })).toObject(); }
    catch (error) { if (error.code === 11000) fail(409, "UPLOAD_PROCESSING"); throw error; }
  } else {
    if (operation.attempts.length >= 5 || operation.status === "uploading" && operation.leaseUntil > now) fail(409, "UPLOAD_PROCESSING");
    const claimed = await Upload.collection.updateOne({ _id: operation._id, status: operation.status, claimToken: operation.claimToken, leaseUntil: operation.leaseUntil }, { $set: { status: "uploading", claimToken: token, leaseUntil, retirementComplete: false, updatedAt: now }, $push: { attempts: attempt } });
    if (claimed.matchedCount !== 1) fail(409, "UPLOAD_PROCESSING"); operation = { ...operation, status: "uploading", claimToken: token, leaseUntil, attempts: [...operation.attempts, attempt] };
  }
  return { operation, key: keyFor(operation, token, extension) };
}
async function recordUpload(operation, session) {
  const attempt = operation.attempts.find(value => value.token === operation.claimToken);
  if (!attempt) fail(409, "UPLOAD_CHANGED");
  await retirement.assertAttachable(operation.caseId, keyFor(operation, operation.claimToken, attempt.extension), session);
  const saved = await Upload.collection.updateOne({ _id: operation._id, claimToken: operation.claimToken, status: "uploading" }, { $set: { status: "recorded", recordedAt: new Date(), updatedAt: new Date() } }, { session }); if (saved.matchedCount !== 1) fail(409, "UPLOAD_CHANGED");
}
async function unconfirmedUpload(operation, status = "unconfirmed") {
  await Upload.collection.updateOne({ _id: operation._id, claimToken: operation.claimToken, status: "uploading" }, { $set: { status, updatedAt: new Date() } }).catch(reportOperationalFailure("services.matterFileWrites.upload_recovery_marker"));
}
async function preserveUploadReceipt(raw, session) {
  if (!raw) fail(409, "CHANGED");
  if (typeof raw.clientUploadId !== "string" || !raw.clientUploadId || !valid(raw.userId) || !valid(raw.caseId)) return;
  const query = { caseId: new mongoose.Types.ObjectId(id(raw.caseId)), ownerId: new mongoose.Types.ObjectId(id(raw.userId)), requestId: raw.clientUploadId };
  const existing = await Upload.collection.findOne({ caseId: query.caseId, requestId: query.requestId, fileId: raw._id }, { session });
  if (existing) return;
  // Earlier records have no byte fingerprint. Retain their identity without
  // pretending a later replacement proves the original upload's contents.
  const now = new Date(); await Upload.create([{ ...query, fingerprint: "legacy-unverified", fileId: raw._id, kind: "upload", status: "recorded", claimToken: "legacy-unverified", leaseUntil: now, attempts: [], recordedAt: raw.createdAt && Number.isFinite(new Date(raw.createdAt).getTime()) ? new Date(raw.createdAt) : null }], { session });
}
async function recoverUpload(req, operation) {
  const saved = await Upload.collection.findOne({ _id: operation._id }, { readConcern: { level: "majority" } });
  if (!saved || saved.status !== "recorded" || saved.fingerprint !== operation.fingerprint) return null;
  const result = await recorded(req, saved, await read(req)); await actor(req); return result;
}
async function persistScan(record, key, scan) {
  const plain = decryptCaseFilePayload(record), normalized = value => String(value || "").replace(/^\/+/, "");
  if (!record?._id || normalized(plain.storageKey) !== normalized(key)) fail(409, "CHANGED");
  await CaseFile.init();
  try { await transact(async session => {
    const file = await CaseFile.collection.findOne({ _id: record._id }, { session });
    if (!file || !valid(file.caseId) || id(file.caseId) !== id(plain.caseId) || normalized(decryptCaseFilePayload(file).storageKey) !== normalized(key) || Number(file.version || 1) !== Number(plain.version || 1)) fail(409, "CHANGED");
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(id(file.caseId)) }, { session }); if (!doc || doc.purgedAt) fail(409, "CHANGED");
    const changed = file.securityStatus !== scan.status, now = new Date();
    // A changed security result must serialize with completion as well as
    // replacement. Routine checks of an unchanged result do not revise work.
    if (changed) { const guard = await Case.collection.updateOne(exact(doc), { $inc: { __v: 1 }, $set: { updatedAt: now } }, { session }); if (guard.matchedCount !== 1) fail(409, "CHANGED"); }
    const update = { securityStatus: scan.status, securityScanResult: scan.result, securityCheckedAt: now, ...(["clean", "blocked", "error"].includes(scan.status) ? { securityScannedAt: now } : {}) };
    const saved = await CaseFile.collection.updateOne({ _id: file._id, storageKey: file.storageKey, version: file.version === undefined ? { $exists: false } : file.version }, { $set: update, ...(changed ? { $inc: { __v: 1 } } : {}) }, { session });
    if (saved.matchedCount !== 1) fail(409, "CHANGED");
  }); } catch (error) {
    if (error.publicCode) throw error;
    fail(error.code === 112 || error.hasErrorLabel?.("TransientTransactionError") ? 409 : 503, "SCAN_UNCONFIRMED", undefined, error);
  }
}
function sendError(res, error) { if (!error.publicCode?.startsWith("FILE_WRITE_")) return false; res.status(error.status || 503).json({ code: error.publicCode, error: error.message, msg: error.message }); return true; }
const handle = operation => async (req, res) => { try { return await operation(req, res); } catch (error) { if (!sendError(res, error)) throw error; } };
module.exports = { read, actor, run, ready, exact, revision, prepareUpload, recordUpload, unconfirmedUpload, preserveUploadReceipt, recoverUpload, persistScan, sendError, handle };
