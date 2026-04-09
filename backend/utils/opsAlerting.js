"use strict";

const sendEmail = require("./email");

function parseRecipients(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getOwnerAlertRecipients() {
  const explicit = parseRecipients(
    process.env.OWNER_ALERT_EMAILS ||
      process.env.ALERT_EMAIL_TO ||
      process.env.OWNER_EMAIL ||
      process.env.ADMIN_EMAIL
  );
  if (explicit.length) return explicit;
  const fallback = String(process.env.SMTP_FROM_EMAIL || "").trim();
  return fallback ? [fallback] : [];
}

async function sendOwnerAlert(subject, lines = [], opts = {}) {
  const recipients = getOwnerAlertRecipients();
  if (!recipients.length) {
    return { skipped: true, reason: "missing_recipients" };
  }

  const safeLines = Array.isArray(lines)
    ? lines.map((line) => String(line || "").trim()).filter(Boolean)
    : [String(lines || "").trim()].filter(Boolean);
  const html = safeLines.length
    ? safeLines.map((line) => `<p>${line}</p>`).join("")
    : "<p>No additional details.</p>";

  const result = await sendEmail(recipients.join(","), subject, html, {
    throwOnError: false,
    headers: { "X-LPC-Ops-Alert": "true" },
    messageIdPrefix: "ops-alert",
    ...opts,
  });

  return {
    skipped: false,
    recipients,
    result,
  };
}

module.exports = {
  getOwnerAlertRecipients,
  sendOwnerAlert,
};
