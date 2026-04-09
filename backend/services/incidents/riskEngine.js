const {
  INCIDENT_RISK_LEVELS,
  INCIDENT_AUTONOMY_MODES,
  HIGH_RISK_DOMAINS,
  HIGH_RISK_KEYWORDS,
  PROTECTED_FILE_PATHS,
  PROTECTED_FIELD_PATHS,
  CORE_WORKFLOW_FILE_PATHS,
  CORE_WORKFLOW_ROUTE_HINTS,
  RISK_LEVEL_RANK,
} = require("../../utils/incidentConstants");

const RISK_LEVEL_SET = new Set(INCIDENT_RISK_LEVELS);
const HIGH_RISK_DOMAIN_SET = new Set(HIGH_RISK_DOMAINS);
const PROTECTED_FILE_SET = new Set(PROTECTED_FILE_PATHS.map((value) => value.toLowerCase()));
const PROTECTED_FIELD_SET = new Set(PROTECTED_FIELD_PATHS.map((value) => value.toLowerCase()));
const CORE_WORKFLOW_FILE_SET = new Set(CORE_WORKFLOW_FILE_PATHS.map((value) => value.toLowerCase()));

function normalizeRiskLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return RISK_LEVEL_SET.has(normalized) ? normalized : "low";
}

function normalizeText(value) {
  return String(value || "").trim();
}

function toLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function normalizeAllowedProtectedPaths(value) {
  return normalizeStringArray(value).map((item) => item.toLowerCase());
}

function filterAllowedProtectedMatches(matches = [], allowedPaths = []) {
  const normalizedAllowed = normalizeAllowedProtectedPaths(allowedPaths);
  if (!normalizedAllowed.length) return normalizeStringArray(matches);

  return normalizeStringArray(matches).filter((rawMatch) => {
    const normalizedMatch = rawMatch.toLowerCase();
    return !normalizedAllowed.some(
      (allowedPath) => normalizedMatch.includes(allowedPath) || allowedPath.includes(normalizedMatch)
    );
  });
}

function toSearchableCorpus(input = {}) {
  return [
    input.summary,
    input.originalReportText,
    input.description,
    input.rootCauseSummary,
    input.errorMessage,
  ]
    .map((value) => toLowerText(value))
    .filter(Boolean)
    .join("\n");
}

function collectKeywordMatches(corpus) {
  return HIGH_RISK_KEYWORDS.filter((keyword) => corpus.includes(String(keyword).toLowerCase()));
}

function collectProtectedPathMatches(paths = []) {
  return normalizeStringArray(paths).filter((rawPath) => {
    const normalized = rawPath.toLowerCase();
    return Array.from(PROTECTED_FILE_SET).some((target) => normalized.includes(target));
  });
}

function collectProtectedFieldMatches(fields = []) {
  return normalizeStringArray(fields).filter((field) => {
    const normalized = field.toLowerCase();
    return Array.from(PROTECTED_FIELD_SET).some((target) => normalized.includes(target));
  });
}

function collectCoreWorkflowMatches(paths = [], routes = []) {
  const pathMatches = normalizeStringArray(paths).filter((rawPath) => {
    const normalized = rawPath.toLowerCase();
    return Array.from(CORE_WORKFLOW_FILE_SET).some((target) => normalized.includes(target));
  });
  const routeMatches = normalizeStringArray(routes).filter((rawRoute) => {
    const normalized = rawRoute.toLowerCase();
    return CORE_WORKFLOW_ROUTE_HINTS.some((target) => normalized.includes(target));
  });
  return [...new Set([...pathMatches, ...routeMatches])];
}

function touchesBackendRouteOrService(paths = []) {
  return normalizeStringArray(paths).some((rawPath) => {
    const normalized = rawPath.toLowerCase();
    return normalized.startsWith("backend/routes/") || normalized.startsWith("backend/services/");
  });
}

function resolveRiskFlags(riskFlags = {}) {
  return {
    affectsMoney: riskFlags.affectsMoney === true,
    affectsAccess: riskFlags.affectsAccess === true,
    affectsLegal: riskFlags.affectsLegal === true,
    affectsAuth: riskFlags.affectsAuth === true,
    affectsPermissions: riskFlags.affectsPermissions === true,
    affectsApprovalDecision: riskFlags.affectsApprovalDecision === true,
    affectsProfileVisibility: riskFlags.affectsProfileVisibility === true,
    affectsDisputes: riskFlags.affectsDisputes === true,
    affectsWithdrawals: riskFlags.affectsWithdrawals === true,
  };
}

