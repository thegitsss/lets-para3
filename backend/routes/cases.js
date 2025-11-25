// backend/routes/cases.js
const router = require("express").Router();
const mongoose = require("mongoose");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireCaseAccess } = require("../utils/authz");
const Case = require("../models/Case");
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

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const FILE_STATUS = ["pending_review", "approved", "attorney_revision"];

const S3_BUCKET = process.env.S3_BUCKET || "";
const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials:
    process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY,
        }
      : undefined,
});
if (!S3_BUCKET) {
  console.warn("[cases] S3_BUCKET not set; signed file downloads will fail.");
}

function cleanString(value, { len = 400 } = {}) {
  if (!value || typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, len);
}

const DOLLARS_RX = /[^0-9.\-]/g;
function dollarsToCents(input) {
  if (input === null || typeof input === "undefined") return null;
  const value =
    typeof input === "number"
      ? input
      : parseFloat(String(input).replace(DOLLARS_RX, ""));
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.round(value * 100));
}

function parseListField(value) {
  if (!value && value !== 0) return [];
  const source = Array.isArray(value)
    ? value
    : String(value)
        .split(/\r?\n|,/)
        .map((entry) => entry.trim());
  return source
    .map((entry) => cleanString(entry, { len: 500 }))
    .filter(Boolean);
}

function buildDetails(description, requirements = [], questions = []) {
  const parts = [];
  const base = cleanString(description || "", { len: 100_000 });
  if (base) parts.push(base);
  if (requirements.length) {
    parts.push(`Requirements:\n- ${requirements.join("\n- ")}`);
  }
  if (questions.length) {
    parts.push(`Screening questions:\n- ${questions.join("\n- ")}`);
  }
  return parts.join("\n\n").trim();
}

function buildBriefSummary({ state, employmentType, experience }) {
  const bits = [];
  const safeState = cleanString(state || "", { len: 200 });
  const safeEmployment = cleanString(employmentType || "", { len: 200 });
  const safeExperience = cleanString(experience || "", { len: 200 });
  if (safeState) bits.push(`State: ${safeState}`);
  if (safeEmployment) bits.push(`Engagement: ${safeEmployment}`);
  if (safeExperience) bits.push(`Experience: ${safeExperience}`);
  return bits.join(" • ");
}

function summarizeUser(person) {
  if (!person || typeof person !== "object") return null;
  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || null;
  return {
    id: String(person._id || person.id),
    firstName: person.firstName || null,
    lastName: person.lastName || null,
    name,
    email: person.email || null,
    role: person.role || null,
  };
}

function caseSummary(doc, { includeFiles = false } = {}) {
  const paralegal = summarizeUser(doc.paralegal || doc.paralegalId);
  const attorney = summarizeUser(doc.attorney || doc.attorneyId);
  const summary = {
    _id: doc._id,
    id: String(doc._id),
    title: doc.title,
    details: doc.details || "",
    practiceArea: doc.practiceArea || "",
    status: doc.status,
    deadline: doc.deadline,
    zoomLink: doc.zoomLink || "",
    paymentReleased: doc.paymentReleased || false,
    escrowIntentId: doc.escrowIntentId || null,
    assignedTo: paralegal,
    acceptedParalegal: !!paralegal,
    applicants: Array.isArray(doc.applicants) ? doc.applicants.length : 0,
    filesCount: Array.isArray(doc.files) ? doc.files.length : 0,
    jobId: doc.jobId || null,
    attorney,
    paralegal,
    hiredAt: doc.hiredAt || null,
    completedAt: doc.completedAt || null,
    briefSummary: doc.briefSummary || "",
    archived: !!doc.archived,
    downloadUrl: Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
  };
  summary.filesCount = Array.isArray(doc.files) ? doc.files.length : 0;
  if (includeFiles) {
    summary.files = Array.isArray(doc.files) ? doc.files.map(normalizeFile) : [];
  }
  return summary;
}

