// backend/routes/cases.js
const router = require("express").Router();
const mongoose = require("mongoose");
const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole, requireCaseAccess } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const CaseFile = require("../models/CaseFile");
const User = require("../models/User");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const Notification = require("../models/Notification");
const sendEmail = require("../utils/email");
const { notifyUser } = require("../utils/notifyUser");
const stripe = require("../utils/stripe");
const { cleanText, cleanTitle, cleanMessage } = require("../utils/sanitize");
const { logAction } = require("../utils/audit");
const { generateArchiveZip, buildReceiptPdfBuffer, uploadPdfToS3, getReceiptKey } = require("../services/caseLifecycle");
const { shapeParalegalSnapshot } = require("../utils/profileSnapshots");
const { BLOCKED_MESSAGE, getBlockedUserIds, isBlockedBetween } = require("../utils/blocks");
const { addSubscriber, publishCaseEvent } = require("../utils/caseEvents");

const STRIPE_BYPASS_PARALEGAL_EMAILS = new Set([
  "samanthasider+11@gmail.com",
  "samanthasider+paralegal@gmail.com",
  "samanthasider+56@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);
const STRIPE_BYPASS_ATTORNEY_EMAILS = new Set([
  "samanthasider+attorney@gmail.com",
  "samanthasider+56@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);

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

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const FILE_STATUS = ["pending_review", "approved", "attorney_revision"];
const MIN_CASE_AMOUNT_CENTS = 40000;
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

function normalizeEmail(value) {
  return String(value || "").toLowerCase().trim();
}

function isStripeBypassPair(req, caseDoc, paralegal) {
  const paralegalEmail = normalizeEmail(paralegal?.email || caseDoc?.paralegal?.email);
  const attorneyEmail = normalizeEmail(caseDoc?.attorney?.email || req?.user?.email);
  return (
    STRIPE_BYPASS_PARALEGAL_EMAILS.has(paralegalEmail) &&
    STRIPE_BYPASS_ATTORNEY_EMAILS.has(attorneyEmail)
  );
}

async function ensureBypassConnectAccount(paralegal) {
  if (!paralegal || paralegal.stripeAccountId) return;
  if (!paralegal.email) return;
  const account = await stripe.accounts.create({
    type: "express",
    country: process.env.STRIPE_CONNECT_COUNTRY || "US",
    email: paralegal.email,
    business_type: "individual",
    capabilities: {
      transfers: { requested: true },
    },
  });
  paralegal.stripeAccountId = account.id;
  paralegal.stripeOnboarded = false;
  paralegal.stripeChargesEnabled = false;
  paralegal.stripePayoutsEnabled = false;
  await paralegal.save();
}
const IN_PROGRESS_STATUS = "in progress";
const LEGACY_IN_PROGRESS_STATUS = "in_progress";
const PLATFORM_FEE_ATTORNEY_PERCENT = Number(
  process.env.PLATFORM_FEE_ATTORNEY_PERCENT || process.env.PLATFORM_FEE_PERCENT || 22
);
const PLATFORM_FEE_PARALEGAL_PERCENT = Number(
  process.env.PLATFORM_FEE_PARALEGAL_PERCENT || 18
);
const WORK_STARTED_STATUSES = new Set([
  IN_PROGRESS_STATUS,
  LEGACY_IN_PROGRESS_STATUS,
  "completed",
  "disputed",
]);

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

const MAX_SCOPE_TASKS = 25;
const MAX_SCOPE_TASK_TITLE = 200;

function normalizeTaskCompletion(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return false;
}

function normalizeTaskTitle(value) {
  return cleanString(String(value || ""), { len: MAX_SCOPE_TASK_TITLE });
}

function normalizeScopeTasks(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const rawTitle = typeof item === "string" ? item : item?.title;
    const title = normalizeTaskTitle(rawTitle);
    if (!title) continue;
    const completed = normalizeTaskCompletion(
      typeof item === "object" ? item?.completed ?? item?.done ?? item?.isCompleted : false
    );
    normalized.push({ title, completed });
    if (normalized.length >= MAX_SCOPE_TASKS) break;
  }
  return normalized;
}

function hasScopeTasks(caseDoc) {
  if (!caseDoc) return false;
  const list = Array.isArray(caseDoc.tasks) ? caseDoc.tasks : [];
  return list.some((task) => {
    const title = typeof task === "string" ? task : task?.title;
    return Boolean(String(title || "").trim());
  });
}

function areAllScopeTasksComplete(caseDoc) {
  if (!caseDoc) return false;
  const list = Array.isArray(caseDoc.tasks) ? caseDoc.tasks : [];
  if (!list.length) return false;
  return list.every((task) => {
    if (!task) return false;
    const completed = normalizeTaskCompletion(
      typeof task === "object" ? task?.completed ?? task?.done ?? task?.isCompleted : false
    );
    return completed;
  });
}

function serializeScopeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((task) => {
      if (typeof task === "string") {
        const title = normalizeTaskTitle(task);
        return title ? { title, completed: false } : null;
      }
      const title = normalizeTaskTitle(task?.title || "");
      const completed = normalizeTaskCompletion(task?.completed ?? task?.done ?? task?.isCompleted);
      return title ? { title, completed } : null;
    })
    .filter(Boolean);
}

function scopeTaskTitleKey(task) {
  if (!task) return "";
  const rawTitle = typeof task === "string" ? task : task?.title;
  return normalizeTaskTitle(rawTitle).toLowerCase();
}

function isCompletionOnlyTaskUpdate(existingTasks, incomingTasks) {
  if (!Array.isArray(existingTasks) || !Array.isArray(incomingTasks)) return false;
  if (existingTasks.length !== incomingTasks.length) return false;
  for (let index = 0; index < existingTasks.length; index += 1) {
    const existingTitle = scopeTaskTitleKey(existingTasks[index]);
    const incomingTitle = scopeTaskTitleKey(incomingTasks[index]);
    if (!existingTitle || existingTitle !== incomingTitle) return false;
  }
  return true;
}

function mergeTaskCompletion(existingTasks, incomingTasks) {
  if (!Array.isArray(existingTasks)) return [];
  return existingTasks.map((task, index) => {
    const incoming = incomingTasks[index] || {};
    const completed = normalizeTaskCompletion(
      incoming?.completed ?? incoming?.done ?? incoming?.isCompleted
    );
    if (typeof task === "string") {
      const title = normalizeTaskTitle(task);
      return { title, completed };
    }
    return {
      title: normalizeTaskTitle(task?.title || ""),
      completed,
      createdAt: task?.createdAt,
    };
  });
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

function formatCurrency(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildPersonDisplay(user, fallback) {
  const name = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  if (name) return name;
  return fallback || "";
}

async function resolvePaymentMethodLabel(caseDoc) {
  const intentId = caseDoc?.paymentIntentId || caseDoc?.escrowIntentId;
  if (!intentId || !stripe?.paymentIntents?.retrieve) {
    return "Card on file";
  }
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["charges.data.payment_method_details", "payment_method"],
    });
    const charge = intent?.charges?.data?.[0];
    const card = charge?.payment_method_details?.card || intent?.payment_method?.card || null;
    if (card?.last4) {
      const brand = card?.brand ? String(card.brand).replace(/_/g, " ") : "Card";
      return `${brand} ending ${card.last4}`;
    }
  } catch (err) {
    console.warn("[cases] payment method lookup failed", err?.message || err);
  }
  return "Card on file";
}

function resolveAttorneyFeePct(doc = {}) {
  return typeof doc.feeAttorneyPct === "number" && Number.isFinite(doc.feeAttorneyPct)
    ? doc.feeAttorneyPct
    : PLATFORM_FEE_ATTORNEY_PERCENT;
}

function resolveParalegalFeePct(doc = {}) {
  return typeof doc.feeParalegalPct === "number" && Number.isFinite(doc.feeParalegalPct)
    ? doc.feeParalegalPct
    : PLATFORM_FEE_PARALEGAL_PERCENT;
}

function computeAttorneyFeeAmount(baseAmount, doc = {}) {
  if (Number.isFinite(doc.feeAttorneyAmount) && doc.feeAttorneyAmount >= 0) {
    return doc.feeAttorneyAmount;
  }
  return Math.max(0, Math.round(baseAmount * (resolveAttorneyFeePct(doc) / 100)));
}

function computeParalegalFeeAmount(baseAmount, doc = {}) {
  if (Number.isFinite(doc.feeParalegalAmount) && doc.feeParalegalAmount >= 0) {
    return doc.feeParalegalAmount;
  }
  return Math.max(0, Math.round(baseAmount * (resolveParalegalFeePct(doc) / 100)));
}

function resolveDisputeSettlement(doc = {}) {
  const settlement = doc.disputeSettlement || {};
  const action = String(settlement.action || "");
  if (!["release_full", "release_partial"].includes(action)) return null;
  const grossAmount = Number(settlement.grossAmount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return null;
  const feeAttorneyPct = Number.isFinite(settlement.feeAttorneyPct)
    ? settlement.feeAttorneyPct
    : resolveAttorneyFeePct(doc);
  const feeParalegalPct = Number.isFinite(settlement.feeParalegalPct)
    ? settlement.feeParalegalPct
    : resolveParalegalFeePct(doc);
  const feeAttorneyAmount = Number.isFinite(settlement.feeAttorneyAmount)
    ? settlement.feeAttorneyAmount
    : Math.max(0, Math.round(grossAmount * (feeAttorneyPct / 100)));
  const feeParalegalAmount = Number.isFinite(settlement.feeParalegalAmount)
    ? settlement.feeParalegalAmount
    : Math.max(0, Math.round(grossAmount * (feeParalegalPct / 100)));
  const payoutAmount = Number.isFinite(settlement.payoutAmount)
    ? settlement.payoutAmount
    : Math.max(0, grossAmount - feeParalegalAmount);
  return {
    grossAmount,
    feeAttorneyAmount,
    feeParalegalAmount,
    feeAttorneyPct,
    feeParalegalPct,
    payoutAmount,
  };
}

async function generateReceiptDocuments(caseDoc, { payoutAmount, paymentMethodLabel } = {}) {
  if (!caseDoc?._id) return;
  const settlement = resolveDisputeSettlement(caseDoc);
  const baseAmount = settlement?.grossAmount ?? Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
  const attorneyFee = settlement?.feeAttorneyAmount ?? computeAttorneyFeeAmount(baseAmount, caseDoc);
  const paralegalFee = settlement?.feeParalegalAmount ?? computeParalegalFeeAmount(baseAmount, caseDoc);
  const computedNet = settlement?.payoutAmount ?? Math.max(0, baseAmount - paralegalFee);
  const payout =
    Number.isFinite(payoutAmount) && payoutAmount >= 0
      ? Math.min(payoutAmount, computedNet)
      : computedNet;
  const issuedAt = caseDoc.completedAt || caseDoc.paidOutAt || new Date();
  const attorneyPct = settlement?.feeAttorneyPct ?? resolveAttorneyFeePct(caseDoc);
  const paralegalPct = settlement?.feeParalegalPct ?? resolveParalegalFeePct(caseDoc);

  const attorneyName =
    caseDoc.attorneyNameSnapshot ||
    buildPersonDisplay(caseDoc.attorney, "") ||
    buildPersonDisplay(caseDoc.attorneyId, "Attorney") ||
    "Attorney";
  const paralegalName =
    caseDoc.paralegalNameSnapshot ||
    buildPersonDisplay(caseDoc.paralegal, "") ||
    buildPersonDisplay(caseDoc.paralegalId, "Paralegal") ||
    "Paralegal";

  const attorneyPayload = {
    title: "Receipt",
    receiptId: caseDoc.paymentIntentId || caseDoc.escrowIntentId || String(caseDoc._id),
    issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
    partyLabel: "Billed to",
    partyName: attorneyName,
    caseTitle: caseDoc.title || "Case",
    lineItems: [
      { label: "Case fee", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${attorneyPct}%)`, value: formatCurrency(attorneyFee) },
    ],
    totalLabel: "Total paid",
    totalAmount: formatCurrency(baseAmount + attorneyFee),
    paymentMethod: paymentMethodLabel || "Card on file",
    paymentStatus: "Paid in full",
  };

  const paralegalPayload = {
    title: "Payout Receipt",
    receiptId: caseDoc.payoutTransferId || String(caseDoc._id),
    issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
    partyLabel: "Payee",
    partyName: paralegalName,
    attorneyName,
    caseTitle: caseDoc.title || "Case",
    lineItems: [
      { label: "Gross amount", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${paralegalPct}%)`, value: formatCurrency(paralegalFee) },
    ],
    totalLabel: "Net paid",
    totalAmount: formatCurrency(payout),
    paymentMethod: "Stripe release",
    paymentStatus: "Paid",
  };

  const attorneyKey = getReceiptKey(caseDoc._id, "attorney");
  const paralegalKey = getReceiptKey(caseDoc._id, "paralegal");
  const [attorneyPdf, paralegalPdf] = await Promise.all([
    buildReceiptPdfBuffer(attorneyPayload),
    buildReceiptPdfBuffer(paralegalPayload),
  ]);

  await Promise.all([
    uploadPdfToS3({ key: attorneyKey, buffer: attorneyPdf }),
    uploadPdfToS3({ key: paralegalKey, buffer: paralegalPdf }),
  ]);
}

function normalizePracticeArea(value) {
  const cleaned = cleanString(value || "", { len: 200 }).toLowerCase();
  if (!cleaned) return "";
  return PRACTICE_AREA_LOOKUP[cleaned] || "";
}

function normalizeCaseStatusValue(status) {
  const value = String(status || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === LEGACY_IN_PROGRESS_STATUS) return IN_PROGRESS_STATUS;
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing"].includes(lower)) return IN_PROGRESS_STATUS;
  return lower;
}

const CLOSED_CASE_STATUSES = new Set(["completed", "closed", "disputed"]);

function isFinalCaseDoc(doc) {
  if (!doc) return false;
  if (doc.paymentReleased === true) return true;
  return normalizeCaseStatusValue(doc.status) === "completed";
}

function isCaseClosedForFiles(doc) {
  if (!doc) return false;
  if (doc.paymentReleased === true) return true;
  return CLOSED_CASE_STATUSES.has(normalizeCaseStatusValue(doc.status));
}

function hasWorkStarted(caseDoc) {
  if (!caseDoc) return false;
  const status = String(caseDoc.status || "").toLowerCase();
  if (WORK_STARTED_STATUSES.has(status)) return true;
  if (Array.isArray(caseDoc.files) && caseDoc.files.length > 0) return true;
  return false;
}

function resolveCaseJobId(caseDoc) {
  if (!caseDoc) return null;
  const raw = caseDoc.jobId || caseDoc.job || null;
  if (!raw) return null;
  if (typeof raw === "object") {
    return raw._id || raw.id || raw;
  }
  return raw;
}

async function markJobAssigned(caseDoc) {
  const jobId = resolveCaseJobId(caseDoc);
  if (!jobId) return null;
  try {
    await Job.findByIdAndUpdate(jobId, { status: "assigned" });
  } catch (err) {
    console.warn("[cases] Unable to update job status after hire", jobId, err?.message || err);
  }
  return jobId;
}

async function rejectJobApplications(jobId, hiredParalegalId) {
  if (!jobId || !hiredParalegalId) return;
  try {
    await Application.updateOne(
      { jobId, paralegalId: hiredParalegalId },
      { $set: { status: "accepted" } }
    );
    await Application.updateMany(
      { jobId, paralegalId: { $ne: hiredParalegalId } },
      { $set: { status: "rejected" } }
    );
  } catch (err) {
    console.warn("[cases] Unable to update application statuses after hire", err?.message || err);
  }
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
    profileImage: person.profileImage || person.avatarURL || null,
  };
}

