const {
  buildObjectDeepLink,
  normalizeId,
  parseMatterDeepLink,
} = require("./objectDeepLinks");

const PROFILE_SETTING_TYPES = new Set([
  "profile_approved",
  "profile_photo_approved",
  "profile_photo_rejected",
  "resume_uploaded",
]);
const WITHDRAWN_SAFE_TYPES = new Set([
  "payout_released",
  "dispute_resolved",
  "admin_review_overdue",
]);

function payloadOf(item) {
  return item?.payload && typeof item.payload === "object" ? item.payload : {};
}

function firstId(...values) {
  for (const value of values) {
    const id = normalizeId(value);
    if (id) return id;
  }
  return "";
}

function notificationCaseId(item = {}) {
  const payload = payloadOf(item);
  const direct = firstId(
    item.caseId,
    payload.caseId,
    payload.caseID,
    payload.case,
    payload.case_id,
    payload.caseRef,
    payload.caseDoc
  );
  if (direct) return direct;
  const parsed = parseMatterDeepLink(item.link || payload.link || payload.url || "");
  return parsed?.caseId || "";
}

function notificationObjectIds(item = {}) {
  const payload = payloadOf(item);
  return {
    caseId: notificationCaseId(item),
    applicantId: firstId(
      item.applicantId,
      item.paralegalId,
      payload.applicantId,
      payload.paralegalId,
      payload.paralegalID,
      payload.paralegal,
      payload.paralegalRef,
      payload.paralegalUserId
    ),
    applicationId: firstId(item.applicationId, payload.applicationId, payload.applicationID, payload.appId),
    fileId: firstId(item.fileId, payload.fileId, payload.documentId, payload.caseFileId),
    messageId: firstId(item.messageId, payload.messageId),
    profileId: firstId(item.profileId, payload.profileId, payload.paralegalId),
  };
}

function sameId(left, right) {
  const a = normalizeId(left);
  const b = normalizeId(right);
  return !!a && a === b;
}

function findApplicant(caseDoc, viewerId) {
  return (Array.isArray(caseDoc?.applicants) ? caseDoc.applicants : []).find(
    (entry) => sameId(entry?.paralegalId || entry?.paralegal, viewerId)
  );
}

function findInvite(caseDoc, viewerId) {
  return (Array.isArray(caseDoc?.invites) ? caseDoc.invites : []).find(
    (entry) => sameId(entry?.paralegalId, viewerId)
  );
}

function caseNotificationAccess(caseDoc, viewer = {}, type = "", blockedIds = new Set()) {
  if (!caseDoc) return { allowed: false, relationship: "missing" };
  const viewerId = normalizeId(viewer.id || viewer._id);
  const role = String(viewer.role || "").toLowerCase();
  if (!viewerId || !["attorney", "paralegal", "admin"].includes(role)) {
    return { allowed: false, relationship: "unauthorized" };
  }
  if (role === "admin") return { allowed: true, relationship: "admin" };
  const attorneyIds = [normalizeId(caseDoc.attorney), normalizeId(caseDoc.attorneyId)].filter(Boolean);
  const assignedIds = [normalizeId(caseDoc.paralegal), normalizeId(caseDoc.paralegalId)].filter(Boolean);
  const attorneyId = attorneyIds[0] || "";
  if (role === "attorney") {
    return attorneyIds.includes(viewerId)
      ? { allowed: true, relationship: "owner" }
      : { allowed: false, relationship: "unrelated" };
  }
  const isAssigned = assignedIds.includes(viewerId);
  const isWithdrawn = sameId(caseDoc.withdrawnParalegalId, viewerId);
  if (isAssigned && !caseDoc.paralegalAccessRevokedAt) {
    return { allowed: true, relationship: "assigned" };
  }
  if ((isAssigned || isWithdrawn) && WITHDRAWN_SAFE_TYPES.has(type)) {
    return { allowed: true, relationship: "withdrawn" };
  }
  const applicant = findApplicant(caseDoc, viewerId);
  const applicantStatus = String(applicant?.status || "").toLowerCase();
  if (applicant && ["pending", "accepted"].includes(applicantStatus)) {
    if (attorneyId && blockedIds.has(attorneyId)) return { allowed: false, relationship: "blocked" };
    return { allowed: true, relationship: "applicant" };
  }
  const invite = findInvite(caseDoc, viewerId);
  const inviteStatus = String(invite?.status || "pending").toLowerCase();
  if ((sameId(caseDoc.pendingParalegalId, viewerId) || invite) && inviteStatus === "pending") {
    if (attorneyId && blockedIds.has(attorneyId)) return { allowed: false, relationship: "blocked" };
    return { allowed: true, relationship: "invitee" };
  }
  return { allowed: false, relationship: "unrelated" };
}

