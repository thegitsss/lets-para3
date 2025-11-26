// backend/routes/uploads.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireCaseAccess } = require("../utils/authz");

// ----------------------------------------
// Optional CSRF (enable via ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

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
  if (!cleaned) return false;
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
      const { contentType, ext, folder, caseId, checksumSha256, contentDisposition, size } = req.body || {};
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
      const normalizedFolder = String(folder || "").toLowerCase();
      const scope = normalizedFolder.includes("message") || normalizedFolder.includes("voice") ? "messages" : "documents";

      const key = `${buildCasePrefix(caseId)}${scope}/${filename}`.replace(/\/+/g, "/");

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
router.post("/attach", csrfProtection, (_req, res) => {
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

module.exports = router;
