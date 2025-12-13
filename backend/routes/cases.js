// backend/routes/cases.js
const router = require("express").Router();
const mongoose = require("mongoose");
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireCaseAccess } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Case = require("../models/Case");
const User = require("../models/User");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const sendEmail = require("../utils/email");
const { notifyUser } = require("../utils/notifyUser");
const stripe = require("../utils/stripe");
const { cleanText, cleanTitle, cleanMessage } = require("../utils/sanitize");
const { logAction } = require("../utils/audit");
const { generateArchiveZip } = require("../services/caseLifecycle");
const { shapeParalegalSnapshot } = require("../utils/profileSnapshots");

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
const PRACTICE_AREAS = [
  "administrative law",
  "bankruptcy",
  "business law",
  "civil litigation",
  "commercial litigation",
  "contract law",
  "corporate law",
  "criminal defense",
  "employment law",
  "estate planning",
  "family law",
  "immigration",
  "intellectual property",
  "labor law",
  "personal injury",
  "real estate",
  "tax law",
  "technology",
  "trusts & estates",
];
const PRACTICE_AREA_LOOKUP = PRACTICE_AREAS.reduce((acc, name) => {
  acc[name.toLowerCase()] = name;
  return acc;
}, {});
const WORK_STARTED_STATUSES = new Set(["active", "awaiting_documents", "reviewing", "in_progress", "completed", "disputed"]);

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

