// backend/routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const multer = require("multer");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const User = require("../models/User");
const Notification = require("../models/Notification");
const AuditLog = require("../models/AuditLog"); // audit trail hooks
const sendEmail = require("../utils/email");
const { getAppSettings } = require("../utils/appSettings");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const { publishEventSafe } = require("../services/lpcEvents/publishEventService");
const { ensureApprovedUserAuthReady, isApprovedUser } = require("../utils/authReady");
const { createLogger } = require("../utils/logger");
const {
  buildAuthenticatedProfilePhotoUrl,
  buildPublicProfilePhotoUrl,
  hasPhotoReference,
} = require("../services/profilePhotoDelivery");
const { hasRequiredParalegalFieldsForPublic } = require("../utils/paralegalProfile");
const verifyToken = require("../utils/verifyToken");
const { validateNewPassword } = require("../utils/passwordPolicy");
const { normalizeHttpUrl } = require("../utils/httpUrl");
const { validateMatterFileBuffer } = require("../utils/fileSecurity");
const {
  ACCESS_SESSION_TTL_MS,
  createAuthSession,
  revokeAllUserSessions,
  revokeSession,
} = require("../services/authSessionService");
const PasskeyCredential = require("../models/PasskeyCredential");
const {
  authenticationOptions: createPasskeyAuthenticationOptions,
  verifyAuthentication: verifyPasskeyAuthentication,
} = require("../services/passkeyService");
const { verifyTotp } = require("../services/mfaService");
const {
  normalizeEmail,
  sendVerificationEmail,
  applyVerifiedEmail,
} = require("../utils/emailVerification");
const {
  applyCurrentLegalAcceptance,
  serializeLegalAcceptance,
} = require("../utils/legalDocuments");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const { createS3Client } = require("../utils/s3Client");
const {
  createGoogleOAuthClient,
  verifyTurnstileToken,
} = require("../services/authProviderClient");

const IS_PROD = process.env.NODE_ENV === "production" || process.env.PROD === "true";
const TWO_FACTOR_ENABLED = String(process.env.ENABLE_TWO_FACTOR || "true").toLowerCase() !== "false";
const EMAIL_BASE_URL = (process.env.EMAIL_BASE_URL || "").replace(/\/+$/, "");
const ASSET_BASE_URL = EMAIL_BASE_URL || "https://www.lets-paraconnect.com";
const GOOGLE_OAUTH_CONTEXT_COOKIE = "lpc_google_oauth";
const GOOGLE_SIGNUP_HANDOFF_COOKIE = "lpc_google_signup";
const GOOGLE_LINK_CANDIDATE_COOKIE = "lpc_google_link";
const GOOGLE_TWO_FACTOR_COOKIE = "lpc_google_2fa";
const GOOGLE_OAUTH_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SIGNUP_TTL_MS = 20 * 60 * 1000;
const authLogger = createLogger("auth");
function resolveCookieDomain(req) {
  if (!IS_PROD || !process.env.COOKIE_DOMAIN) return {};
  const domain = process.env.COOKIE_DOMAIN;
  const normalized = domain.replace(/^\./, "");
  if (req?.hostname && normalized && !req.hostname.endsWith(normalized)) return {};
  return { domain };
}

function buildAuthCookieOptions(req, { maxAge } = {}) {
  return {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    path: "/",
    ...resolveCookieDomain(req),
    ...(typeof maxAge === "number" ? { maxAge } : {}),
  };
}

function buildGoogleCookieOptions(req, { maxAge, path: cookiePath = "/api/auth" } = {}) {
  return {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    path: cookiePath,
    ...resolveCookieDomain(req),
    ...(typeof maxAge === "number" ? { maxAge } : {}),
  };
}

const EMAIL_NOT_VERIFIED_MSG = "Please verify your email before logging in.";
const INVALID_CREDENTIALS_MSG = "Invalid email or password.";
const DUMMY_PASSWORD_HASH = argon2.hash(crypto.randomBytes(32).toString("base64url"));
const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CERT_FILE_BYTES = 10 * 1024 * 1024;
const VALID_US_STATES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);
const registrationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_FILE_BYTES },
});

// S3 client for resume uploads during registration
const s3 = createS3Client();
const BUCKET = process.env.S3_BUCKET || "";

function sseParams() {
  if (process.env.S3_SSE_KMS_KEY_ID) {
    return {
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: process.env.S3_SSE_KMS_KEY_ID,
    };
  }
  return { ServerSideEncryption: "AES256" };
}

function safeSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

function buildUnsubscribeToken(user) {
  if (!user?._id || !process.env.JWT_SECRET) return "";
  const payload = {
    purpose: "unsubscribe",
    uid: String(user._id),
  };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "180d" });
}

function serializeOnboarding(onboarding = {}) {
  return {
    paralegalTourCompleted: Boolean(onboarding?.paralegalTourCompleted),
    paralegalProfileTourCompleted: Boolean(onboarding?.paralegalProfileTourCompleted),
    attorneyTourCompleted: Boolean(onboarding?.attorneyTourCompleted),
  };
}

function serializePendingHire(pendingHire = {}) {
  if (!pendingHire || !pendingHire.caseId) return null;
  return {
    caseId: String(pendingHire.caseId),
    paralegalName: String(pendingHire.paralegalName || "").slice(0, 200),
    fundUrl: String(pendingHire.fundUrl || "").slice(0, 2000),
    message: String(pendingHire.message || "").slice(0, 2000),
    updatedAt: pendingHire.updatedAt || null,
  };
}

function buildResetPasswordEmailHtml(user, resetUrl, opts = {}) {
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const heroUrl = `${ASSET_BASE_URL}/hero-mountain.jpg`;
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
            <td align="center" style="padding:8px 24px 20px;">
              <img src="${heroUrl}" alt="Let's-ParaConnect" width="552" style="display:block;border:0;width:100%;max-width:552px;border-radius:18px;">
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:34px;letter-spacing:0.06em;color:#6e6e6e;">
                Reset your password
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 32px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:16px;letter-spacing:0.08em;color:#1f1f1f;line-height:1.6;">
                We received a request to reset your password. Use this
                <a href="${resetUrl}" style="color:#1f1f1f;text-decoration:underline;">link</a>
                to choose a new one. This link expires in 60 minutes and can only be used once.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#0a84ff" style="border-radius:999px;">
                    <a href="${resetUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 32px;font-family:Georgia, 'Times New Roman', serif;font-size:22px;color:#ffffff;text-decoration:none;">
                      Reset password
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 20px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;letter-spacing:0.04em;color:#545454;line-height:1.7;word-break:break-word;">
                If the button does not work, copy and paste this URL into your browser:<br>
                <a href="${resetUrl}" target="_blank" rel="noopener" style="color:#1f1f1f;text-decoration:underline;word-break:break-all;">${resetUrl}</a>
              </div>
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
                If you did not request a password reset, you can ignore this email and your password will stay the same.
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
                ${unsubscribeLine}. Required account and case notices may still be sent.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
}

function buildTwoFactorEmailHtml(user, code) {
  const name = user?.firstName ? String(user.firstName).trim() : "there";
  return `
    <div style="font-family: Arial, sans-serif; color: #111;">
      <p>Hi ${name},</p>
      <p>Your verification code is:</p>
      <p style="font-size: 24px; letter-spacing: 4px; font-weight: bold;">${code}</p>
      <p>This code expires in 15 minutes.</p>
      <p>If you did not attempt to sign in, you can ignore this email.</p>
    </div>
  `;
}

