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
  "dispute_opened",
  "admin_review_overdue",
]);
const PARALEGAL_SELF_SCOPED_TYPES = new Set([
  "application_denied",
  "case_invite_response",
]);
const INCIDENT_REPORTER_MESSAGES = Object.freeze({
  received: id => `Report ${id} received.`,
  investigating: id => `Report ${id} is under review.`,
  testing_fix: id => `A fix for report ${id} is being tested.`,
  awaiting_internal_review: id => `Report ${id} is under review.`,
  fixed_live: id => `Report ${id} was fixed.`,
  needs_more_info: id => `More information is needed for report ${id}.`,
  closed: id => `Report ${id} was closed.`,
});

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

function notificationIncidentPublicId(item = {}) {
  if (String(item.type || "").toLowerCase() !== "incident_update") return "";
  const value = payloadOf(item).incidentPublicId;
  if (typeof value !== "string") return "";
  const publicId = value.trim();
  return publicId && publicId.length <= 64 && !/[\x00-\x1f\x7f]/.test(publicId) ? publicId : "";
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

function isPostWithdrawalCaseUpdate(item = {}, caseDoc = {}) {
  if (String(item.type || "").toLowerCase() !== "case_update") return false;
  const notificationAt = new Date(item.createdAt || 0).getTime();
  const withdrawalAt = new Date(
    caseDoc.pausedAt || caseDoc.paralegalAccessRevokedAt || caseDoc.payoutFinalizedAt || 0
  ).getTime();
  return Number.isFinite(notificationAt)
    && notificationAt > 0
    && Number.isFinite(withdrawalAt)
    && withdrawalAt > 0
    && notificationAt >= withdrawalAt;
}

function caseNotificationAccess(caseDoc, viewer = {}, type = "", blockedIds = new Set(), item = {}) {
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
  const withdrawnSafe = WITHDRAWN_SAFE_TYPES.has(type) || isPostWithdrawalCaseUpdate(item, caseDoc);
  if ((isAssigned || isWithdrawn) && withdrawnSafe) {
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
  if (type === "case_invite_response" && role === "paralegal") {
    return { label: "Browse Matters", href: "/browse-jobs.html" };
  }
  if (type === "application_denied" && role === "paralegal") {
    return { label: "View applications", href: "/dashboard-paralegal.html#cases" };
  }
  if (["pre_engagement_requested", "pre_engagement_changes_requested", "pre_engagement_submitted"].includes(type)) {
    return {
      label: type === "pre_engagement_submitted" ? "Review response" : "View requirements",
      href: role === "paralegal"
        ? buildObjectDeepLink({ type: "paralegal_application", applicationId: ids.applicationId, jobId: firstId(caseDoc?.jobId, caseDoc?.job, ids.caseId) })
        : buildObjectDeepLink({ type: "application", ...ids }),
    };
  }
  if (type === 'case_update' && payloadOf(item).outcome === 'posting_updated' && role === 'paralegal') return {
    label: 'View application', href: buildObjectDeepLink({ type: 'paralegal_application', applicationId: ids.applicationId, jobId: firstId(caseDoc?.jobId, caseDoc?.job, payloadOf(item).jobId, ids.caseId) }),
  };
  if (type === 'case_update' && payloadOf(item).outcome === 'posting_edits_requested' && role === 'attorney') return {
    label: 'Review requested revisions', href: `/dashboard-attorney.html?previewCaseId=${ids.caseId}#cases`,
  };
  if (type === 'case_update' && payloadOf(item).outcome === 'posting_review_requested' && role === 'admin') return { label: 'Review posting', href: '/admin-dashboard.html#posts' };
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
  if (["dispute_opened", "admin_review_overdue"].includes(type) && payload.disputeId) {
    const href = buildObjectDeepLink({ type: "matter_review", caseId: ids.caseId, disputeId: payload.disputeId, role, retained: access.relationship === "withdrawn" });
    if (href) return { label: "View review status", href };
  }
  if (type === "dispute_opened" || type === "admin_review_overdue") {
    if (role === "paralegal" && access.relationship === "withdrawn") {
      return { label: "View review status", href: buildObjectDeepLink({ type: "completed_matter", caseId: ids.caseId, role }) };
    }
    return { label: "View review status", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "activity" }) };
  }
  if (type === "case_update") {
    if (payload.outcome === "matter_completion_recorded" && ["attorney", "admin"].includes(role)) {
      return { label: "Review completed Matter", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "financials" }) };
    }
    if (["paralegal_withdrawn", "withdrawal_decision_recorded"].includes(payload.outcome) && ["attorney", "admin"].includes(role)) {
      return { label: "Review withdrawal", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "financials" }) };
    }
    const retainedPaymentNotice = ["Payment requires action. Open the Matter to review funding.", "The payment has not completed. Open the Matter to review funding."].includes(payload.summary);
    if ((payload.outcome === "payment_action_required" || retainedPaymentNotice) && ["attorney", "admin"].includes(role)) {
      return { label: "Review funding", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "financials" }) };
    }
    if (payload.outcome === "application_withdrawn" && ["attorney", "admin"].includes(role) && ids.applicantId) {
      return { label: "View application", href: buildObjectDeepLink({ type: "retained_application", ...ids }) };
    }
    if (role === "paralegal" && access.relationship === "withdrawn") {
      return { label: "View Matter history", href: buildObjectDeepLink({ type: "completed_matter", caseId: ids.caseId, role }) };
    }
    const summary = String(payload.summary || item.message || "").toLowerCase();
    const tab = /complete|task|work|withdraw|relist/.test(summary) ? "work" : "overview";
    return { label: "View Matter", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab }) };
  }
  return { label: "View Matter", href: buildObjectDeepLink({ type: "matter", caseId: ids.caseId, tab: "overview" }) };
}

