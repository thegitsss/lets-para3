const { letterEmail } = require("../email/layout");
const accountEmails = require("../email/accountTemplates");
// backend/routes/admin.js
const router = require("express").Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const { createLogger, logPromiseFailure } = require("../utils/logger");
const { createS3Client } = require("../utils/s3Client");
const User = require("../models/User");
const Case = require("../models/Case");
const { CASE_STATUS_ENUM } = require("../utils/caseState");
const Job = require("../models/Job");
const AuditLog = require("../models/AuditLog");
const PaymentOperation = require("../models/PaymentOperation");
const adminPayoutProjection = require("../services/adminPayoutProjection");
const adminMatterDeletion = require("../services/adminMatterDeletion");
const adminFinancialReport = require("../services/adminFinancialReport");
const {
  acknowledgeChargeback,
  clearEligiblePayoutHold,
  recordChargebackEvent,
} = require("../services/chargebackService");
const logger = createLogger("admin");
const { isEmailAddressShape } = require("../utils/emailAddressShape");
const {
  deactivateUserAccount,
  finalizeAccountDataRemoval,
} = require("../services/userDeletion");
const { revokeAllUserSessions } = require("../services/authSessionService");
const sendEmail = require("../utils/email");
const { sendProfilePhotoRejectedEmail } = sendEmail;
const { notifyUser } = require("../utils/notifyUser");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const { getAppSettings, serializeAppSettings } = require("../utils/appSettings");
const workspaceRelease = require("../services/workspaceRelease");
const { publishEventSafe } = require("../services/lpcEvents/publishEventService");
const { ensureApprovedUserAuthReady } = require("../utils/authReady");
const { normalizeEmail, sendVerificationEmail } = require("../utils/emailVerification");
const { assertObjectMalwareSafe, malwareScanRequired } = require("../utils/fileSecurity");
const { extractPersonalFileKey } = require("../utils/personalFileReference");
const {
  buildAuthenticatedProfilePhotoUrl,
  buildPublicProfilePhotoUrl,
  extractProfilePhotoKey,
  hasPhotoReference,
  resolveProfilePhotoKey,
} = require("../services/profilePhotoDelivery");
const {
  activatePersonalStorageDeletion,
  cancelPersonalStorageDeletion,
  collectUserPersonalStorageKeys,
  stagePersonalStorageDeletion,
} = require("../services/personalStorageDeletion");

const EMAIL_BASE_URL = (process.env.EMAIL_BASE_URL || "").replace(/\/$/, "");
const ASSET_BASE_URL = EMAIL_BASE_URL || "https://www.lets-paraconnect.com";
const LOGIN_URL = `${ASSET_BASE_URL}/login.html`;
const LINKEDIN_COMPANY_URL = "https://www.linkedin.com/company/lets-paraconnect/";
const ATTORNEY_LAUNCH_EMAIL_SUBJECT = "Explore Matters on LPC";
const ATTORNEY_FIRST_MATTER_EMAIL_SUBJECT = "Post Your First Matter on Let’s-ParaConnect";
const CREATE_CASE_URL = `${ASSET_BASE_URL}/create-case.html`;
const adminS3 = createS3Client();

// -----------------------------------------
// Helpers
// -----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sanitizeCaseForAdmin(caseDoc) {
  if (!caseDoc || typeof caseDoc !== "object") return caseDoc;
  const sanitized = { ...caseDoc };
  if ("files" in sanitized) delete sanitized.files;
  if ("downloadUrl" in sanitized) delete sanitized.downloadUrl;
  if ("filesCount" in sanitized) delete sanitized.filesCount;
  return sanitized;
}

const formatFullName = (u = {}) => {
const joined = `${u.firstName || ""} ${u.lastName || ""}`.trim();
return joined || null;
};

function parsePagination(req, { maxLimit = 100, defaultLimit = 20 } = {}) {
const page = Math.max(1, parseInt(req.query.page, 10) || 1);
const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
const skip = (page - 1) * limit;
return { page, limit, skip };
}

function startOfMonthWindow(months = 12) {
const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
start.setUTCHours(0, 0, 0, 0);
return start;
}

function formatMonthFromGroup(group) {
if (!group?._id) return "";
const { year, month } = group._id;
return `${year}-${String(month).padStart(2, "0")}`;
}

function isObjId(id) {
return mongoose.isValidObjectId(id);
}

function isEmail(value = "") {
return isEmailAddressShape(value);
}

function sanitizeAdminNote(value = "", max = 4000) {
return String(value || "").trim().slice(0, max);
}

function isTypoEmailDomain(value = "") {
return /@[^@\s]+\.con$/i.test(String(value).trim());
}

function toFileViewUrl(value, ownerId, type) {
const key = extractPersonalFileKey(value, {
  ownerId,
  type,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  cdnBase: process.env.CDN_BASE_URL || process.env.S3_PUBLIC_BASE_URL,
});
return key ? `/api/uploads/view?key=${encodeURIComponent(key)}` : "";
}

function buildApprovedCasePipeline(match = {}) {
const baseMatch = Object.assign({}, match);
return [
{ $match: baseMatch },
{ $addFields: { amountForCalc: { $ifNull: ["$lockedTotalAmount", "$totalAmount"] } } },
];
}

function getFinancialReportingStartDate() {
  const raw = String(
    process.env.ADMIN_FINANCIAL_REPORTING_START_AT ||
      process.env.FINANCIAL_REPORTING_START_AT ||
      ""
  ).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function withCreatedAtFloor(match = {}, floor = null) {
  const next = { ...(match || {}) };
  if (!floor) return next;

  const current = next.createdAt;
  if (!current || current instanceof Date) {
    next.createdAt = current ? { $gte: floor, $lte: current } : { $gte: floor };
    return next;
  }

  if (typeof current === "object" && !Array.isArray(current)) {
    next.createdAt = { ...current };
    const existingGte = next.createdAt.$gte;
    if (!existingGte || new Date(existingGte) < floor) {
      next.createdAt.$gte = floor;
    }
    return next;
  }

  next.createdAt = { $gte: floor };
  return next;
}

function pickUserSafe(u) {
// fields safe to return to admin tools
const {
_id, firstName, lastName, email, role, status, bio, about, availability, emailVerified,
pendingEmail, pendingEmailRequestedAt,
lastLoginAt, lockedUntil, failedLogins, audit, createdAt, updatedAt,
specialties, jurisdictions, skills, yearsExperience, paralegalQualification, languages,
avatarURL, timezone, location, state, kycStatus, stripeCustomerId, stripeAccountId,
barNumber, resumeURL, certificateURL, practiceAreas, experience, education,
disabled, deleted, deletedAt, personalDataStatus, personalDataMinimizedAt,
profileImage, pendingProfileImage, profilePhotoStatus, linkedInURL,
} = u;
const approvedPhotoUrl = profileImage || avatarURL
  ? buildAuthenticatedProfilePhotoUrl(u)
  : "";
const pendingPhotoUrl = pendingProfileImage
  ? buildAuthenticatedProfilePhotoUrl(u, { variant: "pending" })
  : "";
return {
id: _id,
firstName,
lastName,
name: formatFullName(u),
email,
role,
status,
bio,
about,
availability,
emailVerified,
pendingEmail,
pendingEmailRequestedAt,
lastLoginAt, lockedUntil, failedLogins, audit, createdAt, updatedAt,
specialties, jurisdictions, skills, yearsExperience, paralegalQualification, languages,
avatarURL: approvedPhotoUrl, timezone, location, state, kycStatus, stripeCustomerId, stripeAccountId,
profileImage: approvedPhotoUrl,
pendingProfileImage: pendingPhotoUrl,
profilePhotoStatus,
barNumber,
linkedInURL,
resumeURL: toFileViewUrl(resumeURL, _id, "resume"),
certificateURL: toFileViewUrl(certificateURL, _id, "certificate"),
practiceAreas,
experience,
education,
disabled,
deleted,
deletedAt,
personalDataStatus,
personalDataMinimizedAt,
};
}

function normalizeUserStatus(value) {
const safe = String(value || "").trim().toLowerCase();
if (!safe) return null;
if (safe === "rejected") return "denied";
if (safe === "suspended") return "denied";
if (["pending", "approved", "denied"].includes(safe)) return safe;
return null;
}

function normalizePhotoStatus(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (!safe) return null;
  if (["unsubmitted", "pending_review", "approved", "rejected"].includes(safe)) return safe;
  return null;
}

function resolvePhotoStatus(user = {}) {
  if (user.pendingProfileImage) return "pending_review";
  const raw = String(user.profilePhotoStatus || "").trim();
  if (raw) return raw;
  return user.profileImage || user.avatarURL ? "approved" : "unsubmitted";
}

function sanitizeNote(note) {
if (!note && note !== 0) return undefined;
const text = String(note).trim();
return text ? text.slice(0, 1000) : undefined;
}

function assertOwnedAdmissionKey(user, value, type, label) {
  const raw = String(value || "").trim();
  const key = extractPersonalFileKey(value, {
    ownerId: user?._id,
    type,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    cdnBase: process.env.CDN_BASE_URL || process.env.S3_PUBLIC_BASE_URL,
  });
  if (raw && !key) {
    const error = new Error(`${label} is not stored in the applicant's protected LPC folder.`);
    error.code = "ADMISSION_FILE_INVALID";
    error.statusCode = 409;
    throw error;
  }
  return key;
}

async function assertAdmissionFilesSafe(user) {
  if (String(user?.role || "").toLowerCase() !== "paralegal") return;
  const resumeKey = assertOwnedAdmissionKey(user, user.resumeURL, "resume", "Résumé");
  if (!resumeKey) {
    const error = new Error("A protected résumé is required before approving this paralegal.");
    error.code = "ADMISSION_FILE_REQUIRED";
    error.statusCode = 409;
    throw error;
  }
  const keys = [
    resumeKey,
    assertOwnedAdmissionKey(user, user.certificateURL, "certificate", "Certificate"),
    assertOwnedAdmissionKey(user, user.writingSampleURL, "writingSample", "Writing sample"),
  ].filter(Boolean);
  if (!malwareScanRequired()) return;
  for (const key of keys) {
    // Every submitted admission artifact must be clean before approval.
    // eslint-disable-next-line no-await-in-loop
    await assertObjectMalwareSafe({ s3: adminS3, bucket: process.env.S3_BUCKET, key });
  }
}

function escapeRegex(value = "") {
return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeEmailHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getAttorneyIdsWithPostedMatters(attorneyIds = []) {
  const normalizedIds = Array.isArray(attorneyIds)
    ? attorneyIds.filter(isObjId).map((id) => new mongoose.Types.ObjectId(String(id)))
    : [];
  const filter = normalizedIds.length ? { attorneyId: { $in: normalizedIds } } : {};
  const rows = await Job.distinct("attorneyId", filter);
  return new Set(rows.filter((id) => isObjId(id)).map((id) => String(id)));
}

function buildUnsubscribeToken(user) {
  if (!user?._id || !process.env.JWT_SECRET) return "";
  const payload = {
    purpose: "unsubscribe",
    uid: String(user._id),
  };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "180d" });
}

