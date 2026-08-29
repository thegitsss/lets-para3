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
const Job = require("../models/Job");
const Application = require("../models/Application");
const AuditLog = require("../models/AuditLog");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const logger = createLogger("admin");
const {
  deactivateUserAccount,
  finalizeAccountDataRemoval,
} = require("../services/userDeletion");
const { revokeAllUserSessions } = require("../services/authSessionService");
const sendEmail = require("../utils/email");
const { sendProfilePhotoRejectedEmail } = sendEmail;
const { notifyUser } = require("../utils/notifyUser");
const { getAppSettings, serializeAppSettings } = require("../utils/appSettings");
const { publishEventSafe } = require("../services/lpcEvents/publishEventService");
const { ensureApprovedUserAuthReady } = require("../utils/authReady");
const { resolveMatterDeadlineDate } = require("../utils/businessDate");
const { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT } = require("../services/platformFeePolicy");
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
const ATTORNEY_DASHBOARD_URL = `${ASSET_BASE_URL}/dashboard-attorney.html`;
const LINKEDIN_COMPANY_URL = "https://www.linkedin.com/company/lets-paraconnect/";
const APPROVAL_EMAIL_SUBJECT =
"Welcome to Let’s-ParaConnect";
const ATTORNEY_APPROVAL_EMAIL_SUBJECT =
"Welcome to Let’s-ParaConnect";
const DENIAL_EMAIL_SUBJECT =
"Your application to join Let's-ParaConnect has been reviewed and was unfortunately not approved.";
const ATTORNEY_LAUNCH_EMAIL_SUBJECT = "Attorney Access Is Now Open";
const ATTORNEY_FIRST_MATTER_EMAIL_SUBJECT = "Post Your First Matter on Let’s-ParaConnect";
const PLATFORM_FEE_PARALEGAL_PERCENT = DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
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
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).toLowerCase());
}

function sanitizeAdminNote(value = "", max = 4000) {
return String(value || "").trim().slice(0, max);
}

function isTypoEmailDomain(value = "") {
return /@[^@\s]+\.con$/i.test(String(value).trim());
}

const CASE_AMOUNT_EXPR = { $ifNull: ["$lockedTotalAmount", "$totalAmount"] };
const CASE_PARALEGAL_PCT_EXPR = { $ifNull: ["$feeParalegalPct", PLATFORM_FEE_PARALEGAL_PERCENT] };
const CASE_PARALEGAL_FEE_EXPR = {
$ifNull: [
"$feeParalegalAmount",
{
$floor: {
$add: [
{ $multiply: [CASE_AMOUNT_EXPR, { $divide: [CASE_PARALEGAL_PCT_EXPR, 100] }] },
0.5,
],
},
},
],
};
const CASE_PAYOUT_EXPR = { $max: [0, { $subtract: [CASE_AMOUNT_EXPR, CASE_PARALEGAL_FEE_EXPR] }] };

function resolveParalegalFeePct(doc = {}) {
return typeof doc.feeParalegalPct === "number" && Number.isFinite(doc.feeParalegalPct)
? doc.feeParalegalPct
: PLATFORM_FEE_PARALEGAL_PERCENT;
}

function computeParalegalFeeAmount(baseAmount, doc = {}) {
if (Number.isFinite(doc.feeParalegalAmount) && doc.feeParalegalAmount >= 0) {
return doc.feeParalegalAmount;
}
const base = Number(baseAmount || 0);
if (!Number.isFinite(base) || base <= 0) return 0;
return Math.max(0, Math.round(base * (resolveParalegalFeePct(doc) / 100)));
}