function safeArchiveName(title) {
  const cleaned = String(title || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .trim();
  return (cleaned || "case-archive").slice(0, 80);
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

function normalizePracticeArea(value) {
  const cleaned = cleanString(value || "", { len: 200 }).toLowerCase();
  if (!cleaned) return "";
  return PRACTICE_AREA_LOOKUP[cleaned] || "";
}

function hasWorkStarted(caseDoc) {
  if (!caseDoc) return false;
  const status = String(caseDoc.status || "").toLowerCase();
  if (WORK_STARTED_STATUSES.has(status)) return true;
  if (Array.isArray(caseDoc.files) && caseDoc.files.length > 0) return true;
  return false;
}

function parseDeadline(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const now = Date.now();
  const maxFuture = now + 365 * 24 * 60 * 60 * 1000;
  if (date.getTime() < now - 60 * 60 * 1000 || date.getTime() > maxFuture) return null;
  return date;
}

function buildDetails(description, questions = []) {
  const parts = [];
  const base = cleanString(description || "", { len: 100_000 });
  if (base) parts.push(base);
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

function formatPersonName(person) {
  if (!person || typeof person !== "object") return "";
  return `${person.firstName || ""} ${person.lastName || ""}`.trim();
}

function shapeInternalNote(note) {
  if (!note) {
    return { note: "", updatedAt: null, updatedBy: null };
  }
  const base = typeof note === "string" ? { text: note } : note;
  return {
    note: base.text || "",
    updatedAt: base.updatedAt || null,
    updatedBy: summarizeUser(base.updatedBy) || (base.updatedBy ? { id: String(base.updatedBy) } : null),
  };
}

function caseSummary(doc, { includeFiles = false } = {}) {
  const paralegal = summarizeUser(doc.paralegal || doc.paralegalId);
  const pendingParalegal = summarizeUser(doc.pendingParalegal || doc.pendingParalegalId);
  const attorney = summarizeUser(doc.attorney || doc.attorneyId);
  const stateValue = doc.state || doc.locationState || "";
  const summary = {
    _id: doc._id,
    id: String(doc._id),
    title: doc.title,
    details: doc.details || "",
    practiceArea: doc.practiceArea || "",
    state: stateValue,
    locationState: doc.locationState || stateValue,
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
    pendingParalegal,
    pendingParalegalId:
      pendingParalegal?.id || (doc.pendingParalegalId ? String(doc.pendingParalegalId) : null),
    pendingParalegalInvitedAt: doc.pendingParalegalInvitedAt || null,
    hiredAt: doc.hiredAt || null,
    completedAt: doc.completedAt || null,
    briefSummary: doc.briefSummary || "",
    archived: !!doc.archived,
    downloadUrl: Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
    readOnly: !!doc.readOnly,
    paralegalAccessRevokedAt: doc.paralegalAccessRevokedAt || null,
    archiveReadyAt: doc.archiveReadyAt || null,
    archiveDownloadedAt: doc.archiveDownloadedAt || null,
    purgeScheduledFor: doc.purgeScheduledFor || null,
    purgedAt: doc.purgedAt || null,
    paralegalNameSnapshot: doc.paralegalNameSnapshot || "",
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    internalNotes: shapeInternalNote(doc.internalNotes),
    termination: {
      status: doc.terminationStatus || "none",
      reason: doc.terminationReason || "",
      requestedAt: doc.terminationRequestedAt || null,
      requestedBy: doc.terminationRequestedBy
        ? summarizeUser(doc.terminationRequestedBy) || { id: String(doc.terminationRequestedBy) }
        : null,
      disputeId: doc.terminationDisputeId || null,
      terminatedAt: doc.terminatedAt || null,
    },
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

async function sendCaseNotification(userId, type, caseDoc, payload = {}) {
  if (!userId) return;
  try {
    await notifyUser(
      userId,
      type,
      Object.assign(
        {
          caseId: caseDoc?._id,
          caseTitle: caseDoc?.title || "Case",
        },
        payload || {}
      )
    );
  } catch (err) {
    console.warn("[cases] notifyUser failed", err);
  }
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

async function ensureFundsReleased(req, caseDoc) {
  if (caseDoc.paymentReleased) return null;
  const paralegal = caseDoc.paralegal;
  if (!paralegal || !paralegal.stripeAccountId) {
    throw new Error("Paralegal cannot be paid until onboarding completes.");
  }
  if (!paralegal.stripeOnboarded) {
    throw new Error("Paralegal must finish Stripe onboarding before payouts.");
  }
  if (!caseDoc.paymentIntentId) {
    throw new Error("Case has no funded payment intent.");
  }

  const budgetCents = Number(caseDoc.totalAmount || 0);
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
    throw new Error("Case total amount is invalid.");
  }
  const feeAmount = Math.max(0, Math.round(budgetCents * 0.15));
  const payout = Math.max(0, budgetCents - feeAmount);
  if (payout <= 0) {
    throw new Error("Calculated payout must be positive.");
  }

  const transfer = await stripe.transfers.create({
    amount: payout,
    currency: caseDoc.currency || "usd",
    destination: paralegal.stripeAccountId,
    transfer_group: `case_${caseDoc._id}`,
    metadata: {
      caseId: String(caseDoc._id),
      attorneyId: String(caseDoc.attorney?._id || caseDoc.attorneyId || ""),
      paralegalId: String(paralegal._id || caseDoc.paralegalId || ""),
      description: "Case completion payout",
    },
  });

  const completedAt = new Date();
  const paralegalName = `${paralegal.firstName || ""} ${paralegal.lastName || ""}`.trim() || "Paralegal";
  caseDoc.paymentReleased = true;
  caseDoc.payoutTransferId = transfer.id;
  caseDoc.paidOutAt = completedAt;
  caseDoc.completedAt = caseDoc.completedAt || completedAt;
  caseDoc.briefSummary = `${caseDoc.title} – ${paralegalName} – completed ${completedAt.toISOString().split("T")[0]}`;

  const attorneyObjectId = caseDoc.attorney?._id || caseDoc.attorneyId || caseDoc.attorney;
  const paralegalObjectId = paralegal._id || caseDoc.paralegalId || caseDoc.paralegal;

  await Promise.all([
    Payout.create({
      paralegalId: paralegalObjectId,
      caseId: caseDoc._id,
      amountPaid: payout,
      transferId: transfer.id,
    }),
    PlatformIncome.create({
      caseId: caseDoc._id,
      attorneyId: attorneyObjectId,
      paralegalId: paralegalObjectId,
      feeAmount,
    }),
  ]);

  try {
    const completedDateStr = completedAt.toLocaleDateString("en-US");
    const payoutDisplay = `$${(payout / 100).toFixed(2)}`;
    const feeDisplay = `$${(feeAmount / 100).toFixed(2)}`;
    const totalDisplay = `$${(budgetCents / 100).toFixed(2)}`;
    if (caseDoc.attorney?.email) {
      const attorneyName = `${caseDoc.attorney.firstName || ""} ${caseDoc.attorney.lastName || ""}`.trim() || "there";
      await sendEmail(
        caseDoc.attorney.email,
        "Your case has been completed",
        `<p>Hi ${attorneyName},</p>
         <p>Your case "<strong>${caseDoc.title}</strong>" was completed on <strong>${completedDateStr}</strong>.</p>
         <p>Deliverables will be available for the next 24 hours.</p>`
      );
    }
    if (paralegal.email) {
      const paraName = `${paralegal.firstName || ""} ${paralegal.lastName || ""}`.trim() || "there";
      await sendEmail(
        paralegal.email,
        "Your payout is complete",
        `<p>Hi ${paraName},</p>
         <p>Your payout for "<strong>${caseDoc.title}</strong>" is complete.</p>
         <p>Job amount: ${totalDisplay}<br/>Service fee (15%): ${feeDisplay}<br/>Final payout: <strong>${payoutDisplay}</strong></p>`
      );
    }
  } catch (err) {
    console.warn("[cases] payout email error", err?.message || err);
  }

  await logAction(req, "case.release", {
    targetType: "case",
    targetId: caseDoc._id,
    caseId: caseDoc._id,
    meta: { payout, feeAmount, transferId: transfer.id },
  });

  return { payout, transferId: transfer.id };
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

// Invitations (must run before ensureCaseParticipant to allow pending paralegals)
router.post(
  "/:caseId/invite/:paralegalId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const role = String(req.user?.role || "").toLowerCase();
    if (!["attorney", "admin"].includes(role)) {
      return res.status(403).json({ error: "Only attorneys can invite paralegals" });
    }
    const { caseId, paralegalId } = req.params;
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    const [caseDoc, paralegal] = await Promise.all([
      Case.findById(caseId),
      User.findById(paralegalId).select("role status firstName lastName"),
    ]);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const attorneyId = String(caseDoc.attorneyId || caseDoc.attorney || "");
    if (role !== "admin" && (!attorneyId || attorneyId !== String(req.user.id))) {
      return res.status(403).json({ error: "You are not the attorney for this case" });
    }
    if (!paralegal || String(paralegal.role).toLowerCase() !== "paralegal" || String(paralegal.status).toLowerCase() !== "approved") {
      return res.status(400).json({ error: "Paralegal is not available for invitation" });
    }
    if (caseDoc.paralegalId) {
      return res.status(400).json({ error: "A paralegal is already assigned to this case" });
    }

    caseDoc.pendingParalegalId = paralegal._id;
    caseDoc.pendingParalegalInvitedAt = new Date();
    caseDoc.paralegal = null;
    caseDoc.paralegalId = null;
    caseDoc.hiredAt = null;
    if (caseDoc.status === "open") caseDoc.status = "assigned";
    await caseDoc.save();

    const inviterName = formatPersonName(req.user) || "An attorney";
    await sendCaseNotification(paralegal._id, "case_invite", caseDoc, {
      inviterName,
    });

    return res.json(caseSummary(caseDoc));
  })
);

router.post(
  "/:caseId/respond-invite",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const role = String(req.user?.role || "").toLowerCase();
    if (role !== "paralegal" && role !== "admin") {
      return res.status(403).json({ error: "Only the invited paralegal may respond" });
    }
    const { caseId } = req.params;
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["accept", "decline"].includes(decision)) {
      return res.status(400).json({ error: "Decision must be accept or decline" });
    }
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });

    const caseDoc = await Case.findById(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const pendingId = caseDoc.pendingParalegalId ? String(caseDoc.pendingParalegalId) : "";
    if (!pendingId) return res.status(400).json({ error: "No pending invitation for this case" });
    if (role !== "admin" && pendingId !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the invited paralegal" });
    }

    const attorneyId = caseDoc.attorneyId || caseDoc.attorney;
    const paralegalId = role === "admin" && req.body?.paralegalId && isObjId(req.body.paralegalId)
      ? req.body.paralegalId
      : req.user.id;
    const paralegalProfile = await User.findById(paralegalId).select("firstName lastName");
    const paralegalName = formatPersonName(paralegalProfile) || "Paralegal";

    if (decision === "accept") {
      caseDoc.paralegal = paralegalId;
      caseDoc.paralegalId = paralegalId;
      caseDoc.pendingParalegalId = null;
      caseDoc.pendingParalegalInvitedAt = null;
      caseDoc.hiredAt = new Date();
      if (typeof caseDoc.canTransitionTo === "function" && caseDoc.canTransitionTo("in_progress")) {
        caseDoc.transitionTo("in_progress");
      } else {
        caseDoc.status = "in_progress";
      }
      if (!Array.isArray(caseDoc.applicants)) caseDoc.applicants = [];
      const existing = caseDoc.applicants.find((app) => String(app.paralegalId) === String(paralegalId));
      if (existing) existing.status = "accepted";
      else caseDoc.applicants.push({ paralegalId, status: "accepted" });

      await caseDoc.save();
      await sendCaseNotification(attorneyId, "case_invite_response", caseDoc, {
        response: "accepted",
        paralegalId,
        paralegalName,
      });
    } else {
      caseDoc.pendingParalegalId = null;
      caseDoc.pendingParalegalInvitedAt = null;
      caseDoc.status = "open";
      if (Array.isArray(caseDoc.applicants)) {
        const existing = caseDoc.applicants.find((app) => String(app.paralegalId) === pendingId);
        if (existing) existing.status = "rejected";
      }
      await caseDoc.save();
      await sendCaseNotification(attorneyId, "case_invite_response", caseDoc, {
        response: "declined",
        paralegalId: pendingId,
        paralegalName,
      });
    }

    return res.json(caseSummary(caseDoc));
  })
);

