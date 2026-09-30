const { normalizeCaseStatus, canUseWorkspace } = require("../utils/caseState");

const MIN_MATTER_AMOUNT_CENTS = 40_000;
const WITHDRAWAL_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const ATTORNEY_PARTIAL_PAYOUT_MAX_PERCENT = 70;
const CASE_ARCHIVE_RETENTION_MONTHS = 6;

const EVIDENCE_STATES = Object.freeze({
  VERIFIED: "verified",
  ABSENT: "absent",
  UNKNOWN: "unknown",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
  UNAUTHORIZED: "unauthorized",
  NOT_APPLICABLE: "not_applicable",
  BLOCKED_POLICY: "blocked_policy",
});

const ATTORNEY_WORKFLOW_STAGES = Object.freeze({
  POST_MATTER: "post_matter",
  RECEIVE_APPLICATIONS: "receive_applications",
  INVITE_PARALEGAL: "invite_paralegal",
  PRE_ENGAGEMENT: "pre_engagement",
  HIRE_AND_FUND: "hire_and_fund",
  WORKSPACE: "workspace",
  MESSAGING: "messaging",
  COMPLETE_AND_RELEASE: "complete_and_release",
  WITHDRAWAL_DECISION: "withdrawal_decision",
  TERMINATION: "termination",
  RELIST: "relist",
  ARCHIVE_DOWNLOAD: "archive_download",
});

const ATTORNEY_WORKFLOW_POLICY = Object.freeze({
  [ATTORNEY_WORKFLOW_STAGES.POST_MATTER]: Object.freeze({
    paymentMethodRequired: false,
    minimumMatterAmountCents: MIN_MATTER_AMOUNT_CENTS,
    label: "Post a matter",
    timing: "not_required_for_posting",
  }),
  [ATTORNEY_WORKFLOW_STAGES.RECEIVE_APPLICATIONS]: Object.freeze({
    paymentMethodRequired: false,
    label: "Receive applications",
    timing: "not_required_for_applications",
  }),
  [ATTORNEY_WORKFLOW_STAGES.INVITE_PARALEGAL]: Object.freeze({
    label: "Invite a paralegal",
    paralegalApprovalRequired: true,
    paralegalPayoutSetupRequired: true,
  }),
  [ATTORNEY_WORKFLOW_STAGES.PRE_ENGAGEMENT]: Object.freeze({
    label: "Request pre-engagement items",
    scopeTaskRequired: true,
    selectedRequirementRequired: true,
  }),
  [ATTORNEY_WORKFLOW_STAGES.HIRE_AND_FUND]: Object.freeze({
    paymentMethodRequired: true,
    minimumMatterAmountCents: MIN_MATTER_AMOUNT_CENTS,
    scopeTaskRequired: true,
    paralegalPayoutSetupRequired: true,
    label: "Hire and fund a matter",
    timing: "before_hiring",
    chargeTiming: "charged_when_hire_is_confirmed",
    requiredProcessorState: "succeeded",
    resultingMatterStatus: "in_progress",
    resultingFundingStatus: "funded",
    locksScopeTasks: true,
    nextStage: ATTORNEY_WORKFLOW_STAGES.WORKSPACE,
  }),
  [ATTORNEY_WORKFLOW_STAGES.WORKSPACE]: Object.freeze({
    label: "Use the matter workspace",
    participants: Object.freeze(["attorney", "hired_paralegal"]),
    supports: Object.freeze(["scope_tasks", "files", "messages"]),
    nextStage: ATTORNEY_WORKFLOW_STAGES.COMPLETE_AND_RELEASE,
  }),
  [ATTORNEY_WORKFLOW_STAGES.MESSAGING]: Object.freeze({ label: "Send matter messages" }),
  [ATTORNEY_WORKFLOW_STAGES.COMPLETE_AND_RELEASE]: Object.freeze({
    label: "Complete the Matter and release payment",
    allScopeTasksComplete: true,
    verifiedFundingRequired: true,
    paralegalPayoutSetupRequired: true,
    payoutReleaseTrigger: "when_attorney_completes_matter",
    resultingMatterStatus: "completed",
    paymentReleased: true,
    bankDepositTimingSource: "stripe_payout_status_and_estimated_arrival",
    bankDepositTimingDependsOn: Object.freeze([
      "stripe_account_country",
      "stripe_payout_schedule",
      "financial_institution",
    ]),
  }),
  [ATTORNEY_WORKFLOW_STAGES.WITHDRAWAL_DECISION]: Object.freeze({
    label: "Resolve a paralegal withdrawal",
    reviewWindowMs: WITHDRAWAL_REVIEW_WINDOW_MS,
    maximumAttorneyPartialPayoutPercent: ATTORNEY_PARTIAL_PAYOUT_MAX_PERCENT,
  }),
  [ATTORNEY_WORKFLOW_STAGES.TERMINATION]: Object.freeze({
    label: "Request matter termination and dispute review",
    assignedParalegalRequired: true,
  }),
  [ATTORNEY_WORKFLOW_STAGES.RELIST]: Object.freeze({
    label: "Relist a withdrawn matter",
    finalizedPayoutRequired: true,
  }),
  [ATTORNEY_WORKFLOW_STAGES.ARCHIVE_DOWNLOAD]: Object.freeze({
    label: "Download a matter archive",
    storageObjectRequired: true,
    retentionMonths: CASE_ARCHIVE_RETENTION_MONTHS,
  }),
});

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function hasValue(value) {
  return String(value || "").trim().length > 0;
}

