const EMPTY_POLICY = Object.freeze({
  autoHandledTypes: Object.freeze([]),
  founderDecisionTypes: Object.freeze([]),
  blockedTypes: Object.freeze([]),
  informationalTypes: Object.freeze([]),
  neverQuickApproveTypes: Object.freeze([]),
});

const CONTROL_ROOM_DECISION_POLICY = Object.freeze({
  cco: Object.freeze({
    autoHandledTypes: Object.freeze([
      "ticket_reopened",
      "ticket_escalated",
      "incident_routed_from_support",
    ]),
    founderDecisionTypes: Object.freeze([
      "faq_candidate",
      "support_governed_content_approval",
    ]),
    blockedTypes: Object.freeze([
      "faq_candidate",
      "support_governed_content_approval",
    ]),
    informationalTypes: Object.freeze([
      "support_queue_metric",
      "support_founder_alert",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "billing_sensitive_support",
      "payout_sensitive_support",
      "dispute_support",
      "legal_sensitive_support",
      "sensitive_customer_promise",
    ]),
  }),
  cmo: Object.freeze({
    autoHandledTypes: Object.freeze([
      "marketing_research_refresh",
      "marketing_draft_generation",
      "marketing_publishing_prep",
    ]),
    founderDecisionTypes: Object.freeze([
      "marketing_draft_packet",
      "marketing_publish_decision",
    ]),
    blockedTypes: Object.freeze([
      "marketing_draft_packet",
      "marketing_publish_decision",
    ]),
    informationalTypes: Object.freeze([
      "marketing_queue_metric",
      "marketing_system_processing",
      "marketing_cycle_blocked",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "marketing_uncertain_claim",
      "marketing_sensitive_public_messaging",
    ]),
  }),
  cso: Object.freeze({
    autoHandledTypes: Object.freeze([
      "sales_account_memory",
      "sales_account_snapshot",
      "sales_draft_generation",
    ]),
    founderDecisionTypes: Object.freeze([
      "sales_draft_packet",
    ]),
    blockedTypes: Object.freeze([
      "sales_draft_packet",
    ]),
    informationalTypes: Object.freeze([
      "sales_activity_metric",
      "sales_account_metric",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "sales_missing_context",
      "sales_reputational_risk",
    ]),
  }),
  cto: Object.freeze({
    autoHandledTypes: Object.freeze([
      "engineering_diagnosis_run",
      "engineering_execution_plan_generation",
      "engineering_workspace_processing",
    ]),
    founderDecisionTypes: Object.freeze([
      "incident_approval",
      "engineering_execution_forward_decision",
    ]),
    blockedTypes: Object.freeze([
      "incident_approval",
      "engineering_execution_forward_decision",
    ]),
    informationalTypes: Object.freeze([
      "engineering_workload_metric",
      "engineering_health_metric",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "deploy_confirmation",
      "user_facing_promise",
      "irreversible_production_change",
    ]),
  }),
  cfo: Object.freeze({
    autoHandledTypes: Object.freeze([]),
    founderDecisionTypes: Object.freeze([]),
    blockedTypes: Object.freeze([]),
    informationalTypes: Object.freeze([
      "finance_risk_metric",
      "finance_manual_review",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "money_movement",
      "refund_decision",
      "payment_decision",
      "payout_decision",
      "dispute_decision",
    ]),
  }),
  coo: Object.freeze({
    autoHandledTypes: Object.freeze([]),
    founderDecisionTypes: Object.freeze([
      "ops_explicit_approval",
    ]),
    blockedTypes: Object.freeze([
      "ops_explicit_approval",
    ]),
    informationalTypes: Object.freeze([
      "ops_follow_up_metric",
      "ops_stalled_user_metric",
      "ops_lifecycle_alert",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "ops_non_deterministic_judgment",
    ]),
  }),
  cao: Object.freeze({
    autoHandledTypes: Object.freeze([]),
    founderDecisionTypes: Object.freeze([
      "admissions_review",
    ]),
    blockedTypes: Object.freeze([
      "admissions_review",
    ]),
    informationalTypes: Object.freeze([
      "admissions_queue_metric",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "administrative_non_admissions_decision",
    ]),
  }),
  cpo: Object.freeze({
    autoHandledTypes: Object.freeze([]),
    founderDecisionTypes: Object.freeze([]),
    blockedTypes: Object.freeze([]),
    informationalTypes: Object.freeze([
      "product_issue_metric",
      "product_signal_metric",
    ]),
    neverQuickApproveTypes: Object.freeze([
      "product_unwired_decision",
    ]),
  }),
});

function normalizeLaneKey(laneKey = "") {
  return String(laneKey || "").trim().toLowerCase();
}

function includesType(values = [], itemType = "") {
  return Array.isArray(values) && values.includes(String(itemType || "").trim());
}

function getControlRoomLanePolicy(laneKey = "") {
  return CONTROL_ROOM_DECISION_POLICY[normalizeLaneKey(laneKey)] || EMPTY_POLICY;
}

function evaluateControlRoomPolicy({ laneKey = "", itemType = "", hasExecutionPath = false } = {}) {
  const policy = getControlRoomLanePolicy(laneKey);
  const normalizedType = String(itemType || "").trim();
  const isAutoHandled = includesType(policy.autoHandledTypes, normalizedType);
  const isFounderDecision = includesType(policy.founderDecisionTypes, normalizedType);
  const isBlocked = includesType(policy.blockedTypes, normalizedType);
  const isInformational = includesType(policy.informationalTypes, normalizedType);
  const isNeverQuickApprove = includesType(policy.neverQuickApproveTypes, normalizedType);

  return {
    laneKey: normalizeLaneKey(laneKey),
    itemType: normalizedType,
    isAutoHandled,
    isFounderDecision,
    isBlocked,
    isInformational,
    isNeverQuickApprove,
    hasExecutionPath: hasExecutionPath === true,
    canQuickApprove: isFounderDecision && !isNeverQuickApprove && hasExecutionPath === true,
  };
}

module.exports = {
  CONTROL_ROOM_DECISION_POLICY,
  evaluateControlRoomPolicy,
  getControlRoomLanePolicy,
};
