// backend/routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const path = require("path");
const axios = require("axios");
const { URLSearchParams } = require("url");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const User = require("../models/User");
const Notification = require("../models/Notification");
const AuditLog = require("../models/AuditLog"); // audit trail hooks
const sendEmail = require("../utils/email");
const { getAppSettings } = require("../utils/appSettings");

const IS_PROD = process.env.NODE_ENV === "production" || process.env.PROD === "true";
const TWO_FACTOR_ENABLED = String(process.env.ENABLE_TWO_FACTOR || "").toLowerCase() === "true";
const EMAIL_BASE_URL = (process.env.EMAIL_BASE_URL || "").replace(/\/+$/, "");
const ASSET_BASE_URL = EMAIL_BASE_URL || "https://www.lets-paraconnect.com";
const LOGIN_URL = `${ASSET_BASE_URL}/login.html`;
function resolveCookieDomain(req) {
  if (!IS_PROD || !process.env.COOKIE_DOMAIN) return {};
  const domain = process.env.COOKIE_DOMAIN;
  const normalized = domain.replace(/^\./, "");
  if (req?.hostname && normalized && !req.hostname.endsWith(normalized)) return {};
  return { domain };
}

function buildAuthCookieOptions(req, { maxAge } = {}) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const isSecureRequest = Boolean(req?.secure) || forwardedProto === "https";
  const sameSite = isSecureRequest ? "none" : "lax";
  const secure = IS_PROD ? isSecureRequest : false;
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    ...resolveCookieDomain(req),
    ...(typeof maxAge === "number" ? { maxAge } : {}),
  };
}
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

function buildResetPasswordEmailHtml(user, resetUrl, opts = {}) {
  const logoUrl = opts.logoUrl || `${ASSET_BASE_URL}/Cleanfav.png`;
  const heroUrl = `${ASSET_BASE_URL}/hero-mountain.jpg`;
  const token = buildUnsubscribeToken(user);
  const unsubscribeUrl = token ? `${ASSET_BASE_URL}/public/unsubscribe?token=${encodeURIComponent(token)}` : "";
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#f6f5f1;text-decoration:underline;">Unsubscribe</a>`
    : "Unsubscribe";

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
                to choose a new one. This link expires in 48 hours.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 16px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#ffbd59" style="border-radius:999px;">
                    <a href="${resetUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 32px;font-family:Georgia, 'Times New Roman', serif;font-size:22px;color:#ffffff;text-decoration:none;">
                      Reset password
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
                No longer want to receive these emails? ${unsubscribeLine}
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
    ? `<a href="${unsubscribeUrl}" style="color:#f6f5f1;text-decoration:underline;">Unsubscribe</a>`
    : "Unsubscribe";

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
                Thank you for applying to Let’s-ParaConnect. Our verification team is reviewing your credentials,
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
                We’re onboarding paralegals first to ensure profiles and payouts are fully ready as attorneys join.
                If you have questions, reply to this email and our team will help.
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
                No longer want to receive these emails? ${unsubscribeLine}
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
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;
const RESET_PASSWORD_MINUTES = 48 * 60;
const DISABLED_ACCOUNT_MSG = "This account has been disabled.";
const BOT_NAME_GIBBERISH = /^[bcdfghjklmnpqrstvwxyz]{6,}$/;
const BOT_REPEATED = /(.)\1{3,}/;
const BOT_FORBIDDEN_CHARS = /[{}[\]|\\^<>]/;
const PARA_WELCOME_TITLE = "Welcome to Let's-ParaConnect - we're excited to have you.";
const PARA_WELCOME_BODY =
  "We're currently onboarding qualified paralegals as we prepare the platform for attorneys. " +
  "Opportunities will begin appearing as attorney onboarding expands. In the meantime, feel free to complete your profile and upload credentials — we’ll notify you as jobs become available.";

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
}

