const { Types } = require("mongoose");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const { decryptCaseFilePayload } = require("../utils/dataEncryption");
const { fingerprint } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState");
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const refs = id => [new Types.ObjectId(id), String(id)];
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, publicCode: code }); };
const fileFields = { caseId: 1, originalName: 1, storageKey: 1, mimeType: 1, size: 1, version: 1, createdAt: 1, securityStatus: 1 };
function policy(doc) {
  if (doc.purgedAt) return "purged";
  const status = normalizeCaseStatus(doc.status);
  // Keep the existing signed-file authority: manual archive alone does not close files.
  if (doc.paymentReleased === true || ["completed", "closed", "disputed"].includes(status)) return "archive_only";
  return ["", "draft", "open", "paused", "in progress"].includes(status) ? "available" : "unavailable";
}
async function readOwner(req) {
  const actorId = String(req.user?.id || ""), caseId = req.params.caseId;
  try { await require("./attorneyAccountBoundary").read(req, req.query.expectedOwnerId); }
  catch (error) { if (error.publicCode) fail(403, "DOWNLOAD_ACCOUNT_CHANGED", "The signed-in account changed. Reload before continuing."); throw error; }
  if (req.user?.role !== "attorney") fail(403, "DOWNLOAD_RESTRICTED", "Only the Matter attorney can use these file downloads.");
  if (req.query.expectedOwnerId !== actorId) fail(403, "DOWNLOAD_ACCOUNT_CHANGED", "The signed-in account changed. Reload before continuing.");
  if (!validId(caseId) || !validId(actorId)) fail(400, "DOWNLOAD_INVALID", "Invalid Matter.");
  const doc = await Case.collection.findOne({ _id: new Types.ObjectId(caseId), $or: [{ attorney: { $in: refs(actorId) } }, { attorneyId: { $in: refs(actorId) } }] }, { projection: { attorney: 1, attorneyId: 1, title: 1, status: 1, paymentReleased: 1, purgedAt: 1, files: 1 } });
  if (!doc) fail(404, "DOWNLOAD_NOT_FOUND", "This Matter is no longer available.");
  if (doc.attorney && doc.attorneyId && String(doc.attorney) !== String(doc.attorneyId)) fail(403, "DOWNLOAD_RESTRICTED", "This Matter's ownership needs review.");
  return doc;
}
function revision(record) {
  const file = decryptCaseFilePayload(record);
  return fingerprint([String(file._id), String(file.caseId), file.originalName, file.storageKey, file.mimeType, file.size, file.version]);
}
function shape(record) {
  const file = decryptCaseFilePayload(record), date = file.createdAt ? new Date(file.createdAt) : null;
  return { id: String(file._id), name: typeof file.originalName === "string" && file.originalName ? file.originalName : "Unnamed file", revision: revision(record), size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null, version: Number.isSafeInteger(file.version) && file.version > 0 ? file.version : null, uploadedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, securityStatus: ["clean", "pending", "blocked", "error", "not_required"].includes(file.securityStatus) ? file.securityStatus : "unknown" };
}
async function list(req) {
  const doc = await readOwner(req), cursor = req.query.cursor;
  if (cursor !== undefined && !validId(cursor)) fail(400, "DOWNLOAD_INVALID", "Invalid file page.");
  const files = policy(doc) === "available" ? await CaseFile.collection.find({ caseId: { $in: refs(req.params.caseId) }, ...(cursor ? { _id: { $lt: new Types.ObjectId(cursor) } } : {}) }, { projection: fileFields }).sort({ _id: -1 }).limit(51).toArray() : [];
  const current = await readOwner(req), access = policy(current), visible = access === "available" ? files.slice(0, 50) : [];
  return { caseId: String(current._id), ownerId: String(req.user.id), caseTitle: current.title || "Untitled Matter", access, legacyAttachments: Array.isArray(current.files) && current.files.length > 0, files: visible.map(shape), nextCursor: access === "available" && files.length > 50 ? String(visible[49]._id) : null };
}
async function readFile(req) {
  const doc = await readOwner(req);
  if (policy(doc) !== "available") fail(403, "DOWNLOAD_CLOSED", "Individual files are unavailable. Check the Matter's archive or current workflow.");
  if (!validId(req.params.fileId) || !/^[a-f0-9]{64}$/.test(req.query.revision || "")) fail(400, "DOWNLOAD_INVALID", "Refresh the file list before downloading.");
  const record = await CaseFile.collection.findOne({ _id: new Types.ObjectId(req.params.fileId), caseId: { $in: refs(req.params.caseId) } }, { projection: fileFields });
  if (!record) fail(404, "DOWNLOAD_FILE_NOT_FOUND", "This file is no longer available.");
  if (revision(record) !== req.query.revision) fail(409, "DOWNLOAD_CHANGED", "This file changed. Refresh the list before downloading it.");
  return { doc, record, file: decryptCaseFilePayload(record) };
}
module.exports = { list, readFile, policy, shape, revision };