function computeParalegalPayoutAmount(baseAmount, doc = {}) {
const base = Number(baseAmount || 0);
if (!Number.isFinite(base) || base <= 0) return 0;
const fee = computeParalegalFeeAmount(base, doc);
return Math.max(0, base - fee);
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
specialties, jurisdictions, skills, yearsExperience, languages,
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
specialties, jurisdictions, skills, yearsExperience, languages,
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

function buildApprovalEmailHtml(user, opts = {}) {
  const loginUrl = LOGIN_URL;
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";

  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#f6f5f1;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:34px;letter-spacing:0.06em;color:#6e6e6e;">
                Welcome to Let’s-ParaConnect
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 32px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:16px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.7;">
                Hi ${escapeEmailHtml(user?.firstName || "there")},
                <br><br>
                Thank you for applying to join Let’s-ParaConnect.
                <br><br>
                Your application has been reviewed and approved. At this time, we’re onboarding a limited number of paralegals as we open the platform carefully and maintain a high standard across the network.
                <br><br>
                You now have access to complete your profile and explore the platform. You can browse available Matters as attorneys post them.
                <br><br>
                We’re glad to have you as part of the community.
                <br><br>
                —<br>
                Let’s-ParaConnect
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${loginUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 32px;font-family:Georgia, 'Times New Roman', serif;font-size:22px;color:#ffffff;text-decoration:none;">
                      Login
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td height="1" style="background:#bfc3c8;line-height:1px;font-size:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;letter-spacing:0.06em;color:#545454;line-height:1.6;">
                Let's-ParaConnect was built to create a more reliable way for attorneys and paralegals to work together.
                Approval-based access, structured Matter workspaces, and Stripe-processed payments help set clear
                expectations for both sides.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 32px;background:#ffffff;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:20px;color:#1f1f1f;letter-spacing:-0.01em;">
                Need help?
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;color:#545454;line-height:1.4;margin-top:8px;">
                Email us at <a href="mailto:help@lets-paraconnect.com" style="color:#545454;text-decoration:none;">help@lets-paraconnect.com</a> or reply to this email.
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:12px;color:#7a7a7a;line-height:1.4;margin-top:14px;">
                ${unsubscribeLine}. Required account and Matter notices may still be sent.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
}

function buildAttorneyApprovalEmailHtml(user, opts = {}) {
  const dashboardUrl = ATTORNEY_DASHBOARD_URL;
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || formatFullName(user) || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:34px;letter-spacing:0.02em;color:#6e6e6e;">
                Welcome to Let&rsquo;s-ParaConnect
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:16px;letter-spacing:0.01em;color:#1f1f1f;line-height:1.7;text-align:left;">
                <p style="margin:0 0 18px;">Dear ${friendlyName},</p>
                <p style="margin:0 0 18px;">Congratulations! We are pleased to inform you that you have been accepted to Let&rsquo;s-ParaConnect.</p>
                <p style="margin:0 0 18px;">LPC is a platform designed for attorneys and independent paralegals to connect through structured, project-based work. Through LPC, you can review approved paralegal profiles, collaborate in a Matter workspace, and manage legal-support work such as preparation, drafting, research, or administrative assistance.</p>
                <p style="margin:0 0 10px;"><strong>What You Can Use LPC For:</strong></p>
                <ul style="margin:0 0 18px 20px;padding:0;">
                  <li style="margin:0 0 10px;">Reviewing approved paralegal profiles</li>
                  <li style="margin:0 0 10px;">Delegating legal research, drafting, and Matter support tasks</li>
                  <li style="margin:0 0 10px;">Managing workflows and improving operational efficiency</li>
                  <li style="margin:0;">Scaling your practice with flexible, on-demand support</li>
                </ul>
                <p style="margin:0 0 10px;"><strong>Next Steps:</strong></p>
                <ul style="margin:0 0 18px 20px;padding:0;">
                  <li style="margin:0 0 10px;">Log in to your account using the credentials you provided during sign-up.</li>
                  <li style="margin:0 0 10px;">Complete your profile.</li>
                  <li style="margin:0 0 10px;">Explore available paralegal professionals.</li>
                  <li style="margin:0;">Post your first Matter.</li>
                </ul>
                <p style="margin:0 0 18px;">The goal is to help you organize project-based support work and stay focused on your clients.</p>
                <p style="margin:0 0 18px;">If you have any questions or need assistance getting started, please don&rsquo;t hesitate to contact us.</p>
                <p style="margin:0 0 18px;">Welcome aboard&mdash;we&rsquo;re excited to have you as part of the platform.</p>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${dashboardUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Go to Your Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 40px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:16px;letter-spacing:0.01em;color:#1f1f1f;line-height:1.7;text-align:left;">
                Warm regards,<br>
                The Let’s-ParaConnect Team
              </div>
            </td>
          </tr>
          ${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
            backgroundColor: "#f5f7fb",
          })}
        </table>
      </td>
    </tr>
  </table>
  `;
}

function buildDenialEmailHtml(user, opts = {}) {
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(formatFullName(user) || "there");

  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#f6f5f1;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:30px;letter-spacing:0.04em;color:#6e6e6e;">
                Application update
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.6;">
                Hi ${friendlyName},<br><br>
                Thank you for your interest in joining Let's-ParaConnect.<br><br>
                Your application has been reviewed and was not approved at this time. Currently, we are only accepting
                paralegals who have a minimum of one year of professional paralegal experience and who are based in the
                United States.<br><br>
                Our team reviews every submission carefully, and if you believe we may have missed important
                information in your application, you're welcome to reply to this email.<br><br>
                Thank you again for your interest in the community.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 32px;background:#ffffff;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:20px;color:#1f1f1f;letter-spacing:-0.01em;">
                Need help?
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;color:#545454;line-height:1.4;margin-top:8px;">
                Email us at <a href="mailto:help@lets-paraconnect.com" style="color:#545454;text-decoration:none;">help@lets-paraconnect.com</a> or reply to this email.
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:12px;color:#7a7a7a;line-height:1.4;margin-top:14px;">
                ${unsubscribeLine}. Required account and Matter notices may still be sent.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
}

function buildCompleteProfileEmailHtml(user, opts = {}) {
  const profileSettingsUrl = `${ASSET_BASE_URL}/profile-settings.html`;
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(formatFullName(user) || "there");

  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#f6f5f1;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:30px;letter-spacing:0.04em;color:#6e6e6e;">
                Add your profile photo
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.6;">
                Hi ${friendlyName},<br><br>
                Your Let’s-ParaConnect profile is missing a photo.
                Adding a clear, professional photo helps attorneys recognize your profile when reviewing applicants.
                Open Profile Settings to upload one.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${profileSettingsUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 32px;font-family:Georgia, 'Times New Roman', serif;font-size:22px;color:#ffffff;text-decoration:none;">
                      Open Profile Settings
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td height="1" style="background:#bfc3c8;line-height:1px;font-size:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;letter-spacing:0.06em;color:#545454;line-height:1.6;">
                If you have any questions, reply to this email and we’ll help you get set up.
              </div>
            </td>
          </tr>
          <tr>
            <td bgcolor="#070300" style="padding:26px 32px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:20px;color:#f6f5f1;letter-spacing:-0.01em;">
                Need help?
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;color:#f6f5f1;line-height:1.4;margin-top:8px;">
                Email us at <a href="mailto:help@lets-paraconnect.com" style="color:#f6f5f1;text-decoration:none;">help@lets-paraconnect.com</a>
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:12px;color:#bfc3c8;line-height:1.4;margin-top:14px;">
                ${unsubscribeLine}. Required account and Matter notices may still be sent.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
}

function userHasUploadedProfilePhoto(user = {}) {
  return Boolean(user.profileImage || user.avatarURL);
}

function buildLaunchEmailFooter({
  unsubscribeLine,
  contactUrl,
  privacyUrl,
  linkedinUrl,
  linkedinIconUrl = `${ASSET_BASE_URL}/assets/email/linkedin-icon.svg`,
  backgroundColor = "#ffffff",
} = {}) {
  return `
          <tr>
            <td style="padding:26px 32px;background:${backgroundColor};">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:20px;color:#1f1f1f;letter-spacing:-0.01em;">
                Need help?
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;color:#545454;line-height:1.4;margin-top:8px;">
                Email us at <a href="mailto:help@lets-paraconnect.com" style="color:#545454;text-decoration:none;">help@lets-paraconnect.com</a> or reply to this email.
              </div>
              <table cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
                <tr>
                  <td>
                    <a href="${linkedinUrl}" target="_blank" rel="noopener" aria-label="LinkedIn" style="display:inline-block;text-decoration:none;">
                      <img src="${linkedinIconUrl}" alt="LinkedIn" width="18" height="18" style="display:block;border:0;width:18px;height:18px;">
                    </a>
                  </td>
                </tr>
              </table>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;color:#545454;line-height:1.4;margin-top:12px;">
                <a href="${contactUrl}" target="_blank" rel="noopener" style="color:#545454;text-decoration:none;">Contact Us</a>
                &nbsp;&nbsp;|&nbsp;&nbsp;
                <a href="${privacyUrl}" target="_blank" rel="noopener" style="color:#545454;text-decoration:none;">Privacy Policy</a>
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:12px;color:#7a7a7a;line-height:1.4;margin-top:10px;">
                &copy; 2026 Let&rsquo;s-ParaConnect
              </div>
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:12px;color:#7a7a7a;line-height:1.4;margin-top:14px;">
                ${unsubscribeLine}. Required account and Matter notices may still be sent.
              </div>
            </td>
          </tr>
  `;
}

function buildAttorneyLaunchEmailHtml(user, opts = {}) {
  const loginUrl = LOGIN_URL;
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:30px;letter-spacing:0.04em;color:#6e6e6e;">
                Attorney access is now open
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.6;text-align:left;">
                Hi ${friendlyName},<br><br>
                Attorney access is now open. Make sure your paralegal profile is ready for paid Matters by completing Stripe Connect payout setup under Profile Settings &gt; Security. Attorneys can now use LPC to find and hire approved paralegals for project-based work.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${loginUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Log In
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td height="1" style="background:#bfc3c8;line-height:1px;font-size:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;letter-spacing:0.06em;color:#545454;line-height:1.6;">
                If you have any questions, reply to this email and we&rsquo;ll help you get set up.
              </div>
            </td>
          </tr>
          ${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
          })}
        </table>
      </td>
    </tr>
  </table>
  `;
}

function buildAttorneyLaunchSetupEmailHtml(user, opts = {}) {
  const loginUrl = LOGIN_URL;
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:30px;letter-spacing:0.04em;color:#6e6e6e;">
                Attorney access is now open
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.6;text-align:left;">
                Hi ${friendlyName},<br><br>
                Attorney access is now open. Please log in to add your paralegal profile photo and complete Stripe Connect payout setup under Profile Settings &gt; Security so attorneys can evaluate your experience and you are ready to receive payouts for paid Matters.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${loginUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Log In
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td height="1" style="background:#bfc3c8;line-height:1px;font-size:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;letter-spacing:0.06em;color:#545454;line-height:1.6;">
                If you have any questions, reply to this email and we&rsquo;ll help you get set up.
              </div>
            </td>
          </tr>
          ${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
          })}
        </table>
      </td>
    </tr>
  </table>
  `;
}

function buildAttorneyFirstMatterEmailHtml(user, opts = {}) {
  const createCaseUrl = CREATE_CASE_URL;
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const contactUrl = `${ASSET_BASE_URL}/contact.html`;
  const privacyUrl = `${ASSET_BASE_URL}/privacy.html`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const friendlyName = escapeEmailHtml(user?.firstName || formatFullName(user) || "there");
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from non-essential emails</a>`
    : "Unsubscribe from non-essential emails";

  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:24px 24px 8px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;">
                    <img src="${logoUrl}" alt="Let's-ParaConnect" width="42" height="42" style="display:block;border:0;width:42px;height:42px;">
                  </td>
                  <td style="font-family:Georgia, 'Times New Roman', serif;font-size:28px;letter-spacing:0.04em;color:#0e1b10;">
                    Let's-ParaConnect
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:30px;letter-spacing:0.04em;color:#6e6e6e;">
                Post your first matter
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.6;text-align:left;">
                <p style="margin:0 0 18px;">Hi ${friendlyName},</p>
                <p style="margin:0 0 18px;">Your Let&rsquo;s-ParaConnect account is ready. If you have not posted your first matter yet, this is a good time to get one live and start receiving interest from approved paralegals.</p>
                <p style="margin:0 0 10px;"><strong>A simple first post can include:</strong></p>
                <ul style="margin:0 0 18px 20px;padding:0;">
                  <li style="margin:0 0 10px;">A clear scope of work and deadline</li>
                  <li style="margin:0 0 10px;">The practice area and state involved</li>
                  <li style="margin:0;">Compensation for the matter</li>
                </ul>
                <p style="margin:0 0 18px;">Once your matter is posted, approved paralegals can review it and apply directly through the platform.</p>
                <p style="margin:0;">If you need help getting your first matter set up, reply to this email and we&rsquo;ll help.</p>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${createCaseUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-family:Georgia, 'Times New Roman', serif;font-size:20px;color:#ffffff;text-decoration:none;">
                      Post Your First Matter
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${buildLaunchEmailFooter({
            unsubscribeLine,
            contactUrl,
            privacyUrl,
            linkedinUrl: LINKEDIN_COMPANY_URL,
          })}
        </table>
      </td>
    </tr>
  </table>
  `;
}

async function dispatchDecisionEmail(user, status) {
if (!user?.email) return;
const role = String(user?.role || "").toLowerCase();
if (status === "approved") {
const subject = role === "attorney" ? ATTORNEY_APPROVAL_EMAIL_SUBJECT : APPROVAL_EMAIL_SUBJECT;
const html = role === "attorney"
  ? buildAttorneyApprovalEmailHtml(user)
  : buildApprovalEmailHtml(user);
await sendEmail(user.email, subject, html);
return;
}
if (status === "denied") {
const html = buildDenialEmailHtml(user);
await sendEmail(user.email, DENIAL_EMAIL_SUBJECT, html);
}
}

async function sendDecisionEmailSafe(user, status) {
try {
await dispatchDecisionEmail(user, status);
} catch (err) {
logger.warn("Account-status email delivery failed.", {
  status: String(status || "unknown").slice(0, 40),
  name: String(err?.name || "Error").slice(0, 80),
  code: String(err?.code || "EMAIL_DELIVERY_FAILED").slice(0, 100),
});
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

await sendDecisionEmailSafe(user, normalized);
return user;
}

// All admin routes are protected & admin-only
router.use(verifyToken, requireApproved, requireRole("admin"));

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

router.get("/metrics", asyncHandler(async (_req, res) => {
const ACTIVE_CASE_STATUSES = [
  "open",
  "assigned",
  "active",
  "awaiting_documents",
  "reviewing",
  "in progress",
  "in_progress",
];
const financialStart = getFinancialReportingStartDate();

const [roleAggregation, pendingApprovals, recentUsersRaw, monthlyRegistrationsRaw, caseAggregation, escrowAggregation, revenueAggregation] =
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
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({ paymentReleased: { $ne: true } }, financialStart)).concat([{ $group: { _id: null, total: { $sum: "$totalAmount" } } }])
),
PlatformIncome.aggregate([{ $match: withCreatedAtFloor({}, financialStart) }, { $group: { _id: null, total: { $sum: "$feeAmount" }, count: { $sum: 1 } } }]),
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

const escrowHeld = escrowAggregation[0]?.total || 0;
const totalRevenue = revenueAggregation[0]?.total || 0;

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
    meta: { reasonProvided: Boolean(reason), customMessageProvided: Boolean(message) },
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
res.json({ ok: true, disabled: false });
})
);

router.get(
"/summary",
asyncHandler(async (_req, res) => {
const ACTIVE_CASE_STATUSES = [
  "open",
  "assigned",
  "active",
  "awaiting_documents",
  "reviewing",
  "in progress",
  "in_progress",
];
const financialStart = getFinancialReportingStartDate();
const [roleAggregation, pendingUsers, caseAggregation, escrowHeldAgg, escrowReleasedAgg] = await Promise.all([
User.aggregate([{ $match: ACTIVE_USER_MATCH }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments(PENDING_USER_MATCH),
Case.aggregate(buildApprovedCasePipeline({}).concat([{ $group: { _id: "$status", count: { $sum: 1 } } }])),
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({ paymentReleased: { $ne: true } }, financialStart)).concat([
    { $group: { _id: null, total: { $sum: CASE_AMOUNT_EXPR } } },
  ])
),
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({ paymentReleased: true }, financialStart)).concat([
    { $group: { _id: null, total: { $sum: CASE_AMOUNT_EXPR } } },
  ])
),
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

res.json({
totalUsers,
pendingUsers,
totalAttorneys: roleMap.attorney || 0,
totalParalegals: roleMap.paralegal || 0,
activeCases,
completedCases,
totalEscrowHold: escrowHeldAgg[0]?.total || 0,
totalEscrowReleased: escrowReleasedAgg[0]?.total || 0,
});
})
);

router.get(
"/analytics",
asyncHandler(async (_req, res) => {
const MONTHS_WINDOW = 12;
const startWindow = startOfMonthWindow(MONTHS_WINDOW);
const financialStart = getFinancialReportingStartDate();
const financeWindowStart = financialStart && financialStart > startWindow ? financialStart : startWindow;
const ACTIVE_CASE_STATUSES = [
  "open",
  "assigned",
  "active",
  "awaiting_documents",
  "reviewing",
  "in progress",
  "in_progress",
];
const COMPLETED_CASE_STATUSES = ["completed", "closed"];
const LEDGER_LIMIT = 20;

const [
roleAggregation,
pendingApprovalsCount,
registrationsAgg,
escrowHeldAgg,
escrowReleasedAgg,
      escrowHeldByMonthAgg,
      escrowReleasedByMonthAgg,
platformFeeAgg,
monthlyFeesAgg,
jobsPostedAgg,
jobsCompletedAgg,
practiceAgg,
escrowInProgressCount,
pendingPayoutAgg,
payoutTotalsAgg,
caseStatusAgg,
caseLedgerDocs,
payoutLedgerDocs,
feeLedgerDocs,
pendingPayoutCases,
recentUsersRaw,
] = await Promise.all([
User.aggregate([{ $match: ACTIVE_USER_MATCH }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments(PENDING_USER_MATCH),
User.aggregate([
{ $match: { ...ACTIVE_USER_MATCH, createdAt: { $gte: startWindow } } },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({ paymentReleased: { $ne: true } }, financialStart)).concat([
    { $group: { _id: null, total: { $sum: CASE_AMOUNT_EXPR } } },
  ])
),
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({ paymentReleased: true }, financialStart)).concat([
    { $group: { _id: null, total: { $sum: CASE_AMOUNT_EXPR } } },
  ])
),
      Case.aggregate(
        buildApprovedCasePipeline(withCreatedAtFloor({
          paymentReleased: { $ne: true },
          amountForCalc: { $gt: 0 },
        }, financeWindowStart)).concat([
          {
            $group: {
              _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
              total: { $sum: CASE_AMOUNT_EXPR },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ])
      ),
      Payout.aggregate([
        { $match: withCreatedAtFloor({}, financeWindowStart) },
        {
          $group: {
            _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
            total: { $sum: "$amountPaid" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
PlatformIncome.aggregate([{ $match: withCreatedAtFloor({}, financialStart) }, { $group: { _id: null, total: { $sum: "$feeAmount" }, count: { $sum: 1 } } }]),
PlatformIncome.aggregate([
{ $match: withCreatedAtFloor({}, financeWindowStart) },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, revenue: { $sum: "$feeAmount" } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({}, financeWindowStart)).concat([
    { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ])
),
Case.aggregate(
  buildApprovedCasePipeline({ completedAt: { $ne: null, $gte: startWindow } }).concat([
    { $group: { _id: { year: { $year: "$completedAt" }, month: { $month: "$completedAt" } }, count: { $sum: 1 } } },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ])
),
Case.aggregate(
  buildApprovedCasePipeline({}).concat([
    { $group: { _id: "$practiceArea", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ])
),
Case.aggregate(
  buildApprovedCasePipeline({ paymentReleased: { $ne: true }, status: { $in: ACTIVE_CASE_STATUSES } }).concat([{ $count: "count" }])
),
Case.aggregate(
  buildApprovedCasePipeline(withCreatedAtFloor({ paymentReleased: { $ne: true }, status: { $in: COMPLETED_CASE_STATUSES } }, financialStart)).concat([
    { $group: { _id: null, total: { $sum: CASE_PAYOUT_EXPR }, count: { $sum: 1 } } },
  ])
),
Payout.aggregate([{ $match: withCreatedAtFloor({}, financialStart) }, { $group: { _id: null, total: { $sum: "$amountPaid" }, count: { $sum: 1 } } }]),
Case.aggregate(buildApprovedCasePipeline({}).concat([{ $group: { _id: "$status", count: { $sum: 1 } } }])),
Case.find(withCreatedAtFloor({ $or: [{ lockedTotalAmount: { $gt: 0 } }, { totalAmount: { $gt: 0 } }] }, financialStart))
.sort({ createdAt: -1 })
.limit(LEDGER_LIMIT)
.select("title practiceArea totalAmount lockedTotalAmount paymentStatus paymentReleased createdAt")
.lean(),
Payout.find(withCreatedAtFloor({}, financialStart))
.sort({ createdAt: -1 })
.limit(LEDGER_LIMIT)
.select("caseId amountPaid transferId createdAt")
.lean(),
PlatformIncome.find(withCreatedAtFloor({}, financialStart))
.sort({ createdAt: -1 })
.limit(LEDGER_LIMIT)
.select("caseId feeAmount createdAt")
.lean(),
Case.find(withCreatedAtFloor({
  paymentReleased: { $ne: true },
  status: { $in: COMPLETED_CASE_STATUSES },
  $and: [
    { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
    { $or: [{ lockedTotalAmount: { $gt: 0 } }, { totalAmount: { $gt: 0 } }] },
  ],
}, financialStart))
.sort({ deadline: 1, createdAt: 1 })
.limit(5)
.select("deadline deadlineDate totalAmount lockedTotalAmount feeParalegalAmount feeParalegalPct paralegalNameSnapshot paralegal paralegalId createdAt")
.populate("paralegal", "firstName lastName")
.populate("paralegalId", "firstName lastName")
.lean(),
User.find()
.sort({ createdAt: -1 })
.limit(10)
.select("firstName lastName email role status createdAt")
.lean(),
]);

const roleMap = roleAggregation.reduce((acc, entry) => {
if (entry?._id) acc[entry._id] = entry.count;
return acc;
}, {});
const totalUsers = Object.values(roleMap).reduce((sum, value) => sum + value, 0);
const pendingApprovals = Number(pendingApprovalsCount) || 0;
const registrationsByMonth = registrationsAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
count: entry.count,
}));

const userMetrics = {
totalUsers,
totalAttorneys: roleMap.attorney || 0,
totalParalegals: roleMap.paralegal || 0,
pendingApprovals,
registrationsByMonth,
};

    const heldByMonth = escrowHeldByMonthAgg.map((entry) => ({
      month: formatMonthFromGroup(entry),
      total: entry.total || 0,
    }));
    const releasedByMonth = escrowReleasedByMonthAgg.map((entry) => ({
      month: formatMonthFromGroup(entry),
      total: entry.total || 0,
    }));
    const heldMap = heldByMonth.reduce((acc, entry) => {
      if (entry.month) acc[entry.month] = entry.total;
      return acc;
    }, {});
    const releasedMap = releasedByMonth.reduce((acc, entry) => {
      if (entry.month) acc[entry.month] = entry.total;
      return acc;
    }, {});
    const escrowTrendMonths = Array.from(
      new Set([...heldByMonth.map((e) => e.month), ...releasedByMonth.map((e) => e.month)]).values()
    )
      .filter(Boolean)
      .sort();
    const escrowTrends = {
      months: escrowTrendMonths,
      held: escrowTrendMonths.map((m) => heldMap[m] || 0),
      released: escrowTrendMonths.map((m) => releasedMap[m] || 0),
    };

let activeCases = 0;
let completedCases = 0;
caseStatusAgg.forEach((item) => {
if (item?._id === "completed" || item?._id === "closed") {
completedCases += item.count;
} else if (ACTIVE_CASE_STATUSES.includes(item?._id)) {
activeCases += item.count;
}
});

const escrowInProgress = Array.isArray(escrowInProgressCount) ? escrowInProgressCount[0]?.count || 0 : escrowInProgressCount || 0;
const escrowMetrics = {
  totalEscrowHeld: escrowHeldAgg[0]?.total || 0,
  totalEscrowReleased: escrowReleasedAgg[0]?.total || 0,
  escrowInProgress,
  pendingPayouts: pendingPayoutAgg[0]?.total || 0,
  pendingPayoutCount: pendingPayoutAgg[0]?.count || 0,
};

const platformFeeTotals = platformFeeAgg[0] || { total: 0, count: 0 };
const platformFeesCollected = platformFeeTotals.total || 0;
const platformFeeCount = platformFeeTotals.count || 0;

const revenueMetrics = {
platformFeesCollected,
totalRevenue: platformFeesCollected,
monthlyRevenue: monthlyFeesAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
revenue: entry.revenue || 0,
})),
platformFeeCount,
};

const caseMetrics = {
jobsPostedByMonth: jobsPostedAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
count: entry.count,
})),
jobsCompletedByMonth: jobsCompletedAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
count: entry.count,
})),
casesByPracticeArea: practiceAgg.map((entry) => ({
practiceArea: (entry._id && String(entry._id).trim()) || "Unspecified",
count: entry.count,
})),
activeCases,
completedCases,
};

const ledgerEntries = [];
caseLedgerDocs.forEach((doc) => {
ledgerEntries.push({
date: doc.createdAt ? doc.createdAt.toISOString() : null,
category: "Matter Funding",
description: doc.title
? `${doc.title}${doc.practiceArea ? ` – ${doc.practiceArea}` : ""}`
: "Matter funding",
amount: doc.lockedTotalAmount || doc.totalAmount || 0,
type: "funding",
status: doc.paymentStatus || (doc.paymentReleased ? "Released" : "Pending"),
});
});
payoutLedgerDocs.forEach((doc) => {
ledgerEntries.push({
date: doc.createdAt ? doc.createdAt.toISOString() : null,
category: "Paralegal Payout",
description: doc.caseId ? `Payout for Matter ${doc.caseId}` : "Paralegal payout",
amount: doc.amountPaid || 0,
type: "payout",
status: doc.transferId ? "Transferred" : "Pending",
});
});
feeLedgerDocs.forEach((doc) => {
ledgerEntries.push({
date: doc.createdAt ? doc.createdAt.toISOString() : null,
category: "Platform Fee",
description: doc.caseId ? `Fee from Matter ${doc.caseId}` : "Platform income",
amount: doc.feeAmount || 0,
type: "revenue",
status: "Recorded",
});
});

const ledger = ledgerEntries
.sort((a, b) => new Date(b.date) - new Date(a.date))
.slice(0, LEDGER_LIMIT * 2);

const payoutSummary = payoutTotalsAgg[0] || { total: 0, count: 0 };
const payoutMetrics = {
totalRecorded: payoutSummary.total,
count: payoutSummary.count || 0,
};

const pendingPayoutQueue = pendingPayoutCases.map((caseDoc) => {
const matterDeadline = resolveMatterDeadlineDate(caseDoc);
const recipient =
caseDoc.paralegalNameSnapshot ||
[caseDoc.paralegal?.firstName || caseDoc.paralegalId?.firstName, caseDoc.paralegal?.lastName || caseDoc.paralegalId?.lastName]
.filter(Boolean)
.join(" ") ||
"Paralegal";
const baseAmount = Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
return {
matterDeadline: matterDeadline
? (typeof matterDeadline === "string" ? matterDeadline : matterDeadline.toISOString().split("T")[0])
: null,
amount: computeParalegalPayoutAmount(baseAmount, caseDoc),
recipient,
};
});

const recentUsers = recentUsersRaw.map((user) => ({
id: user._id,
name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "User",
email: user.email || "",
role: user.role || "",
status: user.status || "",
createdAt: user.createdAt,
}));

res.json({
userMetrics,
escrowMetrics,
revenueMetrics,
caseMetrics,
payoutMetrics,
pendingPayoutQueue,
ledger,
recentUsers,
      escrowTrends,
});
})
);

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
const normalizedStatus = normalizeUserStatus(status);
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
const rx = new RegExp(q.trim(), "i");
filter.$or = [
{ firstName: rx },
{ lastName: rx },
{ email: rx },
{ specialties: rx },
{ jurisdictions: rx },
];
}

const [items, total] = await Promise.all([
User.find(filter).select("-password").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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
];
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
    subject = ATTORNEY_LAUNCH_EMAIL_SUBJECT;
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

const filter = {};
if (status) filter.status = status;
if (attorney && isObjId(attorney)) filter.attorney = attorney;
if (paralegal && isObjId(paralegal)) filter.paralegal = paralegal;
if (q && q.trim()) filter.title = new RegExp(q.trim(), "i");

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

/**
* DELETE /api/admin/cases/:id
* Body: { reason, message }
* Permanently removes only open postings that were never hired or funded.
*/
router.delete("/cases/:id", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid Matter ID" });

const doc = await Case.findById(id).select(
  "title status attorney attorneyId paralegal paralegalId hiredAt escrowStatus escrowIntentId paymentIntentId paymentReleased payoutTransferId payoutFinalizedAt disputes jobId job"
).lean();
if (!doc) return res.status(404).json({ msg: "Matter not found" });

const statusKey = String(doc.status || "").trim().toLowerCase().replace("in_progress", "in progress");
if (doc.paralegal || doc.paralegalId || doc.hiredAt) {
  return res.status(409).json({ msg: "Hired matters must be retained for audit and payment history." });
}
if (
  String(doc.escrowStatus || "").toLowerCase() === "funded" ||
  doc.escrowIntentId ||
  doc.paymentIntentId ||
  doc.paymentReleased ||
  doc.payoutTransferId ||
  doc.payoutFinalizedAt
) {
  return res.status(409).json({ msg: "Funded matters must be retained for audit and payment history." });
}
if (Array.isArray(doc.disputes) && doc.disputes.length) {
  return res.status(409).json({ msg: "Matters with dispute history must be retained." });
}
if (statusKey !== "open") {
  return res.status(409).json({ msg: "Only open, never-engaged postings can be permanently deleted." });
}

const reason = sanitizeAdminNote(req.body?.reason || "", 2000);
const message = sanitizeAdminNote(req.body?.message || "", 4000);
const attorneyRef = doc.attorneyId || doc.attorney || null;

const relatedJobIds = [doc.jobId, doc.job].filter(Boolean).map((jobId) => String(jobId));
try {
  const extraJobs = await Job.find({ caseId: doc._id }).select("_id").lean();
  extraJobs.forEach((job) => {
    const jobId = job?._id ? String(job._id) : "";
    if (jobId && !relatedJobIds.includes(jobId)) relatedJobIds.push(jobId);
  });
} catch (jobListErr) {
  logger.warn("[admin] Unable to load related jobs for post deletion", doc._id, jobListErr);
}

await Case.deleteOne({ _id: doc._id });

try {
  if (relatedJobIds.length) {
    await Job.deleteMany({ _id: { $in: relatedJobIds } });
  } else {
    await Job.deleteMany({ caseId: doc._id });
  }
} catch (jobErr) {
  logger.warn("[admin] Unable to clean up related jobs for deleted case", doc._id, jobErr);
}

try {
  if (relatedJobIds.length) {
    await Application.deleteMany({ jobId: { $in: relatedJobIds } });
  }
} catch (appErr) {
  logger.warn("[admin] Unable to clean up applications for deleted case", doc._id, appErr);
}

await AuditLog.logFromReq(req, "admin.case.delete", {
targetType: "case",
targetId: doc._id,
caseId: doc._id,
meta: { reason, message },
});

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

res.json({ ok: true });
}));

router.get("/payouts", asyncHandler(async (_req, res) => {
const financialStart = getFinancialReportingStartDate();
const [items, summary] = await Promise.all([
Payout.find(withCreatedAtFloor({}, financialStart)).sort({ createdAt: -1 }).limit(200).lean(),
Payout.aggregate([{ $match: withCreatedAtFloor({}, financialStart) }, { $group: { _id: null, total: { $sum: "$amountPaid" }, count: { $sum: 1 } } }]),
]);
res.json({
totalAmount: summary[0]?.total || 0,
count: summary[0]?.count || 0,
items,
});
}));

router.get("/income", asyncHandler(async (_req, res) => {
const financialStart = getFinancialReportingStartDate();
const [items, summary] = await Promise.all([
PlatformIncome.find(withCreatedAtFloor({}, financialStart)).sort({ createdAt: -1 }).limit(200).lean(),
PlatformIncome.aggregate([{ $match: withCreatedAtFloor({}, financialStart) }, { $group: { _id: null, total: { $sum: "$feeAmount" }, count: { $sum: 1 } } }]),
]);
res.json({
totalAmount: summary[0]?.total || 0,
count: summary[0]?.count || 0,
items,
});
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
