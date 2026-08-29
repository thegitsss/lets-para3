// backend/utils/email.js
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { createLogger } = require("./logger");
const CONTACT_EMAIL = "help@lets-paraconnect.com";
const SIGNATURE = "Let’s-ParaConnect";
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
  // keep your brandy wrapper (backwards compatible)
  return `<div style="font-family: Georgia, serif; font-size:16px; color:#5c4e3a;">${html}</div>`;
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
    messageId:
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
    "Thank you for submitting your application. Our review team is currently evaluating the information and materials you provided for Let’s-ParaConnect access.",
    "We will email you as soon as the review is complete.",
  ]);
}

function sendAdditionalInfoEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Thank you for your continued interest in Let’s-ParaConnect.",
    "We require additional documentation to complete your application review. Please reply to this email with the requested materials so we can finalize the review.",
  ]);
}

function sendAcceptedEmail(lastName) {
  return buildVerificationEmail(lastName, [
    "Congratulations! Your application has been approved and your Let’s-ParaConnect profile can now be completed for platform use.",
    "Sign in to finish your profile and keep your availability current.",
  ]);
}

function sendNotAcceptedEmail(lastName) {
  const body = buildVerificationEmail(lastName, [
    "Thank you for your interest in joining Let’s-ParaConnect.",
    "Your application has been reviewed and was not approved at this time. Currently, we are only accepting paralegals who have a minimum of one year of professional paralegal experience and who are based in the United States.",
    "Our team reviews every submission carefully, and if you believe we may have missed important information in your application, you’re welcome to reply to this email.",
    "Thank you again for your interest in the community.",
  ]);
  return `${body}<p>For more information about our admissions process, please see the Our Vetting Process page.</p>`;
}

async function sendWelcomePacket(user) {
  const lastName = user.lastName || "";
  const email = user.email;

  const subject = "Welcome to Let’s-ParaConnect — Acceptance Packet";
  const body = `
  Dear Ms./Mr. ${lastName},

  Congratulations — your application has been reviewed and approved.
  Welcome to Let’s-ParaConnect as an approved paralegal member.

  Your approval reflects the information and materials reviewed in your application.
  Sign in to complete your profile and keep your availability current for attorneys.

  Respectfully,
  The Let’s-ParaConnect Team
  `;

  if (!email) return;
  return module.exports(email, subject, body);
}

async function sendProfilePhotoRejectedEmail(user, opts = {}) {
  const email = user?.email;
  if (!email) return;
  const baseUrl =
    (opts.profileSettingsUrl && String(opts.profileSettingsUrl).trim()) ||
    (process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || "https://www.lets-paraconnect.com");
  const assetBase = String(baseUrl).replace(/\/+$/, "").replace(/\/profile-settings\.html$/, "");
  const logoUrl = `${assetBase}/Cleanfav.png`;

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
                Please ensure your photo has a plain or neutral background. It helps keep profiles polished and consistent.<br><br>
                We&rsquo;re excited to have you as part of the early group joining the platform.<br><br>
                Once that&rsquo;s done, we&rsquo;ll take care of the rest.<br><br>
                Best,<br>
                Let&rsquo;s-ParaConnect Team
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

  return module.exports(email, subject, html);
}

async function sendAccountDeactivatedEmail(user, opts = {}) {
  const email = user?.email;
  if (!email) return;
  const firstName = user?.firstName || "";
  const baseUrl =
    (opts.baseUrl && String(opts.baseUrl).trim()) ||
    (process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || "https://www.lets-paraconnect.com");
  const assetBase = String(baseUrl).replace(/\/+$/, "").replace(/\/profile-settings\.html$/, "");
  const logoUrl = `${assetBase}/Cleanfav.png`;

  const subject = "Your Let’s-ParaConnect account has been deactivated";
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
            <td align="center" style="padding:8px 32px 0;">
              <div style="font-family:Georgia, 'Times New Roman', serif;font-size:34px;letter-spacing:0.06em;color:#6e6e6e;">
                Account deactivated
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 32px 0;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:16px;letter-spacing:0.08em;color:#1f1f1f;line-height:1.6;text-align:left;">
                ${firstName ? `Hi ${firstName},<br><br>` : ""}
                Your Let&rsquo;s-ParaConnect account has been successfully deactivated.<br><br>
                You will no longer be able to sign in or participate in active platform activity unless your account is reactivated by support.<br><br>
                Historical case, dispute, payment, audit, and related financial records have been preserved in accordance with platform policy. Deactivation does not reopen prior matters or change historical outcomes.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 28px;">
              <div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;letter-spacing:0.06em;color:#545454;line-height:1.6;text-align:left;">
                If you did not intend to deactivate your account, please contact us at <a href="mailto:help@lets-paraconnect.com" style="color:#1f1f1f;text-decoration:underline;">help@lets-paraconnect.com</a>.
              </div>
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
