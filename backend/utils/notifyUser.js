const { createLogger: createRuntimeLogger } = require("./logger");
const runtimeLogger = createRuntimeLogger("utils:notifyUser");
const Notification = require("../models/Notification");
const User = require("../models/User");
const sendEmail = require("./email");
const emailTemplates = require("../email/templates");
const { publishNotificationEvent } = require("./notificationEvents");
const { resolveMessageNotificationPolicy } = require("./messageNotificationPolicy");

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function subjectText(value = "", fallback = "LPC Update") {
  const normalized = String(value || fallback)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, 200);
}

function escapePayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload || {}).map(([key, value]) => [
      key,
      typeof value === "string" ? escapeHtml(value) : value,
    ])
  );
}

function buildDisplayMessage(type, payload = {}) {
  if (payload.message && typeof payload.message === "string") {
    return payload.message;
  }
  const actorName =
    payload.actorFirstName ||
    payload.actorName ||
    payload.fromName ||
    payload.inviterName ||
    payload.paralegalName ||
    payload.userName ||
    "";
  const caseTitle = payload.caseTitle || payload.caseName || "";

  switch (type) {
    case "message": {
      const snippet = payload.messageSnippet || payload.preview || "";
      const base = `${actorName || "Someone"} sent you a message${caseTitle ? ` about ${caseTitle}` : ""}`;
      return snippet ? `${base}: "${snippet}"` : base;
    }
    case "case_invite":
      return `${actorName || "An attorney"} invited you to ${caseTitle || "a Matter"}`;
    case "case_invite_response": {
      const response = String(payload.response || "").toLowerCase();
      if (response === "accepted") {
        return `${actorName || "The paralegal"} accepted your invitation${caseTitle ? ` for ${caseTitle}` : ""}. Confirm the hire and fund the Matter to get started.`.trim();
      }
      const verb = response === "declined" ? "declined" : "accepted";
      return `${actorName || "The paralegal"} ${verb} your invitation${caseTitle ? ` for ${caseTitle}` : ""}`.trim();
    }
    case "case_update":
      return payload.summary || `${actorName || "Someone"} updated ${caseTitle || "your Matter"}`;
    case "resume_uploaded":
      return "Your resume was uploaded successfully.";
    case "profile_approved":
      return "Your profile was approved.";
    case "profile_photo_approved":
      return "Your profile photo was approved.";
    case "profile_photo_rejected":
      return "Your profile photo was rejected. Please upload a new one that meets our photo guidelines, including a plain or neutral background.";
    case "payout_released":
      return "Your payout has been released to Stripe. Check your Stripe account for the current status and estimated arrival; timing depends on your payout schedule and financial institution.";
    case "application_submitted": {
      const paralegal = payload.paralegalName || actorName || "A paralegal";
      return `${paralegal} applied to ${caseTitle || "a Matter"}`.trim();
    }
    case "application_accepted":
      return `Your application for ${caseTitle || "the Matter"} was accepted.`;
    case "application_denied":
      return caseTitle
        ? `This role has been filled for ${caseTitle}.`
        : "This role has been filled.";
    case "case_awaiting_funding":
      return `${payload.caseTitle || "A Matter"} is awaiting funding`;
    case "case_work_ready":
      return `${payload.caseTitle || "A Matter"} is funded. Work can begin.`;
    case "pre_engagement_requested":
      return `${payload.caseTitle || "A Matter"} requires pre-engagement before hiring can continue.`;
    case "pre_engagement_submitted":
      return `${payload.caseTitle || "A Matter"} has a submitted pre-engagement response ready for review.`;
    case "pre_engagement_changes_requested":
      return `${payload.caseTitle || "A Matter"} needs updates to your pre-engagement response.`;
    case "case_file_uploaded": {
      const fileName = payload.fileName || "a document";
      return `${actorName || "Someone"} uploaded ${fileName}${caseTitle ? ` to ${caseTitle}` : ""}`.trim();
    }
    case "case_budget_locked":
      return `Matter amount locked${caseTitle ? ` for ${caseTitle}` : ""}.`.trim();
    case "case_deleted":
      return payload.message || "A Matter posting was removed by admin.";
    case "account_suspended":
      return payload.message || "Your account has been suspended.";
    case "dispute_opened":
      return `A review was opened for ${caseTitle || "a Matter"}.`;
    case "admin_review_overdue":
      return payload.message || "Our team is still reviewing this request and will follow up soon.";
    default:
      return "You have a new notification.";
  }
}

