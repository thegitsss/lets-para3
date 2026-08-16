const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:uploads");
// backend/routes/uploads.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createS3Client } = require("../utils/s3Client");
const verifyToken = require("../utils/verifyToken");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const { requireApproved, requireRole, requireCaseAccess, sameId } = require("../utils/authz");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Application = require("../models/Application");
const Job = require("../models/Job");
const User = require("../models/User");
const { logAction } = require("../utils/audit");
const { notifyUser } = require("../utils/notifyUser");
const { publishCaseEvent } = require("../utils/caseEvents");
const sendEmail = require("../utils/email");
const { normalizeCaseStatus, canUseWorkspace } = require("../utils/caseState");
const {
  decryptCaseFilePayload,
  buildCaseFileKeyQuery,
  buildCaseFileNameQuery,
} = require("../utils/dataEncryption");
const { applyPublicParalegalFilter } = require("../utils/paralegalProfile");
const { isWorkspacePresenceActive } = require("../utils/workspacePresence");
const { csrfProtection } = require("../utils/csrf");
const {
  ALLOWED_MATTER_MIME_TYPES,
  getObjectMalwareScan,
  isExtensionAllowedForMime,
  malwareScanRequired,
  normalizeExtension,
  normalizeMimeType,
  validateMatterFileBuffer,
} = require("../utils/fileSecurity");
const {
  MAX_PROFILE_PHOTO_BYTES,
  buildAuthenticatedProfilePhotoUrl,
  buildPublicProfilePhotoUrl,
  hasPhotoReference,
  resolveProfilePhotoKey,
  streamProfilePhoto,
} = require("../services/profilePhotoDelivery");
const {
  activatePersonalStorageDeletion,
  cancelPersonalStorageDeletion,
  collectUserPersonalStorageKeys,
  normalizeOwnedPersonalKey,
  stagePersonalStorageDeletion,
} = require("../services/personalStorageDeletion");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ----------------------------------------
// S3 client
// ----------------------------------------
const s3 = createS3Client();
const BUCKET = process.env.S3_BUCKET;
if (!BUCKET) {
  runtimeLogger.warn("[uploads] S3_BUCKET not set; presign routes will fail.");
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const isObjId = (id) => mongoose.isValidObjectId(id);

function safeSegment(s, { allowSlash = false } = {}) {
  const cleaned = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gi, "-")
    .replace(/-+/g, "-");
  return allowSlash ? cleaned.replace(/\/+/g, "/") : cleaned.replace(/\//g, "");
}

function buildCasePrefix(caseId) {
  return `cases/${caseId}/`;
}

const CLOSED_CASE_STATUSES = new Set(["completed", "closed", "disputed"]);

function isCaseClosedForAccess(caseDoc) {
  if (!caseDoc) return false;
  if (caseDoc.paymentReleased === true) return true;
  const status = normalizeCaseStatus(caseDoc.status);
  return CLOSED_CASE_STATUSES.has(status);
}

function normalizeKeyPath(key) {
  return String(key || "").replace(/^\/+/, "");
}

function isS3NotFound(err) {
  const code = err?.name || err?.Code || err?.code;
  if (code === "NoSuchKey" || code === "NotFound") return true;
  return err?.$metadata?.httpStatusCode === 404;
}

async function ensureObjectExists(key) {
  if (!BUCKET) throw new Error("S3 bucket not configured");
  const cmd = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
  try {
    await s3.send(cmd);
  } catch (err) {
    if (isS3NotFound(err)) {
      const missing = new Error("S3 object not found");
      missing.code = "NoSuchKey";
      throw missing;
    }
    throw err;
  }
}

async function refreshCaseFileSecurity(record, key, { persist = true, enforce = true } = {}) {
  const scan = await getObjectMalwareScan({ s3, bucket: BUCKET, key });
  const now = new Date();
  if (persist && record?._id) {
    const update = {
      securityStatus: scan.status,
      securityScanResult: scan.result,
      securityCheckedAt: now,
    };
    if (["clean", "blocked", "error"].includes(scan.status)) update.securityScannedAt = now;
    await CaseFile.updateOne({ _id: record._id }, { $set: update }).catch((err) => {
      runtimeLogger.error("[uploads] file security state update failed", err?.message || err);
    });
  }
  if (enforce && !scan.safe) {
    const error = new Error(
      scan.status === "blocked"
        ? "This file is unavailable because it did not pass security scanning."
        : scan.status === "error"
          ? "This file is unavailable because security scanning could not complete."
          : "This file is still undergoing security scanning. Try again shortly."
    );
    error.code = scan.status === "blocked"
      ? "FILE_SECURITY_BLOCKED"
      : scan.status === "error"
        ? "FILE_SCAN_ERROR"
        : "FILE_SCAN_PENDING";
    error.statusCode = scan.status === "blocked" ? 422 : scan.status === "error" ? 503 : 423;
    throw error;
  }
  return scan;
}

async function findCaseFileForObject(caseId, key) {
  if (!caseId || !key) return null;
  const normalized = normalizeKeyPath(key);
  const direct = await CaseFile.findOne(buildCaseFileKeyQuery({ caseId, storageKey: normalized }));
  if (direct) {
    const plain = decryptCaseFilePayload(direct);
    if (normalizeKeyPath(plain.storageKey) === normalized) return direct;
  }
  const files = await CaseFile.find({ caseId }).select("previewKey storageKey");
  return files.find((file) => {
    const plain = decryptCaseFilePayload(file);
    return normalizeKeyPath(plain.previewKey) === normalized;
  }) || null;
}

async function enforceMatterObjectSecurity(key, explicitCaseId) {
  const normalized = normalizeKeyPath(key);
  if (!normalized.startsWith("cases/")) return;
  const isDocument = normalized.includes("/documents/");
  const isPreEngagementDocument = normalized.includes("/pre-engagement/");
  if (!isDocument && !isPreEngagementDocument) return;
  const caseId = explicitCaseId || extractCaseIdFromKey(normalized);
  if (isPreEngagementDocument) {
    await refreshCaseFileSecurity(null, normalized, { persist: false });
    return;
  }
  const record = await findCaseFileForObject(caseId, normalized);
  if (!record) {
    const error = new Error("This file is not attached to the Matter.");
    error.code = "FILE_METADATA_MISSING";
    error.statusCode = 404;
    throw error;
  }
  const plain = decryptCaseFilePayload(record);
  const originalKey = normalizeKeyPath(plain.storageKey);
  const previewKey = normalizeKeyPath(plain.previewKey);
  await refreshCaseFileSecurity(record, originalKey);
  if (normalized !== originalKey) {
    if (!previewKey || normalized !== previewKey) {
      const error = new Error("This file is not attached to the Matter.");
      error.code = "FILE_METADATA_MISSING";
      error.statusCode = 404;
      throw error;
    }
    await refreshCaseFileSecurity(record, previewKey, { persist: false });
  }
}

const SCANNED_PERSONAL_PREFIXES = [
  "profile-photos/",
  "paralegal-resumes/",
  "paralegal-certificates/",
  "paralegal-writing-samples/",
];

async function enforceUploadedObjectSecurity(key, explicitCaseId) {
  const normalized = normalizeKeyPath(key);
  if (normalized.startsWith("cases/")) {
    await enforceMatterObjectSecurity(normalized, explicitCaseId);
    return;
  }
  if (SCANNED_PERSONAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    await refreshCaseFileSecurity(null, normalized, { persist: false });
  }
}

async function deleteUploadedObjects(keys = []) {
  if (!BUCKET) return;
  const uniqueKeys = [...new Set(keys.map(normalizeKeyPath).filter(Boolean))];
  await Promise.all(
    uniqueKeys.map(async (key) => {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      } catch (err) {
        runtimeLogger.error("[uploads] compensating object delete failed", {
          key,
          error: err?.message || String(err),
        });
      }
    })
  );
}

