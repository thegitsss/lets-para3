// backend/utils/caseState.js
// Authoritative persisted case lifecycle plus viewer-facing state helpers.

const STATUS_IN_PROGRESS = "in progress";
const LEGACY_STATUS_IN_PROGRESS = "in_progress";

const CASE_STATUS = Object.freeze([
  "open",
  STATUS_IN_PROGRESS,
  "paused",
  "completed",
  "disputed",
  "closed",
]);

const CASE_STATUS_ENUM = Object.freeze([...CASE_STATUS, LEGACY_STATUS_IN_PROGRESS]);

const CASE_TRANSITIONS = Object.freeze({
  open: Object.freeze([STATUS_IN_PROGRESS, "closed"]),
  [STATUS_IN_PROGRESS]: Object.freeze(["paused", "completed", "disputed", "closed"]),
  paused: Object.freeze([STATUS_IN_PROGRESS, "disputed", "closed"]),
  completed: Object.freeze(["disputed", "closed"]),
  // A withdrawal dispute may resolve into a relisted paused matter with a
  // remaining funded balance; all other dispute settlements close the matter.
  disputed: Object.freeze(["paused", "closed"]),
  closed: Object.freeze([]),
});

const CASE_STATE = Object.freeze({
  DRAFT: "draft",
  OPEN: "open",
  APPLIED: "applied",
  FUNDED_IN_PROGRESS: "funded_in_progress",
});

const FUNDED_WORKSPACE_STATUSES = new Set([STATUS_IN_PROGRESS]);

function normalizeCaseStatus(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === LEGACY_STATUS_IN_PROGRESS) return STATUS_IN_PROGRESS;
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) {
    return STATUS_IN_PROGRESS;
  }
  return lower;
}

function canTransitionCaseStatus(currentStatus, nextStatus) {
  const current = normalizeCaseStatus(currentStatus);
  const target = normalizeCaseStatus(nextStatus);
  if (!CASE_STATUS.includes(current) || !CASE_STATUS.includes(target)) return false;
  return (CASE_TRANSITIONS[current] || []).includes(target);
}

function objectIdString(value) {
  const resolved = value?._id || value?.id || value || "";
  return resolved ? String(resolved) : "";
}

function hasOpenDispute(caseDoc = {}) {
  return Array.isArray(caseDoc.disputes) && caseDoc.disputes.some(
    (dispute) => normalizeCaseStatus(dispute?.status || "open") === "open"
  );
}

function evaluateCaseLifecycleInvariants(
  caseDoc = {},
  { status: statusOverride, requireFundingIntegrity = true } = {}
) {
  const status = normalizeCaseStatus(statusOverride || caseDoc.status);
  const errors = [];
  const attorney = objectIdString(caseDoc.attorney);
  const attorneyAlias = objectIdString(caseDoc.attorneyId);
  const paralegal = objectIdString(caseDoc.paralegal);
  const paralegalAlias = objectIdString(caseDoc.paralegalId);
  const activeParalegal = paralegal || paralegalAlias;
  const openDispute = hasOpenDispute(caseDoc);

  if (!CASE_STATUS.includes(status)) errors.push("invalid_status");
  if (!attorney && !attorneyAlias) errors.push("attorney_required");
  if (attorney && attorneyAlias && attorney !== attorneyAlias) errors.push("attorney_alias_mismatch");
  if (paralegal && paralegalAlias && paralegal !== paralegalAlias) errors.push("paralegal_alias_mismatch");

  if (status === "open") {
    if (activeParalegal) errors.push("open_case_cannot_have_active_paralegal");
    if (caseDoc.hiredAt) errors.push("open_case_cannot_have_hired_at");
  }

  if (status === STATUS_IN_PROGRESS) {
    if (!activeParalegal) errors.push("active_paralegal_required");
    if (!caseDoc.hiredAt) errors.push("hired_at_required");
    if (!isEscrowFunded(caseDoc)) errors.push("verified_funding_required");
    if (
      requireFundingIntegrity &&
      String(caseDoc.fundingIntegrityStatus || "").toLowerCase() !== "verified"
    ) {
      errors.push("funding_integrity_verification_required");
    }
    if (caseDoc.archived === true || caseDoc.readOnly === true) errors.push("active_case_cannot_be_archived");
  }

  if (status === "paused") {
    if (!caseDoc.pausedReason) errors.push("paused_reason_required");
    if (caseDoc.pausedReason === "paralegal_withdrew") {
      if (!caseDoc.withdrawnParalegalId) errors.push("withdrawn_paralegal_required");
      if (activeParalegal) errors.push("withdrawn_case_cannot_have_active_paralegal");
    }
  }

  if (status === "disputed" && !openDispute) errors.push("open_dispute_required");

  if (status === "completed") {
    if (!activeParalegal) errors.push("active_paralegal_required");
    if (!caseDoc.paymentReleased) errors.push("payment_release_required");
    if (!caseDoc.payoutTransferId) errors.push("payout_reference_required");
    if (!caseDoc.paidOutAt) errors.push("paid_out_at_required");
    if (!caseDoc.completedAt) errors.push("completed_at_required");
    if (caseDoc.archived !== true) errors.push("archive_required");
    if (caseDoc.readOnly !== true) errors.push("read_only_required");
  }

  if (status === "closed" && openDispute) errors.push("open_dispute_must_be_resolved");

  if (caseDoc.paymentReleased === true) {
    if (!caseDoc.payoutTransferId) errors.push("payout_reference_required");
    if (!caseDoc.paidOutAt) errors.push("paid_out_at_required");
    if (!["completed", "closed"].includes(status)) errors.push("released_payment_requires_final_status");
  }

  return [...new Set(errors)];
}

