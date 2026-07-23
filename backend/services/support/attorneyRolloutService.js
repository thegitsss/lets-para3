const crypto = require("crypto");

const ATTORNEY_ROLLOUT_CONTRACT_VERSION = "2026-07-22.package9.v1";

const ATTORNEY_ROLLOUT_STAGES = Object.freeze([
  Object.freeze({ id: "internal", percent: 0, minimumHours: 24, minimumManagerMessages: 100, population: "explicit_allowlist_only", requiredCompletedStages: Object.freeze([]) }),
  Object.freeze({ id: "canary", percent: 10, minimumHours: 48, minimumManagerMessages: 100, population: "stable_attorney_bucket", requiredCompletedStages: Object.freeze(["internal"]) }),
  Object.freeze({ id: "limited", percent: 25, minimumHours: 48, minimumManagerMessages: 100, population: "stable_attorney_bucket", requiredCompletedStages: Object.freeze(["internal", "canary"]) }),
  Object.freeze({ id: "expanded", percent: 50, minimumHours: 72, minimumManagerMessages: 100, population: "stable_attorney_bucket", requiredCompletedStages: Object.freeze(["internal", "canary", "limited"]) }),
  Object.freeze({ id: "general", percent: 100, minimumHours: 168, minimumManagerMessages: 100, population: "all_attorneys", requiredCompletedStages: Object.freeze(["internal", "canary", "limited", "expanded"]) }),
]);

function isEnabled(value, defaultValue = true) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  return !["0", "false", "off", "disabled", "no"].includes(String(value).trim().toLowerCase());
}

function parseRolloutPercent(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 100;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return 0;
  return Math.round(parsed);
}