async function finalizeStorageTaskTransition(operation, label) {
  try {
    await operation();
  } catch (error) {
    runtimeLogger.error("[uploads] durable storage cleanup transition deferred", {
      transition: label,
      errorCode: String(error?.name || error?.code || "STORAGE_TASK_TRANSITION_FAILED"),
    });
  }
}

async function replacePersonalDocument({ user, field, key, putParams, reason }) {
  const ownerId = user._id;
  const oldKey = normalizeOwnedPersonalKey(user[field], ownerId);
  const oldTaskIds = await stagePersonalStorageDeletion({
    ownerId,
    keys: oldKey ? [oldKey] : [],
    reason,
  });
  const newTaskIds = await stagePersonalStorageDeletion({
    ownerId,
    keys: [key],
    reason: `${reason}_upload_compensation`,
  });
  try {
    await s3.send(new PutObjectCommand(putParams));
    user[field] = key;
    await user.save();
  } catch (error) {
    await finalizeStorageTaskTransition(
      () => activatePersonalStorageDeletion(newTaskIds),
      "activate_upload_compensation"
    );
    await finalizeStorageTaskTransition(
      () => cancelPersonalStorageDeletion(oldTaskIds),
      "cancel_replaced_object_deletion"
    );
    throw error;
  }
  await finalizeStorageTaskTransition(
    () => cancelPersonalStorageDeletion(newTaskIds),
    "cancel_upload_compensation"
  );
  await finalizeStorageTaskTransition(
    () => activatePersonalStorageDeletion(oldTaskIds),
    "activate_replaced_object_deletion"
  );
}

function normalizeFileName(value = "", fallback = "") {
  const cleaned = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (cleaned) return cleaned.slice(0, 500);
  return fallback || `case-file-${Date.now()}`;
}

async function nextCaseFileVersion(caseId, filename) {
  if (!caseId || !filename) return 1;
  const recent = await CaseFile.find(buildCaseFileNameQuery({ caseId, originalName: filename }))
    .sort({ version: -1, createdAt: -1 })
    .limit(1)
    .lean();
  const latest = recent[0];
  const prev = Number(latest?.version || 0);
  return prev > 0 ? prev + 1 : 1;
}

