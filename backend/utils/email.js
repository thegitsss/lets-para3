// backend/utils/email.js
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const CONTACT_EMAIL = "admin@lets-paraconnect.com";
const SIGNATURE = "Let’s-ParaConnect Verification Division";

// ----------------------------------------
// Transport setup
// ----------------------------------------
const PORT = Number(process.env.SMTP_PORT || 587);
const SECURE_ENV = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
const SECURE = SECURE_ENV || PORT === 465; // auto-secure if using 465

const hasAuth = !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
const hasHost = !!process.env.SMTP_HOST;

if (!hasHost) {
  console.warn("[email] SMTP_HOST not set; email sending will fail.");
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: PORT,
  secure: SECURE,
  pool: true, // connection pooling helps under bursts
  maxConnections: Number(process.env.SMTP_MAX_CONN || 5),
  maxMessages: Number(process.env.SMTP_MAX_MSG || 100),
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
    console.warn("[email] transport verify failed:", e?.message || e);
  }
}

// ----------------------------------------
// Helpers
// ----------------------------------------
function sanitizeSubject(s) {
  // prevent header injection + trim length
  return String(s || "").replace(/[\r\n]/g, " ").trim().slice(0, 140);
}

function wrapHtml(html) {
  // keep your brandy wrapper (backwards compatible)
  return `<div style="font-family: Georgia, serif; font-size:16px; color:#5c4e3a;">${html}</div>`;
}

function defaultFrom() {
  const name = process.env.SMTP_FROM_NAME || "ParaConnect";
  const email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "admin@lets-paraconnect.com";
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
    console.log(`[email] disabled (EMAIL_DISABLE=true). Pretending to send to ${to} :: ${subject}`);
    return { disabled: true };
  }

  await verifyOnce();

  const from = defaultFrom();
  const safeSubject = sanitizeSubject(subject);
  const hasText = typeof opts.text === "string" && opts.text.trim().length > 0;

  // Very simple HTML→text fallback if none provided
  const textFallback = hasText
    ? opts.text
    : String(html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>\s*<p>/gi, "\n\n")
        .replace(/<\/?[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();

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
    from,
    to,
    subject: safeSubject,
    html: wrapHtml(html || ""),
    text: textFallback,
    headers,
    replyTo: opts.replyTo,
    cc: opts.cc,
    bcc: opts.bcc,
    attachments: Array.isArray(opts.attachments) ? opts.attachments : undefined,
    messageId:
      opts.messageIdPrefix && typeof opts.messageIdPrefix === "string"
        ? `<${opts.messageIdPrefix}.${Date.now()}.${Math.random().toString(36).slice(2)}@paraconnect>`
        : undefined,
  };

  try {
    const info = await transporter.sendMail(message);
    if (process.env.NODE_ENV !== "test") {
      console.log(`✅ Email sent to ${to} (id: ${info.messageId || "n/a"})`);
    }
    return info;
  } catch (err) {
    console.error(`❌ Email error to ${to}:`, err?.message || err);
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

function buildVerificationEmail(lastName, paragraphs = []) {
  const safeName = escapeHtmlLite((lastName || "Applicant").trim() || "Applicant");
  const parts = [
    `<p>Dear Ms./Mr. ${safeName},</p>`,
    ...paragraphs.map((text) => `<p>${escapeHtmlLite(text)}</p>`),
    `<p>If you have any questions, contact us at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`,
    `<p>${SIGNATURE}</p>`,
  ];
  return parts.join("");
}

function sendPendingReviewEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Thank you for submitting your application. Our verification team is currently reviewing your credentials for the Let’s-ParaConnect elite paralegal professional collective.",
    "We will email you as soon as the review is complete.",
  ]);
}

function sendAdditionalInfoEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Thank you for your continued interest in Let’s-ParaConnect.",
    "We require additional documentation to complete your verification. Please reply to this email with the requested materials so we can finalize your review.",
  ]);
}

function sendAcceptedEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Congratulations! Your application has been approved and you have been accepted into the Let’s-ParaConnect elite paralegal professional collective.",
    "We will send onboarding instructions as we approach the official platform launch.",
  ]);
}

