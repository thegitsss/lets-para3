// backend/routes/uploads.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const fs = require("fs/promises");
const mongoose = require("mongoose");
const multer = require("multer");
const os = require("os");
const path = require("path");
const util = require("util");
const { execFile } = require("child_process");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const { requireApproved, requireRole, requireCaseAccess, sameId } = require("../utils/authz");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const User = require("../models/User");
const { logAction } = require("../utils/audit");
const { notifyUser } = require("../utils/notifyUser");
const { publishCaseEvent } = require("../utils/caseEvents");
const sendEmail = require("../utils/email");
const { normalizeCaseStatus, canUseWorkspace } = require("../utils/caseState");

const execFileAsync = util.promisify(execFile);
const ENABLE_DOC_PREVIEW_CONVERSION = process.env.ENABLE_DOC_PREVIEW_CONVERSION === "true";

// ----------------------------------------
// CSRF (enabled in production or when ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ----------------------------------------
// S3 client
// ----------------------------------------
const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials:
    process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY,
        }
      : undefined, // falls back to env/role
});
const BUCKET = process.env.S3_BUCKET;
if (!BUCKET) {
  console.warn("[uploads] S3_BUCKET not set; presign routes will fail.");
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

const DOC_PREVIEW_EXTS = new Set(["doc", "docx"]);
const DOC_PREVIEW_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function getFileExtension(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  const parts = trimmed.split(".");
  if (parts.length < 2) return "";
  return parts.pop().toLowerCase();
}

function shouldConvertToPdf({ mimeType, filename } = {}) {
  const ext = getFileExtension(filename);
  const mime = String(mimeType || "").toLowerCase();
  return DOC_PREVIEW_EXTS.has(ext) || DOC_PREVIEW_MIMES.has(mime);
}

function replaceKeyExtension(key, ext) {
  const keyString = String(key || "");
  const lastSlash = keyString.lastIndexOf("/");
  const lastDot = keyString.lastIndexOf(".");
  if (lastDot > lastSlash) {
    return `${keyString.slice(0, lastDot)}${ext}`;
  }
  return `${keyString}${ext}`;
}

async function convertDocToPdfBuffer(buffer, originalName) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lpc-doc-"));
  const ext = getFileExtension(originalName) || "docx";
  const base = safeSegment(originalName.replace(/\.[^/.]+$/, "")) || "document";
  const inputFile = `${base}.${ext}`;
  const inputPath = path.join(tempDir, inputFile);
  try {
    await fs.writeFile(inputPath, buffer);
    await execFileAsync(
      "soffice",
      ["--headless", "--convert-to", "pdf", "--outdir", tempDir, inputPath],
      { timeout: 30000 }
    );
    const outputPath = path.join(tempDir, `${base}.pdf`);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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

function extractKeyFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
  if (!/^https?:\/\//i.test(raw)) return normalizeKeyPath(raw);
  try {
    const parsed = new URL(raw);
    return normalizeKeyPath(parsed.pathname);
  } catch {
    return "";
  }
}

function normalizeFileName(value = "", fallback = "") {
  const cleaned = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (cleaned) return cleaned.slice(0, 500);
  return fallback || `case-file-${Date.now()}`;
}

async function nextCaseFileVersion(caseId, filename) {
  if (!caseId || !filename) return 1;
  const recent = await CaseFile.find({ caseId, originalName: filename })
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
        const { caseDoc, isAdmin } = await loadCaseForUser(req, caseId);
        if (!caseDoc) return false;
        if (!isAdmin && isCaseClosedForAccess(caseDoc)) return false;
        return true;
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
    if (viewerRole === "attorney") return true;
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
const ALLOWED = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
const BLOCKED = [/html/i, /javascript/i, /zip/i, /x-msdownload/i, /octet-stream/i];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CASE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CERT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
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
  async (req, res, next) => {
    try {
      const { caseId } = req.body || {};
      if (!caseId || !isObjId(caseId)) {
        return res.status(400).json({ msg: "Valid caseId is required" });
      }
      return requireCaseAccessInline(req, res, next, "caseId");
    } catch (e) {
      return next(e);
    }
  },
  
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
        return res.status(403).json({ msg: "Work begins once payment is secured." });
      }
      if (!canUseWorkspace(caseDoc)) {
        return res.status(403).json({ msg: "Uploads unlock once the case is funded and in progress." });
      }

      if (!contentType || typeof contentType !== "string") {
        return res.status(400).json({ msg: "contentType required" });
      }
      if (!ALLOWED.has(contentType)) {
        return res.status(400).json({ msg: "Type not allowed" });
      }
      if (BLOCKED.some((rx) => rx.test(contentType))) {
        return res.status(400).json({ msg: "Type not allowed" });
      }

      const declaredSize = Number(size);
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        return res.status(400).json({ msg: "File size is required" });
      }
      if (declaredSize > MAX_FILE_BYTES) {
        return res.status(400).json({ msg: "File exceeds maximum allowed size" });
      }

      const fileExt = safeSegment(ext || "bin");
      const filename = `${crypto.randomUUID()}.${fileExt}`;
      const key = `${buildCasePrefix(caseId)}documents/${filename}`.replace(/\/+/g, "/");

      // Additional server controls
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
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
      console.error("[uploads] presign error", e);
      res.status(500).json({ msg: "presign error" });
    }
  }
);