async function resolveActorSnapshot(actorUserId) {
  if (!actorUserId) {
    return { actorUserId: null, actorFirstName: "", actorProfileImage: "", actorRole: "" };
  }
  try {
    const actor = await User.findById(actorUserId).select("firstName profileImage avatarURL role");
    if (!actor) {
      return { actorUserId, actorFirstName: "", actorProfileImage: "", actorRole: "" };
    }
    return {
      actorUserId: actor._id,
      actorFirstName: actor.firstName || "",
      actorProfileImage: actor.profileImage || actor.avatarURL || "",
      actorRole: actor.role || "",
    };
  } catch (err) {
    runtimeLogger.warn("[notifyUser] actor lookup failed", err?.message || err);
    return { actorUserId, actorFirstName: "", actorProfileImage: "", actorRole: "" };
  }
}

function emailTemplate(type, payload = {}) {
  const safePayload = escapePayload(payload);
  switch (type) {
    case "message":
      return emailTemplates.newMessage(payload);
    case "case_invite":
      return emailTemplates.caseInvite(payload);
    case "case_update":
      return emailTemplates.caseUpdate(payload);
    case "resume_uploaded":
      return {
        subject: "Resume updated",
        html: "<p>Your resume has been successfully uploaded.</p>"
      };
    case "profile_approved":
      return emailTemplates.profileApproved();
    case "profile_photo_approved":
      return (() => {
        const baseUrl =
          process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || "https://www.lets-paraconnect.com";
        const assetBase = String(baseUrl).replace(/\/+$/, "").replace(/\/profile-settings\.html$/, "");
        const logoUrl = `${assetBase}/Cleanfav.png`;
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
                      Great news — your profile photo was approved and is now live on your attorney-facing profile.<br><br>
                      Your profile is now visible to attorneys. Log in anytime to make updates.<br><br>
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
        return {
          subject: "Profile photo approved",
          html,
        };
      })();
    case "profile_photo_rejected":
      return {
        subject: "Profile photo update needed",
        html: "<p>Your profile photo was rejected. Please upload a new one that meets our photo guidelines, including a plain or neutral background.</p>",
      };
    case "case_invite_response":
      return {
        subject: "Matter invitation update",
        html:
          payload.response === "accepted"
            ? `<p>${safePayload.paralegalName || "The invited paralegal"} accepted your invitation${
                safePayload.caseTitle ? ` for <strong>${safePayload.caseTitle}</strong>.` : "."
              }</p><p>Confirm the hire and fund the Matter to get started.</p>`
            : payload.response === "filled"
            ? `<p>The position for <strong>${safePayload.caseTitle || "this Matter"}</strong> has been filled.</p>`
            : `<p>${safePayload.paralegalName || "The invited paralegal"} declined your invitation${
                safePayload.caseTitle ? ` for <strong>${safePayload.caseTitle}</strong>.` : "."
              }</p>`
      };
    case "application_submitted":
      return {
        subject: "New application received",
        html: `<p>${safePayload.paralegalName || "A paralegal"} applied to ${
          safePayload.title || "your Matter"
        }.</p><p>Log in to review the application.</p>`,
      };
    case "application_accepted":
      return {
        subject: "Application accepted",
        html: `<p>Your application${safePayload.caseTitle ? ` for <strong>${safePayload.caseTitle}</strong>` : ""} was accepted.</p><p>Log in to view details.</p>`,
      };
    case "application_denied":
      return {
        subject: "Application update",
        html: `<p>${safePayload.caseTitle ? `This role has been filled for <strong>${safePayload.caseTitle}</strong>.` : "This role has been filled."}</p><p>Log in to explore other opportunities.</p>`,
      };
    case "case_awaiting_funding":
      return {
        subject: subjectText(`Fund ${payload.caseTitle || "your Matter"}`),
        html: `<p>The Matter <strong>${safePayload.caseTitle || "Matter"}</strong> is ready for payment.</p><p>Please add payment to continue.</p>`,
      };
    case "payout_released":
      return emailTemplates.payoutReleased({
        caseTitle: payload.caseTitle || payload.title || "your Matter",
        amount: payload.amount,
        totalDisplay: payload.totalDisplay,
        feeDisplay: payload.feeDisplay,
        feePct: payload.feePct,
        recipientName: payload.recipientName || payload.paralegalName || payload.userName || "",
      });
    case "case_work_ready":
      return {
        subject: subjectText(`Work can begin on ${payload.caseTitle || "your Matter"}`),
        html: `<p>The Matter <strong>${safePayload.caseTitle || "Matter"}</strong> is ready to begin.</p><p>Log in to get started.</p>`,
      };
    case "pre_engagement_requested":
      return {
        subject: subjectText(`Pre-engagement requested${payload.caseTitle ? `: ${payload.caseTitle}` : ""}`),
        html: `<p>The attorney requested pre-engagement items for <strong>${safePayload.caseTitle || "this application"}</strong>.</p><p>Log in to review and respond.</p>`,
      };
    case "pre_engagement_submitted":
      return {
        subject: subjectText(`Pre-engagement ready for review${payload.caseTitle ? `: ${payload.caseTitle}` : ""}`),
        html: `<p>A submitted pre-engagement response is ready for review on <strong>${safePayload.caseTitle || "this Matter"}</strong>.</p><p>Log in to review and continue hiring.</p>`,
      };
    case "pre_engagement_changes_requested":
      return {
        subject: subjectText(`Pre-engagement changes requested${payload.caseTitle ? `: ${payload.caseTitle}` : ""}`),
        html: `<p>The attorney requested updates to your pre-engagement response for <strong>${safePayload.caseTitle || "this application"}</strong>.</p><p>Log in to revise and resubmit.</p>`,
      };
    case "case_file_uploaded":
      return emailTemplates.documentUploaded({
        documentName: payload.fileName || "A document",
        caseTitle: payload.caseTitle || "",
      });
    case "dispute_resolved": {
      const title = safePayload.caseTitle || "the Matter";
      const resolution = safePayload.resolutionLabel || safePayload.resolution || "Resolution";
      const receiptNote =
        safePayload.receiptNote || "A receipt is available in your dashboard with full payment details.";
      return {
        subject: subjectText(`Review resolved${payload.caseTitle ? `: ${payload.caseTitle}` : ""}`),
        html: `<p>${safePayload.message || `The review for <strong>${title}</strong> was resolved.`}</p><p>Resolution: ${resolution}.</p><p>${receiptNote}</p>`,
      };
    }
    case "dispute_opened": {
      const title = safePayload.caseTitle || "your Matter";
      return {
        subject: subjectText(`Review opened${payload.caseTitle ? `: ${payload.caseTitle}` : ""}`),
        html: `<p>A review was opened for <strong>${title}</strong>.</p><p>Log in to review the Matter details.</p>`,
      };
    }
    case "admin_review_overdue": {
      const title = safePayload.caseTitle || "your Matter";
      return {
        subject: subjectText(`Review update${payload.caseTitle ? `: ${payload.caseTitle}` : ""}`),
        html: `<p>Our team is still reviewing <strong>${title}</strong>.</p><p>We will follow up as soon as the review is complete. Thank you for your patience.</p>`,
      };
    }
    case "account_suspended":
      return emailTemplates.accountSuspended({
        recipientName: payload.recipientName || payload.userName || "",
        reason: payload.reason || "",
        message: payload.customNote || "",
      });
    case "case_deleted":
      return emailTemplates.caseDeleted({
        recipientName: payload.recipientName || payload.userName || "",
        caseTitle: payload.caseTitle || "your Matter",
        reason: payload.reason || "",
        message: payload.customNote || "",
      });
    default:
      return {
        subject: "LPC Update",
        html: "<p>You have a new notification.</p>"
      };
  }
}