function buildApplicationSubmissionEmailHtml(user, opts = {}) {
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const heroUrl = `${ASSET_BASE_URL}/hero-mountain.jpg`;
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
            <td align="center" style="padding:8px 24px 20px;">
              <img src="${heroUrl}" alt="Let's-ParaConnect" width="552" style="display:block;border:0;width:100%;max-width:552px;border-radius:18px;">
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:34px;letter-spacing:0.06em;color:#6e6e6e;">
                Application received
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 32px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:16px;letter-spacing:0.08em;color:#1f1f1f;line-height:1.6;">
                Thank you for applying to Let’s-ParaConnect. Our team is reviewing your application and submitted information,
                and we’ll email you as soon as the review is complete.
              </div>
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
                We’ll email you when the review is complete. If any submitted information changes before then,
                reply to this email and our team will help.
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
                ${unsubscribeLine}. Required account and case notices may still be sent.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TWO_HOURS = "2h";
const TWO_HOURS_MS = ACCESS_SESSION_TTL_MS;
const FIFTEEN_MIN = 15 * 60 * 1000;
const RESET_PASSWORD_MINUTES = 60;
const DISABLED_ACCOUNT_MSG = "This account has been deactivated.";
function isDeactivatedUser(user) {
  return !!(user && (user.disabled || user.deleted));
}
const BOT_NAME_GIBBERISH = /^[bcdfghjklmnpqrstvwxyz]{6,}$/;
const BOT_REPEATED = /(.)\1{3,}/;
const BOT_FORBIDDEN_CHARS = /[{}[\]|\\^<>]/;
const PARA_WELCOME_TITLE = "Welcome to Let’s-ParaConnect";
const PARA_WELCOME_BODY =
  "Your application is under review. We’ll notify you when a decision is recorded. " +
  "After approval, complete your profile and Stripe payout setup, then browse and apply to open Matters.";

async function ensureParalegalWelcomeNotification(user) {
  if (!user) return;
  const role = String(user.role || "").toLowerCase();
  if (role !== "paralegal") return;
  const existing = await Notification.findOne({
    userId: user._id,
    type: "paralegal_welcome",
  }).select("_id");
  if (existing) return;
  const message = `${PARA_WELCOME_TITLE} ${PARA_WELCOME_BODY}`;
  await Notification.create({
    userId: user._id,
    userRole: user.role || "",
    type: "paralegal_welcome",
    message,
    payload: { title: PARA_WELCOME_TITLE, body: PARA_WELCOME_BODY },
    read: false,
    isRead: false,
    createdAt: new Date(),
  });
  publishNotificationEvent(user._id, "notifications", { at: new Date().toISOString() });
}

function signAccess(user, sessionId) {
  const approved = String(user.status || "").toLowerCase() === "approved";
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
    approved,
    av: Number(user.authVersion || 0),
    sid: String(sessionId || ""),
  };
  const opts = { expiresIn: TWO_HOURS };
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return jwt.sign(payload, process.env.JWT_SECRET, opts);
}

async function establishSession(req, res, user) {
  if (user.authVersion === undefined) {
    const authState = await User.findById(user._id || user.id).select("+authVersion").lean();
    user.authVersion = Number(authState?.authVersion || 0);
  }
  const { sessionId } = await createAuthSession(user, req, { ttlMs: TWO_HOURS_MS });
  const token = signAccess(user, sessionId);
  res.cookie("token", token, buildAuthCookieOptions(req, { maxAge: TWO_HOURS_MS }));
  return sessionId;
}

function createTwoFactorChallenge(user) {
  const challengeToken = crypto.randomBytes(32).toString("base64url");
  const code = String(crypto.randomInt(100000, 1000000));
  user.twoFactorChallengeHash = hashOpaqueToken(challengeToken);
  user.twoFactorFailedAttempts = 0;
  return { challengeToken, code };
}

function clearTwoFactorChallenge(user) {
  user.twoFactorTempCode = null;
  user.twoFactorExpiresAt = null;
  user.twoFactorChallengeHash = null;
  user.twoFactorFailedAttempts = 0;
}

function hashOpaqueToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function createPasswordResetToken(userId) {
  return `${String(userId)}.${crypto.randomBytes(32).toString("base64url")}`;
}

function signOneTime(payload, { minutes = 30, secretEnv = "JWT_SECRET" } = {}) {
  const expSeconds = Math.floor(Date.now() / 1000) + minutes * 60;
  return jwt.sign({ ...payload, exp: expSeconds }, process.env[secretEnv]);
}

function getGoogleConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri || !process.env.JWT_SECRET) return null;
  return { clientId, clientSecret, redirectUri };
}

function getGoogleClient(config = getGoogleConfig()) {
  if (!config) return null;
  return createGoogleOAuthClient(config);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function maskEmail(value) {
  const [local = "", domain = ""] = String(value || "").split("@");
  if (!local || !domain) return "your email";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function signGoogleContext(payload, minutes) {
  return signOneTime(
    {
      ...payload,
      purpose: payload.purpose,
    },
    { minutes }
  );
}

function verifyGoogleContext(token, purpose) {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || payload.purpose !== purpose) return null;
    return payload;
  } catch {
    return null;
  }
}

function googleErrorRedirect(code, intent = "login") {
  const page = intent === "signup" ? "/signup.html" : "/login.html";
  return `${page}?google_error=${encodeURIComponent(code)}`;
}

function roleDashboard(role) {
  const normalizedRole = String(role || "").toLowerCase();
  if (normalizedRole === "admin") return "/admin-dashboard.html";
  if (normalizedRole === "director") return "/director-portal.html";
  if (normalizedRole === "paralegal") return "/dashboard-paralegal.html";
  return "/dashboard-attorney.html";
}

function legalAcceptanceFields(user) {
  const legalAcceptance = serializeLegalAcceptance(user);
  return {
    legalAcceptanceRequired: legalAcceptance.required,
    legalAcceptance,
  };
}

async function startGoogleTwoFactor(req, res, user) {
  const { challengeToken, code } = createTwoFactorChallenge(user);
  user.twoFactorExpiresAt = new Date(Date.now() + FIFTEEN_MIN);
  if (user.twoFactorMethod === "authenticator") {
    user.twoFactorTempCode = null;
    await user.save();
  } else {
    user.twoFactorTempCode = await bcrypt.hash(code, 10);
    await user.save();
    try {
      const html = buildTwoFactorEmailHtml(user, code);
      const text = `Your verification code is ${code}. This code expires in 15 minutes.`;
      await sendEmail(user.email, "Your verification code", html, { text });
    } catch (err) {
      clearTwoFactorChallenge(user);
      await user.save();
      authLogger.error("[auth.google] two-factor delivery failed");
      return false;
    }
  }

  const context = signGoogleContext(
    {
      purpose: "google_2fa",
      userId: String(user._id),
      challengeToken,
    },
    15
  );
  res.cookie(
    GOOGLE_TWO_FACTOR_COOKIE,
    context,
    buildGoogleCookieOptions(req, { maxAge: FIFTEEN_MIN })
  );
  return true;
}

async function linkPendingGoogleIdentity(req, res, user) {
  const token = req.cookies?.[GOOGLE_LINK_CANDIDATE_COOKIE];
  const candidate = verifyGoogleContext(token, "google_link");
  if (!candidate) return false;

  res.clearCookie(GOOGLE_LINK_CANDIDATE_COOKIE, buildGoogleCookieOptions(req));
  if (
    !candidate.userId ||
    !candidate.providerAccountId ||
    !safeEqual(String(candidate.userId), String(user?._id || ""))
  ) {
    await AuditLog.logFromReq(req, "auth.google.link.fail", {
      targetType: "user",
      targetId: user?._id,
      meta: { reason: "authenticated_user_mismatch" },
    });
    return false;
  }

  const providerAccountId = String(candidate.providerAccountId);
  const providerOwner = await User.findOne({
    authProviders: {
      $elemMatch: {
        provider: "google",
        providerAccountId,
      },
    },
  }).select("_id");
  if (providerOwner && String(providerOwner._id) !== String(user._id)) {
    await AuditLog.logFromReq(req, "auth.google.link.fail", {
      targetType: "user",
      targetId: user._id,
      meta: { reason: "provider_already_linked" },
    });
    return false;
  }

  const target = await User.findById(user._id).select("+authProviders");
  if (!target) return false;
  const alreadyLinked = (target.authProviders || []).some(
    (identity) =>
      identity.provider === "google" &&
      safeEqual(identity.providerAccountId, providerAccountId)
  );
  if (alreadyLinked) return true;

  target.authProviders.push({
    provider: "google",
    providerAccountId,
    linkedAt: new Date(),
  });
  try {
    await target.save();
  } catch (err) {
    if (err?.code === 11000) {
      await AuditLog.logFromReq(req, "auth.google.link.fail", {
        targetType: "user",
        targetId: user._id,
        meta: { reason: "provider_unique_conflict" },
      });
      return false;
    }
    throw err;
  }

  await AuditLog.logFromReq(req, "auth.google.link.success", {
    targetType: "user",
    targetId: user._id,
    meta: { provider: "google" },
  });
  return true;
}