function normalizeFile(file) {
  const original = file.original || file.filename || "";
  return {
    id: file._id ? String(file._id) : undefined,
    key: file.key,
    original,
    filename: file.filename || original,
    mime: file.mime || null,
    size: file.size || null,
    uploadedBy: file.uploadedBy ? String(file.uploadedBy) : null,
    uploadedByRole: file.uploadedByRole || null,
    uploadedAt: file.createdAt || file.updatedAt || file.uploadedAt || null,
    status: file.status || "pending_review",
    version: typeof file.version === "number" ? file.version : 1,
    revisionNotes: file.revisionNotes || "",
    revisionRequestedAt: file.revisionRequestedAt || null,
    approvedAt: file.approvedAt || null,
    replacedAt: file.replacedAt || null,
  };
}

function findFile(doc, fileId) {
  if (!doc || !Array.isArray(doc.files)) return null;
  const byId = doc.files.id?.(fileId);
  if (byId) return byId;
  return doc.files.find((f) => {
    if (!f) return false;
    if (f._id && String(f._id) === String(fileId)) return true;
    return f.key === fileId;
  });
}

function nextFileVersion(doc, filename) {
  if (!Array.isArray(doc?.files) || !filename) return 1;
  const base = String(filename).toLowerCase();
  const versions = doc.files
    .filter((f) => String(f.filename || f.original || "").toLowerCase() === base)
    .map((f) => Number(f.version) || 1);
  if (!versions.length) return 1;
  return Math.max(...versions) + 1;
}

async function signDownload(key) {
  if (!S3_BUCKET) throw new Error("S3 bucket not configured");
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 60 });
}

router.get("/open", verifyToken, requireRole(["paralegal"]), async (req, res) => {
  try {
    const cases = await Case.find({ status: "open" })
      .populate("attorney", "firstName lastName")
      .sort({ createdAt: -1 });

    res.json(cases);
  } catch (err) {
    res.status(500).json({ error: "Failed to load open cases" });
  }
});

// ----------------------------------------
// All case routes require auth + platform roles
// ----------------------------------------
router.use(verifyToken);
router.use(requireRole(["admin", "attorney", "paralegal"]));

/**
 * POST /api/cases
 * Create a new case/job posting (attorney or admin only).
 */
router.post(
  "/",
  requireRole(["admin", "attorney"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { title, practiceArea, description, details, requirements, questions, employmentType, experience } =
      req.body || {};
    const safeTitle = cleanString(title || "", { len: 300 });
    const requirementList = parseListField(requirements);
    const questionList = parseListField(questions);
    const narrative = buildDetails(details || description, requirementList, questionList);
    if (!safeTitle || !narrative) {
      return res.status(400).json({ error: "Title and description are required." });
    }

    const currency = cleanString(req.body?.currency || "usd", { len: 8 }).toLowerCase() || "usd";
    const state = req.body?.state || req.body?.locationState || "";
    const amountInput =
      req.body?.totalAmount ??
      req.body?.budget ??
      req.body?.compensationAmount ??
      req.body?.compAmount ??
      req.body?.compensation;
    const amountCents = dollarsToCents(amountInput);

    const created = await Case.create({
      title: safeTitle,
      practiceArea: cleanString(practiceArea || "", { len: 200 }),
      details: narrative,
      attorney: req.user.id,
      attorneyId: req.user.id,
      status: "open",
      totalAmount: typeof amountCents === "number" && amountCents > 0 ? amountCents : 0,
      currency,
      briefSummary: buildBriefSummary({ state, employmentType, experience }),
      updates: [
        {
          date: new Date(),
          text: "Case posted",
          by: req.user.id,
        },
      ],
    });

    await created.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    try {
      await logAction(req, "case.create", { targetType: "case", targetId: created._id });
    } catch {}

    res.status(201).json(caseSummary(created));
  })
);

/**
 * GET /api/cases/posted
 * List open/active postings for the authenticated attorney (or all if admin).
 */
