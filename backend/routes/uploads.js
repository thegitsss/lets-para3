const { reportOperationalFailure } = require("../utils/operationalFailure");
const presignedUploads = require("../services/matterPresignedUploads");
const matterRetirement = require("../services/matterStorageRetirement"), fileRemoval = require("../services/attorneyMatterFileRemoval");
const matterFileWrites = require("../services/matterFileWrites");
const attorneyFiles = require("../services/attorneyMatterFiles");
const { projectRevisionResolutions } = require("../utils/revisionResolution");
const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:uploads");
// backend/routes/uploads.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const { PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
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
const AuditLog = require("../models/AuditLog");
const matterFileNotifications = require("../services/matterFileNotifications");
const accountWriteGuard = require("../utils/accountWriteGuard");
const { logAction } = require("../utils/audit");
const { notifyUser } = require("../utils/notifyUser");
const { publishCaseEvent } = require("../utils/caseEvents");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
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
  applyAssignmentVisibility,
  isRecordVisibleToCurrentAssignment,
} = require("../utils/matterAssignmentVisibility");
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

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(error => { if (!accountWriteGuard.respond(error, res)) next(error); });

// ----------------------------------------
// S3 client
// ----------------------------------------
const s3 = createS3Client();
// The browser supplies the bytes after signing. Do not checksum an absent body.
const presignS3 = createS3Client(process.env, { requestChecksumCalculation: "WHEN_REQUIRED" });
const BUCKET = process.env.S3_BUCKET;
if (!BUCKET) {
  runtimeLogger.warn("[uploads] S3_BUCKET not set; presign routes will fail.");
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const isObjId = (id) => mongoose.isValidObjectId(id);

function publishCaseParticipantRefresh(caseDoc, type = "matter_documents_refresh") {
  publishCaseProjectionRefresh(caseDoc, type, { caseEvent: "" });
}

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
  if (persist && record?._id) await matterFileWrites.persistScan(record, key, scan);
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

const personalDocumentGuard = require('../utils/personalDocumentGuard');

async function replacePersonalDocument({ req, user, field, key, putParams, reason }) {
  const accountFilter = personalDocumentGuard.prepare(req, user, field);
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
    if (accountFilter) await accountWriteGuard.saveFields(User, user, [field], accountFilter);
    else await user.save();
  } catch (error) {
    await finalizeStorageTaskTransition(
      () => activatePersonalStorageDeletion(newTaskIds),
      "activate_upload_compensation"
    );
    await finalizeStorageTaskTransition(
      () => accountFilter ? activatePersonalStorageDeletion(oldTaskIds) : cancelPersonalStorageDeletion(oldTaskIds),
      accountFilter ? "reconcile_replaced_document_deletion" : "cancel_replaced_object_deletion"
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
        if (isParalegal && cleaned.includes("/documents/")) {
          const record = await findCaseFileForObject(caseDoc._id, cleaned);
          if (
            record &&
            !isRecordVisibleToCurrentAssignment(record, caseDoc, {
              role,
              userId: viewerId,
              isParalegal: true,
            })
          ) {
            return false;
          }
        }
        if (await matterRetirement.retired(caseDoc._id, cleaned) && !await matterRetirement.referenced(caseDoc._id, cleaned, { viewer: { role, userId: viewerId, isParalegal } })) return false;
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
    const owner = await User.findById(ownerId).select("_id resumeURL certificateURL writingSampleURL");
    const current = owner && Object.keys(personalDocumentGuard.TYPES).some(field => personalDocumentGuard.keyOf(owner, field) === cleaned);
    if (current) {
      if (viewerRole === "attorney") {
        if (await attorneyCanAccessPersonalOwner(viewerId, ownerId)) return true;
        return attorneyCanBrowsePersonalOwner(ownerId);
      }
      return ownerId === viewerId;
    }
    const references = require("../services/personalDocumentReferences");
    if (ownerId === viewerId) return references.hasRetainedResumeReference(ownerId, cleaned);
    if (viewerRole === "attorney") return references.attorneyCanAccessRecordedResume(req, ownerId, cleaned);
    return false;
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
  // Multipart forms use flat fields; reject oversized numeric bracket indexes.
  limits: { fileSize: MAX_CASE_FILE_BYTES, fieldArrayIndexLimit: 0 },
});
const profilePhotoUpload = multer({
  storage: multer.memoryStorage(),
  // Multipart forms use flat fields; reject oversized numeric bracket indexes.
  limits: { fileSize: MAX_PROFILE_PHOTO_BYTES, fieldArrayIndexLimit: 0 },
});

// ----------------------------------------
// All routes require auth + approval
// ----------------------------------------
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));
router.use(require("../utils/requestOwner"));

