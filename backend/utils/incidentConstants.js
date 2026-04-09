const INCIDENT_SOURCES = Object.freeze([
  "help_form",
  "inline_help",
  "admin_created",
  "system_monitor",
  "cluster_promotion",
  "api",
]);

const INCIDENT_REPORTER_ROLES = Object.freeze([
  "visitor",
  "attorney",
  "paralegal",
  "admin",
  "system",
]);

const INCIDENT_SURFACES = Object.freeze([
  "public",
  "attorney",
  "paralegal",
  "admin",
  "system",
]);

const INCIDENT_STATES = Object.freeze([
  "reported",
  "intake_validated",
  "classified",
  "investigating",
  "patch_planning",
  "patching",
  "awaiting_verification",
  "verification_failed",
  "verified_release_candidate",
  "awaiting_founder_approval",
  "deploying_preview",
  "deploying_production",
  "post_deploy_verifying",
  "deploy_failed",
  "rollback_in_progress",
  "needs_more_context",
  "needs_human_owner",
  "resolved",
  "closed_duplicate",
  "closed_no_repro",
  "closed_not_actionable",
  "closed_rejected",
  "closed_rolled_back",
]);

const INCIDENT_TERMINAL_STATES = Object.freeze([
  "resolved",
  "closed_duplicate",
  "closed_no_repro",
  "closed_not_actionable",
  "closed_rejected",
  "closed_rolled_back",
]);

const INCIDENT_DOMAINS = Object.freeze([
  "ui",
  "navigation",
  "profile",
  "case_lifecycle",
  "matching",
  "messaging",
  "documents",
  "notifications",
  "payments",
  "stripe_onboarding",
  "escrow",
  "payouts",
  "withdrawals",
  "disputes",
  "auth",
  "permissions",
  "approvals",
  "profile_visibility",
  "admin_tools",
  "performance",
  "data_integrity",
  "unknown",
]);

const INCIDENT_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);
const INCIDENT_RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
const INCIDENT_CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);
const INCIDENT_APPROVAL_STATES = Object.freeze([
  "not_needed",
  "pending",
  "approved",
  "rejected",
  "expired",
]);
const INCIDENT_AUTONOMY_MODES = Object.freeze([
  "full_auto",
  "approval_required",
  "manual_only",
]);

const INCIDENT_USER_VISIBLE_STATUSES = Object.freeze([
  "received",
  "investigating",
  "testing_fix",
  "awaiting_internal_review",
  "fixed_live",
  "needs_more_info",
  "closed",
]);

const INCIDENT_ADMIN_VISIBLE_STATUSES = Object.freeze([
  "new",
  "active",
  "awaiting_approval",
  "verification_failed",
  "deploy_failed",
  "rolled_back",
  "resolved",
  "closed",
]);

const INCIDENT_JOB_TYPES = Object.freeze([
  "intake_validation",
  "classification",
  "investigation",
  "patch_planning",
  "patch_execution",
  "verification",
  "deployment",
  "post_deploy_verification",
  "rollback",
  "notifications",
  "none",
]);

const INCIDENT_RESOLUTION_CODES = Object.freeze([
  "fixed_deployed",
  "duplicate",
  "no_repro",
  "not_actionable",
  "manual_handoff",
  "rejected",
  "rolled_back",
]);

const INCIDENT_EVENT_TYPES = Object.freeze([
  "state_changed",
  "classification_written",
  "risk_reclassified",
  "cluster_linked",
  "investigation_started",
  "investigation_completed",
  "patch_planned",
  "patch_created",
  "patch_failed",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "approval_requested",
  "approval_granted",
  "approval_rejected",
  "deploy_started",
  "deploy_succeeded",
  "deploy_failed",
  "post_deploy_verification_passed",
  "post_deploy_verification_failed",
  "rollback_started",
  "rollback_succeeded",
  "rollback_failed",
  "notification_queued",
  "notification_sent",
  "notification_failed",
  "retry_scheduled",
  "reopened",
  "closed",
  "comment_added",
]);