router.use("/:caseId", ensureCaseParticipant());

/**
 * POST /api/cases
 * Create a new case/job posting (attorney or admin only).
 */
router.post(
  "/",
  requireRole(["admin", "attorney"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const {
      title,
      practiceArea,
      description,
      details,
      questions,
      employmentType,
      experience,
      instructions,
      deadline,
    } = req.body || {};
    const safeTitle = cleanTitle(title || "", 300);
    const questionList = parseListField(questions);
    const combinedDetails = [details || description, instructions]
      .filter(Boolean)
      .map((entry) => cleanText(entry, { max: 100_000 }))
      .join("\n\n");
    const narrative = cleanText(buildDetails(combinedDetails, questionList), { max: 100_000 });
    if (!safeTitle || safeTitle.length < 5 || !narrative || narrative.length < 50) {
      return res.status(400).json({ error: "Title and description are required." });
    }
    const normalizedPractice = normalizePracticeArea(practiceArea);
    if (!normalizedPractice) {
      return res.status(400).json({ error: "Select a valid practice area." });
    }

    const currency = cleanString(req.body?.currency || "usd", { len: 8 }).toLowerCase() || "usd";
    const stateInput = req.body?.state || req.body?.locationState || "";
    const normalizedState = cleanString(stateInput, { len: 200 });
    const amountInput =
      req.body?.totalAmount ??
      req.body?.budget ??
      req.body?.compensationAmount ??
      req.body?.compAmount ??
      req.body?.compensation;
    const amountCents = dollarsToCents(amountInput);

    const deadlineDate = parseDeadline(deadline);
    if (deadline && !deadlineDate) {
      return res.status(400).json({ error: "Invalid deadline provided." });
    }

    const created = await Case.create({
      title: safeTitle,
      practiceArea: normalizedPractice,
      details: narrative,
      attorney: req.user.id,
      attorneyId: req.user.id,
      status: "open",
      totalAmount: typeof amountCents === "number" && amountCents > 0 ? amountCents : 0,
      currency,
      deadline: deadlineDate,
      state: normalizedState,
      locationState: normalizedState,
      briefSummary: buildBriefSummary({ state: normalizedState, employmentType, experience }),
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
 * GET /api/cases/admin
 * Admin overview of recent cases for the posts dashboard.
 */
router.get(
  "/admin",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 250, 1, 1000);
    const statusFilter = String(req.query.status || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const query = {};
    if (statusFilter.length) {
      query.status = { $in: statusFilter };
    }

    const docs = await Case.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("attorney", "firstName lastName email role");

    const cases = docs.map((doc) => {
      const summary = caseSummary(doc);
      const attorney = summary.attorney;
      const authorName =
        attorney?.name ||
        [attorney?.firstName, attorney?.lastName].filter(Boolean).join(" ") ||
        attorney?.email ||
        "Unknown";
      return {
        ...summary,
        authorName,
        category: summary.practiceArea || "",
      };
    });

    res.json({ cases });
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
        "title details practiceArea status deadline zoomLink paymentReleased escrowIntentId applicants files jobId createdAt updatedAt attorney attorneyId paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt hiredAt completedAt briefSummary archived downloadUrl internalNotes"
      )
      .populate("paralegalId", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("internalNotes.updatedBy", "firstName lastName email role avatarURL")
      .lean();

    res.json(docs.map((doc) => caseSummary(doc, { includeFiles })));
  })
);

router.get(
  "/my-active",
  requireRole(["attorney"]),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 50, 1, 200);
    const filter = {
      attorney: req.user.id,
      archived: { $ne: true },
      status: { $nin: ["completed", "closed", "cancelled"] },
    };
    const docs = await Case.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(
        "title practiceArea status deadline zoomLink paymentReleased escrowIntentId jobId createdAt updatedAt attorney attorneyId paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt"
      )
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("paralegalId", "firstName lastName email role avatarURL")
      .populate("pendingParalegalId", "firstName lastName email role avatarURL")
      .lean();

    res.json({ items: docs.map((doc) => caseSummary(doc)) });
  })
);

