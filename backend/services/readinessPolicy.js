const READINESS_REQUIREMENTS = Object.freeze({
  ACCOUNT_APPROVAL: "account_approval",
  ACCOUNT_INFORMATION: "account_information",
  PROFESSIONAL_INFORMATION: "professional_information",
  BIO: "bio",
  SKILLS: "skills",
  PRACTICE_AREAS: "practice_areas",
  RESUME: "resume",
  APPROVED_PHOTO: "approved_photo",
  PUBLIC_VISIBILITY: "public_visibility",
  PAYOUTS: "payouts",
  PAYMENT_METHOD: "payment_method",
  PARTICIPANT_AUTHORIZATION: "participant_authorization",
  FUNDED_ASSIGNMENT: "funded_assignment",
  MATTER_ACCESS: "matter_access",
});

const READINESS_REQUIREMENT_KEYS = Object.freeze(Object.values(READINESS_REQUIREMENTS));
const READINESS_REQUIREMENT_KEY_SET = new Set(READINESS_REQUIREMENT_KEYS);

const READINESS_STATUSES = Object.freeze({
  MISSING: "missing",
  INCOMPLETE: "incomplete",
  PENDING_REVIEW: "pending_review",
  REJECTED: "rejected",
  UNUSABLE: "unusable",
  HIDDEN: "hidden",
  DISABLED: "disabled",
  INELIGIBLE: "ineligible",
  UNKNOWN: "unknown",
  UNAVAILABLE: "unavailable",
  ARCHIVED: "archived",
  REVOKED: "revoked",
});

const READINESS_STATUS_SET = new Set(Object.values(READINESS_STATUSES));

const PHOTO_STATES = Object.freeze({
  MISSING: "missing",
  PENDING_REVIEW: "pending_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  UNUSABLE: "unusable",
});

