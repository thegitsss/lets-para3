const { INCIDENT_STATES, INCIDENT_TERMINAL_STATES } = require("../../utils/incidentConstants");

const TERMINAL_STATE_SET = new Set(INCIDENT_TERMINAL_STATES);
const STATE_SET = new Set(INCIDENT_STATES);

const BASE_TRANSITIONS = Object.freeze({
  reported: ["intake_validated", "closed_duplicate", "needs_more_context", "needs_human_owner"],
  intake_validated: ["classified", "closed_duplicate", "needs_more_context", "needs_human_owner"],
  classified: ["investigating", "awaiting_founder_approval", "needs_human_owner"],
  investigating: [
    "patch_planning",
    "needs_more_context",
    "closed_no_repro",
    "closed_not_actionable",
    "needs_human_owner",
  ],
  patch_planning: ["patching", "needs_human_owner", "closed_not_actionable"],
  patching: ["patching", "awaiting_verification", "verification_failed", "needs_human_owner"],
  awaiting_verification: ["verified_release_candidate", "verification_failed", "needs_human_owner"],
  verification_failed: ["needs_human_owner", "closed_not_actionable"],
  verified_release_candidate: ["deploying_preview", "awaiting_founder_approval", "needs_human_owner"],
  awaiting_founder_approval: ["deploying_preview", "needs_human_owner", "closed_rejected"],
  deploying_preview: ["deploying_production", "deploy_failed", "needs_human_owner"],
  deploying_production: ["post_deploy_verifying", "deploy_failed", "rollback_in_progress", "needs_human_owner"],
  post_deploy_verifying: ["rollback_in_progress", "needs_human_owner"],
  deploy_failed: [],
  rollback_in_progress: ["closed_rolled_back", "needs_human_owner"],
  needs_more_context: [],
  needs_human_owner: [],
  resolved: [],
  closed_duplicate: [],
  closed_no_repro: [],
  closed_not_actionable: [],
  closed_rejected: [],
  closed_rolled_back: [],
});

const CONDITIONAL_TRANSITIONS = Object.freeze({
  needs_more_context: [
    {
      to: "intake_validated",
      when: (context) => context.hasAdditionalContext === true,
      reason: "Additional context is required before returning the incident to intake validation.",
    },
  ],
  verification_failed: [
    {
      to: "patch_planning",
      when: (context) =>
        Number.isFinite(context.verificationRetriesRemaining) &&
        context.verificationRetriesRemaining > 0,
      reason: "Verification can only retry when verification retries remain.",
    },
  ],
  awaiting_founder_approval: [
    {
      to: "verified_release_candidate",
      when: (context) => context.founderApprovalGranted === true,
      reason: "Returning to the verified release candidate queue requires a recorded founder approval grant.",
    },
  ],
  deploying_preview: [
    {
      to: "verified_release_candidate",
      when: (context) => context.previewPreparedOnly === true,
      reason: "Returning to the verified release candidate queue requires an explicit preview-prepared transition.",
    },
  ],
  deploy_failed: [
    {
      to: "verified_release_candidate",
      when: (context) =>
        context.failureMode === "transient_infra" && context.productionDeployStarted !== true,
      reason: "Deploy retry is only allowed for transient infrastructure failures before production starts.",
    },
  ],
  post_deploy_verifying: [
    {
      to: "resolved",
      when: (context) => context.postDeployChecksPassed === true,
      reason: "Incident resolution requires passing post-deploy production verification.",
    },
  ],
  closed_no_repro: [
    {
      to: "investigating",
      when: (context) => context.explicitAdminReopen === true && context.hasNewEvidence === true,
      reason: "Closed no-repro incidents can only reopen with explicit admin action and new evidence.",
    },
  ],
});

const RETRY_TRANSITIONS = new Set([
  "needs_more_context->intake_validated",
  "verification_failed->patch_planning",
  "deploy_failed->verified_release_candidate",
  "closed_no_repro->investigating",
]);