function shouldWrapNotificationEmail(html = "") {
  const lower = String(html || "").toLowerCase();
  if (!lower) return false;
  if (lower.includes("data-lpc-template=\"full\"")) return false;
  if (lower.includes("<table") || lower.includes("<style") || lower.includes("<body")) return false;
  return true;
}

function wrapNotificationEmail(subject, bodyHtml) {
  const title = escapeHtml(subjectText(subject, "LPC Notification"));
  return `
  <div style="margin:0;padding:24px 12px;background:#f5f6f8;">
    <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e6e8ee;border-radius:14px;overflow:hidden;">
      <div style="padding:18px 24px;border-bottom:1px solid #eceff4;background:#fafbfc;">
        <div style="font-family:Georgia, 'Times New Roman', serif;font-size:20px;letter-spacing:0.02em;color:#111827;">
          Let's-ParaConnect
        </div>
      </div>
      <div style="padding:22px 24px;font-family:Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#111827;">
        <div style="font-weight:600;margin-bottom:10px;">${title}</div>
        ${bodyHtml || "<p>You have a new notification.</p>"}
      </div>
      <div style="padding:14px 24px;border-top:1px solid #eceff4;font-family:Arial, Helvetica, sans-serif;font-size:12px;color:#6b7280;">
        This is an automated notification from Let's-ParaConnect.
      </div>
    </div>
  </div>
  `;
}