const PAYMENT_EVIDENCE_STATES = Object.freeze({
  VERIFIED: "verified",
  ABSENT: "absent",
  UNKNOWN: "unknown",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasListValue(value) {
  return Array.isArray(value) && value.some((item) => hasText(item));
}

function reason(key, status, code, fields) {
  if (!READINESS_REQUIREMENT_KEY_SET.has(key)) {
    throw new Error(`Unknown readiness requirement key: ${key}`);
  }
  if (!READINESS_STATUS_SET.has(status)) {
    throw new Error(`Unknown readiness status: ${status}`);
  }

  return {
    key,
    status,
    ...(code ? { code } : {}),
    ...(Array.isArray(fields) && fields.length ? { fields: [...fields] } : {}),
  };
}

function result(reasons = []) {
  const orderedReasons = [...reasons].sort(
    (left, right) =>
      READINESS_REQUIREMENT_KEYS.indexOf(left.key) -
      READINESS_REQUIREMENT_KEYS.indexOf(right.key)
  );
  const missing = READINESS_REQUIREMENT_KEYS.filter((key) =>
    orderedReasons.some((item) => item.key === key)
  );

  return {
    ready: missing.length === 0,
    missing,
    reasons: orderedReasons,
  };
}

function accountApprovalReason(user = {}, requiredRole) {
  const role = String(user?.role || "").trim().toLowerCase();
  const status = String(user?.status || "").trim().toLowerCase();

  if (role !== requiredRole) {
    return reason(
      READINESS_REQUIREMENTS.ACCOUNT_APPROVAL,
      READINESS_STATUSES.INELIGIBLE,
      `${requiredRole}_role_required`
    );
  }
  if (user?.deleted === true) {
    return reason(
      READINESS_REQUIREMENTS.ACCOUNT_APPROVAL,
      READINESS_STATUSES.DISABLED,
      "account_deleted"
    );
  }
  if (user?.disabled === true) {
    return reason(
      READINESS_REQUIREMENTS.ACCOUNT_APPROVAL,
      READINESS_STATUSES.DISABLED,
      "account_disabled"
    );
  }
  if (status === "pending") {
    return reason(
      READINESS_REQUIREMENTS.ACCOUNT_APPROVAL,
      READINESS_STATUSES.PENDING_REVIEW,
      "account_approval_pending"
    );
  }
  if (status === "rejected") {
    return reason(
      READINESS_REQUIREMENTS.ACCOUNT_APPROVAL,
      READINESS_STATUSES.REJECTED,
      "account_approval_rejected"
    );
  }
  if (status !== "approved") {
    return reason(
      READINESS_REQUIREMENTS.ACCOUNT_APPROVAL,
      status ? READINESS_STATUSES.INELIGIBLE : READINESS_STATUSES.MISSING,
      status ? "account_not_approved" : "account_status_missing"
    );
  }
  return null;
}

function attorneyAccountReasons(user = {}) {
  const reasons = [];
  const approvalReason = accountApprovalReason(user, "attorney");
  if (approvalReason) reasons.push(approvalReason);

  const missingAccountFields = [];
  if (!hasText(user?.firstName)) missingAccountFields.push("first_name");
  if (!hasText(user?.lastName)) missingAccountFields.push("last_name");
  if (!hasText(user?.email)) missingAccountFields.push("email");
  if (user?.emailVerified !== true) missingAccountFields.push("email_verification");
  if (user?.termsAccepted !== true) missingAccountFields.push("terms_acceptance");
  if (user?.attorneyPricingAccepted !== true) {
    missingAccountFields.push("attorney_pricing_acceptance");
  }
  if (missingAccountFields.length) {
    reasons.push(
      reason(
        READINESS_REQUIREMENTS.ACCOUNT_INFORMATION,
        READINESS_STATUSES.INCOMPLETE,
        "account_information_incomplete",
        missingAccountFields
      )
    );
  }

  const missingProfessionalFields = [];
  if (!hasText(user?.state)) missingProfessionalFields.push("state");
  if (!hasText(user?.barNumber)) missingProfessionalFields.push("bar_number");
  if (!hasText(user?.barState) && !hasText(user?.location)) {
    missingProfessionalFields.push("bar_state");
  }
  if (missingProfessionalFields.length) {
    reasons.push(
      reason(
        READINESS_REQUIREMENTS.PROFESSIONAL_INFORMATION,
        READINESS_STATUSES.INCOMPLETE,
        "professional_information_incomplete",
        missingProfessionalFields
      )
    );
  }

  return reasons;
}

function evaluateAttorneyAccountReadiness(user = {}) {
  return result(attorneyAccountReasons(user));
}

function evaluateAttorneyPaymentReadiness(paymentState = {}) {
  if (!isObject(paymentState)) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.UNKNOWN,
        "payment_state_malformed"
      ),
    ]);
  }

  const evidenceState = String(paymentState.evidenceState || "").trim().toLowerCase();
  if (
    typeof paymentState.available !== "boolean" ||
    typeof paymentState.isValid !== "boolean"
  ) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.UNKNOWN,
        "payment_state_malformed"
      ),
    ]);
  }
  if (evidenceState === PAYMENT_EVIDENCE_STATES.TEMPORARILY_UNAVAILABLE) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.UNAVAILABLE,
        "payment_state_unavailable"
      ),
    ]);
  }
  if (evidenceState === PAYMENT_EVIDENCE_STATES.ABSENT) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.MISSING,
        "default_payment_method_missing"
      ),
    ]);
  }
  if (evidenceState === PAYMENT_EVIDENCE_STATES.UNKNOWN) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.UNKNOWN,
        "payment_state_unknown"
      ),
    ]);
  }
  if (
    evidenceState !== PAYMENT_EVIDENCE_STATES.VERIFIED ||
    paymentState.available !== true
  ) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.UNKNOWN,
        "payment_state_malformed"
      ),
    ]);
  }
  if (paymentState.isValid !== true) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PAYMENT_METHOD,
        READINESS_STATUSES.UNUSABLE,
        "default_payment_method_unusable"
      ),
    ]);
  }
  return result();
}

function resolveParalegalPhotoState(user = {}) {
  const photoStatus = String(user?.profilePhotoStatus || "").trim().toLowerCase();
  const hasPendingPhoto = hasText(user?.pendingProfileImage);
  const hasApprovedPhoto = hasText(user?.profileImage) || hasText(user?.avatarURL);

  if (hasPendingPhoto || photoStatus === "pending_review") {
    return PHOTO_STATES.PENDING_REVIEW;
  }
  if (photoStatus === "rejected") {
    return PHOTO_STATES.REJECTED;
  }
  if (photoStatus === "approved" && hasApprovedPhoto) {
    return PHOTO_STATES.APPROVED;
  }
  if ((!photoStatus || photoStatus === "unsubmitted") && !hasApprovedPhoto) {
    return PHOTO_STATES.MISSING;
  }
  return PHOTO_STATES.UNUSABLE;
}