function parseAllowlist(value = "") {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function stableAttorneyRolloutKey(user = {}) {
  return String(user._id || user.id || user.email || "").trim().toLowerCase();
}

function attorneyRolloutIdentityCandidates(user = {}) {
  return [...new Set([user._id, user.id, user.email]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
}

function stableAttorneyRolloutBucket(user = {}) {
  const key = stableAttorneyRolloutKey(user);
  if (!key) return null;
  return Number.parseInt(crypto.createHash("sha256").update(`lpc-attorney-rollout:${key}`).digest("hex").slice(0, 8), 16) % 100;
}

function getAttorneyRolloutStage(percent) {
  return ATTORNEY_ROLLOUT_STAGES.find((stage) => stage.percent === percent)?.id || "custom";
}

function getAttorneyRolloutStageDefinition(stageId = "") {
  return ATTORNEY_ROLLOUT_STAGES.find((stage) => stage.id === String(stageId || "").trim().toLowerCase()) || null;
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function evaluateAttorneyRolloutStageGate({
  stageId = "",
  stageStartedAt = null,
  evaluatedAt = new Date(),
  reliabilityReport = {},
  completedStageIds = [],
  openIncidentCount = null,
  curatedAcceptancePassed = false,
  package7Passed = false,
  productOwnerConfirmed = false,
  releaseOwner = "",
  technicalOwner = "",
} = {}) {
  const stage = getAttorneyRolloutStageDefinition(stageId);
  const errors = [];
  if (!stage) {
    return {
      contractVersion: ATTORNEY_ROLLOUT_CONTRACT_VERSION,
      passed: false,
      status: "blocked",
      stageId: String(stageId || ""),
      errors: ["unknown_rollout_stage"],
    };
  }

  const startedAt = parseDate(stageStartedAt);
  const checkedAt = parseDate(evaluatedAt);
  let elapsedHours = null;
  if (!startedAt || !checkedAt) errors.push("invalid_stage_observation_time");
  else {
    elapsedHours = Number(((checkedAt.getTime() - startedAt.getTime()) / 3600000).toFixed(2));
    if (elapsedHours < 0) errors.push("stage_start_is_in_future");
    else if (elapsedHours < stage.minimumHours) errors.push("minimum_observation_duration_not_met");
  }

  const report = reliabilityReport && typeof reliabilityReport === "object" ? reliabilityReport : {};
  const managerMessageCount = Number(report.managerMessageCount || 0);
  if (report.role !== "attorney" || report.readOnly !== true) errors.push("invalid_reliability_report_scope");
  if (managerMessageCount < stage.minimumManagerMessages) errors.push("minimum_manager_sample_not_met");
  if (report.gate?.passed !== true) errors.push(`reliability_gate_not_passed:${String(report.gate?.status || "missing")}`);
  if (Number(report.operationalMode?.rolloutPercent) !== stage.percent) errors.push("operational_rollout_percent_mismatch");

  const stageCounts = report.rolloutStageCounts && typeof report.rolloutStageCounts === "object"
    ? report.rolloutStageCounts
    : {};
  const percentCounts = report.rolloutPercentCounts && typeof report.rolloutPercentCounts === "object"
    ? report.rolloutPercentCounts
    : {};
  const contractCounts = report.rolloutContractVersionCounts && typeof report.rolloutContractVersionCounts === "object"
    ? report.rolloutContractVersionCounts
    : {};
  if (Number(report.rolloutTelemetryMissingCount || 0) > 0) errors.push("rollout_telemetry_incomplete");
  if (Number(stageCounts[stage.id] || 0) !== managerMessageCount || Object.keys(stageCounts).some((key) => key !== stage.id && Number(stageCounts[key] || 0) > 0)) {
    errors.push("rollout_stage_telemetry_mismatch");
  }
  if (Number(percentCounts[String(stage.percent)] || 0) !== managerMessageCount || Object.keys(percentCounts).some((key) => Number(key) !== stage.percent && Number(percentCounts[key] || 0) > 0)) {
    errors.push("rollout_percent_telemetry_mismatch");
  }
  if (Number(contractCounts[ATTORNEY_ROLLOUT_CONTRACT_VERSION] || 0) !== managerMessageCount) {
    errors.push("rollout_contract_telemetry_mismatch");
  }

  const completed = new Set((Array.isArray(completedStageIds) ? completedStageIds : []).map((value) => String(value || "").trim().toLowerCase()));
  for (const requiredStage of stage.requiredCompletedStages) {
    if (!completed.has(requiredStage)) errors.push(`prior_stage_not_completed:${requiredStage}`);
  }
  if (!String(releaseOwner || "").trim()) errors.push("release_owner_not_recorded");
  if (!String(technicalOwner || "").trim()) errors.push("technical_owner_not_recorded");
  if (curatedAcceptancePassed !== true) errors.push("curated_acceptance_not_passed");
  if (package7Passed !== true) errors.push("package7_not_passed");
  const recordedIncidentCount = Number(openIncidentCount);
  if (openIncidentCount === null || openIncidentCount === undefined || !Number.isFinite(recordedIncidentCount) || recordedIncidentCount < 0) {
    errors.push("open_incident_status_not_recorded");
  } else if (recordedIncidentCount > 0) errors.push("open_rollout_incident");
  if (stage.id === "general" && productOwnerConfirmed !== true) errors.push("product_owner_confirmation_not_recorded");

  return {
    contractVersion: ATTORNEY_ROLLOUT_CONTRACT_VERSION,
    passed: errors.length === 0,
    status: errors.length ? "blocked" : "passed",
    stageId: stage.id,
    rolloutPercent: stage.percent,
    minimumHours: stage.minimumHours,
    minimumManagerMessages: stage.minimumManagerMessages,
    elapsedHours,
    managerMessageCount,
    requiredCompletedStages: [...stage.requiredCompletedStages],
    errors: [...new Set(errors)],
  };
}

function evaluateAttorneyManagerRollout(user = {}, env = process.env) {
  const role = String(user.role || "").trim().toLowerCase();
  const globalManagerEnabled = isEnabled(env.OPENAI_SUPPORT_MANAGER_ENABLED, true);
  const attorneyManagerEnabled = isEnabled(env.OPENAI_ATTORNEY_MANAGER_ENABLED, true);
  const rolloutPercent = parseRolloutPercent(env.OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT);
  const rolloutStage = getAttorneyRolloutStage(rolloutPercent);
  const bucket = stableAttorneyRolloutBucket(user);
  const allowlist = parseAllowlist(env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST);
  const stableKey = stableAttorneyRolloutKey(user);
  const allowlisted = attorneyRolloutIdentityCandidates(user).some((value) => allowlist.has(value));

  let eligible = false;
  let reason = "percentage_not_enrolled";
  if (role !== "attorney") reason = "role_not_eligible";
  else if (!globalManagerEnabled) reason = "global_manager_disabled";
  else if (!attorneyManagerEnabled) reason = "attorney_manager_disabled";
  else if (allowlisted) {
    eligible = true;
    reason = "allowlisted";
  } else if (rolloutPercent === 100) {
    eligible = true;
    reason = "all_attorneys";
  } else if (bucket === null) reason = "missing_stable_account_key";
  else if (bucket < rolloutPercent) {
    eligible = true;
    reason = "stable_percentage_bucket";
  }

  return {
    contractVersion: ATTORNEY_ROLLOUT_CONTRACT_VERSION,
    eligible,
    reason,
    rolloutStage,
    rolloutPercent,
    rolloutBucket: bucket,
    allowlisted,
    globalManagerEnabled,
    attorneyManagerEnabled,
  };
}

function publicAttorneyRolloutTelemetry(decision = {}) {
  return {
    contractVersion: String(decision.contractVersion || ATTORNEY_ROLLOUT_CONTRACT_VERSION),
    rolloutStage: String(decision.rolloutStage || "unknown"),
    rolloutPercent: Number(decision.rolloutPercent || 0),
    rolloutBucket: Number.isInteger(decision.rolloutBucket) ? decision.rolloutBucket : null,
    enrollmentReason: String(decision.reason || "unknown"),
  };
}

module.exports = {
  ATTORNEY_ROLLOUT_CONTRACT_VERSION,
  ATTORNEY_ROLLOUT_STAGES,
  evaluateAttorneyRolloutStageGate,
  evaluateAttorneyManagerRollout,
  getAttorneyRolloutStage,
  getAttorneyRolloutStageDefinition,
  parseAllowlist,
  parseRolloutPercent,
  publicAttorneyRolloutTelemetry,
  stableAttorneyRolloutBucket,
};
