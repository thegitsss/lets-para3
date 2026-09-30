const { letterEmail } = require("../email/layout");
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
      if (response === "filled") return `The position for ${caseTitle || "this Matter"} has been filled`;
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
      return payload.outcome === "matter_filled"
        ? `The role for ${caseTitle || "this Matter"} has been filled`
        : `Your application for ${caseTitle || "this Matter"} was not selected`;
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
      return payload.message || "The LPC review remains open. No decision is recorded.";
    default:
      return "You have a new notification.";
  }
}

async function resolveActorSnapshot(actorUserId, session = null) {
  if (!actorUserId) {
    return { actorUserId: null, actorFirstName: "", actorProfileImage: "", actorRole: "" };
  }
  try {
    const actor = await User.findById(actorUserId).select("firstName profileImage avatarURL role").session(session);
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

        const html = letterEmail(`<p>Hello,<br><br>
                      Your profile photo has been approved.<br><br>
                      Sign in to review your profile or make updates.<br><br>
                      </p>`);
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
        html: `<p>${payload.outcome === "matter_filled" ? `The role for <strong>${safePayload.caseTitle || "this Matter"}</strong> has been filled.` : `Your application for <strong>${safePayload.caseTitle || "this Matter"}</strong> was not selected.`}</p><p>Log in to explore other opportunities.</p>`,
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
      return emailTemplates.workReady(payload);
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
        caseId: payload.caseId,
        fileId: payload.fileId,
      });
    case "dispute_resolved": {
      const title = safePayload.caseTitle || "the Matter";
      const resolution = safePayload.resolutionLabel || safePayload.resolution || "Resolution";
      const receiptNote =
        safePayload.receiptNote || "Sign in to review the decision and any payment details in your Matter.";
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
        html: `<p>The LPC review for <strong>${title}</strong> remains open.</p><p>No decision is recorded. Sign in to read the current review status.</p>`,
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
  return !String(html).includes('data-lpc-email="letter"');
}
function wrapNotificationEmail(subject, bodyHtml) {
  return letterEmail(bodyHtml || '<p>You have a new notification.</p>', { title: subjectText(subject) });
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
  const deferred = options.deferDispatch === true;
  if ((deferred || options.session) && (!deferred || !options.session?.inTransaction())) throw new Error("Deferred notifications require an active transaction.");
  if (options.invitationSent && (!deferred || type !== "case_invite")) throw new Error("Invitation email requires its transactional notification.");
  if (options.invitationResponse && (!deferred || type !== "case_invite_response" || options.invitationSent)) throw new Error("Invitation response email requires its transactional notification.");
  if (options.postingNotice && (!deferred || !['updated', 'deleted', 'edits_requested', 'review_requested'].includes(options.postingNotice.kind) || type !== (options.postingNotice.kind === 'deleted' ? 'case_deleted' : 'case_update'))) throw new Error("Posting email requires its transactional notification.");
  if (options.preEngagement && (!deferred || !['requested', 'submitted', 'changes_requested'].includes(options.preEngagement.kind) || type !== `pre_engagement_${options.preEngagement.kind}`)) throw new Error("Pre-engagement email requires its transactional notification.");
  if (options.applicationSubmission && (!deferred || type !== "application_submitted")) throw new Error("Application email requires a transactional submission notification.");
  if (options.applicationWithdrawal && (!deferred || type !== "case_update" || payload.outcome !== "application_withdrawn" || options.applicationSubmission)) throw new Error("Application withdrawal email requires its transactional notification.");
  if (options.fileUpload && (!deferred || type !== "case_file_uploaded")) throw new Error("Upload email requires a transactional file notification.");
  if (options.workReady && (!deferred || type !== "case_work_ready")) throw new Error("Work email requires a transactional assignment notification.");
  if (options.paymentAction && (!deferred || type !== "case_update")) throw new Error("Payment email requires a transactional funding notification.");
  if (options.withdrawalRequest && (!deferred || type !== "case_update")) throw new Error("Withdrawal email requires a transactional withdrawal notification.");
  if (options.withdrawalDecision && (!deferred || type !== "case_update" || options.withdrawalRequest || !["partial", "reject", "relist", "expired"].includes(options.withdrawalDecision))) throw new Error("Withdrawal decision email requires a transactional decision notification.");
  if (options.completionNotice && (!deferred || !["case_update", "payout_released"].includes(type) || options.paymentAction || options.withdrawalRequest || options.withdrawalDecision)) throw new Error("Completion email requires a transactional completion notification.");
  if (options.reviewOpened && (!deferred || type !== "dispute_opened" || options.fileUpload || options.workReady || options.paymentAction || options.withdrawalRequest || options.withdrawalDecision || options.completionNotice)) throw new Error("Review email requires a transactional review notification.");
  if (options.reviewResolved && (!deferred || type !== "dispute_resolved" || options.fileUpload || options.workReady || options.paymentAction || options.withdrawalRequest || options.withdrawalDecision || options.completionNotice || options.reviewOpened)) throw new Error("Review decision email requires a transactional settlement notification.");
  if (options.reviewOverdue && (!deferred || type !== "admin_review_overdue" || options.fileUpload || options.workReady || options.paymentAction || options.withdrawalRequest || options.withdrawalDecision || options.completionNotice || options.reviewOpened || options.reviewResolved)) throw new Error("Overdue email requires a transactional reminder notification.");
  const user = await User.findById(userId).session(options.session || null);
  if (!user) return;

  const actorUserId = payload?.actorUserId || options.actorUserId || null;
  const senderId = payload?.fromId || payload?.senderId || actorUserId || null;
  if (type === "message" && senderId && String(senderId) === String(userId)) {
    return;
  }
  const actor = await resolveActorSnapshot(actorUserId, options.session || null);
  const shouldCreateInApp = shouldCreateInAppNotification(user, options.completionNotice ? "case_update" : type);
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
    const record = {
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
    };
    notif = deferred ? (await Notification.create([record], { session: options.session }))[0] : await Notification.create(record);
  }

  if (options.invitationSent && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterInvitationNotifications").stage({
      caseId: payload.caseId, ownerId: options.invitationSent.ownerId, invitedAt: options.invitationSent.invitedAt,
      userId, actorUserId,
    }, options.session);
  }
  if (options.applicationSubmission && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterApplicationNotifications").stage({
      applicationId: options.applicationSubmission.applicationId, userId, caseId: payload.caseId,
    }, options.session);
  }
  if (options.invitationResponse && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterInvitationNotifications").stageResponse({
      ...options.invitationResponse, caseId: payload.caseId, paralegalId: payload.paralegalId,
      userId, actorUserId,
    }, options.session);
  }
  if (options.postingNotice && shouldSendEmailForType(user, type, payload)) {
    await require('../services/matterPostingNotifications').stage({ ...options.postingNotice, userId }, options.session);
  }
  if (options.preEngagement && shouldSendEmailForType(user, type, payload)) {
    await require('../services/matterPreEngagementNotifications').stage({
      ...options.preEngagement, caseId: payload.caseId, paralegalId: payload.paralegalId, userId, actorUserId,
    }, options.session);
  }
  if (options.applicationWithdrawal && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterApplicationNotifications").stageWithdrawal({
      applicationId: options.applicationWithdrawal.applicationId || null,
      userId, caseId: payload.caseId, paralegalId: payload.applicantId,
    }, options.session);
  }
  if (options.fileUpload && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterFileNotifications").stage({
      uploadId: options.fileUpload.id, fileVersion: options.fileUpload.version,
      userId, actorUserId, caseId: payload.caseId, fileId: payload.fileId,
    }, options.session);
  }
  if (options.workReady && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterWorkNotifications").stage({ caseId: payload.caseId, userId }, options.session);
  }
  if (options.paymentAction && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterPaymentNotifications").stage({ caseId: payload.caseId, userId, paymentIntentId: options.paymentAction.paymentIntentId, paymentStatus: options.paymentAction.paymentStatus }, options.session);
  }
  if ((options.withdrawalRequest || options.withdrawalDecision) && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterWithdrawalNotifications").stage({ caseId: payload.caseId, userId, kind: options.withdrawalDecision || "request" }, options.session);
  }
  // Ordinary payout notifications intentionally suppress their own email. The
  // completion transaction owns this separate, preference-controlled notice.
  if (options.completionNotice && shouldSendEmailForType(user, "case_update", payload)) {
    await require("../services/matterPaymentNotifications").stageCompletionEmail({ caseId: payload.caseId, userId }, options.session);
  }

  if ((options.reviewOpened || options.reviewResolved || options.reviewOverdue) && shouldSendEmailForType(user, type, payload)) {
    await require("../services/matterReviewNotifications").stage({ caseId: payload.caseId, userId, userRole: user.role, disputeId: payload.disputeId, kind: options.reviewResolved ? "resolved" : options.reviewOverdue ? "overdue" : "opened" }, options.session);
  }

  // Assignment writers persist notices in their transaction, then dispatch
  // only after commit. Existing callers keep their immediate behavior.
  const dispatch = async () => {
    // This stream is also the authenticated client's live data-invalidation
    // channel. Emit even when the member has disabled the in-app notification
    // record so Home, Work, unread counts, and open multi-tab sessions can
    // reconcile the underlying domain change immediately. Notification
    // preferences still control record creation and email delivery.
    publishNotificationEvent(userId, "notifications", {
      at: new Date().toISOString(),
      type: `${type}_refresh`,
    });

    let emailPayload = payload;
    if (type === "payout_released") {
      const name = `${user.firstName || ""} ${user.lastName || ""}`.trim();
      if (name && !payload.recipientName) {
        emailPayload = { ...payload, recipientName: name };
      }
    }

    if (!options.invitationSent && !options.invitationResponse && !options.preEngagement && !options.postingNotice && !options.applicationSubmission && !options.applicationWithdrawal && !options.fileUpload && !options.workReady && !options.paymentAction && !options.withdrawalRequest && !options.withdrawalDecision && !options.completionNotice && !options.reviewOpened && !options.reviewResolved && !options.reviewOverdue && shouldSendEmailForType(user, type, emailPayload)) {
      const { subject, html } = emailTemplate(type, emailPayload);
      await safeSendEmail(user.email, subject, html);
    }
    return notif;
  };
  return deferred ? dispatch : dispatch();
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
  shouldSendEmailForType,
};