function assertCaseLifecycleInvariants(caseDoc = {}, options = {}) {
  const errors = evaluateCaseLifecycleInvariants(caseDoc, options);
  if (errors.length) {
    const error = new Error(`Case lifecycle invariant failed: ${errors.join(", ")}`);
    error.code = "CASE_LIFECYCLE_INVARIANT";
    error.invariants = errors;
    throw error;
  }
  return true;
}

function hasParalegal(caseDoc) {
  return !!(caseDoc?.paralegal || caseDoc?.paralegalId);
}

function isEscrowFunded(caseDoc) {
  const escrowStatus = String(caseDoc?.escrowStatus || "").toLowerCase();
  return !!caseDoc?.escrowIntentId && escrowStatus === "funded";
}

function viewerApplied(caseDoc, viewerId) {
  if (!viewerId || !Array.isArray(caseDoc?.applicants)) return false;
  const target = String(viewerId);
  return caseDoc.applicants.some((entry) => {
    const id =
      entry?.paralegalId?._id ||
      entry?.paralegalId ||
      entry?.paralegal?._id ||
      entry?.paralegal ||
      "";
    return id && String(id) === target;
  });
}

function resolveCaseState(caseDoc, { viewerId } = {}) {
  const status = normalizeCaseStatus(caseDoc?.status);
  if (!status) return "";
  const funded = isEscrowFunded(caseDoc);
  const hired = hasParalegal(caseDoc);
  if (funded && hired && FUNDED_WORKSPACE_STATUSES.has(status)) {
    return CASE_STATE.FUNDED_IN_PROGRESS;
  }

  if (status === CASE_STATE.DRAFT) return CASE_STATE.DRAFT;
  if (status === CASE_STATE.APPLIED) return CASE_STATE.APPLIED;
  if (status === CASE_STATE.OPEN) {
    return viewerApplied(caseDoc, viewerId) ? CASE_STATE.APPLIED : CASE_STATE.OPEN;
  }

  return status;
}

function canUseWorkspace(caseDoc, opts = {}) {
  return resolveCaseState(caseDoc, opts) === CASE_STATE.FUNDED_IN_PROGRESS;
}

module.exports = {
  CASE_STATUS,
  CASE_STATUS_ENUM,
  CASE_TRANSITIONS,
  CASE_STATE,
  LEGACY_STATUS_IN_PROGRESS,
  STATUS_IN_PROGRESS,
  assertCaseLifecycleInvariants,
  canTransitionCaseStatus,
  evaluateCaseLifecycleInvariants,
  hasOpenDispute,
  normalizeCaseStatus,
  resolveCaseState,
  canUseWorkspace,
};
