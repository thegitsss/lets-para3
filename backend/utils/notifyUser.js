const Notification = require("../models/Notification");
const User = require("../models/User");
const sendEmail = require("./email");

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
  const caseFragment = caseTitle ? ` to ${caseTitle}` : "";

  switch (type) {
    case "message": {
      const snippet = payload.messageSnippet || payload.preview || "";
      const base = `${actorName || "Someone"} sent you a message${caseTitle ? ` about ${caseTitle}` : ""}`;
      return snippet ? `${base}: "${snippet}"` : base;
    }
    case "case_invite":
      return `${actorName || "An attorney"} invited you${caseFragment || " to a case"}`;
    case "case_invite_response": {
      const response = String(payload.response || "").toLowerCase();
      const verb = response === "declined" ? "declined" : "accepted";
      return `${actorName || "The paralegal"} ${verb} your invitation${caseFragment || ""}`.trim();
    }
    case "case_update":
      return payload.summary || `${actorName || "Someone"} updated${caseFragment || " your case"}`;
    case "resume_uploaded":
      return "Your resume was uploaded successfully.";
    case "profile_approved":
      return "Your profile was approved.";
    case "payout_released":
      return `Your payout was released${payload.amount ? ` (${payload.amount})` : ""}.`;
    case "application_submitted": {
      const paralegal = payload.paralegalName || actorName || "A paralegal";
      return `${paralegal} applied${caseFragment || ""}`.trim();
    }
    case "case_awaiting_funding":
      return `${payload.caseTitle || "A case"} is awaiting funding`;
    default:
      return "You have a new notification.";
  }
}

async function resolveActorSnapshot(actorUserId) {
  if (!actorUserId) {
    return { actorUserId: null, actorFirstName: "", actorProfileImage: "" };
  }
  try {
    const actor = await User.findById(actorUserId).select("firstName profileImage avatarURL");
    if (!actor) {
      return { actorUserId, actorFirstName: "", actorProfileImage: "" };
    }
    return {
      actorUserId: actor._id,
      actorFirstName: actor.firstName || "",
      actorProfileImage: actor.profileImage || actor.avatarURL || "",
    };
  } catch (err) {
    console.warn("[notifyUser] actor lookup failed", err?.message || err);
    return { actorUserId, actorFirstName: "", actorProfileImage: "" };
  }
}

function emailTemplate(type, payload) {
  switch (type) {
    case "message":
      return {
        subject: "New message on LPC",
        html: `<p>You received a new message from <strong>${payload.fromName || "a user"}</strong>.</p><p>Log in to view and reply.</p>`
      };
    case "case_invite":
      return {
        subject: "You've been invited to a case",
        html: `<p>You have a new case invitation: <strong>${payload.caseTitle || "a case"}</strong>.</p>`
      };
    case "case_update":
      return {
        subject: "Case update",
        html: `<p>The case <strong>${payload.caseTitle || "your case"}</strong> has been updated.</p>`
      };
    case "resume_uploaded":
      return {
        subject: "Resume updated",
        html: "<p>Your resume has been successfully uploaded.</p>"
      };
    case "profile_approved":
      return {
        subject: "Profile approved",
        html: "<p>Your profile has been approved. You can now access new opportunities on LPC.</p>"
      };
    case "case_invite_response":
      return {
        subject: "Case invitation update",
        html:
          payload.response === "accepted"
            ? `<p>${payload.paralegalName || "The invited paralegal"} accepted your invitation${
                payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>.` : "."
              }</p>`
            : `<p>${payload.paralegalName || "The invited paralegal"} declined your invitation${
                payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>.` : "."
              }</p>`
      };
    case "application_submitted":
      return {
        subject: "New application received",
        html: `<p>${payload.paralegalName || "A paralegal"} applied to ${
          payload.title || "your job"
        }.</p><p>Log in to review the application.</p>`,
      };
    case "case_awaiting_funding":
      return {
        subject: `Fund ${payload.caseTitle || "your case"}`,
        html: `<p>The case <strong>${payload.caseTitle || "Case"}</strong> is awaiting funding.</p><p>${payload.link ? `<a href="${payload.link}">Open the case to fund now.</a>` : "Please fund the case to continue."}</p>`,
      };
    default:
      return {
        subject: "LPC Notification",
        html: "<p>You have a new notification.</p>"
      };
  }
}

async function safeSendEmail(to, subject, html) {
  if (!to || !subject) return;
  try {
    await sendEmail(to, subject, html);
  } catch (err) {
    console.error("[notifyUser] Email failed:", err);
  }
}

async function notifyUser(userId, type, payload = {}, options = {}) {
  const user = await User.findById(userId);
  if (!user) return;

  const actorUserId = payload?.actorUserId || options.actorUserId || null;
  const actor = await resolveActorSnapshot(actorUserId);
  const message = buildDisplayMessage(type, { ...payload, actorFirstName: actor.actorFirstName });

  const notif = await Notification.create({
    userId,
    userRole: user.role || "",
    type,
    message,
    link: payload.link || "",
    payload,
    actorUserId: actor.actorUserId,
    actorFirstName: actor.actorFirstName,
    actorProfileImage: actor.actorProfileImage,
    read: false,
    isRead: false,
    createdAt: new Date(),
  });

  if (user.notificationPrefs?.categories && user.notificationPrefs.categories[type] === false) {
    return notif;
  }

  if (user.notificationPrefs?.email) {
    const { subject, html } = emailTemplate(type, payload);
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
  const finalMessage = message || buildDisplayMessage(type, { ...payload, actorFirstName: actor.actorFirstName });
  const notif = await Notification.create({
    userId,
    userRole,
    type,
    message: finalMessage,
    link,
    payload: payload || {},
    actorUserId: actor.actorUserId,
    actorFirstName: actor.actorFirstName,
    actorProfileImage: actor.actorProfileImage,
    read: false,
    isRead: false,
    createdAt: new Date(),
  });
  return notif;
}

module.exports = {
  notifyUser,
  emailTemplate,
  createNotification,
};