router.get(
  "/invited-to",
  requireRole(["paralegal"]),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 50, 1, 200);
    const docs = await Case.find({
      pendingParalegalId: req.user.id,
      archived: { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(
        "title practiceArea status deadline zoomLink paymentReleased escrowIntentId jobId createdAt updatedAt attorney attorneyId pendingParalegalId pendingParalegalInvitedAt"
      )
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .populate("pendingParalegalId", "firstName lastName email role avatarURL")
      .lean();

    res.json({ items: docs.map((doc) => caseSummary(doc)) });
  })
);

router.get(
  "/open",
  requireRole(["paralegal"]),
  asyncHandler(async (req, res) => {
    const docs = await Case.find({
      status: "open",
      pendingParalegalId: null,
      paralegalId: null,
      archived: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .select("title description _id attorneyId");

    res.json({ items: docs });
  })
);

router.get(
  "/my-assigned",
  requireRole(["paralegal"]),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 100, 1, 500);
    const docs = await Case.find({
      paralegal: req.user.id,
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("title caseNumber status createdAt updatedAt attorney attorneyId")
      .populate("attorney", "firstName lastName")
      .populate("attorneyId", "firstName lastName")
      .lean();

    const items = docs.map((doc) => ({
      _id: doc._id,
      title: doc.title,
      caseNumber: doc.caseNumber || null,
      attorneyName:
        formatPersonName(doc.attorney || doc.attorneyId) ||
        (doc.attorneyNameSnapshot || ""),
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
    res.json({ items });
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
    const forbiddenKeys = ["applicants", "paralegal", "paralegalId", "attorney", "attorneyId"];
    if (forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
      return res.status(400).json({ error: "One or more fields cannot be modified." });
    }
    let touched = false;

    if (typeof body.title === "string" && body.title.trim()) {
      const nextTitle = cleanString(body.title, { len: 300 });
      if (nextTitle.length < 5) {
        return res.status(400).json({ error: "Title must be at least 5 characters." });
      }
      doc.title = nextTitle;
      touched = true;
    }
    const updatedDetails = typeof body.details === "string" ? body.details : typeof body.description === "string" ? body.description : null;
    if (updatedDetails) {
      const sanitizedDetails = cleanString(updatedDetails, { len: 100_000 });
      if (sanitizedDetails.length < 20) {
        return res.status(400).json({ error: "Description is too short." });
      }
      doc.details = sanitizedDetails;
      touched = true;
    }
    if (typeof body.practiceArea === "string") {
      const nextPractice = normalizePracticeArea(body.practiceArea);
      if (!nextPractice) {
        return res.status(400).json({ error: "Select a valid practice area." });
      }
      doc.practiceArea = nextPractice;
      touched = true;
    }
    if (typeof body.briefSummary === "string") {
      doc.briefSummary = cleanString(body.briefSummary, { len: 1000 });
      touched = true;
    }
    if (typeof body.deadline !== "undefined") {
      if (!body.deadline) {
        doc.deadline = null;
        touched = true;
      } else {
        const nextDeadline = parseDeadline(body.deadline);
        if (!nextDeadline) {
          return res.status(400).json({ error: "Invalid deadline provided." });
        }
        doc.deadline = nextDeadline;
        touched = true;
      }
    }
    const amountInput =
      body.totalAmount ?? body.budget ?? body.compensationAmount ?? body.compAmount;
    if (typeof amountInput !== "undefined" && amountInput !== null) {
      const cents = dollarsToCents(amountInput);
      if (cents !== null && cents >= 0) {
        doc.totalAmount = cents;
        touched = true;
      }
    }
    if (typeof body.currency === "string" && body.currency.trim()) {
      doc.currency = cleanString(body.currency, { len: 8 }).toLowerCase();
       touched = true;
    }

    if (!touched) {
      return res.status(400).json({ error: "No valid changes provided." });
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
 * POST /api/cases/:caseId/terminate
 * End the attorney/paralegal engagement. If work has begun, open a dispute for admin review.
 * Body: { reason? }
 */
router.post(
  "/:caseId/terminate",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney or an admin can terminate this case." });
    }

    const doc = await Case.findById(req.params.caseId)
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("terminationRequestedBy", "firstName lastName email role");
    if (!doc) return res.status(404).json({ error: "Case not found." });

    if (!doc.paralegal) {
      return res.status(400).json({ error: "No paralegal is currently assigned to this case." });
    }
    if (["cancelled", "closed"].includes(String(doc.status || "").toLowerCase())) {
      return res.status(400).json({ error: "This case is already closed." });
    }
    if (doc.terminationStatus && !["none", "resolved"].includes(doc.terminationStatus)) {
      return res.status(400).json({ error: "A termination request is already in progress." });
    }

    const reason = cleanMessage(req.body?.reason || "", { len: 2000 });
    const workStarted = hasWorkStarted(doc);
    doc.terminationRequestedAt = new Date();
    doc.terminationRequestedBy = req.user.id;
    doc.terminationReason = reason;
    doc.terminatedAt = null;
    doc.terminationDisputeId = null;

    if (workStarted) {
      const message = reason
        ? `Attorney requested termination: ${reason}`
        : "Attorney requested termination of this case.";
      doc.createDispute({ message, raisedBy: req.user.id });
      const lastDispute = doc.disputes[doc.disputes.length - 1];
      doc.terminationStatus = "disputed";
      doc.terminationDisputeId = lastDispute?.disputeId || (lastDispute?._id ? String(lastDispute._id) : null);
      doc.paralegalAccessRevokedAt = new Date();
    } else {
      try {
        doc.transitionTo("cancelled");
      } catch (err) {
        return res.status(400).json({ error: "This case cannot be cancelled right now." });
      }
      doc.terminationStatus = "auto_cancelled";
      doc.terminatedAt = new Date();
      doc.paralegalAccessRevokedAt = new Date();
      doc.paralegal = null;
      doc.paralegalId = null;
      doc.pendingParalegalId = null;
      doc.pendingParalegalInvitedAt = null;
    }

    await doc.save();
    await doc.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
      { path: "terminationRequestedBy", select: "firstName lastName email role" },
    ]);

    try {
      await logAction(req, "case.terminate", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { mode: workStarted ? "disputed" : "auto_cancelled" },
      });
    } catch {}

    const payload = {
      ok: true,
      requiresAdmin: workStarted,
      case: caseSummary(doc),
    };
    res.status(workStarted ? 202 : 200).json(payload);
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

    const rawNote = cleanString(req.body?.note || req.body?.coverLetter || "", { len: 2000 });
    if (rawNote && rawNote.length < 20) {
      return res.status(400).json({ error: "Please provide more detail in your note (20+ characters)." });
    }
    const applicant = await User.findById(req.user.id).select(
      "role resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
    );
    if (!applicant) {
      return res.status(404).json({ error: "Unable to load your profile details." });
    }
    try {
      doc.addApplicant(req.user.id, rawNote, {
        resumeURL: applicant.resumeURL || "",
        linkedInURL: applicant.linkedInURL || "",
        profileSnapshot: shapeParalegalSnapshot(applicant),
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || "You have already applied to this case" });
    }

    await doc.save();
    try {
      await logAction(req, "case.apply", { targetType: "case", targetId: doc._id, meta: { note: Boolean(rawNote) } });
    } catch {}

    res.status(201).json({ ok: true, applicants: doc.applicants.length });
  })
);

router.post(
  "/:caseId/invite",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (req.user.role !== "attorney" || !req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the case attorney can invite paralegals." });
    }
    const { paralegalId } = req.body || {};
    if (!isObjId(paralegalId)) {
      return res.status(400).json({ error: "A valid paralegalId is required." });
    }
    const invitee = await User.findById(paralegalId).select("firstName lastName role status");
    if (!invitee || invitee.role !== "paralegal" || invitee.status !== "approved") {
      return res.status(400).json({ error: "Select an approved paralegal to invite." });
    }

    const caseDoc = await Case.findById(req.params.caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("paralegal", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });

    const ownerId = String(caseDoc.attorneyId || caseDoc.attorney?._id || "");
    if (!ownerId || ownerId !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this case." });
    }
    if (caseDoc.paralegal) {
      return res.status(400).json({ error: "A paralegal has already been assigned to this case." });
    }
    if (caseDoc.archived) {
      return res.status(400).json({ error: "This case is archived." });
    }

    caseDoc.pendingParalegalId = invitee._id;
    caseDoc.pendingParalegalInvitedAt = new Date();
    await caseDoc.save();

    try {
      await logAction(req, "paralegal_invited", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
        meta: { paralegalId: invitee._id },
      });
    } catch {}

    const attorneyName = formatPersonName(caseDoc.attorney || caseDoc.attorneyId) || "An attorney";
    await sendCaseNotification(invitee._id, "case_invite", caseDoc, {
      inviterName: attorneyName,
    });

    res.json({ success: true });
  })
);