// Temporary stub for legacy attachment probes
router.post("/attach", (_req, res) => {
  res.json({ ok: true });
});

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
    } catch (err) {
      if (err?.code === "NoSuchKey") return res.status(404).json({ msg: "File not found" });
      throw err;
    }

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: 60 });
    res.redirect(url);
  } catch (e) {
    console.error("[uploads] view error", e);
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
    } catch (err) {
      if (err?.code === "NoSuchKey") return res.status(404).json({ msg: "File not found" });
      throw err;
    }

    const wantsPreview = String(req.query.preview || "").toLowerCase() === "true";
    const ttlRaw = Number(req.query.ttl);
    const ttl = Number.isFinite(ttlRaw) ? Math.min(Math.max(ttlRaw, 60), 900) : wantsPreview ? 600 : 60;
    const get = new GetObjectCommand({ Bucket: BUCKET, Key: normalizedKey });
    const url = await getSignedUrl(s3, get, { expiresIn: ttl });
    res.json({ url });
  } catch (e) {
    console.error(e);
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
    } catch (err) {
      if (err?.code === "NoSuchKey") return res.status(404).json({ msg: "File not found" });
      throw err;
    }

    const expiresIn = 60; // seconds
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn });
    res.json({ url, expiresAt: Date.now() + expiresIn * 1000 });
  } catch (e) {
    console.error("[uploads] download error", e);
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

router.post(
  "/paralegal-certificate",
  requireRole("paralegal"),
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

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

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
    await s3.send(new PutObjectCommand(putParams));

    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    user.certificateURL = key;
    await user.save();

    try {
      await logAction(req, "paralegal.certificate.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      console.warn("[uploads] certificate upload audit failed", err?.message || err);
    }

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/paralegal-writing-sample",
  requireRole("paralegal"),
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

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

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
    await s3.send(new PutObjectCommand(putParams));

    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    user.writingSampleURL = key;
    await user.save();

    try {
      await logAction(req, "paralegal.writingSample.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      console.warn("[uploads] writing sample upload audit failed", err?.message || err);
    }

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/paralegal-resume",
  requireRole("paralegal"),
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

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const timestamp = Date.now();
    const key = `paralegal-resumes/${safeSegment(ownerId)}/resume-${timestamp}.pdf`;
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/pdf",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    await s3.send(new PutObjectCommand(putParams));

    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    user.resumeURL = key;
    await user.save();

    try {
      await logAction(req, "paralegal.resume.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      console.warn("[uploads] resume upload audit failed", err?.message || err);
    }

    try {
      await notifyUser(user._id, "resume_uploaded", {}, { actorUserId: user._id });
    } catch (err) {
      console.warn("[uploads] notifyUser resume_uploaded failed", err);
    }

    res.set("Cache-Control", "no-store");
    return res.json({ success: true, url: key });
  })
);

router.post(
  "/profile-photo",
  requireRole("paralegal", "attorney"),
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

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const key = `profile-photos/${safeSegment(ownerId)}/profile-${Date.now()}.jpg`;
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: photoFile.buffer,
      ContentType: photoFile.mimetype || "image/jpeg",
      ContentLength: photoFile.size,
      ACL: "public-read",
      ...sseParams(),
    };
    await s3.send(new PutObjectCommand(putParams));

    const publicUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
    let originalPublicUrl = "";
    if (originalFile) {
      const originalExt = /png/i.test(originalFile.mimetype || "") ? "png" : "jpg";
      const originalKey = `profile-photos/${safeSegment(ownerId)}/original-${Date.now()}.${originalExt}`;
      const originalPutParams = {
        Bucket: BUCKET,
        Key: originalKey,
        Body: originalFile.buffer,
        ContentType: originalFile.mimetype || "image/jpeg",
        ContentLength: originalFile.size,
        ACL: "public-read",
        ...sseParams(),
      };
      await s3.send(new PutObjectCommand(originalPutParams));
      originalPublicUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${originalKey}`;
    }
    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    const role = String(user.role || "").toLowerCase();
    const requiresReview = role === "paralegal";
    const queueAdminReview = role === "attorney";
    if (requiresReview) {
      user.pendingProfileImage = publicUrl;
      if (originalPublicUrl) {
        user.pendingProfileImageOriginal = originalPublicUrl;
      }
      user.profilePhotoStatus = "pending_review";
    } else {
      user.profileImage = publicUrl;
      user.avatarURL = publicUrl;
      user.pendingProfileImage = queueAdminReview ? publicUrl : "";
      user.pendingProfileImageOriginal = queueAdminReview ? originalPublicUrl || "" : "";
      if (originalPublicUrl) {
        user.profileImageOriginal = originalPublicUrl;
      }
      user.profilePhotoStatus = "approved";
    }
    await user.save();

    try {
      await logAction(req, "user.profile_photo.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      console.warn("[uploads] profile photo upload audit failed", err?.message || err);
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
        console.warn("[uploads] admin photo review email failed", err?.message || err);
      }
    }

    return res.json({
      success: true,
      url: publicUrl,
      status: user.profilePhotoStatus || (requiresReview ? "pending_review" : "approved"),
      pending: requiresReview,
      pendingProfileImage: requiresReview ? publicUrl : "",
      pendingProfileImageOriginal: requiresReview ? user.pendingProfileImageOriginal || "" : "",
      profileImage: requiresReview ? user.profileImage || "" : publicUrl,
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
      "pendingProfileImageOriginal profileImageOriginal pendingProfileImage profileImage avatarURL"
    );
    if (!user) return res.status(404).json({ msg: "User not found" });
    const candidates = [
      user.pendingProfileImageOriginal,
      user.profileImageOriginal,
      user.pendingProfileImage,
      user.profileImage,
      user.avatarURL,
    ]
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (!candidates.length) return res.status(404).json({ msg: "Profile photo not found" });

    let lastErr = null;
    for (const candidate of candidates) {
      const key = extractKeyFromUrl(candidate);
      if (!key) continue;
      try {
        const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
        const obj = await s3.send(getCmd);
        if (!obj?.Body) continue;
        res.set("Content-Type", obj.ContentType || "image/jpeg");
        if (obj.ContentLength) res.set("Content-Length", String(obj.ContentLength));
        res.set("Cache-Control", "no-store");
        obj.Body.pipe(res);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      console.warn("[uploads] profile-photo/original fetch failed", lastErr?.message || lastErr);
    }
    return res.status(404).json({ msg: "Profile photo not found" });
  })
);

router.post(
  "/case/:caseId",
  ensureCaseParticipant(),
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Admins can only access the case archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "File is required" });
    if (req.file.size > MAX_CASE_FILE_BYTES) {
      return res.status(400).json({ msg: "File exceeds maximum allowed size" });
    }

    const originalName = normalizeFileName(req.file.originalname, `case-file-${Date.now()}`);
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

    let previewKey = "";
    let previewMimeType = "";
    let previewSize = 0;
    if (ENABLE_DOC_PREVIEW_CONVERSION && shouldConvertToPdf({ mimeType: req.file.mimetype, filename: originalName })) {
      try {
        const pdfBuffer = await convertDocToPdfBuffer(req.file.buffer, originalName);
        if (pdfBuffer?.length) {
          previewKey = replaceKeyExtension(key, ".pdf");
          const previewParams = {
            Bucket: BUCKET,
            Key: previewKey,
            Body: pdfBuffer,
            ContentType: "application/pdf",
            ContentLength: pdfBuffer.length,
            ACL: "private",
            ...sseParams(),
          };
          await s3.send(new PutObjectCommand(previewParams));
          previewMimeType = "application/pdf";
          previewSize = pdfBuffer.length;
        }
      } catch (err) {
        console.warn("[uploads] pdf preview conversion failed", err?.message || err);
      }
    }

    const entry = await CaseFile.create({
      caseId: caseDoc._id,
      userId: req.user.id,
      originalName,
      storageKey: key,
      previewKey,
      mimeType: req.file.mimetype || "",
      previewMimeType,
      size: req.file.size || 0,
      previewSize,
      uploadedByRole: uploadRole,
      status: defaultStatus,
      version,
    });

    try {
      await logAction(req, "file_uploaded", {
        targetType: "case",
        targetId: caseDoc._id,
        meta: { fileId: entry._id, filename: originalName },
      });
    } catch (err) {
      console.warn("[uploads] file upload audit failed", err?.message || err);
    }

    try {
      const actorRole = String(req.user?.role || "").toLowerCase();
      const recipientId =
        actorRole === "attorney"
          ? caseDoc.paralegal || caseDoc.paralegalId
          : actorRole === "paralegal"
          ? caseDoc.attorney || caseDoc.attorneyId
          : null;
      if (recipientId) {
        const caseId = String(caseDoc._id);
        await notifyUser(
          recipientId,
          "case_file_uploaded",
          {
            caseId,
            caseTitle: caseDoc.title || "Case",
            fileName: originalName,
            link: `case-detail.html?caseId=${encodeURIComponent(caseId)}#caseFilesSection`,
          },
          { actorUserId: req.user.id }
        );
      }
    } catch (err) {
      console.warn("[uploads] notifyUser case_file_uploaded failed", err?.message || err);
    }

    publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
    res.status(201).json({ file: serializeCaseFile(entry) });
  })
);