function extractCaseIdFromKey(key) {
  const match = normalizeKeyPath(key).match(/cases\/([a-f0-9]{24})\//i);
  return match ? match[1] : null;
}

function extractPersonalOwnerId(key) {
  const normalized = normalizeKeyPath(key);
  const personalPrefix = normalized.match(/^(paralegal-(?:resumes|certificates|writing-samples))\/([a-f0-9]{24})\//i);
  if (!personalPrefix) return null;
  return personalPrefix[2];
}

function buildPersonalKey(type, ownerId, ext = "pdf") {
  const nonce = crypto.randomBytes(6).toString("hex");
  let dir = "resume";
  if (type === "paralegal-certificates") dir = "certificate";
  else if (type === "paralegal-writing-samples") dir = "writing-sample";
  return `${type}/${safeSegment(ownerId)}/${dir}-${Date.now()}-${nonce}.${ext}`;
}

async function attorneyCanAccessPersonalOwner(attorneyId, ownerId) {
  if (!isObjId(attorneyId) || !isObjId(ownerId)) return false;

  const hasCaseRelationship = await Case.exists({
    attorneyId,
    $or: [
      { paralegal: ownerId },
      { paralegalId: ownerId },
      { withdrawnParalegalId: ownerId },
      { "applicants.paralegalId": ownerId },
    ],
  });
  if (hasCaseRelationship) return true;

  const jobs = await Job.find({ attorneyId }).select("_id").lean();
  if (!jobs.length) return false;

  return !!(await Application.exists({
    paralegalId: ownerId,
    jobId: { $in: jobs.map((job) => job._id) },
  }));
}

async function attorneyCanBrowsePersonalOwner(ownerId) {
  if (!isObjId(ownerId)) return false;
  const filter = {
    _id: ownerId,
    role: "paralegal",
    status: "approved",
    "preferences.hideProfile": { $ne: true },
  };
  applyPublicParalegalFilter(filter);
  const doc = await User.findOne(filter).select("_id").lean();
  return !!doc;
}

async function ensureKeyAccess(req, key, explicitCaseId) {
  if (!req.user) return false;
  const cleaned = normalizeKeyPath(key);
  if (!cleaned || cleaned.includes("..")) return false;
  const role = String(req.user.role || "").toLowerCase();
  if (role === "admin") {
    if (cleaned.startsWith("cases/")) {
      return /^cases\/[a-f0-9]{24}\/archive-v2\.zip$/i.test(cleaned);
    }
    return true;
  }

  if (cleaned.startsWith("cases/")) {
    const caseId = explicitCaseId || extractCaseIdFromKey(cleaned);
    if (caseId) {
      if (explicitCaseId && !cleaned.includes(buildCasePrefix(caseId))) {
        return false;
      }
      try {
        const {
          caseDoc,
          isAdmin,
          isAttorney,
          isParalegal,
          isRequestedPreEngagementParalegal,
        } = await loadCaseForUser(req, caseId);
        if (!caseDoc) return false;
        if (!isAdmin && isCaseClosedForAccess(caseDoc)) return false;
        const preDocKey = normalizeKeyPath(caseDoc?.preEngagement?.confidentialityDocument?.key || "");
        const preResponseDocKey = normalizeKeyPath(
          caseDoc?.preEngagement?.paralegalConfidentialityDocument?.key || ""
        );
        const requestedParalegalId = String(caseDoc?.preEngagement?.requestedParalegalId || "");
        const viewerId = String(req.user?.id || req.user?._id || "");
        const isRequestedPreEngagementDocument =
          isRequestedPreEngagementParalegal &&
          !!requestedParalegalId &&
          requestedParalegalId === viewerId &&
          ((!!preDocKey && preDocKey === cleaned) ||
            (!!preResponseDocKey && preResponseDocKey === cleaned));
        if (isRequestedPreEngagementDocument) return true;
        return Boolean(isAttorney || isParalegal);
      } catch {
        return false;
      }
    }
    return false;
  }

  const ownerId = extractPersonalOwnerId(cleaned);
  if (ownerId) {
    const viewerRole = String(req.user.role || "").toLowerCase();
    const viewerId = String(req.user.id || req.user._id || "");
    if (viewerRole === "admin") return true;
    if (viewerRole === "attorney") {
      if (await attorneyCanAccessPersonalOwner(viewerId, ownerId)) return true;
      return attorneyCanBrowsePersonalOwner(ownerId);
    }
    return ownerId === viewerId;
  }

  return false;
}

function sseParams() {
  // Use SSE-S3 by default; support KMS if configured
  if (process.env.S3_SSE_KMS_KEY_ID) {
    return {
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: process.env.S3_SSE_KMS_KEY_ID,
    };
  }
  return { ServerSideEncryption: "AES256" };
}

// Allowed content types (expand if needed)
const ALLOWED = ALLOWED_MATTER_MIME_TYPES;
const BLOCKED = [/html/i, /javascript/i, /zip/i, /x-msdownload/i, /octet-stream/i];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CASE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CERT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;
const caseFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CASE_FILE_BYTES },
});
const profilePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROFILE_PHOTO_BYTES },
});

// ----------------------------------------
// All routes require auth + approval
// ----------------------------------------
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));

/**
 * POST /api/uploads/presign
 * Body: { contentType, ext, folder?, caseId?, checksumSha256?, contentDisposition? }
 * - returns { url, key, expiresAt }
 * - if caseId is provided, verifies access via requireCaseAccess middleware after quick param parse.
 */
router.post(
  "/presign",
  csrfProtection,
  requireCaseAccess("caseId"),
  async (req, res) => {
    try {
      const { contentType, ext, caseId, checksumSha256, contentDisposition, size } = req.body || {};
      if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
      if (!caseId || !isObjId(caseId)) {
        return res.status(400).json({ msg: "caseId is required" });
      }
      const caseDoc = await Case.findById(caseId).select("escrowStatus escrowIntentId status paralegal paralegalId");
      const escrowStatus = String(caseDoc?.escrowStatus || "").toLowerCase();
      if (escrowStatus !== "funded") {
        return res.status(403).json({ msg: "Work begins once Matter funding is confirmed." });
      }
      if (!canUseWorkspace(caseDoc)) {
        return res.status(403).json({ msg: "Uploads unlock once the Matter is funded and in progress." });
      }

      if (!contentType || typeof contentType !== "string") {
        return res.status(400).json({ msg: "contentType required" });
      }
      const normalizedContentType = normalizeMimeType(contentType);
      if (!ALLOWED.has(normalizedContentType)) {
        return res.status(400).json({ msg: "Type not allowed" });
      }
      if (BLOCKED.some((rx) => rx.test(normalizedContentType))) {
        return res.status(400).json({ msg: "Type not allowed" });
      }

      const declaredSize = Number(size);
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        return res.status(400).json({ msg: "File size is required" });
      }
      if (declaredSize > MAX_FILE_BYTES) {
        return res.status(400).json({ msg: "File exceeds maximum allowed size" });
      }

      const fileExt = normalizeExtension(ext);
      if (!isExtensionAllowedForMime(fileExt, normalizedContentType)) {
        return res.status(400).json({ msg: "The file extension does not match its type." });
      }
      const filename = `${crypto.randomUUID()}.${fileExt}`;
      const key = `${buildCasePrefix(caseId)}documents/${filename}`.replace(/\/+/g, "/");

      // Additional server controls
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        ContentType: normalizedContentType,
        ContentLength: declaredSize,
        ACL: "private",
        ...sseParams(),
      };

      // Optional checksum (recommended for integrity)
      if (checksumSha256) {
        // Expect base64-encoded SHA256 (as per AWS header x-amz-checksum-sha256)
        putParams.ChecksumSHA256 = String(checksumSha256);
      }

      // Optional content disposition (e.g., "attachment; filename=\"...\"")
      if (contentDisposition && typeof contentDisposition === "string") {
        const sanitizedDisposition = contentDisposition.replace(/[\r\n]/g, " ").trim().slice(0, 200);
        if (sanitizedDisposition) {
          putParams.ContentDisposition = sanitizedDisposition;
        }
      }

      const expiresIn = 60; // seconds
      const command = new PutObjectCommand(putParams);
      const url = await getSignedUrl(s3, command, { expiresIn });
      res.json({ url, key, expiresAt: Date.now() + expiresIn * 1000 });
    } catch (e) {
      runtimeLogger.error("[uploads] presign error", e);
      res.status(500).json({ msg: "presign error" });
    }
  }
);