function isEmail(v = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).toLowerCase());
}

function isTypoEmailDomain(v = "") {
  return /@[^@\s]+\.con$/i.test(String(v).trim());
}

function isObjId(id) {
  return mongoose.isValidObjectId(id);
}

function looksLikeBot({ first = "", last = "", email = "" }) {
  const cleanFirst = String(first).trim().toLowerCase();
  const cleanLast = String(last).trim().toLowerCase();
  const cleanEmail = String(email).trim().toLowerCase();
  const combo = `${cleanFirst} ${cleanLast}`;
  if (cleanFirst.length < 2 || cleanLast.length < 2) return true;
  if (BOT_REPEATED.test(combo)) return true;
  if (BOT_NAME_GIBBERISH.test(cleanFirst) || BOT_NAME_GIBBERISH.test(cleanLast)) return true;
  if (BOT_FORBIDDEN_CHARS.test(combo)) return true;
  if (combo.includes("http://") || combo.includes("https://")) return true;
  if (cleanEmail.startsWith("test@") || cleanEmail.includes("+bot@")) return true;
  return false;
}

async function verifyTurnstile(token, remoteIp) {
  let expectedHostname = "";
  try {
    expectedHostname = new URL(process.env.APP_BASE_URL || "").hostname;
  } catch (_err) {
    // Production startup validation owns the canonical URL error. Verification fails closed below.
  }
  return verifyTurnstileToken({
    secret: process.env.TURNSTILE_SECRET || "",
    token,
    remoteIp,
    logger: authLogger,
    expectedAction: "signup",
    expectedHostname,
  });
}

// ----------------------------------------
// GOOGLE OAUTH (server-side authorization-code flow)
// GET /api/auth/google
// GET /api/auth/google/callback
// ----------------------------------------
router.get(
  "/google",
  asyncHandler(async (req, res) => {
    const config = getGoogleConfig();
    if (!config) {
      return res.status(503).json({ msg: "Google authentication is temporarily unavailable." });
    }

    const intent = req.query?.intent === "signup" ? "signup" : "login";
    const role = req.query?.role === "paralegal" ? "paralegal" : "attorney";
    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const context = signGoogleContext(
      {
        purpose: "google_oauth",
        state,
        nonce,
        intent,
        role,
      },
      10
    );

    res.cookie(
      GOOGLE_OAUTH_CONTEXT_COOKIE,
      context,
      buildGoogleCookieOptions(req, {
        maxAge: GOOGLE_OAUTH_TTL_MS,
        path: "/api/auth/google",
      })
    );

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      prompt: "select_account",
    });
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  })
);

router.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const config = getGoogleConfig();
    const rawContext = req.cookies?.[GOOGLE_OAUTH_CONTEXT_COOKIE];
    const context = verifyGoogleContext(rawContext, "google_oauth");
    const intent = context?.intent === "signup" ? "signup" : "login";
    res.clearCookie(
      GOOGLE_OAUTH_CONTEXT_COOKIE,
      buildGoogleCookieOptions(req, { path: "/api/auth/google" })
    );

    if (!config) {
      return res.redirect(googleErrorRedirect("unavailable", intent));
    }
    if (
      !context ||
      !req.query?.state ||
      !safeEqual(req.query.state, context.state)
    ) {
      await AuditLog.logFromReq(req, "auth.google.fail", {
        targetType: "user",
        meta: { reason: "invalid_state" },
      });
      return res.redirect(googleErrorRedirect("invalid_state", intent));
    }
    if (req.query?.error || !req.query?.code) {
      await AuditLog.logFromReq(req, "auth.google.fail", {
        targetType: "user",
        meta: { reason: req.query?.error ? "provider_denied" : "missing_code" },
      });
      return res.redirect(googleErrorRedirect("cancelled", intent));
    }

    let profile;
    try {
      const client = getGoogleClient(config);
      const { tokens } = await client.getToken({
        code: String(req.query.code),
        redirect_uri: config.redirectUri,
      });
      if (!tokens?.id_token) throw new Error("missing_id_token");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.clientId,
      });
      profile = ticket.getPayload();
    } catch {
      await AuditLog.logFromReq(req, "auth.google.fail", {
        targetType: "user",
        meta: { reason: "code_exchange_or_identity_verification" },
      });
      return res.redirect(googleErrorRedirect("oauth_failed", intent));
    }

    const providerAccountId = String(profile?.sub || "").trim();
    const verifiedEmail = normalizeEmail(profile?.email || "");
    if (
      !providerAccountId ||
      providerAccountId.length > 255 ||
      !isEmail(verifiedEmail) ||
      profile?.email_verified !== true ||
      !profile?.nonce ||
      !safeEqual(profile.nonce, context.nonce)
    ) {
      await AuditLog.logFromReq(req, "auth.google.fail", {
        targetType: "user",
        meta: { reason: "invalid_verified_identity" },
      });
      return res.redirect(googleErrorRedirect("identity_invalid", intent));
    }

    const linkedUser = await User.findOne({
      authProviders: {
        $elemMatch: {
          provider: "google",
          providerAccountId,
        },
      },
    });

    if (linkedUser) {
      if (isDeactivatedUser(linkedUser)) {
        return res.redirect(googleErrorRedirect("disabled", "login"));
      }

      const settings = await getAppSettings();
      if (
        settings?.maintenanceMode &&
        String(linkedUser.role || "").toLowerCase() !== "admin"
      ) {
        return res.redirect(googleErrorRedirect("maintenance", "login"));
      }

      if (!isApprovedUser(linkedUser)) {
        await AuditLog.logFromReq(req, "auth.google.login.blocked", {
          targetType: "user",
          targetId: linkedUser._id,
          meta: { reason: String(linkedUser.status || "pending") },
        });
        return res.redirect(
          googleErrorRedirect(
            String(linkedUser.status || "").toLowerCase() === "pending"
              ? "pending"
              : "not_approved",
            "login"
          )
        );
      }

      let userChanged = ensureApprovedUserAuthReady(linkedUser);
      if (linkedUser.emailVerified !== true) {
        if (userChanged) await linkedUser.save();
        return res.redirect(googleErrorRedirect("email_unverified", "login"));
      }
      if (linkedUser.twoFactorEnabled && !TWO_FACTOR_ENABLED) {
        return res.redirect(googleErrorRedirect("two_factor_unavailable", "login"));
      }
      if (userChanged) await linkedUser.save();

      if (linkedUser.twoFactorEnabled && TWO_FACTOR_ENABLED) {
        const sent = await startGoogleTwoFactor(req, res, linkedUser);
        if (!sent) return res.redirect(googleErrorRedirect("two_factor_unavailable", "login"));
        return res.redirect("/login.html?google_2fa=1");
      }

      const lastLoginAt = linkedUser.lastLoginAt ? new Date(linkedUser.lastLoginAt) : null;
      const approvedAt = linkedUser.approvedAt ? new Date(linkedUser.approvedAt) : null;
      const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
      linkedUser.recordLoginSuccess();
      await linkedUser.save();
      await establishSession(req, res, linkedUser);
      await AuditLog.logFromReq(req, "auth.google.login.success", {
        targetType: "user",
        targetId: linkedUser._id,
      });
      if (isFirstLogin) {
        try {
          await ensureParalegalWelcomeNotification(linkedUser);
        } catch (err) {
          authLogger.warn("[auth.google] welcome notification failed");
        }
      }
      return res.redirect(
        serializeLegalAcceptance(linkedUser).required
          ? "/legal-acceptance.html"
          : roleDashboard(linkedUser.role)
      );
    }

    const emailOwner = await User.findOne({
      email: verifiedEmail,
      deleted: { $ne: true },
    }).select("_id");
    if (emailOwner) {
      const linkCandidate = signGoogleContext(
        {
          purpose: "google_link",
          userId: String(emailOwner._id),
          provider: "google",
          providerAccountId,
        },
        20
      );
      res.cookie(
        GOOGLE_LINK_CANDIDATE_COOKIE,
        linkCandidate,
        buildGoogleCookieOptions(req, { maxAge: GOOGLE_SIGNUP_TTL_MS })
      );
      await AuditLog.logFromReq(req, "auth.google.login.blocked", {
        targetType: "user",
        targetId: emailOwner._id,
        meta: { reason: "matching_email_unlinked" },
      });
      return res.redirect(googleErrorRedirect("matching_email_unlinked", "login"));
    }

    const nameParts = String(profile?.name || "").trim().split(/\s+/).filter(Boolean);
    const firstName = String(profile?.given_name || nameParts[0] || "").trim().slice(0, 150);
    const lastName = String(
      profile?.family_name || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "")
    )
      .trim()
      .slice(0, 150);
    const handoff = signGoogleContext(
      {
        purpose: "google_signup",
        provider: "google",
        providerAccountId,
        email: verifiedEmail,
        firstName,
        lastName,
      },
      20
    );
    res.cookie(
      GOOGLE_SIGNUP_HANDOFF_COOKIE,
      handoff,
      buildGoogleCookieOptions(req, { maxAge: GOOGLE_SIGNUP_TTL_MS })
    );
    await AuditLog.logFromReq(req, "auth.google.signup.handoff", {
      targetType: "user",
      meta: { provider: "google" },
    });
    const role = context.role === "paralegal" ? "paralegal" : "attorney";
    return res.redirect(`/signup.html?google=1&role=${role}`);
  })
);