function hasParalegal(caseDoc = {}) {
  return Boolean(caseDoc.paralegal || caseDoc.paralegalId);
}

function ownsCase(caseDoc = {}, attorneyId = "") {
  const ownerIds = [caseDoc.attorney, caseDoc.attorneyId]
    .map((value) => String(value?._id || value || ""))
    .filter(Boolean);
  return Boolean(attorneyId) && ownerIds.includes(String(attorneyId));
}

function allScopeTasksComplete(caseDoc = {}) {
  const tasks = Array.isArray(caseDoc.tasks) ? caseDoc.tasks : [];
  return tasks.length > 0 && tasks.every((task) => task?.completed === true);
}

function result(stage, blockers = [], facts = {}, { applicable = true } = {}) {
  const normalizedBlockers = unique(blockers);
  return {
    stage,
    evidenceState: applicable ? EVIDENCE_STATES.VERIFIED : EVIDENCE_STATES.NOT_APPLICABLE,
    applicable,
    ready: applicable && normalizedBlockers.length === 0,
    blockers: normalizedBlockers,
    facts,
  };
}

function evaluateMatterPosting(input = {}) {
  const blockers = [];
  const amount = Number(input.amountCents);
  if (!hasValue(input.title)) blockers.push("title_required");
  if (!hasValue(input.details)) blockers.push("description_required");
  if (!hasValue(input.practiceArea)) blockers.push("practice_area_required");
  if (!Number.isFinite(amount) || amount <= 0) blockers.push("valid_amount_required");
  else if (amount < MIN_MATTER_AMOUNT_CENTS) blockers.push("minimum_matter_amount_required");
  if (input.deadlineProvided === true && input.deadlineValid !== true) blockers.push("valid_deadline_required");
  if (input.attorneyStateRequired === true && !hasValue(input.attorneyState)) blockers.push("attorney_state_required");
  return result(ATTORNEY_WORKFLOW_STAGES.POST_MATTER, blockers, {
    minimumMatterAmountCents: MIN_MATTER_AMOUNT_CENTS,
    chargeTiming: ATTORNEY_WORKFLOW_POLICY.hire_and_fund.chargeTiming,
  });
}

function evaluateApplicationEligibility(input = {}) {
  const blockers = [];
  const status = normalizeCaseStatus(input.caseStatus || input.jobStatus);
  const relisted = status === "paused" && input.relistRequestedAt && input.payoutFinalizedAt;
  if (input.applicantApproved !== true) blockers.push("approved_paralegal_required");
  if (input.partiesBlocked === true) blockers.push("parties_blocked");
  if (input.archived === true || (status && status !== "open" && !relisted)) blockers.push("applications_closed");
  if (input.paralegalAssigned === true) blockers.push("paralegal_already_assigned");
  if (input.duplicateApplication === true) blockers.push("duplicate_application");
  if (input.profilePhotoReady === false) blockers.push("profile_photo_required");
  if (input.payoutSetupReady === false) blockers.push("paralegal_payout_setup_required");
  return result(ATTORNEY_WORKFLOW_STAGES.RECEIVE_APPLICATIONS, blockers, { relisted: Boolean(relisted) });
}

