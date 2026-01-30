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
    case "profile_photo_approved":
      return "Your profile photo was approved.";
    case "profile_photo_rejected":
      return "Your profile photo was rejected. Please upload a new one that meets our photo guidelines, including a plain or neutral background.";
    case "payout_released":
      return `Your payout was released${payload.amount ? ` (${payload.amount})` : ""}.`;
    case "application_submitted": {
      const paralegal = payload.paralegalName || actorName || "A paralegal";
      return `${paralegal} applied${caseFragment || ""}`.trim();
    }
    case "application_accepted":
      return `Your application for ${caseTitle || "the case"} was accepted.`;
    case "application_denied":
      return `Your application for ${caseTitle || "the case"} was not selected.`;
    case "case_awaiting_funding":
      return `${payload.caseTitle || "A case"} is awaiting funding`;
    case "case_work_ready":
      return `${payload.caseTitle || "A case"} is funded. Work can begin.`;
    case "case_file_uploaded": {
      const fileName = payload.fileName || "a document";
      return `${actorName || "Someone"} uploaded ${fileName}${caseFragment || ""}`.trim();
    }
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
    console.warn("[notifyUser] actor lookup failed", err?.message || err);
    return { actorUserId, actorFirstName: "", actorProfileImage: "", actorRole: "" };
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
    case "profile_photo_approved":
      return (() => {
        const baseUrl =
          process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || "https://www.lets-paraconnect.com";
        const assetBase = String(baseUrl).replace(/\/+$/, "").replace(/\/profile-settings\.html$/, "");
        const logoUrl = `${assetBase}/Cleanfav.png`;
        const loginUrl = `${assetBase}/login.html`;
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
                      Your profile is now visible to attorneys, and you can log in anytime to make updates.<br><br>
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
        subject: "Case invitation update",
        html:
          payload.response === "accepted"
            ? `<p>${payload.paralegalName || "The invited paralegal"} accepted your invitation${
                payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>.` : "."
              }</p>`
            : payload.response === "filled"
            ? `<p>The position for <strong>${payload.caseTitle || "this case"}</strong> has been filled.</p>`
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
    case "application_accepted":
      return {
        subject: "Application accepted",
        html: `<p>Your application${payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>` : ""} was accepted.</p><p>${payload.link ? `<a href="${payload.link}">Open the case</a>` : "Log in to view details."}</p>`,
      };
    case "application_denied":
      return {
        subject: "Application update",
        html: `<p>Your application${payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>` : ""} was not selected.</p><p>${payload.link ? `<a href="${payload.link}">Browse jobs</a>` : "Log in to explore other opportunities."}</p>`,
      };
    case "case_awaiting_funding":
      return {
        subject: `Fund ${payload.caseTitle || "your case"}`,
        html: `<p>The case <strong>${payload.caseTitle || "Case"}</strong> is awaiting funding.</p><p>${payload.link ? `<a href="${payload.link}">Open the case to fund now.</a>` : "Please fund the case to continue."}</p>`,
      };
    case "payout_released":
      return {
        subject: "Your payout is on the way",
        html: `<p>Your payout${payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>` : ""} is on the way${payload.amount ? ` (${payload.amount})` : ""}.</p><p>${payload.link ? `<a href="${payload.link}">Open the case</a>` : "Log in to view details."}</p>`,
      };
    case "case_work_ready":
      return {
        subject: `Work can begin on ${payload.caseTitle || "your case"}`,
        html: `<p>The case <strong>${payload.caseTitle || "Case"}</strong> is funded and ready to begin.</p><p>${payload.link ? `<a href="${payload.link}">Open the case</a>` : "Log in to get started."}</p>`,
      };
    case "case_file_uploaded":
      return {
        subject: `New document on ${payload.caseTitle || "your case"}`,
        html: `<p>${payload.fileName || "A document"} was uploaded${payload.caseTitle ? ` to <strong>${payload.caseTitle}</strong>` : ""}.</p><p>${payload.link ? `<a href="${payload.link}">Open the case</a>` : "Log in to view the document."}</p>`,
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
  "payout_released",
]);

function shouldSendEmailForType(user, type) {
  const prefs = user?.notificationPrefs || {};
  if (type === "profile_photo_rejected") return false;
  if (prefs.email === false) return false;
  if (type === "message") {
    return prefs.emailMessages !== false;
  }
  if (CASE_EMAIL_TYPES.has(type)) {
    return prefs.emailCase !== false;
  }
  return true;
}

function shouldCreateInAppNotification(user, type) {
  const prefs = user?.notificationPrefs || {};
  if (prefs.inApp === false) return false;
  if (type === "message") {
    if (Object.prototype.hasOwnProperty.call(prefs, "inAppMessages")) {
      return prefs.inAppMessages !== false;
    }
    return prefs.emailMessages !== false;
  }
  if (CASE_EMAIL_TYPES.has(type)) {
    if (Object.prototype.hasOwnProperty.call(prefs, "inAppCase")) {
      return prefs.inAppCase !== false;
    }
    return prefs.emailCase !== false;
  }
  if (Object.prototype.hasOwnProperty.call(prefs, "inApp")) {
    return prefs.inApp !== false;
  }
  return prefs.email !== false;
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
  }

  if (shouldSendEmailForType(user, type)) {
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
  return notif;
}

module.exports = {
  notifyUser,
  emailTemplate,
  createNotification,
};