function paralegalPhotoReason(user = {}) {
  const photoState = resolveParalegalPhotoState(user);
  if (photoState === PHOTO_STATES.APPROVED) return null;
  if (photoState === PHOTO_STATES.PENDING_REVIEW) {
    return reason(
      READINESS_REQUIREMENTS.APPROVED_PHOTO,
      READINESS_STATUSES.PENDING_REVIEW,
      "profile_photo_review_pending"
    );
  }
  if (photoState === PHOTO_STATES.REJECTED) {
    return reason(
      READINESS_REQUIREMENTS.APPROVED_PHOTO,
      READINESS_STATUSES.REJECTED,
      "profile_photo_rejected"
    );
  }
  if (photoState === PHOTO_STATES.UNUSABLE) {
    return reason(
      READINESS_REQUIREMENTS.APPROVED_PHOTO,
      READINESS_STATUSES.UNUSABLE,
      "profile_photo_unusable"
    );
  }
  return reason(
    READINESS_REQUIREMENTS.APPROVED_PHOTO,
    READINESS_STATUSES.MISSING,
    "profile_photo_missing"
  );
}

function paralegalCoreProfileReasons(user = {}) {
  const reasons = [];
  if (!hasText(user?.bio)) {
    reasons.push(reason(READINESS_REQUIREMENTS.BIO, READINESS_STATUSES.MISSING, "bio_missing"));
  }
  if (!hasListValue(user?.skills)) {
    reasons.push(
      reason(READINESS_REQUIREMENTS.SKILLS, READINESS_STATUSES.MISSING, "skills_missing")
    );
  }
  if (!hasListValue(user?.practiceAreas)) {
    reasons.push(
      reason(
        READINESS_REQUIREMENTS.PRACTICE_AREAS,
        READINESS_STATUSES.MISSING,
        "practice_areas_missing"
      )
    );
  }
  if (!hasText(user?.resumeURL)) {
    reasons.push(
      reason(READINESS_REQUIREMENTS.RESUME, READINESS_STATUSES.MISSING, "resume_missing")
    );
  }
  const photoReason = paralegalPhotoReason(user);
  if (photoReason) reasons.push(photoReason);
  return reasons;
}

function paralegalProfessionalReadinessReasons(user = {}) {
  const reasons = [];
  const approvalReason = accountApprovalReason(user, "paralegal");
  if (approvalReason) reasons.push(approvalReason);
  reasons.push(...paralegalCoreProfileReasons(user));
  return reasons;
}

function evaluateParalegalPublicSearchReadiness(user = {}) {
  const reasons = paralegalProfessionalReadinessReasons(user);
  if (user?.preferences?.hideProfile === true) {
    reasons.push(
      reason(
        READINESS_REQUIREMENTS.PUBLIC_VISIBILITY,
        READINESS_STATUSES.HIDDEN,
        "public_profile_hidden"
      )
    );
  }
  return result(reasons);
}

function evaluateParalegalMatterViewReadiness(user = {}) {
  const approvalReason = accountApprovalReason(user, "paralegal");
  return result(approvalReason ? [approvalReason] : []);
}

function evaluateParalegalApplicationReadiness(user = {}) {
  return result(paralegalProfessionalReadinessReasons(user));
}

function evaluateParalegalInvitationAcceptanceReadiness(user = {}) {
  return result(paralegalProfessionalReadinessReasons(user));
}

function payoutReadinessReasons(payoutState = {}) {
  if (!isObject(payoutState)) {
    return [
      reason(
        READINESS_REQUIREMENTS.PAYOUTS,
        READINESS_STATUSES.UNKNOWN,
        "payout_state_malformed"
      ),
    ];
  }
  if (!hasText(payoutState.accountId)) {
    return [
      reason(
        READINESS_REQUIREMENTS.PAYOUTS,
        READINESS_STATUSES.MISSING,
        "payout_account_missing"
      ),
    ];
  }

  const missingStateFields = [];
  if (typeof payoutState.detailsSubmitted !== "boolean") {
    missingStateFields.push("details_submitted");
  }
  if (typeof payoutState.payoutsEnabled !== "boolean") {
    missingStateFields.push("payouts_enabled");
  }
  if (missingStateFields.length) {
    return [
      reason(
        READINESS_REQUIREMENTS.PAYOUTS,
        READINESS_STATUSES.UNKNOWN,
        "payout_state_incomplete",
        missingStateFields
      ),
    ];
  }

  const incompleteFields = [];
  if (payoutState.detailsSubmitted !== true) incompleteFields.push("details_submitted");
  if (payoutState.payoutsEnabled !== true) incompleteFields.push("payouts_enabled");
  if (incompleteFields.length) {
    return [
      reason(
        READINESS_REQUIREMENTS.PAYOUTS,
        READINESS_STATUSES.INCOMPLETE,
        "payout_setup_incomplete",
        incompleteFields
      ),
    ];
  }
  return [];
}

