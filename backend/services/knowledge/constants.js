const KNOWLEDGE_AUDIENCE_SCOPES = Object.freeze([
  "internal_ops",
  "support_safe",
  "sales_safe",
  "marketing_safe",
  "public_approved",
]);

const KNOWLEDGE_APPROVAL_STATES = Object.freeze([
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "archived",
]);

const KNOWLEDGE_RECORD_TYPES = Object.freeze([
  "fact_card",
  "policy_card",
  "voice_card",
  "positioning_card",
  "distinctiveness_card",
  "objection_card",
  "value_card",
  "claim_guardrail",
]);

const KNOWLEDGE_SOURCE_TYPES = Object.freeze(["file", "incident", "manual"]);
const KNOWLEDGE_SYNC_STATES = Object.freeze(["never_synced", "synced", "drift_detected", "error"]);
const KNOWLEDGE_INSIGHT_LANES = Object.freeze(["quarantined"]);
const KNOWLEDGE_INSIGHT_STATUSES = Object.freeze(["candidate", "reviewed", "promoted", "rejected"]);

const APPROVAL_TASK_STATES = Object.freeze(["pending", "approved", "rejected", "cancelled"]);
const APPROVAL_TASK_TYPES = Object.freeze(["knowledge_review", "marketing_review", "support_review", "sales_review"]);
const APPROVAL_TARGET_TYPES = Object.freeze([
  "knowledge_revision",
  "marketing_draft_packet",
  "faq_candidate",
  "sales_draft_packet",
]);

module.exports = {
  APPROVAL_TARGET_TYPES,
  APPROVAL_TASK_STATES,
  APPROVAL_TASK_TYPES,
  KNOWLEDGE_APPROVAL_STATES,
  KNOWLEDGE_AUDIENCE_SCOPES,
  KNOWLEDGE_INSIGHT_LANES,
  KNOWLEDGE_INSIGHT_STATUSES,
  KNOWLEDGE_RECORD_TYPES,
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_SYNC_STATES,
};