router.get(
  "/posted",
  requireRole(["admin", "attorney"]),
  asyncHandler(async (req, res) => {
    const filter = {
      archived: { $ne: true },
      status: { $in: ["open", "assigned", "in_progress"] },
    };
    if (req.user.role !== "admin") {
      filter.attorney = req.user.id;
    }

    const docs = await Case.find(filter)
      .sort({ createdAt: -1 })
      .select("title practiceArea status totalAmount currency applicants paralegal hiredAt createdAt briefSummary details");

    const items = docs.map((doc) => ({
      id: doc._id,
      title: doc.title,
      practiceArea: doc.practiceArea,
      status: doc.status,
      totalAmount: doc.totalAmount || 0,
      currency: doc.currency || "usd",
      applicants: doc.applicants || [],
      applicantsCount: Array.isArray(doc.applicants) ? doc.applicants.length : 0,
      paralegal: doc.paralegal || null,
      hiredAt: doc.hiredAt || null,
      createdAt: doc.createdAt,
      briefSummary: doc.briefSummary || "",
    }));

    res.json({ items });
  })
);

/**
 * GET /api/cases/my
 * Returns the most recent cases relevant to the authenticated user.
 */
router.get(
  "/my",
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 12, 1, 50);
    const role = req.user.role;
    const userId = req.user.id;

    const includeFiles = String(req.query.withFiles || "").toLowerCase() === "true";
    const filter = {};
    if (role === "attorney") {
      filter.attorney = userId;
    } else if (role === "paralegal") {
      filter.$or = [{ paralegal: userId }, { "applicants.paralegalId": userId }];
    } else {
      // admin: optional filter by attorney/paralegal query params
      if (req.query.attorney && isObjId(req.query.attorney)) filter.attorney = req.query.attorney;
      if (req.query.paralegal && isObjId(req.query.paralegal)) filter.paralegal = req.query.paralegal;
    }

    if (typeof req.query.archived !== "undefined") {
      filter.archived = String(req.query.archived).toLowerCase() === "true";
    }

    const docs = await Case.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(
        "title details practiceArea status deadline zoomLink paymentReleased escrowIntentId applicants files jobId createdAt updatedAt attorney attorneyId paralegal paralegalId hiredAt completedAt briefSummary archived downloadUrl"
      )
      .populate("paralegalId", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("attorney", "firstName lastName email role avatarURL")
      .lean();

    res.json(docs.map((doc) => caseSummary(doc, { includeFiles })));
  })
);

router.patch(
  "/:caseId",
  csrfProtection,
  requireCaseAccess("caseId", { project: "title details practiceArea totalAmount currency status briefSummary" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can update this case" });
    }
    const doc = req.case;
    const body = req.body || {};

    if (typeof body.title === "string" && body.title.trim()) {
      doc.title = cleanString(body.title, { len: 300 });
    }
    const updatedDetails = typeof body.details === "string" ? body.details : typeof body.description === "string" ? body.description : null;
    if (updatedDetails) {
      doc.details = cleanString(updatedDetails, { len: 100_000 });
    }
    if (typeof body.practiceArea === "string") {
      doc.practiceArea = cleanString(body.practiceArea, { len: 200 });
    }
    if (typeof body.briefSummary === "string") {
      doc.briefSummary = cleanString(body.briefSummary, { len: 1000 });
    }
    const amountInput =
      body.totalAmount ?? body.budget ?? body.compensationAmount ?? body.compAmount;
    if (typeof amountInput !== "undefined" && amountInput !== null) {
      const cents = dollarsToCents(amountInput);
      if (cents !== null && cents >= 0) {
        doc.totalAmount = cents;
      }
    }
    if (typeof body.currency === "string" && body.currency.trim()) {
      doc.currency = cleanString(body.currency, { len: 8 }).toLowerCase();
    }

    await doc.save();
    await doc.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    try {
      await logAction(req, "case.update", { targetType: "case", targetId: doc._id });
    } catch {}

    res.json(caseSummary(doc));
  })
);

