// backend/utils/caseState.js
// Centralized case state helpers (UI + route gating).

const CASE_STATE = Object.freeze({
  DRAFT: "draft",
  OPEN: "open",
  APPLIED: "applied",
  FUNDED_IN_PROGRESS: "funded_in_progress",
});

const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);

function normalizeCaseStatus(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) return "in progress";
  return lower;
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
  CASE_STATE,
  normalizeCaseStatus,
  resolveCaseState,
  canUseWorkspace,
};