function signAccess(user) {
  const approved = String(user.status || "").toLowerCase() === "approved";
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
    approved,
  };
  const opts = { expiresIn: TWO_HOURS };
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return jwt.sign(payload, process.env.JWT_SECRET, opts);
}

function signOneTime(payload, { minutes = 30, secretEnv = "JWT_SECRET" } = {}) {
  const expSeconds = Math.floor(Date.now() / 1000) + minutes * 60;
  return jwt.sign({ ...payload, exp: expSeconds }, process.env[secretEnv]);
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
  const secret = process.env.TURNSTILE_SECRET || "";
  if (!secret) {
    return { success: false, errorCodes: ["missing-secret"] };
  }
  if (!token) {
    return { success: false, errorCodes: ["missing-token"] };
  }
  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    if (remoteIp) params.append("remoteip", remoteIp);
    const { data } = await axios.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", params);
    return data || { success: false };
  } catch (err) {
    console.error("[turnstile] verify error", err?.message || err);
    return { success: false, errorCodes: ["verify-error"] };
  }
}

// ----------------------------------------
// REGISTER
// POST /api/auth/register
// ----------------------------------------
router.post(
  "/register",
  registrationUpload.fields([
    { name: "resume", maxCount: 1 },
    { name: "resumeFile", maxCount: 1 },
    { name: "certificateFile", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const bypassList = (process.env.DEV_BYPASS_EMAILS || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
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
      resumeURL,
      certificateURL,
      turnstileToken,
      captchaToken,
      recaptchaToken,
      termsAccepted,
      phoneNumber,
      barState,
      state,
      timezone,
      yearsExperience,
    } = req.body || {};

    const settings = await getAppSettings();
    if (settings?.maintenanceMode) {
      return res.status(503).json({ msg: "Signups are temporarily unavailable during maintenance." });
    }
    if (settings?.allowSignups === false) {
      return res.status(403).json({ msg: "Signups are temporarily paused." });
    }

    const normalizedEmail = String(email || "").toLowerCase().trim();
    const bypassCaptcha = normalizedEmail && bypassList.includes(normalizedEmail);

    const resolvedTurnstileToken =
      turnstileToken ||
      req.body?.["cf-turnstile-response"] ||
      req.body?.cfTurnstileResponse ||
      captchaToken ||
      recaptchaToken;
    if (!bypassCaptcha && enforceTurnstile && process.env.NODE_ENV === "production") {
      if (!resolvedTurnstileToken || !process.env.TURNSTILE_SECRET) {
        return res.status(400).json({ error: "Turnstile verification failed" });
      }
      const verification = await verifyTurnstile(resolvedTurnstileToken, req.ip);
      if (!verification?.success) {
        console.warn("[turnstile] signup verify failed", verification?.["error-codes"] || verification?.errorCodes);
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

    if (!termsAccepted) {
      return res.status(400).json({ msg: "Terms of Use must be accepted." });
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
    if (!password || String(password).length < 8) {
      return res
        .status(400)
        .json({ msg: "Password must be at least 8 characters." });
    }

    const normalizedBarState =
      typeof barState === "string" ? barState.trim().toUpperCase() : "";
    const normalizedBarNumber = String(barNumber || "").trim();
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
    }

    const resumeFile = req.files?.resume?.[0] || req.files?.resumeFile?.[0] || null;
    const certificateFile = req.files?.certificateFile?.[0] || null;

    // Paralegals must attach a PDF resume at signup
    if (roleLc === "paralegal" && !resumeFile) {
      return res.status(400).json({ msg: "Résumé file is required for paralegal registration." });
    }

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      if (existing.deleted) {
        await User.deleteOne({ _id: existing._id, deleted: true });
      } else {
        return res.status(400).json({ msg: "User already exists" });
      }
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
      password: String(password),
      role: roleLc,
      status: "pending",
      barNumber: roleLc === "attorney" ? String(barNumber || "") : "",
      resumeURL: roleLc === "paralegal" ? "" : "",
      certificateURL: roleLc === "paralegal" ? String(certificateURL || "") : "",
      linkedInURL: linkedInURL ? String(linkedInURL).trim() : "",
      lawFirm: roleLc === "attorney" ? (String(lawFirm || "").trim() || null) : null,
      termsAccepted: true,
      phoneNumber: phoneNumber ? String(phoneNumber).trim() || null : null,
      state: normalizedState,
      timezone: safeTimezone || undefined,
      yearsExperience: roleLc === "paralegal" ? safeYearsExperience : undefined,
    });

    if (roleLc === "attorney" && normalizedBarState) {
      user.location = normalizedBarState;
    } else if (roleLc === "paralegal" && normalizedState) {
      user.location = normalizedState;
    }

    // Upload resume (paralegal) before saving
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
      user.certificateURL = key;
    }

    await user.save();

    // Email: registration received + email verification link (optional but nice)
    try {
      const verifyToken = signOneTime(
        { purpose: "verify-email", uid: user._id.toString() },
        { minutes: 60, secretEnv: "JWT_SECRET" }
      );
      const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
      const inlineLogoPath = path.join(__dirname, "../../frontend/Cleanfav.png");
      const html = buildApplicationSubmissionEmailHtml(user, { logoUrl: "cid:cleanfav-logo" });
      await sendEmail(user.email, "Registration received", html, {
        attachments: [
          {
            filename: "Cleanfav.png",
            path: inlineLogoPath,
            cid: "cleanfav-logo",
          },
        ],
      });
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.register", {
      targetType: "user",
      targetId: user._id,
      meta: { role: user.role },
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
      console.warn("[auth] admin signup email failed", err?.message || err);
    }

    res.json({ msg: "Registered successfully. Await admin approval." });
  })
);