router.delete(
  "/:caseId",
  csrfProtection,
  requireCaseAccess("caseId", { project: "status paralegal attorney" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can delete this case" });
    }
    const doc = req.case;
    if (doc.paralegal) {
      return res.status(400).json({ error: "Cannot delete a case after hiring a paralegal" });
    }
    if (!["open", "awaiting_documents"].includes(doc.status)) {
      return res.status(400).json({ error: "Only open cases can be deleted" });
    }

    await Case.deleteOne({ _id: doc._id });
    try {
      await logAction(req, "case.delete", { targetType: "case", targetId: doc._id });
    } catch {}
    res.json({ ok: true });
  })
);

/**
 * PATCH /api/cases/:caseId/zoom
 * Body: { zoomLink }
 * Only attorneys on the case or admins may update the link.
 */
router.patch(
  "/:caseId/zoom",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAdmin && !req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the case attorney or an admin may update Zoom" });
    }
    const { zoomLink } = req.body || {};
    const doc = await Case.findById(req.params.caseId).select("zoomLink title");
    if (!doc) return res.status(404).json({ error: "Case not found" });

    doc.zoomLink = cleanString(zoomLink || "", { len: 2000 });
    await doc.save();

    try {
      await logAction(req, "case.zoom.update", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { zoomLink: doc.zoomLink },
      });
    } catch {}

    res.json({ ok: true, zoomLink: doc.zoomLink });
  })
);

/**
 * POST /api/cases/:caseId/files
 * Body: { key, original?, mime?, size? }
 * Attaches a file record (S3 key) to the case.
 */
router.post(
  "/:caseId/files",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    const { key, original, mime, size } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;

    const filename = cleanString(original || "", { len: 400 }) || key.split("/").pop();
    const uploadRole = req.user.role || "attorney";
    const defaultStatus = req.acl?.isAttorney || uploadRole === "attorney" ? "attorney_revision" : "pending_review";

    const entry = {
      key: String(key).trim(),
      original: cleanString(original || "", { len: 400 }) || undefined,
      filename,
      mime: typeof mime === "string" ? mime : undefined,
      size: Number.isFinite(Number(size)) ? Number(size) : undefined,
      uploadedBy: req.user.id,
      uploadedByRole: uploadRole,
      status: FILE_STATUS.includes(defaultStatus) ? defaultStatus : "pending_review",
      version: nextFileVersion(doc, filename),
    };

    doc.files = doc.files || [];
    const exists = doc.files.some((f) => f.key === entry.key);
    if (!exists) {
      doc.files.push(entry);
      await doc.save();
      try {
        await logAction(req, "case.file.attach", {
          targetType: "case",
          targetId: doc._id,
          caseId: doc._id,
          meta: { key: entry.key, name: entry.filename },
        });
      } catch {}
    }

    res.status(exists ? 200 : 201).json({ ok: true });
  })
);

/**
 * DELETE /api/cases/:caseId/files
 * Body: { key }
 * Removes the file metadata from the case.
 */
router.delete(
  "/:caseId/files",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    const { key } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;

    const before = doc.files?.length || 0;
    doc.files = (doc.files || []).filter((f) => f.key !== key);
    if ((doc.files?.length || 0) === before) {
      return res.status(404).json({ error: "File not found on case" });
    }
    await doc.save();

    try {
      await logAction(req, "case.file.remove", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { key },
      });
    } catch {}

    res.json({ ok: true });
  })
);

/**
 * GET /api/cases/:caseId/files/signed-get?key=
 * Returns a signed download URL for the specified case file key.
 */
router.get(
  "/:caseId/files/signed-get",
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    const { key } = req.query;
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key query param required" });
    const doc = req.case;
    const file = (doc.files || []).find((f) => f.key === key);
    if (!file) return res.status(404).json({ error: "File not found" });

    try {
      const url = await signDownload(file.key);
      res.json({ url, filename: file.original || file.filename || null });
    } catch (e) {
      console.error("[cases] signed-get error:", e);
      res.status(500).json({ error: "Unable to sign file" });
    }
  })
);

