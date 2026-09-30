const { Types } = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User"), Block = require("../models/Block");
const applications = require("./matterApplications");
const { fingerprint } = require("./matterDraftRevision");
const { evaluatePreEngagementRequest } = require("./attorneyWorkflowPolicy");

const id = value => String(value?._id || value || "");
const refs = value => [new Types.ObjectId(id(value)), id(value)];
const text = value => typeof value === "string" ? value : "";
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const phases = new Set(["requested", "submitted", "approved", "changes_requested"]);
const fields = "attorney attorneyId title status archived readOnly paralegal paralegalId hiringClaimToken hiringClaimStatus paymentReleased relistPending pausedReason payoutFinalizedAt remainingAmount tasks applicants preEngagement __v".split(" ");
const projection = Object.fromEntries(fields.map(field => [field, 1]));
const fail = (status, code) => { throw Object.assign(new Error("The pre-engagement review could not be completed."), { status, publicCode: `PRE_ENGAGEMENT_${code}` }); };

function document(value, caseId, kind) {
  if (!value) return null;
  const key = text(value.key), prefix = `cases/${caseId}/pre-engagement/`;
  const validKey = key.startsWith(prefix) && !/[\\\x00-\x1f\x7f]/.test(key) && !key.split("/").some(part => [".", ".."].includes(part));
  return { kind, name: text(value.name) || "Confidentiality document", key: validKey ? key : null, mimeType: text(value.mimeType), size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null, uploadedAt: date(value.uploadedAt) };
}
function requestRecord(value, caseId) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) value = {};
  return {
    status: phases.has(value.status) ? value.status : "unknown",
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : value.revision == null ? 0 : null,
    applicantId: /^[a-f0-9]{24}$/i.test(id(value.requestedParalegalId)) ? id(value.requestedParalegalId) : null,
    confidentialityRequired: typeof value.confidentialityAgreementRequired === "boolean" ? value.confidentialityAgreementRequired : null,
    conflictsRequired: typeof value.conflictsCheckRequired === "boolean" ? value.conflictsCheckRequired : null,
    conflictsDetails: text(value.conflictsDetails),
    acknowledged: typeof value.confidentialityAcknowledged === "boolean" ? value.confidentialityAcknowledged : null,
    acknowledgedAt: date(value.confidentialityAcknowledgedAt),
    conflictsResponse: ["none_known", "disclosure"].includes(value.conflictsResponseType) ? value.conflictsResponseType : value.conflictsResponseType ? "unknown" : null,
    disclosure: text(value.conflictsDisclosureText), requestedAt: date(value.requestedAt), submittedAt: date(value.submittedAt), reviewedAt: date(value.reviewedAt),
    documents: [document(value.confidentialityDocument, caseId, "attorney"), document(value.paralegalConfidentialityDocument, caseId, "paralegal")].filter(Boolean),
  };
}
async function snapshot(req) {
  if (req.user?.role !== "attorney") fail(403, "RESTRICTED");
  if (typeof req.params.applicantId !== "string" || !/^[a-f0-9]{24}$/i.test(req.params.applicantId)) fail(400, "INVALID");
  const selected = await applications.selectedRecords(req);
  const facts = await Case.collection.findOne({ _id: selected.doc._id }, { projection });
  if (!facts || fingerprint([facts.preEngagement]) !== fingerprint([selected.doc.preEngagement])) fail(409, "CHANGED");
  const profile = await User.collection.findOne({ _id: new Types.ObjectId(req.params.applicantId) }, { projection: { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1 } });
  const block = await Block.collection.findOne({ active: { $ne: false }, $or: [
    { blockerId: { $in: refs(req.user.id) }, blockedId: { $in: refs(req.params.applicantId) } },
    { blockerId: { $in: refs(req.params.applicantId) }, blockedId: { $in: refs(req.user.id) } },
  ] }, { projection: { _id: 1 } });
  const available = !!profile && profile.role === "paralegal" && profile.status === "approved" && !profile.disabled && !profile.deleted && !block;
  const record = requestRecord(facts.preEngagement, id(facts._id));
  const policy = evaluatePreEngagementRequest({ caseDoc: facts, ownerAuthorized: true, targetSelected: true, partiesBlocked: !!block, confidentialityRequired: true, confidentialityDocumentReady: true });
  let reason = !available ? block ? "blocked" : "profile_unavailable" : !policy.ready || facts.readOnly || facts.paymentReleased || facts.hiringClaimToken || facts.hiringClaimStatus ? "matter_unavailable" : "ready";
  if (reason === "ready" && (!selected.mirror || !["pending", "submitted", "viewed", "shortlisted", "accepted"].includes(selected.record.status) || selected.applicationId && (!applications.mirrorStatusMatches(selected.record.status, selected.mirror.status) || ["pending", "needs_reconciliation"].includes(selected.record.syncStatus)))) reason = "application_unavailable";
  if (reason === "ready" && (facts.__v != null && (!Number.isSafeInteger(facts.__v) || facts.__v < 0) || record && (record.status === "unknown" || record.revision === null || !record.applicantId || record.confidentialityRequired === null || record.conflictsRequired === null))) reason = "request_unavailable";
  const selectedRequest = record?.applicantId === req.params.applicantId;
  const revision = fingerprint([selected.revision, facts, profile, block]);
  const dto = { caseId: req.params.caseId, ownerId: id(req.user.id), applicantId: req.params.applicantId, caseTitle: text(facts.title) || "Untitled Matter", name: available ? [text(profile.firstName), text(profile.lastName)].filter(Boolean).join(" ") || "Paralegal applicant" : "Paralegal applicant", revision, reason, selectedRequest, request: record,
    canRequest: reason === "ready" && (!record || record.status === "requested"),
    canReview: reason === "ready" && selectedRequest && record.status === "submitted",
  };
  dto.canApprove = dto.canReview && (record.confidentialityRequired || record.conflictsRequired) && (!record.confidentialityRequired || record.acknowledged === true && record.documents.some(doc => doc.kind === "attorney" && doc.key)) && (!record.conflictsRequired || record.conflictsDetails.trim().length > 0 && (record.conflictsResponse === "none_known" || record.conflictsResponse === "disclosure" && record.disclosure.trim().length > 0)) && record.documents.every(doc => !!doc.key);
  const filter = { _id: facts._id, ...Object.fromEntries(fields.map(field => [field, facts[field] === undefined ? { $exists: false } : facts[field]])) };
  return { dto, filter, facts };
}
async function readSnapshot(req) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const first = await snapshot(req), latest = await snapshot(req);
  if (first.dto.revision !== latest.dto.revision) fail(409, "CHANGED");
  return latest;
}
async function read(req) { return (await readSnapshot(req)).dto; }
async function reviewed(req, applicantId) {
  if (typeof req.body?.reviewedRevision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.reviewedRevision)) fail(400, "INVALID");
  const bound = { ...req, params: { ...req.params, applicantId }, query: { expectedOwnerId: req.body.expectedOwnerId } };
  const value = await readSnapshot(bound);
  if (value.dto.revision !== req.body.reviewedRevision) fail(409, "CHANGED");
  return value;
}
module.exports = { read, reviewed };
