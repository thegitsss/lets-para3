const crypto = require("crypto"), mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Removal = require("../models/MatterFileRemoval"), Task = require("../models/MatterStorageRetirement");
const downloads = require("./matterDownloads");
const files = require("./attorneyMatterFiles"), writes = require("./matterFileWrites"), storage = require("./matterStorageRetirement");
const { decryptCaseFilePayload, decryptString } = require("../utils/dataEncryption"), { fingerprint } = require("./matterDraftRevision");
const { publishCaseEvent } = require("../utils/caseEvents"), { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const id = value => String(value || ""), valid = value => /^[a-f0-9]{24}$/i.test(id(value)), uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const fail = (status, suffix) => { throw Object.assign(new Error("The document removal could not be verified. Refresh Files before continuing."), { status, publicCode: `FILE_REMOVAL_${suffix}` }); };
const revision = (raw, doc) => crypto.createHmac("sha256", process.env.JWT_SECRET).update(fingerprint([raw, writes.revision(doc), doc.files])).digest("hex");
const findFile = (req, doc, session) => CaseFile.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.fileId), caseId: { $in: [doc._id, id(doc._id)] } }, { session });
const findRemoval = (req, doc, session) => Removal.collection.findOne({ caseId: doc._id, fileId: new mongoose.Types.ObjectId(req.params.fileId) }, { session, ...(!session ? { readConcern: { level: "majority" } } : {}) });
const canRemove = doc => files.active(doc) && !doc.completionClaimToken && !doc.hiringClaimToken;
function validate(req, write = false) {
  const body = write ? req.body : req.query;
  if (!valid(req.params.fileId) || Object.keys(body || {}).some(key => !["expectedOwnerId", "requestId", ...(write ? ["reviewedRevision"] : [])].includes(key)) || (write || body?.requestId !== undefined) && !uuid(body?.requestId) || write && !/^[a-f0-9]{64}$/.test(body?.reviewedRevision || "")) fail(400, "INVALID");
}
async function outcome(record, requestId) {
  if (!record) return null;
  const tasks = await Task.collection.find({ _id: { $in: record.retirementIds || [] } }, { projection: { status: 1 } }).toArray();
  const cleanup = record.storageNeedsReview || tasks.length !== record.retirementIds?.length || tasks.some(task => task.status === "needs_review") ? "needs_review" : tasks.some(task => ["pending", "processing", "unconfirmed"].includes(task.status)) ? "pending" : tasks.some(task => task.status === "retained") ? "retained" : "deleted";
  return { status: "removed", fileId: id(record.fileId), removedAt: record.removedAt.toISOString(), exactRequest: Boolean(requestId && requestId === record.requestId), cleanup };
}
async function review(req) {
  validate(req); await storage.ready(); const doc = await files.matter(req), file = await findFile(req, doc), removed = await findRemoval(req, doc);
  const current = await files.matter(req), latest = await findFile(req, current);
  if (writes.revision(doc) !== writes.revision(current) || Boolean(file) !== Boolean(latest) || file && revision(file, doc) !== revision(latest, current)) fail(409, "CHANGED");
  const result = { caseId: id(doc._id), ownerId: id(req.user.id), file: file && downloads.policy(doc) === "available" ? files.shape(file, doc) : null, revision: file && downloads.policy(doc) === "available" ? revision(file, doc) : null, canRemove: Boolean(file && canRemove(doc) && !removed), removal: await outcome(removed, req.query.requestId) }; await files.actor(req); return result;
}
function mirrorMatches(entry, plain) {
  if (!entry || typeof entry !== "object") return false;
  const keys = [entry.storageKey, entry.key, entry.fileKey].filter(value => typeof value === "string" && value).map(decryptString);
  if (!keys.length || keys.some(key => key !== plain.storageKey)) return false;
  const ids = [entry.fileId, entry.caseFileId].filter(Boolean); if (ids.some(value => id(value) !== id(plain._id))) return false;
  const names = [entry.originalName, entry.original, entry.name, entry.filename].filter(value => typeof value === "string" && value).map(decryptString);
  return !names.some(value => value !== plain.originalName);
}
async function remove(req) {
  validate(req, true); await storage.ready(); await AuditLog.init(); const doc = await files.matter(req);
  const prior = await findRemoval(req, doc);
  if (prior) { if (id(prior.ownerId) !== id(req.user.id) || prior.requestId !== req.body.requestId || prior.reviewedRevision !== req.body.reviewedRevision) fail(409, "ALREADY_REMOVED"); const result = await outcome(prior, req.body.requestId); await files.actor(req); return { removal: result }; }
  if (!canRemove(doc)) fail(403, "RESTRICTED");
  let saved, committed = false;
  try {
    saved = await writes.run(req, doc, async (session, current) => {
      const file = await findFile(req, current, session); if (!file || revision(file, current) !== req.body.reviewedRevision) fail(409, "CHANGED");
      const plain = decryptCaseFilePayload(file), mirrors = Array.isArray(current.files) ? current.files : [];
      const removedMirrors = mirrors.filter(entry => mirrorMatches(entry, plain)), retirementIds = []; let storageNeedsReview = false;
      for (const key of [...new Set([plain.storageKey, plain.previewKey].filter(Boolean))]) {
        const task = await storage.stage({ caseId: current._id, key, reason: "document_removed", putOutcome: await storage.knownPutOutcome(current._id, key, session) }, session); if (task) retirementIds.push(task); else storageNeedsReview = true;
      }
      if (!plain.storageKey) storageNeedsReview = true;
      await writes.preserveUploadReceipt(file, session);
      const deletion = await CaseFile.collection.deleteOne(files.exact(file, [...files.fileFields, "previewKey", "previewMimeType", "previewSize"]), { session }); if (deletion.deletedCount !== 1) fail(409, "CHANGED");
      if (removedMirrors.length) await Case.collection.updateOne({ _id: current._id }, { $set: { files: mirrors.filter(entry => !mirrorMatches(entry, plain)) } }, { session });
      const [record] = await Removal.create([{ caseId: current._id, fileId: file._id, ownerId: req.user.id, requestId: req.body.requestId, reviewedRevision: req.body.reviewedRevision, snapshot: file, removedMirrors, retirementIds, storageNeedsReview, removedAt: new Date() }], { session });
      await AuditLog.create([{ actor: req.user.id, actorRole: "attorney", action: req.fileRemovalAuditAction || "case.file.remove", targetType: "case", targetId: id(current._id), case: current._id, method: req.fileRemovalAuditMethod || req.method, path: req.originalUrl?.split("?")[0], meta: { fileId: id(file._id), removalId: id(record._id) } }], { session });
      return record.toObject();
    }); committed = true;
  } catch (error) {
    // Inspect the exact durable outcome after a duplicate or lost commit response.
    // Never repeat a destructive transaction based on the network error alone.
    const recovered = await findRemoval(req, await files.matter(req));
    if (!recovered || id(recovered.ownerId) !== id(req.user.id) || recovered.requestId !== req.body.requestId || recovered.reviewedRevision !== req.body.reviewedRevision) { if (error.code === 11000) fail(409, "REQUEST_CHANGED"); throw error; }
    saved = recovered;
  }
  if (committed) { publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() }); publishCaseProjectionRefresh(doc, "matter_documents_refresh", { caseEvent: "" }); }
  const result = await outcome(saved, req.body.requestId); await files.matter(req); return { removal: result };
}
async function legacy(req, fileId) {
  // Earlier clients have no displayed revision. Bind their one request to a fresh
  // read, then use the same transactional removal and retained evidence.
  const adapted = { ...req, params: { ...req.params, fileId: id(fileId) }, method: "GET", query: { expectedOwnerId: id(req.user.id) } };
  const reviewed = await review(adapted); if (!reviewed.file) fail(404, "NOT_FOUND");
  return remove({ ...adapted, method: "POST", fileRemovalAuditMethod: req.method, fileRemovalAuditAction: req.originalUrl?.startsWith("/api/uploads/") ? "file_deleted" : "case.file.remove", body: { expectedOwnerId: id(req.user.id), requestId: crypto.randomUUID(), reviewedRevision: reviewed.revision } });
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "FILE_REMOVAL_UNAVAILABLE", error: "The document removal could not be confirmed. Check Files before trying again." });
module.exports = { review, remove, legacy, sendError, revision };
