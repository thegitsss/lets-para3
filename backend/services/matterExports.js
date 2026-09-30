const { Types } = require("mongoose");
const Case = require("../models/Case");
const User = require("../models/User");
const contents = require("./matterExportContents");
const exportReceipts = require("./matterExportReceipts");
const { buildArchiveZipFile } = require("./caseLifecycle");
const { evaluateArchiveReadiness } = require("./attorneyWorkflowPolicy");
const { normalizeCaseStatus } = require("../utils/caseState");
const { findActiveSession } = require("./authSessionService");
const { fingerprint } = require("./matterDraftRevision");

const fields = ["attorney", "attorneyId", "paralegal", "paralegalId", "attorneyNameSnapshot", "paralegalNameSnapshot", "title", "practiceArea", "details", "briefSummary", "tasks", "deadline", "deadlineDate", "status", "archived", "readOnly", "paymentReleased", "totalAmount", "lockedTotalAmount", "currency", "createdAt", "completedAt", "purgeScheduledFor", "purgedAt", "files", "preEngagement", "archiveZipKey"];
fields.push("internalNotes", "paymentIntentId", "escrowIntentId", "escrowStatus", "fundingIntegrityStatus", "withdrawalHistory", "withdrawnParalegalId", "payoutFinalizedAt", "payoutFinalizedType", "partialPayoutAmount", "payoutTransferId", "pausedAt");
const projection = Object.fromEntries(fields.map(field => [field, 1]));
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const refs = value => [new Types.ObjectId(value), value];
const fail = (status, publicCode, message) => { throw Object.assign(new Error(message), { status, publicCode }); };
async function owner(req, requireExpectedOwner) {
  req.exportSignal?.throwIfAborted();
  const actorId = String(req.user?.id || ""), caseId = req.params.caseId;
  if (!["attorney", "admin"].includes(req.user?.role)) fail(403, "EXPORT_RESTRICTED", "Only the Matter attorney or an administrator can download its archive.");
  if ((requireExpectedOwner || req.query.expectedOwnerId !== undefined) && req.query.expectedOwnerId !== actorId) fail(403, "EXPORT_ACCOUNT_CHANGED", "The signed-in account changed. Sign in again before opening the archive.");
  if (!validId(actorId) || !validId(caseId)) fail(400, "EXPORT_INVALID", "Invalid Matter.");
  const user = await User.collection.findOne({ _id: new Types.ObjectId(actorId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.role !== req.user.role || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0)) fail(403, "EXPORT_ACCOUNT_CHANGED", "This account can no longer access the archive.");
  if (req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) fail(403, "EXPORT_ACCOUNT_CHANGED", "Your session ended. Sign in again before opening the archive.");
  const doc = await Case.collection.findOne({ _id: new Types.ObjectId(caseId), ...(user.role === "admin" ? {} : { $or: [{ attorney: { $in: refs(actorId) } }, { attorneyId: { $in: refs(actorId) } }] }) }, { projection });
  if (!doc) fail(404, "EXPORT_NOT_FOUND", "This Matter is no longer available.");
  if (doc.attorney && doc.attorneyId && String(doc.attorney) !== String(doc.attorneyId)) fail(409, "EXPORT_SOURCE_INVALID", "This Matter's ownership needs review before its archive can be prepared.");
  return { doc, revision: fingerprint([fields.map(field => doc[field]), user]) };
}
function accessFor(doc) {
  const policy = evaluateArchiveReadiness({ caseDoc: doc, storageChecked: false });
  let access = "available";
  if (policy.blockers.includes("archive_purged")) access = "purged";
  else if (policy.blockers.includes("archive_retention_expired")) access = "expired";
  else if (policy.blockers.includes("archive_retention_unconfirmed")) access = "retention_unconfirmed";
  else if (!policy.applicable) access = "not_archived";
  else if (!["draft", "open", "in progress", "paused", "completed", "closed", "disputed"].includes(normalizeCaseStatus(doc.status))) access = "needs_review";
  return { access, retentionEndsAt: policy.facts.purgeScheduledFor };
}
async function snapshot(req, { requireExpectedOwner = true } = {}) {
  const initial = await owner(req, requireExpectedOwner), { doc } = initial;
  const policy = accessFor(doc); let source = null, access = policy.access;
  if (access === "available") {
    try {
      source = await contents.read(doc);
      // Attorney-only additions never enter the shared, completion-time ZIP.
      if (req.user.role === "attorney") {
        const rawNote = typeof doc.internalNotes === "string" ? doc.internalNotes : doc.internalNotes?.text;
        if (rawNote != null && typeof rawNote !== "string") fail(409, "EXPORT_SOURCE_INVALID", "The Matter notes need review.");
        source.attorneyNotes = rawNote || "";
        source.receipts = await exportReceipts.read(req, doc);
        source.counts = { ...source.counts, receipts: source.receipts.length, notes: source.attorneyNotes ? 1 : 0 };
        source.revision = fingerprint([source.revision, source.attorneyNotes, source.receipts]);
      }
    }
    catch (error) { if (error.publicCode === "EXPORT_TOO_LARGE") access = "too_large"; else if (error.publicCode === "EXPORT_SOURCE_INVALID") access = "needs_review"; else throw error; }
  }
  const current = await owner(req, requireExpectedOwner);
  if (initial.revision !== current.revision || policy.access !== accessFor(current.doc).access) fail(409, "EXPORT_CHANGED", "The Matter changed. Refresh the archive details before downloading.");
  const value = { caseId: String(doc._id), ownerId: String(req.user.id), caseTitle: doc.title || "Untitled Matter", access, retentionEndsAt: policy.retentionEndsAt, counts: source ? source.counts : null, filename: `${contents.safeName(doc.title, "Matter")}-archive.zip`, revision: source ? fingerprint([initial.revision, source.revision]) : null };
  req.exportSignal?.throwIfAborted();
  return { value, doc, source };
}
function requireAvailable(value) {
  if (value.access === "available") return;
  const code = ({ expired: "EXPORT_EXPIRED", purged: "EXPORT_PURGED", too_large: "EXPORT_TOO_LARGE" })[value.access] || "EXPORT_NOT_READY";
  fail(["expired", "purged"].includes(value.access) ? 410 : value.access === "too_large" ? 413 : 409, code, "The archive cannot be prepared from this Matter's current records. Refresh its details to review availability.");
}
async function prepare(req) {
  if (req.query.revision !== undefined && !/^[a-f0-9]{64}$/.test(req.query.revision)) fail(400, "EXPORT_INVALID", "Refresh the archive details before downloading.");
  const result = await snapshot(req, { requireExpectedOwner: false }); requireAvailable(result.value);
  if (req.query.revision !== undefined && req.query.revision !== result.value.revision) fail(409, "EXPORT_CHANGED", "The archive contents changed. Refresh the details before downloading.");
  const validate = async () => {
    const current = (await snapshot(req, { requireExpectedOwner: false })).value; requireAvailable(current);
    if (current.revision !== result.value.revision) fail(409, "EXPORT_CHANGED", "The Matter changed while the archive was being prepared. Refresh its details before downloading.");
  };
  const artifact = await buildArchiveZipFile(result.doc, { contents: result.source, signal: req.exportSignal, validate });
  return { ...artifact, value: result.value };
}
module.exports = { snapshot, prepare, accessFor };