router.get("/google/signup-profile", (req, res) => {
  const handoff = verifyGoogleContext(
    req.cookies?.[GOOGLE_SIGNUP_HANDOFF_COOKIE],
    "google_signup"
  );
  if (!handoff) {
    return res.status(401).json({ msg: "Google signup session expired. Please try again." });
  }
  return res.json({
    profile: {
      firstName: String(handoff.firstName || ""),
      lastName: String(handoff.lastName || ""),
      email: String(handoff.email || ""),
      emailVerified: true,
    },
  });
});

router.get("/google/2fa-context", asyncHandler(async (req, res) => {
  const context = verifyGoogleContext(
    req.cookies?.[GOOGLE_TWO_FACTOR_COOKIE],
    "google_2fa"
  );
  res.clearCookie(GOOGLE_TWO_FACTOR_COOKIE, buildGoogleCookieOptions(req));
  if (!context?.userId || !isObjId(context.userId)) {
    return res.status(401).json({ msg: "Google sign-in session expired. Please try again." });
  }
  const user = await User.findById(context.userId)
    .select("email twoFactorEnabled twoFactorMethod")
    .lean();
  if (!user?.twoFactorEnabled) {
    return res.status(401).json({ msg: "Google sign-in session expired. Please try again." });
  }
  return res.json({
    challengeToken: context.challengeToken,
    method: user.twoFactorMethod || "email",
    destination: user.twoFactorMethod === "authenticator" ? "your authenticator app" : maskEmail(user.email),
    passkeyAvailable: (await PasskeyCredential.exists({ userId: context.userId })) !== null,
  });
}));