router.get(
  "/case/:caseId",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Admins can only access the case archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    const files = await CaseFile.find({ caseId: caseDoc._id }).sort({ createdAt: -1 }).lean();
    res.json({ files: files.map(serializeCaseFile) });
  })
);

router.delete(
  "/case/:caseId/:fileId",
  ensureCaseParticipant(),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin, isAttorney } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Admins can only access the case archive." });
    }
    if (!assertWorkspaceReady(caseDoc, res)) return;
    if (!isAdmin && !isAttorney) {
      return res.status(403).json({ msg: "Only the case attorney can delete documents." });
    }
    if (!isObjId(req.params.fileId)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const record = await CaseFile.findOne({ _id: req.params.fileId, caseId: caseDoc._id });
    if (!record) {
      return res.status(404).json({ msg: "File not found" });
    }
    if (BUCKET && record.storageKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(record.storageKey) }));
      } catch (err) {
        console.warn("[uploads] delete object failed", err?.message || err);
      }
    }
    if (BUCKET && record.previewKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(record.previewKey) }));
      } catch (err) {
        console.warn("[uploads] delete preview object failed", err?.message || err);
      }
    }
    await CaseFile.deleteOne({ _id: record._id });
    try {
      await logAction(req, "file_deleted", {
        targetType: "case",
        targetId: caseDoc._id,
        meta: { fileId: record._id, filename: record.originalName },
      });
    } catch (err) {
      console.warn("[uploads] file delete audit failed", err?.message || err);
    }
    publishCaseEvent(caseDoc._id, "documents", { at: new Date().toISOString() });
    res.json({ ok: true });
  })
);