function buildApprovalEmailHtml(user) {
  return accountEmails.applicationApproved(user, LOGIN_URL).html;
}

function buildAttorneyApprovalEmailHtml(user) {
  return accountEmails.applicationApproved(user, LOGIN_URL).html;
}

function buildCompleteProfileEmailHtml(user) {
  const profileSettingsUrl = `${ASSET_BASE_URL}/profile-settings.html`;

  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(formatFullName(user) || "there");

  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#f6f5f1;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return letterEmail(`<p>Add your profile photo</p>
<p>Hi ${friendlyName},<br><br>
                Your Let’s-ParaConnect profile is missing a photo.
                Adding a clear, professional photo helps attorneys recognize your profile when reviewing applicants.
                Open Profile Settings to upload one.</p>
<p><a href="${profileSettingsUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 32px;font-family:Georgia, 'Times New Roman', serif;font-size:22px;color:#ffffff;text-decoration:none;">
                      Open Profile Settings
                    </a></p>
<p>If you have any questions, reply to this email and we’ll help you get set up.</p>
<p>Need help?</p>
<p>Email us at <a href="mailto:help@lets-paraconnect.com" style="color:#f6f5f1;text-decoration:none;">help@lets-paraconnect.com</a></p>
<p>${unsubscribeLine}. Required account and Matter notices may still be sent.</p>`);
}

function userHasUploadedProfilePhoto(user = {}) {
  return Boolean(user.profileImage || user.avatarURL);
}

function buildLaunchEmailFooter({
  unsubscribeLine,
  contactUrl,
  privacyUrl,
  linkedinUrl,
} = {}) {
  return `<p>Need help?</p>
<p>Email us at <a href="mailto:help@lets-paraconnect.com" style="color:#545454;text-decoration:none;">help@lets-paraconnect.com</a> or reply to this email.</p>
<p><a href="${contactUrl}" target="_blank" rel="noopener" style="color:#545454;text-decoration:none;">Contact Us</a>
                &nbsp;&nbsp;|&nbsp;&nbsp;
                <a href="${privacyUrl}" target="_blank" rel="noopener" style="color:#545454;text-decoration:none;">Privacy Policy</a></p>
<p>&copy; 2026 Let&rsquo;s-ParaConnect</p>
<p>${unsubscribeLine}. Required account and Matter notices may still be sent.</p><p><a href="${linkedinUrl}">LinkedIn</a></p>`;
}

function buildAttorneyLaunchEmailHtml(user) {
  const loginUrl = LOGIN_URL;

  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return letterEmail(`<p>Explore Matters on LPC</p>
<p>Hi ${friendlyName},<br><br>
                Browse Matters to find work that fits your experience and availability. You choose which Matters to apply to, and attorneys choose whom to hire.</p><p>Check your profile and Stripe Connect payout setup before pursuing work.</p>
<p><a href="${loginUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Log In
                    </a></p>
<p>If you have any questions, reply to this email and we&rsquo;ll help you get set up.</p>`, { footer: `${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
          })}` });
}

function buildAttorneyLaunchSetupEmailHtml(user) {
  const loginUrl = LOGIN_URL;

  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return letterEmail(`<p>Update your paralegal profile</p>
<p>Hi ${friendlyName},<br><br>
                Sign in to add your paralegal profile photo so attorneys can recognize your profile when reviewing applications.</p><p>You can also review your profile details and Stripe Connect payout setup.</p>
<p><a href="${loginUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Log In
                    </a></p>
<p>If you have any questions, reply to this email and we&rsquo;ll help you get set up.</p>`, { footer: `${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
          })}` });
}

function buildAttorneyFirstMatterEmailHtml(user) {
  const createCaseUrl = CREATE_CASE_URL;

  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || formatFullName(user) || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return letterEmail(`<p>Create your first Matter</p>
<div><p style="margin:0 0 18px;">Hi ${friendlyName},</p>
                <p style="margin:0 0 18px;">Have work you’re ready to delegate? Create your first Matter by describing what you need, when you need it, and the compensation.</p>
                <p style="margin:0 0 10px;"><strong>Include:</strong></p>
                <ul style="margin:0 0 18px 20px;padding:0;">
                  <li style="margin:0 0 10px;">A clear scope of work and deadline</li>
                  <li style="margin:0 0 10px;">The practice area and state involved</li>
                  <li style="margin:0;">Compensation for the Matter</li>
                </ul>
                <p style="margin:0 0 18px;">Once your Matter is published, independent paralegals can apply. You review the applications and decide whom to hire.</p>
                <p style="margin:0;">If you need help creating your first Matter, reply to this email and we&rsquo;ll help.</p></div>