const INCIDENT_ACTOR_TYPES = Object.freeze(["system", "user", "admin", "agent", "worker"]);
const INCIDENT_AGENT_ROLES = Object.freeze([
  "help_copilot",
  "incident_router",
  "engineering_agent",
  "verifier_agent",
  "release_agent",
  "founder_copilot",
  "scheduler",
]);

const INCIDENT_ARTIFACT_TYPES = Object.freeze([
  "user_report",
  "browser_diagnostics",
  "screenshot",
  "network_trace",
  "log_excerpt",
  "route_map",
  "repro_steps",
  "test_output",
  "coverage_summary",
  "diff_summary",
  "preview_url",
  "deploy_log",
  "health_snapshot",
  "rollback_report",
  "notification_copy",
  "approval_packet",
  "cluster_summary",
]);

const INCIDENT_ARTIFACT_STAGES = Object.freeze([
  "intake",
  "classification",
  "investigation",
  "patch",
  "verification",
  "release",
  "post_deploy",
  "rollback",
  "notification",
]);

const INCIDENT_ARTIFACT_CONTENT_TYPES = Object.freeze([
  "json",
  "text",
  "markdown",
  "link",
  "image",
]);

const INCIDENT_ARTIFACT_STORAGE_MODES = Object.freeze(["inline", "s3", "external_url"]);
const INCIDENT_REDACTION_STATUSES = Object.freeze([
  "not_needed",
  "redacted",
  "contains_sensitive_data",
]);

const INCIDENT_INVESTIGATION_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "needs_more_context",
  "no_repro",
  "escalated",
]);

const INCIDENT_INVESTIGATION_TRIGGER_TYPES = Object.freeze([
  "auto",
  "retry",
  "reopen",
  "cluster_reanalysis",
]);

const INCIDENT_INVESTIGATION_ASSIGNEES = Object.freeze([
  "incident_router",
  "engineering_agent",
  "human",
]);

const INCIDENT_REPRODUCTION_STATUSES = Object.freeze([
  "not_attempted",
  "reproduced",
  "not_reproduced",
  "partially_reproduced",
]);

const INCIDENT_HYPOTHESIS_STATUSES = Object.freeze(["pending", "confirmed", "rejected"]);
const INCIDENT_RECOMMENDED_ACTIONS = Object.freeze([
  "patch",
  "request_context",
  "manual_handoff",
  "close_duplicate",
  "close_not_actionable",
]);

const INCIDENT_PATCH_STATUSES = Object.freeze([
  "planned",
  "branch_created",
  "coding",
  "tests_added",
  "ready_for_verification",
  "failed",
  "abandoned",
]);

const INCIDENT_PATCH_STRATEGIES = Object.freeze([
  "frontend_only",
  "backend_only",
  "fullstack",
  "config_only",
  "test_only",
  "feature_flag",
  "no_code",
]);

const INCIDENT_VERIFICATION_STATUSES = Object.freeze([
  "queued",
  "running",
  "passed",
  "failed",
  "partial",
  "blocked",
]);

const INCIDENT_VERIFICATION_LEVELS = Object.freeze([
  "targeted",
  "full_required",
  "release_candidate",
  "post_deploy",
]);

const INCIDENT_VERIFICATION_CHECK_KEYS = Object.freeze([
  "build",
  "lint",
  "unit_tests",
  "integration_tests",
  "api_replay",
  "ui_flow",
  "e2e_flow",
  "preview_smoke",
  "health_check",
  "prod_smoke",
  "log_watch",
  "audit_log_check",
  "authz_check",
  "payment_safety_check",
]);

const INCIDENT_VERIFICATION_CHECK_STATUSES = Object.freeze([
  "pending",
  "passed",
  "failed",
  "skipped",
]);

