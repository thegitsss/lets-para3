const crypto = require("crypto");

const PARALEGAL_ROLLOUT_CONTRACT_VERSION = "2026-07-23.paralegal.package9.v1";

const PARALEGAL_ROLLOUT_STAGES = Object.freeze([
  Object.freeze({
    id: "internal",
    percent: 0,
    minimumHours: 24,
    minimumManagerMessages: 100,
    population: "explicit_allowlist_only",
    requiredCompletedStages: Object.freeze([]),
  }),
  Object.freeze({
    id: "limited",
    percent: 10,
    minimumHours: 48,
    minimumManagerMessages: 100,
    population: "stable_paralegal_bucket",
    requiredCompletedStages: Object.freeze(["internal"]),
  }),
  Object.freeze({
    id: "general",
    percent: 50,
    minimumHours: 72,
    minimumManagerMessages: 100,
    population: "stable_paralegal_bucket",
    requiredCompletedStages: Object.freeze(["internal", "limited"]),
  }),
  Object.freeze({
    id: "full",
    percent: 100,
    minimumHours: 168,
    minimumManagerMessages: 100,
    population: "all_paralegals",
    requiredCompletedStages: Object.freeze(["internal", "limited", "general"]),
  }),
]);

function isEnabled(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  return ["1", "true", "on", "enabled", "yes"].includes(String(value).trim().toLowerCase());
}

function parseParalegalRolloutPercent(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return 0;
  return Math.round(parsed);
}