function sendNotAcceptedEmail(lastName) {
  const body = buildVerificationEmail(lastName, [
    "Thank you for your interest in joining Let’s-ParaConnect.",
    "Your application has been reviewed and was not approved at this time. Currently, we are only accepting paralegals who have a minimum of one year of professional paralegal experience and who are based in the United States.",
    "Our team reviews every submission carefully, and if you believe we may have missed important information in your application, you’re welcome to reply to this email.",
    "Thank you again for your interest in the community.",
  ]);
  return `${body}<p>For more information about our admissions process, please see our <a href="/paralegal-admission.html">Paralegal Admission Requirements</a>.</p>`;
}

async function sendWelcomePacket(user) {
  const lastName = user.lastName || "";
  const email = user.email;

  const subject = "Welcome to Let’s-ParaConnect — Acceptance Packet";
  const body = `
  Dear Ms./Mr. ${lastName},

  Congratulations — your application has been meticulously reviewed and approved.
  We would like to welcome you to Let’s-ParaConnect as one of our vetted,
  elite paralegals.

  Your acceptance signifies trust in your professionalism, verified credentials,
  and commitment to excellence. Your profile will appear to attorneys upon launch.

  Respectfully,
  Let’s-ParaConnect Verification Division
  `;

  if (!email) return;
  return module.exports(email, subject, body);
}

async function sendProfilePhotoRejectedEmail(user, opts = {}) {
  const email = user?.email;
  if (!email) return;
  const lastName = user?.lastName || "";
  const baseUrl =
    (opts.profileSettingsUrl && String(opts.profileSettingsUrl).trim()) ||
    (process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || "https://www.lets-paraconnect.com");
  const assetBase = String(baseUrl).replace(/\/+$/, "").replace(/\/profile-settings\.html$/, "");
  const logoUrl = `${assetBase}/Cleanfav.png`;
  const loginUrl = `${assetBase}/login.html`;

  const subject = "Action required: update your profile photo";
  const html = `
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
            <td align="center" style="padding:8px 40px 24px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:15px;letter-spacing:0.04em;color:#1f1f1f;line-height:1.6;text-align:left;">
                Hi &mdash;<br><br>
                Thank you for completing your profile. Before we publish it, we just need a different photo selected for your attorney-facing profile.<br><br>
                If helpful, many paralegals choose to use the same photo they have on LinkedIn.<br><br>
                We&rsquo;re excited to have you as part of the early group joining the platform.<br><br>
                Once that&rsquo;s done, we&rsquo;ll take care of the rest.<br><br>
                Best,<br>
                Let&rsquo;s-ParaConnect Team
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 28px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="#ffbd59" style="border-radius:999px;">
                    <a href="${loginUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 32px;font-family:Georgia, 'Times New Roman', serif;font-size:22px;color:#ffffff;text-decoration:none;">
                      Login
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

  return module.exports(email, subject, html);
}

module.exports.sendPendingReviewEmail = sendPendingReviewEmail;
module.exports.sendAdditionalInfoEmail = sendAdditionalInfoEmail;
module.exports.sendAcceptedEmail = sendAcceptedEmail;
module.exports.sendNotAcceptedEmail = sendNotAcceptedEmail;
module.exports.sendWelcomePacket = sendWelcomePacket;
module.exports.sendProfilePhotoRejectedEmail = sendProfilePhotoRejectedEmail;

async function sendVerificationEmail(user, code) {
  if (!user?.email) return;
  const safeCode = code || Math.random().toString(36).slice(2, 8).toUpperCase();
  const body = `Hi ${user.firstName || user.email},<br/><br/>Your Let’s-ParaConnect verification code is <strong>${safeCode}</strong>.<br/><br/>Enter this code in the app to confirm your email.`;
  try {
    await module.exports(user.email, "Verify your email", body);
  } catch (err) {
    console.warn("[email] verification email placeholder failed", err?.message || err);
  }
}

async function sendVerificationSMS(phone, code) {
  console.log(`[sms] Placeholder verification SMS to ${phone || "unknown"}: ${code || "000000"}`);
}

module.exports.sendVerificationEmail = sendVerificationEmail;
module.exports.sendVerificationSMS = sendVerificationSMS;

async function sendNotificationEmail(to, subject, body) {
  if (!to) return;
  try {
    await module.exports(to, subject || "Let’s-ParaConnect notification", body || "You have a new notification.");
  } catch (err) {
    console.warn("[email] notification email failed", err?.message || err);
  }
}

function sendNotificationSMS(phone, message) {
  if (!phone) return;
  console.log(`[sms] Notification to ${phone}: ${message || "You have a new notification."}`);
}

module.exports.sendNotificationEmail = sendNotificationEmail;
module.exports.sendNotificationSMS = sendNotificationSMS;