function evaluateInvitationEligibility(input = {}) {
  const blockers = [];
  const status = normalizeCaseStatus(input.caseDoc?.status);
  if (input.ownerAuthorized !== true) blockers.push("attorney_ownership_required");
  const relisted =
    status === "paused" &&
    input.caseDoc?.pausedReason === "paralegal_withdrew" &&
    input.caseDoc?.payoutFinalizedAt &&
    Number(input.caseDoc?.remainingAmount) > 0;
  if (input.caseDoc?.archived === true || (status !== "open" && !relisted)) blockers.push("matter_not_open");
  if (input.targetSelected !== true) blockers.push("paralegal_selection_required");
  if (input.targetSelected === true && input.paralegalApproved !== true) blockers.push("approved_paralegal_required");
  if (input.targetSelected === true && input.payoutSetupReady !== true) blockers.push("paralegal_payout_setup_required");
  if (input.partiesBlocked === true) blockers.push("parties_blocked");
  if (hasParalegal(input.caseDoc)) blockers.push("paralegal_already_assigned");
  if (input.existingInviteStatus === "pending") blockers.push("invitation_already_pending");
  if (input.existingInviteStatus === "accepted") blockers.push("invitation_already_accepted");
  return result(ATTORNEY_WORKFLOW_STAGES.INVITE_PARALEGAL, blockers);
}

function evaluatePreEngagementRequest(input = {}) {
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  const status = normalizeCaseStatus(caseDoc.status);
  if (input.ownerAuthorized !== true) blockers.push("attorney_ownership_required");
  if (input.targetSelected !== true) blockers.push("paralegal_selection_required");
  const relisted =
    status === "paused" &&
    caseDoc.pausedReason === "paralegal_withdrew" &&
    caseDoc.payoutFinalizedAt &&
    Number(caseDoc.remainingAmount) > 0;
  if (caseDoc.archived === true || (status !== "open" && !relisted)) blockers.push("matter_not_open");
  if (hasParalegal(caseDoc)) blockers.push("paralegal_already_assigned");
  if (!Array.isArray(caseDoc.tasks) || caseDoc.tasks.length === 0) blockers.push("scope_task_required");
  if (input.partiesBlocked === true) blockers.push("parties_blocked");
  if (input.confidentialityRequired !== true && input.conflictsCheckRequired !== true) {
    blockers.push("pre_engagement_requirement_required");
  }
  if (input.conflictsCheckRequired === true && !hasValue(input.conflictsDetails)) {
    blockers.push("conflicts_details_required");
  }
  if (input.confidentialityRequired === true && input.confidentialityDocumentReady !== true) {
    blockers.push("confidentiality_document_required");
  }
  return result(ATTORNEY_WORKFLOW_STAGES.PRE_ENGAGEMENT, blockers);
}

function evaluateHiringEligibility(input = {}) {
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  const amount = Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount);
  const status = normalizeCaseStatus(caseDoc.status);
  const preEngagementStatus = String(caseDoc.preEngagement?.status || "").toLowerCase();
  if (input.ownerAuthorized !== true) blockers.push("attorney_ownership_required");
  if (input.targetSelected !== true) blockers.push("paralegal_selection_required");
  const relisted =
    status === "paused" &&
    caseDoc.pausedReason === "paralegal_withdrew" &&
    caseDoc.payoutFinalizedAt &&
    Number(caseDoc.remainingAmount) > 0;
  if (caseDoc.archived === true || (status !== "open" && !relisted)) blockers.push("matter_not_open");
  if (hasParalegal(caseDoc)) blockers.push("paralegal_already_assigned");
  if (!Array.isArray(caseDoc.tasks) || caseDoc.tasks.length === 0) blockers.push("scope_task_required");
  if (!Number.isFinite(amount) || amount < MIN_MATTER_AMOUNT_CENTS) blockers.push("minimum_matter_amount_required");
  if (input.partiesBlocked === true) blockers.push("parties_blocked");
  if (input.targetSelected === true && input.paralegalApproved !== true) blockers.push("approved_paralegal_required");
  if (input.targetSelected === true && input.paralegalPayoutSetupReady !== true) blockers.push("paralegal_payout_setup_required");
  if (input.paymentMethodSaved !== true) blockers.push("saved_payment_method_required");
  if (caseDoc.preEngagement && preEngagementStatus !== "approved") blockers.push("pre_engagement_approval_required");
  return result(ATTORNEY_WORKFLOW_STAGES.HIRE_AND_FUND, blockers, {
    minimumMatterAmountCents: MIN_MATTER_AMOUNT_CENTS,
    chargeTiming: ATTORNEY_WORKFLOW_POLICY.hire_and_fund.chargeTiming,
    requiredProcessorState: ATTORNEY_WORKFLOW_POLICY.hire_and_fund.requiredProcessorState,
  });
}