/**
 * GET /api/uploads/view?key=<s3key>
 * Redirects to a short-lived signed URL after auth checks.
 */
router.get("/view", async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const key = normalizeKeyPath(req.query.key);
    if (!key) return res.status(400).json({ msg: "Missing key" });

    const allowed = await ensureKeyAccess(req, key, req.query.caseId);
    if (!allowed) return res.status(403).json({ msg: "Forbidden" });

    try {
      await ensureObjectExists(key);
      await enforceUploadedObjectSecurity(key, req.query.caseId);
    } catch (err) {
      if (err?.code === "NoSuchKey") return res.status(404).json({ msg: "File not found" });
      if (err?.statusCode) return res.status(err.statusCode).json({ msg: err.message, code: err.code });
      throw err;
    }

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: 60 });
    res.redirect(url);
  } catch (e) {
    runtimeLogger.error("[uploads] view error", e);
    res.status(500).json({ msg: "view error" });
  }
});

/**
 * GET /api/uploads/download?key=<s3key>
 * Returns a short-lived GET URL to download a private object the user has rights to.
 * - Users can download files under their personal prefix.
 * - If the key is under cases/<caseId>/..., we verify case access.
 */
// GET /api/uploads/signed-get?caseId=...&key=...
router.get("/signed-get", async (req, res) => {
  try {
    const { caseId, key } = req.query;
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!key) return res.status(400).json({ msg: "Missing key" });

    const normalizedKey = normalizeKeyPath(key);
    const allowed = await ensureKeyAccess(req, normalizedKey, caseId);
    if (!allowed) return res.status(403).json({ msg: "Forbidden" });

    try {
      await ensureObjectExists(normalizedKey);
      await enforceUploadedObjectSecurity(normalizedKey, caseId);
    } catch (err) {
      if (err?.code === "NoSuchKey") return res.status(404).json({ msg: "File not found" });
      if (err?.statusCode) return res.status(err.statusCode).json({ msg: err.message, code: err.code });
      throw err;
    }

    const wantsPreview = String(req.query.preview || "").toLowerCase() === "true";
    const ttlRaw = Number(req.query.ttl);
    const ttl = Number.isFinite(ttlRaw) ? Math.min(Math.max(ttlRaw, 60), 900) : wantsPreview ? 600 : 60;
    const get = new GetObjectCommand({ Bucket: BUCKET, Key: normalizedKey });
    const url = await getSignedUrl(s3, get, { expiresIn: ttl });
    res.json({ url });
  } catch (e) {
    runtimeLogger.error(e);
    res.status(500).json({ msg: "signed-get error" });
  }
});
router.get("/download", csrfProtection, async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const key = normalizeKeyPath(req.query.key);
    if (!key) return res.status(400).json({ msg: "Missing key" });

    const allowed = await ensureKeyAccess(req, key, req.query.caseId);
    if (!allowed) return res.status(403).json({ msg: "Forbidden" });

    try {
      await ensureObjectExists(key);
      await enforceUploadedObjectSecurity(key, req.query.caseId);
    } catch (err) {
      if (err?.code === "NoSuchKey") return res.status(404).json({ msg: "File not found" });
      if (err?.statusCode) return res.status(err.statusCode).json({ msg: err.message, code: err.code });
      throw err;
    }

    const expiresIn = 60; // seconds
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn });
    res.json({ url, expiresAt: Date.now() + expiresIn * 1000 });
  } catch (e) {
    runtimeLogger.error("[uploads] download error", e);
    res.status(500).json({ msg: "download error" });
  }
});

function caseFileMiddleware(req, res, next) {
  caseFileUpload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ msg: "File exceeds maximum allowed size" });
      }
      return res.status(400).json({ msg: err?.message || "Upload failed" });
    }
    return next();
  });
}

function validatePdfUpload(file, label) {
  try {
    validateMatterFileBuffer({
      buffer: file?.buffer,
      mimeType: file?.mimetype,
      filename: file?.originalname || `${String(label || "document").toLowerCase()}.pdf`,
    });
    return null;
  } catch (error) {
    return {
      msg: `${label} must be a valid PDF.`,
      code: error?.code || "FILE_SIGNATURE_MISMATCH",
    };
  }
}

