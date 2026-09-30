const id = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const phases = ["requested", "submitted", "approved", "changes_requested", "unknown"];
const reasons = ["ready", "blocked", "profile_unavailable", "matter_unavailable", "application_unavailable", "request_unavailable"];
const stamp = value => value === null || typeof value === "string" && Number.isFinite(new Date(value).getTime());
export function preEngagementKey(value, caseId) {
  return typeof value === "string" && value.startsWith(`cases/${caseId}/pre-engagement/`) && value.length > `cases/${caseId}/pre-engagement/`.length && !/[\\\x00-\x1f\x7f%?#]/.test(value) && !value.split("/").some(part => [".", ".."].includes(part)) ? value : null;
}
export function readPreEngagement(value, caseId, ownerId, applicantId) {
  const invalid = () => { throw new Error("invalid_pre_engagement"); };
  if (!value || !id(caseId) || !id(ownerId) || !id(applicantId) || value.caseId !== caseId || value.ownerId !== ownerId || value.applicantId !== applicantId || !revision(value.revision) || !reasons.includes(value.reason) || typeof value.caseTitle !== "string" || typeof value.name !== "string" || ["canRequest", "canReview", "canApprove", "selectedRequest"].some(key => typeof value[key] !== "boolean")) invalid();
  const request = value.request;
  if (request !== null) {
    if (!request || !phases.includes(request.status) || !(request.revision === null || Number.isSafeInteger(request.revision) && request.revision >= 0) || !(request.applicantId === null || id(request.applicantId)) || ["confidentialityRequired", "conflictsRequired", "acknowledged"].some(key => request[key] !== null && typeof request[key] !== "boolean") || ![null, "none_known", "disclosure", "unknown"].includes(request.conflictsResponse) || ["disclosure", "conflictsDetails"].some(key => typeof request[key] !== "string") || ["requestedAt", "submittedAt", "reviewedAt", "acknowledgedAt"].some(key => !stamp(request[key])) || !Array.isArray(request.documents) || request.documents.length > 2 || new Set(request.documents.map(doc => doc.kind)).size !== request.documents.length) invalid();
    if (request.documents.some(doc => !doc || !["attorney", "paralegal"].includes(doc.kind) || typeof doc.name !== "string" || typeof doc.mimeType !== "string" || !(doc.size === null || Number.isSafeInteger(doc.size) && doc.size >= 0) || !stamp(doc.uploadedAt))) invalid();
  }
  if (value.canApprove && !value.canReview || value.selectedRequest !== (request?.applicantId === applicantId) || value.canRequest && (value.reason !== "ready" || request && request.status !== "requested") || value.canReview && (value.reason !== "ready" || !value.selectedRequest || request?.status !== "submitted")) invalid();
  return { caseId, ownerId, applicantId, revision: value.revision, reason: value.reason, caseTitle: value.caseTitle, name: value.name, canRequest: value.canRequest, canReview: value.canReview, canApprove: value.canApprove, selectedRequest: value.selectedRequest, request: request ? { ...Object.fromEntries(["status", "revision", "applicantId", "confidentialityRequired", "conflictsRequired", "acknowledged", "acknowledgedAt", "conflictsResponse", "disclosure", "conflictsDetails", "requestedAt", "submittedAt", "reviewedAt"].map(key => [key, request[key]])), documents: request.documents.map(doc => ({ kind: doc.kind, name: doc.name, key: preEngagementKey(doc.key, caseId), mimeType: doc.mimeType, size: doc.size, uploadedAt: doc.uploadedAt })) } : null };
}
export const preEngagementStatus = status => ({ requested: "Awaiting the paralegal's response", submitted: "Response ready for attorney review", approved: "Pre-engagement response approved", changes_requested: "Changes requested from the paralegal", unknown: "Request status could not be verified" })[status];
export const preEngagementReason = reason => ({ blocked: "Further interaction with this paralegal is blocked.", profile_unavailable: "This paralegal's account is unavailable for pre-engagement.", matter_unavailable: "The Matter does not currently permit pre-engagement changes. Review its scope and hiring status.", application_unavailable: "This application no longer permits pre-engagement changes.", request_unavailable: "The saved request could not be verified. Its requirements cannot be changed here." })[reason] || "";
export function preEngagementError(error) {
  if (error.kind === "authentication") return "Your account could not be verified. Sign in again before reviewing pre-engagement.";
  if ([403, 404].includes(error.status)) return "This pre-engagement review or document is no longer available to your account.";
  if (error.status === 409) return "The Matter or pre-engagement response changed. Refresh the saved requirements before continuing.";
  if (error.status === 423 || error.code === "FILE_SCAN_PENDING") return "The document is awaiting its security check. Check it again before approving the response.";
  if (error.status === 422 || error.code === "FILE_SECURITY_BLOCKED") return "The document cannot be opened or approved because it did not pass its security check.";
  return "The pre-engagement request could not be confirmed. Refresh the saved requirements before continuing.";
}
export function requestProblem(draft, review) {
  if (!draft.confidentiality && !draft.conflicts) return "Choose a confidentiality agreement, a conflicts check, or both.";
  if (draft.conflicts && (!draft.details.trim() || draft.details.length > 5000)) return "Enter the parties and other details needed for the conflicts check (up to 5,000 characters).";
  if (draft.confidentiality && !draft.file && !(review.selectedRequest && review.request?.status === "requested" && review.request.documents.some(doc => doc.kind === "attorney" && doc.key))) return "Choose the confidentiality agreement to send.";
  if (draft.file && (draft.file.size < 1 || draft.file.size > 10 * 1024 * 1024 || !/\.(?:pdf|doc|docx)$/i.test(draft.file.name))) return "Choose a PDF, DOC or DOCX file up to 10 MB.";
  return "";
}
