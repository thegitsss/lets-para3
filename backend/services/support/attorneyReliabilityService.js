const crypto = require("crypto");
const {
  ATTORNEY_ROLLOUT_CONTRACT_VERSION,
  parseRolloutPercent,
} = require("./attorneyRolloutService");

const ATTORNEY_RELIABILITY_CONTRACT_VERSION = "2026-07-22.package8.v1";
const SUPPORT_TELEMETRY_RETENTION_DAYS = 183;

const ATTORNEY_RELIABILITY_THRESHOLDS = Object.freeze({
  minimumLaunchSample: 100,
  managerUnavailableRate: 0.01,
  toolFailureRate: 0.02,
  safeFallbackRate: 0.01,
  criticalValidationFailureCount: 0,
  unhelpfulMessageRate: 0.05,
  unhelpfulAmongFeedbackRate: 0.2,
  repeatedQuestionRate: 0.1,
  unknownQuestionRate: 0.1,
  missingTelemetryRate: 0.02,
  p95LatencyMs: 15000,
});

const CRITICAL_VALIDATION_PATTERNS = Object.freeze([
  /numeric_claim_absent_from_evidence/i,
  /unsupported_(?:financial|amount|date|status|participant)/i,
  /workflow_answer_conflicts/i,
  /unauthorized|ownership|sensitive/i,
  /forbidden_action_or_legal_claim/i,
  /unavailable_evidence_reported_as_absent/i,
  /claimed_data_unavailable_despite_available_evidence/i,
]);

const REGRESSION_LINKS = Object.freeze({
  manager_unavailable: "npm test -- --runInBand supportAssistant.test.js",
  tool_failure: "npm run test:integration:attorney-support",
  critical_validation_failure: "npm test -- --runInBand attorneyResponseValidator.test.js supportManagerAgent.test.js",
  safe_fallback: "npm test -- --runInBand supportManagerAgent.test.js supportResponseUi.test.js",
  unhelpful_feedback: "npm test -- --runInBand supportAssistant.test.js",
  repeated_question: "npm test -- --runInBand attorneyConversationResolver.test.js supportManagerAgent.test.js",
  unknown_question: "npm run test:eval:attorney-support-coverage",
  missing_telemetry: "npm test -- --runInBand attorneySupportReliability.test.js supportAssistant.test.js",
  latency: "npm test -- --runInBand attorneySupportReliability.test.js",
  unsafe_legacy_fallback: "npm test -- --runInBand attorneySupportReliability.test.js supportAssistant.test.js",
});

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function increment(map, key = "unknown", amount = 1) {
  const normalized = String(key || "unknown");
  map[normalized] = Number(map[normalized] || 0) + amount;
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function percentile(values = [], target = 0.95) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const index = Math.max(0, Math.ceil(numbers.length * target) - 1);
  return numbers[index];
}