router.post(
  "/paralegal-certificate",
  requireRole("paralegal"),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "Certificate file is required" });
    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ msg: "Certificate must be a PDF" });
    }
    if (req.file.size > MAX_CERT_FILE_BYTES) {
      return res.status(400).json({ msg: "Certificate exceeds maximum allowed size" });
    }
    const invalidFile = validatePdfUpload(req.file, "Certificate");
    if (invalidFile) return res.status(400).json(invalidFile);

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });

    const key = buildPersonalKey("paralegal-certificates", ownerId);
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/pdf",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    await replacePersonalDocument({
      user,
      field: "certificateURL",
      key,
      putParams,
      reason: "certificate_replaced",
    });

    try {
      await logAction(req, "paralegal.certificate.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      runtimeLogger.warn("[uploads] certificate upload audit failed", err?.message || err);
    }

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/paralegal-writing-sample",
  requireRole("paralegal"),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "Writing sample file is required" });
    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ msg: "Writing sample must be a PDF" });
    }
    if (req.file.size > MAX_CERT_FILE_BYTES) {
      return res.status(400).json({ msg: "Writing sample exceeds maximum allowed size" });
    }
    const invalidFile = validatePdfUpload(req.file, "Writing sample");
    if (invalidFile) return res.status(400).json(invalidFile);

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });

    const key = buildPersonalKey("paralegal-writing-samples", ownerId);
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/pdf",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    await replacePersonalDocument({
      user,
      field: "writingSampleURL",
      key,
      putParams,
      reason: "writing_sample_replaced",
    });

    try {
      await logAction(req, "paralegal.writingSample.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      runtimeLogger.warn("[uploads] writing sample upload audit failed", err?.message || err);
    }

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/paralegal-resume",
  requireRole("paralegal"),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "Résumé file is required" });
    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ msg: "Résumé must be a PDF" });
    }
    if (req.file.size > MAX_RESUME_FILE_BYTES) {
      return res.status(400).json({ msg: "Résumé exceeds maximum allowed size" });
    }
    const invalidFile = validatePdfUpload(req.file, "Résumé");
    if (invalidFile) return res.status(400).json(invalidFile);

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(6).toString("hex");
    const key = `paralegal-resumes/${safeSegment(ownerId)}/resume-${timestamp}-${nonce}.pdf`;
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/pdf",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    await replacePersonalDocument({
      user,
      field: "resumeURL",
      key,
      putParams,
      reason: "resume_replaced",
    });

    try {
      await logAction(req, "paralegal.resume.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      runtimeLogger.warn("[uploads] resume upload audit failed", err?.message || err);
    }

    try {
      await notifyUser(user._id, "resume_uploaded", {}, { actorUserId: user._id });
    } catch (err) {
      runtimeLogger.warn("[uploads] notifyUser resume_uploaded failed", err);
    }

    res.set("Cache-Control", "no-store");
    return res.json({ success: true, url: key });
  })
);

