const MARKETING_WORKFLOW_TYPES = Object.freeze([
  "founder_linkedin_post",
  "platform_update_announcement",
  "linkedin_company_post",
  "facebook_page_post",
]);

const MARKETING_PUBLISHING_CHANNELS = Object.freeze([
  "linkedin_company",
  "facebook_page",
]);

const MARKETING_LINKEDIN_COMPANY_CONTENT_LANES = Object.freeze([
  "platform_explanation",
  "standards_positioning",
  "updates_momentum",
]);

const MARKETING_PUBLISHING_CADENCE_MODES = Object.freeze([
  "manual_only",
  "daily",
  "every_2_days",
  "every_3_days",
]);

const MARKETING_PUBLISHING_CYCLE_STATUSES = Object.freeze([
  "drafted",
  "awaiting_approval",
  "blocked",
  "skipped",
  "ready_to_publish",
]);

const MARKETING_PUBLISHING_TRIGGER_SOURCES = Object.freeze([
  "manual",
  "scheduled",
]);

const MARKETING_JR_CMO_SOURCE_MODES = Object.freeze([
  "internal_only",
  "hybrid",
  "external_research",
]);

const MARKETING_JR_CMO_DAY_CONTEXT_STATUSES = Object.freeze([
  "active",
  "archived",
]);

const MARKETING_JR_CMO_TONE_RECOMMENDATIONS = Object.freeze([
  "measured",
  "credible",
  "focused",
  "quiet_momentum",
  "cautious",
]);

const MARKETING_JR_CMO_OPPORTUNITY_TYPES = Object.freeze([
  "lane_gap",
  "queue_hold",
  "fresh_explainer",
  "fresh_positioning",
  "fresh_update",
  "evaluation_learning",
]);

const MARKETING_JR_CMO_OPPORTUNITY_PRIORITIES = Object.freeze([
  "watch",
  "candidate",
  "recommended",
  "hold",
]);

const MARKETING_JR_CMO_LIBRARY_STATUSES = Object.freeze([
  "active",
  "archived",
  "used",
  "dismissed",
]);

const MARKETING_JR_CMO_FACT_SAFETY_STATUSES = Object.freeze([
  "approved",
  "needs_review",
  "expired",
]);

const MARKETING_JR_CMO_EVALUATION_TYPES = Object.freeze([
  "weekly",
  "packet_outcome",
]);

const MARKETING_CHANNEL_CONNECTION_STATUSES = Object.freeze([
  "not_connected",
  "connected_unvalidated",
  "connected_validated",
  "blocked",
  "auth_failed",
]);

const MARKETING_PUBLISH_INTENT_STATUSES = Object.freeze([
  "queued",
  "publishing",
  "published",
  "failed",
  "retryable_failed",
]);

const MARKETING_PUBLISH_ATTEMPT_STATUSES = Object.freeze([
  "started",
  "succeeded",
  "failed",
]);

const MARKETING_PUBLISH_FAILURE_CLASSES = Object.freeze([
  "auth",
  "validation",
  "transient",
  "provider",
]);

module.exports = {
  MARKETING_CHANNEL_CONNECTION_STATUSES,
  MARKETING_JR_CMO_DAY_CONTEXT_STATUSES,
  MARKETING_JR_CMO_EVALUATION_TYPES,
  MARKETING_JR_CMO_FACT_SAFETY_STATUSES,
  MARKETING_JR_CMO_LIBRARY_STATUSES,
  MARKETING_JR_CMO_OPPORTUNITY_PRIORITIES,
  MARKETING_JR_CMO_OPPORTUNITY_TYPES,
  MARKETING_JR_CMO_SOURCE_MODES,
  MARKETING_JR_CMO_TONE_RECOMMENDATIONS,
  MARKETING_LINKEDIN_COMPANY_CONTENT_LANES,
  MARKETING_PUBLISH_ATTEMPT_STATUSES,
  MARKETING_PUBLISH_FAILURE_CLASSES,
  MARKETING_PUBLISH_INTENT_STATUSES,
  MARKETING_PUBLISHING_CADENCE_MODES,
  MARKETING_PUBLISHING_CHANNELS,
  MARKETING_PUBLISHING_CYCLE_STATUSES,
  MARKETING_PUBLISHING_TRIGGER_SOURCES,
  MARKETING_WORKFLOW_TYPES,
};