router.patch(
  "/:caseId/files/:fileId/status",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can update file status" });
    }
    const doc = req.case;
    const file = findFile(doc, req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

    const { status, notes } = req.body || {};
    const now = new Date();

    if (status) {
      if (!FILE_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      file.status = status;
      if (status === "approved") file.approvedAt = now;
      else if (status !== "approved") file.approvedAt = null;
      if (status !== "pending_review") {
        file.revisionRequestedAt = null;
        file.revisionNotes = status === "approved" ? "" : file.revisionNotes;
      }
    }
    if (typeof notes === "string") {
      file.revisionNotes = cleanString(notes, { len: 2000 });
      if (file.revisionNotes) file.revisionRequestedAt = now;
    }

    await doc.save();
    try {
      await logAction(req, "case.file.status.update", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id, status: file.status },
      });
    } catch {}

    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  })
);

router.post(
  "/:caseId/files/:fileId/revision-request",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can request revisions" });
    }
    const doc = req.case;
    const file = findFile(doc, req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

    const note = cleanString(req.body?.notes || "", { len: 2000 });
    file.revisionNotes = note;
    file.revisionRequestedAt = new Date();
    file.status = "pending_review";
    file.approvedAt = null;

    await doc.save();
    try {
      await logAction(req, "case.file.revision.request", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id },
      });
    } catch {}

    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  })
);

router.post(
  "/:caseId/files/:fileId/replace",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can replace a document" });
    }
    const { key, original, mime, size } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;
    const file = findFile(doc, req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

    if (!Array.isArray(file.history)) file.history = [];
    file.history.push({ key: file.key, replacedAt: new Date() });

    const filename = cleanString(original || "", { len: 400 }) || key.split("/").pop();
    file.key = String(key).trim();
    file.original = cleanString(original || "", { len: 400 }) || undefined;
    file.filename = filename;
    file.mime = typeof mime === "string" ? mime : undefined;
    file.size = Number.isFinite(Number(size)) ? Number(size) : undefined;
    file.replacedAt = new Date();
    file.uploadedBy = req.user.id;
    file.uploadedByRole = req.user.role || "attorney";
    file.status = "attorney_revision";
    file.version = nextFileVersion(doc, filename);
    file.approvedAt = null;
    file.revisionRequestedAt = null;
    file.revisionNotes = "";

    await doc.save();
    try {
      await logAction(req, "case.file.replace", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id, key: file.key },
      });
    } catch {}

    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  })
);

router.post(
  "/:caseId/apply",
  requireRole(["paralegal"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });

    const doc = await Case.findById(caseId).select("status paralegal applicants archived");
    if (!doc) return res.status(404).json({ error: "Case not found" });
    if (doc.archived) return res.status(400).json({ error: "This case is not accepting applications" });
    if (doc.paralegal) return res.status(400).json({ error: "A paralegal has already been hired" });
    if (doc.status !== "open") return res.status(400).json({ error: "Applications are closed for this case" });

    const note = cleanString(req.body?.note || req.body?.coverLetter || "", { len: 4000 });
    try {
      doc.addApplicant(req.user.id, note);
    } catch (err) {
      return res.status(400).json({ error: err?.message || "You have already applied to this case" });
    }

    await doc.save();
    try {
      await logAction(req, "case.apply", { targetType: "case", targetId: doc._id, meta: { note: Boolean(note) } });
    } catch {}

    res.status(201).json({ ok: true, applicants: doc.applicants.length });
  })
);

/**
 * POST /api/cases/:caseId/hire/:paralegalId
 * Assigns a paralegal to an existing case (attorney-only).
 */
