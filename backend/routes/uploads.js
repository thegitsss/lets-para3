// backend/routes/uploads.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
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

function buildUserPrefix(user) {
  // e.g., uploads/attorney/64ef.../  (keep consistent for ownership checks)
  return `uploads/${user.role}/${user.id}/`;
}

function buildCasePrefix(caseId) {
  return `cases/${caseId}/`;
}

function userOwnsKey(user, key) {
  // Must live under user's personal prefix OR a case prefix where they have access
  const prefix = buildUserPrefix(user);
  return key.startsWith(prefix);
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
  "image/png",
  "image/jpeg",
  "audio/mpeg",
  "audio/webm",
  "audio/wav",
  "audio/mp4",
  // Uncomment if you want docs/text:
  // "application/msword",
  // "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // "text/plain",
]);

// ----------------------------------------
// All routes require auth
// ----------------------------------------
router.use(verifyToken);

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
      // If caseId present, run case access check; otherwise continue
      const { caseId } = req.body || {};
      if (caseId && isObjId(caseId)) {
        // delegate to middleware then resume handler
        return requireCaseAccessInline(req, res, next, "caseId");
      }
      return next();
    } catch (e) {
      return next(e);
    }
  },
  
  async (req, res) => {
    try {
      const { contentType, ext, folder, caseId, checksumSha256, contentDisposition } = req.body || {};
      if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });

      if (!ALLOWED.has(contentType)) {
        return res.status(400).json({ msg: "Type not allowed" });
      }

      const safeFolder = safeSegment(folder || "uploads", { allowSlash: true }) || "uploads";
      const fileExt = safeSegment(ext || "bin");
      const filename = `${crypto.randomUUID()}.${fileExt}`;

      // Key rules:
      // - If caseId present (and access verified), put under cases/<caseId>/
      // - Else put under user personal prefix uploads/<role>/<userId>/
      const base = caseId && isObjId(caseId) ? buildCasePrefix(caseId) : buildUserPrefix(req.user);
      const key = `${safeFolder}/${base}${filename}`.replace(/\/+/g, "/");

      // Additional server controls
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
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
        putParams.ContentDisposition = contentDisposition;
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

/**
 * GET /api/uploads/download?key=<s3key>
 * Returns a short-lived GET URL to download a private object the user has rights to.
 * - Users can download files under their personal prefix.
 * - If the key is under cases/<caseId>/..., we verify case access.
 */
// GET /api/uploads/signed-get?caseId=...&key=...
router.get('/signed-get', verifyToken, async (req, res) => {
  try {
    const { caseId, key } = req.query;
    if (!key) return res.status(400).json({ msg: 'Missing key' });

    // 🔐 Optional: restrict to a case the user has access to
    // (reuse your requireCaseAccess if you want stricter checking)
    // For now: just allow if logged in
    if (!req.user) return res.status(401).json({ msg: 'Unauthorized' });

    const get = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, get, { expiresIn: 60 }); // 1 minute
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: 'signed-get error' });
  }
});
router.get("/download", csrfProtection, async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ msg: "Server misconfigured (bucket)" });
    const key = String(req.query.key || "").replace(/^\/+/, "");
    if (!key) return res.status(400).json({ msg: "Missing key" });

    // If it's a case file, enforce case access
    const caseMatch = key.match(/^.*\/cases\/([a-f0-9]{24})\//i);
    if (caseMatch && caseMatch[1]) {
      const caseId = caseMatch[1];
      // quick inline access check
      const ok = await hasCaseAccess(req, caseId);
      if (!ok) return res.status(403).json({ msg: "Forbidden" });
    } else {
      // Else require user-owned path
      if (!userOwnsKey(req.user, key)) {
        return res.status(403).json({ msg: "Forbidden" });
      }
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