function actorName(item = {}) {
  const payload = payloadOf(item);
  return String(
    item.actorFirstName ||
      payload.actorFirstName ||
      payload.fromName ||
      payload.actorName ||
      payload.paralegalName ||
      ""
  ).trim();
}

function actionForNotification({ item, caseDoc, viewer, access, ids }) {
  const payload = payloadOf(item);
  const type = String(item.type || "").toLowerCase();
  const role = String(viewer?.role || "").toLowerCase();
  const closed = ["completed", "closed"].includes(String(caseDoc?.status || "").toLowerCase()) || caseDoc?.paymentReleased;
  if (type === "application_submitted" && role === "attorney") {
    return { label: "Review application", href: buildObjectDeepLink({ type: "application", ...ids }) };
  }
  if (type === "case_invite" && role === "paralegal") {
    return { label: "View invitation", href: buildObjectDeepLink({ type: "invitation", caseId: ids.caseId }) };
  }
  if (type === "case_invite_response" && role === "attorney") {
    const accepted = String(payload.response || "").toLowerCase() === "accepted";
    return {
      label: accepted ? "Continue hiring" : "Review applications",
      href: accepted && ids.applicantId
        ? buildObjectDeepLink({ type: "application", ...ids })
        : buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "applications" }),
    };
  }
  if (["pre_engagement_requested", "pre_engagement_changes_requested", "pre_engagement_submitted"].includes(type)) {
    return {
      label: type === "pre_engagement_submitted" ? "Review response" : "View requirements",
      href: ids.caseId
        ? buildObjectDeepLink({ type: "application", ...ids, applicantId: ids.applicantId || normalizeId(viewer?.id || viewer?._id) })
        : buildObjectDeepLink({ type: "paralegal_application", applicationId: ids.applicationId }),
    };
  }
  if (type === "case_file_uploaded") {
    return { label: "View file", href: buildObjectDeepLink({ type: "file", ...ids }) };
  }
  if (type === "message") {
    return { label: "View message", href: buildObjectDeepLink({ type: "message", ...ids }) };
  }
  if (["payout_released", "dispute_resolved"].includes(type) && role === "paralegal" && (closed || access.relationship === "withdrawn")) {
    return { label: type === "payout_released" ? "View payout" : "View resolution", href: buildObjectDeepLink({ type: "completed_matter", caseId: ids.caseId, role }) };
  }
  if (["payout_released", "dispute_resolved"].includes(type)) {
    return { label: type === "payout_released" ? "View payment" : "View resolution", href: buildObjectDeepLink({ type: "financials", caseId: ids.caseId }) };
  }
  if (["case_awaiting_funding", "case_work_ready"].includes(type)) {
    const tab = type === "case_awaiting_funding" ? "financials" : "work";
    return { label: type === "case_awaiting_funding" ? "Review funding" : "Open work", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab }) };
  }
  if (type === "application_accepted") {
    return { label: "Open Matter", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "overview" }) };
  }
  if (type === "dispute_opened" || type === "admin_review_overdue") {
    return { label: "View review status", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "activity" }) };
  }
  if (type === "case_update") {
    const summary = String(payload.summary || item.message || "").toLowerCase();
    const tab = /complete|task|work|withdraw|relist/.test(summary) ? "work" : "overview";
    return { label: "View Matter", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab }) };
  }
  return { label: "View Matter", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "overview" }) };
}