router.post(
  "/:caseId/hire/:paralegalId",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the case attorney can hire for this case" });
    }

    const { caseId, paralegalId } = req.params;
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    const selectedCase = await Case.findById(caseId);
    if (!selectedCase) return res.status(404).json({ error: "Case not found" });

    const rawAttorney = selectedCase.attorney || selectedCase.attorneyId;
    const attorneyOnCase =
      rawAttorney && typeof rawAttorney === "object" && rawAttorney._id
        ? String(rawAttorney._id)
        : String(rawAttorney || "");
    if (!attorneyOnCase || attorneyOnCase !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this case" });
    }

    selectedCase.paralegal = paralegalId;
    selectedCase.paralegalId = paralegalId;
    selectedCase.hiredAt = new Date();
    if (typeof selectedCase.canTransitionTo === "function" && selectedCase.canTransitionTo("in_progress")) {
      selectedCase.transitionTo("in_progress");
    } else {
      selectedCase.status = "in_progress";
    }
    if (Array.isArray(selectedCase.applicants) && selectedCase.applicants.length) {
      selectedCase.applicants.forEach((app) => {
        if (String(app.paralegalId) === String(paralegalId)) {
          app.status = "accepted";
        }
      });
    }

    await selectedCase.save();
    await selectedCase.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    res.json(caseSummary(selectedCase));
  })
);

/**
 * PATCH /api/cases/:caseId/archive
 * Body: { archived?: boolean }
 * Marks a case archived/unarchived (attorney or admin only).
 */
router.patch(
  "/:caseId/archive",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can archive this case" });
    }
    const { archived } = req.body || {};
    const shouldArchive = typeof archived === "boolean" ? archived : true;
    const doc = await Case.findById(req.params.caseId)
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("paralegalId", "firstName lastName email role avatarURL")
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL");
    if (!doc) return res.status(404).json({ error: "Case not found" });

    doc.archived = shouldArchive;
    await doc.save();
    try {
      await logAction(req, shouldArchive ? "case.archive" : "case.restore", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
      });
    } catch {}

    res.json(caseSummary(doc));
  })
);

/**
 * GET /api/cases/:caseId
 * Returns case details needed by the Documents view (includes files array).
 */
router.get(
  "/:caseId",
  requireCaseAccess("caseId", {
    allowApplicants: true,
    alsoAllow: (req, caseDoc) => {
      if (String(req.user.role).toLowerCase() !== "paralegal") return false;
      const isOpen = caseDoc.status === "open" && !caseDoc.archived;
      const hasHire = !!caseDoc.paralegal;
      return isOpen && !hasHire;
    },
    project: "status paralegal attorney applicants archived",
  }),
  asyncHandler(async (req, res) => {
    const doc = await Case.findById(req.params.caseId)
      .select(
        "title status practiceArea deadline zoomLink paymentReleased escrowIntentId totalAmount currency files attorney paralegal applicants hiredAt completedAt briefSummary archived downloadUrl"
      )
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role")
      .populate("applicants.paralegalId", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Case not found" });

    const applicants = Array.isArray(doc.applicants)
      ? doc.applicants.map((entry) => ({
          status: entry.status,
          appliedAt: entry.appliedAt,
          note: entry.note || "",
          paralegalId: entry.paralegalId ? String(entry.paralegalId._id || entry.paralegalId) : null,
          paralegal: summarizeUser(entry.paralegalId),
        }))
      : [];

    res.json({
      id: String(doc._id),
      _id: doc._id,
      title: doc.title,
      status: doc.status,
      zoomLink: doc.zoomLink || "",
      paymentReleased: doc.paymentReleased || false,
      escrowIntentId: doc.escrowIntentId || null,
      totalAmount: doc.totalAmount || 0,
      currency: doc.currency || "usd",
      deadline: doc.deadline || null,
      hiredAt: doc.hiredAt || null,
      completedAt: doc.completedAt || null,
      briefSummary: doc.briefSummary || "",
      archived: !!doc.archived,
      downloadUrl: Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
      attorney: doc.attorney || null,
      paralegal: doc.paralegal || null,
      files: Array.isArray(doc.files) ? doc.files.map(normalizeFile) : [],
      applicants,
    });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error("[cases] route error:", err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
