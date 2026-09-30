const id = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readDownloads(value, caseId, ownerId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value.caseId !== caseId || typeof value.caseTitle !== "string" || !["available", "archive_only", "purged", "unavailable"].includes(value.access) || typeof value.legacyAttachments !== "boolean" || !Array.isArray(value.files) || value.files.length > 50 || (value.nextCursor !== null && !id(value.nextCursor))) throw new Error("invalid_downloads");
  const seen = new Set();
  for (const file of value.files) {
    if (!id(file?.id) || seen.has(file.id) || !hash(file.revision) || typeof file.name !== "string" || !file.name || (file.size !== null && (!Number.isSafeInteger(file.size) || file.size < 0)) || (file.version !== null && (!Number.isSafeInteger(file.version) || file.version < 1)) || (file.uploadedAt !== null && (typeof file.uploadedAt !== "string" || !Number.isFinite(new Date(file.uploadedAt).getTime()))) || !["clean", "pending", "blocked", "error", "not_required", "unknown"].includes(file.securityStatus)) throw new Error("invalid_file");
    seen.add(file.id);
  }
  if ((value.access !== "available" && (value.files.length || value.nextCursor)) || (value.nextCursor && value.nextCursor !== value.files.at(-1)?.id)) throw new Error("invalid_download_page");
  return value;
}
export const fileName = name => String(name || "Matter file").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-").replace(/^\.+/, "").trim().slice(0, 180) || "Matter file";
export const downloadAccess = value => ({ available: "Choose a file below. Security and access are checked again before each download.", archive_only: "Individual files are closed for this Matter. Its archive or existing dispute workflow determines which records remain available.", purged: "This Matter's retained files have been removed. File downloads are unavailable.", unavailable: "This Matter's status needs review before its files can be downloaded." })[value.access];
export function fileDescription(file) {
  const size = file.size === null ? "Size unavailable" : file.size < 1024 ? `${file.size} bytes` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  const date = file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Upload date unavailable";
  const scan = { clean: "Clear", pending: "Pending", blocked: "Blocked", error: "Unavailable", not_required: "Not required", unknown: "Not recorded" }[file.securityStatus];
  return `${size} · ${file.version ? `Version ${file.version}` : "Version unavailable"} · ${date} · Last recorded security check: ${scan}`;
}
export function downloadError(error) {
  return ({ DOWNLOAD_CHANGED: "This file changed after the list loaded. Refresh files before downloading the new version.", DOWNLOAD_FILE_NOT_FOUND: "This file is no longer available. Refresh the list to check the remaining files.", DOWNLOAD_BLOCKED: "This file did not pass its security check and was not downloaded.", DOWNLOAD_SCAN_PENDING: "This file is still undergoing its security check. You can check and download it again later.", DOWNLOAD_SCAN_ERROR: "The security check could not finish. No file was downloaded. Try again later." })[error.code] || "The download could not be completed. Nothing was handed to your browser. You can try again explicitly.";
}