const ACTIVE_INCIDENT_RELEASE_STATUSES = Object.freeze([
  "queued",
  "awaiting_policy_check",
  "blocked",
  "awaiting_founder_approval",
  "deploying_preview",
  "preview_prepared",
  "preview_blocked",
  "preview_failed",
  "preview_verified",
  "deploying_production",
  "production_failed",
  "post_deploy_verifying",
  "succeeded",
  "rollback_requested",
  "rolled_back",
  "rollback_failed",
]);

const DEPRECATED_INCIDENT_RELEASE_STATUSES = Object.freeze([
  "preview_passed",
]);

const INCIDENT_RELEASE_STATUSES = Object.freeze([
  ...ACTIVE_INCIDENT_RELEASE_STATUSES,
  ...DEPRECATED_INCIDENT_RELEASE_STATUSES,
]);

const INCIDENT_POLICY_DECISIONS = Object.freeze([
  "auto_allowed",
  "approval_required",
  "blocked",
]);

const INCIDENT_DEPLOY_PROVIDERS = Object.freeze(["render"]);

const INCIDENT_APPROVAL_TYPES = Object.freeze([
  "production_deploy",
  "user_facing_resolution",
  "manual_data_repair",
  "policy_override",
]);

const INCIDENT_APPROVAL_DECISION_ROLES = Object.freeze(["admin", "founder_approver"]);
const INCIDENT_APPROVAL_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "expired",
  "canceled",
]);

const INCIDENT_NOTIFICATION_AUDIENCES = Object.freeze([
  "reporter",
  "admin",
  "founder",
  "internal_team",
]);

const INCIDENT_NOTIFICATION_CHANNELS = Object.freeze([
  "in_app",
  "email",
  "control_room",
  "system_note",
]);

const INCIDENT_NOTIFICATION_TEMPLATE_KEYS = Object.freeze([
  "received",
  "investigating",
  "testing_fix",
  "awaiting_internal_review",
  "approval_required",
  "fixed_live",
  "needs_more_info",
  "verification_failed_internal",
  "deploy_failed_internal",
  "rollback_notice",
  "founder_approval_request",
]);

const INCIDENT_NOTIFICATION_STATUSES = Object.freeze([
  "queued",
  "sent",
  "failed",
  "skipped",
]);

const INCIDENT_RISK_FLAG_KEYS = Object.freeze([
  "affectsMoney",
  "affectsAccess",
  "affectsLegal",
  "affectsAuth",
  "affectsPermissions",
  "affectsApprovalDecision",
  "affectsProfileVisibility",
  "affectsDisputes",
  "affectsWithdrawals",
]);

const HIGH_RISK_DOMAINS = Object.freeze([
  "payments",
  "stripe_onboarding",
  "escrow",
  "payouts",
  "withdrawals",
  "disputes",
  "auth",
  "permissions",
  "approvals",
  "profile_visibility",
]);

const HIGH_RISK_KEYWORDS = Object.freeze([
  "stripe",
  "payment",
  "payout",
  "escrow",
  "withdraw",
  "dispute",
  "login",
  "auth",
  "forbidden",
  "permission",
  "approve",
  "deny",
  "profile visible",
  "hidden profile",
  "refund",
  "bank",
]);

const PROTECTED_FILE_PATHS = Object.freeze([
  "backend/routes/payments.js",
  "backend/routes/paymentsWebhook.js",
  "backend/routes/disputes.js",
  "backend/routes/auth.js",
  "backend/utils/authz.js",
  "backend/routes/users.js",
  "backend/services/userDeletion.js",
  "frontend/assets/scripts/utils/stripe-connect.js",
  "frontend/assets/scripts/views/case-detail.js",
  "frontend/assets/scripts/profile-paralegal.js",
  "frontend/assets/scripts/profile-settings.js",
  "frontend/dashboard-paralegal.html",
]);