function formatPersonName(person) {
  if (!person || typeof person !== "object") return "";
  return `${person.firstName || ""} ${person.lastName || ""}`.trim();
}

async function ensureStripeCustomer(user) {
  if (!user) throw new Error("User not found");
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: formatPersonName(user) || undefined,
    metadata: {
      userId: user._id ? String(user._id) : "",
      role: user.role || "",
    },
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

async function fetchDefaultPaymentMethodId(customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  return customer?.invoice_settings?.default_payment_method || null;
}

async function attorneyHasPaymentMethod(attorneyId) {
  if (!attorneyId) return false;
  try {
    const attorney = await User.findById(attorneyId).select("email stripeCustomerId");
    const attorneyEmail = String(attorney?.email || "").toLowerCase().trim();
    if (STRIPE_BYPASS_ATTORNEY_EMAILS.has(attorneyEmail)) return true;
    if (!attorney?.stripeCustomerId) return false;
    const methodId = await fetchDefaultPaymentMethodId(attorney.stripeCustomerId);
    return Boolean(methodId);
  } catch (err) {
    console.warn("[cases] Unable to verify attorney payment method", err?.message || err);
    return false;
  }
}

function buildCaseChargeDescription(caseDoc, paralegalDoc) {
  const caseName = caseDoc?.title || caseDoc?.caseTitle || `Case ${caseDoc?._id || ""}`;
  const paralegalName = formatPersonName(paralegalDoc) || "Paralegal";
  return `Case: ${caseName} — Paralegal: ${paralegalName}`;
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

const INVITE_STATUSES = new Set(["pending", "accepted", "declined", "expired"]);

function normalizeInviteStatus(value) {
  const key = String(value || "").toLowerCase();
  return INVITE_STATUSES.has(key) ? key : "pending";
}

function listCaseInvites(caseDoc, { includeLegacy = true } = {}) {
  const invites = Array.isArray(caseDoc?.invites) ? caseDoc.invites : [];
  const normalized = invites
    .map((invite) => ({
      paralegalId: invite?.paralegalId ? String(invite.paralegalId) : "",
      status: normalizeInviteStatus(invite?.status),
      invitedAt: invite?.invitedAt || null,
      respondedAt: invite?.respondedAt || null,
    }))
    .filter((invite) => invite.paralegalId);

  if (!normalized.length && includeLegacy && caseDoc?.pendingParalegalId) {
    normalized.push({
      paralegalId: String(caseDoc.pendingParalegalId),
      status: "pending",
      invitedAt: caseDoc.pendingParalegalInvitedAt || null,
      respondedAt: null,
    });
  }
  return normalized;
}

function hasPendingInvites(caseDoc) {
  return listCaseInvites(caseDoc).some((invite) => invite.status === "pending");
}

function findInviteIndex(caseDoc, paralegalId) {
  if (!Array.isArray(caseDoc.invites)) {
    caseDoc.invites = [];
  }
  const target = String(paralegalId || "");
  return caseDoc.invites.findIndex((invite) => String(invite.paralegalId) === target);
}

function upsertInvite(caseDoc, paralegalId, { status = "pending", invitedAt = new Date(), respondedAt = null } = {}) {
  const idx = findInviteIndex(caseDoc, paralegalId);
  const payload = {
    paralegalId,
    status: normalizeInviteStatus(status),
    invitedAt: invitedAt || new Date(),
    respondedAt: respondedAt || null,
  };
  if (idx >= 0) {
    caseDoc.invites[idx] = { ...caseDoc.invites[idx], ...payload };
    return caseDoc.invites[idx];
  }
  caseDoc.invites.push(payload);
  return caseDoc.invites[caseDoc.invites.length - 1];
}

function markOtherInvites(caseDoc, excludeParalegalId, status = "declined") {
  if (!Array.isArray(caseDoc.invites)) return;
  const target = String(excludeParalegalId || "");
  const normalizedStatus = normalizeInviteStatus(status);
  caseDoc.invites.forEach((invite) => {
    if (String(invite.paralegalId) !== target && normalizeInviteStatus(invite.status) === "pending") {
      invite.status = normalizedStatus;
      invite.respondedAt = new Date();
    }
  });
}

function expirePendingInvites(caseDoc) {
  if (!Array.isArray(caseDoc.invites)) return;
  caseDoc.invites.forEach((invite) => {
    if (normalizeInviteStatus(invite.status) === "pending") {
      invite.status = "expired";
      invite.respondedAt = new Date();
    }
  });
}

function syncLegacyPendingFields(caseDoc) {
  if (!Array.isArray(caseDoc.invites) || !caseDoc.invites.length) return;
  const pending = caseDoc.invites
    .filter((invite) => normalizeInviteStatus(invite.status) === "pending")
    .sort((a, b) => {
      const aTime = a.invitedAt ? new Date(a.invitedAt).getTime() : 0;
      const bTime = b.invitedAt ? new Date(b.invitedAt).getTime() : 0;
      return aTime - bTime;
    });
  const first = pending[0] || null;
  caseDoc.pendingParalegalId = first ? first.paralegalId : null;
  caseDoc.pendingParalegalInvitedAt = first ? first.invitedAt || null : null;
}

function seedLegacyInvite(caseDoc) {
  if (!caseDoc?.pendingParalegalId) return;
  if (!Array.isArray(caseDoc.invites)) caseDoc.invites = [];
  const pendingId = String(caseDoc.pendingParalegalId);
  const exists = caseDoc.invites.some((invite) => String(invite.paralegalId) === pendingId);
  if (!exists) {
    caseDoc.invites.push({
      paralegalId: caseDoc.pendingParalegalId,
      status: "pending",
      invitedAt: caseDoc.pendingParalegalInvitedAt || new Date(),
      respondedAt: null,
    });
  }
}

function caseSummary(doc, { includeFiles = false, viewerRole = "" } = {}) {
  const isAdmin = String(viewerRole || "").toLowerCase() === "admin";
  const paralegal = summarizeUser(doc.paralegal || doc.paralegalId);
  const pendingParalegal = summarizeUser(doc.pendingParalegal || doc.pendingParalegalId);
  const attorney = summarizeUser(doc.attorney || doc.attorneyId);
  const stateValue = doc.state || doc.locationState || "";
  const normalizedStatus = normalizeCaseStatusValue(doc.status);
  const invites = listCaseInvites(doc);
  const summary = {
    _id: doc._id,
    id: String(doc._id),
    title: doc.title,
    details: doc.details || "",
    practiceArea: doc.practiceArea || "",
    state: stateValue,
    locationState: doc.locationState || stateValue,
    tasks: serializeScopeTasks(doc.tasks),
    tasksLocked: !!doc.tasksLocked,
    status: normalizedStatus,
    deadline: doc.deadline,
    zoomLink: doc.zoomLink || "",
    paymentReleased: doc.paymentReleased || false,
    escrowIntentId: doc.escrowIntentId || null,
    escrowStatus: doc.escrowStatus || null,
    totalAmount: typeof doc.totalAmount === "number" ? doc.totalAmount : 0,
    lockedTotalAmount: typeof doc.lockedTotalAmount === "number" ? doc.lockedTotalAmount : null,
    currency: doc.currency || "usd",
    assignedTo: paralegal,
    acceptedParalegal: !!paralegal,
    applicants: Array.isArray(doc.applicants) ? doc.applicants.length : 0,
    filesCount: !isAdmin && Array.isArray(doc.files) ? doc.files.length : 0,
    jobId: doc.jobId || null,
    attorney,
    paralegal,
    pendingParalegal,
    pendingParalegalId:
      pendingParalegal?.id || (doc.pendingParalegalId ? String(doc.pendingParalegalId) : null),
    pendingParalegalInvitedAt: doc.pendingParalegalInvitedAt || null,
    invites,
    hiredAt: doc.hiredAt || null,
    completedAt: doc.completedAt || null,
    briefSummary: doc.briefSummary || "",
    archived: !!doc.archived,
    downloadUrl: !isAdmin && Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
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
  if (includeFiles && !isAdmin) {
    summary.files = Array.isArray(doc.files) ? doc.files.map(normalizeFile) : [];
  }
  return summary;
}

function normalizeFile(file) {
  const original = file.original || file.filename || file.originalName || "";
  const key = file.key || file.storageKey || "";
  return {
    id: file._id ? String(file._id) : undefined,
    key,
    storageKey: key,
    previewKey: file.previewKey || "",
    original,
    filename: file.filename || original,
    mime: file.mime || file.mimeType || null,
    previewMime: file.previewMime || file.previewMimeType || null,
    size: file.size || null,
    previewSize: file.previewSize || null,
    uploadedBy: file.uploadedBy ? String(file.uploadedBy) : file.userId ? String(file.userId) : null,
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

async function sendCaseNotification(userId, type, caseDoc, payload = {}, options = {}) {
  if (!userId) return;
  try {
    const actorUserId = options.actorUserId || payload.actorUserId || null;
    await notifyUser(
      userId,
      type,
      Object.assign(
        {
          caseId: caseDoc?._id,
          caseTitle: caseDoc?.title || "Case",
        },
        payload || {}
      ),
      { actorUserId }
    );
  } catch (err) {
    console.warn("[cases] notifyUser failed", err);
  }
}

async function hasCaseNotification(userId, type, caseDoc, payload = {}) {
  if (!userId || !caseDoc?._id) return false;
  const query = {
    userId,
    type,
    "payload.caseId": caseDoc._id,
  };
  if (payload.summary) {
    query["payload.summary"] = payload.summary;
  }
  if (payload.amount) {
    query["payload.amount"] = payload.amount;
  }
  const existing = await Notification.findOne(query).select("_id").lean();
  return !!existing;
}

function buildCaseLink(caseDoc) {
  const id = caseDoc?._id || caseDoc?.id;
  return id ? `case-detail.html?caseId=${encodeURIComponent(id)}` : "";
}

async function ensureStripeOnboardedUser(paralegal) {
  if (!paralegal?.stripeAccountId) return false;
  if (paralegal.stripeOnboarded && paralegal.stripePayoutsEnabled) return true;
  try {
    const account = await stripe.accounts.retrieve(paralegal.stripeAccountId);
    const submitted = !!account?.details_submitted;
    const chargesEnabled = !!account?.charges_enabled;
    const payoutsEnabled = !!account?.payouts_enabled;
    paralegal.stripeChargesEnabled = chargesEnabled;
    paralegal.stripePayoutsEnabled = payoutsEnabled;
    paralegal.stripeOnboarded = submitted && payoutsEnabled;
    await paralegal.save();
    return paralegal.stripeOnboarded;
  } catch (err) {
    console.warn("[cases] stripe onboarding status check failed", err?.message || err);
  }
  return false;
}

async function notifyAttorneyAwaitingFunding(caseDoc, actorUserId = null) {
  const attorneyId = caseDoc?.attorney?._id || caseDoc?.attorneyId || caseDoc?.attorney || null;
  if (!attorneyId) return;
  const link = buildCaseLink(caseDoc);
  await sendCaseNotification(
    attorneyId,
    "case_awaiting_funding",
    caseDoc,
    {
      link,
    },
    { actorUserId }
  );
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

async function signDownload(key) {
  if (!S3_BUCKET) throw new Error("S3 bucket not configured");
  const head = new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key });
  try {
    await s3.send(head);
  } catch (err) {
    const code = err?.name || err?.Code || err?.code;
    const missing = code === "NoSuchKey" || code === "NotFound" || err?.$metadata?.httpStatusCode === 404;
    if (missing) {
      const notFound = new Error("S3 object not found");
      notFound.code = "NoSuchKey";
      throw notFound;
    }
    throw err;
  }
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 60 });
}

async function ensureFundsReleased(req, caseDoc) {
  if (caseDoc.paymentReleased) return null;
  const existingPayout = await Payout.findOne({ caseId: caseDoc._id })
    .select("amountPaid transferId")
    .lean();
  if (existingPayout) {
    caseDoc.paymentReleased = true;
    if (!caseDoc.payoutTransferId) caseDoc.payoutTransferId = existingPayout.transferId;
    return { payout: existingPayout.amountPaid, transferId: existingPayout.transferId, alreadyReleased: true };
  }
  if (caseDoc.payoutTransferId) {
    caseDoc.paymentReleased = true;
    return { payout: null, transferId: caseDoc.payoutTransferId, alreadyReleased: true };
  }
  const paralegal = caseDoc.paralegal;
  const bypassStripe = isStripeBypassPair(req, caseDoc, paralegal);
  if (!paralegal || !paralegal.stripeAccountId) {
    if (bypassStripe) {
      await ensureBypassConnectAccount(paralegal);
    }
    if (!paralegal || !paralegal.stripeAccountId) {
      throw new Error("Paralegal cannot be paid until onboarding completes.");
    }
  }
  if (!bypassStripe) {
    if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
      const refreshed = await ensureStripeOnboardedUser(paralegal);
      if (!refreshed) {
        throw new Error("Payment method needs to be updated before funds can be released.");
      }
    }
    if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
      throw new Error("Payment method needs to be updated before funds can be released.");
    }
  }
  const intentId = caseDoc.paymentIntentId || caseDoc.escrowIntentId;
  if (!intentId) {
    throw new Error("Case has no funded payment intent.");
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["charges.data.balance_transaction"],
    });
  } catch (err) {
    console.error("[cases] payment intent lookup failed", err?.message || err);
    throw new Error("Unable to verify case funding. Please try again shortly.");
  }
  if (!caseDoc.paymentIntentId) caseDoc.paymentIntentId = paymentIntent.id;
  if (!caseDoc.escrowIntentId) caseDoc.escrowIntentId = paymentIntent.id;
  if (!caseDoc.currency) caseDoc.currency = paymentIntent.currency || caseDoc.currency || "usd";

  const { transferable, charge } = stripe.isTransferablePaymentIntent(paymentIntent, {
    caseId: caseDoc._id,
  });
  if (!transferable) {
    throw new Error("Case funding is not ready to release yet.");
  }
  caseDoc.escrowStatus = "funded";
  caseDoc.paymentStatus = paymentIntent.status || caseDoc.paymentStatus || "succeeded";

  const budgetCents = Number(caseDoc.lockedTotalAmount ?? (caseDoc.totalAmount || 0));
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
    throw new Error("Case total amount is invalid.");
  }
  const attorneyFee = computeAttorneyFeeAmount(budgetCents, caseDoc);
  const paralegalFeePct = 18;
  const paralegalFee = Math.max(0, Math.round((budgetCents * paralegalFeePct) / 100));
  const payout = Math.max(0, budgetCents - paralegalFee);
  if (payout <= 0) {
    throw new Error("Calculated payout must be positive.");
  }

  const transferPayload = {
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
  };
  if (charge?.id) {
    transferPayload.source_transaction = charge.id;
  }

  let transfer;
  try {
    if (bypassStripe) {
      transfer = { id: `bypass_${caseDoc._id}` };
    } else {
      transfer = await stripe.transfers.create(transferPayload);
    }
  } catch (err) {
    console.error("[cases] payout transfer failed", err?.message || err);
    const message = stripe.sanitizeStripeError(
      err,
      "We couldn't release funds right now. Please try again shortly."
    );
    throw new Error(message);
  }

  const completedAt = caseDoc.completedAt || new Date();
  const paralegalName = `${paralegal.firstName || ""} ${paralegal.lastName || ""}`.trim() || "Paralegal";
  caseDoc.paymentReleased = true;
  caseDoc.payoutTransferId = transfer.id;
  caseDoc.paidOutAt = completedAt;
  caseDoc.completedAt = caseDoc.completedAt || completedAt;
  caseDoc.briefSummary = `${caseDoc.title} – ${paralegalName} – completed ${completedAt.toISOString().split("T")[0]}`;
  if (!Number.isFinite(caseDoc.feeAttorneyPct)) caseDoc.feeAttorneyPct = resolveAttorneyFeePct(caseDoc);
  if (!Number.isFinite(caseDoc.feeAttorneyAmount)) caseDoc.feeAttorneyAmount = attorneyFee;
  caseDoc.feeParalegalPct = paralegalFeePct;
  caseDoc.feeParalegalAmount = paralegalFee;

  const attorneyObjectId = caseDoc.attorney?._id || caseDoc.attorneyId || caseDoc.attorney;
  const paralegalObjectId = paralegal._id || caseDoc.paralegalId || caseDoc.paralegal;

  const existingIncome = await PlatformIncome.findOne({ caseId: caseDoc._id })
    .select("_id")
    .lean();
  await Promise.all([
    Payout.updateOne(
      { caseId: caseDoc._id },
      {
        $setOnInsert: {
          paralegalId: paralegalObjectId,
          caseId: caseDoc._id,
          amountPaid: payout,
          transferId: transfer.id,
        },
      },
      { upsert: true }
    ).catch((err) => {
      if (err?.code === 11000) return null;
      throw err;
    }),
    existingIncome
      ? Promise.resolve(null)
      : PlatformIncome.create({
          caseId: caseDoc._id,
          attorneyId: attorneyObjectId,
          paralegalId: paralegalObjectId,
          feeAmount: Math.max(0, (caseDoc.feeAttorneyAmount || attorneyFee || 0) + (paralegalFee || 0)),
        }).catch((err) => {
          if (err?.code === 11000) return null;
          throw err;
        }),
  ]);

  const payoutDisplay = `$${(payout / 100).toFixed(2)}`;
  try {
    const link = "dashboard-paralegal.html#cases-completed";
    const payload = {
      amount: payoutDisplay,
      link,
      message: `Case "${caseDoc.title || "Case"}" completed. Funds released.`,
    };
    const alreadySent = await hasCaseNotification(paralegalObjectId, "payout_released", caseDoc, payload);
    if (!alreadySent) {
      await sendCaseNotification(
        paralegalObjectId,
        "payout_released",
        caseDoc,
        payload,
        { actorUserId: req.user?.id }
      );
    }
  } catch {}

  try {
    const completedDateStr = completedAt.toLocaleDateString("en-US");
    const feeDisplay = `$${(paralegalFee / 100).toFixed(2)}`;
    const totalDisplay = `$${(budgetCents / 100).toFixed(2)}`;
    if (caseDoc.attorney?.email) {
      const attorneyName = `${caseDoc.attorney.firstName || ""} ${caseDoc.attorney.lastName || ""}`.trim() || "there";
      await sendEmail(
        caseDoc.attorney.email,
        "Your case has been completed",
        `<p>Hi ${attorneyName},</p>
         <p>Your case "<strong>${caseDoc.title}</strong>" was completed on <strong>${completedDateStr}</strong>.</p>
         <p>Deliverables will be available for the next 6 months.</p>`
      );
    }
    if (paralegal.email) {
      const paraName = `${paralegal.firstName || ""} ${paralegal.lastName || ""}`.trim() || "there";
      await sendEmail(
        paralegal.email,
        "Your payout is complete",
        `<p>Hi ${paraName},</p>
         <p>Your payout for "<strong>${caseDoc.title}</strong>" is complete.</p>
         <p>Case amount (Stripe): ${totalDisplay}<br/>Platform fee (${resolveParalegalFeePct(caseDoc)}%) deducted: ${feeDisplay}<br/>Payout: <strong>${payoutDisplay}</strong></p>`
      );
    }
  } catch (err) {
    console.warn("[cases] payout email error", err?.message || err);
  }

  await logAction(req, "case.release", {
    targetType: "case",
    targetId: caseDoc._id,
    caseId: caseDoc._id,
    meta: { payout, feeParalegalAmount: paralegalFee, transferId: transfer.id },
  });

  return { payout, transferId: transfer.id };
}