function evaluateWorkspaceAccess(input = {}) {
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  if (!hasParalegal(caseDoc)) blockers.push("hire_required");
  if (!(caseDoc.escrowIntentId && String(caseDoc.escrowStatus || "").toLowerCase() === "funded")) {
    blockers.push("funding_required");
  }
  if (!canUseWorkspace(caseDoc, { viewerId: input.viewerId })) blockers.push("workspace_not_active");
  if (input.viewerRole === "paralegal" && caseDoc.paralegalAccessRevokedAt) blockers.push("workspace_access_revoked");
  return result(ATTORNEY_WORKFLOW_STAGES.WORKSPACE, blockers, {
    readOnly: caseDoc.readOnly === true,
    status: normalizeCaseStatus(caseDoc.status),
  });
}

function evaluateMessagingPermission(input = {}) {
  const workspace = evaluateWorkspaceAccess(input);
  const blockers = [...workspace.blockers];
  if (input.partiesBlocked === true) blockers.push("parties_blocked");
  if (input.caseDoc?.readOnly === true && input.viewerRole !== "admin") blockers.push("case_read_only");
  if (["completed", "closed", "disputed"].includes(normalizeCaseStatus(input.caseDoc?.status))) {
    blockers.push("messaging_closed");
  }
  return result(ATTORNEY_WORKFLOW_STAGES.MESSAGING, blockers, workspace.facts);
}

function evaluateCompletionEligibility(input = {}) {
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  const status = normalizeCaseStatus(caseDoc.status);
  const hasOpenDispute = Array.isArray(caseDoc.disputes) && caseDoc.disputes.some(
    (dispute) => String(dispute?.status || "open").toLowerCase() === "open"
  );
  if (["completed", "closed"].includes(status)) {
    return result(ATTORNEY_WORKFLOW_STAGES.COMPLETE_AND_RELEASE, [], { alreadyCompleted: true }, { applicable: false });
  }
  if (input.ownerAuthorized !== true) blockers.push("attorney_ownership_required");
  if (status !== "in progress") blockers.push("active_matter_required");
  if (caseDoc.archived === true && input.reconcileReleasedPayout !== true) blockers.push("matter_archived");
  if (caseDoc.readOnly === true && input.reconcileReleasedPayout !== true) blockers.push("matter_read_only");
  if (hasOpenDispute || status === "disputed") blockers.push("open_dispute");
  if (!hasParalegal(caseDoc)) blockers.push("hire_required");
  if (!Array.isArray(caseDoc.tasks) || caseDoc.tasks.length === 0) blockers.push("scope_task_required");
  else if (!allScopeTasksComplete(caseDoc)) blockers.push("incomplete_scope_tasks");
  if (!(caseDoc.escrowIntentId && String(caseDoc.escrowStatus || "").toLowerCase() === "funded")) {
    blockers.push("verified_funding_required");
  }
  return result(ATTORNEY_WORKFLOW_STAGES.COMPLETE_AND_RELEASE, blockers, { alreadyCompleted: false });
}

function evaluateWithdrawalAndRelist(input = {}) {
  const caseDoc = input.caseDoc || {};
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const deadline = caseDoc.disputeDeadlineAt ? new Date(caseDoc.disputeDeadlineAt) : null;
  const reviewWindowActive = Boolean(deadline && !Number.isNaN(deadline.getTime()) && deadline > now && !caseDoc.payoutFinalizedAt);
  const withdrawalApplicable = normalizeCaseStatus(caseDoc.status) === "paused" && caseDoc.pausedReason === "paralegal_withdrew";
  const decisionBlockers = [];
  if (!withdrawalApplicable) decisionBlockers.push("withdrawal_state_required");
  if (caseDoc.payoutFinalizedAt) decisionBlockers.push("payout_already_finalized");
  const relistBlockers = [];
  if (!withdrawalApplicable) relistBlockers.push("withdrawal_state_required");
  if (!caseDoc.payoutFinalizedAt) relistBlockers.push("payout_finalization_required");
  if (reviewWindowActive) relistBlockers.push("review_window_active");
  if (!(Number(caseDoc.remainingAmount) > 0)) relistBlockers.push("remaining_amount_required");
  return {
    decision: result(ATTORNEY_WORKFLOW_STAGES.WITHDRAWAL_DECISION, decisionBlockers, {
      reviewWindowActive,
      reviewDeadlineAt: deadline && !Number.isNaN(deadline.getTime()) ? deadline.toISOString() : null,
      maximumAttorneyPartialPayoutPercent: ATTORNEY_PARTIAL_PAYOUT_MAX_PERCENT,
    }, { applicable: withdrawalApplicable }),
    relist: result(ATTORNEY_WORKFLOW_STAGES.RELIST, relistBlockers, {
      reviewWindowActive,
      remainingAmountCents: Number.isFinite(Number(caseDoc.remainingAmount)) ? Number(caseDoc.remainingAmount) : null,
    }, { applicable: withdrawalApplicable }),
  };
}