function collectHighRiskReasons(input = {}) {
  const reasons = [];
  const domain = toLowerText(input.domain);
  const corpus = toSearchableCorpus(input);
  const allPaths = [
    ...normalizeStringArray(input.suspectedFiles),
    ...normalizeStringArray(input.touchedFiles),
    ...normalizeStringArray(input.touchedPaths),
  ];
  const allFields = normalizeStringArray(input.touchedFields);
  const keywordMatches = collectKeywordMatches(corpus);
  const protectedPathMatches = filterAllowedProtectedMatches(
    collectProtectedPathMatches(allPaths),
    input.allowedProtectedPaths
  );
  const protectedFieldMatches = collectProtectedFieldMatches(allFields);
  const flags = resolveRiskFlags(input.riskFlags);

  if (HIGH_RISK_DOMAIN_SET.has(domain)) reasons.push(`high-risk domain:${domain}`);
  if (flags.affectsMoney) reasons.push("risk flag:affectsMoney");
  if (flags.affectsAccess) reasons.push("risk flag:affectsAccess");
  if (flags.affectsLegal) reasons.push("risk flag:affectsLegal");
  if (flags.affectsAuth) reasons.push("risk flag:affectsAuth");
  if (flags.affectsPermissions) reasons.push("risk flag:affectsPermissions");
  if (flags.affectsApprovalDecision) reasons.push("risk flag:affectsApprovalDecision");
  if (flags.affectsProfileVisibility) reasons.push("risk flag:affectsProfileVisibility");
  if (flags.affectsDisputes) reasons.push("risk flag:affectsDisputes");
  if (flags.affectsWithdrawals) reasons.push("risk flag:affectsWithdrawals");

  keywordMatches.forEach((match) => reasons.push(`keyword:${match}`));
  protectedPathMatches.forEach((match) => reasons.push(`protected_path:${match}`));
  protectedFieldMatches.forEach((match) => reasons.push(`protected_field:${match}`));

  return {
    reasons: [...new Set(reasons)],
    keywordMatches,
    protectedPathMatches,
    protectedFieldMatches,
    riskFlags: flags,
  };
}

function classifyIncidentRisk(input = {}) {
  const confidence = toLowerText(input.confidence) || "low";
  const clusterIncidentCount = Number(input.clusterIncidentCount || 0);
  const allPaths = [
    ...normalizeStringArray(input.suspectedFiles),
    ...normalizeStringArray(input.touchedFiles),
    ...normalizeStringArray(input.touchedPaths),
  ];
  const allRoutes = normalizeStringArray(input.suspectedRoutes);
  const highRisk = collectHighRiskReasons(input);
  const mediumReasons = [];
  const coreWorkflowMatches = collectCoreWorkflowMatches(allPaths, allRoutes);

  if (highRisk.reasons.length) {
    return {
      riskLevel: "high",
      reasons: highRisk.reasons,
      keywordMatches: highRisk.keywordMatches,
      protectedPathMatches: highRisk.protectedPathMatches,
      protectedFieldMatches: highRisk.protectedFieldMatches,
      coreWorkflowMatches,
    };
  }

  if (touchesBackendRouteOrService(allPaths)) {
    mediumReasons.push("backend route/service change");
  }
  if (coreWorkflowMatches.length) {
    mediumReasons.push("core workflow change");
  }
  if (clusterIncidentCount >= 3) {
    mediumReasons.push("repeated cluster volume");
  }
  if (confidence === "low") {
    mediumReasons.push("low confidence");
  }

  const patchStrategy = toLowerText(input.patchStrategy);
  if (["backend_only", "fullstack", "config_only"].includes(patchStrategy) && !mediumReasons.length) {
    mediumReasons.push("non-trivial patch scope");
  }

  return {
    riskLevel: mediumReasons.length ? "medium" : "low",
    reasons: mediumReasons,
    keywordMatches: [],
    protectedPathMatches: [],
    protectedFieldMatches: [],
    coreWorkflowMatches,
  };
}

function determineAutonomyMode(input = {}) {
  if (input.manualOnly === true) return "manual_only";
  const riskLevel = normalizeRiskLevel(input.riskLevel);
  return riskLevel === "high" ? "approval_required" : "full_auto";
}