function evaluateParalegalFinalSelectionReadiness(user = {}, payoutState = {}) {
  return result([
    ...paralegalProfessionalReadinessReasons(user),
    ...payoutReadinessReasons(payoutState),
  ]);
}

function normalizedBooleanReason(value, options) {
  if (typeof value !== "boolean") {
    return reason(options.key, READINESS_STATUSES.UNKNOWN, options.unknownCode);
  }
  if (value === options.readyValue) return null;
  return reason(options.key, options.blockedStatus, options.blockedCode);
}

function evaluateFundedWorkspaceReadiness(workspaceState = {}) {
  if (!isObject(workspaceState)) {
    return result([
      reason(
        READINESS_REQUIREMENTS.PARTICIPANT_AUTHORIZATION,
        READINESS_STATUSES.UNKNOWN,
        "workspace_state_malformed"
      ),
    ]);
  }

  const reasons = [];
  const checks = [
    normalizedBooleanReason(workspaceState.participantAuthorized, {
      key: READINESS_REQUIREMENTS.PARTICIPANT_AUTHORIZATION,
      readyValue: true,
      blockedStatus: READINESS_STATUSES.INELIGIBLE,
      blockedCode: "participant_not_authorized",
      unknownCode: "participant_authorization_unknown",
    }),
    normalizedBooleanReason(workspaceState.fundedAssignment, {
      key: READINESS_REQUIREMENTS.FUNDED_ASSIGNMENT,
      readyValue: true,
      blockedStatus: READINESS_STATUSES.MISSING,
      blockedCode: "funded_assignment_missing",
      unknownCode: "funded_assignment_unknown",
    }),
    normalizedBooleanReason(workspaceState.matterStatusEligible, {
      key: READINESS_REQUIREMENTS.MATTER_ACCESS,
      readyValue: true,
      blockedStatus: READINESS_STATUSES.INELIGIBLE,
      blockedCode: "matter_status_ineligible",
      unknownCode: "matter_status_unknown",
    }),
    normalizedBooleanReason(workspaceState.archived, {
      key: READINESS_REQUIREMENTS.MATTER_ACCESS,
      readyValue: false,
      blockedStatus: READINESS_STATUSES.ARCHIVED,
      blockedCode: "matter_archived",
      unknownCode: "archive_state_unknown",
    }),
    normalizedBooleanReason(workspaceState.accessRevoked, {
      key: READINESS_REQUIREMENTS.MATTER_ACCESS,
      readyValue: false,
      blockedStatus: READINESS_STATUSES.REVOKED,
      blockedCode: "workspace_access_revoked",
      unknownCode: "access_revocation_state_unknown",
    }),
    normalizedBooleanReason(workspaceState.securityAllowed, {
      key: READINESS_REQUIREMENTS.MATTER_ACCESS,
      readyValue: true,
      blockedStatus: READINESS_STATUSES.INELIGIBLE,
      blockedCode: "workspace_security_rule_blocked",
      unknownCode: "workspace_security_state_unknown",
    }),
    normalizedBooleanReason(workspaceState.relationshipAllowed, {
      key: READINESS_REQUIREMENTS.MATTER_ACCESS,
      readyValue: true,
      blockedStatus: READINESS_STATUSES.INELIGIBLE,
      blockedCode: "workspace_relationship_rule_blocked",
      unknownCode: "workspace_relationship_state_unknown",
    }),
  ];
  checks.forEach((check) => {
    if (check) reasons.push(check);
  });
  return result(reasons);
}

module.exports = {
  PAYMENT_EVIDENCE_STATES,
  PHOTO_STATES,
  READINESS_REQUIREMENTS,
  READINESS_REQUIREMENT_KEYS,
  READINESS_STATUSES,
  evaluateAttorneyAccountReadiness,
  evaluateAttorneyPaymentReadiness,
  evaluateFundedWorkspaceReadiness,
  evaluateParalegalApplicationReadiness,
  evaluateParalegalFinalSelectionReadiness,
  evaluateParalegalInvitationAcceptanceReadiness,
  evaluateParalegalMatterViewReadiness,
  evaluateParalegalPublicSearchReadiness,
  resolveParalegalPhotoState,
};