// ----------------------------------------
// REGISTER
// POST /api/auth/register
// ----------------------------------------
router.post(
  "/register",
  csrfProtection,
  registrationUpload.fields([
    { name: "resume", maxCount: 1 },
    { name: "resumeFile", maxCount: 1 },
    { name: "certificateFile", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const enforceTurnstile = String(process.env.TURNSTILE_ENFORCED || "true").toLowerCase() === "true";
    const {
      firstName,
      lastName,
      email,
      password,
      role,
      barNumber,
      linkedInURL,
      lawFirm,
      certificateURL,
      turnstileToken,
      termsAccepted,
      privacyAcknowledged,
      attorneyPricingAccepted,
      phoneNumber,
      barState,
      state,
      timezone,
      yearsExperience,
      googleSignupIntent,
    } = req.body || {};

    const settings = await getAppSettings();
    if (settings?.maintenanceMode) {
      return res.status(503).json({ msg: "Signups are temporarily unavailable during maintenance." });
    }
    if (settings?.allowSignups === false) {
      return res.status(403).json({ msg: "Signups are temporarily paused." });
    }

    const normalizedEmail = String(email || "").toLowerCase().trim();
    const googleSignupHandoff = verifyGoogleContext(
      req.cookies?.[GOOGLE_SIGNUP_HANDOFF_COOKIE],
      "google_signup"
    );
    const expectsGoogleSignup =
      String(googleSignupIntent || "").toLowerCase() === "true";
    if (expectsGoogleSignup && !googleSignupHandoff) {
      return res.status(401).json({
        msg: "Google signup session expired. Please continue with Google again.",
      });
    }
    if (
      googleSignupHandoff &&
      (!safeEqual(normalizedEmail, normalizeEmail(googleSignupHandoff.email || "")) ||
        googleSignupHandoff.provider !== "google" ||
        !googleSignupHandoff.providerAccountId)
    ) {
      return res.status(400).json({
        msg: "Google signup details changed or expired. Please continue with Google again.",
      });
    }
    const resolvedTurnstileToken =
      turnstileToken ||
      req.body?.["cf-turnstile-response"] ||
      req.body?.cfTurnstileResponse;
    if (enforceTurnstile && process.env.NODE_ENV === "production") {
      if (!resolvedTurnstileToken || !process.env.TURNSTILE_SECRET) {
        return res.status(400).json({ error: "Turnstile verification failed" });
      }
      const verification = await verifyTurnstile(resolvedTurnstileToken, req.ip);
      if (!verification?.success) {
        authLogger.warn("[turnstile] signup verify failed", verification?.["error-codes"] || verification?.errorCodes);
        return res.status(400).json({ error: "Turnstile verification failed" });
      }
    }

    const safeFirst = String(firstName || "").trim();
    const safeLast = String(lastName || "").trim();
    if (!safeFirst || !safeLast) {
      return res.status(400).json({ msg: "First and last name are required." });
    }
    if (looksLikeBot({ first: safeFirst, last: safeLast, email: normalizedEmail })) {
      return res.status(400).json({ msg: "Registration failed validation. Please provide accurate information." });
    }

    if (
      String(termsAccepted || "").toLowerCase() !== "true" ||
      String(privacyAcknowledged || "").toLowerCase() !== "true"
    ) {
      return res.status(400).json({
        msg: "You must accept the Terms of Service and acknowledge the Privacy Policy.",
      });
    }

    const roleLc = String(role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(roleLc)) {
      return res.status(400).json({ msg: "Invalid role" });
    }
    const normalizedState =
      typeof state === "string" ? state.trim().toUpperCase() : "";
    if (!normalizedState) {
      return res.status(400).json({ msg: "State is required." });
    }
    if (!VALID_US_STATES.has(normalizedState)) {
      return res.status(400).json({ msg: "State must be a valid 2-letter code." });
    }
    const safeTimezone =
      typeof timezone === "string" && timezone.trim().length <= 64 ? timezone.trim() : "";
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });
    if (isTypoEmailDomain(normalizedEmail)) {
      return res.status(400).json({ msg: "Please use a .com email address (.con is a typo)." });
    }
    const passwordPolicy = validateNewPassword(password, {
      user: { email: normalizedEmail, firstName: safeFirst, lastName: safeLast },
    });
    if (!passwordPolicy.ok) return res.status(400).json({ msg: passwordPolicy.error, code: passwordPolicy.code });

    const normalizedBarState =
      typeof barState === "string" ? barState.trim().toUpperCase() : "";
    const normalizedBarNumber = String(barNumber || "").trim();
    const linkedIn = normalizeHttpUrl(linkedInURL, {
      fieldLabel: "LinkedIn URL",
      requiredHost: "linkedin.com",
    });
    if (!linkedIn.ok) return res.status(400).json({ msg: linkedIn.error });
    const normalizedLinkedInURL = linkedIn.value;
    if (roleLc === "attorney") {
      if (!normalizedBarNumber) {
        return res.status(400).json({ msg: "State Bar Number is required for attorneys." });
      }
      if (!normalizedBarState) {
        return res.status(400).json({ msg: "Bar State is required for attorneys." });
      }
      if (!/^[A-Z]{2}$/.test(normalizedBarState)) {
        return res.status(400).json({ msg: "Bar State must be a valid 2-letter code." });
      }
      const pricingAccepted = String(attorneyPricingAccepted || "").toLowerCase() === "true";
      if (!pricingAccepted) {
        return res.status(400).json({ msg: "Attorneys must acknowledge the $400 minimum Matter requirement." });
      }
    }

    const resumeFile = req.files?.resume?.[0] || req.files?.resumeFile?.[0] || null;
    const certificateFile = req.files?.certificateFile?.[0] || null;

    // Paralegals must attach a PDF resume at signup
    if (roleLc === "paralegal" && !resumeFile) {
      return res.status(400).json({ msg: "Résumé file is required for paralegal registration." });
    }

    if (googleSignupHandoff) {
      const existingProvider = await User.findOne({
        authProviders: {
          $elemMatch: {
            provider: "google",
            providerAccountId: String(googleSignupHandoff.providerAccountId),
          },
        },
      }).select("_id");
      if (existingProvider) {
        return res.status(409).json({
          msg: "This Google account is already linked. Sign in with Google instead.",
        });
      }
    }

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({
        msg: existing.deleted
          ? "An account with this email was deactivated. Contact support if you need help returning."
          : "User already exists",
      });
    }

    if (roleLc === "paralegal" && resumeFile) {
      if (resumeFile.mimetype !== "application/pdf") {
        return res.status(400).json({ msg: "Résumé must be a PDF" });
      }
      if (resumeFile.size > MAX_RESUME_FILE_BYTES) {
        return res.status(400).json({ msg: "Résumé exceeds maximum allowed size (10 MB)." });
      }
      if (!BUCKET) {
        return res.status(500).json({ msg: "Resume upload unavailable. Please try again later." });
      }
      try {
        validateMatterFileBuffer({
          buffer: resumeFile.buffer,
          mimeType: resumeFile.mimetype,
          filename: resumeFile.originalname || "resume.pdf",
        });
      } catch (error) {
        return res.status(400).json({ msg: "Résumé must be a valid PDF.", code: error?.code });
      }
    }
    if (roleLc === "paralegal" && certificateFile) {
      if (certificateFile.mimetype !== "application/pdf") {
        return res.status(400).json({ msg: "Certificate must be a PDF" });
      }
      if (certificateFile.size > MAX_CERT_FILE_BYTES) {
        return res.status(400).json({ msg: "Certificate exceeds maximum allowed size (10 MB)." });
      }
      if (!BUCKET) {
        return res.status(500).json({ msg: "Certificate upload unavailable. Please try again later." });
      }
      try {
        validateMatterFileBuffer({
          buffer: certificateFile.buffer,
          mimeType: certificateFile.mimetype,
          filename: certificateFile.originalname || "certificate.pdf",
        });
      } catch (error) {
        return res.status(400).json({ msg: "Certificate must be a valid PDF.", code: error?.code });
      }
    }

    // Let the model hash the password (pre-save hook)

    const parsedYearsExperience = parseInt(yearsExperience, 10);
    const safeYearsExperience = Number.isFinite(parsedYearsExperience)
      ? Math.max(0, Math.min(80, parsedYearsExperience))
      : undefined;

    const user = new User({
      firstName: safeFirst,
      lastName: safeLast,
      email: String(email || "").toLowerCase(),
      password: passwordPolicy.password,
      role: roleLc,
      status: "pending",
      preferences: {
        theme: roleLc === "attorney" ? "light" : "mountain",
      },
      barNumber: roleLc === "attorney" ? String(barNumber || "") : "",
      resumeURL: roleLc === "paralegal" ? "" : "",
      certificateURL: roleLc === "paralegal" ? String(certificateURL || "") : "",
      linkedInURL: normalizedLinkedInURL,
      lawFirm: roleLc === "attorney" ? (String(lawFirm || "").trim() || null) : null,
      attorneyPricingAccepted:
        roleLc === "attorney" ? String(attorneyPricingAccepted || "").toLowerCase() === "true" : false,
      phoneNumber: phoneNumber ? String(phoneNumber).trim() || null : null,
      state: normalizedState,
      timezone: safeTimezone || undefined,
      yearsExperience: roleLc === "paralegal" ? safeYearsExperience : undefined,
      emailVerified: Boolean(googleSignupHandoff),
      authProviders: googleSignupHandoff
        ? [
            {
              provider: "google",
              providerAccountId: String(googleSignupHandoff.providerAccountId),
              linkedAt: new Date(),
            },
          ]
        : [],
    });
    applyCurrentLegalAcceptance(user, { source: "signup" });

    if (roleLc === "attorney" && normalizedBarState) {
      user.location = normalizedBarState;
    } else if (roleLc === "paralegal" && normalizedState) {
      user.location = normalizedState;
    }

    // Upload admission documents before saving, then compensate if persistence fails.
    const uploadedAdmissionKeys = [];
    if (roleLc === "paralegal" && resumeFile) {
      const key = `paralegal-resumes/${safeSegment(user._id)}/resume.pdf`;
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        Body: resumeFile.buffer,
        ContentType: "application/pdf",
        ContentLength: resumeFile.size,
        ACL: "private",
        ...sseParams(),
      };
      await s3.send(new PutObjectCommand(putParams));
      uploadedAdmissionKeys.push(key);
      user.resumeURL = key;
    }
    if (roleLc === "paralegal" && certificateFile) {
      const key = `paralegal-certificates/${safeSegment(user._id)}/certificate.pdf`;
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        Body: certificateFile.buffer,
        ContentType: "application/pdf",
        ContentLength: certificateFile.size,
        ACL: "private",
        ...sseParams(),
      };
      await s3.send(new PutObjectCommand(putParams));
      uploadedAdmissionKeys.push(key);
      user.certificateURL = key;
    }

    try {
      await user.save();
    } catch (err) {
      await Promise.allSettled(uploadedAdmissionKeys.map((key) =>
        s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
      ));
      const duplicateProvider =
        err?.code === 11000 &&
        (err?.keyPattern?.["authProviders.providerAccountId"] ||
          String(err?.message || "").includes("user_auth_provider_unique"));
      if (duplicateProvider) {
        return res.status(409).json({
          msg: "This Google account is already linked. Sign in with Google instead.",
        });
      }
      throw err;
    }

    if (googleSignupHandoff) {
      res.clearCookie(
        GOOGLE_SIGNUP_HANDOFF_COOKIE,
        buildGoogleCookieOptions(req)
      );
    }

    // Email: registration received
    try {
      const html = buildApplicationSubmissionEmailHtml(user);
      await sendEmail(user.email, "Registration received", html);
    } catch (error) {
      authLogger.warn("[auth] registration email delivery failed", {
        userId: String(user._id),
        error: error?.message || String(error),
      });
    }

    await AuditLog.logFromReq(req, "auth.register", {
      targetType: "user",
      targetId: user._id,
      meta: {
        role: user.role,
        provider: googleSignupHandoff ? "google" : "password",
      },
    });

    try {
      const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
      const adminLink = baseUrl ? `${baseUrl}/admin-dashboard.html#section-user-management` : "";
      const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || "New user";
      const timestamp = new Date().toISOString();
      const linkHtml = adminLink ? `<p><a href="${adminLink}">Open admin dashboard</a></p>` : "";
      await sendEmail(
        "admin@lets-paraconnect.com",
        "New user signup",
        `<p>A new user signed up.</p>
         <p><strong>Name:</strong> ${fullName}<br/>
         <strong>Role:</strong> ${String(user.role || "").toLowerCase()}<br/>
         <strong>Timestamp:</strong> ${timestamp}</p>
         ${linkHtml}`
      );
    } catch (err) {
      authLogger.warn("[auth] admin signup email failed", err?.message || err);
    }

    await publishEventSafe({
      eventType: "user.signup.created",
      eventFamily: "platform_user",
      idempotencyKey: `user:${user._id}:signup:created`,
      correlationId: `user:${user._id}`,
      actor: {
        actorType: "user",
        userId: user._id,
        role: user.role || "",
        email: user.email || "",
        label: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "User",
      },
      subject: {
        entityType: "user",
        entityId: String(user._id),
      },
      related: {
        userId: user._id,
      },
      source: {
        surface: "public",
        route: "/api/auth/register",
        service: "auth",
        producer: "route",
      },
      facts: {
        summary: `${user.email || "User"} signed up and entered the pending admissions queue.`,
        after: {
          email: user.email || "",
          role: user.role || "",
          status: user.status || "",
        },
      },
      signals: {
        confidence: "high",
        priority: "normal",
      },
    });

    res.json({ msg: "Registered successfully. Await admin approval." });
  })
);

