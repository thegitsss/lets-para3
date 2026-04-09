const IncidentNotification = require("../../models/IncidentNotification");
const Notification = require("../../models/Notification");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const SupportTicket = require("../../models/SupportTicket");
const { publishConversationEvent } = require("../support/liveUpdateService");
const { publishNotificationEvent } = require("../../utils/notificationEvents");
const sendEmail = require("../../utils/email");
const { findFounderApproverUsers, getFounderApproverEmails } = require("./approvalRecipients");

function compactText(value, maxLength = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : "";
}

function reporterHelpLink(incident = {}) {
  const surface = String(incident.context?.surface || incident.reporter?.role || "").toLowerCase();
  const publicId = encodeURIComponent(incident.publicId || "");
  const base = surface === "paralegal" ? "/paralegalhelp.html" : "/help.html";
  return publicId ? `${base}?incident=${publicId}` : base;
}

function adminIncidentLink(incident = {}) {
  const publicId = encodeURIComponent(incident.publicId || "");
  const baseUrl = String(process.env.APP_BASE_URL || process.env.EMAIL_BASE_URL || "https://www.lets-paraconnect.com").replace(
    /\/+$/,
    ""
  );
  const relativePath = publicId ? `/admin-dashboard.html?incident=${publicId}` : "/admin-dashboard.html";
  return `${baseUrl}${relativePath}`;
}