function messageForNotification({ item, caseDoc, available }) {
  const payload = payloadOf(item);
  const type = String(item.type || "").toLowerCase();
  const title = String(caseDoc?.title || payload.caseTitle || payload.title || "this Matter").trim();
  const actor = actorName(item);
  if (!available) return "";
  if (type === "message") {
    const snippet = String(payload.messageSnippet || "").trim();
    const base = `${actor || "A participant"} sent a message about ${title}`;
    return snippet ? `${base}: “${snippet}”` : base;
  }
  if (type === "case_budget_locked") {
    const recorded = Number.isSafeInteger(caseDoc?.lockedTotalAmount) && caseDoc.lockedTotalAmount > 0 && caseDoc.amountLockedAt && Number.isFinite(new Date(caseDoc.amountLockedAt).getTime());
    return recorded ? `Matter amount locked for ${title}` : `Review the Matter amount for ${title}`;
  }
  if (type === "application_submitted") return `${actor || "A paralegal"} applied to ${title}`;
  if (type === "case_invite") return `${actor || "An attorney"} invited you to ${title}`;
  if (type === "case_invite_response") {
    const response = String(payload.response || "responded").toLowerCase();
    if (response === "filled") return `The position for ${title} has been filled`;
    if (String(item.message || "").trim()) return String(item.message).trim();
    return `${actor || "The invited paralegal"} ${response} the invitation for ${title}`;
  }
  if (type === "pre_engagement_requested") return `${actor || "The attorney"} requested pre-engagement information for ${title}`;
  if (type === "pre_engagement_submitted") return `${actor || "A paralegal"} submitted a pre-engagement response for ${title}`;
  if (type === "pre_engagement_changes_requested") return `${actor || "The attorney"} requested changes to the pre-engagement response for ${title}`;
  if (type === "case_file_uploaded") return `${actor || "A participant"} uploaded ${String(payload.fileName || "a file")} to ${title}`;
  if (type === "case_work_ready") return `${title} is funded and ready for work`;
  if (type === "case_awaiting_funding") return `${title} is awaiting funding`;
  if (type === "payout_released") return `Payout released for ${title}`;
  if (type === "application_accepted") return `Your application for ${title} was accepted`;
  if (type === "application_denied") {
    const filled = payload.outcome === "matter_filled" || !payload.outcome && !!firstId(caseDoc?.paralegal, caseDoc?.paralegalId);
    return filled ? `The role for ${title} has been filled` : `Your application for ${title} was not selected`;
  }
  if (type === "dispute_opened") return `A review was opened for ${title}`;
  if (type === "dispute_resolved") return `The review for ${title} was resolved`;
  if (type === "admin_review_overdue") return `The review of ${title} was awaiting an LPC decision`;
  if (type === "case_update") {
    const summary = String(payload.summary || item.message || "").trim();
    if (payload.outcome === "application_withdrawn") return `${actor || "A paralegal"} withdrew their application for ${title}`;
    if (payload.outcome === "paralegal_withdrawn") return `${title}: Paralegal withdrawal recorded.`;
    if (payload.outcome === "posting_updated") return `${title}: the attorney updated the posting.`;
    if (payload.outcome === "posting_edits_requested") return `${title}: ${summary}`;
    if (payload.outcome === "posting_review_requested") return `${title}: the attorney requested review of the revised posting.`;
    if (["withdrawal_decision_recorded", "matter_completion_recorded"].includes(payload.outcome) && summary) return `${title}: ${summary}`;
    return summary || `Notification details unavailable for ${title}.`;
  }
  return `Notification details unavailable for ${title}.`;
}

