const { reportOperationalFailure } = require("../utils/operationalFailure");
const crypto = require("crypto"), mongoose = require("mongoose");
const Lease = require("../models/MatterPresignedUpload"), Case = require("../models/Case");
const storage = require("./matterStorageRetirement");
const { encryptString, decryptString } = require("../utils/dataEncryption");
const fingerprint = key => crypto.createHash("sha256").update(key).digest("hex");
const id = value => String(value || ""), objectId = value => new mongoose.Types.ObjectId(id(value));
const fail = suffix => { throw Object.assign(new Error("This upload is no longer available for attachment. Upload the document again."), { status: 409, publicCode: `FILE_WRITE_PRESIGN_${suffix}` }); };
async function issue({ caseId, ownerId, key, bucket, expiresAt }, session) {
  if (!session?.inTransaction() || !storage.safeKey(caseId, key) || !bucket || !(expiresAt instanceof Date) || expiresAt <= new Date()) fail("INVALID");
  const [lease] = await Lease.create([{ caseId, ownerId, keyFingerprint: fingerprint(key), encryptedKey: encryptString(key), bucket, expiresAt, nextCheckAt: expiresAt }], { session }); return lease;
}
async function attach(req, key, fileId, session) {
  if (!session?.inTransaction()) throw new Error("Presigned attachment requires a transaction");
  const query = { caseId: objectId(req.params.caseId), keyFingerprint: fingerprint(key) }, lease = await Lease.collection.findOne(query, { session });
  if (!lease) return; // Earlier keys keep their existing verified-object contract.
  if (id(lease.ownerId) !== id(req.user.id) || lease.bucket !== process.env.S3_BUCKET) fail("OWNER_CHANGED");
  if (lease.status === "attached" && id(lease.attachedFileId) === id(fileId)) return;
  if (lease.status !== "issued") fail("RETIRED");
  const result = await Lease.collection.updateOne({ _id: lease._id, status: "issued", ownerId: lease.ownerId }, { $set: { status: "attached", attachedFileId: objectId(fileId), attachedAt: new Date() } }, { session }); if (result.matchedCount !== 1) fail("CHANGED");
}
function requiredHeaders(url, params) {
  const parsed = new URL(url), signed = parsed.searchParams.get("X-Amz-SignedHeaders")?.split(";") || [];
  const possible = { "content-type": params.ContentType, "if-none-match": params.IfNoneMatch, "content-disposition": params.ContentDisposition, "x-amz-server-side-encryption": params.ServerSideEncryption, "x-amz-server-side-encryption-aws-kms-key-id": params.SSEKMSKeyId, "x-amz-checksum-sha256": params.ChecksumSHA256, "x-amz-acl": params.ACL };
  if (parsed.protocol !== "https:" || !["content-type", "if-none-match", "content-length", "host"].every(name => signed.includes(name)) || signed.some(name => !["content-length", "host"].includes(name) && typeof possible[name] !== "string")) throw new Error("Conditional upload signature unavailable");
  return Object.fromEntries(signed.filter(name => !["host", "content-length"].includes(name)).map(name => [name, possible[name]]));
}
async function sweep({ now = new Date(), limit = 25 } = {}) {
  const records = await Lease.collection.find({ status: "issued", expiresAt: { $lte: now }, $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: null }, { nextCheckAt: { $lte: now } }] }).sort({ nextCheckAt: 1, expiresAt: 1, _id: 1 }).limit(Math.min(100, Math.max(0, limit))).toArray();
  let staged = 0, failed = 0;
  for (const prior of records) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      const lease = await Lease.collection.findOne({ _id: prior._id, status: "issued", expiresAt: { $lte: now } }, { session });
      if (!lease) { await session.abortTransaction(); continue; }
      const doc = await Case.collection.findOne({ _id: lease.caseId }, { session }); if (!doc) throw Object.assign(new Error("Presigned Matter unavailable"), { code: "PRESIGNED_MATTER_MISSING" });
      const guard = await Case.collection.updateOne({ _id: doc._id, __v: doc.__v === undefined ? { $exists: false } : doc.__v }, { $inc: { __v: 1 } }, { session }); if (guard.matchedCount !== 1) throw new Error("Presigned Matter changed");
      const retirementId = await storage.stage({ caseId: lease.caseId, key: decryptString(lease.encryptedKey), reason: "unattached_upload", putOutcome: "unconfirmed", now, bucket: lease.bucket }, session);
      if (!retirementId) throw new Error("Presigned storage reference unavailable");
      const saved = await Lease.collection.updateOne({ _id: lease._id, status: "issued", keyFingerprint: lease.keyFingerprint }, { $set: { status: "retired", retirementId, retiredAt: now } }, { session }); if (saved.matchedCount !== 1) throw new Error("Presigned attachment changed");
      await session.commitTransaction(); staged++;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.matterPresignedUploads.transaction_abort")); failed++;
      await Lease.collection.updateOne({ _id: prior._id, status: "issued" }, { $set: { nextCheckAt: new Date(now.getTime() + Math.min(86400000, 60000 * 2 ** Math.min(10, Number(prior.attempts || 0)))), lastErrorCode: error.code === "PRESIGNED_MATTER_MISSING" ? error.code : "PRESIGNED_RETIREMENT_UNCONFIRMED", ...(error.code === "PRESIGNED_MATTER_MISSING" ? { status: "needs_review" } : {}) }, $inc: { attempts: 1 } }).catch(reportOperationalFailure("services.matterPresignedUploads.retirement_retry_schedule"));
    } finally { await session.endSession(); }
  }
  return { scanned: records.length, staged, failed };
}
module.exports = { issue, attach, requiredHeaders, sweep };