function getFounderEngineeringAlertEmails() {
  const explicit = String(process.env.INCIDENT_FOUNDER_ALERT_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (explicit.length) return explicit;

  const approvers = getFounderApproverEmails();
  if (approvers.length) return approvers;

  return ["admin@lets-paraconnect.com"];
}

function isFounderSupportEngineeringIncident(incident = {}) {
  return String(incident?.source || "").trim().toLowerCase() === "inline_help";
}

function buildFounderSupportIssueBody({ incident, ticket = null, diagnosisKickoff = null, linkedToExisting = false } = {}) {
  const requesterRole = String(incident.reporter?.role || "user")
    .replace(/_/g, " ")
    .trim();
  const requesterEmail = String(incident.reporter?.email || "").trim();
  const routeLabel = compactText(incident.context?.routePath || incident.context?.pageUrl || incident.context?.featureKey || "Unknown area", 200);
  const issueLabel = compactText(incident.summary || incident.originalReportText || "Support-linked engineering issue", 220);
  const incidentRef = incident.publicId || String(incident._id || "");
  const ticketRef = ticket?.reference || "";
  const diagnosisLine = diagnosisKickoff?.started
    ? "Engineering diagnosis started automatically."
    : diagnosisKickoff?.reused
      ? "Engineering diagnosis was already in progress."
      : "Engineering diagnosis has not started yet.";

  return {
    subject: `New engineering issue from support: ${compactText(issueLabel, 90)}`,
    html: [
      "<p>A user-reported engineering issue came in through the support agent.</p>",
      `<p><strong>Issue:</strong> ${issueLabel}</p>`,
      `<p><strong>Incident:</strong> ${incidentRef}</p>`,
      ticketRef ? `<p><strong>Support ticket:</strong> ${ticketRef}</p>` : "",
      `<p><strong>Reporter:</strong> ${compactText(`${requesterRole}${requesterEmail ? ` · ${requesterEmail}` : ""}`, 220)}</p>`,
      `<p><strong>Area:</strong> ${routeLabel}</p>`,
      `<p><strong>Status:</strong> ${linkedToExisting ? "Linked to an existing engineering incident." : "Created as a new engineering incident."} ${diagnosisLine}</p>`,
      `<p><a href="${adminIncidentLink(incident)}">Open in Admin Dashboard</a></p>`,
    ]
      .filter(Boolean)
      .join(""),
    text: [
      "A user-reported engineering issue came in through the support agent.",
      `Issue: ${issueLabel}`,
      `Incident: ${incidentRef}`,
      ticketRef ? `Support ticket: ${ticketRef}` : "",
      `Reporter: ${requesterRole}${requesterEmail ? ` · ${requesterEmail}` : ""}`,
      `Area: ${routeLabel}`,
      `Status: ${linkedToExisting ? "Linked to an existing engineering incident." : "Created as a new engineering incident."} ${diagnosisLine}`,
      `Admin: ${adminIncidentLink(incident)}`,
    ]
      .filter(Boolean)
      .join("\n"),
    preview: compactText(
      `${issueLabel}. ${linkedToExisting ? "Linked to an existing engineering incident." : "Created as a new engineering incident."} ${diagnosisLine}`,
      240
    ),
  };
}

function buildFounderSupportFixedBody({ incident } = {}) {
  const issueLabel = compactText(incident.summary || incident.originalReportText || "Support-linked engineering issue", 220);
  const incidentRef = incident.publicId || String(incident._id || "");
  const resolutionSummary = compactText(
    incident.resolution?.summary || "The issue has been marked fixed and is now live.",
    320
  );
  return {
    subject: `Fixed engineering issue: ${compactText(issueLabel, 90)}`,
    html: [
      "<p>A support-linked engineering issue is now fixed.</p>",
      `<p><strong>Issue:</strong> ${issueLabel}</p>`,
      `<p><strong>Incident:</strong> ${incidentRef}</p>`,
      `<p><strong>Resolution:</strong> ${resolutionSummary}</p>`,
      `<p><a href="${adminIncidentLink(incident)}">Open in Admin Dashboard</a></p>`,
    ].join(""),
    text: [
      "A support-linked engineering issue is now fixed.",
      `Issue: ${issueLabel}`,
      `Incident: ${incidentRef}`,
      `Resolution: ${resolutionSummary}`,
      `Admin: ${adminIncidentLink(incident)}`,
    ].join("\n"),
    preview: compactText(`${issueLabel}. Fixed live. ${resolutionSummary}`, 240),
  };
}

function buildReporterMessage(templateKey, incident = {}) {
  const isSupportLinked = isFounderSupportEngineeringIncident(incident);
  switch (templateKey) {
    case "received":
      if (isSupportLinked) return "";
      return "We received your report and logged it for review.";
    case "investigating":
      if (isSupportLinked) return "";
      return "We validated your report and started technical investigation.";
    case "awaiting_internal_review":
      if (isSupportLinked) return "";
      return "Your report is under internal review.";
    case "fixed_live":
      if (isSupportLinked) return "Your reported issue has been fixed.";
      return "We identified the issue, verified the fix, and it is now live.";
    case "needs_more_info":
      if (isSupportLinked) return "";
      return "We need a bit more detail to continue investigating this report.";
    default:
      return "";
  }
}

function buildSupportLifecycleMessage(templateKey, incident = {}) {
  const issueLabel = compactText(incident.summary || incident.originalReportText || "This issue", 220);
  const issuePhrase = issueLabel ? `the issue you reported (${issueLabel})` : "the issue you reported";
  switch (templateKey) {
    case "testing_fix":
      return `A fix for ${issuePhrase} is being tested now. I'll share another update here once that verification is complete.`;
    case "awaiting_internal_review":
      return `A fix for ${issuePhrase} is under final review now. I'll share another update here as soon as that review is complete.`;
    case "fixed_live":
      return `${issuePhrase.charAt(0).toUpperCase() + issuePhrase.slice(1)} has been resolved. If it's still happening, reply here and we'll reopen it.`;
    case "closed":
      return `We closed out ${issuePhrase} after review. If it's still happening, reply here and we'll reopen it.`;
    default:
      return "";
  }
}

async function syncSupportConversationLifecycleMessages({ incident }) {
  if (!incident?._id || !isFounderSupportEngineeringIncident(incident)) return [];

  const templateKeyByStatus = {
    testing_fix: "testing_fix",
    awaiting_internal_review: "awaiting_internal_review",
    fixed_live: "fixed_live",
    closed: "closed",
  };

  const templateKey = templateKeyByStatus[incident.userVisibleStatus];
  if (!templateKey) return [];

  const messageText = buildSupportLifecycleMessage(templateKey, incident);
  if (!messageText) return [];

  const tickets = await SupportTicket.find({
    linkedIncidentIds: incident._id,
    conversationId: { $ne: null },
  })
    .select("_id conversationId routePath pageContext")
    .lean();

  if (!tickets.length) return [];

  const createdMessages = [];
  for (const ticket of tickets) {
    const conversationId = String(ticket.conversationId || "").trim();
    if (!conversationId) continue;

    const dedupeKey = `support-lifecycle:${String(incident._id)}:${templateKey}`;
    const existing = await SupportMessage.findOne({
      conversationId,
      "metadata.kind": "support_status_update",
      "metadata.lifecycleDedupeKey": dedupeKey,
    })
      .select("_id")
      .lean();
    if (existing) continue;

    const conversation = await SupportConversation.findById(conversationId);
    if (!conversation) continue;

    const message = await SupportMessage.create({
      conversationId: conversation._id,
      sender: "system",
      text: messageText,
      sourcePage: ticket.routePath || conversation.sourcePage || "",
      pageContext: ticket.pageContext || conversation.pageContext || {},
      metadata: {
        kind: "support_status_update",
        source: "incident_lifecycle",
        teamLabel: "LPC Team",
        lifecycleIncidentId: String(incident._id),
        lifecycleIncidentPublicId: incident.publicId || "",
        lifecycleStatusKey: templateKey,
        lifecycleDedupeKey: dedupeKey,
      },
    });

    conversation.lastMessageAt = message.createdAt || new Date();
    await conversation.save();
    publishConversationEvent(conversation._id, {
      type: "conversation.updated",
      reason: "incident.lifecycle_update",
      incidentId: String(incident._id),
      incidentPublicId: incident.publicId || "",
      lifecycleStatusKey: templateKey,
    });
    createdMessages.push(message);
  }

  return createdMessages;
}

function buildFounderApprovalMessage({ incident, approval }) {
  const publicId = incident?.publicId || "Incident";
  const risk = incident?.classification?.riskLevel || "unknown";
  const approvalId = approval?._id ? String(approval._id) : "";
  return compactText(
    `${publicId} requires founder approval before production release can continue. Risk: ${risk}.${approvalId ? ` Approval ${approvalId}.` : ""}`,
    240
  );
}

function buildDedupeKey({ audience, templateKey, incident, approval = null }) {
  if (audience === "founder" && templateKey === "founder_approval_request" && approval?._id) {
    return `approval:${String(approval._id)}`;
  }

  const publicId = String(incident?.publicId || "");
  return `${audience}:${templateKey}:${publicId}`;
}

async function ensureIncidentNotification({
  incident,
  audience,
  channel,
  templateKey,
  subject = "",
  bodyPreview = "",
  recipientUserId = null,
  recipientUserRole = "",
  recipientEmail = "",
  payload = {},
  inAppType = "",
  inAppMessage = "",
  link = "",
}) {
  const dedupeKey = compactText(payload.dedupeKey, 200);
  const notificationPayload = {
    ...payload,
    dedupeKey,
  };

  const existing = await IncidentNotification.findOne({
    incidentId: incident._id,
    audience,
    templateKey,
    recipientUserId: recipientUserId || null,
    recipientEmail: compactText(recipientEmail, 240).toLowerCase(),
    "payload.dedupeKey": dedupeKey,
  }).sort({ createdAt: -1 });

  if (existing) {
    if (!incident.latestNotificationId || String(incident.latestNotificationId) !== String(existing._id)) {
      if (typeof incident.save === "function") {
        incident.latestNotificationId = existing._id;
        await incident.save();
      } else if (incident?._id) {
        await IncidentNotification.db
          .model("Incident")
          .findByIdAndUpdate(incident._id, { $set: { latestNotificationId: existing._id } });
      }
    }
    return existing;
  }

  let status = "queued";
  let externalMessageId = "";
  if (recipientUserId && inAppType) {
    try {
      const sentNotification = await Notification.create({
        userId: recipientUserId,
        userRole: compactText(recipientUserRole, 80),
        type: inAppType,
        message: inAppMessage || bodyPreview,
        link,
        payload: notificationPayload || {},
        read: false,
        isRead: false,
        createdAt: new Date(),
      });
      publishNotificationEvent(recipientUserId, "notifications", { at: new Date().toISOString() });
      status = sentNotification ? "sent" : "queued";
      externalMessageId = sentNotification?._id ? String(sentNotification._id) : "";
    } catch (error) {
      status = "failed";
      notificationPayload.deliveryError = compactText(error?.message, 240);
    }
  } else if (channel === "control_room" || channel === "system_note") {
    status = "sent";
  } else if (channel === "email" && recipientEmail) {
    try {
      const emailHtml = typeof payload.emailHtml === "string" ? payload.emailHtml : `<p>${bodyPreview}</p>`;
      const emailText = typeof payload.emailText === "string" ? payload.emailText : bodyPreview;
      const info = await sendEmail(recipientEmail, subject || "Incident update", emailHtml, {
        text: emailText,
        messageIdPrefix: `incident-${String(incident.publicId || incident._id || "update").toLowerCase()}`,
      });
      status = info?.error ? "failed" : "sent";
      externalMessageId = info?.messageId ? String(info.messageId) : "";
      if (info?.error) {
        notificationPayload.deliveryError = compactText(info?.message || "Email delivery failed.", 240);
      }
    } catch (error) {
      status = "failed";
      notificationPayload.deliveryError = compactText(error?.message, 240);
    }
  }

  const incidentNotification = await IncidentNotification.create({
    incidentId: incident._id,
    audience,
    channel,
    templateKey,
    status,
    bodyPreview,
    recipientUserId: recipientUserId || null,
    recipientEmail: compactText(recipientEmail, 240).toLowerCase(),
    subject: compactText(subject, 240),
    payload: notificationPayload,
    externalMessageId,
    sentAt: status === "sent" ? new Date() : null,
  });

  incident.latestNotificationId = incidentNotification._id;
  if (typeof incident.save === "function") {
    await incident.save();
  } else if (incident?._id) {
    await IncidentNotification.db
      .model("Incident")
      .findByIdAndUpdate(incident._id, { $set: { latestNotificationId: incidentNotification._id } });
  }
  return incidentNotification;
}

async function syncReporterMilestoneNotifications({ incident }) {
  const templateKeyByStatus = {
    received: "received",
    investigating: "investigating",
    awaiting_internal_review: "awaiting_internal_review",
    fixed_live: "fixed_live",
    needs_more_info: "needs_more_info",
  };

  const templateKey = templateKeyByStatus[incident.userVisibleStatus];
  if (!templateKey) return [];

  const message = buildReporterMessage(templateKey, incident);
  if (!message) return [];

  const recipientUserId = incident.reporter?.userId || null;
  const notification = await ensureIncidentNotification({
    incident,
    audience: "reporter",
    channel: recipientUserId ? "in_app" : "system_note",
    templateKey,
    subject: "Incident update",
    bodyPreview: message,
    recipientUserId,
    recipientUserRole: incident.reporter?.role || "",
    recipientEmail: incident.reporter?.email || "",
    payload: {
      dedupeKey: buildDedupeKey({ audience: "reporter", templateKey, incident }),
      incidentPublicId: incident.publicId || "",
      status: incident.userVisibleStatus || "",
      state: incident.state || "",
    },
    inAppType: recipientUserId ? "incident_update" : "",
    inAppMessage: message,
    link: reporterHelpLink(incident),
  });

  return notification ? [notification] : [];
}

async function syncFounderApprovalNotifications({ incident, approval = null, release = null }) {
  if (!approval || approval.status !== "pending" || incident.state !== "awaiting_founder_approval") {
    return [];
  }

  const message = buildFounderApprovalMessage({ incident, approval });
  const recipients = await findFounderApproverUsers();
  const dedupeBase = buildDedupeKey({
    audience: "founder",
    templateKey: "founder_approval_request",
    incident,
    approval,
  });

  if (!recipients.length) {
    const fallbackEmail = getFounderApproverEmails()[0] || "";
    const controlRoomNotification = await ensureIncidentNotification({
      incident,
      audience: "founder",
      channel: "control_room",
      templateKey: "founder_approval_request",
      subject: "Founder approval requested",
      bodyPreview: message,
      recipientEmail: fallbackEmail,
      payload: {
        dedupeKey: `${dedupeBase}:control-room`,
        incidentPublicId: incident.publicId || "",
        approvalId: String(approval._id || ""),
        releaseId: String(release?._id || approval.releaseId || ""),
        deliveryState: "no_local_founder_recipient",
      },
    });
    return controlRoomNotification ? [controlRoomNotification] : [];
  }

  const notifications = [];
  for (const recipient of recipients) {
    const created = await ensureIncidentNotification({
      incident,
      audience: "founder",
      channel: "in_app",
      templateKey: "founder_approval_request",
      subject: "Founder approval requested",
      bodyPreview: message,
      recipientUserId: recipient._id,
      recipientUserRole: recipient.role || "",
      recipientEmail: recipient.email || "",
      payload: {
        dedupeKey: `${dedupeBase}:${String(recipient._id)}`,
        incidentPublicId: incident.publicId || "",
        approvalId: String(approval._id || ""),
        releaseId: String(release?._id || approval.releaseId || ""),
      },
      inAppType: "incident_approval_required",
      inAppMessage: message,
      link: adminIncidentLink(incident),
    });
    if (created) notifications.push(created);
  }

  return notifications;
}

async function notifyFounderSupportEngineeringIssue({ incident, ticket = null, diagnosisKickoff = null, linkedToExisting = false } = {}) {
  if (!incident?._id || !isFounderSupportEngineeringIncident(incident)) return [];

  const emailRecipients = getFounderEngineeringAlertEmails();
  if (!emailRecipients.length) return [];

  const content = buildFounderSupportIssueBody({ incident, ticket, diagnosisKickoff, linkedToExisting });
  const dedupeBase = `founder-support-issue:${incident.publicId || String(incident._id)}:${String(ticket?.id || ticket?._id || "ticket")}`;
  const notifications = [];

  for (const recipientEmail of emailRecipients) {
    const created = await ensureIncidentNotification({
      incident,
      audience: "founder",
      channel: "email",
      templateKey: "received",
      subject: content.subject,
      bodyPreview: content.preview,
      recipientEmail,
      payload: {
        dedupeKey: `${dedupeBase}:${recipientEmail}`,
        incidentPublicId: incident.publicId || "",
        ticketReference: ticket?.reference || "",
        linkedToExisting,
        emailHtml: content.html,
        emailText: content.text,
      },
    });
    if (created) notifications.push(created);
  }

  return notifications;
}

async function syncFounderSupportResolvedEmails({ incident }) {
  if (!incident?._id || !isFounderSupportEngineeringIncident(incident)) return [];

  const isFixed = incident.userVisibleStatus === "fixed_live" || incident.state === "resolved" || Boolean(incident.resolution?.resolvedAt);
  if (!isFixed) return [];

  const emailRecipients = getFounderEngineeringAlertEmails();
  if (!emailRecipients.length) return [];

  const content = buildFounderSupportFixedBody({ incident });
  const dedupeBase = `founder-support-fixed:${incident.publicId || String(incident._id)}`;
  const notifications = [];

  for (const recipientEmail of emailRecipients) {
    const created = await ensureIncidentNotification({
      incident,
      audience: "founder",
      channel: "email",
      templateKey: "fixed_live",
      subject: content.subject,
      bodyPreview: content.preview,
      recipientEmail,
      payload: {
        dedupeKey: `${dedupeBase}:${recipientEmail}`,
        incidentPublicId: incident.publicId || "",
        emailHtml: content.html,
        emailText: content.text,
      },
    });
    if (created) notifications.push(created);
  }

  return notifications;
}

async function syncIncidentNotifications({ incident, approval = null, release = null }) {
  if (!incident?._id) return { reporter: [], founder: [] };

  const reporter = await syncReporterMilestoneNotifications({ incident });
  const founderApproval = await syncFounderApprovalNotifications({ incident, approval, release });
  const founderSupportResolved = await syncFounderSupportResolvedEmails({ incident });
  const supportThread = await syncSupportConversationLifecycleMessages({ incident });

  return { reporter, founder: [...founderApproval, ...founderSupportResolved], supportThread };
}

module.exports = {
  notifyFounderSupportEngineeringIssue,
  syncIncidentNotifications,
  buildReporterMessage,
  buildFounderApprovalMessage,
};