router.get("/open", verifyToken, requireApproved, requireRole("paralegal"), async (req, res) => {
  try {
    const blockedIds = await getBlockedUserIds(req.user.id);
    const filter = { status: "open" };
    if (blockedIds.length) {
      filter.attorney = { $nin: blockedIds };
      filter.attorneyId = { $nin: blockedIds };
    }
    const cases = await Case.find(filter)
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
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));

// ----------------------------------------
// Server-Sent Events for case updates
// ----------------------------------------
router.get(
  "/:caseId/stream",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId;
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);
    }
    res.write(`event: ready\ndata: ${JSON.stringify({ caseId, at: new Date().toISOString() })}\n\n`);

    const unsubscribe = addSubscriber(caseId, res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {}\n\n`);
      } catch {
        /* ignore */
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("error", cleanup);
  })
);

// Invitations (must run before ensureCaseParticipant to allow pending paralegals)
router.post(
  "/:caseId/invite/:paralegalId",
  csrfProtection,
  asyncHandler(async (req, res, next) => {
    const role = String(req.user?.role || "").toLowerCase();
    const { caseId, paralegalId } = req.params;

    // Avoid catching the accept/decline routes below
    if (["accept", "decline"].includes(String(paralegalId || "").toLowerCase())) {
      return next("route");
    }

    if (!["attorney", "admin"].includes(role)) {
      return res.status(403).json({ error: "Only attorneys can invite paralegals" });
    }
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    const [caseDoc, paralegal] = await Promise.all([
      Case.findById(caseId),
      User.findById(paralegalId).select(
        "role status firstName lastName email stripeAccountId stripeOnboarded stripePayoutsEnabled stripeChargesEnabled"
      ),
    ]);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }
    const attorneyId = String(caseDoc.attorneyId || caseDoc.attorney || "");
    if (role !== "admin" && (!attorneyId || attorneyId !== String(req.user.id))) {
      return res.status(403).json({ error: "You are not the attorney for this case" });
    }
    if (!paralegal || String(paralegal.role).toLowerCase() !== "paralegal" || String(paralegal.status).toLowerCase() !== "approved") {
      return res.status(400).json({ error: "Paralegal is not available for invitation" });
    }
    const paralegalEmail = normalizeEmail(paralegal.email);
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(paralegalEmail);
    if (!bypassStripe) {
      if (!paralegal.stripeAccountId) {
        return res.status(403).json({ error: "Paralegal must connect Stripe before being invited." });
      }
      if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(paralegal);
        if (!refreshed) {
          return res.status(403).json({ error: "Paralegal must complete Stripe onboarding before being invited." });
        }
      }
    }
    const caseAttorneyId = caseDoc.attorneyId || caseDoc.attorney || attorneyId;
    if (caseAttorneyId && (await isBlockedBetween(caseAttorneyId, paralegal._id))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (caseDoc.paralegalId) {
      return res.status(400).json({ error: "A paralegal is already assigned to this case" });
    }

    seedLegacyInvite(caseDoc);
    const existingInvite = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(paralegal._id)
    );
    if (existingInvite) {
      if (existingInvite.status === "pending") {
        return res.status(400).json({ error: "An invitation is already pending for this paralegal." });
      }
      if (existingInvite.status === "accepted") {
        return res.status(400).json({ error: "This paralegal has already accepted." });
      }
    }

    upsertInvite(caseDoc, paralegal._id, { status: "pending", invitedAt: new Date(), respondedAt: null });
    syncLegacyPendingFields(caseDoc);
    const lockedNow = caseDoc.lockedTotalAmount == null;
    if (lockedNow) {
      caseDoc.lockedTotalAmount = caseDoc.totalAmount;
      caseDoc.amountLockedAt = new Date();
    }
    await caseDoc.save();

    if (lockedNow) {
      try {
        const caseAttorneyId = caseDoc.attorneyId || caseDoc.attorney || null;
        if (caseAttorneyId) {
          const link = buildCaseLink(caseDoc);
          await sendCaseNotification(
            caseAttorneyId,
            "case_budget_locked",
            caseDoc,
            { link },
            { actorUserId: req.user.id }
          );
        }
      } catch {}
    }

    const inviterName = formatPersonName(req.user) || "An attorney";
    await sendCaseNotification(
      paralegal._id,
      "case_invite",
      caseDoc,
      {
        inviterName,
      },
      { actorUserId: req.user.id }
    );

    return res.json(caseSummary(caseDoc, { viewerRole: req.user?.role }));
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
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }
    const attorneyId = caseDoc.attorneyId || caseDoc.attorney;
    const paralegalId = role === "admin" && req.body?.paralegalId && isObjId(req.body.paralegalId)
      ? req.body.paralegalId
      : req.user.id;
    seedLegacyInvite(caseDoc);
    const inviteRecord = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(paralegalId)
    );
    if (!inviteRecord || inviteRecord.status !== "pending") {
      return res.status(400).json({ error: "No pending invitation for this paralegal." });
    }
    if (role !== "admin" && String(paralegalId) !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the invited paralegal" });
    }
    if (caseDoc.paralegalId && String(caseDoc.paralegalId) !== String(paralegalId)) {
      return res.status(400).json({ error: "This case is already assigned to another paralegal." });
    }
    const paralegalProfile = await User.findById(paralegalId).select(
      "firstName lastName email stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
    );
    const paralegalName = formatPersonName(paralegalProfile) || "Paralegal";

    if (decision === "accept") {
      if (!hasScopeTasks(caseDoc)) {
        return res.status(400).json({
          error: "Add at least one task before hiring a paralegal for this case.",
        });
      }
      if (attorneyId && (await isBlockedBetween(attorneyId, paralegalId))) {
        return res.status(403).json({ error: BLOCKED_MESSAGE });
      }
      if (!paralegalProfile?.stripeAccountId) {
        return res.status(403).json({ error: "Connect Stripe before accepting invitations." });
      }
      if (!paralegalProfile?.stripeOnboarded || !paralegalProfile?.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(paralegalProfile);
        if (!refreshed) {
          return res.status(403).json({ error: "Complete Stripe onboarding before accepting invitations." });
        }
      }
      if (caseDoc.lockedTotalAmount == null) {
        caseDoc.lockedTotalAmount = caseDoc.totalAmount;
        caseDoc.amountLockedAt = new Date();
      }
      upsertInvite(caseDoc, paralegalId, { status: "accepted", respondedAt: new Date() });
      syncLegacyPendingFields(caseDoc);
      if (!Array.isArray(caseDoc.applicants)) caseDoc.applicants = [];
      const existing = caseDoc.applicants.find((app) => String(app.paralegalId) === String(paralegalId));
      if (existing) {
        existing.status = "pending";
      } else {
        caseDoc.addApplicant(paralegalId, "", {
          resumeURL: paralegalProfile?.resumeURL || "",
          linkedInURL: paralegalProfile?.linkedInURL || "",
          profileSnapshot: shapeParalegalSnapshot(paralegalProfile),
        });
      }

      await caseDoc.save();
      await sendCaseNotification(
        attorneyId,
        "case_invite_response",
        caseDoc,
        {
          response: "accepted",
          paralegalId,
          paralegalName,
        },
        { actorUserId: paralegalId }
      );
      await sendCaseNotification(
        paralegalId,
        "case_invite_response",
        caseDoc,
        {
          response: "accepted",
          paralegalId,
          paralegalName,
        },
        { actorUserId: paralegalId }
      );
    } else {
      upsertInvite(caseDoc, paralegalId, { status: "declined", respondedAt: new Date() });
      syncLegacyPendingFields(caseDoc);
      if (!caseDoc.paralegalId && !hasPendingInvites(caseDoc)) {
        caseDoc.escrowStatus = null;
        caseDoc.status = "open";
      }
      if (Array.isArray(caseDoc.applicants)) {
        const existing = caseDoc.applicants.find((app) => String(app.paralegalId) === String(paralegalId));
        if (existing) existing.status = "rejected";
      }
      await caseDoc.save();
      await sendCaseNotification(
        attorneyId,
        "case_invite_response",
        caseDoc,
        {
          response: "declined",
          paralegalId,
          paralegalName,
        },
        { actorUserId: paralegalId }
      );
      await sendCaseNotification(
        paralegalId,
        "case_invite_response",
        caseDoc,
        {
          response: "declined",
          paralegalId,
          paralegalName,
        },
        { actorUserId: paralegalId }
      );
    }

    return res.json(caseSummary(caseDoc, { viewerRole: req.user?.role }));
  })
);

router.get(
  "/:caseId/invites",
  requireCaseAccess("caseId", { project: "invites pendingParalegalId pendingParalegalInvitedAt attorney attorneyId" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only attorneys can view invited paralegals." });
    }
    seedLegacyInvite(req.case);
    const inviteList = listCaseInvites(req.case);
    if (!inviteList.length) {
      return res.json({ invites: [] });
    }
    const inviteIds = inviteList.map((invite) => invite.paralegalId).filter(Boolean);
    const profiles = await User.find({ _id: { $in: inviteIds } })
      .select("firstName lastName email role avatarURL profileImage")
      .lean();
    const profileMap = new Map(profiles.map((profile) => [String(profile._id), profile]));
    const invites = inviteList
      .map((invite) => ({
        paralegal: summarizeUser(profileMap.get(String(invite.paralegalId))) || { id: invite.paralegalId },
        status: invite.status,
        invitedAt: invite.invitedAt || null,
        respondedAt: invite.respondedAt || null,
      }))
      .sort((a, b) => {
        const aTime = a.invitedAt ? new Date(a.invitedAt).getTime() : 0;
        const bTime = b.invitedAt ? new Date(b.invitedAt).getTime() : 0;
        return bTime - aTime;
      });
    return res.json({ invites });
  })
);

const ensureCaseParticipantMiddleware = ensureCaseParticipant();
router.use((req, res, next) => {
  const caseId = req.params?.caseId;
  if (!caseId || !isObjId(caseId)) {
    return next();
  }
  return ensureCaseParticipantMiddleware(req, res, next);
});

/**
 * POST /api/cases
 * Create a new case/job posting (attorney or admin only).
 */
router.post(
  "/",
  requireRole("admin", "attorney"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const role = String(req.user?.role || "").toLowerCase();
    if (role === "attorney") {
      const hasPaymentMethod = await attorneyHasPaymentMethod(req.user.id || req.user._id);
      if (!hasPaymentMethod) {
        return res
          .status(403)
          .json({ error: "Connect Stripe and add a payment method before posting a case." });
      }
    }
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
      tasks,
    } = req.body || {};
    const safeTitle = cleanTitle(title || "", 300);
    const questionList = parseListField(questions);
    const combinedDetails = [details || description, instructions]
      .filter(Boolean)
      .map((entry) => cleanText(entry, { max: 100_000 }))
      .join("\n\n");
    const narrative = cleanText(buildDetails(combinedDetails, questionList), { max: 100_000 });
    const MIN_DESCRIPTION_LENGTH = 20;
    if (!safeTitle || safeTitle.length < 5 || !narrative || narrative.length < MIN_DESCRIPTION_LENGTH) {
      return res.status(400).json({ error: "Title and a short description are required." });
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
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: "Budget must be greater than $0." });
    }
    if (amountCents < MIN_CASE_AMOUNT_CENTS) {
      return res.status(400).json({ error: "Budget must be at least $400." });
    }

    const deadlineDate = parseDeadline(deadline);
    if (deadline && !deadlineDate) {
      return res.status(400).json({ error: "Invalid deadline provided." });
    }

    const normalizedTasks = normalizeScopeTasks(tasks);
    const created = await Case.create({
      title: safeTitle,
      practiceArea: normalizedPractice,
      details: narrative,
      attorney: req.user.id,
      attorneyId: req.user.id,
      status: "open",
      totalAmount: amountCents,
      currency,
      deadline: deadlineDate,
      state: normalizedState,
      locationState: normalizedState,
      tasks: normalizedTasks,
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
      const budgetDollars = Math.max(400, Math.round((amountCents || 0) / 100) || 0);
      const attorneyProfile = await User.findById(req.user.id).select("state");
      const attorneyState = String(attorneyProfile?.state || "").trim().toUpperCase();
      const job = await Job.create({
        caseId: created._id,
        attorneyId: req.user.id,
        title: created.title,
        practiceArea: created.practiceArea,
        description: created.details,
        budget: budgetDollars,
        status: "open",
        state: attorneyState,
        locationState: attorneyState,
      });
      created.jobId = job._id;
      await created.save();
    } catch (jobErr) {
      console.warn("[cases] Unable to mirror job posting", jobErr?.message || jobErr);
    }

    try {
      await logAction(req, "case.create", { targetType: "case", targetId: created._id });
    } catch {}

    res.status(201).json(caseSummary(created, { viewerRole: req.user?.role }));
  })
);

/**
 * GET /api/cases/posted
 * List open/active postings for the authenticated attorney (or all if admin).
 */
router.get(
  "/posted",
  requireRole("admin", "attorney"),
  asyncHandler(async (req, res) => {
    const filter = {
      archived: { $ne: true },
      status: {
        $in: [
          "open",
          IN_PROGRESS_STATUS,
          LEGACY_IN_PROGRESS_STATUS,
          "assigned",
          "awaiting_funding",
          "active",
          "awaiting_documents",
          "reviewing",
        ],
      },
    };
    if (req.user.role !== "admin") {
      filter.attorney = req.user.id;
    }

    const docs = await Case.find(filter)
      .sort({ createdAt: -1 })
      .select("title practiceArea status totalAmount currency applicants paralegal hiredAt createdAt briefSummary details escrowStatus escrowIntentId");

    const items = docs.map((doc) => ({
      id: doc._id,
      title: doc.title,
      practiceArea: doc.practiceArea,
      status: normalizeCaseStatusValue(doc.status),
      totalAmount: doc.totalAmount || 0,
      currency: doc.currency || "usd",
      applicants: doc.applicants || [],
      applicantsCount: Array.isArray(doc.applicants) ? doc.applicants.length : 0,
      paralegal: doc.paralegal || null,
      hiredAt: doc.hiredAt || null,
      escrowStatus: doc.escrowStatus || null,
      escrowIntentId: doc.escrowIntentId || null,
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
  requireRole("admin"),
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
      const summary = caseSummary(doc, { viewerRole: req.user?.role });
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
  verifyToken.optional,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const limit = clamp(parseInt(req.query.limit, 10) || 12, 1, 50);
    if (!user || !user.role) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const role = user.role;
    const userId = user.id;

    const includeFiles = role !== "admin" && String(req.query.withFiles || "").toLowerCase() === "true";
    const userObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;
    const filter = {};
    const ownershipFilters = [];
    const allVariants = userObjectId ? [userObjectId, userId] : [userId];
    const includeAttorneyFilters = () => {
      allVariants.forEach((value) => {
        ownershipFilters.push({ attorney: value }, { attorneyId: value });
      });
    };
    includeAttorneyFilters();
    const includeParalegalFilters = () => {
      allVariants.forEach((value) => {
        ownershipFilters.push(
          { paralegal: value },
          { paralegalId: value },
          { "applicants.paralegalId": value }
        );
      });
    };
    includeParalegalFilters();

    if (role === "attorney") {
      filter.$or = ownershipFilters.filter((entry) => entry.attorney !== undefined || entry.attorneyId !== undefined);
    } else if (role === "paralegal") {
      filter.$or = ownershipFilters.filter(
        (entry) =>
          entry.paralegal !== undefined ||
          entry.paralegalId !== undefined ||
          entry["applicants.paralegalId"] !== undefined
      );
    } else {
      // admin: optional filter by attorney/paralegal query params
      if (req.query.attorney && isObjId(req.query.attorney)) filter.attorney = req.query.attorney;
      if (req.query.paralegal && isObjId(req.query.paralegal)) filter.paralegal = req.query.paralegal;
    }

    if (typeof req.query.archived !== "undefined") {
      const wantArchived = String(req.query.archived).toLowerCase() === "true";
      filter.archived = wantArchived ? true : { $ne: true };
    } else {
      filter.archived = { $ne: true };
    }
    if (role === "paralegal") {
      filter.$and = [
        ...(filter.$and || []),
        { status: { $ne: "completed" } },
        { paymentReleased: { $ne: true } },
      ];
    }

    const docs = await Case.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(
        "title details practiceArea status escrowStatus deadline zoomLink paymentReleased escrowIntentId applicants files jobId createdAt updatedAt attorney attorneyId paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt invites hiredAt completedAt briefSummary archived downloadUrl internalNotes totalAmount lockedTotalAmount currency tasks tasksLocked"
      )
      .populate("paralegalId", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("internalNotes.updatedBy", "firstName lastName email role avatarURL")
      .lean();

    let filesByCase = new Map();
    if (includeFiles && docs.length) {
      const caseIds = docs.map((doc) => doc._id);
      const files = await CaseFile.find({ caseId: { $in: caseIds } }).sort({ createdAt: -1 }).lean();
      files.forEach((file) => {
        const key = String(file.caseId);
        if (!filesByCase.has(key)) filesByCase.set(key, []);
        filesByCase.get(key).push(normalizeFile(file));
      });
    }

    const payload = docs.map((doc) => {
      const summary = caseSummary(doc, { includeFiles: false, viewerRole: role });
      if (includeFiles) {
        const files = filesByCase.get(String(doc._id)) || [];
        summary.files = files;
        summary.filesCount = files.length;
      }
      return summary;
    });

    res.json(payload);
  })
);

router.get(
  "/my-active",
  requireRole("attorney"),
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
        "title practiceArea status escrowStatus deadline zoomLink paymentReleased escrowIntentId jobId createdAt updatedAt attorney attorneyId paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt invites"
      )
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("paralegalId", "firstName lastName email role avatarURL")
      .populate("pendingParalegalId", "firstName lastName email role avatarURL")
      .lean();

    res.json({ items: docs.map((doc) => caseSummary(doc, { viewerRole: req.user?.role })) });
  })
);

router.get(
  "/invited-to",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 50, 1, 200);
    const filter = {
      archived: { $ne: true },
      $or: [
        { "invites.paralegalId": req.user.id, "invites.status": "pending" },
        { pendingParalegalId: req.user.id },
      ],
    };
    const blockedIds = await getBlockedUserIds(req.user.id);
    if (blockedIds.length) {
      filter.attorney = { $nin: blockedIds };
      filter.attorneyId = { $nin: blockedIds };
    }
    const docs = await Case.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(
        "title practiceArea status escrowStatus deadline zoomLink paymentReleased escrowIntentId jobId createdAt updatedAt attorney attorneyId pendingParalegalId pendingParalegalInvitedAt invites"
      )
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .lean();

    const items = docs.map((doc) => {
      const summary = caseSummary(doc, { viewerRole: req.user?.role });
      const invite = listCaseInvites(doc).find(
        (entry) => entry.status === "pending" && String(entry.paralegalId) === String(req.user.id)
      );
      if (invite) {
        summary.inviteStatus = invite.status;
        summary.inviteInvitedAt = invite.invitedAt || null;
      }
      return summary;
    });
    res.json({ items });
  })
);

router.get(
  "/open",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const filter = {
      status: "open",
      paralegalId: null,
      archived: { $ne: true },
    };
    const blockedIds = await getBlockedUserIds(req.user.id);
    if (blockedIds.length) {
      filter.attorney = { $nin: blockedIds };
      filter.attorneyId = { $nin: blockedIds };
    }
    const docs = await Case.find(filter)
      .sort({ createdAt: -1 })
      .select("title description _id attorneyId");

    res.json({ items: docs });
  })
);

router.get(
  "/my-assigned",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 100, 1, 500);
    const docs = await Case.find({
      paralegal: req.user.id,
      status: { $ne: "completed" },
      paymentReleased: { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("title caseNumber status escrowStatus escrowIntentId createdAt updatedAt attorney attorneyId archived paymentReleased paralegal paralegalId")
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
      status: normalizeCaseStatusValue(doc.status),
      escrowStatus: doc.escrowStatus || null,
      escrowIntentId: doc.escrowIntentId || null,
      archived: doc.archived,
      paymentReleased: doc.paymentReleased,
      paralegalId: doc.paralegalId || doc.paralegal || null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
    res.json({ items });
  })
);

router.get(
  "/my-completed",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 100, 1, 500);
    const userId = req.user.id;
    const userObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;
    const allVariants = userObjectId ? [userObjectId, userId] : [userId];
    const paralegalFilters = [];
    allVariants.forEach((value) => {
      paralegalFilters.push({ paralegal: value }, { paralegalId: value });
    });
    const filter = {
      $and: [
        { $or: paralegalFilters },
        { $or: [{ status: "completed" }, { paymentReleased: true }] },
      ],
    };

    const docs = await Case.find(filter)
      .sort({ completedAt: -1, paidOutAt: -1, updatedAt: -1 })
      .limit(limit)
      .select("title status paymentReleased completedAt paidOutAt attorney attorneyId")
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .lean();

    const caseIds = docs.map((doc) => doc._id);
    const payoutFilter = {
      caseId: { $in: caseIds },
      paralegalId: userObjectId || userId,
    };
    const payouts = caseIds.length
      ? await Payout.find(payoutFilter).select("caseId amountPaid createdAt").lean()
      : [];
    const payoutMap = new Map(payouts.map((payout) => [String(payout.caseId), payout]));

    const items = docs.map((doc) => {
      const payout = payoutMap.get(String(doc._id));
      const attorneyName =
        formatPersonName(doc.attorney || doc.attorneyId) ||
        doc.attorneyNameSnapshot ||
        "Attorney";
      return {
        caseId: doc._id,
        title: doc.title || "Untitled Case",
        attorneyName,
        completedAt: doc.completedAt || doc.paidOutAt || payout?.createdAt || doc.updatedAt,
        paymentAmount: (payout?.amountPaid || 0) / 100,
      };
    });

    res.json({ items });
  })
);

router.patch(
  "/:caseId",
  csrfProtection,
  requireCaseAccess(
    "caseId",
    { project: "title details practiceArea totalAmount lockedTotalAmount currency status briefSummary invites pendingParalegalId pendingParalegalInvitedAt applicants tasks tasksLocked hiredAt paralegalId" }
  ),
  asyncHandler(async (req, res) => {
    const isAdmin = !!req.acl?.isAdmin;
    if (!req.acl?.isAttorney && !isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can update this case" });
    }
    const doc = req.case;
    const body = req.body || {};
    const tasksInputProvided = Object.prototype.hasOwnProperty.call(body, "tasks");
    const normalizedTasks = tasksInputProvided ? normalizeScopeTasks(body.tasks) : null;
    const tasksOnlyUpdate =
      tasksInputProvided && Object.keys(body).every((key) => key === "tasks");
    const completionOnlyUpdate =
      tasksOnlyUpdate && isCompletionOnlyTaskUpdate(doc.tasks, normalizedTasks);
    const amountInput =
      body.totalAmount ?? body.budget ?? body.compensationAmount ?? body.compAmount;
    if (typeof amountInput !== "undefined" && amountInput !== null && doc.lockedTotalAmount != null) {
      return res.status(403).json({ error: "Case amount is locked and cannot be modified." });
    }
    const normalizedStatus = normalizeCaseStatusValue(doc.status);
    const statusKey = normalizedStatus;
    const caseClosed = CLOSED_CASE_STATUSES.has(normalizedStatus);
    const hasApplicants = Array.isArray(doc.applicants) && doc.applicants.length > 0;
    if (normalizedStatus === IN_PROGRESS_STATUS && !completionOnlyUpdate) {
      return res.status(403).json({ error: "Case edits are locked once work is in progress." });
    }
    if (!isAdmin) {
      if (completionOnlyUpdate && caseClosed) {
        return res.status(403).json({ error: "Closed cases cannot be modified." });
      }
      if (!completionOnlyUpdate) {
        if (doc.paralegalId || hasPendingInvites(doc) || hasApplicants) {
          return res.status(403).json({
            error: "Compensation is locked once a paralegal is invited, applies, or is hired.",
          });
        }
        if (!["open"].includes(statusKey)) {
          return res.status(403).json({ error: "Case edits are limited to posted cases." });
        }
      }
    }
    const forbiddenKeys = ["applicants", "paralegal", "paralegalId", "attorney", "attorneyId", "tasksLocked"];
    if (forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
      return res.status(400).json({ error: "One or more fields cannot be modified." });
    }
    if (tasksInputProvided && (doc.tasksLocked || doc.hiredAt || doc.paralegal || doc.paralegalId) && !completionOnlyUpdate) {
      return res.status(403).json({
        error: "Tasks are locked once a paralegal is hired. Create a new case for additional work.",
      });
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
    if (tasksInputProvided) {
      doc.tasks = completionOnlyUpdate
        ? mergeTaskCompletion(doc.tasks, normalizedTasks)
        : normalizedTasks || [];
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
    const beforeAmount = doc.totalAmount;
    if (typeof amountInput !== "undefined" && amountInput !== null) {
      const cents = dollarsToCents(amountInput);
      if (!Number.isFinite(cents) || cents <= 0) {
        return res.status(400).json({ error: "Budget must be greater than $0." });
      }
      if (cents < MIN_CASE_AMOUNT_CENTS) {
        return res.status(400).json({ error: "Budget must be at least $400." });
      }
      if (cents > 0) {
        if (!doc.paralegalId && !hasPendingInvites(doc)) {
          doc.totalAmount = cents;
          touched = true;
        }
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
      await logAction(req, "case.update", {
        targetType: "case",
        targetId: doc._id,
        meta: isAdmin && beforeAmount !== doc.totalAmount ? { amountOverride: { from: beforeAmount, to: doc.totalAmount }, adminId: req.user.id } : undefined,
      });
    } catch {}

    if (tasksInputProvided) {
      publishCaseEvent(doc._id, "tasks", { at: new Date().toISOString() });
    }

    res.json(caseSummary(doc, { viewerRole: req.user?.role }));
  })
);

router.delete(
  "/:caseId",
  csrfProtection,
  requireCaseAccess("caseId", { project: "status paralegal paralegalId attorney escrowStatus escrowIntentId paymentReleased" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can delete this case" });
    }
    const doc = req.case;
    const hasParalegal = !!(doc.paralegal || doc.paralegalId);
    if (hasParalegal) {
      return res.status(400).json({ error: "Cannot delete a case after hiring a paralegal" });
    }
    const escrowStatus = String(doc.escrowStatus || "").toLowerCase();
    const escrowFunded = escrowStatus === "funded" || doc.paymentReleased === true;
    if (escrowFunded) {
      return res.status(400).json({ error: "Cannot delete a case after Stripe is funded" });
    }

    await Case.deleteOne({ _id: doc._id });
    const relatedJobIds = [doc.jobId, doc.job].filter(Boolean);
    let jobIdsForCleanup = relatedJobIds.map((id) => String(id));
    try {
      const extraJobs = await Job.find({ caseId: doc._id }).select("_id").lean();
      extraJobs.forEach((job) => {
        const id = job?._id ? String(job._id) : "";
        if (id && !jobIdsForCleanup.includes(id)) jobIdsForCleanup.push(id);
      });
    } catch (jobListErr) {
      console.warn("[cases] Unable to load related jobs for cleanup", doc._id, jobListErr);
    }
    try {
      if (jobIdsForCleanup.length) {
        await Job.deleteMany({ _id: { $in: jobIdsForCleanup } });
      } else {
        await Job.deleteMany({ caseId: doc._id });
      }
    } catch (jobErr) {
      console.warn("[cases] Unable to clean up related jobs for deleted case", doc._id, jobErr);
    }
    try {
      if (jobIdsForCleanup.length) {
        await Application.deleteMany({ jobId: { $in: jobIdsForCleanup } });
      }
    } catch (appErr) {
      console.warn("[cases] Unable to clean up applications for deleted case", doc._id, appErr);
    }
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
    const normalizedStatus = normalizeCaseStatusValue(doc.status);
    if (normalizedStatus === "closed") {
      return res.status(400).json({ error: "This case is already closed." });
    }
    if (doc.terminationStatus && !["none", "resolved"].includes(doc.terminationStatus)) {
      return res.status(400).json({ error: "A termination request is already in progress." });
    }

    const reason = cleanMessage(req.body?.reason || "", { len: 2000 });
    doc.terminationRequestedAt = new Date();
    doc.terminationRequestedBy = req.user.id;
    doc.terminationReason = reason;
    doc.terminatedAt = null;
    doc.terminationDisputeId = null;
    const message = reason
      ? `Attorney requested termination: ${reason}`
      : "Attorney requested termination of this case.";
    doc.createDispute({ message, raisedBy: req.user.id });
    const lastDispute = doc.disputes[doc.disputes.length - 1];
    doc.terminationStatus = "disputed";
    doc.terminationDisputeId = lastDispute?.disputeId || (lastDispute?._id ? String(lastDispute._id) : null);
    doc.paralegalAccessRevokedAt = new Date();

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
        meta: { mode: "disputed" },
      });
    } catch {}

    const payload = {
      ok: true,
      requiresAdmin: true,
      case: caseSummary(doc, { viewerRole: req.user?.role }),
    };
    res.status(202).json(payload);
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
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Admins can only access the case archive." });
    }
    const { key, original, mime, size } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;
    const storageKey = String(key).trim();
    const filename = cleanString(original || "", { len: 400 }) || storageKey.split("/").pop();
    const uploadRole = req.user.role || "attorney";
    const defaultStatus = "pending_review";
    const status = FILE_STATUS.includes(defaultStatus) ? defaultStatus : "pending_review";

    const exists = await CaseFile.findOne({ caseId: doc._id, storageKey }).select("_id").lean();
    if (!exists) {
      const version = await nextCaseFileVersion(doc._id, filename);
      await CaseFile.create({
        caseId: doc._id,
        userId: req.user.id,
        originalName: filename,
        storageKey,
        mimeType: typeof mime === "string" ? mime : "",
        size: Number.isFinite(Number(size)) ? Number(size) : 0,
        uploadedByRole: uploadRole,
        status,
        version,
      });
      try {
        await logAction(req, "case.file.attach", {
          targetType: "case",
          targetId: doc._id,
          caseId: doc._id,
          meta: { key: storageKey, name: filename },
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
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Admins can only access the case archive." });
    }
    const { key } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;
    const storageKey = String(key).trim();
    const record = await CaseFile.findOne({ caseId: doc._id, storageKey });
    if (!record) {
      return res.status(404).json({ error: "File not found on case" });
    }
    if (S3_BUCKET && record.storageKey) {
      try {
        const keyPath = String(record.storageKey).replace(/^\/+/, "");
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: keyPath }));
      } catch (err) {
        console.warn("[cases] file delete error", err?.message || err);
      }
    }
    if (S3_BUCKET && record.previewKey) {
      try {
        const keyPath = String(record.previewKey).replace(/^\/+/, "");
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: keyPath }));
      } catch (err) {
        console.warn("[cases] file preview delete error", err?.message || err);
      }
    }
    await CaseFile.deleteOne({ _id: record._id });

    try {
      await logAction(req, "case.file.remove", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { key: storageKey },
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
  requireCaseAccess("caseId", { project: "files paymentReleased" }),
  asyncHandler(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Admins can only access the case archive." });
    }
    const { key } = req.query;
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key query param required" });
    const doc = req.case;
    if (!req.acl?.isAdmin && isCaseClosedForFiles(doc)) {
      return res.status(403).json({ error: "Files are no longer available. Download the archive instead." });
    }
    const file = await CaseFile.findOne({ caseId: doc._id, storageKey: String(key).trim() }).lean();
    if (!file) return res.status(404).json({ error: "File not found" });

    try {
      const url = await signDownload(file.storageKey);
      res.json({ url, filename: file.originalName || null });
    } catch (e) {
      console.error("[cases] signed-get error:", e);
      if (e?.code === "NoSuchKey") {
        return res.status(404).json({ error: "File no longer available for download." });
      }
      res.status(500).json({ error: "Unable to sign file" });
    }
  })
);

router.patch(
  "/:caseId/files/:fileId/status",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Admins can only access the case archive." });
    }
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the case attorney can update file status" });
    }
    const doc = req.case;
    const file = await CaseFile.findOne({ _id: req.params.fileId, caseId: doc._id });
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

    await file.save();
    try {
      await logAction(req, "case.file.status.update", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id, status: file.status },
      });
    } catch {}

    publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  })
);

router.post(
  "/:caseId/files/:fileId/revision-request",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Admins can only access the case archive." });
    }
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can request revisions" });
    }
    const doc = req.case;
    const file = await CaseFile.findOne({ _id: req.params.fileId, caseId: doc._id });
    if (!file) return res.status(404).json({ error: "File not found" });

    const note = cleanString(req.body?.notes || "", { len: 2000 });
    file.revisionNotes = note;
    file.revisionRequestedAt = new Date();
    file.status = "pending_review";
    file.approvedAt = null;

    await file.save();
    try {
      await logAction(req, "case.file.revision.request", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id },
      });
    } catch {}

    publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  })
);

router.post(
  "/:caseId/files/:fileId/replace",
  csrfProtection,
  requireCaseAccess("caseId", { project: "files" }),
  asyncHandler(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Admins can only access the case archive." });
    }
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can replace a document" });
    }
    const { key, original, mime, size } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;
    const file = await CaseFile.findOne({ _id: req.params.fileId, caseId: doc._id });
    if (!file) return res.status(404).json({ error: "File not found" });

    if (!Array.isArray(file.history)) file.history = [];
    if (file.storageKey) {
      file.history.push({ storageKey: file.storageKey, replacedAt: new Date() });
    }

    const filename = cleanString(original || "", { len: 400 }) || key.split("/").pop();
    file.storageKey = String(key).trim();
    file.originalName = filename;
    file.mimeType = typeof mime === "string" ? mime : "";
    file.size = Number.isFinite(Number(size)) ? Number(size) : 0;
    file.replacedAt = new Date();
    file.userId = req.user.id;
    file.uploadedByRole = req.user.role || "attorney";
    file.status = "attorney_revision";
    file.version = await nextCaseFileVersion(doc._id, filename);
    file.approvedAt = null;
    file.revisionRequestedAt = null;
    file.revisionNotes = "";

    await file.save();
    try {
      await logAction(req, "case.file.replace", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id, key: file.storageKey },
      });
    } catch {}

    publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  })
);

router.post(
  "/:caseId/apply",
  requireRole("paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });

    const doc = await Case.findById(caseId).select(
      "status paralegal applicants archived attorney attorneyId title paymentReleased totalAmount lockedTotalAmount amountLockedAt"
    );
    if (!doc) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(doc)) {
      return res.status(400).json({ error: "This case is no longer accepting applications." });
    }
    if (doc.archived) return res.status(400).json({ error: "This case is not accepting applications" });
    if (doc.paralegal) return res.status(400).json({ error: "A paralegal has already been hired" });
    if (doc.status !== "open") return res.status(400).json({ error: "Applications are closed for this case" });
    const caseAttorneyId = doc.attorneyId || doc.attorney || null;
    if (caseAttorneyId && (await isBlockedBetween(req.user.id, caseAttorneyId))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    const attorneyReady = await attorneyHasPaymentMethod(caseAttorneyId);
    if (!attorneyReady) {
      return res
        .status(403)
        .json({ error: "This attorney must connect Stripe before applications can be submitted." });
    }

    const rawNote = cleanString(req.body?.note || req.body?.coverLetter || "", { len: 2000 });
    if (rawNote && rawNote.length < 20) {
      return res.status(400).json({ error: "Please provide more detail in your note (20+ characters)." });
    }
    const applicant = await User.findById(req.user.id).select(
      "firstName lastName email role stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
    );
    if (!applicant) {
      return res.status(404).json({ error: "Unable to load your profile details." });
    }
    const applicantEmail = String(applicant.email || req.user?.email || "").toLowerCase().trim();
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(applicantEmail);
    if (!bypassStripe) {
      if (!applicant.stripeAccountId) {
        return res.status(403).json({ error: "Connect Stripe before applying to jobs." });
      }
      if (!applicant.stripeOnboarded || !applicant.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(applicant);
        if (!refreshed) {
          return res.status(403).json({ error: "Complete Stripe onboarding before applying to jobs." });
        }
      }
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
    const lockedNow = doc.lockedTotalAmount == null;
    if (lockedNow) {
      doc.lockedTotalAmount = doc.totalAmount;
      doc.amountLockedAt = new Date();
    }

    await doc.save();
    try {
      await logAction(req, "case.apply", { targetType: "case", targetId: doc._id, meta: { note: Boolean(rawNote) } });
    } catch {}
    try {
      const attorneyId = doc.attorney?._id || doc.attorneyId || doc.attorney || null;
      if (attorneyId) {
        const link = buildCaseLink(doc);
        if (lockedNow) {
          await sendCaseNotification(
            attorneyId,
            "case_budget_locked",
            doc,
            { link },
            { actorUserId: req.user.id }
          );
        }
        const paralegalName = formatPersonName(applicant) || "Paralegal";
        await sendCaseNotification(
          attorneyId,
          "application_submitted",
          doc,
          {
            paralegalName,
            paralegalId: req.user.id,
            title: doc.title || "Case",
            link,
          },
          { actorUserId: req.user.id }
        );
      }
    } catch {}

    res.status(201).json({ ok: true, applicants: doc.applicants.length });
  })
);

router.post(
  "/:caseId/applicants/:paralegalId/star",
  verifyToken,
  csrfProtection,
  requireCaseAccess("caseId", { project: "applicants attorney attorneyId jobId job" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only attorneys can star applications." });
    }
    const caseDoc = req.case;
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const ownerId = String(caseDoc.attorneyId || caseDoc.attorney || "");
    if (ownerId && String(req.user.id) !== ownerId && req.user.role !== "admin") {
      return res.status(403).json({ error: "You are not the attorney for this case." });
    }

    const paralegalId = req.params.paralegalId;
    if (!isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid paralegal id" });
    }

    const jobId = caseDoc.jobId || caseDoc.job || null;
    const userId = String(req.user.id);
    const requested = req.body?.starred;
    const desired = typeof requested === "boolean" ? requested : null;

    const caseEntry = Array.isArray(caseDoc.applicants)
      ? caseDoc.applicants.find((app) => String(app.paralegalId) === String(paralegalId))
      : null;

    const applicationDoc = jobId
      ? await Application.findOne({ jobId, paralegalId })
      : null;

    if (!caseEntry && !applicationDoc) {
      return res.status(404).json({ error: "Application not found." });
    }

    const caseStarred =
      caseEntry &&
      Array.isArray(caseEntry.starredBy) &&
      caseEntry.starredBy.some((id) => String(id) === userId);
    const appStarred =
      applicationDoc &&
      Array.isArray(applicationDoc.starredBy) &&
      applicationDoc.starredBy.some((id) => String(id) === userId);
    const shouldStar = typeof desired === "boolean" ? desired : !(caseStarred || appStarred);

    const updateStarList = (list) => {
      const idx = list.findIndex((id) => String(id) === userId);
      if (shouldStar && idx === -1) list.push(req.user.id);
      if (!shouldStar && idx !== -1) list.splice(idx, 1);
    };

    if (caseEntry) {
      if (!Array.isArray(caseEntry.starredBy)) caseEntry.starredBy = [];
      updateStarList(caseEntry.starredBy);
      await caseDoc.save();
    }

    if (applicationDoc) {
      if (!Array.isArray(applicationDoc.starredBy)) applicationDoc.starredBy = [];
      updateStarList(applicationDoc.starredBy);
      await applicationDoc.save();
    }

    res.json({ ok: true, starred: shouldStar });
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
    const invitee = await User.findById(paralegalId).select(
      "firstName lastName role status email stripeAccountId stripeOnboarded stripePayoutsEnabled stripeChargesEnabled"
    );
    if (!invitee || invitee.role !== "paralegal" || invitee.status !== "approved") {
      return res.status(400).json({ error: "Select an approved paralegal to invite." });
    }
    const inviteeEmail = normalizeEmail(invitee.email);
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(inviteeEmail);
    if (!bypassStripe) {
      if (!invitee.stripeAccountId) {
        return res.status(403).json({ error: "Paralegal must connect Stripe before being invited." });
      }
      if (!invitee.stripeOnboarded || !invitee.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(invitee);
        if (!refreshed) {
          return res.status(403).json({ error: "Paralegal must complete Stripe onboarding before being invited." });
        }
      }
    }

    const caseDoc = await Case.findById(req.params.caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("paralegal", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }

    const ownerId = String(caseDoc.attorneyId || caseDoc.attorney?._id || "");
    if (!ownerId || ownerId !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this case." });
    }
    if (await isBlockedBetween(ownerId, invitee._id)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (caseDoc.paralegal) {
      return res.status(400).json({ error: "A paralegal has already been assigned to this case." });
    }
    if (caseDoc.archived) {
      return res.status(400).json({ error: "This case is archived." });
    }

    seedLegacyInvite(caseDoc);
    const existingInvite = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(invitee._id)
    );
    if (existingInvite) {
      if (existingInvite.status === "pending") {
        return res.status(400).json({ error: "An invitation is already pending for this paralegal." });
      }
      if (existingInvite.status === "accepted") {
        return res.status(400).json({ error: "This paralegal has already accepted." });
      }
    }

    upsertInvite(caseDoc, invitee._id, { status: "pending", invitedAt: new Date(), respondedAt: null });
    syncLegacyPendingFields(caseDoc);
    const lockedNow = caseDoc.lockedTotalAmount == null;
    if (lockedNow) {
      caseDoc.lockedTotalAmount = caseDoc.totalAmount;
      caseDoc.amountLockedAt = new Date();
    }
    await caseDoc.save();

    if (lockedNow) {
      try {
        const caseAttorneyId =
          caseDoc.attorneyId?._id || caseDoc.attorneyId || caseDoc.attorney?._id || caseDoc.attorney || null;
        if (caseAttorneyId) {
          const link = buildCaseLink(caseDoc);
          await sendCaseNotification(
            caseAttorneyId,
            "case_budget_locked",
            caseDoc,
            { link },
            { actorUserId: req.user.id }
          );
        }
      } catch {}
    }

    try {
      await logAction(req, "paralegal_invited", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
        meta: { paralegalId: invitee._id },
      });
    } catch {}

    const attorneyName = formatPersonName(caseDoc.attorney || caseDoc.attorneyId) || "An attorney";
    await sendCaseNotification(
      invitee._id,
      "case_invite",
      caseDoc,
      {
        inviterName: attorneyName,
      },
      { actorUserId: req.user.id }
    );

    res.json({ success: true });
  })
);

router.post(
  "/:caseId/invite/accept",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });
    const caseDoc = await Case.findById(caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("pendingParalegalId", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }
    // If another paralegal is already assigned, block; otherwise allow the accept to repair state.
    if (caseDoc.paralegal && String(caseDoc.paralegal) !== String(req.user.id)) {
      return res.status(400).json({ error: "This case is already assigned to another paralegal." });
    }
    const caseAttorneyId = caseDoc.attorneyId?._id || caseDoc.attorneyId || caseDoc.attorney?._id || caseDoc.attorney;
    if (caseAttorneyId && (await isBlockedBetween(caseAttorneyId, req.user.id))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }

    seedLegacyInvite(caseDoc);
    const inviteRecord = listCaseInvites(caseDoc).find(
      (invite) => invite.status === "pending" && String(invite.paralegalId) === String(req.user.id)
    );
    if (!inviteRecord) {
      return res.status(400).json({ error: "No pending invitation for this case." });
    }

    const paralegal = await User.findById(req.user.id).select(
      "firstName lastName email stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
    );
    if (!paralegal?.stripeAccountId) {
      return res.status(403).json({ error: "Connect Stripe before accepting invitations." });
    }
    if (!paralegal?.stripeOnboarded || !paralegal?.stripePayoutsEnabled) {
      const refreshed = await ensureStripeOnboardedUser(paralegal);
      if (!refreshed) {
        return res.status(403).json({ error: "Complete Stripe onboarding before accepting invitations." });
      }
    }
    if (caseDoc.lockedTotalAmount == null) {
      caseDoc.lockedTotalAmount = caseDoc.totalAmount;
      caseDoc.amountLockedAt = new Date();
    }
    if (!hasScopeTasks(caseDoc)) {
      return res.status(400).json({
        error: "Add at least one task before hiring a paralegal for this case.",
      });
    }
    upsertInvite(caseDoc, req.user.id, { status: "accepted", respondedAt: new Date() });
    syncLegacyPendingFields(caseDoc);
    if (!Array.isArray(caseDoc.applicants)) caseDoc.applicants = [];
    const existing = caseDoc.applicants.find((app) => String(app.paralegalId) === String(req.user.id));
    if (existing) {
      existing.status = "pending";
    } else {
      caseDoc.addApplicant(req.user.id, "", {
        resumeURL: paralegal?.resumeURL || "",
        linkedInURL: paralegal?.linkedInURL || "",
        profileSnapshot: shapeParalegalSnapshot(paralegal),
      });
    }

    await caseDoc.save();

    try {
      await logAction(req, "paralegal_invite_accepted", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
      });
    } catch {}

    const attorneyId = caseDoc.attorney?._id || caseDoc.attorneyId || null;
    if (attorneyId) {
      await sendCaseNotification(
        attorneyId,
        "case_invite_response",
        caseDoc,
        {
          response: "accepted",
          paralegalId: req.user.id,
          paralegalName: formatPersonName(paralegal),
        },
        { actorUserId: req.user.id }
      );
    }

    // Let the paralegal know the acceptance was recorded
    await sendCaseNotification(
      req.user.id,
      "case_invite_response",
      caseDoc,
      {
        response: "accepted",
        paralegalId: req.user.id,
        paralegalName: formatPersonName(paralegal),
      },
      { actorUserId: req.user.id }
    );

    res.json({ success: true });
  })
);

router.post(
  "/:caseId/invite/decline",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });
    const caseDoc = await Case.findById(caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("pendingParalegalId", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }
    seedLegacyInvite(caseDoc);
    const inviteRecord = listCaseInvites(caseDoc).find(
      (invite) => invite.status === "pending" && String(invite.paralegalId) === String(req.user.id)
    );
    if (!inviteRecord) {
      return res.status(400).json({ error: "No pending invitation for this case." });
    }
    const paralegal = await User.findById(req.user.id).select("firstName lastName");
    upsertInvite(caseDoc, req.user.id, { status: "declined", respondedAt: new Date() });
    syncLegacyPendingFields(caseDoc);
    if (Array.isArray(caseDoc.applicants) && caseDoc.applicants.length) {
      caseDoc.applicants.forEach((app) => {
        if (app?.paralegalId && String(app.paralegalId) === String(req.user.id)) {
          app.status = "rejected";
        }
      });
    }
    if (!caseDoc.paralegalId && !hasPendingInvites(caseDoc)) {
      caseDoc.status = "open";
      caseDoc.escrowStatus = null;
    }
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
      await sendCaseNotification(
        attorneyId,
        "case_invite_response",
        caseDoc,
        {
          response: "declined",
          paralegalId: req.user.id,
          paralegalName: formatPersonName(paralegal),
        },
        { actorUserId: req.user.id }
      );
    }

    // Let the paralegal know their decline was recorded
    await sendCaseNotification(
      req.user.id,
      "case_invite_response",
      caseDoc,
      {
        response: "declined",
        paralegalId: req.user.id,
        paralegalName: formatPersonName(paralegal),
      },
      { actorUserId: req.user.id }
    );

    res.json({ success: true });
  })
);

/**
 * POST /api/cases/:caseId/withdraw
 * Paralegal withdraws from a case before escrow is funded.
 */
router.post(
  "/:caseId/withdraw",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid case id" });

    const caseDoc = await Case.findById(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }

    const paralegalRef = caseDoc.paralegalId || caseDoc.paralegal;
    if (!paralegalRef || String(paralegalRef) !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not assigned to this case" });
    }
    return res.status(400).json({
      error: "Paralegals cannot withdraw after being hired. Open a dispute to request any changes.",
    });
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
    console.log("[case-hire] request", {
      caseId: req.params.caseId,
      paralegalId: req.params.paralegalId,
      attorneyId: req.user?.id,
    });
    if (!req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the case attorney can hire for this case" });
    }

    const { caseId, paralegalId } = req.params;
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    const selectedCase = await Case.findById(caseId);
    if (!selectedCase) return res.status(404).json({ error: "Case not found" });
    if (isFinalCaseDoc(selectedCase)) {
      return res.status(400).json({ error: "Completed cases cannot be modified." });
    }
    if (selectedCase.paralegalId || selectedCase.paralegal) {
      return res.status(400).json({ error: "A paralegal has already been hired" });
    }
    if (!hasScopeTasks(selectedCase)) {
      return res.status(400).json({
        error: "Add at least one task before hiring a paralegal for this case.",
      });
    }

    const rawAttorney = selectedCase.attorney || selectedCase.attorneyId;
    const attorneyOnCase =
      rawAttorney && typeof rawAttorney === "object" && rawAttorney._id
        ? String(rawAttorney._id)
        : String(rawAttorney || "");
    if (!attorneyOnCase || attorneyOnCase !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this case" });
    }

    const amountToCharge = selectedCase.lockedTotalAmount;
    const budgetCents = Math.round(Number(amountToCharge) || 0);
    if (!Number.isFinite(budgetCents) || budgetCents < MIN_CASE_AMOUNT_CENTS) {
      return res.status(400).json({ error: "Case amount must be at least $400 before hiring." });
    }

    const paralegal = await User.findById(paralegalId).select(
      "firstName lastName email role stripeAccountId stripeOnboarded stripePayoutsEnabled"
    );
    if (!paralegal) return res.status(404).json({ error: "Paralegal not found" });
    if (await isBlockedBetween(attorneyOnCase, paralegal._id)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    const paralegalEmail = String(paralegal.email || "").toLowerCase().trim();
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(paralegalEmail);
    if (!bypassStripe) {
      if (!paralegal.stripeAccountId) {
        return res.status(403).json({ error: "Connect Stripe before hiring a paralegal." });
      }
      if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(paralegal);
        if (!refreshed) {
          return res.status(403).json({ error: "Complete Stripe onboarding before hiring a paralegal." });
        }
      }
    }

    const attorney = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!attorney) return res.status(404).json({ error: "Attorney not found" });

    const attorneyFee = Math.max(0, Math.round(budgetCents * (resolveAttorneyFeePct(selectedCase) / 100)));
    const paralegalFee = Math.max(0, Math.round(budgetCents * (resolveParalegalFeePct(selectedCase) / 100)));
    const totalCharge = Math.round(budgetCents + attorneyFee);

    if (!attorney.email) {
      return res.status(400).json({ error: "Attorney email is required to fund Stripe." });
    }

    const customerId = await ensureStripeCustomer(attorney);
    const defaultPaymentMethodId = await fetchDefaultPaymentMethodId(customerId);
    if (!defaultPaymentMethodId) {
      return res.status(400).json({ error: "Add a payment method before hiring." });
    }

    if (selectedCase.escrowIntentId) {
      try {
        const existing = await stripe.paymentIntents.retrieve(selectedCase.escrowIntentId);
        if (existing && !["succeeded", "canceled"].includes(existing.status)) {
          await stripe.paymentIntents.cancel(existing.id);
        }
      } catch (err) {
        console.warn("[case-hire] Unable to cancel existing payment intent", err?.message || err);
      }
    }

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: totalCharge,
        currency: selectedCase.currency || "usd",
        customer: customerId,
        payment_method: defaultPaymentMethodId,
        off_session: true,
        confirm: true,
        receipt_email: attorney.email,
        transfer_group: stripe.caseTransferGroup
          ? stripe.caseTransferGroup(selectedCase._id)
          : `case_${selectedCase._id.toString()}`,
        metadata: {
          caseId: String(selectedCase._id),
          attorneyId: String(attorney._id),
          paralegalId: String(paralegal._id),
        },
        description: buildCaseChargeDescription(selectedCase, paralegal),
      });
    } catch (err) {
      const message = stripe.sanitizeStripeError(
        err,
        "Unable to charge the card on file. Please try again or update your payment method."
      );
      return res.status(402).json({ error: message });
    }

    if (!paymentIntent || paymentIntent.status !== "succeeded") {
      try {
        if (paymentIntent?.id) await stripe.paymentIntents.cancel(paymentIntent.id);
      } catch (err) {
        console.warn("[case-hire] Unable to cancel failed payment intent", err?.message || err);
      }
      return res.status(402).json({ error: "Unable to charge the card on file. Please try again." });
    }

    seedLegacyInvite(selectedCase);
    const pendingInvitees = listCaseInvites(selectedCase)
      .filter((invite) => invite.status === "pending" && String(invite.paralegalId) !== String(paralegalId))
      .map((invite) => invite.paralegalId);
    const existingInvite = listCaseInvites(selectedCase).find(
      (invite) => String(invite.paralegalId) === String(paralegalId)
    );

    selectedCase.paralegal = paralegalId;
    selectedCase.paralegalId = paralegalId;
    if (existingInvite) {
      upsertInvite(selectedCase, paralegalId, { status: "accepted", respondedAt: new Date() });
    }
    markOtherInvites(selectedCase, paralegalId, "declined");
    syncLegacyPendingFields(selectedCase);
    if (selectedCase.lockedTotalAmount == null) {
      selectedCase.lockedTotalAmount = selectedCase.totalAmount;
      selectedCase.amountLockedAt = new Date();
    }
    selectedCase.hiredAt = new Date();
    selectedCase.tasksLocked = true;
    selectedCase.paralegalNameSnapshot = formatPersonName(paralegal);
    selectedCase.paymentIntentId = paymentIntent.id;
    selectedCase.escrowIntentId = paymentIntent.id;
    selectedCase.paymentStatus = paymentIntent.status || selectedCase.paymentStatus || "succeeded";
    selectedCase.escrowStatus = "funded";
    selectedCase.currency = paymentIntent.currency || selectedCase.currency || "usd";
    if (typeof selectedCase.canTransitionTo === "function" && selectedCase.canTransitionTo(IN_PROGRESS_STATUS)) {
      selectedCase.transitionTo(IN_PROGRESS_STATUS);
    } else {
      selectedCase.status = IN_PROGRESS_STATUS;
    }
    selectedCase.feeAttorneyPct = resolveAttorneyFeePct(selectedCase);
    selectedCase.feeAttorneyAmount = attorneyFee;
    selectedCase.feeParalegalPct = resolveParalegalFeePct(selectedCase);
    selectedCase.feeParalegalAmount = paralegalFee;
    let hiredWasApplicant = false;
    const rejectedApplicantIds = new Set();
    if (Array.isArray(selectedCase.applicants) && selectedCase.applicants.length) {
      selectedCase.applicants.forEach((app) => {
        const applicantId = String(app.paralegalId || "");
        if (!applicantId) return;
        if (applicantId === String(paralegalId)) {
          app.status = "accepted";
          hiredWasApplicant = true;
        } else {
          app.status = "rejected";
          rejectedApplicantIds.add(applicantId);
        }
      });
    }

    const rawJobId = selectedCase.jobId || selectedCase.job || null;
    const jobId =
      rawJobId && typeof rawJobId === "object" ? rawJobId._id || rawJobId.id || rawJobId : rawJobId;
    if (jobId) {
      const jobApps = await Application.find({ jobId }).select("paralegalId").lean();
      jobApps.forEach((app) => {
        const applicantId = String(app.paralegalId || "");
        if (!applicantId) return;
        if (applicantId === String(paralegalId)) {
          hiredWasApplicant = true;
        } else {
          rejectedApplicantIds.add(applicantId);
        }
      });
    }

    try {
      await selectedCase.save();
    } catch (err) {
      try {
        await stripe.refunds.create({ payment_intent: paymentIntent.id });
      } catch (refundErr) {
        console.error("[case-hire] Unable to refund after save failure", refundErr?.message || refundErr);
      }
      return res.status(500).json({ error: "Unable to finalize hire. Please try again." });
    }
    await markJobAssigned(selectedCase);
    await selectedCase.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    await Promise.all(
      pendingInvitees.map((inviteeId) =>
        sendCaseNotification(
          inviteeId,
          "case_invite_response",
          selectedCase,
          {
            response: "filled",
            paralegalId,
            paralegalName: formatPersonName(paralegal),
          },
          { actorUserId: req.user.id }
        )
      )
    );

    if (jobId) {
      try {
        await Application.updateOne(
          { jobId, paralegalId },
          { $set: { status: "accepted" } }
        );
        await Application.updateMany(
          { jobId, paralegalId: { $ne: paralegalId } },
          { $set: { status: "rejected" } }
        );
      } catch (err) {
        console.warn("[case-hire] Unable to update application statuses", err?.message || err);
      }
    }

    try {
      const link = buildCaseLink(selectedCase);
      if (hiredWasApplicant) {
        await sendCaseNotification(
          paralegalId,
          "application_accepted",
          selectedCase,
          { link },
          { actorUserId: req.user.id }
        );
      }
      if (rejectedApplicantIds.size) {
        const rejectLink = "dashboard-paralegal.html";
        await Promise.all(
          [...rejectedApplicantIds].map((id) =>
            sendCaseNotification(
              id,
              "application_denied",
              selectedCase,
              { link: rejectLink },
              { actorUserId: req.user.id }
            )
          )
        );
      }
      await sendCaseNotification(
        paralegalId,
        "case_work_ready",
        selectedCase,
        { link },
        { actorUserId: req.user.id }
      );
    } catch {}

    res.json(caseSummary(selectedCase, { viewerRole: req.user?.role }));
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
    const statusKey = String(doc.status || "").toLowerCase();
    const isFinalCase = statusKey === "completed" || doc.paymentReleased === true;
    if (!shouldArchive && isFinalCase) {
      return res.status(400).json({ error: "Completed cases cannot be restored." });
    }

    // Normalize status when unarchiving to avoid enum errors on legacy "draft" values.
    if (!shouldArchive) {
      const statusKey = String(doc.status || "").toLowerCase();
      if (!statusKey || statusKey === "draft") {
        doc.status = "open";
      }
    }
    doc.archived = shouldArchive;
    await doc.save();
    try {
      await logAction(req, shouldArchive ? "case.archive" : "case.restore", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
      });
    } catch {}

    res.json(caseSummary(doc, { viewerRole: req.user?.role }));
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
      .populate(
        "paralegal",
        "firstName lastName email role stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled"
      )
      .populate("attorney", "firstName lastName email role");
    if (!doc) return res.status(404).json({ error: "Case not found" });
    if (doc.status === "completed" || doc.paymentReleased) {
      return res.json({
        ok: true,
        alreadyClosed: true,
        downloadPath: doc.archiveZipKey
          ? `/api/cases/${encodeURIComponent(doc._id)}/archive/download`
          : null,
        purgeScheduledFor: doc.purgeScheduledFor,
        archiveReadyAt: doc.archiveReadyAt,
      });
    }
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

    if (!areAllScopeTasksComplete(doc)) {
      return res.status(400).json({
        error: "All tasks must be checked off before releasing funds.",
      });
    }

    let releaseResult;
    try {
      releaseResult = await ensureFundsReleased(req, doc);
    } catch (err) {
      return res.status(400).json({ error: err.message || "Unable to release funds." });
    }

    const now = new Date();
    if (typeof doc.transitionTo === "function" && doc.canTransitionTo("completed")) {
      doc.transitionTo("completed");
    } else {
      doc.status = "completed";
    }
    doc.completedAt = doc.completedAt || now;
    doc.archived = true;
    doc.readOnly = true;
    doc.paralegalAccessRevokedAt = doc.paralegalAccessRevokedAt || now;
    doc.paralegalNameSnapshot =
      doc.paralegalNameSnapshot ||
      `${doc.paralegal?.firstName || ""} ${doc.paralegal?.lastName || ""}`.trim();
    doc.attorneyNameSnapshot =
      doc.attorneyNameSnapshot ||
      `${doc.attorney?.firstName || ""} ${doc.attorney?.lastName || ""}`.trim();
    const purgeAt = new Date(now);
    purgeAt.setMonth(purgeAt.getMonth() + 6);
    doc.purgeScheduledFor = purgeAt;
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

    try {
      const paymentMethodLabel = await resolvePaymentMethodLabel(doc);
      await generateReceiptDocuments(doc, {
        payoutAmount: releaseResult?.payout,
        paymentMethodLabel,
      });
    } catch (err) {
      console.warn("[cases] receipt generation failed", err?.message || err);
    }

    try {
      const link = "dashboard-attorney.html#cases:archived";
      const attorneyId = doc.attorney?._id || doc.attorneyId || doc.attorney || null;
      if (attorneyId) {
        const payload = {
          link,
          summary: "Payment released. Case completed and archived.",
        };
        const alreadySent = await hasCaseNotification(attorneyId, "case_update", doc, payload);
        if (!alreadySent) {
          await sendCaseNotification(
            attorneyId,
            "case_update",
            doc,
            payload,
            { actorUserId: req.user?.id }
          );
        }
      }
    } catch {}

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
        "title status practiceArea details state locationState deadline zoomLink paymentReleased escrowIntentId escrowStatus totalAmount lockedTotalAmount currency files attorney paralegal applicants hiredAt completedAt briefSummary archived downloadUrl terminationReason terminationStatus terminationRequestedAt terminationRequestedBy terminationDisputeId terminatedAt paralegalAccessRevokedAt archiveReadyAt archiveDownloadedAt purgeScheduledFor readOnly jobId job tasks tasksLocked"
      )
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role")
      .populate("applicants.paralegalId", "firstName lastName email role")
      .populate("terminationRequestedBy", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Case not found" });
    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const canSeeStars = role === "attorney" || isAdmin;
    const statusKey = String(doc.status || "").toLowerCase();
    if (role === "paralegal" && (statusKey === "completed" || doc.paymentReleased === true)) {
      return res.status(403).json({ error: "Completed cases are no longer accessible." });
    }

    let applicants = Array.isArray(doc.applicants)
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
          const starred =
            canSeeStars &&
            Array.isArray(entry.starredBy) &&
            entry.starredBy.some((id) => String(id) === String(req.user.id));
          return {
            status: entry.status,
            appliedAt: entry.appliedAt,
            note: coverLetter,
            coverLetter,
            resumeURL,
            linkedInURL,
            profileSnapshot,
            applicationId: null,
            starred,
            paralegalId: entry.paralegalId ? String(entry.paralegalId._id || entry.paralegalId) : null,
            paralegal: summarizeUser(entry.paralegalId),
          };
        })
      : [];

    const jobId = doc.jobId || doc.job || null;
    if (jobId) {
      const jobApps = await Application.find({ jobId })
        .populate("paralegalId", "firstName lastName email role profileImage avatarURL")
        .lean();
      if (jobApps.length) {
        const existing = new Set(applicants.map((entry) => String(entry.paralegalId || "")));
        const mapped = jobApps
          .map((app) => {
            const paralegalDoc = app.paralegalId && typeof app.paralegalId === "object" ? app.paralegalId : null;
            const paralegalId = paralegalDoc?._id || app.paralegalId || null;
            const starred =
              canSeeStars &&
              Array.isArray(app.starredBy) &&
              app.starredBy.some((id) => String(id) === String(req.user.id));
            return {
              status: app.status || "submitted",
              appliedAt: app.createdAt,
              note: app.coverLetter || "",
              coverLetter: app.coverLetter || "",
              resumeURL: app.resumeURL || "",
              linkedInURL: app.linkedInURL || "",
              profileSnapshot: app.profileSnapshot || {},
              applicationId: app._id ? String(app._id) : null,
              starred,
              paralegalId: paralegalId ? String(paralegalId) : null,
              paralegal: summarizeUser(paralegalDoc),
            };
          })
          .filter((entry) => {
            if (!entry.paralegalId) return true;
            if (existing.has(String(entry.paralegalId))) return false;
            existing.add(String(entry.paralegalId));
            return true;
          });
        applicants = [...applicants, ...mapped];
      }
    }

    if (String(req.user?.role || "").toLowerCase() === "attorney") {
      const blockedIds = await getBlockedUserIds(req.user.id);
      if (blockedIds.length) {
        const blockedSet = new Set(blockedIds.map((id) => String(id)));
        applicants = applicants.filter((entry) => !blockedSet.has(String(entry.paralegalId || "")));
      }
    }

    res.json({
      id: String(doc._id),
      _id: doc._id,
      title: doc.title,
      status: normalizeCaseStatusValue(doc.status),
      practiceArea: doc.practiceArea || "",
      details: doc.details || "",
      state: doc.state || "",
      locationState: doc.locationState || doc.state || "",
      zoomLink: doc.zoomLink || "",
      paymentReleased: doc.paymentReleased || false,
      escrowIntentId: doc.escrowIntentId || null,
      escrowStatus: doc.escrowStatus || null,
      totalAmount: doc.totalAmount || 0,
      lockedTotalAmount: typeof doc.lockedTotalAmount === "number" ? doc.lockedTotalAmount : null,
      currency: doc.currency || "usd",
      deadline: doc.deadline || null,
      hiredAt: doc.hiredAt || null,
      completedAt: doc.completedAt || null,
      briefSummary: doc.briefSummary || "",
      tasks: serializeScopeTasks(doc.tasks),
      tasksLocked: !!doc.tasksLocked,
      archived: !!doc.archived,
      downloadUrl: isAdmin ? [] : Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
      readOnly: !!doc.readOnly,
      paralegalAccessRevokedAt: doc.paralegalAccessRevokedAt || null,
      archiveReadyAt: doc.archiveReadyAt || null,
      archiveDownloadedAt: doc.archiveDownloadedAt || null,
      purgeScheduledFor: doc.purgeScheduledFor || null,
      attorney: doc.attorney || null,
      paralegal: doc.paralegal || null,
      paralegalNameSnapshot: doc.paralegalNameSnapshot || "",
      files: isAdmin ? [] : Array.isArray(doc.files) ? doc.files.map(normalizeFile) : [],
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
    const doc = await Case.findById(req.params.caseId)
      .select(
        "archiveZipKey title practiceArea status deadline createdAt updatedAt completedAt lockedTotalAmount totalAmount currency paymentReleased briefSummary zoomLink archived readOnly files attorney attorneyId paralegal paralegalId attorneyNameSnapshot paralegalNameSnapshot"
      )
      .populate("attorney", "firstName lastName email role")
      .populate("paralegal", "firstName lastName email role")
      .lean();
    if (!doc) {
      return res.status(404).json({ error: "Archive not available" });
    }
    let archiveKey = doc.archiveZipKey || "";
    let generatedOnDemand = false;
    if (!archiveKey || !String(archiveKey).includes("archive-v2.zip")) {
      try {
        const regen = await generateArchiveZip(doc);
        archiveKey = regen.key;
        generatedOnDemand = true;
      } catch (err) {
        console.error("[cases] archive regenerate error", err);
        return res.status(500).json({ error: "Archive not ready" });
      }
    }
    if (!archiveKey) {
      return res.status(404).json({ error: "Archive not found" });
    }
    if (!S3_BUCKET) {
      return res.status(500).json({ error: "Storage misconfigured" });
    }
    const key = String(archiveKey).replace(/^\/+/, "");
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

    if (generatedOnDemand) {
      stream.Body.on("end", async () => {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        } catch (err) {
          console.warn("[cases] archive delete error", err?.message || err);
        }
      });
    }

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