const ESCALATION_TRANSITIONS = new Set([
  "reported->needs_human_owner",
  "intake_validated->needs_human_owner",
  "classified->needs_human_owner",
  "investigating->needs_human_owner",
  "patch_planning->needs_human_owner",
  "patching->needs_human_owner",
  "awaiting_verification->needs_human_owner",
  "verification_failed->needs_human_owner",
  "verified_release_candidate->awaiting_founder_approval",
  "verified_release_candidate->needs_human_owner",
  "awaiting_founder_approval->needs_human_owner",
  "deploying_preview->needs_human_owner",
  "deploying_production->needs_human_owner",
  "post_deploy_verifying->rollback_in_progress",
  "deploying_production->rollback_in_progress",
  "rollback_in_progress->needs_human_owner",
]);

function transitionKey(fromState, toState) {
  return `${fromState}->${toState}`;
}

function isKnownState(state) {
  return STATE_SET.has(String(state || ""));
}

function isTerminalState(state) {
  return TERMINAL_STATE_SET.has(String(state || ""));
}

function getConditionalTransition(fromState, toState) {
  return (CONDITIONAL_TRANSITIONS[fromState] || []).find((entry) => entry.to === toState) || null;
}

function getAllowedTransitions(fromState, context = {}) {
  if (!isKnownState(fromState)) return [];
  const allowed = new Set(BASE_TRANSITIONS[fromState] || []);

  (CONDITIONAL_TRANSITIONS[fromState] || []).forEach((entry) => {
    if (entry.when(context || {})) allowed.add(entry.to);
  });

  return Array.from(allowed);
}

function getTransitionBlockReason(fromState, toState, context = {}) {
  const from = String(fromState || "");
  const to = String(toState || "");

  if (!isKnownState(from)) return `Unknown fromState "${from}".`;
  if (!isKnownState(to)) return `Unknown toState "${to}".`;
  if (from === to && !(BASE_TRANSITIONS[from] || []).includes(to)) {
    return `State "${from}" does not support self-transitions.`;
  }
  if (isTerminalState(from)) {
    const conditional = getConditionalTransition(from, to);
    if (!conditional) return `Terminal state "${from}" cannot transition to "${to}".`;
    if (!conditional.when(context)) return conditional.reason;
    return null;
  }
  if ((BASE_TRANSITIONS[from] || []).includes(to)) return null;

  const conditional = getConditionalTransition(from, to);
  if (conditional) {
    return conditional.when(context) ? null : conditional.reason;
  }

  return `Transition "${from}" -> "${to}" is not allowed.`;
}

function canTransition(fromState, toState, context = {}) {
  const reason = getTransitionBlockReason(fromState, toState, context);
  return {
    allowed: !reason,
    reason,
  };
}

function assertTransition(fromState, toState, context = {}) {
  const result = canTransition(fromState, toState, context);
  if (!result.allowed) {
    const error = new Error(
      `Invalid incident state transition.${result.reason ? ` ${result.reason}` : ""}`.trim()
    );
    error.code = "INVALID_INCIDENT_TRANSITION";
    error.fromState = fromState;
    error.toState = toState;
    throw error;
  }
  return true;
}

function isRetryTransition(fromState, toState) {
  return RETRY_TRANSITIONS.has(transitionKey(fromState, toState));
}

function isEscalationTransition(fromState, toState) {
  return ESCALATION_TRANSITIONS.has(transitionKey(fromState, toState));
}

module.exports = {
  BASE_TRANSITIONS,
  CONDITIONAL_TRANSITIONS,
  RETRY_TRANSITIONS,
  ESCALATION_TRANSITIONS,
  isKnownState,
  isTerminalState,
  getAllowedTransitions,
  getTransitionBlockReason,
  canTransition,
  assertTransition,
  isRetryTransition,
  isEscalationTransition,
};