function normalizeEvidenceState(result = {}) {
  const explicit = String(result.evidenceState || result.evidence?.state || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (result.ok === true && result.available === false) return "absent";
  if (result.ok === true) return "verified";
  return "unknown";
}

function classifyAttorneyToolOutcome(result = {}) {
  const evidenceState = normalizeEvidenceState(result);
  const error = String(result.error || result.reason || "").trim().toLowerCase();
  if (result.ok === true) {
    if (["absent", "not_applicable", "blocked_policy", "unknown", "temporarily_unavailable", "unauthorized"].includes(evidenceState)) {
      return evidenceState;
    }
    return "success";
  }
  if (evidenceState === "unauthorized" || /access|authoriz|role|ownership/.test(error)) return "authorization_denied";
  if (evidenceState === "temporarily_unavailable" || result.retryable === true || /timeout|unavailable|lookup_failed|execution_failed/.test(error)) {
    return "dependency_unavailable";
  }
  if (/invalid|unsupported_tool_argument|missing_tool_argument/.test(error)) return "invalid_request";
  if (error === "unknown_tool" || error === "tool_not_available_for_role") return "tool_contract";
  if (evidenceState === "absent") return "absence";
  return "unknown_failure";
}

function summarizeAttorneyToolCall({ name = "", capabilityId = "", result = {}, durationMs = 0 } = {}) {
  const normalizedCapabilityId = String(capabilityId || "").slice(0, 120);
  return {
    name: String(name || "unknown_tool").slice(0, 120),
    ...(normalizedCapabilityId ? { capabilityId: normalizedCapabilityId } : {}),
    ok: result?.ok === true,
    evidenceState: normalizeEvidenceState(result),
    failureClass: classifyAttorneyToolOutcome(result),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
  };
}

function normalizeQuestionForFingerprint(messageText = "") {
  const stop = new Set([
    "a", "an", "and", "are", "can", "could", "do", "does", "for", "have", "i", "in", "is", "it",
    "id", "me", "my", "of", "on", "please", "the", "this", "to", "what", "when", "where", "which", "who",
    "why", "with", "would", "you",
  ]);
  return String(messageText || "")
    .toLowerCase()
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " <email> ")
    .replace(/\b[0-9a-f]{24}\b/gi, " <record> ")
    .replace(/\$?\d+(?:[.,]\d+)*(?:%|\b)/g, " <number> ")
    .replace(/https?:\/\/\S+/g, " <url> ")
    .replace(/[^a-z<>\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && (!stop.has(token) || token.startsWith("<")))
    .slice(0, 24)
    .sort()
    .join(" ");
}

function buildQuestionFamilySignal(messageText = "") {
  const normalized = normalizeQuestionForFingerprint(messageText);
  if (!normalized) return { familyKey: "question:empty", tokenCount: 0 };
  return {
    familyKey: `question:${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`,
    tokenCount: normalized.split(/\s+/).filter(Boolean).length,
  };
}

function isCriticalValidationFailure(value = "") {
  return CRITICAL_VALIDATION_PATTERNS.some((pattern) => pattern.test(String(value || "")));
}

function getAttorneySupportOperationalMode(env = process.env) {
  const managerEnabled = !["0", "false", "off", "disabled"].includes(
    String(env.OPENAI_SUPPORT_MANAGER_ENABLED || "true").trim().toLowerCase()
  );
  const attorneyManagerEnabled = !["0", "false", "off", "disabled"].includes(
    String(env.OPENAI_ATTORNEY_MANAGER_ENABLED || "true").trim().toLowerCase()
  );
  const rolloutPercent = parseRolloutPercent(env.OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT);
  const allowlistConfigured = Boolean(String(env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST || "").trim());
  const legacyFallbackEnabled = ["1", "true", "on", "enabled"].includes(
    String(env.OPENAI_ATTORNEY_LEGACY_FALLBACK || "false").trim().toLowerCase()
  );
  const effectiveManagerEnabled = managerEnabled && attorneyManagerEnabled && (rolloutPercent > 0 || allowlistConfigured);
  return {
    managerEnabled,
    attorneyManagerEnabled,
    rolloutPercent,
    allowlistConfigured,
    legacyFallbackEnabled,
    mode: effectiveManagerEnabled
      ? rolloutPercent === 100
        ? "manager"
        : "staged_manager"
      : legacyFallbackEnabled
        ? "unsafe_legacy_fallback"
        : "safe_disabled",
    safeDisableConfigured: !effectiveManagerEnabled && !legacyFallbackEnabled,
  };
}

function failureRegressionLink(failureClass = "") {
  const normalized = String(failureClass || "").trim();
  if (REGRESSION_LINKS[normalized]) return REGRESSION_LINKS[normalized];
  if (normalized.startsWith("tool_failure")) return REGRESSION_LINKS.tool_failure;
  return "npm run test:eval:attorney-support-coverage";
}

function buildSyntheticAttorneyReliabilityMessages() {
  const base = {
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
    metadata: {
      provider: "openai_manager",
      feedback: null,
      reliability: {
        evidenceStatus: "verified",
        capabilityIds: ["A01_matter_overview"],
        validationRetries: 0,
        validationFailures: [],
        validationExhausted: false,
        retryOutcome: "not_needed",
        reliabilityGap: "",
        repeatedQuestion: false,
        questionFamilyKey: "question:synthetic001",
        unknownQuestionCluster: "",
      },
      telemetry: {
        managerAvailable: true,
        latencyMs: 1200,
        rollout: {
          contractVersion: ATTORNEY_ROLLOUT_CONTRACT_VERSION,
          rolloutStage: "general",
          rolloutPercent: 100,
          rolloutBucket: 1,
          enrollmentReason: "all_attorneys",
        },
        toolCalls: [{
          name: "get_my_case_overview",
          capabilityId: "A01_matter_overview",
          ok: true,
          evidenceState: "verified",
          failureClass: "success",
          durationMs: 25,
        }],
      },
    },
  };
  return Array.from({ length: 120 }, (_, index) => ({
    _id: `synthetic-message-${index + 1}`,
    conversationId: `synthetic-conversation-${Math.floor(index / 3) + 1}`,
    ...JSON.parse(JSON.stringify(base)),
    createdAt: new Date(Date.parse("2026-07-22T12:00:00.000Z") + index * 1000),
  }));
}

function normalizeMessage(message = {}) {
  const metadata = message.metadata || {};
  return {
    id: String(message._id || message.id || ""),
    conversationId: String(message.conversationId || ""),
    createdAt: message.createdAt || null,
    provider: String(metadata.provider || "unknown"),
    feedbackRating: String(metadata.feedback?.rating || ""),
    reliability: metadata.reliability && typeof metadata.reliability === "object" ? metadata.reliability : {},
    telemetry: metadata.telemetry && typeof metadata.telemetry === "object" ? metadata.telemetry : {},
  };
}

function summarizeAttorneyReliability(messages = [], {
  windowDays = 30,
  thresholds = ATTORNEY_RELIABILITY_THRESHOLDS,
  operationalMode = getAttorneySupportOperationalMode({}),
} = {}) {
  const providerCounts = {};
  const managerAvailabilityCounts = {};
  const evidenceStatusCounts = {};
  const capabilityCounts = {};
  const validationFailureCounts = {};
  const toolFailureCounts = {};
  const toolSelectionCounts = {};
  const toolOutcomeCounts = {};
  const toolEvidenceStateCounts = {};
  const reliabilityGapCounts = {};
  const retryOutcomeCounts = {};
  const rolloutStageCounts = {};
  const rolloutPercentCounts = {};
  const rolloutContractVersionCounts = {};
  const unknownQuestionClusters = {};
  const capabilityReliability = {};
  const failureSamples = [];
  const latencyValues = [];
  const toolLatencyValues = [];
  let managerMessageCount = 0;
  let managerUnavailableCount = 0;
  let safeFallbackCount = 0;
  let feedbackCount = 0;
  let unhelpfulCount = 0;
  let validationRetryMessageCount = 0;
  let validationExhaustedCount = 0;
  let criticalValidationFailureCount = 0;
  let toolCallCount = 0;
  let toolFailureCount = 0;
  let repeatedQuestionCount = 0;
  let unknownQuestionCount = 0;
  let missingTelemetryCount = 0;
  let rolloutExcludedCount = 0;
  let rolloutTelemetryMissingCount = 0;

  for (const rawMessage of messages) {
    const message = normalizeMessage(rawMessage);
    const reliability = message.reliability;
    const telemetry = message.telemetry;
    increment(providerCounts, message.provider);
    increment(evidenceStatusCounts, reliability.evidenceStatus || "unknown");
    increment(retryOutcomeCounts, reliability.retryOutcome || "unknown");
    const managerRelated = message.provider.startsWith("openai_manager") || message.provider === "attorney_manager_unavailable";
    if (managerRelated) managerMessageCount += 1;
    if (managerRelated) {
      increment(
        managerAvailabilityCounts,
        telemetry.managerAvailable === true
          ? "available"
          : telemetry.managerAvailable === false
            ? "unavailable"
            : "missing"
      );
      const rollout = telemetry.rollout && typeof telemetry.rollout === "object" ? telemetry.rollout : {};
      const rolloutStage = String(rollout.rolloutStage || "").trim();
      const rolloutPercent = Number(rollout.rolloutPercent);
      const rolloutContractVersion = String(rollout.contractVersion || "").trim();
      if (rolloutStage) increment(rolloutStageCounts, rolloutStage);
      if (Number.isFinite(rolloutPercent)) increment(rolloutPercentCounts, String(rolloutPercent));
      if (rolloutContractVersion) increment(rolloutContractVersionCounts, rolloutContractVersion);
      if (!rolloutStage || !Number.isFinite(rolloutPercent) || rolloutContractVersion !== ATTORNEY_ROLLOUT_CONTRACT_VERSION) {
        rolloutTelemetryMissingCount += 1;
      }
    }
    if (message.provider === "attorney_manager_unavailable") managerUnavailableCount += 1;
    if (message.provider === "attorney_manager_not_enrolled") rolloutExcludedCount += 1;
    if (message.provider === "openai_manager_safe_fallback") safeFallbackCount += 1;
    if (message.feedbackRating) feedbackCount += 1;
    if (message.feedbackRating === "unhelpful") unhelpfulCount += 1;
    if (Number(reliability.validationRetries || 0) > 0) validationRetryMessageCount += 1;
    if (reliability.validationExhausted === true) validationExhaustedCount += 1;
    if (reliability.repeatedQuestion === true) repeatedQuestionCount += 1;
    if (reliability.unknownQuestionCluster) {
      unknownQuestionCount += 1;
      increment(unknownQuestionClusters, reliability.unknownQuestionCluster);
    }
    if (reliability.reliabilityGap) increment(reliabilityGapCounts, reliability.reliabilityGap);
    const capabilityIds = Array.isArray(reliability.capabilityIds) ? reliability.capabilityIds : [];
    for (const capabilityId of capabilityIds) {
      increment(capabilityCounts, capabilityId);
      const capability = capabilityReliability[capabilityId] || {
        messageCount: 0,
        unhelpfulCount: 0,
        validationRetryCount: 0,
        safeFallbackCount: 0,
        toolCallCount: 0,
        toolFailureCount: 0,
      };
      capability.messageCount += 1;
      if (message.feedbackRating === "unhelpful") capability.unhelpfulCount += 1;
      if (Number(reliability.validationRetries || 0) > 0) capability.validationRetryCount += 1;
      if (message.provider === "openai_manager_safe_fallback") capability.safeFallbackCount += 1;
      capabilityReliability[capabilityId] = capability;
    }
    const validationFailures = Array.isArray(reliability.validationFailures) ? reliability.validationFailures : [];
    for (const failure of validationFailures) {
      increment(validationFailureCounts, failure);
      if (isCriticalValidationFailure(failure)) criticalValidationFailureCount += 1;
    }
    const latencyMs = Number(telemetry.latencyMs);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) latencyValues.push(latencyMs);
    const toolCalls = Array.isArray(telemetry.toolCalls) ? telemetry.toolCalls : [];
    if (
      managerRelated &&
      (
        typeof telemetry.managerAvailable !== "boolean" ||
        !Array.isArray(telemetry.toolCalls) ||
        !telemetry.rollout ||
        String(telemetry.rollout?.contractVersion || "") !== ATTORNEY_ROLLOUT_CONTRACT_VERSION ||
        !String(telemetry.rollout?.rolloutStage || "").trim() ||
        !Number.isFinite(Number(telemetry.rollout?.rolloutPercent)) ||
        (telemetry.managerAvailable === true && !(Number.isFinite(latencyMs) && latencyMs >= 0))
      )
    ) {
      missingTelemetryCount += 1;
    }
    const issues = [];
    if (message.provider === "attorney_manager_unavailable") issues.push("manager_unavailable");
    if (message.provider === "openai_manager_safe_fallback") issues.push("safe_fallback");
    if (message.feedbackRating === "unhelpful") issues.push("unhelpful_feedback");
    if (reliability.repeatedQuestion === true) issues.push("repeated_question");
    if (reliability.unknownQuestionCluster) issues.push("unknown_question");
    if (validationFailures.some(isCriticalValidationFailure)) issues.push("critical_validation_failure");
    for (const call of toolCalls) {
      toolCallCount += 1;
      increment(toolSelectionCounts, call.name || "unknown_tool");
      const failureClass = String(call.failureClass || (call.ok === true ? "success" : "unknown_failure"));
      const evidenceState = String(call.evidenceState || "unknown");
      increment(toolOutcomeCounts, failureClass);
      increment(toolEvidenceStateCounts, evidenceState);
      const durationMs = Number(call.durationMs);
      if (Number.isFinite(durationMs) && durationMs >= 0) toolLatencyValues.push(durationMs);
      const callCapabilityId = String(call.capabilityId || "");
      const attributedCapabilityIds = callCapabilityId && capabilityReliability[callCapabilityId]
        ? [callCapabilityId]
        : capabilityIds.length === 1
          ? capabilityIds
          : [];
      for (const capabilityId of attributedCapabilityIds) {
        const capability = capabilityReliability[capabilityId];
        if (!capability) continue;
        capability.toolCallCount += 1;
        if (call.ok !== true) capability.toolFailureCount += 1;
      }
      if (call.ok !== true) {
        toolFailureCount += 1;
        increment(toolFailureCounts, `${call.name || "unknown_tool"}:${failureClass}`);
        issues.push(`tool_failure:${failureClass}`);
      }
    }
    if (issues.length && failureSamples.length < 25) {
      failureSamples.push({
        messageId: message.id,
        createdAt: message.createdAt,
        issues: unique(issues),
        regressionCommands: unique(issues.map((issue) => failureRegressionLink(issue.split(":")[0]))),
      });
    }
  }

  for (const capability of Object.values(capabilityReliability)) {
    capability.unhelpfulRate = rate(capability.unhelpfulCount, capability.messageCount);
    capability.toolFailureRate = rate(capability.toolFailureCount, capability.toolCallCount);
    capability.safeFallbackRate = rate(capability.safeFallbackCount, capability.messageCount);
  }

  const metrics = {
    managerUnavailableRate: rate(managerUnavailableCount, managerMessageCount),
    safeFallbackRate: rate(safeFallbackCount, managerMessageCount),
    unhelpfulMessageRate: rate(unhelpfulCount, messages.length),
    unhelpfulAmongFeedbackRate: rate(unhelpfulCount, feedbackCount),
    toolFailureRate: rate(toolFailureCount, toolCallCount),
    repeatedQuestionRate: rate(repeatedQuestionCount, managerMessageCount),
    unknownQuestionRate: rate(unknownQuestionCount, managerMessageCount),
    missingTelemetryRate: rate(missingTelemetryCount, managerMessageCount),
    p95LatencyMs: percentile(latencyValues, 0.95),
    p95ToolLatencyMs: percentile(toolLatencyValues, 0.95),
  };
  const sampleReady = managerMessageCount >= Number(thresholds.minimumLaunchSample || 0);
  const breaches = [];
  if (managerUnavailableCount && metrics.managerUnavailableRate > thresholds.managerUnavailableRate) breaches.push("manager_unavailable");
  if (toolFailureCount && metrics.toolFailureRate > thresholds.toolFailureRate) breaches.push("tool_failure");
  if (safeFallbackCount && metrics.safeFallbackRate > thresholds.safeFallbackRate) breaches.push("safe_fallback");
  if (criticalValidationFailureCount > thresholds.criticalValidationFailureCount) breaches.push("critical_validation_failure");
  if (unhelpfulCount && metrics.unhelpfulMessageRate > thresholds.unhelpfulMessageRate) breaches.push("unhelpful_feedback");
  if (feedbackCount && metrics.unhelpfulAmongFeedbackRate > thresholds.unhelpfulAmongFeedbackRate) breaches.push("unhelpful_feedback_ratio");
  if (repeatedQuestionCount && metrics.repeatedQuestionRate > thresholds.repeatedQuestionRate) breaches.push("repeated_question");
  if (unknownQuestionCount && metrics.unknownQuestionRate > thresholds.unknownQuestionRate) breaches.push("unknown_question");
  if (missingTelemetryCount && metrics.missingTelemetryRate > thresholds.missingTelemetryRate) breaches.push("missing_telemetry");
  if (metrics.p95LatencyMs != null && metrics.p95LatencyMs > thresholds.p95LatencyMs) breaches.push("latency");
  if (operationalMode.mode === "unsafe_legacy_fallback") breaches.push("unsafe_legacy_fallback");
  const alerts = unique(breaches).map((failureClass) => ({
    severity: ["critical_validation_failure", "manager_unavailable", "missing_telemetry", "unsafe_legacy_fallback"].includes(failureClass)
      ? "critical"
      : "warning",
    failureClass,
    regressionCommand: failureRegressionLink(failureClass),
    action: ["critical_validation_failure", "manager_unavailable", "tool_failure", "safe_fallback", "missing_telemetry", "unsafe_legacy_fallback"].includes(failureClass)
      ? "disable_attorney_manager_and_investigate"
      : "investigate_and_add_regression",
  }));
  const hasZeroToleranceBreach = breaches.some((failureClass) =>
    ["critical_validation_failure", "unsafe_legacy_fallback"].includes(failureClass)
  );
  const gate = !messages.length
    ? { passed: null, status: "missing_data", reason: "no_attorney_assistant_messages_in_window" }
    : hasZeroToleranceBreach
      ? { passed: false, status: "threshold_breach", breaches: unique(breaches) }
    : !sampleReady
      ? { passed: null, status: "insufficient_sample", reason: "minimum_launch_sample_not_met" }
      : { passed: breaches.length === 0, status: breaches.length ? "threshold_breach" : "passed", breaches: unique(breaches) };
  return {
    contractVersion: ATTORNEY_RELIABILITY_CONTRACT_VERSION,
    role: "attorney",
    readOnly: true,
    windowDays,
    retentionDays: SUPPORT_TELEMETRY_RETENTION_DAYS,
    assistantMessageCount: messages.length,
    managerMessageCount,
    managerUnavailableCount,
    safeFallbackCount,
    feedbackCount,
    unhelpfulCount,
    validationRetryMessageCount,
    validationExhaustedCount,
    criticalValidationFailureCount,
    toolCallCount,
    toolFailureCount,
    repeatedQuestionCount,
    unknownQuestionCount,
    missingTelemetryCount,
    rolloutExcludedCount,
    rolloutTelemetryMissingCount,
    metrics,
    thresholds,
    gate,
    operationalMode,
    alerts,
    providerCounts,
    managerAvailabilityCounts,
    evidenceStatusCounts,
    capabilityCounts,
    capabilityReliability,
    validationFailureCounts,
    toolFailureCounts,
    toolSelectionCounts,
    toolOutcomeCounts,
    toolEvidenceStateCounts,
    reliabilityGapCounts,
    retryOutcomeCounts,
    rolloutStageCounts,
    rolloutPercentCounts,
    rolloutContractVersionCounts,
    unknownQuestionClusters: Object.entries(unknownQuestionClusters)
      .map(([clusterKey, count]) => ({
        clusterKey,
        count,
        sourceOfTruthBacklog: "docs/attorney-assistant/SOURCE_OF_TRUTH_MATRIX.md",
        evaluationBacklog: "backend/ai/attorneySupportEvalCorpus.js",
      }))
      .sort((left, right) => right.count - left.count),
    failureSamples,
    privacy: {
      rawMessageTextRead: false,
      rawToolOutputRead: false,
      customerIdentityProjected: false,
      unknownQuestionContentStored: false,
    },
  };
}

module.exports = {
  ATTORNEY_RELIABILITY_CONTRACT_VERSION,
  ATTORNEY_RELIABILITY_THRESHOLDS,
  SUPPORT_TELEMETRY_RETENTION_DAYS,
  buildQuestionFamilySignal,
  buildSyntheticAttorneyReliabilityMessages,
  classifyAttorneyToolOutcome,
  failureRegressionLink,
  getAttorneySupportOperationalMode,
  isCriticalValidationFailure,
  normalizeEvidenceState,
  normalizeQuestionForFingerprint,
  percentile,
  rate,
  summarizeAttorneyReliability,
  summarizeAttorneyToolCall,
};