router.post(
  "/profile-photo",
  requireRole("paralegal", "attorney"),
  csrfProtection,
  profilePhotoUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "original", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const getFileFromField = (field) => {
      const list = req.files?.[field];
      return Array.isArray(list) && list.length ? list[0] : null;
    };
    const photoFile = getFileFromField("file");
    const originalFile = getFileFromField("original");
    if (!photoFile) return res.status(400).json({ msg: "Profile photo is required" });
    if (!/image\/(png|jpe?g)/i.test(photoFile.mimetype || "")) {
      return res.status(400).json({ msg: "Only JPEG or PNG images are allowed" });
    }
    if (photoFile.size > MAX_PROFILE_PHOTO_BYTES) {
      return res.status(400).json({ msg: "Profile photo exceeds maximum allowed size" });
    }
    if (originalFile) {
      if (!/image\/(png|jpe?g)/i.test(originalFile.mimetype || "")) {
        return res.status(400).json({ msg: "Only JPEG or PNG images are allowed" });
      }
      if (originalFile.size > MAX_PROFILE_PHOTO_BYTES) {
        return res.status(400).json({ msg: "Profile photo exceeds maximum allowed size" });
      }
    }
    try {
      validateMatterFileBuffer({
        buffer: photoFile.buffer,
        mimeType: photoFile.mimetype,
        filename: photoFile.originalname || (/png/i.test(photoFile.mimetype || "") ? "profile.png" : "profile.jpg"),
      });
      if (originalFile) {
        validateMatterFileBuffer({
          buffer: originalFile.buffer,
          mimeType: originalFile.mimetype,
          filename: originalFile.originalname || (/png/i.test(originalFile.mimetype || "") ? "original.png" : "original.jpg"),
        });
      }
    } catch (error) {
      return res.status(400).json({
        msg: "The profile photo contents do not match the selected image type.",
        code: error?.code || "FILE_SIGNATURE_MISMATCH",
      });
    }

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const user = await User.findById(ownerId).select(
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!user) return res.status(404).json({ msg: "User not found" });
    const role = String(user.role || "").toLowerCase();
    const editExistingRaw = String(req.body?.editExisting || "").trim().toLowerCase();
    const editExisting = editExistingRaw === "1" || editExistingRaw === "true" || editExistingRaw === "yes";
    const hasExistingPhoto = Boolean(user.profileImage || user.avatarURL);
    const requiresReview = role === "paralegal" && !(editExisting && hasExistingPhoto);
    const queueAdminReview = role === "attorney";

    const profileExt = /png/i.test(photoFile.mimetype || "") ? "png" : "jpg";
    const photoTimestamp = Date.now();
    const photoNonce = crypto.randomBytes(6).toString("hex");
    const key = `profile-photos/${safeSegment(ownerId)}/profile-${photoTimestamp}-${photoNonce}.${profileExt}`;
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: photoFile.buffer,
      ContentType: photoFile.mimetype || "image/jpeg",
      ContentLength: photoFile.size,
      ...sseParams(),
    };
    let originalKey = "";
    let originalPutParams = null;
    if (originalFile) {
      const originalExt = /png/i.test(originalFile.mimetype || "") ? "png" : "jpg";
      const originalNonce = crypto.randomBytes(6).toString("hex");
      originalKey = `profile-photos/${safeSegment(ownerId)}/original-${photoTimestamp}-${originalNonce}.${originalExt}`;
      originalPutParams = {
        Bucket: BUCKET,
        Key: originalKey,
        Body: originalFile.buffer,
        ContentType: originalFile.mimetype || "image/jpeg",
        ContentLength: originalFile.size,
        ...sseParams(),
      };
    }
    const currentPhotoKeys = collectUserPersonalStorageKeys(user).filter((value) =>
      value.startsWith(`profile-photos/${ownerId}/`)
    );
    const pendingKeys = [
      resolveProfilePhotoKey(user, {
        bucket: BUCKET,
        region: process.env.S3_REGION,
        variant: "pending",
      }),
      resolveProfilePhotoKey(user, {
        bucket: BUCKET,
        region: process.env.S3_REGION,
        variant: "pending-original",
      }),
    ].filter(Boolean);
    const oldTaskIds = await stagePersonalStorageDeletion({
      ownerId,
      keys: requiresReview ? pendingKeys : currentPhotoKeys,
      reason: "profile_photo_replaced",
    });
    const newTaskIds = await stagePersonalStorageDeletion({
      ownerId,
      keys: [key, originalKey].filter(Boolean),
      reason: "profile_photo_upload_compensation",
    });
    const photoVersion = new Date();
    const approvedDisplayUrl = role === "paralegal"
      ? buildPublicProfilePhotoUrl(user, photoVersion)
      : buildAuthenticatedProfilePhotoUrl(user, { updatedAt: photoVersion });
    const pendingDisplayUrl = buildAuthenticatedProfilePhotoUrl(user, {
      variant: "pending",
      updatedAt: photoVersion,
    });
    const approvedOriginalUrl = buildAuthenticatedProfilePhotoUrl(user, {
      variant: "approved-original",
      updatedAt: photoVersion,
    });
    const pendingOriginalUrl = buildAuthenticatedProfilePhotoUrl(user, {
      variant: "pending-original",
      updatedAt: photoVersion,
    });
    try {
      await s3.send(new PutObjectCommand(putParams));
      if (originalPutParams) await s3.send(new PutObjectCommand(originalPutParams));
      if (requiresReview) {
        user.pendingProfileImageKey = key;
        user.pendingProfileImage = pendingDisplayUrl;
        user.pendingProfileImageOriginalKey = originalKey;
        user.pendingProfileImageOriginal = originalKey ? pendingOriginalUrl : "";
        user.profilePhotoStatus = "pending_review";
      } else {
        user.profileImageKey = key;
        user.profileImage = approvedDisplayUrl;
        user.avatarURL = approvedDisplayUrl;
        user.pendingProfileImageKey = queueAdminReview ? key : "";
        user.pendingProfileImage = queueAdminReview ? pendingDisplayUrl : "";
        user.pendingProfileImageOriginalKey = queueAdminReview ? originalKey : "";
        user.pendingProfileImageOriginal = queueAdminReview && originalKey ? pendingOriginalUrl : "";
        user.profileImageOriginalKey = originalKey;
        user.profileImageOriginal = originalKey ? approvedOriginalUrl : "";
        user.profilePhotoStatus = "approved";
      }
      await user.save();
    } catch (error) {
      await finalizeStorageTaskTransition(
        () => activatePersonalStorageDeletion(newTaskIds),
        "activate_profile_upload_compensation"
      );
      await finalizeStorageTaskTransition(
        () => cancelPersonalStorageDeletion(oldTaskIds),
        "cancel_replaced_profile_deletion"
      );
      throw error;
    }
    await finalizeStorageTaskTransition(
      () => cancelPersonalStorageDeletion(newTaskIds),
      "cancel_profile_upload_compensation"
    );
    await finalizeStorageTaskTransition(
      () => activatePersonalStorageDeletion(oldTaskIds),
      "activate_replaced_profile_deletion"
    );

    try {
      await logAction(req, "user.profile_photo.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      runtimeLogger.warn("[uploads] profile photo upload audit failed", err?.message || err);
    }

    if (requiresReview) {
      try {
        const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
        const adminLink = baseUrl ? `${baseUrl}/admin-dashboard.html#section-photo-reviews` : "";
        const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Paralegal";
        const timestamp = new Date().toISOString();
        const linkHtml = adminLink ? `<p><a href="${adminLink}">Open photo reviews</a></p>` : "";
        await sendEmail(
          "admin@lets-paraconnect.com",
          "Profile photo review submitted",
          `<p>A paralegal submitted a profile photo for review.</p>
           <p><strong>Name:</strong> ${fullName}<br/>
           <strong>Role:</strong> ${String(user.role || "").toLowerCase()}<br/>
           <strong>Timestamp:</strong> ${timestamp}</p>
           ${linkHtml}`
        );
      } catch (err) {
        runtimeLogger.warn("[uploads] admin photo review email failed", err?.message || err);
      }
    }

    return res.json({
      success: true,
      url: requiresReview ? pendingDisplayUrl : approvedDisplayUrl,
      status: user.profilePhotoStatus || (requiresReview ? "pending_review" : "approved"),
      pending: requiresReview,
      pendingProfileImage: requiresReview ? pendingDisplayUrl : "",
      pendingProfileImageOriginal: requiresReview ? user.pendingProfileImageOriginal || "" : "",
      profileImage: requiresReview ? user.profileImage || "" : approvedDisplayUrl,
      profileImageOriginal: user.profileImageOriginal || "",
    });
  })
);

router.get(
  "/profile-photo/original",
  asyncHandler(async (req, res) => {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });
    const user = await User.findById(ownerId).select(
      "pendingProfileImageOriginal profileImageOriginal pendingProfileImage profileImage avatarURL " +
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!user) return res.status(404).json({ msg: "User not found" });
    const variant = hasPhotoReference(user, "pending-original") ? "pending-original" : "approved-original";
    const key = resolveProfilePhotoKey(user, {
      bucket: BUCKET,
      region: process.env.S3_REGION,
      variant,
    });
    if (!key) return res.status(404).json({ msg: "Profile photo not found" });
    const served = await streamProfilePhoto({
      req,
      res,
      s3,
      bucket: BUCKET,
      key,
      cacheControl: "private, no-store",
    });
    if (!served && !res.headersSent) return res.status(404).json({ msg: "Profile photo not found" });
    return undefined;
  })
);

