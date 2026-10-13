import { readFileReview } from "./files-model.mjs";
export const uploadAccept = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg,.gif";
export const uploadSize = bytes => bytes < 1024 ? `${bytes.toLocaleString()} bytes` : `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
export function selectionError(file) {
  if (!file || !file.size) return "Choose a document containing at least one byte.";
  if (file.size > 20 * 1024 * 1024) return "Choose a document no larger than 20 MB.";
  if (!uploadAccept.split(",").some(extension => file.name.toLowerCase().endsWith(extension))) return "Choose a PDF, Office document, text file, CSV or supported image.";
  return "";
}
export function readUpload(value) {
  if (!value || !Object.hasOwn(value, "file") || !["missing", "uploading", "failed", "unconfirmed", "recorded"].includes(value.status) || typeof value.retryAllowed !== "boolean" || value.file !== null && value.status !== "recorded" || value.status === "recorded" && value.retryAllowed || value.changedSinceUpload !== undefined && (typeof value.changedSinceUpload !== "boolean" || value.changedSinceUpload && (!value.file || value.status !== "recorded"))) throw new Error("invalid_upload_outcome");
  if (value.file) readFileReview(value.file);
  return value;
}
export function readReplacementReview(value, caseId, ownerId, fileId) {
  readUploadReview(value, caseId, ownerId);
  if (!Object.hasOwn(value, "target") || value.canUpload && !value.target || value.target && value.target.id !== fileId) throw new Error("invalid_replacement_target");
  if (value.target) readFileReview(value.target);
  return value;
}
export function readUploadReview(value, caseId, ownerId) {
  if (!value || value.caseId !== caseId || value.ownerId !== ownerId || !/^[a-f0-9]{64}$/.test(value.revision || "") || typeof value.canUpload !== "boolean") throw new Error("invalid_upload_review");
  if (value.upload !== null) readUpload(value.upload);
  return value;
}
export const uploadError = error => error.code === "FILE_UPLOAD_TYPE" ? "This file's contents do not match an accepted document type. Choose a valid document." : error.code === "FILE_UPLOAD_CONTENT_CHANGED" ? "This upload was started with a different file. Check the saved upload before choosing another document." : error.status === 409 ? "The Matter or upload changed. Check the saved upload before continuing." : "The upload could not be confirmed. Check the saved upload before trying again.";
