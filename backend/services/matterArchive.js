const { Types } = require("mongoose");
const { fingerprint, requestIdValid } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState");
const fields = ["title", "attorney", "attorneyId", "status", "archived", "readOnly", "hiredAt", "paralegal", "paralegalId", "paymentReleased", "purgedAt", "purgeScheduledFor", "hiringClaimStatus", "hiringClaimToken", "hiringClaimPaymentIntentId", "completionClaimStatus", "completionClaimToken", "withdrawalClaimStatus", "withdrawalClaimToken", "relistRequestedAt", "payoutFinalizedAt", "payoutFinalizedType", "applicants", "invites", "pendingParalegalId", "withdrawnParalegalId", "archiveReceipt"];
const exact = value => value === undefined ? { $exists: false } : { $eq: value };
const snapshot = doc => Object.fromEntries(fields.map(key => [key, exact(doc[key])]));
const revisionFor = doc => fingerprint([String(doc._id), ...fields.map(key => [key, doc[key] ?? null])]);
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, publicCode: code }); };
function policy(doc) {
  const status = normalizeCaseStatus(doc.status), archived = doc.archived === true;
  const assigned = !!(doc.paralegal || doc.paralegalId);
  const legacyReopen = archived && !status;
  const draftRestore = archived && status === "draft";
  const relisted = !!doc.relistRequestedAt || (doc.payoutFinalizedAt && ["zero_auto", "partial_attorney", "expired_zero", "admin"].includes(doc.payoutFinalizedType));
  const history = status === "paused" && !relisted;
  const restoredView = status === "draft" ? "draft" : history ? "archived" : !assigned && doc.applicants?.length ? "applications" : "active";
  const reason = doc.purgedAt || doc.purgeScheduledFor ? "retention"
    : doc.paymentReleased || ["completed", "closed"].includes(status) ? "final"
    : !["", "draft", "open", "in progress", "paused", "disputed"].includes(status) || (doc.attorney && doc.attorneyId && String(doc.attorney) !== String(doc.attorneyId)) || (doc.paralegal && doc.paralegalId && String(doc.paralegal) !== String(doc.paralegalId)) || ((legacyReopen || draftRestore) && (assigned || doc.hiredAt)) || (status === "in progress" && !assigned) ? "unsupported"
    : !archived && assigned ? "assigned"
    : (!archived || legacyReopen || draftRestore) && (doc.hiringClaimStatus || doc.hiringClaimToken || doc.hiringClaimPaymentIntentId || doc.completionClaimStatus || doc.completionClaimToken || doc.withdrawalClaimStatus || doc.withdrawalClaimToken) ? "processing"
    : !archived && history ? "history"
    : "ready";
  return { archived, status, canChange: reason === "ready", reason, targetArchived: !archived, legacyReopen, restoredView, readOnly: doc.readOnly === true };
}
function shape(doc, actorId) {
  const receipt = doc.archiveReceipt;
  return { caseId: String(doc._id), ownerId: String(actorId), caseTitle: doc.title || "Untitled Matter", revision: revisionFor(doc), ...policy(doc),
    receipt: receipt && String(receipt.by) === String(actorId) ? { requestId: receipt.requestId, revision: receipt.revision, archived: receipt.archived, at: receipt.at } : null };
}
async function read(Case, caseId, actorId, isAdmin = false) {
  const refs = [new Types.ObjectId(actorId), String(actorId)];
  const doc = await Case.collection.findOne({ _id: new Types.ObjectId(caseId), ...(isAdmin ? {} : { $or: [{ attorney: { $in: refs } }, { attorneyId: { $in: refs } }] }) }, { projection: Object.fromEntries(fields.map(key => [key, 1])) });
  if (!doc) fail(404, "ARCHIVE_NOT_FOUND", "This Matter is no longer available.");
  return doc;
}
function validate(body) {
  if (!body || Object.keys(body).some(key => !["expectedOwnerId", "revision", "requestId", "archived"].includes(key)) || typeof body.archived !== "boolean") fail(400, "ARCHIVE_INVALID", "Review whether to archive or restore this Matter.");
  if (!/^[a-f0-9]{64}$/.test(body.revision || "") || !requestIdValid(body.requestId)) fail(428, "ARCHIVE_REVIEW_REQUIRED", "Load and review the current archive status before continuing.");
}
async function change(Case, doc, actorId, body) {
  validate(body);
  if (doc.archiveReceipt?.requestId === body.requestId && String(doc.archiveReceipt.by) === String(actorId)) {
    if (doc.archiveReceipt.revision !== body.revision || doc.archiveReceipt.archived !== body.archived) fail(409, "ARCHIVE_REQUEST_REUSED", "This request belongs to a different archive review.");
    return { doc, replayed: true };
  }
  if (revisionFor(doc) !== body.revision) fail(409, "ARCHIVE_CHANGED", "This Matter changed. Review its current status before continuing.");
  const current = policy(doc);
  if (!current.canChange || current.targetArchived !== body.archived) fail(409, "ARCHIVE_UNAVAILABLE", "This archive change is no longer available. Check the current status.");
  const now = new Date();
  const changes = { archived: body.archived, updatedAt: now, archiveReceipt: { requestId: body.requestId, revision: body.revision, archived: body.archived, at: now, by: new Types.ObjectId(actorId) }, ...(current.legacyReopen ? { status: "open" } : {}) };
  const result = await Case.collection.updateOne({ _id: doc._id, ...snapshot(doc) }, { $set: changes });
  if (!result.matchedCount) fail(409, "ARCHIVE_CHANGED", "This Matter changed during your review. Check its current status.");
  return { doc: { ...doc, ...changes }, replayed: false };
}
module.exports = { fields, revisionFor, policy, shape, read, change };
