const SUPPORT_TICKET_STATUSES = Object.freeze([
  "open",
  "in_review",
  "waiting_on_user",
  "waiting_on_info",
  "resolved",
  "closed",
]);

const SUPPORT_TICKET_CATEGORIES = Object.freeze([
  "platform_explainer",
  "admissions",
  "account_access",
  "case_workflow",
  "job_application",
  "payments_risk",
  "fees",
  "incident_watch",
  "general_support",
]);

const SUPPORT_REQUESTER_ROLES = Object.freeze([
  "visitor",
  "attorney",
  "paralegal",
  "admin",
  "unknown",
]);

const SUPPORT_SURFACES = Object.freeze([
  "public",
  "attorney",
  "paralegal",
  "admin",
  "email",
  "manual",
]);

const SUPPORT_CONFIDENCE = Object.freeze(["low", "medium", "high"]);

const SUPPORT_OWNER_KEYS = Object.freeze([
  "support_ops",
  "admissions",
  "payments",
  "incident_watch",
  "founder_review",
]);

const SUPPORT_CONVERSATION_STATUSES = Object.freeze([
  "open",
  "escalated",
  "resolved",
  "closed",
]);

const SUPPORT_MESSAGE_SENDERS = Object.freeze([
  "user",
  "assistant",
  "system",
]);

const FAQ_CANDIDATE_STATES = Object.freeze(["draft", "pending_review", "approved", "rejected"]);

const SUPPORT_INSIGHT_TYPES = Object.freeze(["friction_pattern", "confusion_pattern", "routing_pattern"]);
const SUPPORT_INSIGHT_STATES = Object.freeze(["active", "dismissed"]);

module.exports = {
  FAQ_CANDIDATE_STATES,
  SUPPORT_CONFIDENCE,
  SUPPORT_CONVERSATION_STATUSES,
  SUPPORT_INSIGHT_STATES,
  SUPPORT_INSIGHT_TYPES,
  SUPPORT_MESSAGE_SENDERS,
  SUPPORT_OWNER_KEYS,
  SUPPORT_REQUESTER_ROLES,
  SUPPORT_SURFACES,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_STATUSES,
};