// ----------------------------------------
// LOGIN
// POST /api/auth/login  -> returns { token, user }
// ----------------------------------------
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const enforceTurnstile = String(process.env.TURNSTILE_ENFORCED || "true").toLowerCase() === "true";

    if (IS_PROD && enforceTurnstile) {
      const turnstileToken =
        req.body?.turnstileToken ||
        req.body?.["cf-turnstile-response"] ||
        req.body?.cfTurnstileResponse ||
        req.body?.recaptchaToken ||
        req.body?.recaptcha ||
        "";
      if (!process.env.TURNSTILE_SECRET) {
        return res.status(500).json({ error: "Turnstile is not configured." });
      }
      if (!turnstileToken) {
        return res.status(400).json({ error: "Turnstile verification failed" });
      }

      const verification = await verifyTurnstile(turnstileToken, req.ip);
      if (!verification?.success) {
        console.warn("[turnstile] login verify failed", verification?.["error-codes"] || verification?.errorCodes);
        return res.status(400).json({ error: "Turnstile verification failed" });
      }
    }

    if (!isEmail(email) || !password) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    // IMPORTANT: password is select:false in schema, so we MUST include it
    const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!user) {
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", meta: { email } });
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    if (user.disabled) {
      return res.status(403).json({ error: DISABLED_ACCOUNT_MSG, msg: DISABLED_ACCOUNT_MSG });
    }

    const settings = await getAppSettings();
    if (settings?.maintenanceMode && String(user.role || "").toLowerCase() !== "admin") {
      return res.status(503).json({ msg: "The platform is in maintenance mode. Please try again soon." });
    }

    const status = user.status || "pending";
    const approvedFlag = status === "approved";
    if (!approvedFlag) {
      const msg =
        status === "pending"
          ? "Your application is still pending admin approval."
          : "Your application was not approved. Please contact support if you have questions.";
      return res.status(403).json({ msg });
    }

    const ok = await user.comparePassword(String(password));
    if (!ok) {
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", targetId: user._id });
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    if (user._passwordNeedsRehash) {
      user.password = String(password);
    }

    if (user.twoFactorEnabled && !TWO_FACTOR_ENABLED) {
      user.twoFactorEnabled = false;
      user.twoFactorMethod = "email";
      user.twoFactorTempCode = null;
      user.twoFactorExpiresAt = null;
      user.twoFactorBackupCodes = [];
      await user.save();
    }

    if (user.twoFactorEnabled && TWO_FACTOR_ENABLED) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const hashed = await bcrypt.hash(code, 10);
      user.twoFactorTempCode = hashed;
      user.twoFactorExpiresAt = new Date(Date.now() + FIFTEEN_MIN);
      await user.save();

      try {
        const html = buildTwoFactorEmailHtml(user, code);
        const text = `Your verification code is ${code}. This code expires in 15 minutes.`;
        await sendEmail(user.email, "Your verification code", html, { text });
      } catch (err) {
        console.error("[2fa] email failed", err?.message || err);
        user.twoFactorTempCode = null;
        user.twoFactorExpiresAt = null;
        await user.save();
        return res.status(500).json({ msg: "Unable to send verification code." });
      }

      return res.json({
        twoFactorRequired: true,
        method: user.twoFactorMethod || "email",
        email: user.email,
      });
    }

    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    user.recordLoginSuccess();
    await user.save();
    const token = signAccess(user);
    res.cookie("token", token, buildAuthCookieOptions(req, { maxAge: TWO_HOURS_MS }));
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        console.warn("[auth] welcome notification failed", err?.message || err);
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
      },
    });
  })
);

