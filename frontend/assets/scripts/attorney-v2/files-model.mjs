import { readDownloads } from "./download-model.mjs";
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const date = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
export function readFileReview(file) {
  if (!file || !validId(file.id) || !/^[a-f0-9]{64}$/.test(file.reviewRevision || "") || !["pending_review", "approved", "attorney_revision", "unknown"].includes(file.status) || !["attorney", "paralegal", "admin", "unknown"].includes(file.uploadedByRole) || typeof file.notes !== "string" || typeof file.mimeType !== "string" || typeof file.canReview !== "boolean" || ![file.requestedAt, file.approvedAt, file.replacedAt].every(date) || file.revisionOf !== null && (!validId(file.revisionOf?.id) || !date(file.revisionOf.requestedAt) || file.revisionOf.version !== null && (!Number.isSafeInteger(file.revisionOf.version) || file.revisionOf.version < 1))) throw new Error("invalid_file_review");
  if (file.canReview && (file.uploadedByRole !== "paralegal" || !["clean", "not_required"].includes(file.securityStatus) || file.status === "unknown")) throw new Error("invalid_file_actions");
  return file;
}
export function readFiles(value, caseId, ownerId, expectedFilters) {
  readDownloads(value, caseId, ownerId);
  if (typeof value.canUpload !== "boolean" || !["none", "found", "unavailable"].includes(value.selection) || (value.selection === "found") !== Boolean(value.selectedFile)) throw new Error("invalid_file_selection");
  if (value.total !== undefined && (!Number.isSafeInteger(value.total) || value.total < value.files.length || value.total > 10000)) throw new Error('invalid_file_total');
  if (value.filters) { const filters=value.filters;if(typeof filters.q !== 'string' || filters.q.length>200 || /[\x00-\x1f\x7f]/.test(filters.q) || !['all','pending_review','approved','attorney_revision','shared','security_pending','security_blocked'].includes(filters.status) || !['newest','oldest','name'].includes(filters.sort) || expectedFilters && ['q','status','sort'].some(key=>filters[key]!==expectedFilters[key]))throw new Error('invalid_file_filters'); }
  if(value.counts && (!['total','awaitingReview','revisions','approved'].every(key=>Number.isSafeInteger(value.counts[key]) && value.counts[key]>=0 && value.counts[key]<=10000) || value.counts.total < value.total || ['awaitingReview','revisions','approved'].some(key=>value.counts[key]>value.counts.total)))throw new Error('invalid_file_counts');
  value.files.forEach(readFileReview);
  if (value.selectedFile) {
    readDownloads({ ...value, files: [value.selectedFile], nextCursor: null }, caseId, ownerId); readFileReview(value.selectedFile);
  }
  return value;
}
export const fileStatus = file => file.uploadedByRole !== "paralegal" ? "Shared document" : ({ pending_review: "Awaiting attorney review", approved: "Approved", attorney_revision: "Revisions requested", unknown: "Review status not recorded" })[file.status];
export const previewType = file => ({ "application/pdf": "pdf", "image/png": "image", "image/jpeg": "image", "image/gif": "image", "text/plain": "text", "text/csv": "text" })[file.mimeType.toLowerCase()] || null;
export const reviewError = error => error.status === 409 ? "The document or Matter changed. Refresh Files before making another decision." : error.status === 423 ? "The document did not pass its current security check. Refresh Files to check its status." : "This document decision could not be confirmed. Check the saved review before trying again.";