// ----------------------------------------
// LOGIN
// POST /api/auth/login  -> returns { token, user }
// ----------------------------------------
router.post(
  "/login",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

    if (!isEmail(email) || !password || String(password).length > 128) {
      return res.status(400).json({ msg: INVALID_CREDENTIALS_MSG, error: INVALID_CREDENTIALS_MSG });
    }

    // IMPORTANT: password is select:false in schema, so we MUST include it
    const user = await User.findOne({ email: String(email).toLowerCase() })
      .select("+password +authVersion +twoFactorChallengeHash +twoFactorFailedAttempts");
    if (!user) {
      const dummyHash = await DUMMY_PASSWORD_HASH;
      await argon2.verify(dummyHash, String(password)).catch(() => false);
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", meta: { email } });
      return res.status(401).json({ msg: INVALID_CREDENTIALS_MSG, error: INVALID_CREDENTIALS_MSG });
    }

    if (user.isLocked) {
      await argon2.verify(await DUMMY_PASSWORD_HASH, String(password)).catch(() => false);
      return res.status(401).json({ msg: INVALID_CREDENTIALS_MSG, error: INVALID_CREDENTIALS_MSG });
    }

    const ok = await user.comparePassword(String(password));
    if (!ok) {
      user.recordLoginFailure();
      await user.save();
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", targetId: user._id });
      return res.status(401).json({ msg: INVALID_CREDENTIALS_MSG, error: INVALID_CREDENTIALS_MSG });
    }

    if (isDeactivatedUser(user)) {
      return res.status(403).json({ error: DISABLED_ACCOUNT_MSG, msg: DISABLED_ACCOUNT_MSG });
    }

    const settings = await getAppSettings();
    if (settings?.maintenanceMode && String(user.role || "").toLowerCase() !== "admin") {
      return res.status(503).json({ msg: "The platform is in maintenance mode. Please try again soon." });
    }

    const status = user.status || "pending";
    const approvedFlag = isApprovedUser(user);
    if (!approvedFlag) {
      const msg =
        status === "pending"
          ? "Your account is still under review. We'll email you as soon as it's approved."
          : "Your application was not approved. Please contact support if you have questions.";
      return res.status(403).json({ msg });
    }

    let userChanged = ensureApprovedUserAuthReady(user);
    if (user.emailVerified !== true) {
      if (userChanged) await user.save();
      return res.status(403).json({ msg: EMAIL_NOT_VERIFIED_MSG, error: EMAIL_NOT_VERIFIED_MSG });
    }

    if (user._passwordNeedsRehash) {
      user.password = String(password);
      userChanged = true;
    }

    if (user.twoFactorEnabled && !TWO_FACTOR_ENABLED) {
      return res.status(503).json({ msg: "Two-step verification is temporarily unavailable. Please try again later." });
    }

    if (userChanged) {
      await user.save();
    }

    if (user.twoFactorEnabled && TWO_FACTOR_ENABLED) {
      const { challengeToken, code } = createTwoFactorChallenge(user);
      user.twoFactorExpiresAt = new Date(Date.now() + FIFTEEN_MIN);
      if (user.twoFactorMethod === "authenticator") {
        user.twoFactorTempCode = null;
        await user.save();
      } else {
        user.twoFactorTempCode = await bcrypt.hash(code, 10);
        await user.save();
        try {
          const html = buildTwoFactorEmailHtml(user, code);
          const text = `Your verification code is ${code}. This code expires in 15 minutes.`;
          await sendEmail(user.email, "Your verification code", html, { text });
        } catch (err) {
          authLogger.error("[2fa] email failed", err?.message || err);
          clearTwoFactorChallenge(user);
          await user.save();
          return res.status(500).json({ msg: "Unable to send verification code." });
        }
      }

      return res.json({
        twoFactorRequired: true,
        method: user.twoFactorMethod || "email",
        challengeToken,
        destination: user.twoFactorMethod === "authenticator" ? "your authenticator app" : maskEmail(user.email),
        passkeyAvailable: (await PasskeyCredential.exists({ userId: user._id })) !== null,
      });
    }

    await linkPendingGoogleIdentity(req, res, user);
    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    user.recordLoginSuccess();
    await user.save();
    await establishSession(req, res, user);
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        authLogger.warn("[auth] welcome notification failed", err?.message || err);
      }
    }

    return res.json({
      success: true,
      user: {
        _id: user._id,
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: user.status,
        state: user.state || "",
        location: user.location || "",
        stateExperience: Array.isArray(user.stateExperience) ? user.stateExperience : [],
        disabled: Boolean(user.disabled),
        isFirstLogin,
        onboarding: serializeOnboarding(user.onboarding || {}),
        pendingHire: serializePendingHire(user.pendingHire || {}),
        ...legalAcceptanceFields(user),
      },
    });
  })
);

router.post(
  "/2fa-verify",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !/^\d{6}$/.test(String(code || ""))) {
      return res.status(400).json({ error: "Invalid 2FA attempt." });
    }

    const user = await User.findOne({ twoFactorChallengeHash: hashOpaqueToken(challengeToken) })
      .select("+twoFactorTempCode +twoFactorExpiresAt +twoFactorChallengeHash +twoFactorFailedAttempts +authVersion +totpSecretEncrypted +totpLastUsedTimeStep");
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: "Invalid 2FA attempt." });
    }
    if (isDeactivatedUser(user)) {
      return res.status(403).json({ error: DISABLED_ACCOUNT_MSG, msg: DISABLED_ACCOUNT_MSG });
    }

    if (!isApprovedUser(user)) {
      clearTwoFactorChallenge(user);
      await user.save();
      return res.status(403).json({ error: "Account pending approval" });
    }

    ensureApprovedUserAuthReady(user);
    if (user.emailVerified !== true) {
      clearTwoFactorChallenge(user);
      await user.save();
      return res.status(403).json({ error: EMAIL_NOT_VERIFIED_MSG });
    }

    if (
      !user.twoFactorExpiresAt ||
      user.twoFactorExpiresAt < new Date() ||
      (user.twoFactorMethod === "authenticator" ? !user.totpSecretEncrypted : !user.twoFactorTempCode)
    ) {
      clearTwoFactorChallenge(user);
      await user.save();
      return res.status(400).json({ error: "Code expired." });
    }

    let match = false;
    let totpTimeStep = null;
    if (user.twoFactorMethod === "authenticator") {
      const totpResult = await verifyTotp({
        encryptedSecret: user.totpSecretEncrypted,
        token: code,
        afterTimeStep: Number.isInteger(user.totpLastUsedTimeStep) ? user.totpLastUsedTimeStep : undefined,
      });
      match = totpResult.valid === true;
      totpTimeStep = totpResult.timeStep;
    } else {
      match = await bcrypt.compare(String(code), user.twoFactorTempCode);
    }
    if (!match) {
      user.twoFactorFailedAttempts = Number(user.twoFactorFailedAttempts || 0) + 1;
      if (user.twoFactorFailedAttempts >= 5) {
        clearTwoFactorChallenge(user);
        await user.save();
        return res.status(429).json({ error: "Too many attempts. Sign in again to request a new code." });
      }
      await user.save();
      return res.status(400).json({ error: "Incorrect code." });
    }

    await linkPendingGoogleIdentity(req, res, user);
    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    clearTwoFactorChallenge(user);
    if (Number.isInteger(totpTimeStep)) user.totpLastUsedTimeStep = totpTimeStep;
    user.recordLoginSuccess();
    await user.save();

    await establishSession(req, res, user);
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        authLogger.warn("[auth] welcome notification failed", err?.message || err);
      }
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: user.status,
        state: user.state || "",
        location: user.location || "",
        stateExperience: Array.isArray(user.stateExperience) ? user.stateExperience : [],
        disabled: Boolean(user.disabled),
        isFirstLogin,
        onboarding: serializeOnboarding(user.onboarding || {}),
        pendingHire: serializePendingHire(user.pendingHire || {}),
        ...legalAcceptanceFields(user),
      },
    });
  })
);