router.post(
  "/2fa-verify",
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const { email, code } = req.body || {};
    if (!isEmail(email) || !code) {
      return res.status(400).json({ error: "Invalid 2FA attempt." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() })
      .select("+twoFactorTempCode +twoFactorExpiresAt");
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: "Invalid 2FA attempt." });
    }

    if (!user.twoFactorTempCode || !user.twoFactorExpiresAt || user.twoFactorExpiresAt < new Date()) {
      return res.status(400).json({ error: "Code expired." });
    }

    const match = await bcrypt.compare(String(code), user.twoFactorTempCode);
    if (!match) {
      return res.status(400).json({ error: "Incorrect code." });
    }

    const approvedFlag = String(user.status || "").toLowerCase() === "approved";
    if (!approvedFlag) {
      user.twoFactorTempCode = null;
      user.twoFactorExpiresAt = null;
      await user.save();
      return res.status(403).json({ error: "Account pending approval" });
    }

    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    user.twoFactorTempCode = null;
    user.twoFactorExpiresAt = null;
    user.recordLoginSuccess();
    await user.save();

    const token = signAccess(user);
    res.cookie("token", token, buildAuthCookieOptions(req, { maxAge: TWO_HOURS_MS }));
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        console.warn("[auth] welcome notification failed", err?.message || err);
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
      },
    });
  })
);