router.post(
  "/:caseId/invite/accept",
  csrfProtection,
  requireRole(["paralegal"]),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });
    const caseDoc = await Case.findById(caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("pendingParalegalId", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (!caseDoc.pendingParalegalId || String(caseDoc.pendingParalegalId) !== String(req.user.id)) {
      return res.status(403).json({ error: "You do not have an invitation for this case." });
    }
    if (caseDoc.paralegal && String(caseDoc.paralegal) !== String(req.user.id)) {
      return res.status(400).json({ error: "This case is already assigned to another paralegal." });
    }

    const paralegal = await User.findById(req.user.id).select("firstName lastName");
    caseDoc.paralegal = req.user.id;
    caseDoc.paralegalId = req.user.id;
    caseDoc.pendingParalegalId = null;
    caseDoc.pendingParalegalInvitedAt = null;
    caseDoc.hiredAt = new Date();
    caseDoc.paralegalNameSnapshot = formatPersonName(paralegal);
    if (typeof caseDoc.canTransitionTo === "function" && caseDoc.canTransitionTo("in_progress")) {
      caseDoc.transitionTo("in_progress");
    } else if (!["in_progress", "active"].includes(caseDoc.status)) {
      caseDoc.status = "in_progress";
    }
    if (Array.isArray(caseDoc.applicants) && caseDoc.applicants.length) {
      caseDoc.applicants.forEach((app) => {
        if (String(app.paralegalId) === String(req.user.id)) {
          app.status = "accepted";
        }
      });
    }

    await caseDoc.save();

    try {
      await logAction(req, "paralegal_assigned", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
      });
    } catch {}

    const attorneyId = caseDoc.attorney?._id || caseDoc.attorneyId || null;
    if (attorneyId) {
      await sendCaseNotification(attorneyId, "case_invite_response", caseDoc, {
        response: "accepted",
        paralegalId: req.user.id,
        paralegalName: formatPersonName(paralegal),
      });
    }

    res.json({ success: true });
  })
);