router.post(
  "/passkeys/authentication-options",
  csrfProtection,
  asyncHandler(async (req, res) => {
    let userId = null;
    const challengeToken = String(req.body?.challengeToken || "");
    if (challengeToken) {
      const challengeUser = await User.findOne({ twoFactorChallengeHash: hashOpaqueToken(challengeToken) })
        .select("_id twoFactorEnabled +twoFactorExpiresAt");
      if (!challengeUser?.twoFactorEnabled || !challengeUser.twoFactorExpiresAt || challengeUser.twoFactorExpiresAt <= new Date()) {
        return res.status(400).json({ error: "Invalid sign-in challenge." });
      }
      userId = challengeUser._id;
    }
    const result = await createPasskeyAuthenticationOptions(req, { userId });
    if (userId && !result.available) {
      return res.status(404).json({ error: "No passkey is available for this account." });
    }
    res.json(result);
  })
);

router.post(
  "/passkeys/authenticate",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || "");
    let expectedUserId = null;
    let challengeUser = null;
    if (challengeToken) {
      challengeUser = await User.findOne({ twoFactorChallengeHash: hashOpaqueToken(challengeToken) })
        .select("+authVersion +twoFactorChallengeHash +twoFactorFailedAttempts +twoFactorExpiresAt");
      if (!challengeUser?.twoFactorEnabled || !challengeUser.twoFactorExpiresAt || challengeUser.twoFactorExpiresAt <= new Date()) {
        return res.status(400).json({ error: "Invalid sign-in challenge." });
      }
      expectedUserId = challengeUser._id;
    }

    let passkey;
    try {
      passkey = await verifyPasskeyAuthentication(req, {
        challengeId: req.body?.challengeId,
        response: req.body?.response,
        expectedUserId,
      });
    } catch (_error) {
      return res.status(400).json({ error: "Passkey verification failed or expired." });
    }
    const user = challengeUser || await User.findById(passkey.userId).select("+authVersion");
    if (!user || isDeactivatedUser(user) || !isApprovedUser(user)) {
      return res.status(403).json({ error: "This account cannot sign in." });
    }
    const settings = await getAppSettings();
    if (settings?.maintenanceMode && String(user.role || "").toLowerCase() !== "admin") {
      return res.status(503).json({ error: "The platform is in maintenance mode. Please try again soon." });
    }
    ensureApprovedUserAuthReady(user);
    if (user.emailVerified !== true) {
      return res.status(403).json({ error: EMAIL_NOT_VERIFIED_MSG });
    }
    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    if (challengeUser) clearTwoFactorChallenge(user);
    user.recordLoginSuccess();
    await user.save();
    await establishSession(req, res, user);
    await AuditLog.logFromReq(req, "auth.passkey.login.success", {
      targetType: "user",
      targetId: user._id,
      meta: { passkeyId: String(passkey._id) },
    });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        authLogger.warn("[auth] welcome notification failed", err?.message || err);
      }
    }
    res.json({
      success: true,
      user: {
        id: user._id,
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: user.status,
        isFirstLogin,
        onboarding: serializeOnboarding(user.onboarding || {}),
        pendingHire: serializePendingHire(user.pendingHire || {}),
        ...legalAcceptanceFields(user),
      },
    });
  })
);

router.post(
  "/2fa-backup",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !code) {
      return res.status(400).json({ error: "Invalid request." });
    }

    const user = await User.findOne({ twoFactorChallengeHash: hashOpaqueToken(challengeToken) })
      .select("+twoFactorChallengeHash +twoFactorFailedAttempts +twoFactorExpiresAt +twoFactorBackupCodes +authVersion");
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: "Invalid request." });
    }
    if (isDeactivatedUser(user)) {
      return res.status(403).json({ error: DISABLED_ACCOUNT_MSG, msg: DISABLED_ACCOUNT_MSG });
    }
    if (!isApprovedUser(user)) {
      return res.status(403).json({ error: "Account pending approval" });
    }

    ensureApprovedUserAuthReady(user);
    if (user.emailVerified !== true) {
      clearTwoFactorChallenge(user);
      await user.save();
      return res.status(403).json({ error: EMAIL_NOT_VERIFIED_MSG });
    }

    if (!user.twoFactorExpiresAt || user.twoFactorExpiresAt < new Date()) {
      clearTwoFactorChallenge(user);
      await user.save();
      return res.status(400).json({ error: "Sign-in challenge expired. Please sign in again." });
    }

    if (!Array.isArray(user.twoFactorBackupCodes) || user.twoFactorBackupCodes.length === 0) {
      return res.status(400).json({ error: "Invalid backup code." });
    }

    const suppliedCodeHash = hashOpaqueToken(String(code).trim().toUpperCase());
    const index = user.twoFactorBackupCodes.findIndex((hashed) => safeEqual(hashed, suppliedCodeHash));

    if (index === -1) {
      user.twoFactorFailedAttempts = Number(user.twoFactorFailedAttempts || 0) + 1;
      if (user.twoFactorFailedAttempts >= 5) {
        clearTwoFactorChallenge(user);
        await user.save();
        return res.status(429).json({ error: "Too many attempts. Sign in again to continue." });
      }
      await user.save();
      return res.status(400).json({ error: "Invalid backup code." });
    }

    await linkPendingGoogleIdentity(req, res, user);
    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    user.twoFactorBackupCodes.splice(index, 1);
    clearTwoFactorChallenge(user);
    user.recordLoginSuccess();
    await user.save();

    await establishSession(req, res, user);
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        authLogger.warn("[auth] welcome notification failed", err?.message || err);
      }
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: user.status,
        disabled: Boolean(user.disabled),
        isFirstLogin,
        onboarding: serializeOnboarding(user.onboarding || {}),
        pendingHire: serializePendingHire(user.pendingHire || {}),
        ...legalAcceptanceFields(user),
      },
    });
  })
);

