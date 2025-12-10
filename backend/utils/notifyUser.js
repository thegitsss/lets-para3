const Notification = require("../models/Notification");
const User = require("../models/User");
const sendEmail = require("./email");

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

async function notifyUser(userId, type, payload = {}) {
  const user = await User.findById(userId);
  if (!user) return;

  const notif = await Notification.create({
    userId,
    type,
    payload,
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

module.exports = {
  notifyUser,
  emailTemplate,
};