async function safeSendEmail(to, subject, html) {
  if (!to || !subject) return;
  try {
    const safeSubject = subjectText(subject);
    const finalHtml = shouldWrapNotificationEmail(html)
      ? wrapNotificationEmail(safeSubject, html)
      : html;
    await sendEmail(to, safeSubject, finalHtml);
  } catch (err) {
    runtimeLogger.error("[notifyUser] Email failed:", err);
  }
}

const CASE_EMAIL_TYPES = new Set([
  "case_invite",
  "case_invite_response",
  "case_update",
  "case_awaiting_funding",
  "case_work_ready",
  "case_file_uploaded",
  "application_submitted",
  "application_accepted",
  "application_denied",
  "pre_engagement_requested",
  "pre_engagement_submitted",
  "pre_engagement_changes_requested",
  "payout_released",
  "dispute_resolved",
]);

const MESSAGE_EMAIL_SUPPRESS_MS = resolveMessageNotificationPolicy().suppressMs;

function normalizePrefs(user) {
  const prefs = user?.notificationPrefs;
  if (!prefs) return {};
  if (typeof prefs.toObject === "function") return prefs.toObject();
  if (typeof prefs.toJSON === "function") return prefs.toJSON();
  return prefs;
}

function getLastViewedAt(user, caseId) {
  if (!user || !caseId) return null;
  const map = user.messageLastViewedAt;
  if (map && typeof map.get === "function") {
    return map.get(String(caseId)) || null;
  }
  if (map && typeof map === "object") {
    return map[String(caseId)] || null;
  }
  return null;
}

function shouldSuppressMessageEmail(user, payload = {}) {
  if (!payload?.caseId) return false;
  const lastViewed = getLastViewedAt(user, payload.caseId);
  if (!lastViewed) return false;
  const viewedAt = new Date(lastViewed).getTime();
  if (Number.isNaN(viewedAt)) return false;
  return Date.now() - viewedAt < MESSAGE_EMAIL_SUPPRESS_MS;
}

function shouldSendEmailForType(user, type, payload = {}) {
  const prefs = normalizePrefs(user);
  if (type === "admin_review_overdue") return true;
  if (type === "dispute_opened" && String(user.role || "").toLowerCase() === "admin") return true;
  if (type === "case_deleted") return true;
  if (type === "account_suspended") return true;
  if (type === "case_budget_locked") return false;
  if (type === "profile_photo_rejected") return false;
  if (type === "application_denied") return false;
  if (type === "payout_released") return false;
  if (prefs.email === false) return false;
  if (type === "message") {
    if (payload?.suppressEmail) return false;
    if (shouldSuppressMessageEmail(user, payload)) return false;
    return prefs.emailMessages !== false;
  }
  if (CASE_EMAIL_TYPES.has(type)) {
    return prefs.emailCase !== false;
  }
  return true;
}