// ----------------------------------------
// ME
// GET /api/auth/me  (reads Bearer token)
// ----------------------------------------
router.get(
  "/me",
  verifyToken.optional,
  asyncHandler(async (req, res) => {
    if (!req.user?.id) return res.json({ user: null });
    try {
      const u = await User.findById(req.user.id).lean();
      if (!u) return res.json({ user: null });
      if (isDeactivatedUser(u)) {
        return res.status(403).json({ error: DISABLED_ACCOUNT_MSG, msg: DISABLED_ACCOUNT_MSG });
      }
      const hasApprovedPhoto = hasPhotoReference(u, "approved");
      const hasPendingPhoto = hasPhotoReference(u, "pending");
      const publicPhotoReady =
        String(u.role || "").toLowerCase() === "paralegal" &&
        String(u.profilePhotoStatus || "").toLowerCase() === "approved" &&
        !hasPendingPhoto &&
        u.preferences?.hideProfile !== true &&
        hasRequiredParalegalFieldsForPublic(u);
      const approvedPhotoUrl = hasApprovedPhoto
        ? publicPhotoReady
          ? buildPublicProfilePhotoUrl(u)
          : buildAuthenticatedProfilePhotoUrl(u)
        : null;
      res.json({
        user: {
          id: u._id,
          role: u.role,
          email: u.email,
          pendingEmail: u.pendingEmail || "",
          pendingEmailRequestedAt: u.pendingEmailRequestedAt || null,
        firstName: u.firstName,
        lastName: u.lastName,
        avatarURL: approvedPhotoUrl,
        profileImage: approvedPhotoUrl,
        pendingProfileImage: hasPendingPhoto
          ? buildAuthenticatedProfilePhotoUrl(u, { variant: "pending" })
          : null,
        profilePhotoStatus: u.profilePhotoStatus || null,
        status: u.status,
        state: u.state || "",
        location: u.location || "",
          stateExperience: Array.isArray(u.stateExperience) ? u.stateExperience : [],
          disabled: Boolean(u.disabled),
          preferences: {
            theme:
              (u.preferences && typeof u.preferences === "object" && u.preferences.theme) ||
              "mountain",
            fontSize:
              (u.preferences && typeof u.preferences === "object" && u.preferences.fontSize) ||
              "md",
          },
          onboarding: serializeOnboarding(u.onboarding || {}),
          pendingHire: serializePendingHire(u.pendingHire || {}),
          ...legalAcceptanceFields(u),
        },
      });
    } catch (error) {
      throw error;
    }
  })
);

// ----------------------------------------
// LOGOUT (revokes the managed session and clears the cookie)
// POST /api/auth/logout
// ----------------------------------------
router.post("/logout", verifyToken.optional, csrfProtection, asyncHandler(async (req, res) => {
  if (req.authSessionId && req.user?.id) {
    await revokeSession(req.authSessionId, req.user.id, "logout");
  }
  res.clearCookie("token", buildAuthCookieOptions(req));
  res.json({ success: true });
}));

// ----------------------------------------
// EMAIL VERIFICATION (optional but handy)
// POST /api/auth/resend-verification
// POST /api/auth/verify-email  { token }
// ----------------------------------------
router.post(
  "/resend-verification",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const normalizedEmail = normalizeEmail(email);
    const user = await User.findOne({
      $or: [{ email: normalizedEmail }, { pendingEmail: normalizedEmail }],
    });
    if (!user) return res.json({ ok: true }); // don't reveal existence
    const isCurrentEmail = normalizeEmail(user.email) === normalizedEmail;
    const isPendingEmail = normalizeEmail(user.pendingEmail) === normalizedEmail;
    if (isCurrentEmail && user.emailVerified && !isPendingEmail) return res.json({ ok: true });

    try {
      await sendVerificationEmail({
        user,
        email: isPendingEmail ? user.pendingEmail : user.email,
      });
    } catch (error) {
      authLogger.warn("[auth] verification email resend failed", {
        userId: String(user._id),
        error: error?.message || String(error),
      });
    }

    await AuditLog.logFromReq(req, "auth.verify.resend", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/verify-email",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ msg: "Missing token" });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "verify-email" || !isObjId(payload.uid) || !isEmail(payload.email || "")) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid).select("+authVersion");
      if (!user) return res.status(404).json({ msg: "User not found" });
      const verifiedEmail = normalizeEmail(payload.email);
      const emailWillChange = normalizeEmail(user.pendingEmail) === verifiedEmail;
      if (!applyVerifiedEmail(user, verifiedEmail)) {
        return res.status(400).json({ msg: "Invalid or expired token" });
      }
      if (normalizeEmail(user.email) === verifiedEmail) {
        const collision = await User.exists({
          _id: { $ne: user._id },
          email: verifiedEmail,
        });
        if (collision) {
          return res.status(409).json({ msg: "Email already in use" });
        }
      }
      if (emailWillChange) user.authVersion = Number(user.authVersion || 0) + 1;
      await user.save();
      if (emailWillChange) {
        await revokeAllUserSessions(user._id, "email_change");
        res.clearCookie("token", buildAuthCookieOptions(req));
      }

      await AuditLog.logFromReq(req, "auth.verify.success", {
        targetType: "user",
        targetId: user._id,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ msg: "Invalid or expired token" });
    }
  })
);

// ----------------------------------------
// PASSWORD RESET (opaque, hashed, single-use token via email)
// POST /api/auth/request-password-reset { email }
// POST /api/auth/reset-password { token, newPassword }
// ----------------------------------------
router.post(
  "/request-password-reset",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // do not reveal

    const resetToken = createPasswordResetToken(user._id);
    user.resetPasswordTokenHash = hashOpaqueToken(resetToken);
    user.resetPasswordExpiresAt = new Date(Date.now() + RESET_PASSWORD_MINUTES * 60 * 1000);
    user.resetPasswordRequestedAt = new Date();
    await user.save();
    const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;
    try {
      const html = buildResetPasswordEmailHtml(user, resetUrl);
      const text = `Reset your password using this link: ${resetUrl}\nThis link expires in 60 minutes and can only be used once.`;
      await sendEmail(user.email, "Reset your password", html, { text });
    } catch (error) {
      authLogger.warn("[auth] password reset email delivery failed", {
        userId: String(user._id),
        error: error?.message || String(error),
      });
    }

    await AuditLog.logFromReq(req, "auth.password.reset.request", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/reset-password",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ msg: "Missing token or newPassword" });
    const separator = String(token).indexOf(".");
    const userId = separator > 0 ? String(token).slice(0, separator) : "";
    if (!isObjId(userId)) return res.status(400).json({ msg: "Invalid or expired token" });

    try {
      const user = await User.findById(userId)
        .select("+password +authVersion +resetPasswordTokenHash +resetPasswordExpiresAt +resetPasswordRequestedAt");
      if (
        !user ||
        !user.resetPasswordTokenHash ||
        !safeEqual(user.resetPasswordTokenHash, hashOpaqueToken(token)) ||
        !user.resetPasswordExpiresAt ||
        user.resetPasswordExpiresAt <= new Date()
      ) {
        return res.status(400).json({ msg: "Invalid or expired token" });
      }
      const passwordPolicy = validateNewPassword(newPassword, { user });
      if (!passwordPolicy.ok) return res.status(400).json({ msg: passwordPolicy.error, code: passwordPolicy.code });
      if (await user.comparePassword(passwordPolicy.password)) {
        return res.status(400).json({ msg: "Choose a password you have not already used for this account." });
      }

      const claimHash = `claimed:${crypto.randomBytes(32).toString("hex")}`;
      const claimed = await User.updateOne(
        {
          _id: user._id,
          resetPasswordTokenHash: user.resetPasswordTokenHash,
          resetPasswordExpiresAt: { $gt: new Date() },
        },
        {
          $set: { resetPasswordTokenHash: claimHash },
        }
      );
      if (claimed.modifiedCount !== 1) {
        return res.status(400).json({ msg: "Invalid or expired token" });
      }

      user.password = passwordPolicy.password;
      user.authVersion = Number(user.authVersion || 0) + 1;
      user.resetPasswordTokenHash = null;
      user.resetPasswordExpiresAt = null;
      user.resetPasswordRequestedAt = null;
      clearTwoFactorChallenge(user);
      await user.save();
      await revokeAllUserSessions(user._id, "password_reset");
      res.clearCookie("token", buildAuthCookieOptions(req));

      await AuditLog.logFromReq(req, "auth.password.reset.success", {
        targetType: "user",
        targetId: user._id,
      });

      res.json({ ok: true, reauthenticationRequired: true });
    } catch (e) {
      res.status(400).json({ msg: "Invalid or expired token" });
    }
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res, { field: "msg" })) return;
  const productionRuntime = process.env.NODE_ENV === "production" || process.env.PROD === "true";
  if (productionRuntime) {
    authLogger.error("Route failure", { name: err?.name || "Error" });
  } else {
    authLogger.error(err);
  }
  const payload = { msg: "Server error" };
  if (!productionRuntime) {
    payload.error = err?.message || "Unknown error";
  }
  res.status(500).json(payload);
});

module.exports = router;