function parseParalegalAllowlist(value = "") {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function stableParalegalRolloutKey(user = {}) {
  return String(user._id || user.id || user.email || "").trim().toLowerCase();
}

function paralegalRolloutIdentityCandidates(user = {}) {
  return [...new Set(
    [user._id, user.id, user.email]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  )];
}

function stableParalegalRolloutBucket(user = {}) {
  const key = stableParalegalRolloutKey(user);
  if (!key) return null;
  return Number.parseInt(
    crypto
      .createHash("sha256")
      .update(`lpc-paralegal-rollout:${key}`)
      .digest("hex")
      .slice(0, 8),
    16
  ) % 100;
}

function getParalegalRolloutStage(percent) {
  return PARALEGAL_ROLLOUT_STAGES.find((stage) => stage.percent === percent)?.id || "custom";
}

function getParalegalRolloutStageDefinition(stageId = "") {
  const normalized = String(stageId || "").trim().toLowerCase();
  return PARALEGAL_ROLLOUT_STAGES.find((stage) => stage.id === normalized) || null;
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function evaluateParalegalRolloutStageGate({
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
  const stage = getParalegalRolloutStageDefinition(stageId);
  const errors = [];
  if (!stage) {
    return {
      contractVersion: PARALEGAL_ROLLOUT_CONTRACT_VERSION,
      passed: false,
      status: "blocked",
      stageId: String(stageId || ""),
      errors: ["unknown_rollout_stage"],
    };
  }

  const startedAt = parseDate(stageStartedAt);
  const checkedAt = parseDate(evaluatedAt);
  let elapsedHours = null;
  if (!startedAt || !checkedAt) {
    errors.push("invalid_stage_observation_time");
  } else {
    elapsedHours = Number(((checkedAt.getTime() - startedAt.getTime()) / 3600000).toFixed(2));
    if (elapsedHours < 0) errors.push("stage_start_is_in_future");
    else if (elapsedHours < stage.minimumHours) errors.push("minimum_observation_duration_not_met");
  }

  const report = reliabilityReport && typeof reliabilityReport === "object"
    ? reliabilityReport
    : {};
  const managerMessageCount = Number(report.managerMessageCount || 0);
  if (report.role !== "paralegal" || report.readOnly !== true) {
    errors.push("invalid_reliability_report_scope");
  }
  if (managerMessageCount < stage.minimumManagerMessages) {
    errors.push("minimum_manager_sample_not_met");
  }
  if (report.gate?.passed !== true) {
    errors.push(`reliability_gate_not_passed:${String(report.gate?.status || "missing")}`);
  }
  if (Number(report.operationalMode?.rolloutPercent) !== stage.percent) {
    errors.push("operational_rollout_percent_mismatch");
  }

  const stageCounts = report.rolloutStageCounts && typeof report.rolloutStageCounts === "object"
    ? report.rolloutStageCounts
    : {};
  const percentCounts = report.rolloutPercentCounts && typeof report.rolloutPercentCounts === "object"
    ? report.rolloutPercentCounts
    : {};
  const contractCounts =
    report.rolloutContractVersionCounts &&
    typeof report.rolloutContractVersionCounts === "object"
      ? report.rolloutContractVersionCounts
      : {};
  if (Number(report.rolloutTelemetryMissingCount || 0) > 0) {
    errors.push("rollout_telemetry_incomplete");
  }
  if (
    Number(stageCounts[stage.id] || 0) !== managerMessageCount ||
    Object.keys(stageCounts).some(
      (key) => key !== stage.id && Number(stageCounts[key] || 0) > 0
    )
  ) {
    errors.push("rollout_stage_telemetry_mismatch");
  }
  if (
    Number(percentCounts[String(stage.percent)] || 0) !== managerMessageCount ||
    Object.keys(percentCounts).some(
      (key) => Number(key) !== stage.percent && Number(percentCounts[key] || 0) > 0
    )
  ) {
    errors.push("rollout_percent_telemetry_mismatch");
  }
  if (
    Number(contractCounts[PARALEGAL_ROLLOUT_CONTRACT_VERSION] || 0) !== managerMessageCount ||
    Object.keys(contractCounts).some(
      (key) =>
        key !== PARALEGAL_ROLLOUT_CONTRACT_VERSION &&
        Number(contractCounts[key] || 0) > 0
    )
  ) {
    errors.push("rollout_contract_telemetry_mismatch");
  }

  const completed = new Set(
    (Array.isArray(completedStageIds) ? completedStageIds : [])
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
  );
  for (const requiredStage of stage.requiredCompletedStages) {
    if (!completed.has(requiredStage)) {
      errors.push(`prior_stage_not_completed:${requiredStage}`);
    }
  }
  if (!String(releaseOwner || "").trim()) errors.push("release_owner_not_recorded");
  if (!String(technicalOwner || "").trim()) errors.push("technical_owner_not_recorded");
  if (curatedAcceptancePassed !== true) errors.push("curated_acceptance_not_passed");
  if (package7Passed !== true) errors.push("package7_not_passed");
  const incidentCount = Number(openIncidentCount);
  if (
    openIncidentCount === null ||
    openIncidentCount === undefined ||
    !Number.isFinite(incidentCount) ||
    incidentCount < 0
  ) {
    errors.push("open_incident_status_not_recorded");
  } else if (incidentCount > 0) {
    errors.push("open_rollout_incident");
  }
  if (stage.id === "full" && productOwnerConfirmed !== true) {
    errors.push("product_owner_confirmation_not_recorded");
  }

  return {
    contractVersion: PARALEGAL_ROLLOUT_CONTRACT_VERSION,
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

function evaluateParalegalManagerRollout(user = {}, env = process.env) {
  const role = String(user.role || "").trim().toLowerCase();
  const globalManagerEnabled = isEnabled(env.OPENAI_SUPPORT_MANAGER_ENABLED, true);
  const paralegalManagerEnabled = isEnabled(env.OPENAI_PARALEGAL_MANAGER_ENABLED, false);
  const rolloutPercent = parseParalegalRolloutPercent(
    env.OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT
  );
  const rolloutStage = getParalegalRolloutStage(rolloutPercent);
  const rolloutBucket = stableParalegalRolloutBucket(user);
  const allowlist = parseParalegalAllowlist(env.OPENAI_PARALEGAL_MANAGER_ALLOWLIST);
  const allowlisted = paralegalRolloutIdentityCandidates(user).some((value) =>
    allowlist.has(value)
  );

  let eligible = false;
  let reason = "percentage_not_enrolled";
  if (role !== "paralegal") reason = "role_not_eligible";
  else if (!globalManagerEnabled) reason = "global_manager_disabled";
  else if (!paralegalManagerEnabled) reason = "paralegal_manager_disabled";
  else if (allowlisted) {
    eligible = true;
    reason = "allowlisted";
  } else if (rolloutPercent === 100) {
    eligible = true;
    reason = "all_paralegals";
  } else if (rolloutBucket === null) {
    reason = "missing_stable_account_key";
  } else if (rolloutBucket < rolloutPercent) {
    eligible = true;
    reason = "stable_percentage_bucket";
  }

  return {
    contractVersion: PARALEGAL_ROLLOUT_CONTRACT_VERSION,
    eligible,
    reason,
    rolloutStage,
    rolloutPercent,
    rolloutBucket,
    allowlisted,
    globalManagerEnabled,
    paralegalManagerEnabled,
  };
}

function publicParalegalRolloutTelemetry(decision = {}) {
  return {
    contractVersion: String(
      decision.contractVersion || PARALEGAL_ROLLOUT_CONTRACT_VERSION
    ),
    rolloutStage: String(decision.rolloutStage || "unknown"),
    rolloutPercent: Number(decision.rolloutPercent || 0),
    rolloutBucket: Number.isInteger(decision.rolloutBucket)
      ? decision.rolloutBucket
      : null,
    enrollmentReason: String(decision.reason || "unknown"),
  };
}

module.exports = {
  PARALEGAL_ROLLOUT_CONTRACT_VERSION,
  PARALEGAL_ROLLOUT_STAGES,
  evaluateParalegalManagerRollout,
  evaluateParalegalRolloutStageGate,
  getParalegalRolloutStage,
  parseParalegalRolloutPercent,
  publicParalegalRolloutTelemetry,
  stableParalegalRolloutBucket,
};