router.get(
  "/case/:caseId/:fileId/download",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc, isAdmin } = await loadCaseForUser(req, req.params.caseId);
    if (isAdmin) {
      return res.status(403).json({ msg: "Admins can only access the case archive." });
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
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(record.storageKey) });
    const data = await s3.send(getCmd);
    const filename = record.originalName || `case-file-${record._id}`;
    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    if (record.size) {
      res.setHeader("Content-Length", String(record.size));
    }
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    data.Body.on("error", (err) => {
      console.error("[uploads] download stream error", err);
      res.destroy(err);
    });
    data.Body.pipe(res);
    data.Body.on("end", () => {
      logAction(req, "file_downloaded", {
        targetType: "case",
        targetId: caseDoc._id,
        meta: { fileId: record._id, filename },
      }).catch(() => {});
    });
  })
);

// ----------------------------------------
// Inline access helpers
// ----------------------------------------
async function hasCaseAccess(req, caseId) {
  return new Promise((resolve) => {
    // re-use requireCaseAccess but in a promise style
    const mw = requireCaseAccess("caseId");
    const mockReq = Object.assign(Object.create(Object.getPrototypeOf(req)), req, {
      params: { ...(req.params || {}), caseId },
    });
    const mockRes = {
      status: () => ({ json: () => resolve(false) }),
      json: () => resolve(false),
    };
    mw(mockReq, mockRes, () => resolve(true));
  });
}