function presentNotificationBase(item = {}, { viewer = {}, caseDoc = null, incidentDoc = null, blockedIds = new Set() } = {}) {
  const type = String(item.type || "").toLowerCase();
  const ids = notificationObjectIds(item);
  // Match the authoritative unread query: either retained true flag means read.
  const isRead = item.read === true || item.isRead === true;
  if (type === "incident_update") {
    const publicId = notificationIncidentPublicId(item);
    const role = String(viewer.role || "").toLowerCase();
    const viewerId = viewer.id || viewer._id;
    const available = !!publicId && incidentDoc?.publicId === publicId
      && ["attorney", "paralegal"].includes(role)
      && sameId(item.userId, viewerId) && sameId(incidentDoc?.reporter?.userId, viewerId);
    // These are historical reporter milestones, not the current Incident state.
    // Never forward stored message, internal state, reporter details or links.
    const status = payloadOf(item).status;
    const message = typeof status === "string" && Object.hasOwn(INCIDENT_REPORTER_MESSAGES, status)
      ? INCIDENT_REPORTER_MESSAGES[status](publicId) : `Report ${publicId} has an update.`;
    return {
      id: String(item._id || item.id || ""), type,
      message: available ? message : "",
      action: available ? { label: "View report", href: `${role === "paralegal" ? "/paralegalhelp.html" : "/help.html"}?incident=${encodeURIComponent(publicId)}` } : { label: "", href: "" },
      context: available ? { incidentPublicId: publicId } : {},
      available, read: isRead, isRead, actorFirstName: "", actorProfileImage: "", createdAt: item.createdAt || null,
    };
  }
  if (type === 'case_deleted' && ['attorney', 'admin'].includes(String(viewer?.role || '').toLowerCase()) && sameId(item.userId, viewer?.id || viewer?._id)) {
    // This recipient's retained removal record is historical. It grants no
    // access to a deleted Matter and must not depend on a live Case lookup.
    const title = String(payloadOf(item).caseTitle || 'your Matter');
    return { id: String(item._id || item.id || ''), type, message: `Your posting for ${title} was removed by an LPC administrator.`, action: { label: 'View Matters', href: viewer.role === 'admin' ? '/admin-dashboard.html#posts' : '/dashboard-attorney.html#cases:inquiries' }, context: {}, available: true, read: isRead, isRead, actorFirstName: '', actorProfileImage: '', createdAt: item.createdAt || null };
  }
  if (PROFILE_SETTING_TYPES.has(type)) {
    return {
      id: String(item._id || item.id || ""),
      type,
      message: String(item.message || "Your profile has an update."),
      action: { label: "View profile settings", href: buildObjectDeepLink({ type: "profile_settings" }) },
      context: {},
      read: isRead,
      isRead,
      actorFirstName: "",
      actorProfileImage: "",
      createdAt: item.createdAt || null,
    };
  }
  const expectsCase = !!ids.caseId;
  let access = expectsCase
    ? caseNotificationAccess(caseDoc, viewer, type, blockedIds, item)
    : { allowed: false, relationship: "missing" };
  if (String(viewer?.role || "").toLowerCase() === "paralegal" && PARALEGAL_SELF_SCOPED_TYPES.has(type)) {
    // These records are selected by Notification.userId before presentation and
    // their actions never open the protected Matter. Preserve the recipient's
    // own application/invitation history after the underlying relationship is
    // rejected, declined, or filled.
    access = { allowed: true, relationship: type === "application_denied" ? "application_history" : "invitation_history" };
  }
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
          matterTitle: String(caseDoc?.title || payloadOf(item).caseTitle || "this Matter").trim(),
          applicantId: ids.applicantId || undefined,
          applicationId: ids.applicationId || undefined,
          fileId: ids.fileId || undefined,
          messageId: ids.messageId || undefined,
        }
      : {},
    available,
    read: isRead,
    isRead,
    actorFirstName: actor,
    actorProfileImage: "",
    createdAt: item.createdAt || null,
  };
}

