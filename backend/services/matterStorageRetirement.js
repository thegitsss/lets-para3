const { reportOperationalFailure } = require("../utils/operationalFailure");
const PresignedUpload = require("../models/MatterPresignedUpload");
const crypto = require("crypto"), mongoose = require("mongoose");
const Task = require("../models/MatterStorageRetirement"), Removal = require("../models/MatterFileRemoval"), Upload = require("../models/MatterFileUpload"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Message = require("../models/Message");
const { encryptString, decryptString, isEncrypted } = require("../utils/dataEncryption");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3"), { createS3Client } = require("../utils/s3Client");
const id = value => String(value || ""), objectId = value => new mongoose.Types.ObjectId(id(value));
const queryFor = caseId => ({ caseId: { $in: [objectId(caseId), id(caseId)] } });
const digest = key => crypto.createHash("sha256").update(key).digest("hex");
const { isRecordVisibleToCurrentAssignment } = require("../utils/matterAssignmentVisibility");
const day = 86400000;
function safeKey(caseId, key) {
  return typeof key === "string" && /^[a-f0-9]{24}$/.test(id(caseId)) && key.startsWith(`cases/${caseId}/`) && new RegExp(`^cases/${caseId}/(?:documents|previews)/[^\\s\\\\?#%]+$`).test(key) && !key.split("/").some(part => !part || part === "." || part === "..") ? key : "";
}
async function ready() {
  let timer;
  try { await Promise.race([Promise.all([Task.init(), Removal.init(), PresignedUpload.init()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Matter storage records unavailable")), 8000); })]); } finally { clearTimeout(timer); }
  for (const [model, key] of [[PresignedUpload, { caseId: 1, keyFingerprint: 1 }], [Task, { caseId: 1, keyFingerprint: 1 }], [Removal, { ownerId: 1, requestId: 1 }], [Removal, { caseId: 1, fileId: 1 }]]) {
    if (!(await model.collection.indexes()).some(index => index.unique && JSON.stringify(index.key) === JSON.stringify(key))) throw new Error("Matter storage boundary unavailable");
  }
}
async function retired(caseId, key, session) { return typeof key === "string" && Boolean(await Task.collection.findOne({ caseId: objectId(caseId), keyFingerprint: digest(key) }, { session, projection: { _id: 1 } })); }
async function assertAttachable(caseId, key, session) {
  if (!safeKey(caseId, key) || await retired(caseId, key, session)) throw Object.assign(new Error("This stored copy is no longer available for a new attachment. Upload the document again."), { status: 409, publicCode: "FILE_WRITE_RETIRED" });
}
// Call only inside the transaction that fences the Case and retires its current
// reference or upload attempt. Permanent tombstones stop later reattachment.
async function stage({ caseId, key, reason, putOutcome = "unconfirmed", uploadId = null, attemptToken = "", now = new Date(), bucket: issuedBucket }, session) {
  if (!session?.inTransaction()) throw new Error("Matter storage retirement requires a transaction");
  if (typeof key !== "string" || !key) return null;
  const scoped = Boolean(safeKey(caseId, key));
  const query = { caseId: objectId(caseId), keyFingerprint: digest(key) };
  const existing = await Task.collection.findOne(query, { session }); if (existing) return existing._id;
  const bucket = String(issuedBucket === undefined ? process.env.S3_BUCKET || "" : issuedBucket).trim();
  const [task] = await Task.create([{ ...query, encryptedKey: encryptString(key), bucket: bucket || "unconfigured", reason, putOutcome, uploadId, attemptToken, nextCheckAt: now, status: bucket && scoped ? "pending" : "needs_review", lastErrorCode: !scoped ? "STORAGE_KEY_NEEDS_REVIEW" : bucket ? "" : "STORAGE_BUCKET_UNCONFIGURED" }], { session });
  return task._id;
}
function contains(value, key, depth = 0, field = "") {
  if (depth > 40) throw new Error("REFERENCE_DEPTH_UNAVAILABLE");
  if (typeof value === "string") {
    if (!["storageKey", "previewKey", "fileKey", "key", "url", "downloadUrl", "history", "files"].includes(field)) return false;
    const plain = decryptString(value); if (isEncrypted(plain)) throw new Error("REFERENCE_DECRYPTION_UNAVAILABLE");
    if (plain.replace(/^\/+/, "") === key) return true;
    if (/^https?:\/\//i.test(plain)) { try { return decodeURIComponent(new URL(plain).pathname).replace(/^\/+/, "") === key; } catch { throw new Error("REFERENCE_INVENTORY_UNAVAILABLE"); } }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => contains(item, key, depth + 1, field));
  if (value && typeof value === "object" && !value._bsontype && !(value instanceof Date) && !Buffer.isBuffer(value)) return Object.entries(value).some(([name, item]) => contains(item, key, depth + 1, name));
  return false;
}
const withoutCurrentKeys = value => value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !["storageKey", "previewKey", "key", "fileKey"].includes(key))) : value;
async function referenced(caseId, key, { limit = 10000, viewer = null } = {}) {
  const doc = await Case.collection.findOne({ _id: objectId(caseId) });
  if (!doc) throw new Error("MATTER_NOT_FOUND");
  if (doc.purgedAt) return false;
  // Inspect the complete retained containers, including earlier aliases and
  // unknown fields. An incomplete inventory must never authorize deletion.
  if (contains(viewer ? (doc.files || []).filter(entry => isRecordVisibleToCurrentAssignment(entry, doc, viewer)) : doc.files, key)) return true;
  for (const model of [CaseFile, Message, Removal]) {
    let count = 0; const cursor = model.collection.find(queryFor(caseId)).limit(limit + 1);
    try { for await (const raw of cursor) {
      if (++count > limit) throw new Error("REFERENCE_INVENTORY_UNAVAILABLE");
      if (viewer && !isRecordVisibleToCurrentAssignment(model === Removal ? raw.snapshot : raw, doc, viewer)) continue;
      const value = model === Removal ? [withoutCurrentKeys(raw.snapshot), ...(raw.removedMirrors || []).map(withoutCurrentKeys)] : raw;
      if (contains(value, key)) return true;
    } } finally { await cursor.close(); }
  }
  return false;
}
async function knownPutOutcome(caseId, key, session) {
  if (typeof key !== "string") return "unconfirmed";
  const prefix = `cases/${caseId}/documents/`;
  if (!key.startsWith(prefix)) return "unconfirmed";
  const match = key.slice(prefix.length).match(/^([a-f0-9]{24})-([a-f0-9]{32})((?:\.[a-z0-9]{1,12})?)$/);
  if (!match) return "unconfirmed";
  const operation = await Upload.collection.findOne({ caseId: objectId(caseId), fileId: objectId(match[1]), status: "recorded", claimToken: match[2], attempts: { $elemMatch: { token: match[2], extension: match[3], putOutcome: "uploaded" } } }, { session });
  return operation ? "uploaded" : "unconfirmed";
}
async function settleAttempt(operation, putOutcome) {
  const now = new Date();
  // A late acknowledgement belongs to its original attempt, never the current
  // claim. Unknown provider outcomes remain eligible for recurring cleanup.
  await Upload.collection.updateOne({ _id: operation._id, "attempts.token": operation.claimToken }, { $set: { "attempts.$.putOutcome": putOutcome, "attempts.$.settledAt": now } });
  if (putOutcome === "uploaded") await Task.collection.updateMany({ uploadId: operation._id, attemptToken: operation.claimToken }, { $set: { putOutcome: "uploaded" } });
}
async function sweepUploads({ now = new Date(), limit = 25 } = {}) {
  const records = await Upload.collection.find({ retirementComplete: { $ne: true }, $or: [{ status: { $ne: "uploading" } }, { leaseUntil: { $lte: now } }], $and: [{ $or: [{ retirementCheckedAt: { $exists: false } }, { retirementCheckedAt: { $lte: new Date(now.getTime() - 60000) } }] }] }).sort({ retirementCheckedAt: 1, _id: 1 }).limit(limit).toArray();
  let staged = 0, failed = 0;
  for (const prior of records) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      const operation = await Upload.collection.findOne({ _id: prior._id }, { session });
      if (!operation || operation.status === "uploading" && operation.leaseUntil > now) { await session.abortTransaction(); continue; }
      const attempts = (operation.attempts || []).filter(attempt => !(operation.status === "recorded" && attempt.token === operation.claimToken));
      if (!attempts.length && !operation.retiredPreviewKey && operation.status === "recorded") {
        await Upload.collection.updateOne({ _id: operation._id, status: "recorded", claimToken: operation.claimToken }, { $set: { retirementCheckedAt: now, retirementComplete: true } }, { session });
        await session.commitTransaction(); continue;
      }
      const doc = await Case.collection.findOne({ _id: operation.caseId }, { session }); if (!doc) throw new Error("MATTER_NOT_FOUND");
      const guarded = await Case.collection.updateOne({ _id: doc._id, __v: doc.__v === undefined ? { $exists: false } : doc.__v }, { $inc: { __v: 1 } }, { session }); if (guarded.matchedCount !== 1) throw new Error("MATTER_CHANGED");
      // This write invalidates an expired upload claim before cleanup can run.
      const fenced = await Upload.collection.updateOne({ _id: operation._id, claimToken: operation.claimToken, status: operation.status, leaseUntil: operation.leaseUntil }, { $set: { retirementCheckedAt: now, retirementComplete: true, ...(operation.status === "uploading" ? { status: "unconfirmed" } : {}) } }, { session }); if (fenced.matchedCount !== 1) throw new Error("UPLOAD_CHANGED");
      let count = 0;
      for (const attempt of attempts) {
        if (operation.status === "recorded" && attempt.token === operation.claimToken) continue;
        if (!/^[a-f0-9]{32}$/.test(attempt.token || "") || !/^(?:\.[a-z0-9]{1,12})?$/.test(attempt.extension || "")) continue;
        if (await stage({ caseId: operation.caseId, key: `cases/${operation.caseId}/documents/${operation.fileId}-${attempt.token}${attempt.extension || ""}`, reason: "upload_attempt", putOutcome: attempt.putOutcome === "uploaded" ? "uploaded" : "unconfirmed", uploadId: operation._id, attemptToken: attempt.token, now }, session)) count++;
      }
      if (operation.retiredPreviewKey && await stage({ caseId: operation.caseId, key: decryptString(operation.retiredPreviewKey), reason: "preview_replaced", now }, session)) count++;
      await session.commitTransaction(); staged += count;
    } catch { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.matterStorageRetirement.transaction_abort")); failed++; } finally { await session.endSession(); }
  }
  return { scanned: records.length, staged, failed };
}
async function processMatterStorageRetirements({ now = new Date(), limit = 25 } = {}, { s3 = createS3Client(), env = process.env } = {}) {
  limit = Math.min(100, Math.max(0, Number.isSafeInteger(limit) ? limit : 25));
  await ready(); const reconciliation = await sweepUploads({ now, limit });
  const presigned = await require("./matterPresignedUploads").sweep({ now, limit });
  const totals = { ...reconciliation, presigned, failed: reconciliation.failed + presigned.failed, deleted: 0, retained: 0, unconfirmed: 0, needsReview: 0, retried: 0 };
  for (let index = 0; index < Math.min(100, Math.max(0, limit)); index++) {
    const claimToken = crypto.randomUUID();
    const task = await Task.collection.findOneAndUpdate({ $or: [{ status: { $in: ["pending", "retained", "unconfirmed"] }, nextCheckAt: { $lte: now } }, { status: "processing", leaseUntil: { $lte: now } }] }, { $set: { status: "processing", claimToken, leaseUntil: new Date(now.getTime() + 600000) }, $inc: { attempts: 1 } }, { returnDocument: "after", sort: { nextCheckAt: 1, _id: 1 } });
    if (!task) break;
    const query = { _id: task._id, status: "processing", claimToken }; let change;
    try {
      const key = decryptString(task.encryptedKey);
      if (!safeKey(task.caseId, key) || digest(key) !== task.keyFingerprint || !env.S3_BUCKET || task.bucket !== env.S3_BUCKET) { change = { status: "needs_review", lastErrorCode: "STORAGE_BOUNDARY_CHANGED" }; totals.needsReview++; }
      else if (await referenced(task.caseId, key)) { change = { status: "retained", retainedAt: now, nextCheckAt: new Date(now.getTime() + day), lastErrorCode: "" }; totals.retained++; }
      else {
        await s3.send(new DeleteObjectCommand({ Bucket: task.bucket, Key: key }));
        const confirmed = task.putOutcome === "uploaded";
        change = { status: confirmed ? "deleted" : "unconfirmed", deletedAt: confirmed ? now : null, nextCheckAt: new Date(now.getTime() + day), lastErrorCode: "" }; totals[confirmed ? "deleted" : "unconfirmed"]++;
      }
    } catch (error) {
      const inventory = ["MATTER_NOT_FOUND", "REFERENCE_DEPTH_UNAVAILABLE", "REFERENCE_INVENTORY_UNAVAILABLE", "REFERENCE_DECRYPTION_UNAVAILABLE"].includes(error.message);
      change = { status: inventory ? "needs_review" : "pending", lastErrorCode: inventory ? error.message : "STORAGE_CHECK_UNCONFIRMED", nextCheckAt: new Date(now.getTime() + Math.min(day, 60000 * 2 ** Math.min(10, task.attempts))) }; totals[inventory ? "needsReview" : "retried"]++;
    }
    await Task.collection.updateOne(query, { $set: { ...change, leaseUntil: null, claimToken: "", updatedAt: now } });
  }
  return totals;
}
module.exports = { ready, safeKey, retired, assertAttachable, stage, referenced, knownPutOutcome, settleAttempt, sweepUploads, processMatterStorageRetirements };