const PROTECTED_FIELD_PATHS = Object.freeze([
  "escrowStatus",
  "paymentReleased",
  "payout",
  "stripe",
  "disputes",
  "withdrawnParalegalId",
  "preferences.hideProfile",
  "status",
]);

const CORE_WORKFLOW_FILE_PATHS = Object.freeze([
  "backend/routes/cases.js",
  "backend/routes/jobs.js",
  "backend/routes/messages.js",
  "backend/routes/uploads.js",
  "backend/routes/notifications.js",
]);

const CORE_WORKFLOW_ROUTE_HINTS = Object.freeze([
  "/api/cases",
  "/api/jobs",
  "/api/messages",
  "/api/uploads",
  "/api/notifications",
]);

const RISK_LEVEL_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

module.exports = {
  INCIDENT_SOURCES,
  INCIDENT_REPORTER_ROLES,
  INCIDENT_SURFACES,
  INCIDENT_STATES,
  INCIDENT_TERMINAL_STATES,
  INCIDENT_DOMAINS,
  INCIDENT_SEVERITIES,
  INCIDENT_RISK_LEVELS,
  INCIDENT_CONFIDENCE_LEVELS,
  INCIDENT_APPROVAL_STATES,
  INCIDENT_AUTONOMY_MODES,
  INCIDENT_USER_VISIBLE_STATUSES,
  INCIDENT_ADMIN_VISIBLE_STATUSES,
  INCIDENT_JOB_TYPES,
  INCIDENT_RESOLUTION_CODES,
  INCIDENT_EVENT_TYPES,
  INCIDENT_ACTOR_TYPES,
  INCIDENT_AGENT_ROLES,
  INCIDENT_ARTIFACT_TYPES,
  INCIDENT_ARTIFACT_STAGES,
  INCIDENT_ARTIFACT_CONTENT_TYPES,
  INCIDENT_ARTIFACT_STORAGE_MODES,
  INCIDENT_REDACTION_STATUSES,
  INCIDENT_INVESTIGATION_STATUSES,
  INCIDENT_INVESTIGATION_TRIGGER_TYPES,
  INCIDENT_INVESTIGATION_ASSIGNEES,
  INCIDENT_REPRODUCTION_STATUSES,
  INCIDENT_HYPOTHESIS_STATUSES,
  INCIDENT_RECOMMENDED_ACTIONS,
  INCIDENT_PATCH_STATUSES,
  INCIDENT_PATCH_STRATEGIES,
  INCIDENT_VERIFICATION_STATUSES,
  INCIDENT_VERIFICATION_LEVELS,
  INCIDENT_VERIFICATION_CHECK_KEYS,
  INCIDENT_VERIFICATION_CHECK_STATUSES,
  ACTIVE_INCIDENT_RELEASE_STATUSES,
  DEPRECATED_INCIDENT_RELEASE_STATUSES,
  INCIDENT_RELEASE_STATUSES,
  INCIDENT_POLICY_DECISIONS,
  INCIDENT_DEPLOY_PROVIDERS,
  INCIDENT_APPROVAL_TYPES,
  INCIDENT_APPROVAL_DECISION_ROLES,
  INCIDENT_APPROVAL_STATUSES,
  INCIDENT_NOTIFICATION_AUDIENCES,
  INCIDENT_NOTIFICATION_CHANNELS,
  INCIDENT_NOTIFICATION_TEMPLATE_KEYS,
  INCIDENT_NOTIFICATION_STATUSES,
  INCIDENT_RISK_FLAG_KEYS,
  HIGH_RISK_DOMAINS,
  HIGH_RISK_KEYWORDS,
  PROTECTED_FILE_PATHS,
  PROTECTED_FIELD_PATHS,
  CORE_WORKFLOW_FILE_PATHS,
  CORE_WORKFLOW_ROUTE_HINTS,
  RISK_LEVEL_RANK,
};
