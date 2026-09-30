const { letterEmail } = require("../email/layout");
const { plainTextEmail } = require("../email/plainText");
// backend/utils/email.js
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { createLogger } = require("./logger");
const CONTACT_EMAIL = "help@lets-paraconnect.com";
const logger = createLogger("email");

// ----------------------------------------
// Transport setup
// ----------------------------------------
const PORT = Number(process.env.SMTP_PORT || 587);
const SECURE_ENV = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
const SECURE = SECURE_ENV || PORT === 465; // auto-secure if using 465

const hasAuth = !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
const hasHost = !!process.env.SMTP_HOST;
const emailDisabledAtStartup = String(process.env.EMAIL_DISABLE || "").toLowerCase() === "true";

if (!hasHost && !emailDisabledAtStartup) {
  logger.warn("SMTP_HOST is not configured; email delivery is unavailable.");
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: PORT,
  secure: SECURE,
  pool: true, // connection pooling helps under bursts
  maxConnections: Number(process.env.SMTP_MAX_CONN || 5),
  maxMessages: Number(process.env.SMTP_MAX_MSG || 100),
  // Retries belong to the persisted delivery owner. A pool must not silently
  // resend after a connection closes with an unknown acceptance outcome.
  maxRequeues: 0,
  auth: hasAuth
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : undefined,
  dkim: process.env.SMTP_DKIM_PKEY
    ? {
        domainName: process.env.SMTP_DKIM_DOMAIN,
        keySelector: process.env.SMTP_DKIM_SELECTOR,
        privateKey: process.env.SMTP_DKIM_PKEY,
      }
    : undefined,
  // timeouts
  socketTimeout: 20_000,
  greetingTimeout: 10_000,
  connectionTimeout: 10_000,
});

// one-time lazy verification (non-fatal)
let verifiedOnce = false;
async function verifyOnce() {
  if (verifiedOnce || process.env.EMAIL_SKIP_VERIFY === "true") return;
  try {
    await transporter.verify();
    verifiedOnce = true;
  } catch (e) {
    // Non-fatal; log and continue so app doesn’t crash at boot
    logger.warn("SMTP transport verification failed.", emailErrorMetadata(e));
  }
}

// ----------------------------------------
// Helpers
// ----------------------------------------
function sanitizeSubject(s) {
  // prevent header injection + trim length
  return String(s || "").replace(/[\r\n]/g, " ").trim().slice(0, 140);
}

function recipientCount(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return entries.map((entry) => String(entry || "").trim()).filter(Boolean).length;
}

function emailErrorMetadata(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    code: String(error?.code || "EMAIL_DELIVERY_FAILED").slice(0, 80),
    responseCode: Number.isFinite(Number(error?.responseCode)) ? Number(error.responseCode) : undefined,
    command: error?.command ? String(error.command).slice(0, 40) : undefined,
  };
}

function wrapHtml(html) {
  return letterEmail(html);
}

function defaultFrom() {
  const name = process.env.SMTP_FROM_NAME || "ParaConnect";
  let email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "admin@lets-paraconnect.com";
  if (String(email || "").toLowerCase() === "admin@letsparaconnect.com") {
    email = "admin@lets-paraconnect.com";
  }
  return `"${name}" <${email}>`;
}

// ----------------------------------------
// sendEmail API
//   sendEmail(to, subject, html, opts?)
//     - opts.text              plain text body (auto-generated if missing)
//     - opts.replyTo           string or { name, address }
//     - opts.cc, opts.bcc      string | string[]
//     - opts.attachments       nodemailer attachments array
//     - opts.headers           extra headers (object)
//     - opts.listUnsubscribe   URL or mailto for List-Unsubscribe header
//     - opts.throwOnError      boolean (default: false)
//     - opts.messageIdPrefix   string to prefix Message-ID
//     - returns info from nodemailer when successful
// ----------------------------------------
module.exports = async function sendEmail(to, subject, html, opts = {}) {
  const DISABLED = String(process.env.EMAIL_DISABLE || "").toLowerCase() === "true";
  if (DISABLED) {
    logger.debug("Email delivery skipped because EMAIL_DISABLE is enabled.", {
      recipientCount: recipientCount(to),
    });
    return { disabled: true };
  }

  const customSmtp = opts.smtp || null;
  const activeTransporter = customSmtp
    ? nodemailer.createTransport({
        host: customSmtp.host || process.env.SMTP_HOST,
        port: Number(customSmtp.port || process.env.SMTP_PORT || 587),
        secure:
          typeof customSmtp.secure === "boolean"
            ? customSmtp.secure
            : String(customSmtp.secure || process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
              Number(customSmtp.port || process.env.SMTP_PORT || 587) === 465,
        auth:
          customSmtp.user && customSmtp.pass
            ? {
                user: customSmtp.user,
                pass: customSmtp.pass,
              }
            : undefined,
        socketTimeout: 20_000,
        greetingTimeout: 10_000,
        connectionTimeout: 10_000,
      })
    : transporter;

  if (!customSmtp) {
    await verifyOnce();
  }

  const from = defaultFrom();
  const safeSubject = sanitizeSubject(subject);
  const hasText = typeof opts.text === "string" && opts.text.trim().length > 0;

  // Preserve readable paragraphs and action URLs for plain-text email clients.
  const textFallback = hasText ? opts.text : plainTextEmail(html);

  // Default headers
  const headers = Object.assign(
    {
      "X-Entity-Ref-ID": crypto.randomUUID(),
    },
    opts.headers || {}
  );

  // Optional List-Unsubscribe
  const unsubUrl = opts.listUnsubscribe || process.env.EMAIL_LIST_UNSUBSCRIBE_URL;
  if (unsubUrl) {
    headers["List-Unsubscribe"] = `<${unsubUrl}>`;
    // RFC encourages also including the Post header to suggest one-click
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  // Build message
  const message = {
    from: opts.from || from,
    to,
    subject: safeSubject,
    html: wrapHtml(html || ""),
    text: textFallback,
    headers,
    replyTo: opts.replyTo || CONTACT_EMAIL,
    cc: opts.cc,
    bcc: opts.bcc,
    attachments: Array.isArray(opts.attachments) ? opts.attachments : undefined,
    messageId: typeof opts.messageId === "string" && /^<[^<>\s]{1,250}>$/.test(opts.messageId) ? opts.messageId :
      opts.messageIdPrefix && typeof opts.messageIdPrefix === "string"
        ? `<${opts.messageIdPrefix}.${Date.now()}.${Math.random().toString(36).slice(2)}@paraconnect>`
        : undefined,
  };

  try {
    const info = await activeTransporter.sendMail(message);
    if (process.env.NODE_ENV !== "test") {
      logger.info("Email accepted by the configured transport.", {
        recipientCount: recipientCount(to),
        providerMessageIdPresent: Boolean(info.messageId),
      });
    }
    return info;
  } catch (err) {
    logger.error("Email delivery failed.", {
      recipientCount: recipientCount(to),
      ...emailErrorMetadata(err),
    });
    if (opts.throwOnError) throw err;
    return { error: true, message: err?.message || String(err) };
  }
};

// (optional) export transporter for tests/health checks
module.exports.transporter = transporter;

function escapeHtmlLite(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildVerificationEmail(_lastName, paragraphs = []) {
  const parts = [
    `<p>Hello,</p>`,
    ...paragraphs.map((text) => `<p>${escapeHtmlLite(text)}</p>`),
    `<p>If you have any questions, contact us at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`,
  ];
  return parts.join("");
}

function sendPendingReviewEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Thank you for submitting your application. Our review team is currently evaluating the information and materials you provided for Let’s-ParaConnect access.",
    "We will email you as soon as the review is complete.",
  ]);
}

function sendAdditionalInfoEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "We need more information to finish reviewing your application.",
    "Please reply to this email so we can confirm which materials are needed and how to submit them.",
  ]);
}

function sendAcceptedEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Your application is approved. Welcome to Let’s-ParaConnect!",
    "Sign in to finish your profile and keep your availability current.",
  ]);
}

function sendNotAcceptedEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Thank you for your interest in Let’s-ParaConnect. Your application was not approved at this time.",
    "If you have questions about the decision, please contact us.",
  ]);
}

async function sendWelcomePacket(user) {
  const email = user.email;

  const subject = "Your LPC application is approved";
  const body = `
  Hello,

  Congratulations — your application has been reviewed and approved.
  Welcome to Let’s-ParaConnect as an approved paralegal member.

  Your approval reflects the information and materials reviewed in your application.
  Sign in to complete your profile and keep your availability current for attorneys.

  `;

  if (!email) return;
  return module.exports(email, subject, body);
}

async function sendProfilePhotoRejectedEmail(user) {
  const email = user?.email;
  if (!email) return;

  const subject = "Action required: update your profile photo";
  const html = letterEmail(`<p>Hello,</p><p>Your profile photo was not approved. Please upload a clear photo with a plain or neutral background for review.</p><p>Sign in and open your profile settings to upload a replacement.</p>`);

  return module.exports(email, subject, html);
}

async function sendAccountDeactivatedEmail(user) {
  const email = user?.email;
  if (!email) return;
  const firstName = escapeHtmlLite(user?.firstName || "");

  const subject = "Your Let’s-ParaConnect account has been deactivated";
  const html = letterEmail(`<p>Account deactivated</p>
<p>${firstName ? `Hi ${firstName},<br><br>` : ""}
                Your Let&rsquo;s-ParaConnect account has been successfully deactivated.<br><br>
                You can no longer sign in. Contact support if you would like to request reactivation.<br><br>
                Deactivation does not delete your Matter history or payment records.</p>
<p>If you did not intend to deactivate your account, please contact us at <a href="mailto:help@lets-paraconnect.com" style="color:#1f1f1f;text-decoration:underline;">help@lets-paraconnect.com</a>.</p>`);

  return module.exports(email, subject, html);
}

module.exports.sendPendingReviewEmail = sendPendingReviewEmail;
module.exports.sendAdditionalInfoEmail = sendAdditionalInfoEmail;
module.exports.sendAcceptedEmail = sendAcceptedEmail;
module.exports.sendNotAcceptedEmail = sendNotAcceptedEmail;
module.exports.sendWelcomePacket = sendWelcomePacket;
module.exports.sendProfilePhotoRejectedEmail = sendProfilePhotoRejectedEmail;
module.exports.sendAccountDeactivatedEmail = sendAccountDeactivatedEmail;

async function sendVerificationEmail(user, code) {
  if (!user?.email) return;
  const safeCode = code || Math.random().toString(36).slice(2, 8).toUpperCase();
  const body = `Hi ${user.firstName || user.email},<br/><br/>Your Let’s-ParaConnect verification code is <strong>${safeCode}</strong>.<br/><br/>Enter this code in the app to confirm your email.`;
  try {
    await module.exports(user.email, "Verify your email", body);
  } catch (err) {
    logger.warn("Verification email delivery failed.", emailErrorMetadata(err));
  }
}

module.exports.sendVerificationEmail = sendVerificationEmail;

async function sendNotificationEmail(to, subject, body) {
  if (!to) return;
  try {
    await module.exports(to, subject || "Let’s-ParaConnect notification", body || "You have a new notification.");
  } catch (err) {
    logger.warn("Notification email delivery failed.", emailErrorMetadata(err));
  }
}

module.exports.sendNotificationEmail = sendNotificationEmail;