function reclassifyRiskUpward(currentRiskLevel, input = {}) {
  const previousRiskLevel = normalizeRiskLevel(currentRiskLevel);
  const next = classifyIncidentRisk(input);
  const riskLevel =
    RISK_LEVEL_RANK[next.riskLevel] > RISK_LEVEL_RANK[previousRiskLevel]
      ? next.riskLevel
      : previousRiskLevel;

  return {
    previousRiskLevel,
    riskLevel,
    upgraded: riskLevel !== previousRiskLevel,
    reasons: next.reasons,
    keywordMatches: next.keywordMatches,
    protectedPathMatches: next.protectedPathMatches,
    protectedFieldMatches: next.protectedFieldMatches,
    coreWorkflowMatches: next.coreWorkflowMatches,
    autonomyMode: determineAutonomyMode({ ...input, riskLevel }),
  };
}

function shouldRequireApproval(input = {}) {
  const reasons = [];
  const riskLevel = normalizeRiskLevel(input.riskLevel);
  const configDomainsTouched = normalizeStringArray(input.configDomainsTouched).map((value) =>
    value.toLowerCase()
  );

  if (riskLevel === "high") reasons.push("high-risk incident");
  if (input.manualDataRepair === true) reasons.push("manual data repair");
  if (configDomainsTouched.some((value) => ["payments", "auth", "disputes"].includes(value))) {
    reasons.push("protected config domain touched");
  }
  if (input.requiredVerificationPassed !== true) reasons.push("required verification incomplete");
  if (input.userFacingResolution === true && riskLevel === "high" && input.founderApprovalGranted !== true) {
    reasons.push("high-risk user-facing resolution requires founder approval");
  }

  return {
    required: reasons.length > 0,
    reasons,
  };
}

function canAutoDeploy(input = {}) {
  const reasons = [];
  const riskLevel = normalizeRiskLevel(input.riskLevel);
  const approvalState = toLowerText(input.approvalState);
  const verificationStatus = toLowerText(input.verificationStatus);
  const previewStatus = toLowerText(input.previewStatus);
  const filesTouched = normalizeStringArray(input.filesTouched);
  const protectedPathMatches = filterAllowedProtectedMatches(
    collectProtectedPathMatches(filesTouched),
    input.allowedProtectedPaths
  );

  if (input.autoDeployEnabled !== true) reasons.push("auto deploy disabled");
  if (!["low", "medium"].includes(riskLevel)) reasons.push("risk level not auto-deployable");
  if (approvalState !== "not_needed") reasons.push("approval state requires manual review");
  if (verificationStatus !== "passed") reasons.push("verification not passed");
  if (input.requiredChecksPassed !== true) reasons.push("required checks not passed");
  if (protectedPathMatches.length) reasons.push("protected paths touched");
  if (previewStatus !== "passed") reasons.push("preview not passed");
  if (!normalizeText(input.rollbackTargetDeployId) && input.skipRollbackTargetRequirement !== true) {
    reasons.push("rollback target missing");
  }
  if (Number(input.freshClusterIncidentCount || 0) > 0) reasons.push("fresh cluster incidents detected");

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function shouldTriggerRollback(input = {}) {
  const reasons = [];

  if (Number(input.healthFailuresWithinTwoMinutes || 0) >= 2) {
    reasons.push("health check failed twice in two minutes");
  }
  if (Number(input.prodSmokeFailures || 0) >= 2) {
    reasons.push("production smoke failed twice");
  }
  if (Number(input.postDeployErrorFingerprintCount || 0) >= 5) {
    reasons.push("error fingerprint spike after deploy");
  }
  if (Number(input.newClusterIncidentsWithin15Min || 0) >= 2) {
    reasons.push("new clustered incidents after deploy");
  }
  if (input.unauthorizedFailure === true) {
    reasons.push("unauthorized or forbidden regression detected");
  }
  if (input.protectedDomainSignal === true) {
    reasons.push("protected-domain regression signal detected");
  }

  return {
    shouldRollback: reasons.length > 0,
    reasons,
  };
}

module.exports = {
  normalizeRiskLevel,
  classifyIncidentRisk,
  determineAutonomyMode,
  reclassifyRiskUpward,
  shouldRequireApproval,
  canAutoDeploy,
  shouldTriggerRollback,
};
