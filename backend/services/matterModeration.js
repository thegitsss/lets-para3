const { fingerprint } = require("./matterDraftRevision");
const { resolveMatterDeadlineDate } = require("../utils/businessDate");
const PUBLIC_FIELDS = "title details practiceArea state locationState experiencePreference minimumYearsExperience totalAmount deadline deadlineDate tasks requirements";
const FIELDS = ["attorney", "attorneyId", "flags", "archived", "status", "readOnly", "moderationStatus", "moderationFlaggedAt", "moderationFlaggedBy", "moderationResolutionRequestedAt", "moderationResolutionRequestedBy", "moderationPostingBaseline", "moderationEditRequest", "moderationReviewReceipt"];
function postingFingerprint(doc) {
  // Task completion, applications, notes and other workspace activity do not edit a posting.
  return fingerprint([doc.title || "", doc.details || "", doc.practiceArea || "", doc.state || doc.locationState || "", doc.experiencePreference || "", Number(doc.minimumYearsExperience || 0), Number(doc.totalAmount || 0), resolveMatterDeadlineDate(doc) || "", (doc.tasks || []).map(task => typeof task === "string" ? task : task.title || ""), doc.requirements || []]);
}
const hasRevision = doc => /^[a-f0-9]{64}$/.test(doc?.moderationPostingBaseline || "") && postingFingerprint(doc) !== doc.moderationPostingBaseline;
const revisionFor = doc => fingerprint([String(doc._id), FIELDS.map(key => doc[key] ?? null), postingFingerprint(doc)]);
function shape(doc, ownerId) {
  const status = ["none", "flagged", "resolution_requested"].includes(doc.moderationStatus || "none") ? (doc.moderationStatus || "none") : "unavailable";
  const reason = doc.archived ? "archived" : doc.readOnly ? "read_only" : status === "unavailable" ? "unavailable" : status === "none" ? "no_request" : status === "resolution_requested" ? "awaiting_review" : !hasRevision(doc) ? (doc.moderationPostingBaseline ? "edit_required" : "legacy_edit_required") : "ready";
  return { caseId: String(doc._id), ownerId, caseTitle: doc.title || "Untitled Matter", status, revision: revisionFor(doc), canRequestReview: reason === "ready", reason,
    feedback: typeof doc.moderationEditRequest === "string" && status !== "none" ? doc.moderationEditRequest : "",
    flaggedAt: doc.moderationFlaggedAt || null, requestedAt: doc.moderationResolutionRequestedAt || null,
    receipt: doc.moderationReviewReceipt?.requestId ? { requestId: doc.moderationReviewReceipt.requestId, revision: doc.moderationReviewReceipt.revision, requestedAt: doc.moderationReviewReceipt.requestedAt } : null };
}
module.exports = { PUBLIC_FIELDS, FIELDS, postingFingerprint, hasRevision, revisionFor, shape };