function messageForNotification({ item, caseDoc, available }) {
  const payload = payloadOf(item);
  const type = String(item.type || "").toLowerCase();
  const title = String(caseDoc?.title || "this Matter").trim();
  const actor = actorName(item);
  if (!available) return "This notification is no longer available.";
  if (type === "message") {
    const snippet = String(payload.messageSnippet || "").trim();
    const base = `${actor || "A participant"} sent a message about ${title}`;
    return snippet ? `${base}: “${snippet}”` : base;
  }
  if (type === "application_submitted") return `${actor || "A paralegal"} applied to ${title}`;
  if (type === "case_invite") return `${actor || "An attorney"} invited you to ${title}`;
  if (type === "case_invite_response") {
    const response = String(payload.response || "responded").toLowerCase();
    return `${actor || "The invited paralegal"} ${response} the invitation for ${title}`;
  }
  if (type === "pre_engagement_requested") return `Pre-engagement is required for ${title}`;
  if (type === "pre_engagement_submitted") return `A pre-engagement response is ready for review on ${title}`;
  if (type === "pre_engagement_changes_requested") return `Updates are needed for the pre-engagement response on ${title}`;
  if (type === "case_file_uploaded") return `${actor || "A participant"} uploaded ${String(payload.fileName || "a file")} to ${title}`;
  if (type === "case_work_ready") return `${title} is funded and ready for work`;
  if (type === "case_awaiting_funding") return `${title} is awaiting funding`;
  if (type === "payout_released") return `Payout released for ${title}`;
  if (type === "application_accepted") return `Your application for ${title} was accepted`;
  if (type === "application_denied") return `The role for ${title} has been filled`;
  if (type === "dispute_opened") return `A review was opened for ${title}`;
  if (type === "dispute_resolved") return `The review for ${title} was resolved`;
  if (type === "admin_review_overdue") return `The review for ${title} is still in progress`;
  if (type === "case_update") return `${title} was updated`;
  return `View the latest update for ${title}`;
}

function presentNotification(item = {}, { viewer = {}, caseDoc = null, blockedIds = new Set() } = {}) {
  const type = String(item.type || "").toLowerCase();
  const ids = notificationObjectIds(item);
  if (PROFILE_SETTING_TYPES.has(type)) {
    return {
      id: String(item._id || item.id || ""),
      type,
      message: String(item.message || "Your profile has an update."),
      action: { label: "View profile settings", href: buildObjectDeepLink({ type: "profile_settings" }) },
      context: {},
      read: item.isRead ?? item.read ?? false,
      isRead: item.isRead ?? item.read ?? false,
      actorFirstName: "",
      actorProfileImage: "",
      createdAt: item.createdAt || null,
    };
  }
  const expectsCase = !!ids.caseId;
  const access = expectsCase
    ? caseNotificationAccess(caseDoc, viewer, type, blockedIds)
    : { allowed: false, relationship: "missing" };
  const available = expectsCase && access.allowed;
  const action = available ? actionForNotification({ item, caseDoc, viewer, access, ids }) : { label: "", href: "" };
  const safeAction = action.href ? action : { label: "", href: "" };
  const actor = available ? actorName(item) : "";
  return {
    id: String(item._id || item.id || ""),
    type,
    message: messageForNotification({ item, caseDoc, available }),
    action: safeAction,
    context: available
      ? {
          caseId: ids.caseId || undefined,
          applicantId: ids.applicantId || undefined,
          applicationId: ids.applicationId || undefined,
          fileId: ids.fileId || undefined,
          messageId: ids.messageId || undefined,
        }
      : {},
    available,
    read: item.isRead ?? item.read ?? false,
    isRead: item.isRead ?? item.read ?? false,
    actorFirstName: actor,
    actorProfileImage: "",
    createdAt: item.createdAt || null,
  };
}

module.exports = {
  caseNotificationAccess,
  notificationCaseId,
  notificationObjectIds,
  presentNotification,
};