function evaluateTerminationEligibility(input = {}) {
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  if (input.ownerAuthorized !== true && input.adminAuthorized !== true) blockers.push("attorney_ownership_required");
  if (!hasParalegal(caseDoc)) blockers.push("assigned_paralegal_required");
  if (normalizeCaseStatus(caseDoc.status) !== "in progress") blockers.push("active_matter_required");
  if (caseDoc.archived === true || caseDoc.readOnly === true) blockers.push("matter_final");
  if (Array.isArray(caseDoc.disputes) && caseDoc.disputes.some(
    (dispute) => String(dispute?.status || "open").toLowerCase() === "open"
  )) blockers.push("open_dispute");
  if (!["", "none", "resolved"].includes(String(caseDoc.terminationStatus || "").toLowerCase())) {
    blockers.push("termination_already_in_progress");
  }
  return result(ATTORNEY_WORKFLOW_STAGES.TERMINATION, blockers, {
    opensDisputeReview: true,
    currentTerminationStatus: String(caseDoc.terminationStatus || "none"),
  });
}

function evaluateArchiveReadiness(input = {}) {
  const caseDoc = input.caseDoc || {};
  const blockers = [];
  const status = normalizeCaseStatus(caseDoc.status);
  const applicable = caseDoc.archived === true || ["completed", "closed"].includes(status);
  if (!applicable) blockers.push("completed_or_archived_matter_required");
  if (!hasValue(caseDoc.archiveZipKey)) blockers.push("archive_not_generated");
  if (input.storageChecked !== true) blockers.push("archive_storage_unverified");
  else if (input.storageObjectExists !== true) blockers.push("archive_object_missing");
  if (caseDoc.purgedAt) blockers.push("archive_purged");
  const final = ["completed", "closed"].includes(status);
  const recordedDeadline = caseDoc.purgeScheduledFor || (final && caseDoc.completedAt ? calculateArchivePurgeAt(caseDoc.completedAt) : null);
  const retentionEndsAt = recordedDeadline ? new Date(recordedDeadline) : null;
  if ((final && !retentionEndsAt) || retentionEndsAt && Number.isNaN(retentionEndsAt.getTime())) blockers.push("archive_retention_unconfirmed");
  else if (retentionEndsAt && retentionEndsAt <= new Date(input.now || Date.now())) blockers.push("archive_retention_expired");
  return result(ATTORNEY_WORKFLOW_STAGES.ARCHIVE_DOWNLOAD, blockers, {
    archiveReadyAt: caseDoc.archiveReadyAt || null,
    purgeScheduledFor: retentionEndsAt && !Number.isNaN(retentionEndsAt.getTime()) ? retentionEndsAt.toISOString() : null,
    purgedAt: caseDoc.purgedAt || null,
  }, { applicable });
}

function calculateArchivePurgeAt(completedAt = new Date()) {
  const purgeAt = completedAt instanceof Date ? new Date(completedAt) : new Date(completedAt);
  if (Number.isNaN(purgeAt.getTime())) return null;
  purgeAt.setUTCMonth(purgeAt.getUTCMonth() + CASE_ARCHIVE_RETENTION_MONTHS);
  return purgeAt;
}

function getAttorneyWorkflowPolicy() {
  return Object.fromEntries(
    Object.entries(ATTORNEY_WORKFLOW_POLICY).map(([stage, policy]) => [stage, { ...policy }])
  );
}

function isAttorneyPaymentMethodRequired(stage = "") {
  return ATTORNEY_WORKFLOW_POLICY[String(stage || "")]?.paymentMethodRequired === true;
}

module.exports = {
  ATTORNEY_PARTIAL_PAYOUT_MAX_PERCENT,
  CASE_ARCHIVE_RETENTION_MONTHS,
  ATTORNEY_WORKFLOW_STAGES,
  EVIDENCE_STATES,
  MIN_MATTER_AMOUNT_CENTS,
  WITHDRAWAL_REVIEW_WINDOW_MS,
  allScopeTasksComplete,
  calculateArchivePurgeAt,
  evaluateApplicationEligibility,
  evaluateArchiveReadiness,
  evaluateCompletionEligibility,
  evaluateHiringEligibility,
  evaluateInvitationEligibility,
  evaluateMatterPosting,
  evaluateMessagingPermission,
  evaluatePreEngagementRequest,
  evaluateTerminationEligibility,
  evaluateWithdrawalAndRelist,
  evaluateWorkspaceAccess,
  getAttorneyWorkflowPolicy,
  isAttorneyPaymentMethodRequired,
  ownsCase,
};