router.post(
  "/2fa-backup",
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const { email, code } = req.body || {};
    if (!isEmail(email) || !code) {
      return res.status(400).json({ error: "Invalid request." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: "Invalid request." });
    }

    if (!Array.isArray(user.twoFactorBackupCodes) || user.twoFactorBackupCodes.length === 0) {
      return res.status(400).json({ error: "No backup codes available." });
    }

    const matchIndex = await Promise.all(
      user.twoFactorBackupCodes.map(async (hashed) => bcrypt.compare(String(code), hashed))
    );
    const index = matchIndex.findIndex(Boolean);

    if (index === -1) {
      return res.status(400).json({ error: "Invalid backup code." });
    }

    const lastLoginAt = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
    const approvedAt = user.approvedAt ? new Date(user.approvedAt) : null;
    const isFirstLogin = !lastLoginAt || (approvedAt && lastLoginAt < approvedAt);
    user.twoFactorBackupCodes.splice(index, 1);
    user.twoFactorTempCode = null;
    user.twoFactorExpiresAt = null;
    user.recordLoginSuccess();
    await user.save();

    const token = signAccess(user);
    res.cookie("token", token, buildAuthCookieOptions(req, { maxAge: TWO_HOURS_MS }));
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });
    if (isFirstLogin) {
      try {
        await ensureParalegalWelcomeNotification(user);
      } catch (err) {
        console.warn("[auth] welcome notification failed", err?.message || err);
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
  asyncHandler(async (req, res) => {
    const hdr = req.headers.authorization || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const cookieToken =
      req.cookies?.token ||
      req.cookies?.[process.env.JWT_COOKIE_NAME || "access"];
    const token = cookieToken || bearer;
    if (!token) return res.json({ user: null });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      // freshen user info (role/status might have changed)
      const u = await User.findById(payload.id).lean();
      if (!u) return res.json({ user: null });
      if (u.disabled) {
        return res.status(403).json({ error: DISABLED_ACCOUNT_MSG });
      }
      res.json({
        user: {
          id: u._id,
          role: u.role,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarURL: u.avatarURL || null,
          profileImage: u.profileImage || null,
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
        },
      });
    } catch {
      res.json({ user: null });
    }
  })
);

// ----------------------------------------
// LOGOUT (stateless JWT – client deletes token)
// POST /api/auth/logout
// ----------------------------------------
router.post("/logout", (req, res) => {
  res.clearCookie("token", buildAuthCookieOptions(req));
  res.json({ success: true });
});

// ----------------------------------------
// EMAIL VERIFICATION (optional but handy)
// POST /api/auth/resend-verification
// POST /api/auth/verify-email  { token }
// ----------------------------------------
router.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // don't reveal existence
    if (user.emailVerified) return res.json({ ok: true });

    try {
      const verifyToken = signOneTime(
        { purpose: "verify-email", uid: user._id.toString() },
        { minutes: 60, secretEnv: "JWT_SECRET" }
      );
      const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
      await sendEmail(user.email, "Verify your email", `Click to verify: ${verifyUrl}`);
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.verify.resend", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ msg: "Missing token" });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "verify-email" || !isObjId(payload.uid)) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid);
      if (!user) return res.status(404).json({ msg: "User not found" });
      user.markEmailVerified?.();
      await user.save();

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
// PASSWORD RESET (stateless token via email)
// POST /api/auth/request-password-reset { email }
// POST /api/auth/reset-password { token, newPassword }
// ----------------------------------------
router.post(
  "/request-password-reset",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // do not reveal

    const resetToken = signOneTime(
      { purpose: "reset-password", uid: user._id.toString() },
      { minutes: RESET_PASSWORD_MINUTES, secretEnv: "JWT_SECRET" }
    );
    const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;
    try {
      const inlineLogoPath = path.join(__dirname, "../../frontend/Cleanfav.png");
      const html = buildResetPasswordEmailHtml(user, resetUrl, { logoUrl: "cid:cleanfav-logo" });
      const text = `Reset your password using this link: ${resetUrl}\nThis link expires in 48 hours.`;
      await sendEmail(user.email, "Reset your password", html, {
        text,
        attachments: [
          {
            filename: "Cleanfav.png",
            path: inlineLogoPath,
            cid: "cleanfav-logo",
          },
        ],
      });
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.password.reset.request", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ msg: "Missing token or newPassword" });
    if (String(newPassword).length < 8) return res.status(400).json({ msg: "Password must be at least 8 characters." });

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "reset-password" || !isObjId(payload.uid)) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid).select("+password");
      if (!user) return res.status(404).json({ msg: "User not found" });

      // Assign; hashing handled by model pre-save
      user.password = String(newPassword);
      await user.save();

      await AuditLog.logFromReq(req, "auth.password.reset.success", {
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
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
});

module.exports = router;