router.post(
  "/case/:caseId",
  ensureCaseParticipant(),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "File is required" });
    if (req.file.size > MAX_CASE_FILE_BYTES) {
      return res.status(400).json({ msg: "File exceeds maximum allowed size" });
    }

    const originalName = normalizeFileName(req.file.originalname, `case-file-${Date.now()}`);
    try {
      validateMatterFileBuffer({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: originalName,
      });
    } catch (err) {
      if (["FILE_TYPE_NOT_ALLOWED", "FILE_EXTENSION_MISMATCH", "FILE_SIGNATURE_MISMATCH"].includes(err?.code)) {
        return res.status(400).json({ msg: err.message, code: err.code });
      }
      throw err;
    }
    const safeName = safeSegment(originalName) || `case-file-${Date.now()}`;
    const key = `${buildCasePrefix(caseDoc._id)}documents/${Date.now()}-${safeName}`.replace(/\/+/g, "/");
    const uploadRole = String(req.user?.role || "attorney").toLowerCase();
    const defaultStatus = "pending_review";
    const version = await nextCaseFileVersion(caseDoc._id, originalName);
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || "application/octet-stream",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    await s3.send(new PutObjectCommand(putParams));

    let entry;
    try {
      entry = await CaseFile.create({
        caseId: caseDoc._id,
        userId: req.user.id,
        originalName,
        storageKey: key,
        previewKey: "",
        mimeType: req.file.mimetype || "",
        previewMimeType: "",
        size: req.file.size || 0,
        previewSize: 0,
        securityStatus: malwareScanRequired() ? "pending" : "not_required",
        securityScanResult: malwareScanRequired() ? "PENDING" : "NOT_REQUIRED",
        uploadedByRole: uploadRole,
        status: defaultStatus,
        version,
      });
    } catch (err) {
      await deleteUploadedObjects([key]);
      throw err;
    }

    try {
      await logAction(req, "file_uploaded", {
        targetType: "case",
        targetId: caseDoc._id,
        meta: { fileId: entry._id, filename: originalName },
      });
    } catch (err) {
      runtimeLogger.warn("[uploads] file upload audit failed", err?.message || err);
    }

    try {
      const actorRole = String(req.user?.role || "").toLowerCase();
      const recipientId =
        actorRole === "attorney"
          ? caseDoc.paralegal || caseDoc.paralegalId
          : actorRole === "paralegal"
          ? caseDoc.attorney || caseDoc.attorneyId
          : null;
      if (recipientId && !isWorkspacePresenceActive(recipientId, caseDoc._id)) {
        const caseId = String(caseDoc._id);
        await notifyUser(
          recipientId,
          "case_file_uploaded",
          {
            caseId,
            caseTitle: caseDoc.title || "Untitled Matter",
            fileId: entry._id,
            fileName: originalName,
            link: `case-detail.html?caseId=${encodeURIComponent(caseId)}&tab=files`,
          },
          { actorUserId: req.user.id }
        );
      }
    } catch (err) {
      runtimeLogger.warn("[uploads] notifyUser case_file_uploaded failed", err?.message || err);
    }

    publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
    res.status(201).json({
      file: req.query?.presentation === "matter"
        ? serializeMatterCaseFile(entry)
        : serializeCaseFile(entry),
    });
  })
);

router.get(
  "/case/:caseId",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    const files = await CaseFile.find({ caseId: caseDoc._id }).sort({ createdAt: -1 }).lean();
    const serializer = req.query?.presentation === "matter"
      ? serializeMatterCaseFile
      : serializeCaseFile;
    res.json({ files: files.map(serializer) });
  })
);

router.delete(
  "/case/:caseId/:fileId",
  ensureCaseParticipant(),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin, isAttorney } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!isAdmin && !isAttorney) {
      return res.status(403).json({ msg: "Only the Matter attorney can delete documents." });
    }
    if (!isObjId(req.params.fileId)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const record = await CaseFile.findOne({ _id: req.params.fileId, caseId: caseDoc._id });
    if (!record) {
      return res.status(404).json({ msg: "File not found" });
    }
    const plainRecord = decryptCaseFilePayload(record);
    if (BUCKET && plainRecord.storageKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(plainRecord.storageKey) }));
      } catch (err) {
        runtimeLogger.warn("[uploads] delete object failed", err?.message || err);
      }
    }
    if (BUCKET && plainRecord.previewKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(plainRecord.previewKey) }));
      } catch (err) {
        runtimeLogger.warn("[uploads] delete preview object failed", err?.message || err);
      }
    }
    await CaseFile.deleteOne({ _id: record._id });
    try {
      await logAction(req, "file_deleted", {
        targetType: "case",
        targetId: caseDoc._id,
        meta: { fileId: record._id, filename: plainRecord.originalName },
      });
    } catch (err) {
      runtimeLogger.warn("[uploads] file delete audit failed", err?.message || err);
    }
    publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
    res.json({ ok: true });
  })
);

router.get(
  "/case/:caseId/:fileId/security-status",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!isObjId(req.params.fileId)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const record = await CaseFile.findOne({ _id: req.params.fileId, caseId: caseDoc._id });
    if (!record) return res.status(404).json({ msg: "File not found" });
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const plainRecord = decryptCaseFilePayload(record);
    const scan = await refreshCaseFileSecurity(record, plainRecord.storageKey, { enforce: false });
    res.set("Cache-Control", "no-store");
    return res.json({
      fileId: String(record._id),
      securityStatus: scan.status,
      securityScanResult: scan.result,
      ready: scan.safe,
      checkedAt: new Date().toISOString(),
    });
  })
);

