"use strict";

const {
  GetObjectCommand,
  GetObjectTaggingCommand,
} = require("@aws-sdk/client-s3");

const GUARDDUTY_TAG_KEY = "GuardDutyMalwareScanStatus";
const CLEAN_SCAN_RESULT = "NO_THREATS_FOUND";
const BLOCKED_SCAN_RESULT = "THREATS_FOUND";
const ERROR_SCAN_RESULTS = new Set(["UNSUPPORTED", "ACCESS_DENIED", "FAILED"]);

const MIME_EXTENSIONS = Object.freeze({
  "application/pdf": new Set(["pdf"]),
  "application/msword": new Set(["doc"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": new Set(["docx"]),
  "application/vnd.ms-excel": new Set(["xls"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": new Set(["xlsx"]),
  "application/vnd.ms-powerpoint": new Set(["ppt"]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": new Set(["pptx"]),
  "text/plain": new Set(["txt"]),
  "text/csv": new Set(["csv"]),
  "image/png": new Set(["png"]),
  "image/jpeg": new Set(["jpg", "jpeg"]),
  "image/gif": new Set(["gif"]),
});

const ALLOWED_MATTER_MIME_TYPES = new Set(Object.keys(MIME_EXTENSIONS));

function malwareScanRequired(env = process.env) {
  return String(env.S3_MALWARE_SCAN_REQUIRED || "").trim().toLowerCase() === "true";
}

function normalizeMimeType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function normalizeExtension(value) {
  return String(value || "").trim().toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]/g, "");
}

function extensionFromFilename(value) {
  const name = String(value || "").trim();
  const index = name.lastIndexOf(".");
  return index >= 0 ? normalizeExtension(name.slice(index + 1)) : "";
}

function isExtensionAllowedForMime(extension, mimeType) {
  const allowed = MIME_EXTENSIONS[normalizeMimeType(mimeType)];
  return Boolean(allowed?.has(normalizeExtension(extension)));
}

function startsWith(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function looksLikeUtf8Text(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function matchesDeclaredFileType(buffer, mimeType) {
  const mime = normalizeMimeType(mimeType);
  const zip = startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
  const ole = startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (mime === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "image/png") return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/jpeg") return startsWith(buffer, [0xff, 0xd8, 0xff]);
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  if (["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mime)) {
    return ole;
  }
  if (mime.startsWith("application/vnd.openxmlformats-officedocument.")) {
    if (!zip) return false;
    const archiveText = buffer.toString("latin1");
    if (!archiveText.includes("[Content_Types].xml")) return false;
    if (mime.includes("wordprocessingml")) return archiveText.includes("word/");
    if (mime.includes("spreadsheetml")) return archiveText.includes("xl/");
    if (mime.includes("presentationml")) return archiveText.includes("ppt/");
    return false;
  }
  if (["text/plain", "text/csv"].includes(mime)) return looksLikeUtf8Text(buffer);
  return false;
}

function validateMatterFileBuffer({ buffer, mimeType, filename = "", extension = "" } = {}) {
  const mime = normalizeMimeType(mimeType);
  const ext = normalizeExtension(extension || extensionFromFilename(filename));
  if (!ALLOWED_MATTER_MIME_TYPES.has(mime)) {
    const error = new Error("This file type is not allowed.");
    error.code = "FILE_TYPE_NOT_ALLOWED";
    throw error;
  }
  if (!ext || !isExtensionAllowedForMime(ext, mime)) {
    const error = new Error("The file extension does not match its declared type.");
    error.code = "FILE_EXTENSION_MISMATCH";
    throw error;
  }
  if (!Buffer.isBuffer(buffer) || !matchesDeclaredFileType(buffer, mime)) {
    const error = new Error("The file contents do not match its declared type.");
    error.code = "FILE_SIGNATURE_MISMATCH";
    throw error;
  }
  return { mimeType: mime, extension: ext };
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function validateStoredMatterFile({ s3, bucket, key, mimeType, filename = "" } = {}) {
  if (!s3 || !bucket || !key) throw new Error("Stored file validation requires S3, bucket, and key.");
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: String(key),
  }));
  const prefix = await bodyToBuffer(response?.Body);
  return validateMatterFileBuffer({ buffer: prefix, mimeType, filename });
}

function classifyMalwareScanResult(value, { required = malwareScanRequired() } = {}) {
  if (!required) return { status: "not_required", result: "NOT_REQUIRED", safe: true };
  const result = String(value || "").trim().toUpperCase();
  if (result === CLEAN_SCAN_RESULT) return { status: "clean", result, safe: true };
  if (result === BLOCKED_SCAN_RESULT) return { status: "blocked", result, safe: false };
  if (ERROR_SCAN_RESULTS.has(result)) return { status: "error", result, safe: false };
  return { status: "pending", result: result || "PENDING", safe: false };
}

async function getObjectMalwareScan({ s3, bucket, key, required = malwareScanRequired() } = {}) {
  if (!required) return classifyMalwareScanResult("", { required: false });
  if (!s3 || !bucket || !key) throw new Error("Malware scan verification requires S3, bucket, and key.");
  const response = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: String(key) }));
  const tag = (response?.TagSet || []).find((entry) => entry?.Key === GUARDDUTY_TAG_KEY);
  return classifyMalwareScanResult(tag?.Value, { required: true });
}

function unsafeFileError(scan = {}) {
  let message = "This file is still undergoing security scanning. Try again shortly.";
  let code = "FILE_SCAN_PENDING";
  let statusCode = 423;
  if (scan.status === "blocked") {
    message = "This file is unavailable because it did not pass security scanning.";
    code = "FILE_SECURITY_BLOCKED";
    statusCode = 422;
  } else if (scan.status === "error") {
    message = "This file is unavailable because security scanning could not complete.";
    code = "FILE_SCAN_ERROR";
    statusCode = 503;
  }
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.scan = scan;
  return error;
}

async function assertObjectMalwareSafe(options = {}) {
  const scan = await getObjectMalwareScan(options);
  if (!scan.safe) throw unsafeFileError(scan);
  return scan;
}

module.exports = {
  ALLOWED_MATTER_MIME_TYPES,
  BLOCKED_SCAN_RESULT,
  CLEAN_SCAN_RESULT,
  ERROR_SCAN_RESULTS,
  GUARDDUTY_TAG_KEY,
  classifyMalwareScanResult,
  extensionFromFilename,
  getObjectMalwareScan,
  isExtensionAllowedForMime,
  malwareScanRequired,
  matchesDeclaredFileType,
  normalizeExtension,
  normalizeMimeType,
  assertObjectMalwareSafe,
  unsafeFileError,
  validateMatterFileBuffer,
  validateStoredMatterFile,
};