// Compact copy is derived only after the recipient-safe projection above.
function presentNotification(item = {}, options = {}) {
  const value = presentNotificationBase(item, options);
  if (!value.message || value.available === false) return value;
  const type = String(item.type || '').toLowerCase(), payload = payloadOf(item);
  const actor = value.actorFirstName || '';
  const title = value.context?.matterTitle || (type === 'case_deleted' ? String(payload.caseTitle || 'Your Matter') : '');
  const labels = {
    application_submitted: `${actor || 'A paralegal'} applied`,
    case_invite: `${actor || 'An attorney'} invited you`,
    pre_engagement_requested: `${actor || 'The attorney'} requested pre-engagement information`,
    pre_engagement_submitted: `${actor || 'A paralegal'} submitted a pre-engagement response`,
    pre_engagement_changes_requested: `${actor || 'The attorney'} requested changes to your response`,
    case_file_uploaded: `${actor || 'A participant'} uploaded a file`,
    message: `${actor || 'A participant'} sent a message`,
    case_deleted: 'LPC removed this posting',
    dispute_opened: 'A review was opened', dispute_resolved: 'The review was resolved',
    admin_review_overdue: 'Review was awaiting an LPC decision',
    case_work_ready: 'Funded and ready for work', case_awaiting_funding: 'Awaiting funding',
    payout_released: 'Payout released', application_accepted: 'Your application was accepted',
  };
  let headline = labels[type] || value.message;
  if (type === 'case_budget_locked') headline = value.message.startsWith('Matter amount locked') ? 'Matter amount locked' : 'Review the Matter amount';
  if (type === 'application_denied') headline = value.message.startsWith('The role') ? 'The role has been filled' : 'Your application was not selected';
  if (type === 'case_invite_response') {
    if (payload.response === 'accepted') headline = options.viewer?.role === 'paralegal' ? 'Invitation accepted' : `${actor || 'The paralegal'} accepted your invitation`;
    else if (payload.response === 'declined') headline = options.viewer?.role === 'paralegal' ? 'Invitation declined' : `${actor || 'The paralegal'} declined your invitation`;
    else if (payload.response === 'filled') headline = 'The position has been filled';
  }
  if (type === 'case_update') {
    const updates = {
      application_withdrawn: `${actor || 'A paralegal'} withdrew their application`,
      paralegal_withdrawn: 'Paralegal withdrawal recorded',
      posting_updated: `${actor || 'The attorney'} updated the posting`,
      posting_review_requested: `${actor || 'The attorney'} requested posting review`,
      posting_edits_requested: 'LPC requested posting edits',
      withdrawal_decision_recorded: 'Withdrawal decision recorded',
      matter_completion_recorded: 'Matter completed',
      payment_action_required: 'Funding needs attention',
    };
    // Retained events predate structured outcomes. Recognize only known event
    // wording; keep the full recipient-safe message and destination unchanged.
    const retained = String(payload.summary || item.message || '').trim();
    const legacyUpdates = [
      [/^Release was declined\./i, 'Release declined'],
      [/^Paralegal (?:withdrew\.|requested withdrawal\.)/i, 'Paralegal withdrawal recorded'],
      [/^Partial payout set\./i, 'Withdrawal decision recorded'],
      [/^Close without release recorded\./i, 'Close without release recorded'],
      [/^Payment released\. Case completed and archived\./i, 'Payment release recorded'],
      [/^Case relisted and ready for new applicants\./i, 'Matter relisted'],
      [/^24-hour hold complete\./i, 'Withdrawal review window ended'],
      [/^Admin requested edits:/i, 'LPC requested posting edits'],
      [/^(?:Payment requires (?:action|your attention)|The payment has not completed)\./i, 'Funding needs attention'],
    ];
    headline = updates[payload.outcome] || legacyUpdates.find(([pattern]) => pattern.test(retained))?.[1] || value.message;
    if (title && headline.startsWith(`${title}: `)) headline = headline.slice(title.length + 2);
  }
  return { ...value, headline, contextLabel: title || (type === 'incident_update' ? 'Support' : PROFILE_SETTING_TYPES.has(type) ? 'Profile' : 'Account') };
}

module.exports = {
  caseNotificationAccess,
  notificationCaseId,
  notificationIncidentPublicId,
  notificationObjectIds,
  presentNotification,
};