<p><a href="${createCaseUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Post Your First Matter
                    </a></p>`, { footer: `${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
          })}` });
}

async function dispatchDecisionEmail(user, status) {
  if (!user?.email) return;
  const message = status === "approved" ? accountEmails.applicationApproved(user, LOGIN_URL)
    : status === "denied" ? accountEmails.applicationDenied(user) : null;
  if (message) return sendEmail(user.email, message.subject, message.html, { text: message.text, throwOnError: true });
}

async function sendDecisionEmailSafe(user, status) {
try {
const result=await dispatchDecisionEmail(user, status);
return result?.disabled?"disabled":result?.accepted?.length?"accepted":"unconfirmed";
} catch (err) {
logger.warn("Account-status email delivery failed.", {
  status: String(status || "unknown").slice(0, 40),
  name: String(err?.name || "Error").slice(0, 80),
  code: String(err?.code || "EMAIL_DELIVERY_FAILED").slice(0, 100),
});
return "unconfirmed";
}
}

async function applyUserDecision(req, user, status, note) {
const normalized = normalizeUserStatus(status);
if (!normalized || normalized === "pending") {
const error = new Error("Invalid status");
error.statusCode = 400;
throw error;
}
const wasApproved = user.status === "approved";
  if (!wasApproved && normalized === "approved") {
    await assertAdmissionFilesSafe(user);
  }
  const previousStatus = String(user.status || "");
  const cleanNote = sanitizeNote(note);
  user.status = normalized;
  if (normalized === "approved") {
    ensureApprovedUserAuthReady(user);
  }
  if (!wasApproved && normalized === "approved" && String(user.role || "").toLowerCase() === "paralegal") {
    user.preferences = {
      ...(typeof user.preferences?.toObject === "function"
        ? user.preferences.toObject()
        : user.preferences || {}),
      hideProfile: true,
    };
  }
if (!Array.isArray(user.audit)) user.audit = [];
user.audit.push({
adminId: req.user?.id || null,
action: normalized === "denied" ? "denied" : "approved",
note: cleanNote,
});
await user.save();

const auditEvent = normalized === "denied" ? "admin.user.denied" : "admin.user.approved";
try {
await AuditLog.logFromReq(req, auditEvent, {
targetType: "user",
targetId: user._id,
meta: { status: normalized, note: cleanNote },
});
} catch (err) {
logger.warn("[admin] Failed to log audit event", err?.message || err);
}

await publishEventSafe({
eventType: "user.approval.decided",
eventFamily: "platform_user",
idempotencyKey: `user:${user._id}:approval:${normalized}:${user.audit.length}`,
correlationId: `user:${user._id}`,
actor: {
actorType: "admin",
userId: req.user?.id || req.user?._id || null,
role: req.user?.role || "admin",
email: req.user?.email || "",
label: req.user?.email || "Admin",
},
subject: {
entityType: "user",
entityId: String(user._id),
},
related: {
userId: user._id,
},
source: {
surface: "admin",
route: `/api/admin/users/${user._id}/${normalized === "approved" ? "approve" : "deny"}`,
service: "admin",
producer: "route",
},
facts: {
summary: `${user.email || "User"} was marked ${normalized}.`,
reason: cleanNote,
before: {
status: previousStatus,
},
after: {
status: normalized,
email: user.email || "",
role: user.role || "",
approvedAt: user.approvedAt || null,
},
},
signals: {
confidence: "high",
priority: "normal",
},
});

const delivery=await sendDecisionEmailSafe(user, normalized);
await AuditLog.logFromReq(req,"admin.user.notification_recorded",{targetType:"user",targetId:user._id,meta:{decision:normalized,delivery}});
return user;
}

// All admin routes are protected & admin-only
router.use(verifyToken, requireApproved, requireRole("admin"));

router.get("/workspace-release", asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ settings: await workspaceRelease.readConfig() });
}));

router.put("/workspace-release", csrfProtection, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ settings: await workspaceRelease.updateConfig(req, req.body) });
}));

router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const settings = await getAppSettings();
    res.json({ settings: serializeAppSettings(settings) });
  })
);

router.put(
  "/settings",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const settings = await getAppSettings();
    const updates = req.body || {};

    if (typeof updates.allowSignups === "boolean") {
      settings.allowSignups = updates.allowSignups;
    }
    if (typeof updates.maintenanceMode === "boolean") {
      settings.maintenanceMode = updates.maintenanceMode;
    }
    if (typeof updates.supportEmail === "string") {
      settings.supportEmail = updates.supportEmail.trim();
    }
    settings.updatedBy = req.user.id;
    await settings.save();

    res.json({ settings: serializeAppSettings(settings) });
  })
);

const ACTIVE_USER_MATCH = {
  status: { $nin: ["denied", "rejected"] },
  disabled: { $ne: true },
  deleted: { $ne: true },
};
const PENDING_USER_MATCH = { status: "pending", deleted: { $ne: true }, disabled: { $ne: true } };

router.get("/metrics", asyncHandler(async (req, res) => {
const ACTIVE_CASE_STATUSES = [
  "open",
  "assigned",
  "active",
  "awaiting_documents",
  "reviewing",
  "in progress",
  "in_progress",
];
res.set("Cache-Control", "private, no-store");
const report = await adminFinancialReport.begin(req, { from: getFinancialReportingStartDate() });

const [roleAggregation, pendingApprovals, recentUsersRaw, monthlyRegistrationsRaw, caseAggregation] =
await Promise.all([
User.aggregate([{ $match: ACTIVE_USER_MATCH }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments(PENDING_USER_MATCH),
User.find(ACTIVE_USER_MATCH)
.sort({ createdAt: -1 })
.limit(10)
.select("firstName lastName email role status createdAt")
.lean(),
User.aggregate([
  { $match: ACTIVE_USER_MATCH },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate(buildApprovedCasePipeline({}).concat([{ $group: { _id: "$status", count: { $sum: 1 } } }])),

]);

const roleMap = roleAggregation.reduce((acc, item) => {
acc[item._id] = item.count;
return acc;
}, {});

const totalUsers = Object.values(roleMap).reduce((sum, value) => sum + value, 0);

let activeCases = 0;
let completedCases = 0;
caseAggregation.forEach((item) => {
if (item._id === "completed") {
completedCases = item.count;
} else if (ACTIVE_CASE_STATUSES.includes(item._id)) {
activeCases += item.count;
}
});

const monthlyRegistrations = monthlyRegistrationsRaw.map((entry) => ({
month: `${entry._id.year}-${String(entry._id.month).padStart(2, "0")}`,
count: entry.count,
}));

const recentUsers = recentUsersRaw.map((user) => ({
id: user._id,
name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "User",
email: user.email || "",
role: user.role || "",
status: user.status || "",
createdAt: user.createdAt,
}));

const escrowHeld = report.value.held.totalAmount;
const totalRevenue = report.value.incomeTotals.totalAmount;
await report.verify();

res.json({
totals: {
totalUsers,
attorneys: roleMap.attorney || 0,
paralegals: roleMap.paralegal || 0,
pendingApprovals,
escrowHeld,
activeCases,
completedCases,
totalRevenue,
},
monthlyRegistrations,
recentUsers,
financial: { ownerId: report.value.ownerId, revision: report.value.revision, held: report.value.held, income: report.value.incomeTotals },
});
}));

router.get(
  "/profile-photos",
  asyncHandler(async (req, res) => {
    const status = normalizePhotoStatus(req.query?.status) || "pending_review";
    const filter = {
      role: { $in: ["paralegal", "attorney"] },
      deleted: { $ne: true },
      status: { $ne: "denied" },
    };
    if (status === "pending_review") {
      filter.pendingProfileImage = { $nin: ["", null] };
    } else if (status === "rejected") {
      filter.profilePhotoStatus = "rejected";
    } else if (status === "approved") {
      filter.profilePhotoStatus = "approved";
      filter.pendingProfileImage = { $in: ["", null] };
      filter.$or = [
        { profileImage: { $nin: ["", null] } },
        { avatarURL: { $nin: ["", null] } },
      ];
    }
    const users = await User.find(filter)
      .select(
        "firstName lastName email role profilePhotoStatus pendingProfileImage profileImage avatarURL createdAt updatedAt " +
        "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
      )
      .sort({ updatedAt: -1 })
      .lean();
    const items = users.map((user) => {
      const approvedUrl = String(user.role || "").toLowerCase() === "paralegal"
        ? buildPublicProfilePhotoUrl(user)
        : buildAuthenticatedProfilePhotoUrl(user);
      return {
        id: user._id,
        name: formatFullName(user) || user.email || "User",
        email: user.email || "",
        status: resolvePhotoStatus(user),
        pendingProfileImage: hasPhotoReference(user, "pending")
          ? buildAuthenticatedProfilePhotoUrl(user, { variant: "pending" })
          : "",
        profileImage: hasPhotoReference(user, "approved") ? approvedUrl : "",
        createdAt: user.createdAt || null,
      };
    });
    res.json({ items });
  })
);

router.post(
  "/profile-photos/:id/approve",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
    const user = await User.findById(id).select(
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    const role = String(user.role || "").toLowerCase();
    if (!["paralegal", "attorney"].includes(role)) {
      return res.status(400).json({ error: "Only attorney or paralegal profile photos can be reviewed here" });
    }
    if (!user.pendingProfileImage) {
      return res.status(400).json({ error: "No pending profile photo to approve" });
    }
    const pendingKey = resolveProfilePhotoKey(user, {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      variant: "pending",
    });
    if (!pendingKey) return res.status(400).json({ error: "Pending profile photo is invalid" });
    const pendingOriginalKey = extractProfilePhotoKey(
      user.pendingProfileImageOriginalKey || user.pendingProfileImageOriginal,
      { bucket: process.env.S3_BUCKET, region: process.env.S3_REGION, ownerId: user._id }
    );
    try {
      await assertObjectMalwareSafe({ s3: adminS3, bucket: process.env.S3_BUCKET, key: pendingKey });
      if (user.pendingProfileImageOriginalKey || user.pendingProfileImageOriginal) {
        if (!pendingOriginalKey) {
          return res.status(400).json({ error: "Pending original profile photo is invalid" });
        }
        await assertObjectMalwareSafe({
          s3: adminS3,
          bucket: process.env.S3_BUCKET,
          key: pendingOriginalKey,
        });
      }
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      throw error;
    }
    const oldApprovedKeys = collectUserPersonalStorageKeys(user).filter(
      (key) =>
        key.startsWith(`profile-photos/${user._id}/`) &&
        key !== pendingKey &&
        key !== pendingOriginalKey
    );
    const storageTaskIds = await stagePersonalStorageDeletion({
      ownerId: user._id,
      keys: oldApprovedKeys,
      reason: "profile_photo_approved_replacement",
    });
    const photoVersion = new Date();
    const approvedUrl = role === "paralegal"
      ? buildPublicProfilePhotoUrl(user, photoVersion)
      : buildAuthenticatedProfilePhotoUrl(user, { updatedAt: photoVersion });
    user.profileImageKey = pendingKey;
    user.profileImage = approvedUrl;
    user.avatarURL = approvedUrl;
    user.profileImageOriginalKey = pendingOriginalKey;
    user.profileImageOriginal = pendingOriginalKey
      ? buildAuthenticatedProfilePhotoUrl(user, {
          variant: "approved-original",
          updatedAt: photoVersion,
        })
      : "";
    user.pendingProfileImage = "";
    user.pendingProfileImageKey = "";
    user.pendingProfileImageOriginal = "";
    user.pendingProfileImageOriginalKey = "";
    user.profilePhotoStatus = "approved";
    if (role === "paralegal") {
      user.preferences = {
        ...(typeof user.preferences?.toObject === "function"
          ? user.preferences.toObject()
          : user.preferences || {}),
        hideProfile: false,
      };
    }
    try {
      await user.save();
    } catch (error) {
      await cancelPersonalStorageDeletion(storageTaskIds).catch(
        logPromiseFailure(logger, "[admin] approved profile photo cleanup rollback failed")
      );
      throw error;
    }
    await activatePersonalStorageDeletion(storageTaskIds).catch((error) => {
      logger.error("[admin] approved profile photo cleanup activation deferred", {
        errorCode: String(error?.name || error?.code || "STORAGE_TASK_TRANSITION_FAILED"),
      });
    });
    try {
      await AuditLog.logFromReq(req, "admin.profile_photo.approved", {
        targetType: "user",
        targetId: user._id,
      });
    } catch (err) {
      logger.warn("[admin] profile photo approval audit failed", err?.message || err);
    }
    try {
      if (role === "paralegal") {
        await notifyUser(user._id, "profile_photo_approved", {}, { actorUserId: req.user.id });
      }
    } catch (err) {
      logger.warn("[admin] notifyUser profile_photo_approved failed", err);
    }
    res.json({ ok: true, user: pickUserSafe(user.toObject()), profilePhotoStatus: user.profilePhotoStatus });
  })
);

router.post(
  "/profile-photos/:id/reject",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
    const user = await User.findById(id).select(
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    const role = String(user.role || "").toLowerCase();
    if (!["paralegal", "attorney"].includes(role)) {
      return res.status(400).json({ error: "Only attorney or paralegal profile photos can be reviewed here" });
    }
    const allPhotoKeys = collectUserPersonalStorageKeys(user).filter((key) =>
      key.startsWith(`profile-photos/${user._id}/`)
    );
    const approvedKeys = [
      resolveProfilePhotoKey(user, {
        bucket: process.env.S3_BUCKET,
        region: process.env.S3_REGION,
        variant: "approved",
      }),
      resolveProfilePhotoKey(user, {
        bucket: process.env.S3_BUCKET,
        region: process.env.S3_REGION,
        variant: "approved-original",
      }),
    ].filter(Boolean);
    const keysToDelete = [];
    if (user.pendingProfileImage) {
      if (role === "attorney") keysToDelete.push(...allPhotoKeys);
      else keysToDelete.push(...allPhotoKeys.filter((key) => !approvedKeys.includes(key)));
      user.pendingProfileImage = "";
      user.pendingProfileImageKey = "";
      user.pendingProfileImageOriginal = "";
      user.pendingProfileImageOriginalKey = "";
      user.profilePhotoStatus = role === "paralegal" && approvedKeys.length ? "approved" : "rejected";
      if (role === "attorney") {
        user.profileImage = null;
        user.profileImageKey = "";
        user.avatarURL = "";
        user.profileImageOriginal = "";
        user.profileImageOriginalKey = "";
      }
    } else if (user.profileImage || user.avatarURL) {
      keysToDelete.push(...allPhotoKeys);
      user.profileImage = null;
      user.profileImageKey = "";
      user.avatarURL = "";
      user.pendingProfileImage = "";
      user.pendingProfileImageKey = "";
      user.profileImageOriginal = "";
      user.profileImageOriginalKey = "";
      user.pendingProfileImageOriginal = "";
      user.pendingProfileImageOriginalKey = "";
      user.profilePhotoStatus = "rejected";
    } else {
      return res.status(400).json({ error: "No profile photo to reject" });
    }
    const storageTaskIds = await stagePersonalStorageDeletion({
      ownerId: user._id,
      keys: [...new Set(keysToDelete)],
      reason: "profile_photo_rejected",
    });
    try {
      await user.save();
    } catch (error) {
      await cancelPersonalStorageDeletion(storageTaskIds).catch(
        logPromiseFailure(logger, "[admin] rejected profile photo cleanup rollback failed")
      );
      throw error;
    }
    await activatePersonalStorageDeletion(storageTaskIds).catch((error) => {
      logger.error("[admin] rejected profile photo cleanup activation deferred", {
        errorCode: String(error?.name || error?.code || "STORAGE_TASK_TRANSITION_FAILED"),
      });
    });
    try {
      await AuditLog.logFromReq(req, "admin.profile_photo.rejected", {
        targetType: "user",
        targetId: user._id,
      });
    } catch (err) {
      logger.warn("[admin] profile photo rejection audit failed", err?.message || err);
    }
    try {
      const profileSettingsUrl = `${ASSET_BASE_URL}/profile-settings.html`;
      await sendProfilePhotoRejectedEmail(user, { profileSettingsUrl });
    } catch (err) {
      logger.warn("[admin] profile photo rejection email failed", err?.message || err);
    }
    try {
      await notifyUser(user._id, "profile_photo_rejected", {}, { actorUserId: req.user.id });
    } catch (err) {
      logger.warn("[admin] notifyUser profile_photo_rejected failed", err);
    }
    res.json({ ok: true, user: pickUserSafe(user.toObject()), profilePhotoStatus: user.profilePhotoStatus });
  })
);

router.post(
"/disable/:id",
csrfProtection,
asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
const user = await User.findById(id).select("+authVersion");
if (!user) return res.status(404).json({ error: "User not found" });
if (String(user._id) === String(req.user?.id)) {
  return res.status(409).json({ error: "You cannot suspend your own active admin session." });
}
user.disabled = true;
user.authVersion = Number(user.authVersion || 0) + 1;
await user.save();
await revokeAllUserSessions(user._id, "admin_suspended");
publishNotificationEvent(user._id, "notifications", {
  at: new Date().toISOString(),
  type: "account_suspended_refresh",
});
const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason : "";
const messageRaw = typeof req.body?.message === "string" ? req.body.message : "";
const reason = reasonRaw.trim().slice(0, 2000);
const message = messageRaw.trim().slice(0, 4000);
if (reason || message) {
  const recipientName = formatFullName(user) || "";
  const payload = {
    message: message || `Your account has been suspended. Reason: ${reason || "Policy review"}.`,
    reason: reason || "Policy review",
    customNote: message || "",
    recipientName,
  };
  try {
    await notifyUser(user._id, "account_suspended", payload, { actorUserId: req.user?.id || null });
  } catch (err) {
    logger.warn("[admin] notifyUser account_suspended failed", err?.message || err);
  }
}
try {
  await AuditLog.logFromReq(req, "admin.user.suspended", {
    targetType: "user",
    targetId: user._id,
    meta: { reasonProvided: Boolean(reason), customMessageProvided: Boolean(message), notificationAttempted: Boolean(reason || message), notification: reason || message ? "Attempted through account notifications; email delivery is not confirmed." : "No account notification requested." },
  });
} catch (err) {
  logger.warn("[admin] Failed to log suspension", err?.message || err);
}
res.json({ ok: true, disabled: true });
})
);

router.post(
"/enable/:id",
csrfProtection,
asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
const user = await User.findById(id).select("+authVersion");
if (!user) return res.status(404).json({ error: "User not found" });
if (user.deleted || user.personalDataStatus === "minimized") {
  return res.status(409).json({ error: "A deactivated or minimized account cannot be re-enabled." });
}
user.disabled = false;
user.authVersion = Number(user.authVersion || 0) + 1;
await user.save();
await revokeAllUserSessions(user._id, "admin_reenabled");
await AuditLog.logFromReq(req,"admin.user.reinstated",{targetType:"user",targetId:user._id,meta:{reason:sanitizeNote(req.body?.reason)}});
res.json({ ok: true, disabled: false });
})
);

router.get(
"/summary",
asyncHandler(async (req, res) => {
const ACTIVE_CASE_STATUSES = [
  "open",
  "assigned",
  "active",
  "awaiting_documents",
  "reviewing",
  "in progress",
  "in_progress",
];
res.set("Cache-Control", "private, no-store");
const report = await adminFinancialReport.begin(req, { from: getFinancialReportingStartDate() });
const [roleAggregation, pendingUsers, caseAggregation] = await Promise.all([
User.aggregate([{ $match: ACTIVE_USER_MATCH }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments(PENDING_USER_MATCH),
Case.aggregate(buildApprovedCasePipeline({}).concat([{ $group: { _id: "$status", count: { $sum: 1 } } }])),

]);

const roleMap = roleAggregation.reduce((acc, item) => {
acc[item._id] = item.count;
return acc;
}, {});
const totalUsers = Object.values(roleMap).reduce((sum, value) => sum + value, 0);

let activeCases = 0;
let completedCases = 0;
caseAggregation.forEach((item) => {
if (item._id === "completed") {
completedCases = item.count;
} else if (ACTIVE_CASE_STATUSES.includes(item._id)) {
activeCases += item.count;
}
});

await report.verify();
res.json({
totalUsers,
pendingUsers,
totalAttorneys: roleMap.attorney || 0,
totalParalegals: roleMap.paralegal || 0,
activeCases,
completedCases,
totalEscrowHold: report.value.held.totalAmount,
totalEscrowReleased: report.value.payoutTotals.totalAmount,
financial: { ownerId: report.value.ownerId, revision: report.value.revision, held: report.value.held, payouts: report.value.payoutTotals },
});
})
);

function financialMonths(rows, from) {
  const selected = rows.filter(row => row.recordedAt && new Date(row.recordedAt) >= from);
  const totals = adminFinancialReport.aggregate(selected, { unknownAffectsTotal: true });
  const available = totals.currencies.length <= 1 && !totals.requiresReview && !rows.some(row => !row.recordedAt && !['failed', 'canceled'].includes(row.state));
  const unit = available && totals.currencies[0] ? { currency: totals.currencies[0].currency, stripeMode: totals.currencies[0].stripeMode } : null;
  const months = new Map();
  if (available) for (const row of selected) {
    if (row.state !== "recorded" || !adminFinancialReport.money(row.amount)) continue;
    const month = row.recordedAt.slice(0, 7);
    months.set(month, (months.get(month) || 0) + row.amount);
    if (!adminFinancialReport.money(months.get(month))) adminFinancialReport.fail(413, "TOTAL_TOO_LARGE");
  }
  return { available, unit, totals, entries: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount })) };
}
router.get("/analytics", asyncHandler(async (req, res) => {
  const startWindow = startOfMonthWindow(12), financialStart = getFinancialReportingStartDate();
  const financeWindowStart = financialStart && financialStart > startWindow ? financialStart : startWindow;
  const activeStatuses = ["open", "assigned", "active", "awaiting_documents", "reviewing", "in progress", "in_progress"];
  res.set("Cache-Control", "private, no-store");
  const report = await adminFinancialReport.begin(req, { from: financialStart }), value = report.value;
  const [roles, pendingApprovals, registrations, posted, completed, practice, statuses, recent] = await Promise.all([
    User.aggregate([{ $match: ACTIVE_USER_MATCH }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
    User.countDocuments(PENDING_USER_MATCH),
    User.aggregate([{ $match: { ...ACTIVE_USER_MATCH, createdAt: { $gte: startWindow } } }, { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } }, { $sort: { "_id.year": 1, "_id.month": 1 } }]),
    Case.aggregate(buildApprovedCasePipeline(withCreatedAtFloor({}, startWindow)).concat([{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } }, { $sort: { "_id.year": 1, "_id.month": 1 } }])),
    Case.aggregate(buildApprovedCasePipeline({ completedAt: { $ne: null, $gte: startWindow } }).concat([{ $group: { _id: { year: { $year: "$completedAt" }, month: { $month: "$completedAt" } }, count: { $sum: 1 } } }, { $sort: { "_id.year": 1, "_id.month": 1 } }])),
    Case.aggregate(buildApprovedCasePipeline({}).concat([{ $group: { _id: "$practiceArea", count: { $sum: 1 } } }, { $sort: { count: -1 } }])),
    Case.aggregate(buildApprovedCasePipeline({}).concat([{ $group: { _id: "$status", count: { $sum: 1 } } }])),
    User.find(ACTIVE_USER_MATCH).sort({ createdAt: -1 }).limit(10).select("firstName lastName email role status createdAt").lean(),
  ]);
  const roleMap = Object.fromEntries(roles.map(row => [row._id, row.count]));
  const userMetrics = { totalUsers: roles.reduce((sum, row) => sum + row.count, 0), totalAttorneys: roleMap.attorney || 0, totalParalegals: roleMap.paralegal || 0, pendingApprovals, registrationsByMonth: registrations.map(row => ({ month: formatMonthFromGroup(row), count: row.count })) };
  const caseMetrics = { jobsPostedByMonth: posted.map(row => ({ month: formatMonthFromGroup(row), count: row.count })), jobsCompletedByMonth: completed.map(row => ({ month: formatMonthFromGroup(row), count: row.count })), casesByPracticeArea: practice.map(row => ({ practiceArea: String(row._id || "Unspecified"), count: row.count })), activeCases: statuses.filter(row => activeStatuses.includes(row._id)).reduce((sum, row) => sum + row.count, 0), completedCases: statuses.filter(row => ["completed", "closed"].includes(row._id)).reduce((sum, row) => sum + row.count, 0) };
  const revenue = financialMonths(value.income, financeWindowStart), funding = financialMonths(value.funding, financeWindowStart), payout = financialMonths(value.payouts, financeWindowStart);
  const months = [...new Set([...funding.entries, ...payout.entries].map(row => row.month))].sort();
  const flowUnits = new Set([funding.unit, payout.unit].filter(Boolean).map(unit => `${unit.currency}:${unit.stripeMode}`));
  const flowAvailable = funding.available && payout.available && flowUnits.size <= 1;
  const escrowTrends = { months, held: months.map(month => funding.entries.find(row => row.month === month)?.amount || 0), released: months.map(month => payout.entries.find(row => row.month === month)?.amount || 0), basis: "recorded_flows", fundingAvailable: funding.available, payoutAvailable: payout.available, chartAvailable: flowAvailable, unit: flowAvailable ? funding.unit || payout.unit : null };
  const escrowMetrics = { totalEscrowHeld: value.held.totalAmount, totalEscrowReleased: value.payoutTotals.totalAmount, escrowInProgress: value.matters.filter(row => row.status === "active").length, pendingPayouts: value.pendingTotals.totalAmount, pendingPayoutCount: value.pending.length, held: value.held, pending: value.pendingTotals, payouts: value.payoutTotals };
  const revenueMetrics = { platformFeesCollected: value.incomeTotals.totalAmount, totalRevenue: value.incomeTotals.totalAmount, platformFeeCount: value.incomeTotals.count, monthlyRevenue: revenue.entries.map(row => ({ month: row.month, revenue: row.amount })), chartAvailable: revenue.available, chartUnit: revenue.unit, ...value.incomeTotals };
  const payoutMetrics = { totalRecorded: value.payoutTotals.totalAmount, ...value.payoutTotals, revision: value.revision, chartAvailable: payout.available };
  const ledger = [...value.funding.map(row => ({ ...row, type: "funding", category: "Matter funding" })), ...value.payouts.map(row => ({ ...row, type: "payout", category: "Paralegal payout" })), ...value.income.map(row => ({ ...row, type: "revenue", category: "Platform fee" }))].sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || "") || a.id.localeCompare(b.id)).slice(0, 40).map(row => ({ ...row, date: row.recordedAt, description: row.title || `Matter ${row.caseId}`, status: row.state === "recorded" ? "Recorded" : row.state }));
  const pendingPayoutQueue = value.pending.slice(0, 5).map(row => ({ caseId: row.caseId, recipient: row.paralegalName || "Name unavailable", matterDeadline: report.source.caseDocs.find(doc => String(doc._id) === row.caseId)?.deadlineDate || null, amount: row.amount, currency: row.currency, stripeMode: row.stripeMode, state: row.state, basis: row.basis }));
  await report.verify();
  res.json({ ownerId: value.ownerId, revision: value.revision, from: value.from, userMetrics, caseMetrics, escrowMetrics, revenueMetrics, payoutMetrics, pendingPayoutQueue, ledger, escrowTrends, fundingMetrics: value.fundingTotals, recentUsers: recent.map(user => ({ id: user._id, name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "User", email: user.email || "", role: user.role || "", status: user.status || "", createdAt: user.createdAt })) });
}));

const listUsersHandler = asyncHandler(async (req, res) => {
const { status = "pending", role, q } = req.query;
const { skip, limit, page } = parsePagination(req, { defaultLimit: 25, maxLimit: 200 });
const audience = String(req.query.audience || "").trim().toLowerCase();

const filter = {};
const rawStatus = String(status || "").trim().toLowerCase();
if (["deleted", "deactivated"].includes(rawStatus)) {
filter.deleted = true;
} else {
if (String(req.query?.includeDeleted || "").toLowerCase() !== "true") {
filter.deleted = { $ne: true };
}
const normalizedStatus = ["all", "suspended"].includes(rawStatus) ? "" : normalizeUserStatus(status);
if(rawStatus === "suspended") filter.disabled = true;
if (normalizedStatus) {
if (normalizedStatus === "denied") {
filter.status = { $in: ["denied", "rejected"] };
} else {
filter.status = normalizedStatus;
}
}
}
if (["attorney", "paralegal", "admin"].includes(role)) filter.role = role;
if (audience === "attorney_no_matter") {
filter.role = "attorney";
filter.status = "approved";
const postedAttorneyIds = await getAttorneyIdsWithPostedMatters();
if (postedAttorneyIds.size) {
  filter._id = {
    $nin: Array.from(postedAttorneyIds).map((id) => new mongoose.Types.ObjectId(id)),
  };
}
}
if (q && q.trim()) {
const rx = new RegExp(q.trim().slice(0,200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
filter.$or = [
{ firstName: rx },
{ lastName: rx },
{ email: rx },
{ specialties: rx },
{ jurisdictions: rx },
];
if (isObjId(q.trim())) filter.$or.push({ _id: q.trim() });
}

const [items, total] = await Promise.all([
User.find(filter).select("-password").sort({ createdAt: req.query.sort === "oldest" ? 1 : -1, _id: req.query.sort === "oldest" ? 1 : -1 }).skip(skip).limit(limit).lean(),
User.countDocuments(filter),
]);

res.json({
page, limit, total, pages: Math.ceil(total / limit),
users: items.map(pickUserSafe),
});
});

/**
* GET /api/admin/pending-users
 * Optional query: ?status=pending|approved|denied&role=attorney|paralegal|admin&q=search&page=&limit=
 * Returns paginated users (password never selected).
 */
router.get("/pending-users", listUsersHandler);
router.get("/users/:id", asyncHandler(async (req,res) => {
  if(!isObjId(req.params.id)) return res.status(400).json({error:"Invalid user ID"});
  const user=await User.findById(req.params.id).select("-password").lean();
  if(!user) return res.status(404).json({error:"User not found"});
  res.json({user:pickUserSafe(user)});
}));
router.get("/users/:id/admission-check",asyncHandler(async(req,res)=>{
 if(!isObjId(req.params.id))return res.status(400).json({error:"Invalid user ID"});
 const user=await User.findById(req.params.id);if(!user)return res.status(404).json({error:"Account not found."});
 try{await assertAdmissionFilesSafe(user);res.json({canApprove:!user.deleted,checkedAt:new Date(),message:user.role==="paralegal"?"Required protected-document checks passed.":"No automated credential verification is performed. Review the applicant’s professional details."});}
 catch(error){res.json({canApprove:false,code:error.code||"DOCUMENT_CHECK_UNAVAILABLE",message:error.message,checkedAt:new Date()});}
}));


/**
* GET /api/admin/audit-logs
* Optional query: ?q=search&role=admin|attorney|paralegal|system&targetType=user|case|payment|message|dispute|document|other&caseId=&actorId=&from=&to=&page=&limit=
*/
router.get("/audit-logs", asyncHandler(async (req, res) => {
const { skip, limit, page } = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
const filter = {};
const q = String(req.query.q || "").trim();
const role = String(req.query.role || "").trim().toLowerCase();
const targetType = String(req.query.targetType || "").trim().toLowerCase();
const action = String(req.query.action || "").trim();
const caseId = req.query.caseId;
const actorId = req.query.actorId;
const from = req.query.from;
const to = req.query.to;

if (role && role !== "all") filter.actorRole = role;
if (targetType && targetType !== "all") filter.targetType = targetType;
if (action) filter.action = new RegExp(escapeRegex(action), "i");
if (caseId && isObjId(caseId)) filter.case = caseId;
if (actorId && isObjId(actorId)) filter.actor = actorId;
if (from || to) {
const createdAt = {};
if (from) {
const fromDate = new Date(from);
if (!Number.isNaN(fromDate.getTime())) createdAt.$gte = fromDate;
}
if (to) {
const toDate = new Date(to);
if (!Number.isNaN(toDate.getTime())) createdAt.$lte = toDate;
}
if (Object.keys(createdAt).length) filter.createdAt = createdAt;
}
if (q) {
const rx = new RegExp(escapeRegex(q), "i");
let actorIds = [];
try {
const matches = await User.find({
$or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
})
  .select("_id")
  .limit(100)
  .lean();
actorIds = matches.map((user) => user._id);
} catch (error) {
logger.warn("[admin] audit-log actor search failed", {
  error: error?.message || String(error),
});
}
const orFilters = [
{ action: rx },
{ path: rx },
{ method: rx },
{ targetId: rx },
{ "meta.reason": rx },
{ "meta.note": rx },
];
if(isObjId(q))orFilters.push({case:q},{actor:q});
if (actorIds.length) {
orFilters.push({ actor: { $in: actorIds } });
}
filter.$or = orFilters;
}

const [items, total] = await Promise.all([
AuditLog.find(filter)
  .sort({ createdAt: -1 })
  .skip(skip)
  .limit(limit)
  .populate("actor", "firstName lastName email role")
  .populate("case", "title")
  .lean(),
AuditLog.countDocuments(filter),
]);

const logs = items.map((entry) => {
const actor = entry.actor || {};
const actorName = [actor.firstName, actor.lastName].filter(Boolean).join(" ") || actor.email || null;
const caseDoc = entry.case || null;
const caseIdValue = caseDoc?._id || entry.case || null;
return {
id: entry._id,
createdAt: entry.createdAt,
action: entry.action,
actorRole: entry.actorRole,
actorId: actor._id || entry.actor || null,
actorName,
actorEmail: actor.email || null,
targetType: entry.targetType,
targetId: entry.targetId,
caseId: caseIdValue,
caseTitle: caseDoc?.title || null,
path: entry.path,
method: entry.method,
meta: entry.meta || {},
ip: entry.ip,
ua: entry.ua,
};
});

res.json({
page,
limit,
total,
pages: Math.ceil(total / limit),
logs,
});
}));

router.patch("/users/:id/role", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
const nextRole = String(req.body?.role || "").trim().toLowerCase();
if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
if (!["attorney", "paralegal"].includes(nextRole)) {
  return res.status(400).json({ error: "Role must be attorney or paralegal" });
}

const user = await User.findById(id);
if (!user) return res.status(404).json({ error: "User not found" });
if (String(user.role || "").toLowerCase() === "admin") {
  return res.status(400).json({ error: "Admin role cannot be changed here" });
}

const currentRole = String(user.role || "").toLowerCase();
if (currentRole === nextRole) {
  return res.json({ ok: true, user: pickUserSafe(user.toObject()) });
}

user.role = nextRole;
await user.save();

try {
  await AuditLog.logFromReq(req, "admin.user.role_changed", {
    targetType: "user",
    targetId: user._id,
    meta: { from: currentRole, to: nextRole },
  });
} catch (err) {
  logger.warn("[admin] Failed to log role change", err?.message || err);
}

res.json({ ok: true, user: pickUserSafe(user.toObject()) });
}));

router.patch("/users/:id/email", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });

const nextEmail = String(req.body?.email || "").trim().toLowerCase();
if (!isEmail(nextEmail)) return res.status(400).json({ msg: "Invalid email address" });
if (isTypoEmailDomain(nextEmail)) {
  return res.status(400).json({ msg: "Email must not end with .con" });
}
if (nextEmail !== normalizeEmail(user.email) && nextEmail !== normalizeEmail(user.pendingEmail)) {
  const exists = await User.countDocuments({
    _id: { $ne: user._id },
    $or: [{ email: nextEmail }, { pendingEmail: nextEmail }],
  });
  if (exists) return res.status(409).json({ msg: "Email already in use" });
  const previousEmail = user.email || "";
  user.pendingEmail = nextEmail;
  user.pendingEmailRequestedAt = new Date();
  await user.save();
  try {
    await sendVerificationEmail({ user, email: user.pendingEmail });
  } catch (err) {
    logger.warn("[admin] pending email verification send failed", err?.message || err);
  }
  try {
    await AuditLog.logFromReq(req, "admin.user.email_changed", {
      targetType: "user",
      targetId: user._id,
      meta: { from: previousEmail, pendingTo: nextEmail },
    });
  } catch (err) {
    logger.warn("[admin] Failed to log email change", err?.message || err);
  }
}
res.json({ ok: true, user: pickUserSafe(user.toObject()) });
}));

router.post("/users/:id/approve", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });
const updated = await applyUserDecision(req, user, "approved", req.body?.note);
res.json({ ok: true, user: pickUserSafe(updated.toObject()) });
}));

router.post("/users/:id/deny", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });
const updated = await applyUserDecision(req, user, "denied", req.body?.note);
res.json({ ok: true, user: pickUserSafe(updated.toObject()) });
}));

// Preview approval email HTML in-browser (admin-only)
router.get("/email/approval-preview", asyncHandler(async (req, res) => {
const { userId, email } = req.query || {};
let user = null;
if (userId && isObjId(userId)) {
  user = await User.findById(userId);
} else if (typeof email === "string" && email.trim()) {
  user = await User.findOne({ email: String(email).toLowerCase().trim() });
}
if (!user) return res.status(404).send("User not found.");
const html = String(user?.role || "").toLowerCase() === "attorney"
  ? buildAttorneyApprovalEmailHtml(user)
  : buildApprovalEmailHtml(user);
res.set("Content-Type", "text/html").send(html);
}));

router.post("/bulk-email", csrfProtection, asyncHandler(async (req, res) => {
const { type, userIds } = req.body || {};
const normalizedType = String(type || "").trim().toLowerCase();
if (!["complete_profile", "attorney_launch", "attorney_launch_setup", "attorney_first_matter"].includes(normalizedType)) {
  return res.status(400).json({ msg: "Invalid email type" });
}
if (!Array.isArray(userIds) || !userIds.length) {
  return res.status(400).json({ msg: "No users selected" });
}
if (userIds.length > 200) {
  return res.status(400).json({ msg: "Bulk email is limited to 200 recipients per send" });
}
const ids = Array.from(new Set(userIds.map((id) => String(id || "").trim())));
if (!ids.length || ids.some((id) => !isObjId(id))) {
  return res.status(400).json({ msg: "One or more user ids are invalid" });
}

const users = await User.find({ _id: { $in: ids } })
  .select("firstName lastName email role status profileImage avatarURL profilePhotoStatus disabled deleted notificationPrefs emailPref")
  .lean();
const emailOpts = {
  throwOnError: true,
};

let sent = 0;
let skipped = Math.max(0, ids.length - users.length);
const failures = [];
const attorneyIdsWithPostedMatters = normalizedType === "attorney_first_matter"
  ? await getAttorneyIdsWithPostedMatters(users.map((user) => user?._id).filter(Boolean))
  : new Set();
for (const user of users) {
  const email = user?.email;
  const isActiveApprovedUser = String(user?.status || "").toLowerCase() === "approved"
    && user?.disabled !== true
    && user?.deleted !== true;
  const allowsNonEssentialEmail = user?.notificationPrefs?.email !== false
    && user?.emailPref?.product !== false
    && (normalizedType === "complete_profile" || user?.emailPref?.marketing !== false);
  if (!email || !isActiveApprovedUser || !allowsNonEssentialEmail) {
    skipped += 1;
    continue;
  }
  if (normalizedType === "complete_profile") {
    const isApprovedParalegal = String(user?.role || "").toLowerCase() === "paralegal";
    if (!isApprovedParalegal || userHasUploadedProfilePhoto(user)) {
      skipped += 1;
      continue;
    }
  }
  if (normalizedType === "attorney_launch" || normalizedType === "attorney_launch_setup") {
    const isApprovedParalegal = String(user?.role || "").toLowerCase() === "paralegal"
      && String(user?.status || "").toLowerCase() === "approved";
    const photoRequirementMet = normalizedType === "attorney_launch"
      ? userHasUploadedProfilePhoto(user)
      : !userHasUploadedProfilePhoto(user);
    if (!isApprovedParalegal || !photoRequirementMet) {
      skipped += 1;
      continue;
    }
  }
  if (normalizedType === "attorney_first_matter") {
    const isApprovedAttorney = String(user?.role || "").toLowerCase() === "attorney"
      && String(user?.status || "").toLowerCase() === "approved";
    const hasPostedMatter = attorneyIdsWithPostedMatters.has(String(user?._id || ""));
    if (!isApprovedAttorney || hasPostedMatter) {
      skipped += 1;
      continue;
    }
  }
  let subject = "";
  let html = "";
  if (normalizedType === "complete_profile") {
    subject = "Add your profile photo on Let’s-ParaConnect";
    html = buildCompleteProfileEmailHtml(user);
  } else if (normalizedType === "attorney_launch") {
    subject = ATTORNEY_LAUNCH_EMAIL_SUBJECT;
    html = buildAttorneyLaunchEmailHtml(user);
  } else if (normalizedType === "attorney_launch_setup") {
    subject = "Update your paralegal profile";
    html = buildAttorneyLaunchSetupEmailHtml(user);
  } else if (normalizedType === "attorney_first_matter") {
    subject = ATTORNEY_FIRST_MATTER_EMAIL_SUBJECT;
    html = buildAttorneyFirstMatterEmailHtml(user);
  }
  try {
    await sendEmail(email, subject, html, emailOpts);
    sent += 1;
  } catch (err) {
    failures.push({ id: user._id, email });
  }
}

try {
  await AuditLog.logFromReq(req, "admin.bulk_email.sent", {
    targetType: "user",
    targetId: null,
    meta: {
      type: normalizedType,
      total: ids.length,
      sent,
      skipped,
      failed: failures.length,
    },
  });
} catch (err) {
  logger.warn("[admin] Failed to log bulk email", err?.message || err);
}

res.json({ ok: true, total: ids.length, sent, skipped, failed: failures.length, failures });
}));

router.post("/users/:id/delete", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });
if (String(user._id) === String(req.user?.id) || ["admin", "director"].includes(String(user.role || "").toLowerCase())) {
  return res.status(409).json({ msg: "Operational accounts require a separately approved offboarding procedure." });
}
if (!user.deleted || !user.disabled) await deactivateUserAccount(user, { now: new Date() });

try {
await AuditLog.logFromReq(req, "admin.user.delete", {
  targetType: "user",
  targetId: user._id,
  meta: { role: user.role || "", outcome: "deactivated" },
});
} catch (auditError) {
  logger.error("[admin] account deactivation audit persistence failed", auditError);
}

res.json({ ok: true, id, mode: "deactivated" });
}));

router.post("/users/:id/purge", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });
if (String(user._id) === String(req.user?.id) || ["admin", "director"].includes(String(user.role || "").toLowerCase())) {
  return res.status(409).json({ msg: "Operational accounts require a separately approved offboarding procedure." });
}
const result = await finalizeAccountDataRemoval(user._id, { now: new Date() });

try {
await AuditLog.logFromReq(req, "admin.user.data_removal.finalized", {
  targetType: "user",
  targetId: id,
  meta: {
    role: user.role || "",
    mode: result.mode,
    retainedRecordTypes: result.retainedRecordTypes,
    storageTaskCount: result.storageTaskCount,
  },
});
} catch (auditError) {
  logger.error("[admin] account deletion audit persistence failed", auditError);
}

res.json({ ok: true, id, ...result });
}));

/**
* GET /api/admin/cases
* Optional query: ?status=&attorney=&paralegal=&q=&page=&limit=
* Returns paginated cases with parties populated (name/email/role/status).
*/
router.get("/cases", asyncHandler(async (req, res) => {
const { status, attorney, paralegal, q } = req.query;
const { skip, limit, page } = parsePagination(req, { defaultLimit: 25 });
if (status !== undefined && (typeof status !== "string" || !CASE_STATUS_ENUM.includes(status)) ||
    attorney !== undefined && (typeof attorney !== "string" || !isObjId(attorney)) ||
    paralegal !== undefined && (typeof paralegal !== "string" || !isObjId(paralegal))) {
  return res.status(400).json({ error: "Choose valid case filters." });
}
if (q !== undefined && (typeof q !== "string" || q.length > 200)) {
  return res.status(400).json({ error: "Choose a valid case search." });
}

const filter = {};
if (status) filter.status = status;
if (attorney && isObjId(attorney)) filter.attorney = attorney;
if (paralegal && isObjId(paralegal)) filter.paralegal = paralegal;
if (q && q.trim()) filter.title = new RegExp(escapeRegex(q.trim()), "i");

const [items, total] = await Promise.all([
Case.find(filter)
.sort({ createdAt: -1 })
.skip(skip).limit(limit)
.select("-files -downloadUrl")
.populate("attorney paralegal", "firstName lastName email role status")
.lean(),
Case.countDocuments(filter),
]);

res.json({
page, limit, total, pages: Math.ceil(total / limit),
cases: items.map(sanitizeCaseForAdmin),
});
}));

router.get("/cases/:id/deletion", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { return res.json({ deletion: await adminMatterDeletion.review(req, req.params.id) }); }
  catch (error) { return res.status(error.status || 503).json({ code: error.publicCode || "ADMIN_MATTER_DELETE_UNAVAILABLE", msg: error.publicCode ? error.message : "The posting could not be verified. Refresh before continuing." }); }
}));

/**
* DELETE /api/admin/cases/:id
* Body: { reason, message }
* Permanently removes only open postings that were never hired or funded.
*/
router.delete("/cases/:id", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid Matter ID" });

const reason = sanitizeAdminNote(req.body?.reason || "", 2000);
const message = sanitizeAdminNote(req.body?.message || "", 4000);
let result;
try {
  result = await adminMatterDeletion.remove(req, id, { reason, message });
} catch (error) {
  if (!error.publicCode) logger.error("[admin] posting deletion could not be confirmed", { caseId: id, error: error.name });
  return res.status(error.status || 503).json({ code: error.publicCode || "ADMIN_MATTER_DELETE_UNCONFIRMED", msg: error.publicCode ? error.message : "Deletion could not be confirmed. Check this posting before trying again." });
}
const doc = result.doc;
const attorneyRef = doc.attorneyId || doc.attorney || null;
const affectedParalegalIds = result.recipients;

if (attorneyRef && (reason || message)) {
  try {
    await notifyUser(
      attorneyRef,
      "case_deleted",
      {
        caseTitle: doc.title || "Untitled Matter",
        reason: reason || "Admin review",
        customNote: message || "",
        message: `Your Matter posting "${doc.title || "Untitled Matter"}" was removed by the platform.`,
      },
      { actorUserId: req.user?.id || req.user?._id || null }
    );
  } catch (err) {
    logger.warn("[admin] notifyUser case_deleted failed", err?.message || err);
  }
}

publishCaseProjectionRefresh(doc, "matter_deleted_refresh", {
  additionalUserIds: [...affectedParalegalIds],
  discovery: true,
});

res.json({ ok: true, caseId: String(doc._id), ownerId: String(req.user.id || req.user._id) });
}));

router.get("/payouts", asyncHandler(async (req, res) => {
res.set('Cache-Control', 'private, no-store');
const value = await adminPayoutProjection.read(req, { from: getFinancialReportingStartDate() });
res.json(value);
}));

function adminFinancialPage(req, value, rows) {
  const page = req.query.page === undefined ? 1 : Number(req.query.page), limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) adminFinancialReport.fail(400, "INVALID");
  if (req.query.revision !== undefined && req.query.revision !== value.revision) adminFinancialReport.fail(409, "CHANGED");
  return { ownerId: value.ownerId, revision: value.revision, page, limit, total: rows.length, pages: Math.ceil(rows.length / limit), items: rows.slice((page - 1) * limit, page * limit) };
}
router.get("/funding-evidence", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const value = await adminFinancialReport.read(req, { from: getFinancialReportingStartDate() });
  const totalsByMode = {}, currencies = [];
  for (const group of value.fundingTotals.currencies) {
    const rows = value.funding.filter(row => row.state === "recorded" && row.currency === group.currency && row.stripeMode === group.stripeMode && (!value.from || row.recordedAt));
    const total = { currency: group.currency, stripeMode: group.stripeMode, count: rows.length, grossAmount: rows.reduce((sum, row) => sum + row.grossAmount, 0), processingFeeAmount: rows.reduce((sum, row) => sum + row.processingFeeAmount, 0), netAmount: rows.reduce((sum, row) => sum + row.netAmount, 0) };
    if (![total.grossAmount, total.processingFeeAmount, total.netAmount].every(adminFinancialReport.money)) adminFinancialReport.fail(413, "TOTAL_TOO_LARGE");
    currencies.push(total);
  }
  for (const providerMode of ["test", "live"]) {
    const groups = currencies.filter(group => group.stripeMode === providerMode);
    if (groups.length) totalsByMode[providerMode] = groups.length === 1 && groups[0].currency === "USD" ? { count: groups[0].count, grossAmount: groups[0].grossAmount, processingFeeAmount: groups[0].processingFeeAmount, netAmount: groups[0].netAmount } : { count: groups.reduce((sum, group) => sum + group.count, 0), grossAmount: null, processingFeeAmount: null, netAmount: null };
  }
  res.json({ ...adminFinancialPage(req, value, value.funding), totalsByMode, currencies, summary: value.fundingTotals, statusCounts: value.fundingTotals.states });
}));

router.get("/chargebacks", asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await require('../services/adminChargebackReport').read(req));
}));

router.post("/chargebacks/:operationId/acknowledge", csrfProtection, asyncHandler(async (req, res) => {
const result = await acknowledgeChargeback(req.params.operationId, req.user.id, { authVersion: Number(req.auth?.payload?.av || 0), sessionId: req.authSessionId || null, ip: req.ip, ua: req.headers["user-agent"] });
if (!result.found) return res.status(404).json({ msg: "Chargeback record not found." });
return res.json({ ok: true, changed: result.changed, administrativeStatus: result.operation.administrativeStatus });
}));

router.post("/chargebacks/:operationId/clear-hold", csrfProtection, asyncHandler(async (req, res) => {
const result = await clearEligiblePayoutHold(req.params.operationId, req.user.id, { authVersion: Number(req.auth?.payload?.av || 0), sessionId: req.authSessionId || null, ip: req.ip, ua: req.headers["user-agent"] });
if (!result.found) return res.status(404).json({ msg: "Chargeback record not found." });
return res.json({ ok: true, changed: result.changed, administrativeStatus: result.operation.administrativeStatus });
}));

router.post("/chargebacks/:operationId/reconcile", csrfProtection, asyncHandler(async (req, res) => {
const stripe = require("../utils/stripe");
if (!/^[a-f0-9]{24}$/i.test(req.params.operationId)) return res.status(400).json({ msg: "Invalid chargeback." });
const operation = await PaymentOperation.findOne({ _id: req.params.operationId, kind: "chargeback" });
if (!operation) return res.status(404).json({ msg: "Chargeback record not found." });
if (!operation.stripeDisputeId || !operation.stripeEventId) {
  return res.status(409).json({ msg: "Chargeback evidence is incomplete and cannot be reconciled automatically." });
}
const result = await recordChargebackEvent({
  stripeClient: stripe,
  reconciliation: { operationId: String(operation._id), actorId: req.user.id, authVersion: Number(req.auth?.payload?.av || 0), sessionId: req.authSessionId || null },
  ip: req.ip,
  ua: req.headers["user-agent"],
});
return res.json({ ok: true, evidenceStatus: result.operation?.evidenceStatus || "needs_review" });
}));

router.get("/income", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const value = await adminFinancialReport.read(req, { from: getFinancialReportingStartDate() });
  res.json({ ...adminFinancialPage(req, value, value.income), ...value.incomeTotals });
}));

// -----------------------------------------
// Fallback error handler (keeps admin routes tidy)
// -----------------------------------------
router.use((err, _req, res, _next) => {
if (respondToCsrfError(err, res, { field: "msg" })) return;
logger.error(err);
const status = Number(err?.statusCode) >= 400 && Number(err?.statusCode) < 600 ? Number(err.statusCode) : 500;
res.status(status).json({
  msg: status < 500 ? err.message : "Server error",
  ...(err?.code ? { code: err.code } : {}),
});
});

module.exports = router;