function requireCaseAccessInline(req, res, next, param) {
  const mw = requireCaseAccess(param);
  return mw(req, res, next);
}

function assertWorkspaceReady(caseDoc, res) {
  const hasParalegal = !!(caseDoc?.paralegal || caseDoc?.paralegalId);
  if (!hasParalegal) {
    res.status(403).json({ msg: "Workspace unlocks after a paralegal is hired." });
    return false;
  }
  const escrowFunded =
    !!caseDoc?.escrowIntentId && String(caseDoc?.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) {
    res.status(403).json({ msg: "Work begins once payment is secured." });
    return false;
  }
  if (!canUseWorkspace(caseDoc)) {
    const status = normalizeCaseStatus(caseDoc?.status);
    const closedStatuses = ["completed", "closed", "disputed"];
    const msg = closedStatuses.includes(status)
      ? "Uploads are closed for this case."
      : "Uploads unlock once the case is funded and in progress.";
    res.status(403).json({ msg });
    return false;
  }
  return true;
}

async function loadCaseForUser(req, caseId) {
  if (!isObjId(caseId)) {
    const error = new Error("Invalid case id");
    error.statusCode = 400;
    throw error;
  }
  const doc = await Case.findById(caseId).select(
    "_id attorney attorneyId paralegal paralegalId title escrowIntentId escrowStatus status paymentReleased readOnly paralegalAccessRevokedAt"
  );
  if (!doc) {
    const error = new Error("Case not found");
    error.statusCode = 404;
    throw error;
  }
  const userId = req.user?.id;
  const isAdmin = req.user?.role === "admin";
  const isAttorney = sameId(doc.attorney, userId) || sameId(doc.attorneyId, userId);
  const isParalegal = sameId(doc.paralegal, userId) || sameId(doc.paralegalId, userId);
  if (!isAdmin && isParalegal && doc.paralegalAccessRevokedAt) {
    const error = new Error("Access revoked");
    error.statusCode = 403;
    throw error;
  }
  if (!isAdmin && !isAttorney && !isParalegal) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
  return { caseDoc: doc, isAdmin, isAttorney, isParalegal };
}

function serializeCaseFile(doc) {
  return {
    id: String(doc._id),
    caseId: String(doc.caseId),
    userId: String(doc.userId),
    originalName: doc.originalName,
    storageKey: doc.storageKey,
    previewKey: doc.previewKey || "",
    key: doc.storageKey,
    original: doc.originalName,
    filename: doc.originalName,
    mimeType: doc.mimeType || null,
    mime: doc.mimeType || null,
    previewMimeType: doc.previewMimeType || null,
    previewMime: doc.previewMimeType || null,
    size: doc.size || 0,
    previewSize: doc.previewSize || 0,
    createdAt: doc.createdAt,
    uploadedAt: doc.createdAt,
    uploadedByRole: doc.uploadedByRole || null,
    status: doc.status || "pending_review",
    version: typeof doc.version === "number" ? doc.version : 1,
    revisionNotes: doc.revisionNotes || "",
    revisionRequestedAt: doc.revisionRequestedAt || null,
    approvedAt: doc.approvedAt || null,
    replacedAt: doc.replacedAt || null,
  };
}

module.exports = router;
