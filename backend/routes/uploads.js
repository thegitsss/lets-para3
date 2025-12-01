// backend/routes/uploads.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const { requireCaseAccess, sameId } = require("../utils/authz");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const User = require("../models/User");
const { logAction } = require("../utils/audit");

// ----------------------------------------
// Optional CSRF (enable via ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
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

function normalizeKeyPath(key) {
  return String(key || "").replace(/^\/+/, "");
}

function extractCaseIdFromKey(key) {
  const match = normalizeKeyPath(key).match(/cases\/([a-f0-9]{24})\//i);
  return match ? match[1] : null;
}

async function ensureKeyAccess(req, key, explicitCaseId) {
  if (!req.user) return false;
  const cleaned = normalizeKeyPath(key);
  if (!cleaned || cleaned.includes("..")) return false;
  if (!cleaned.startsWith("cases/")) return false;
  if (req.user.role === "admin") return true;

  const caseId = explicitCaseId || extractCaseIdFromKey(cleaned);
  if (caseId) {
    if (explicitCaseId && !cleaned.includes(buildCasePrefix(caseId))) {
      return false;
    }
    return hasCaseAccess(req, caseId);
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
// All routes require auth
// ----------------------------------------
router.use(verifyToken);
router.use(requireRole(["admin", "attorney", "paralegal"]));

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
 * GET /api/uploads/download?key=<s3key>
 * Returns a short-lived GET URL to download a private object the user has rights to.
 * - Users can download files under their personal prefix.
 * - If the key is under cases/<caseId>/..., we verify case access.
 */
// GET /api/uploads/signed-get?caseId=...&key=...
router.get("/signed-get", async (req, res) => {
  try {
    const { caseId, key } = req.query;
    if (!key) return res.status(400).json({ msg: "Missing key" });

    const allowed = await ensureKeyAccess(req, key, caseId);
    if (!allowed) return res.status(403).json({ msg: "Forbidden" });

    const get = new GetObjectCommand({ Bucket: BUCKET, Key: normalizeKeyPath(key) });
    const url = await getSignedUrl(s3, get, { expiresIn: 60 });
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
  requireRole(["paralegal"]),
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

    const key = `paralegal-certificates/${safeSegment(ownerId)}/certificate.pdf`;
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
  "/paralegal-resume",
  requireRole(["paralegal"]),
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

    const key = `paralegal-resumes/${safeSegment(ownerId)}/resume.pdf`;
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

    return res.json({ success: true, url: key });
  })
);

router.post(
  "/profile-photo",
  requireRole(["paralegal", "attorney"]),
  profilePhotoUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "Profile photo is required" });
    if (!/image\/(png|jpe?g)/i.test(req.file.mimetype || "")) {
      return res.status(400).json({ msg: "Only JPEG or PNG images are allowed" });
    }
    if (req.file.size > MAX_PROFILE_PHOTO_BYTES) {
      return res.status(400).json({ msg: "Profile photo exceeds maximum allowed size" });
    }

    const ownerId = String(req.user?.id || req.user?._id || "").trim();
    if (!ownerId) return res.status(400).json({ msg: "Invalid user" });

    const key = `profile-photos/${safeSegment(ownerId)}/profile.jpg`;
    const putParams = {
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || "image/jpeg",
      ContentLength: req.file.size,
      ACL: "private",
      ...sseParams(),
    };
    await s3.send(new PutObjectCommand(putParams));

    const publicUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
    const user = await User.findById(ownerId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    user.profileImage = publicUrl;
    user.avatarURL = publicUrl;
    await user.save();

    try {
      await logAction(req, "user.profile_photo.upload", { targetType: "user", targetId: user._id });
    } catch (err) {
      console.warn("[uploads] profile photo upload audit failed", err?.message || err);
    }

    return res.json({ success: true, url: publicUrl });
  })
);

router.post(
  "/case/:caseId",
  ensureCaseParticipant(),
  caseFileMiddleware,
  asyncHandler(async (req, res) => {
    const { caseDoc } = await loadCaseForUser(req, req.params.caseId);
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    if (!req.file) return res.status(400).json({ msg: "File is required" });
    if (req.file.size > MAX_CASE_FILE_BYTES) {
      return res.status(400).json({ msg: "File exceeds maximum allowed size" });
    }

    const originalName = req.file.originalname || `case-file-${Date.now()}`;
    const safeName = safeSegment(originalName) || `case-file-${Date.now()}`;
    const key = `${buildCasePrefix(caseDoc._id)}documents/${Date.now()}-${safeName}`.replace(/\/+/g, "/");
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
    const entry = await CaseFile.create({
      caseId: caseDoc._id,
      userId: req.user.id,
      originalName,
      storageKey: key,
      mimeType: req.file.mimetype || "",
      size: req.file.size || 0,
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

    res.status(201).json({ file: serializeCaseFile(entry) });
  })
);

router.get(
  "/case/:caseId",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc } = await loadCaseForUser(req, req.params.caseId);
    const files = await CaseFile.find({ caseId: caseDoc._id }).sort({ createdAt: -1 }).lean();
    res.json({ files: files.map(serializeCaseFile) });
  })
);

router.get(
  "/case/:caseId/:fileId/download",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const { caseDoc } = await loadCaseForUser(req, req.params.caseId);
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

async function loadCaseForUser(req, caseId) {
  if (!isObjId(caseId)) {
    const error = new Error("Invalid case id");
    error.statusCode = 400;
    throw error;
  }
  const doc = await Case.findById(caseId).select("_id attorney attorneyId paralegal paralegalId title");
  if (!doc) {
    const error = new Error("Case not found");
    error.statusCode = 404;
    throw error;
  }
  const userId = req.user?.id;
  const isAdmin = req.user?.role === "admin";
  const isAttorney = sameId(doc.attorney, userId) || sameId(doc.attorneyId, userId);
  const isParalegal = sameId(doc.paralegal, userId) || sameId(doc.paralegalId, userId);
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
    mimeType: doc.mimeType || null,
    size: doc.size || 0,
    createdAt: doc.createdAt,
  };
}

module.exports = router;