router.post(
  "/:caseId/invite/decline",
  csrfProtection,
  requireRole(["paralegal"]),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });
    const caseDoc = await Case.findById(caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("pendingParalegalId", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (!caseDoc.pendingParalegalId || String(caseDoc.pendingParalegalId) !== String(req.user.id)) {
      return res.status(403).json({ error: "You do not have an invitation for this case." });
    }

    const paralegal = await User.findById(req.user.id).select("firstName lastName");
    caseDoc.pendingParalegalId = null;
    caseDoc.pendingParalegalInvitedAt = null;
    await caseDoc.save();

    try {
      await logAction(req, "paralegal_declined", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
      });
    } catch {}

    const attorneyId = caseDoc.attorney?._id || caseDoc.attorneyId || null;
    if (attorneyId) {
      await sendCaseNotification(attorneyId, "case_invite_response", caseDoc, {
        response: "declined",
        paralegalId: req.user.id,
        paralegalName: formatPersonName(paralegal),
      });
    }

    res.json({ success: true });
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
    selectedCase.pendingParalegalId = null;
    selectedCase.pendingParalegalInvitedAt = null;
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
 * POST /api/cases/:caseId/complete
 * Attorney-only. Releases funds, locks case, generates archive, and schedules purge.
 */
router.post(
  "/:caseId/complete",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney may close this case." });
    }
    const { caseId } = req.params;
    const doc = await Case.findById(caseId)
      .populate("paralegal", "firstName lastName email role stripeAccountId stripeOnboarded")
      .populate("attorney", "firstName lastName email role");
    if (!doc) return res.status(404).json({ error: "Case not found" });
    if (!doc.paralegal) {
      return res.status(400).json({ error: "Assign a paralegal before completing the case." });
    }
    if (doc.readOnly) {
      if (!doc.archiveZipKey) {
        try {
          const regen = await generateArchiveZip(doc);
          doc.archiveZipKey = regen.key;
          doc.archiveReadyAt = regen.readyAt;
          doc.archiveDownloadedAt = null;
          await doc.save();
        } catch (err) {
          console.error("[cases] archive regenerate error", err);
          return res.status(500).json({ error: "Unable to regenerate archive" });
        }
      }
      return res.json({
        ok: true,
        downloadPath: `/api/cases/${encodeURIComponent(doc._id)}/archive/download`,
        purgeScheduledFor: doc.purgeScheduledFor,
        archiveReadyAt: doc.archiveReadyAt,
        alreadyClosed: true,
      });
    }

    try {
      await ensureFundsReleased(req, doc);
    } catch (err) {
      return res.status(400).json({ error: err.message || "Unable to release funds." });
    }

    const now = new Date();
    doc.status = "closed";
    doc.archived = true;
    doc.readOnly = true;
    doc.paralegalAccessRevokedAt = doc.paralegalAccessRevokedAt || now;
    doc.paralegalNameSnapshot =
      doc.paralegalNameSnapshot ||
      `${doc.paralegal?.firstName || ""} ${doc.paralegal?.lastName || ""}`.trim();
    doc.attorneyNameSnapshot =
      doc.attorneyNameSnapshot ||
      `${doc.attorney?.firstName || ""} ${doc.attorney?.lastName || ""}`.trim();
    doc.purgeScheduledFor = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    doc.archiveDownloadedAt = null;
    doc.downloadUrl = [];
    doc.applicants = [];

    let archiveMeta;
    try {
      archiveMeta = await generateArchiveZip(doc);
    } catch (err) {
      console.error("[cases] archive error", err);
      return res.status(500).json({ error: "Unable to generate archive" });
    }
    doc.archiveZipKey = archiveMeta.key;
    doc.archiveReadyAt = archiveMeta.readyAt;
    await doc.save();

    await logAction(req, "case.complete.archive", {
      targetType: "case",
      targetId: doc._id,
      caseId: doc._id,
      meta: { purgeScheduledFor: doc.purgeScheduledFor },
    });

    res.json({
      ok: true,
      downloadPath: `/api/cases/${encodeURIComponent(doc._id)}/archive/download`,
      purgeScheduledFor: doc.purgeScheduledFor,
      archiveReadyAt: doc.archiveReadyAt,
    });
  })
);