function shouldCreateInAppNotification(user, type) {
  const prefs = normalizePrefs(user);
  if (type === "admin_review_overdue") return true;
  if (type === "dispute_opened" && String(user.role || "").toLowerCase() === "admin") return true;
  if (prefs.inApp === false) return false;
  if (type === "message") {
    if (Object.prototype.hasOwnProperty.call(prefs, "inAppMessages")) {
      return prefs.inAppMessages !== false;
    }
    return true;
  }
  if (CASE_EMAIL_TYPES.has(type)) {
    if (Object.prototype.hasOwnProperty.call(prefs, "inAppCase")) {
      return prefs.inAppCase !== false;
    }
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(prefs, "inApp")) {
    return prefs.inApp !== false;
  }
  return true;
}

async function notifyUser(userId, type, payload = {}, options = {}) {
  const user = await User.findById(userId);
  if (!user) return;

  const actorUserId = payload?.actorUserId || options.actorUserId || null;
  const senderId = payload?.fromId || payload?.senderId || actorUserId || null;
  if (type === "message" && senderId && String(senderId) === String(userId)) {
    return;
  }
  const actor = await resolveActorSnapshot(actorUserId);
  const shouldCreateInApp = shouldCreateInAppNotification(user, type);
  let notif = null;
  if (shouldCreateInApp) {
    const payloadWithActor = { ...payload };
    if (actor.actorFirstName && !payloadWithActor.actorFirstName) {
      payloadWithActor.actorFirstName = actor.actorFirstName;
    }
    if (actor.actorRole && !payloadWithActor.actorRole) {
      payloadWithActor.actorRole = actor.actorRole;
    }
    const message = buildDisplayMessage(type, { ...payloadWithActor });
    notif = await Notification.create({
      userId,
      userRole: user.role || "",
      type,
      message,
      link: payload.link || "",
      payload: payloadWithActor,
      actorUserId: actor.actorUserId,
      actorFirstName: actor.actorFirstName,
      actorProfileImage: actor.actorProfileImage,
      read: false,
      isRead: false,
      createdAt: new Date(),
    });
    publishNotificationEvent(userId, "notifications", { at: new Date().toISOString() });
  }

  let emailPayload = payload;
  if (type === "payout_released") {
    const name = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    if (name && !payload.recipientName) {
      emailPayload = { ...payload, recipientName: name };
    }
  }

  if (shouldSendEmailForType(user, type, emailPayload)) {
    const { subject, html } = emailTemplate(type, emailPayload);
    await safeSendEmail(user.email, subject, html);
  }

  return notif;
}

async function createNotification({
  userId,
  userRole = "",
  type,
  message = "",
  link = "",
  actorUserId = null,
  payload = {},
}) {
  if (!userId || !type) return null;
  const actor = await resolveActorSnapshot(actorUserId);
  const payloadWithActor = { ...payload };
  if (actor.actorFirstName && !payloadWithActor.actorFirstName) {
    payloadWithActor.actorFirstName = actor.actorFirstName;
  }
  if (actor.actorRole && !payloadWithActor.actorRole) {
    payloadWithActor.actorRole = actor.actorRole;
  }
  const finalMessage = message || buildDisplayMessage(type, { ...payloadWithActor });
  const notif = await Notification.create({
    userId,
    userRole,
    type,
    message: finalMessage,
    link,
    payload: payloadWithActor,
    actorUserId: actor.actorUserId,
    actorFirstName: actor.actorFirstName,
    actorProfileImage: actor.actorProfileImage,
    read: false,
    isRead: false,
    createdAt: new Date(),
  });
  publishNotificationEvent(userId, "notifications", { at: new Date().toISOString() });
  return notif;
}

module.exports = {
  notifyUser,
  emailTemplate,
  createNotification,
};
