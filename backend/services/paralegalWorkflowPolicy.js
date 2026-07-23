const {
  evaluateApplicationEligibility: evaluatePlatformApplicationEligibility,
  evaluateMessagingPermission: evaluatePlatformMessagingPermission,
} = require("./attorneyWorkflowPolicy");

const PARALEGAL_WORKFLOW_STAGES = Object.freeze({
  APPLICATION: "application",
  INVITATION: "invitation",
  PRE_ENGAGEMENT: "pre_engagement",
  ASSIGNMENT: "assignment",
  WORKSPACE: "workspace",
  MESSAGING: "messaging",
  COMPLETION: "completion",
  PAYOUT: "payout",
  WITHDRAWAL: "withdrawal",
  ARCHIVE: "archive",
});

const EVIDENCE_STATES = Object.freeze({
  VERIFIED: "verified",
  ABSENT: "absent",
  UNKNOWN: "unknown",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
  UNAUTHORIZED: "unauthorized",
  NOT_APPLICABLE: "not_applicable",
  BLOCKED_POLICY: "blocked_policy",
});

const PARALEGAL_WORKFLOW_POLICY = Object.freeze({
  [PARALEGAL_WORKFLOW_STAGES.APPLICATION]: Object.freeze({
    requiredRole: "paralegal",
    requiredAccountStatus: "approved",
    allowedMatterStatuses: ["open"],
    requiresUnassignedMatter: true,
    duplicateApplicationAllowed: false,
  }),
  [PARALEGAL_WORKFLOW_STAGES.INVITATION]: Object.freeze({
    requiredRole: "paralegal",
    requiredAccountStatus: "approved",
    requiresPendingInvitation: true,
    requiresScopeTasks: true,
    requiresPayoutSetup: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.PRE_ENGAGEMENT]: Object.freeze({
    requiredRole: "paralegal",
    allowedStatuses: ["requested", "changes_requested"],
    requiresRequestedParalegalMatch: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.ASSIGNMENT]: Object.freeze({
    requiredRole: "paralegal",
    requiresAcceptedSelection: true,
    requiresPayoutSetup: true,
    requiresScopeTasks: true,
    resultingMatterStatus: "in progress",
  }),
  [PARALEGAL_WORKFLOW_STAGES.WORKSPACE]: Object.freeze({
    activeParticipantRequired: true,
    withdrawnHistoryAllowed: true,
    revokedAccessIsReadOnly: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.MESSAGING]: Object.freeze({
    activeParticipantRequired: true,
    blockedRelationshipDenied: true,
    finalOrReadOnlyMatterDenied: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.COMPLETION]: Object.freeze({
    allScopeTasksRequired: true,
    attorneyMarksMatterComplete: true,
    attorneyReleasesFunds: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.PAYOUT]: Object.freeze({
    payoutSetupRequired: true,
    releaseTrigger: "attorney_marks_matter_complete",
    bankDepositEstimateBusinessDays: Object.freeze({ minimum: 3, maximum: 5 }),
    bankReceiptRequiresProcessorEvidence: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.WITHDRAWAL]: Object.freeze({
    activeAssignmentRequired: true,
    finalMatterDenied: true,
    allTasksCompleteDenied: true,
    outcomeDependsOnCompletedScope: true,
  }),
  [PARALEGAL_WORKFLOW_STAGES.ARCHIVE]: Object.freeze({
    completedOrWithdrawnRelationshipRequired: true,
    storageReadinessMustBeVerified: true,
  }),
});

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(normalized)) return "closed";
  return normalized;
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function result(stage, blockers = [], facts = {}, options = {}) {
  const normalizedBlockers = unique(blockers);
  const applicable = options.applicable !== false;
  return {
    stage,
    applicable,
    allowed: applicable && normalizedBlockers.length === 0,
    evidenceState: applicable ? EVIDENCE_STATES.VERIFIED : EVIDENCE_STATES.NOT_APPLICABLE,
    blockers: normalizedBlockers,
    facts,
  };
}

function assignedParalegalId(caseDoc = {}) {
  return normalizeId(caseDoc.paralegalId || caseDoc.paralegal);
}

function isAssignedParalegal(caseDoc = {}, userId = "") {
  return Boolean(normalizeId(userId) && assignedParalegalId(caseDoc) === normalizeId(userId));
}

function isWithdrawnParalegal(caseDoc = {}, userId = "") {
  return Boolean(
    normalizeId(userId) &&
    normalizeId(caseDoc.withdrawnParalegalId) === normalizeId(userId)
  );
}

function allScopeTasksComplete(caseDoc = {}) {
  const tasks = Array.isArray(caseDoc.tasks) ? caseDoc.tasks : [];
  return tasks.length > 0 && tasks.every((task) => task?.completed === true);
}

function evaluateApplicationEligibility(input = {}) {
  if (!input.user && !input.caseDoc) {
    const platformResult = evaluatePlatformApplicationEligibility(input);
    return {
      ...platformResult,
      allowed: platformResult.ready,
    };
  }
  const user = input.user || {};
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  if (String(user.role || "").toLowerCase() !== "paralegal") blockers.push("paralegal_role_required");
  if (String(user.status || "").toLowerCase() !== "approved") blockers.push("approved_account_required");
  if (normalizeStatus(caseDoc.status) !== "open") blockers.push("open_matter_required");
  if (caseDoc.archived === true) blockers.push("matter_archived");
  if (assignedParalegalId(caseDoc)) blockers.push("matter_already_assigned");
  if (input.alreadyApplied === true) blockers.push("application_already_exists");
  if (input.blockedRelationship === true) blockers.push("relationship_blocked");
  return result(PARALEGAL_WORKFLOW_STAGES.APPLICATION, blockers, {
    matterStatus: normalizeStatus(caseDoc.status),
    alreadyApplied: input.alreadyApplied === true,
  });
}

function evaluateInvitationEligibility(input = {}) {
  const user = input.user || {};
  const caseDoc = input.caseDoc || {};
  const stripe = input.stripeState || {};
  const blockers = [];
  if (String(user.role || "").toLowerCase() !== "paralegal") blockers.push("paralegal_role_required");
  if (String(user.status || "").toLowerCase() !== "approved") blockers.push("approved_account_required");
  if (String(input.inviteStatus || "").toLowerCase() !== "pending") blockers.push("pending_invitation_required");
  const assignedId = assignedParalegalId(caseDoc);
  if (assignedId && assignedId !== normalizeId(user._id || user.id)) blockers.push("matter_assigned_to_another_paralegal");
  if (["completed", "closed", "disputed"].includes(normalizeStatus(caseDoc.status))) blockers.push("matter_not_eligible");
  if (!Array.isArray(caseDoc.tasks) || caseDoc.tasks.length === 0) blockers.push("scope_tasks_required");
  if (!stripe.accountId) blockers.push("payout_account_required");
  if (stripe.detailsSubmitted !== true || stripe.payoutsEnabled !== true) blockers.push("payout_setup_incomplete");
  if (input.blockedRelationship === true) blockers.push("relationship_blocked");
  return result(PARALEGAL_WORKFLOW_STAGES.INVITATION, blockers, {
    inviteStatus: String(input.inviteStatus || "").toLowerCase(),
    payoutSetupReady: Boolean(stripe.accountId && stripe.detailsSubmitted && stripe.payoutsEnabled),
  });
}

function evaluatePreEngagementSubmission(input = {}) {
  const userId = normalizeId(input.user?._id || input.user?.id);
  const pre = input.caseDoc?.preEngagement || null;
  const applicable = Boolean(pre);
  const blockers = [];
  if (!pre) blockers.push("pre_engagement_not_requested");
  if (pre && normalizeId(pre.requestedParalegalId) !== userId) blockers.push("requested_paralegal_required");
  if (pre && !["requested", "changes_requested"].includes(String(pre.status || "").toLowerCase())) {
    blockers.push("pre_engagement_not_editable");
  }
  return result(PARALEGAL_WORKFLOW_STAGES.PRE_ENGAGEMENT, blockers, {
    status: String(pre?.status || ""),
    confidentialityRequired: pre?.confidentialityAgreementRequired === true,
    conflictsCheckRequired: pre?.conflictsCheckRequired === true,
  }, { applicable });
}

function evaluateWorkspaceAccess(input = {}) {
  const caseDoc = input.caseDoc || {};
  const userId = normalizeId(input.user?._id || input.user?.id);
  const assigned = isAssignedParalegal(caseDoc, userId);
  const withdrawn = isWithdrawnParalegal(caseDoc, userId);
  const blockers = [];
  if (!assigned && !withdrawn) blockers.push("authorized_matter_relationship_required");
  if (caseDoc.paralegalAccessRevokedAt && !withdrawn) blockers.push("workspace_access_revoked");
  return result(PARALEGAL_WORKFLOW_STAGES.WORKSPACE, blockers, {
    relationship: assigned ? "assigned" : withdrawn ? "withdrawn" : "none",
    readOnly: caseDoc.readOnly === true || withdrawn || ["completed", "closed"].includes(normalizeStatus(caseDoc.status)),
    archived: caseDoc.archived === true,
  });
}

function evaluateMessagingPermission(input = {}) {
  const workspace = evaluateWorkspaceAccess(input);
  const caseDoc = input.caseDoc || {};
  const userId = normalizeId(input.user?._id || input.user?.id || input.viewerId);
  const platform = evaluatePlatformMessagingPermission({
    caseDoc,
    viewerId: userId,
    viewerRole: "paralegal",
    partiesBlocked: input.blockedRelationship === true || input.partiesBlocked === true,
  });
  const blockers = [...workspace.blockers, ...(platform.blockers || [])];
  if (input.blockedRelationship === true || input.partiesBlocked === true) blockers.push("relationship_blocked");
  if (caseDoc.readOnly === true) blockers.push("matter_read_only");
  if (["completed", "closed"].includes(normalizeStatus(caseDoc.status))) blockers.push("matter_final");
  if (workspace.facts.relationship !== "assigned") blockers.push("active_assignment_required");
  return result(PARALEGAL_WORKFLOW_STAGES.MESSAGING, blockers, {
    relationship: workspace.facts.relationship,
    matterStatus: normalizeStatus(caseDoc.status),
  });
}

function evaluateCompletionState(input = {}) {
  const caseDoc = input.caseDoc || {};
  const userId = normalizeId(input.user?._id || input.user?.id);
  const blockers = [];
  if (!isAssignedParalegal(caseDoc, userId)) blockers.push("active_assignment_required");
  if (!allScopeTasksComplete(caseDoc)) blockers.push("scope_tasks_incomplete");
  const status = normalizeStatus(caseDoc.status);
  const completed = status === "completed" || Boolean(caseDoc.completedAt);
  return result(PARALEGAL_WORKFLOW_STAGES.COMPLETION, blockers, {
    allScopeTasksComplete: allScopeTasksComplete(caseDoc),
    matterCompleted: completed,
    paymentReleased: caseDoc.paymentReleased === true,
    nextActor: completed ? (caseDoc.paymentReleased ? "stripe" : "attorney") : "attorney",
  });
}

function evaluatePayoutReadiness(input = {}) {
  const caseDoc = input.caseDoc || {};
  const stripe = input.stripeState || {};
  const userId = normalizeId(input.user?._id || input.user?.id);
  const blockers = [];
  if (!isAssignedParalegal(caseDoc, userId) && !isWithdrawnParalegal(caseDoc, userId)) {
    blockers.push("authorized_matter_relationship_required");
  }
  if (!stripe.accountId || stripe.detailsSubmitted !== true || stripe.payoutsEnabled !== true) {
    blockers.push("payout_setup_incomplete");
  }
  if (!caseDoc.paymentReleased) blockers.push("payment_not_released");
  return result(PARALEGAL_WORKFLOW_STAGES.PAYOUT, blockers, {
    payoutSetupReady: Boolean(stripe.accountId && stripe.detailsSubmitted && stripe.payoutsEnabled),
    matterCompleted: normalizeStatus(caseDoc.status) === "completed" || Boolean(caseDoc.completedAt),
    paymentReleased: caseDoc.paymentReleased === true,
    paidOutAt: caseDoc.paidOutAt || null,
    bankDepositEstimateBusinessDays:
      PARALEGAL_WORKFLOW_POLICY[PARALEGAL_WORKFLOW_STAGES.PAYOUT].bankDepositEstimateBusinessDays,
    bankReceiptConfirmed: input.bankReceiptConfirmed === true,
  });
}

function evaluateWithdrawalEligibility(input = {}) {
  const caseDoc = input.caseDoc || {};
  const userId = normalizeId(input.user?._id || input.user?.id);
  const blockers = [];
  if (!isAssignedParalegal(caseDoc, userId)) blockers.push("active_assignment_required");
  if (["completed", "closed", "disputed"].includes(normalizeStatus(caseDoc.status))) blockers.push("matter_not_withdrawable");
  if (allScopeTasksComplete(caseDoc)) blockers.push("all_scope_tasks_complete");
  if (caseDoc.payoutFinalizedAt) blockers.push("payout_already_finalized");
  const completedTaskCount = (caseDoc.tasks || []).filter((task) => task?.completed === true).length;
  return result(PARALEGAL_WORKFLOW_STAGES.WITHDRAWAL, blockers, {
    completedTaskCount,
    totalTaskCount: Array.isArray(caseDoc.tasks) ? caseDoc.tasks.length : 0,
    outcomeRequiresReview: completedTaskCount > 0,
  });
}

function evaluateArchiveAccess(input = {}) {
  const caseDoc = input.caseDoc || {};
  const userId = normalizeId(input.user?._id || input.user?.id);
  const relationship = isAssignedParalegal(caseDoc, userId) || isWithdrawnParalegal(caseDoc, userId);
  const applicable = relationship && (
    caseDoc.archived === true ||
    ["completed", "closed"].includes(normalizeStatus(caseDoc.status)) ||
    isWithdrawnParalegal(caseDoc, userId)
  );
  const blockers = [];
  if (!relationship) blockers.push("authorized_matter_relationship_required");
  if (!applicable) blockers.push("completed_archived_or_withdrawn_matter_required");
  if (input.storageChecked !== true) blockers.push("archive_storage_unverified");
  else if (input.storageObjectExists !== true) blockers.push("archive_object_missing");
  if (caseDoc.purgedAt) blockers.push("archive_purged");
  return result(PARALEGAL_WORKFLOW_STAGES.ARCHIVE, blockers, {
    archiveReadyAt: caseDoc.archiveReadyAt || null,
    purgeScheduledFor: caseDoc.purgeScheduledFor || null,
    purgedAt: caseDoc.purgedAt || null,
  }, { applicable });
}

function getParalegalWorkflowPolicy() {
  return Object.fromEntries(
    Object.entries(PARALEGAL_WORKFLOW_POLICY).map(([key, value]) => [key, { ...value }])
  );
}

module.exports = {
  EVIDENCE_STATES,
  PARALEGAL_WORKFLOW_STAGES,
  allScopeTasksComplete,
  evaluateApplicationEligibility,
  evaluateArchiveAccess,
  evaluateCompletionState,
  evaluateInvitationEligibility,
  evaluateMessagingPermission,
  evaluatePayoutReadiness,
  evaluatePreEngagementSubmission,
  evaluateWithdrawalEligibility,
  evaluateWorkspaceAccess,
  getParalegalWorkflowPolicy,
  isAssignedParalegal,
  isWithdrawnParalegal,
  normalizeStatus,
};