router.get(
  "/:caseId/notes",
  verifyToken,
  requireCaseAccess("caseId", { project: "internalNotes" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only attorneys can view notes" });
    }
    const doc = await Case.findById(req.case.id)
      .select("internalNotes")
      .populate("internalNotes.updatedBy", "firstName lastName email role avatarURL");
    if (!doc) return res.status(404).json({ error: "Case not found" });
    return res.json(shapeInternalNote(doc.internalNotes));
  })
);

router.put(
  "/:caseId/notes",
  verifyToken,
  csrfProtection,
  requireCaseAccess("caseId", { project: "internalNotes" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only attorneys can update notes" });
    }
    const doc = await Case.findById(req.case.id).select("internalNotes");
    if (!doc) return res.status(404).json({ error: "Case not found" });
    const text = cleanMessage(req.body?.note || "", 10_000);
    doc.internalNotes = {
      text,
      updatedBy: req.user.id,
      updatedAt: new Date(),
    };
    await doc.save();
    await doc.populate("internalNotes.updatedBy", "firstName lastName email role avatarURL");
    return res.json(shapeInternalNote(doc.internalNotes));
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
        "title status practiceArea deadline zoomLink paymentReleased escrowIntentId totalAmount currency files attorney paralegal applicants hiredAt completedAt briefSummary archived downloadUrl terminationReason terminationStatus terminationRequestedAt terminationRequestedBy terminationDisputeId terminatedAt paralegalAccessRevokedAt archiveReadyAt archiveDownloadedAt purgeScheduledFor readOnly"
      )
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role")
      .populate("applicants.paralegalId", "firstName lastName email role")
      .populate("terminationRequestedBy", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Case not found" });

    const applicants = Array.isArray(doc.applicants)
      ? doc.applicants.map((entry) => {
          const paralegalDoc =
            entry.paralegalId && typeof entry.paralegalId === "object" ? entry.paralegalId : null;
          const coverLetter = entry.note || "";
          const baseSnapshot = shapeParalegalSnapshot(paralegalDoc || {});
          const storedSnapshot =
            entry.profileSnapshot && typeof entry.profileSnapshot === "object"
              ? entry.profileSnapshot
              : {};
          const profileSnapshot = { ...baseSnapshot, ...storedSnapshot };
          const resumeURL = entry.resumeURL || paralegalDoc?.resumeURL || "";
          const linkedInURL = entry.linkedInURL || paralegalDoc?.linkedInURL || "";
          return {
            status: entry.status,
            appliedAt: entry.appliedAt,
            note: coverLetter,
            coverLetter,
            resumeURL,
            linkedInURL,
            profileSnapshot,
            paralegalId: entry.paralegalId ? String(entry.paralegalId._id || entry.paralegalId) : null,
            paralegal: summarizeUser(entry.paralegalId),
          };
        })
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
      readOnly: !!doc.readOnly,
      paralegalAccessRevokedAt: doc.paralegalAccessRevokedAt || null,
      archiveReadyAt: doc.archiveReadyAt || null,
      archiveDownloadedAt: doc.archiveDownloadedAt || null,
      purgeScheduledFor: doc.purgeScheduledFor || null,
      attorney: doc.attorney || null,
      paralegal: doc.paralegal || null,
      paralegalNameSnapshot: doc.paralegalNameSnapshot || "",
      files: Array.isArray(doc.files) ? doc.files.map(normalizeFile) : [],
      applicants,
      termination: {
        status: doc.terminationStatus || "none",
        reason: doc.terminationReason || "",
        requestedAt: doc.terminationRequestedAt || null,
        requestedBy: summarizeUser(doc.terminationRequestedBy) || (doc.terminationRequestedBy ? { id: String(doc.terminationRequestedBy) } : null),
        disputeId: doc.terminationDisputeId || null,
        terminatedAt: doc.terminatedAt || null,
      },
    });
  })
);