/**
 * POST /api/uploads/presign
 * Body: { contentType, ext, size, caseId, checksumSha256?, contentDisposition? }
 * - returns { url, key, expiresAt, requiredHeaders }; PUT must include the returned headers
 * - verifies current Matter participation and write authority before issuing a link.
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
      const writeReq = { ...req, params: { ...req.params, caseId: String(caseId).toLowerCase() } };
      const caseDoc = await matterFileWrites.read(writeReq);

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
      if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
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
      const key = `${buildCasePrefix(caseDoc._id)}documents/${filename}`.replace(/\/+/g, "/");

      // Additional server controls
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        ContentType: normalizedContentType,
        ContentLength: declaredSize,
        IfNoneMatch: "*",
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

      const expiresIn = 60, signingDate = new Date(Math.floor(Date.now() / 1000) * 1000), expiresAt = new Date(signingDate.getTime() + expiresIn * 1000);
      await matterFileWrites.run(writeReq, caseDoc, session => presignedUploads.issue({ caseId: caseDoc._id, ownerId: req.user.id, key, bucket: BUCKET, expiresAt }, session));
      const command = new PutObjectCommand(putParams);
      const url = await getSignedUrl(presignS3, command, { expiresIn, signingDate, signableHeaders: new Set(["if-none-match", "content-type"]) });
      const requiredHeaders = presignedUploads.requiredHeaders(url, putParams);
      await matterFileWrites.read(writeReq);
      if (expiresAt <= new Date()) return res.status(503).json({ msg: "The upload link expired while it was being prepared. Request a new upload link." });
      res.set("Cache-Control", "private, no-store");
      res.json({ url, key, expiresAt: expiresAt.getTime(), requiredHeaders });
    } catch (e) {
      if (matterFileWrites.sendError(res, e)) return;
      runtimeLogger.error("[uploads] presign preparation unavailable", { code: "PRESIGN_UNAVAILABLE" });
      res.status(503).json({ code: "FILE_PRESIGN_UNAVAILABLE", msg: "The upload link could not be prepared. Request a new upload link." });
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

    if (extractPersonalOwnerId(key)) await personalDocumentGuard.checkCurrentRead(req, key);
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
    if (extractPersonalOwnerId(key)) {
      await personalDocumentGuard.checkCurrentRead(req, key);
      if (!await ensureKeyAccess(req, key, req.query.caseId)) return res.status(403).json({ msg: "Forbidden" });
    }
    res.set("Cache-Control", "private, no-store");
    res.redirect(url);
  } catch (e) {
    if (accountWriteGuard.respond(e, res)) return;
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
    if (extractPersonalOwnerId(normalizedKey)) await personalDocumentGuard.checkCurrentRead(req, normalizedKey);
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
    if (extractPersonalOwnerId(normalizedKey)) {
      await personalDocumentGuard.checkCurrentRead(req, normalizedKey);
      if (!await ensureKeyAccess(req, normalizedKey, req.query.caseId)) return res.status(403).json({ msg: "Forbidden" });
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ url });
  } catch (e) {
    if (accountWriteGuard.respond(e, res)) return;
    runtimeLogger.error(e);
    res.status(500).json({ msg: "signed-get error" });
  }
});
router.get("/download", csrfProtection, async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const key = normalizeKeyPath(req.query.key);
    if (!key) return res.status(400).json({ msg: "Missing key" });

    if (extractPersonalOwnerId(key)) await personalDocumentGuard.checkCurrentRead(req, key);
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
    const attachmentName = { resumeURL: "Resume.pdf", certificateURL: "Certificate.pdf", writingSampleURL: "Writing sample.pdf" }[req.query.documentField];
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key, ...(extractPersonalOwnerId(key) && req.query.download === "true" && attachmentName ? { ResponseContentDisposition: `attachment; filename="${attachmentName}"` } : {}) });
    const url = await getSignedUrl(s3, getCmd, { expiresIn });
    if (extractPersonalOwnerId(key)) {
      await personalDocumentGuard.checkCurrentRead(req, key);
      if (!await ensureKeyAccess(req, key, req.query.caseId)) return res.status(403).json({ msg: "Forbidden" });
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ url, expiresAt: Date.now() + expiresIn * 1000 });
  } catch (e) {
    if (accountWriteGuard.respond(e, res)) return;
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
    accountWriteGuard.checkOwner(req);
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
      req,
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

    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "profile_document_refresh",
    });

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/paralegal-writing-sample",
  requireRole("paralegal"),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    accountWriteGuard.checkOwner(req);
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
      req,
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

    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "profile_document_refresh",
    });

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/paralegal-resume",
  requireRole("paralegal"),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    accountWriteGuard.checkOwner(req);
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
      req,
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
    accountWriteGuard.checkOwner(req);
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

    let user = await User.findById(ownerId).select(
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!user) return res.status(404).json({ msg: "User not found" });
    const accountFilter = accountWriteGuard.photoGuard(req, user)
      ? accountWriteGuard.captureFilter(user, accountWriteGuard.PHOTO_FIELDS) : null;
    const role = String(user.role || "").toLowerCase();
    // Client-supplied image bytes cannot prove an approval-preserving crop.
    // Retain the approved asset while every paralegal replacement awaits review.
    const requiresReview = role === "paralegal";
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
      if (accountFilter) user = await accountWriteGuard.saveFields(User, user, accountWriteGuard.PHOTO_FIELDS, accountFilter);
      else await user.save();
    } catch (error) {
      await finalizeStorageTaskTransition(
        () => activatePersonalStorageDeletion(newTaskIds),
        "activate_profile_upload_compensation"
      );
      await finalizeStorageTaskTransition(
        () => accountFilter ? activatePersonalStorageDeletion(oldTaskIds) : cancelPersonalStorageDeletion(oldTaskIds),
        accountFilter ? "reconcile_replaced_profile_deletion" : "cancel_replaced_profile_deletion"
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

    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "profile_photo_refresh",
    });

    return res.json({
      success: true,
      url: requiresReview ? pendingDisplayUrl : approvedDisplayUrl,
      status: user.profilePhotoStatus || (requiresReview ? "pending_review" : "approved"),
      pending: requiresReview,
      pendingProfileImage: requiresReview ? pendingDisplayUrl : "",
      pendingProfileImageOriginal: requiresReview ? user.pendingProfileImageOriginal || "" : "",
      profileImage: requiresReview ? user.profileImage || "" : approvedDisplayUrl,
      profileImageOriginal: user.profileImageOriginal || "",
      profilePhotoRevision: accountWriteGuard.photoRevision(user),
    });
  })
);

router.get(
  "/profile-photo/original",
  asyncHandler(async (req, res) => {
    accountWriteGuard.checkOwner(req, req.query);
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });
    const user = await User.findById(ownerId).select(
      "pendingProfileImageOriginal profileImageOriginal pendingProfileImage profileImage avatarURL profilePhotoStatus " +
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!user) return res.status(404).json({ msg: "User not found" });
    if (req.query.expectedPhotoRevision !== undefined) accountWriteGuard.photoGuard(req, user, req.query);
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

const attorneyMatterUploads = require("../services/attorneyMatterUploads");
router.get("/case/:caseId/upload-review", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await attorneyMatterUploads.review(req)); } catch (error) { attorneyMatterUploads.sendError(res, error); }
}));
router.post("/case/:caseId/reviewed-upload", requireRole("attorney"), csrfProtection, caseFileMiddleware, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  if (!BUCKET) return attorneyMatterUploads.sendError(res, {});
  try { res.json(await attorneyMatterUploads.send(req, { putObject: params => s3.send(new PutObjectCommand({ ...params, Bucket: BUCKET, ACL: "private", ...sseParams() })) })); }
  catch (error) { attorneyMatterUploads.sendError(res, error); }
}));
router.get("/case/:caseId/replacement-review/:fileId", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await attorneyMatterUploads.review(req)); } catch (error) { attorneyMatterUploads.sendError(res, error); }
}));
router.post("/case/:caseId/reviewed-replacement/:fileId", requireRole("attorney"), csrfProtection, caseFileMiddleware, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  if (!BUCKET) return attorneyMatterUploads.sendError(res, {});
  try { res.json(await attorneyMatterUploads.send(req, { putObject: params => s3.send(new PutObjectCommand({ ...params, Bucket: BUCKET, ACL: "private", ...sseParams() })) })); }
  catch (error) { attorneyMatterUploads.sendError(res, error); }
}));

router.post(
  "/case/:caseId",
  ensureCaseParticipant(),
  csrfProtection,
  caseFileMiddleware,
  asyncHandler(matterFileWrites.handle(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    const writeReview = await matterFileWrites.read(req);
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "File is required" });
    if (req.file.size > MAX_CASE_FILE_BYTES) {
      return res.status(400).json({ msg: "File exceeds maximum allowed size" });
    }

    const originalName = normalizeFileName(req.file.originalname, `case-file-${Date.now()}`);
    const clientUploadId = String(req.body?.clientUploadId || "").trim();
    if (clientUploadId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(clientUploadId)) {
      return res.status(400).json({ msg: "Invalid upload request id" });
    }
    const present = result => ({ file: req.query?.presentation === "matter" ? serializeMatterCaseFile(result.file) : serializeCaseFile(result.file), idempotent: true, ...(result.changedSinceUpload ? { changedSinceUpload: true } : {}) });
    const prior = await matterFileWrites.prepareUpload(req, writeReview, { name: originalName, clientUploadId, revisionOfFileId: String(req.body?.revisionOfFileId || "").trim(), revisionRequestAt: String(req.body?.revisionRequestAt || ""), onlyRecorded: true });
    if (prior.recorded) return res.status(200).json(present(prior.recorded));
    let revisionSource = null;
    const revisionOfFileId = String(req.body?.revisionOfFileId || "").trim();
    if (revisionOfFileId) {
      if (req.user?.role !== "paralegal" || !mongoose.Types.ObjectId.isValid(revisionOfFileId)) {
        return res.status(400).json({ msg: "Invalid revision reference" });
      }
      revisionSource = await CaseFile.findOne(applyAssignmentVisibility(
        { _id: revisionOfFileId, caseId: caseDoc._id, uploadedByRole: "paralegal", status: "attorney_revision" },
        caseDoc, { role: req.user.role, userId: req.user.id, isParalegal: true }
      ));
      if (!revisionSource) return res.status(409).json({ msg: "This revision request is no longer available. Refresh Files before submitting." });
      const requestedAt = String(req.body?.revisionRequestAt || "");
      if (requestedAt !== (revisionSource.revisionRequestedAt?.toISOString() || "")) {
        return res.status(409).json({ msg: "The revision request changed. Refresh Files and review the latest instructions." });
      }
      const visibleFiles = await CaseFile.find(applyAssignmentVisibility(
        { caseId: caseDoc._id }, caseDoc, { role: req.user.role, userId: req.user.id, isParalegal: true }
      )).select("caseId uploadedByRole status version revisionRequestedAt revisionOfFileId revisionOfVersion revisionRequestAt approvedAt").lean();
      if (projectRevisionResolutions(visibleFiles).find(file => String(file._id) === revisionOfFileId)?.revisionResolution) {
        return res.status(409).json({ msg: "The attorney has already approved a response to this revision request. Refresh Files before submitting." });
      }
    }
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
    // Recorded retries remain readable when delivery infrastructure is down.
    // A new upload must be able to retain its eligible delivery obligation.
    try { await matterFileNotifications.ready(); }
    catch (cause) { throw Object.assign(new Error("Uploads are temporarily unavailable. Please try again.", { cause }), { status: 503, publicCode: "FILE_WRITE_DELIVERY_UNAVAILABLE" }); }
    const pending = await matterFileWrites.prepareUpload(req, writeReview, { name: originalName, clientUploadId, revisionOfFileId, revisionRequestAt: String(req.body?.revisionRequestAt || "") });
    if (pending.recorded) return res.status(200).json(present(pending.recorded));
    const key = pending.key;
    const uploadRole = String(req.user?.role || "attorney").toLowerCase();
    const defaultStatus = "pending_review";
    const version = Math.max(await nextCaseFileVersion(caseDoc._id, originalName), revisionSource ? Number(revisionSource.version || 1) + 1 : 1);
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || "application/octet-stream",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    try { await s3.send(new PutObjectCommand(putParams)); }
    catch (error) { await matterRetirement.settleAttempt(pending.operation, "unconfirmed").catch(reportOperationalFailure("routes.uploads.upload_retirement_outcome")); await matterFileWrites.unconfirmedUpload(pending.operation, "failed"); throw error; }
    await matterRetirement.settleAttempt(pending.operation, "uploaded");

    let entry, recoveredResult, dispatchNotification = null;
    let liveRefreshRecipientId = null;
    let notificationSuppressedByPresence = false;
    try {
      entry = await matterFileWrites.run(req, writeReview, async (session, currentMatter) => {
        // A retried, uncommitted transaction must discard its earlier dispatch.
        dispatchNotification = null;
        await matterFileWrites.recordUpload(pending.operation, session);
        if (revisionSource) {
          const current = await CaseFile.findOne({ _id: revisionSource._id, caseId: caseDoc._id }).session(session);
          if (!current || current.status !== revisionSource.status || String(current.revisionRequestedAt?.toISOString() || "") !== String(revisionSource.revisionRequestedAt?.toISOString() || "") || Number(current.get("__v") || 0) !== Number(revisionSource.get("__v") || 0)) throw Object.assign(new Error("The revision request changed. Refresh Files before submitting."), { status: 409, publicCode: "FILE_WRITE_REVISION_CHANGED" });
        }
        const [stored] = await CaseFile.create([{ _id: pending.operation.fileId,
        caseId: caseDoc._id,
        userId: req.user.id,
        originalName,
        storageKey: key,
        previewKey: "",
        mimeType: req.file.mimetype || "",
        previewMimeType: "",
        size: req.file.size || 0,
        previewSize: 0,
        ...(clientUploadId ? { clientUploadId } : {}),
        securityStatus: malwareScanRequired() ? "pending" : "not_required",
        securityScanResult: malwareScanRequired() ? "PENDING" : "NOT_REQUIRED",
        uploadedByRole: uploadRole,
        status: defaultStatus,
        revisionOfFileId: revisionSource?._id || null,
        revisionOfVersion: revisionSource?.version || null,
        revisionRequestAt: revisionSource?.revisionRequestedAt || null,
        version,
        }], { session });
        await AuditLog.logFromReq(req, "file_uploaded", {
          targetType: "case", targetId: currentMatter._id, caseId: currentMatter._id,
          meta: { fileId: String(stored._id) }, session,
        });
        liveRefreshRecipientId = uploadRole === "attorney"
          ? currentMatter.paralegal || currentMatter.paralegalId
          : currentMatter.attorney || currentMatter.attorneyId;
        notificationSuppressedByPresence = Boolean(liveRefreshRecipientId && await isWorkspacePresenceActive(liveRefreshRecipientId, currentMatter._id, "files"));
        if (liveRefreshRecipientId && !notificationSuppressedByPresence) {
          dispatchNotification = await notifyUser(liveRefreshRecipientId, "case_file_uploaded", {
            caseId: String(currentMatter._id), caseTitle: caseDoc.title || "Untitled Matter",
            fileId: String(stored._id), fileName: originalName,
            link: `case-detail.html?caseId=${currentMatter._id}&tab=files&fileId=${stored._id}`,
          }, { actorUserId: req.user.id, session, deferDispatch: true, fileUpload: { id: pending.operation._id, version } });
        }
        return stored;
      });
    } catch (err) {
      await matterFileWrites.unconfirmedUpload(pending.operation);
      const recovered = await matterFileWrites.recoverUpload(req, pending.operation);
      if (!recovered) throw err;
      entry = recovered.file;
      recoveredResult = recovered;
    }

    // The stored file can be reconciled by both open workspaces immediately;
    // only live invalidation follows the commit; email runs in the worker.
    publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(caseDoc, "case_file_uploaded_refresh");

    await dispatchNotification?.();

    // Presence suppresses the stored alert, not live state reconciliation.
    if (liveRefreshRecipientId && notificationSuppressedByPresence) {
      publishNotificationEvent(liveRefreshRecipientId, "notifications", {
        at: new Date().toISOString(),
        type: "case_file_uploaded_refresh",
      });
    }

    await matterFileWrites.read(req);
    if (recoveredResult) return res.status(200).json(present(recoveredResult));
    res.status(201).json({
      file: req.query?.presentation === "matter"
        ? serializeMatterCaseFile(entry)
        : serializeCaseFile(entry),
    });
  }))
);

router.get(
  "/case/:caseId",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin, isParalegal } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    const attorneyReq = { ...req, query: { expectedOwnerId: String(req.user.id) } };
    let reviewedMatter = null;
    try { if (req.user.role === "attorney") reviewedMatter = await attorneyFiles.matter(attorneyReq); }
    catch (error) { return attorneyFiles.sendError(res, error); }
    const files = await CaseFile.find(applyAssignmentVisibility(
      { caseId: caseDoc._id },
      caseDoc,
      { role: req.user?.role, userId: req.user?.id, isParalegal }
    )).sort({ createdAt: -1 }).lean();
    const serializer = req.query?.presentation === "matter"
      ? serializeMatterCaseFile
      : serializeCaseFile;
    if (reviewedMatter) {
      let current;
      try { current = await attorneyFiles.matter(attorneyReq); } catch (error) { return attorneyFiles.sendError(res, error); }
      if (attorneyFiles.matterRevision(current) !== attorneyFiles.matterRevision(reviewedMatter)) return attorneyFiles.sendError(res, { status: 409, publicCode: "DOCUMENT_MATTER_CHANGED" });
    }
    // Use the raw persisted fields before adding derived revision resolutions.
    const reviews = new Map(reviewedMatter ? files.map(file => [String(file._id), attorneyFiles.shape(file, reviewedMatter)]) : []);
    res.set("Cache-Control", "private, no-store");
    res.json({ files: projectRevisionResolutions(files).map(file => {
      const serialized = serializer(file), review = reviews.get(String(file._id));
      return review ? { ...serialized, reviewRevision: review.reviewRevision, reviewOwnerId: String(req.user.id), canReview: review.canReview } : serialized;
    }) });
  })
);

router.get("/case/:caseId/removal-review/:fileId", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await fileRemoval.review(req)); } catch (error) { fileRemoval.sendError(res, error); }
}));
router.post("/case/:caseId/reviewed-removal/:fileId", requireRole("attorney"), csrfProtection, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await fileRemoval.remove(req)); } catch (error) { fileRemoval.sendError(res, error); }
}));
router.delete("/case/:caseId/:fileId", ensureCaseParticipant(), requireRole("attorney"), csrfProtection, asyncHandler(async (req, res) => {
  try { res.json({ ok: true, ...await fileRemoval.legacy(req, req.params.fileId) }); } catch (error) { fileRemoval.sendError(res, error); }
}));

router.get(
  "/case/:caseId/:fileId/security-status",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin, isParalegal } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!isObjId(req.params.fileId)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const record = await CaseFile.findOne(applyAssignmentVisibility(
      { _id: req.params.fileId, caseId: caseDoc._id },
      caseDoc,
      { role: req.user?.role, userId: req.user?.id, isParalegal }
    ));
    if (!record) return res.status(404).json({ msg: "File not found" });
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const plainRecord = decryptCaseFilePayload(record);
    const previousSecurityStatus = String(record.securityStatus || "");
    const scan = await refreshCaseFileSecurity(record, plainRecord.storageKey, { enforce: false });
    if (String(scan.status || "") !== previousSecurityStatus) {
      publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(caseDoc, "case_file_security_refresh");
    }
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
    const { caseDoc, isAdmin, isParalegal } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Administrators can only access the Matter archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!isObjId(req.params.fileId)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const record = await CaseFile.findOne(applyAssignmentVisibility(
      { _id: req.params.fileId, caseId: caseDoc._id },
      caseDoc,
      { role: req.user?.role, userId: req.user?.id, isParalegal }
    ));
    if (!record) {
      return res.status(404).json({ msg: "File not found" });
    }
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const plainRecord = decryptCaseFilePayload(record);
    const previousSecurityStatus = String(record.securityStatus || "");
    try {
      const scan = await refreshCaseFileSecurity(record, plainRecord.storageKey);
      if (String(scan.status || "") !== previousSecurityStatus) {
        publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
        publishCaseParticipantRefresh(caseDoc, "case_file_security_refresh");
      }
    } catch (err) {
      if (String(record.securityStatus || "") !== previousSecurityStatus) {
        publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
        publishCaseParticipantRefresh(caseDoc, "case_file_security_refresh");
      }
      if (err?.statusCode) return res.status(err.statusCode).json({ msg: err.message, code: err.code });
      throw err;
    }
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(plainRecord.storageKey) });
    const data = await s3.send(getCmd);
    const filename = plainRecord.originalName || `case-file-${record._id}`;
    const mimeType = String(plainRecord.mimeType || "application/octet-stream").toLowerCase();
    const previewableMimeTypes = new Set([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/gif",
      "text/plain",
      "text/csv",
    ]);
    const previewInline = String(req.query.preview || "").toLowerCase() === "true"
      && previewableMimeTypes.has(mimeType);
    res.setHeader("Content-Type", mimeType);
    if (plainRecord.size) {
      res.setHeader("Content-Length", String(plainRecord.size));
    }
    res.setHeader(
      "Content-Disposition",
      `${previewInline ? "inline" : "attachment"}; filename="${encodeURIComponent(filename)}"`
    );
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
    "_id attorney attorneyId paralegal paralegalId title escrowIntentId escrowStatus status paymentReleased readOnly paralegalAccessRevokedAt withdrawnParalegalId hiredAt preEngagement.requestedParalegalId preEngagement.confidentialityDocument.key preEngagement.paralegalConfidentialityDocument.key"
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
    revisionResolution: plain.revisionResolution || null,
    revisionOfFileId: plain.revisionOfFileId ? String(plain.revisionOfFileId) : null,
    revisionOfVersion: plain.revisionOfVersion || null,
    revisionRequestAt: plain.revisionRequestAt || null,
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
    revisionResolution: file.revisionResolution,
    revisionOfFileId: file.revisionOfFileId,
    revisionOfVersion: file.revisionOfVersion,
    revisionRequestAt: file.revisionRequestAt,
    revisionNotes: file.revisionNotes,
    revisionRequestedAt: file.revisionRequestedAt,
    approvedAt: file.approvedAt,
    replacedAt: file.replacedAt,
  };
}

module.exports = router;