router.get(
  "/case/:caseId/:fileId/download",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!isObjId(req.params.fileId)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const record = await CaseFile.findOne({ _id: req.params.fileId, caseId: caseDoc._id });
    if (!record) {
      return res.status(404).json({ msg: "File not found" });
    }
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const plainRecord = decryptCaseFilePayload(record);
    try {
      await refreshCaseFileSecurity(record, plainRecord.storageKey);
    } catch (err) {
      if (err?.statusCode) return res.status(err.statusCode).json({ msg: err.message, code: err.code });
      throw err;
    }
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(plainRecord.storageKey) });
    const data = await s3.send(getCmd);
    const filename = plainRecord.originalName || `case-file-${record._id}`;
    res.setHeader("Content-Type", plainRecord.mimeType || "application/octet-stream");
    if (plainRecord.size) {
      res.setHeader("Content-Length", String(plainRecord.size));
    }
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    data.Body.on("error", (err) => {
      runtimeLogger.error("[uploads] download stream error", err);
      res.destroy(err);
    });
    data.Body.pipe(res);
    data.Body.on("end", () => {
      logAction(req, "file_downloaded", {
        targetType: "case",
        targetId: caseDoc._id,
        meta: { fileId: record._id, filename },
      }).catch(logPromiseFailure(runtimeLogger, "[uploads] file download audit persistence failed", {
        caseId: caseDoc._id,
        fileId: record._id,
      }));
    });
  })
);

function assertWorkspaceReady(caseDoc, res) {
  const hasParalegal = !!(caseDoc?.paralegal || caseDoc?.paralegalId);
  if (!hasParalegal) {
    res.status(403).json({ msg: "Workspace unlocks after a paralegal is hired." });
    return false;
  }
  const escrowFunded =
    !!caseDoc?.escrowIntentId && String(caseDoc?.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) {
    res.status(403).json({ msg: "Work begins once Matter funding is confirmed." });
    return false;
  }
  if (!canUseWorkspace(caseDoc)) {
    const status = normalizeCaseStatus(caseDoc?.status);
    const closedStatuses = ["completed", "closed", "disputed"];
    const msg = closedStatuses.includes(status)
      ? "Uploads are closed for this Matter."
      : "Uploads unlock once the Matter is funded and in progress.";
    res.status(403).json({ msg });
    return false;
  }
  return true;
}

async function loadCaseForUser(req, caseId) {
  if (!isObjId(caseId)) {
    const error = new Error("Invalid Matter ID");
    error.statusCode = 400;
    throw error;
  }
  const doc = await Case.findById(caseId).select(
    "_id attorney attorneyId paralegal paralegalId title escrowIntentId escrowStatus status paymentReleased readOnly paralegalAccessRevokedAt preEngagement.requestedParalegalId preEngagement.confidentialityDocument.key preEngagement.paralegalConfidentialityDocument.key"
  );
  if (!doc) {
    const error = new Error("Matter not found");
    error.statusCode = 404;
    throw error;
  }
  const userId = req.user?.id;
  const isAdmin = req.user?.role === "admin";
  const isAttorney = sameId(doc.attorney, userId) || sameId(doc.attorneyId, userId);
  const isParalegal = sameId(doc.paralegal, userId) || sameId(doc.paralegalId, userId);
  const requestedParalegalId = doc?.preEngagement?.requestedParalegalId;
  const isRequestedPreEngagementParalegal = sameId(requestedParalegalId, userId);
  if (!isAdmin && isParalegal && doc.paralegalAccessRevokedAt) {
    const error = new Error("Access revoked");
    error.statusCode = 403;
    throw error;
  }
  if (!isAdmin && !isAttorney && !isParalegal && !isRequestedPreEngagementParalegal) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
  return { caseDoc: doc, isAdmin, isAttorney, isParalegal, isRequestedPreEngagementParalegal };
}

function serializeCaseFile(doc) {
  const plain = decryptCaseFilePayload(doc);
  return {
    id: String(plain._id),
    caseId: String(plain.caseId),
    userId: String(plain.userId),
    originalName: plain.originalName,
    storageKey: plain.storageKey,
    previewKey: plain.previewKey || "",
    key: plain.storageKey,
    original: plain.originalName,
    filename: plain.originalName,
    mimeType: plain.mimeType || null,
    mime: plain.mimeType || null,
    previewMimeType: plain.previewMimeType || null,
    previewMime: plain.previewMimeType || null,
    size: plain.size || 0,
    previewSize: plain.previewSize || 0,
    securityStatus: plain.securityStatus || (malwareScanRequired() ? "pending" : "not_required"),
    securityScanResult: plain.securityScanResult || (malwareScanRequired() ? "PENDING" : "NOT_REQUIRED"),
    securityScannedAt: plain.securityScannedAt || null,
    createdAt: plain.createdAt,
    uploadedAt: plain.createdAt,
    uploadedByRole: plain.uploadedByRole || null,
    status: plain.status || "pending_review",
    version: typeof plain.version === "number" ? plain.version : 1,
    revisionNotes: plain.revisionNotes || "",
    revisionRequestedAt: plain.revisionRequestedAt || null,
    approvedAt: plain.approvedAt || null,
    replacedAt: plain.replacedAt || null,
  };
}

function serializeMatterCaseFile(doc) {
  const file = serializeCaseFile(doc);
  return {
    id: file.id,
    caseId: file.caseId,
    originalName: file.originalName,
    original: file.originalName,
    filename: file.originalName,
    mimeType: file.mimeType,
    mime: file.mimeType,
    previewMimeType: file.previewMimeType,
    previewMime: file.previewMimeType,
    size: file.size,
    previewSize: file.previewSize,
    securityStatus: file.securityStatus,
    securityScanResult: file.securityScanResult,
    securityScannedAt: file.securityScannedAt,
    createdAt: file.createdAt,
    uploadedAt: file.uploadedAt,
    uploadedByRole: file.uploadedByRole,
    status: file.status,
    version: file.version,
    revisionRequestedAt: file.revisionRequestedAt,
    approvedAt: file.approvedAt,
    replacedAt: file.replacedAt,
  };
}

module.exports = router;