router.get(
  "/:caseId/archive/download",
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can download the archive." });
    }
    const doc = await Case.findById(req.params.caseId).select("archiveZipKey title");
    if (!doc) {
      return res.status(404).json({ error: "Archive not available" });
    }
    if (!doc.archiveZipKey) {
      try {
        const regen = await generateArchiveZip(doc);
        doc.archiveZipKey = regen.key;
        doc.archiveReadyAt = regen.readyAt;
        doc.archiveDownloadedAt = null;
        await doc.save();
      } catch (err) {
        console.error("[cases] archive regenerate error", err);
        return res.status(500).json({ error: "Archive not ready" });
      }
    }
    if (!S3_BUCKET) {
      return res.status(500).json({ error: "Storage misconfigured" });
    }
    const key = doc.archiveZipKey.replace(/^\/+/, "");
    let stream;
    try {
      const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
      stream = await s3.send(cmd);
    } catch (err) {
      console.error("[cases] archive fetch error", err);
      return res.status(404).json({ error: "Archive not found" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeArchiveName(doc.title)}.zip"`);

    stream.Body.on("error", (err) => {
      console.error("[cases] archive stream error", err);
      res.destroy(err);
    });

    stream.Body.on("end", async () => {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      } catch (err) {
        console.warn("[cases] archive delete error", err?.message || err);
      }
      doc.archiveZipKey = "";
      doc.archiveDownloadedAt = new Date();
      await doc.save();
    });

    stream.Body.pipe(res);
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
