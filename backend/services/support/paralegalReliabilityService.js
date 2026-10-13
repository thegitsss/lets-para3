const crypto = require("crypto");
const {
  PARALEGAL_ROLLOUT_CONTRACT_VERSION,
  getParalegalRolloutStage,
  parseParalegalRolloutPercent,
} = require("./paralegalRolloutService");

const PARALEGAL_RELIABILITY_CONTRACT_VERSION = "2026-07-23.paralegal.package8.v1";
const PARALEGAL_SUPPORT_TELEMETRY_RETENTION_DAYS = 183;

const PARALEGAL_RELIABILITY_THRESHOLDS = Object.freeze({
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
  /unsupported_(?:monetary|fee|date|name|status|bank_receipt|workflow|authorization|availability)/i,
  /attorney_financial_data_out_of_scope/i,
  /unauthorized|ownership|sensitive|internal_field|raw_evidence/i,
  /legal_boundary|false_action_or_handoff/i,
  /unavailable_evidence_used_as_fact|direct_factual_answer_without_successful_tool_evidence/i,
]);

const REGRESSION_LINKS = Object.freeze({
  manager_unavailable: "npm test -- --runInBand tests/paralegalSupportReliability.test.js",
  tool_failure: "npm run test:integration:paralegal-support",
  critical_validation_failure:
    "npm test -- --runInBand tests/paralegalResponseValidator.test.js tests/paralegalResponsePipeline.test.js",
  safe_fallback:
    "npm test -- --runInBand tests/paralegalResponsePipeline.test.js tests/paralegalResponseUiPolicy.test.js",
  unhelpful_feedback: "npm test -- --runInBand tests/supportAssistant.test.js",
  repeated_question:
    "npm test -- --runInBand tests/paralegalConversationResolver.test.js tests/paralegalConversationPolicy.test.js",
  unknown_question: "npm run test:eval:paralegal-support-coverage",
  missing_telemetry:
    "npm test -- --runInBand tests/paralegalSupportReliability.test.js tests/supportAssistant.test.js",
  latency: "npm test -- --runInBand tests/paralegalSupportReliability.test.js",
  unsafe_legacy_fallback:
    "npm test -- --runInBand tests/paralegalSupportReliability.test.js tests/supportAssistant.test.js",
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
  const numbers = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!numbers.length) return null;
  return numbers[Math.max(0, Math.ceil(numbers.length * target) - 1)];
}

function normalizeParalegalEvidenceState(result = {}) {
  const explicit = String(result.evidenceState || result.evidence?.state || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;
  if (result.ok === true && result.available === false) return "absent";
  if (result.ok === true) return "verified";
  return "unknown";
}

function classifyParalegalToolOutcome(result = {}) {
  const evidenceState = normalizeParalegalEvidenceState(result);
  const error = String(result.error || result.reason || "").trim().toLowerCase();
  if (result.ok === true) {
    if (
      ["absent", "not_applicable", "blocked_policy", "unknown", "temporarily_unavailable", "unauthorized"]
        .includes(evidenceState)
    ) {
      return evidenceState;
    }
    return "success";
  }
  if (evidenceState === "unauthorized" || /access|authoriz|role|ownership/.test(error)) {
    return "authorization_denied";
  }
  if (
    evidenceState === "temporarily_unavailable" ||
    result.retryable === true ||
    /timeout|unavailable|lookup_failed|execution_failed/.test(error)
  ) {
    return "dependency_unavailable";
  }
  if (/invalid|unsupported_tool_argument|missing_tool_argument/.test(error)) return "invalid_request";
  if (error === "unknown_tool" || error === "tool_not_available_for_role") return "tool_contract";
  if (evidenceState === "absent") return "absence";
  return "unknown_failure";
}

function summarizeParalegalToolCall({
  name = "",
  capabilityId = "",
  result = {},
  durationMs = 0,
} = {}) {
  const safeCapabilityId = String(capabilityId || "").slice(0, 120);
  return {
    name: String(name || "unknown_tool").slice(0, 120),
    ...(safeCapabilityId ? { capabilityId: safeCapabilityId } : {}),
    ok: result?.ok === true,
    evidenceState: normalizeParalegalEvidenceState(result),
    failureClass: classifyParalegalToolOutcome(result),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
  };
}

function normalizeParalegalQuestionForFingerprint(messageText = "") {
  const stop = new Set([
    "a", "an", "and", "are", "can", "could", "do", "does", "for", "have", "i", "id", "in", "is", "it",
    "me", "my", "of", "on", "please", "the", "this", "to", "what", "when", "where", "which", "who",
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

function buildParalegalQuestionFamilySignal(messageText = "") {
  const normalized = normalizeParalegalQuestionForFingerprint(messageText);
  if (!normalized) return { familyKey: "paralegal-question:empty", tokenCount: 0 };
  return {
    familyKey:
      `paralegal-question:${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`,
    tokenCount: normalized.split(/\s+/).filter(Boolean).length,
  };
}

function isCriticalParalegalValidationFailure(value = "") {
  return CRITICAL_VALIDATION_PATTERNS.some((pattern) => pattern.test(String(value || "")));
}

function enabled(value, fallback = false) {
  const normalized = String(value ?? (fallback ? "true" : "false")).trim().toLowerCase();
  return ["1", "true", "on", "enabled"].includes(normalized);
}

function getParalegalSupportOperationalMode(env = process.env) {
  const globalManagerEnabled = !["0", "false", "off", "disabled"].includes(
    String(env.OPENAI_SUPPORT_MANAGER_ENABLED || "true").trim().toLowerCase()
  );
  const paralegalManagerEnabled = enabled(env.OPENAI_PARALEGAL_MANAGER_ENABLED, false);
  const rolloutPercent = parseParalegalRolloutPercent(
    env.OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT
  );
  const legacyFallbackEnabled = enabled(env.OPENAI_PARALEGAL_LEGACY_FALLBACK, false);
  const effectiveManagerEnabled = globalManagerEnabled && paralegalManagerEnabled;
  return {
    globalManagerEnabled,
    paralegalManagerEnabled,
    legacyFallbackEnabled,
    rolloutPercent,
    rolloutStage: getParalegalRolloutStage(rolloutPercent),
    rolloutAllowlistConfigured: Boolean(
      String(env.OPENAI_PARALEGAL_MANAGER_ALLOWLIST || "").trim()
    ),
    mode: effectiveManagerEnabled
      ? "manager_active"
      : legacyFallbackEnabled
        ? "unsafe_legacy_fallback"
        : "safe_disabled",
    safeDisableConfigured: !effectiveManagerEnabled && !legacyFallbackEnabled,
  };
}

function paralegalFailureRegressionLink(failureClass = "") {
  const normalized = String(failureClass || "").trim();
  if (REGRESSION_LINKS[normalized]) return REGRESSION_LINKS[normalized];
  if (normalized.startsWith("tool_failure")) return REGRESSION_LINKS.tool_failure;
  return REGRESSION_LINKS.unknown_question;
}

function buildSyntheticParalegalReliabilityMessages() {
  const base = {
    createdAt: new Date("2026-07-23T12:00:00.000Z"),
    metadata: {
      provider: "openai_manager_paralegal",
      feedback: null,
      reliability: {
        role: "paralegal",
        evidenceStatus: "verified",
        capabilityIds: ["P01_assigned_overview"],
        validationRetries: 0,
        validationFailures: [],
        validationExhausted: false,
        retryOutcome: "not_needed",
        reliabilityGap: "",
        repeatedQuestion: false,
        questionFamilyKey: "paralegal-question:synthetic001",
        unknownQuestionCluster: "",
      },
      telemetry: {
        role: "paralegal",
        managerAvailable: true,
        latencyMs: 1100,
        rollout: {
          contractVersion: PARALEGAL_ROLLOUT_CONTRACT_VERSION,
          rolloutStage: "full",
          rolloutPercent: 100,
          rolloutBucket: 42,
          enrollmentReason: "all_paralegals",
        },
        toolCalls: [{
          name: "get_paralegal_case_overview",
          capabilityId: "P01_assigned_overview",
          ok: true,
          evidenceState: "verified",
          failureClass: "success",
          durationMs: 24,
        }],
      },
    },
  };
  return Array.from({ length: 120 }, (_, index) => ({
    _id: `synthetic-paralegal-message-${index + 1}`,
    conversationId: `synthetic-paralegal-conversation-${Math.floor(index / 3) + 1}`,
    ...structuredClone(base),
    createdAt: new Date(Date.parse("2026-07-23T12:00:00.000Z") + index * 1000),
  }));
}

function normalizeMessage(message = {}) {
  const metadata = message.metadata || {};
  return {
    id: String(message._id || message.id || ""),
    createdAt: message.createdAt || null,
    provider: String(metadata.provider || "unknown"),
    feedbackRating: String(metadata.feedback?.rating || ""),
    reliability:
      metadata.reliability && typeof metadata.reliability === "object"
        ? metadata.reliability
        : {},
    telemetry:
      metadata.telemetry && typeof metadata.telemetry === "object"
        ? metadata.telemetry
        : {},
  };
}

function summarizeParalegalReliability(messages = [], {
  windowDays = 30,
  thresholds = PARALEGAL_RELIABILITY_THRESHOLDS,
  operationalMode = getParalegalSupportOperationalMode({}),
} = {}) {
  const providerCounts = {};
  const managerAvailabilityCounts = {};
  const evidenceStatusCounts = {};
  const capabilityCounts = {};
  const capabilityReliability = {};
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
  const failureSamples = [];
  const latencyValues = [];
  const toolLatencyValues = [];
  let assistantMessageCount = 0;
  let roleExcludedCount = 0;
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

  for (const rawMessage of Array.isArray(messages) ? messages : []) {
    const message = normalizeMessage(rawMessage);
    const eventRole = String(message.telemetry.role || message.reliability.role || "").toLowerCase();
    if (eventRole && eventRole !== "paralegal") {
      roleExcludedCount += 1;
      continue;
    }
    assistantMessageCount += 1;
    const reliability = message.reliability;
    const telemetry = message.telemetry;
    increment(providerCounts, message.provider);
    increment(evidenceStatusCounts, reliability.evidenceStatus || "unknown");
    increment(retryOutcomeCounts, reliability.retryOutcome || "unknown");
    const managerRelated =
      message.provider.startsWith("openai_manager_paralegal") ||
      message.provider === "paralegal_manager_unavailable";
    if (managerRelated) {
      managerMessageCount += 1;
      increment(
        managerAvailabilityCounts,
        telemetry.managerAvailable === true
          ? "available"
          : telemetry.managerAvailable === false
            ? "unavailable"
          : "missing"
      );
      const rollout =
        telemetry.rollout && typeof telemetry.rollout === "object"
          ? telemetry.rollout
          : {};
      const rolloutStage = String(rollout.rolloutStage || "").trim();
      const rolloutPercent = Number(rollout.rolloutPercent);
      const rolloutContractVersion = String(rollout.contractVersion || "").trim();
      if (rolloutStage) increment(rolloutStageCounts, rolloutStage);
      if (Number.isFinite(rolloutPercent)) {
        increment(rolloutPercentCounts, String(rolloutPercent));
      }
      if (rolloutContractVersion) {
        increment(rolloutContractVersionCounts, rolloutContractVersion);
      }
      if (
        !rolloutStage ||
        !Number.isFinite(rolloutPercent) ||
        rolloutContractVersion !== PARALEGAL_ROLLOUT_CONTRACT_VERSION
      ) {
        rolloutTelemetryMissingCount += 1;
      }
    }
    if (message.provider === "paralegal_manager_unavailable") managerUnavailableCount += 1;
    if (message.provider === "paralegal_manager_not_enrolled") rolloutExcludedCount += 1;
    if (message.provider === "openai_manager_paralegal_safe_fallback") safeFallbackCount += 1;
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
    const capabilityIds = Array.isArray(reliability.capabilityIds)
      ? reliability.capabilityIds.filter((value) => /^P\d{2}_/.test(String(value || "")))
      : [];
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
      if (message.provider === "openai_manager_paralegal_safe_fallback") {
        capability.safeFallbackCount += 1;
      }
      capabilityReliability[capabilityId] = capability;
    }
    const validationFailures = Array.isArray(reliability.validationFailures)
      ? reliability.validationFailures
      : [];
    for (const failure of validationFailures) {
      increment(validationFailureCounts, failure);
      if (isCriticalParalegalValidationFailure(failure)) criticalValidationFailureCount += 1;
    }
    const latencyMs = Number(telemetry.latencyMs);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) latencyValues.push(latencyMs);
    const toolCalls = Array.isArray(telemetry.toolCalls) ? telemetry.toolCalls : [];
    if (
      managerRelated &&
      (
        telemetry.role !== "paralegal" ||
        typeof telemetry.managerAvailable !== "boolean" ||
        !Array.isArray(telemetry.toolCalls) ||
        !telemetry.rollout ||
        String(telemetry.rollout?.contractVersion || "") !==
          PARALEGAL_ROLLOUT_CONTRACT_VERSION ||
        !String(telemetry.rollout?.rolloutStage || "").trim() ||
        !Number.isFinite(Number(telemetry.rollout?.rolloutPercent)) ||
        (telemetry.managerAvailable === true && !(Number.isFinite(latencyMs) && latencyMs >= 0))
      )
    ) {
      missingTelemetryCount += 1;
    }
    const issues = [];
    if (message.provider === "paralegal_manager_unavailable") issues.push("manager_unavailable");
    if (message.provider === "openai_manager_paralegal_safe_fallback") issues.push("safe_fallback");
    if (message.feedbackRating === "unhelpful") issues.push("unhelpful_feedback");
    if (reliability.repeatedQuestion === true) issues.push("repeated_question");
    if (reliability.unknownQuestionCluster) issues.push("unknown_question");
    if (validationFailures.some(isCriticalParalegalValidationFailure)) {
      issues.push("critical_validation_failure");
    }
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
      const attributedIds =
        callCapabilityId && capabilityReliability[callCapabilityId]
          ? [callCapabilityId]
          : capabilityIds.length === 1
            ? capabilityIds
            : [];
      for (const capabilityId of attributedIds) {
        capabilityReliability[capabilityId].toolCallCount += 1;
        if (call.ok !== true) capabilityReliability[capabilityId].toolFailureCount += 1;
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
        regressionCommands: unique(
          issues.map((issue) => paralegalFailureRegressionLink(issue.split(":")[0]))
        ),
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
    unhelpfulMessageRate: rate(unhelpfulCount, assistantMessageCount),
    unhelpfulAmongFeedbackRate: rate(unhelpfulCount, feedbackCount),
    toolFailureRate: rate(toolFailureCount, toolCallCount),
    repeatedQuestionRate: rate(repeatedQuestionCount, managerMessageCount),
    unknownQuestionRate: rate(unknownQuestionCount, managerMessageCount),
    missingTelemetryRate: rate(missingTelemetryCount, managerMessageCount),
    p95LatencyMs: percentile(latencyValues),
    p95ToolLatencyMs: percentile(toolLatencyValues),
  };
  const breaches = [];
  if (managerUnavailableCount && metrics.managerUnavailableRate > thresholds.managerUnavailableRate) {
    breaches.push("manager_unavailable");
  }
  if (toolFailureCount && metrics.toolFailureRate > thresholds.toolFailureRate) breaches.push("tool_failure");
  if (safeFallbackCount && metrics.safeFallbackRate > thresholds.safeFallbackRate) breaches.push("safe_fallback");
  if (criticalValidationFailureCount > thresholds.criticalValidationFailureCount) {
    breaches.push("critical_validation_failure");
  }
  if (unhelpfulCount && metrics.unhelpfulMessageRate > thresholds.unhelpfulMessageRate) {
    breaches.push("unhelpful_feedback");
  }
  if (feedbackCount && metrics.unhelpfulAmongFeedbackRate > thresholds.unhelpfulAmongFeedbackRate) {
    breaches.push("unhelpful_feedback_ratio");
  }
  if (repeatedQuestionCount && metrics.repeatedQuestionRate > thresholds.repeatedQuestionRate) {
    breaches.push("repeated_question");
  }
  if (unknownQuestionCount && metrics.unknownQuestionRate > thresholds.unknownQuestionRate) {
    breaches.push("unknown_question");
  }
  if (missingTelemetryCount && metrics.missingTelemetryRate > thresholds.missingTelemetryRate) {
    breaches.push("missing_telemetry");
  }
  if (metrics.p95LatencyMs != null && metrics.p95LatencyMs > thresholds.p95LatencyMs) {
    breaches.push("latency");
  }
  if (operationalMode.mode === "unsafe_legacy_fallback") breaches.push("unsafe_legacy_fallback");
  const alerts = unique(breaches).map((failureClass) => ({
    severity:
      ["critical_validation_failure", "manager_unavailable", "missing_telemetry", "unsafe_legacy_fallback"]
        .includes(failureClass)
        ? "critical"
        : "warning",
    failureClass,
    regressionCommand: paralegalFailureRegressionLink(failureClass),
    action:
      ["critical_validation_failure", "manager_unavailable", "tool_failure", "safe_fallback", "missing_telemetry", "unsafe_legacy_fallback"]
        .includes(failureClass)
        ? "disable_paralegal_manager_and_investigate"
        : "investigate_and_add_regression",
  }));
  const zeroToleranceBreach = breaches.some((failureClass) =>
    ["critical_validation_failure", "unsafe_legacy_fallback"].includes(failureClass)
  );
  const sampleReady = managerMessageCount >= Number(thresholds.minimumLaunchSample || 0);
  const gate = !assistantMessageCount
    ? { passed: null, status: "missing_data", reason: "no_paralegal_assistant_messages_in_window" }
    : zeroToleranceBreach
      ? { passed: false, status: "threshold_breach", breaches: unique(breaches) }
      : !sampleReady
        ? { passed: null, status: "insufficient_sample", reason: "minimum_launch_sample_not_met" }
        : {
            passed: breaches.length === 0,
            status: breaches.length ? "threshold_breach" : "passed",
            breaches: unique(breaches),
          };

  return {
    contractVersion: PARALEGAL_RELIABILITY_CONTRACT_VERSION,
    role: "paralegal",
    readOnly: true,
    windowDays,
    retentionDays: PARALEGAL_SUPPORT_TELEMETRY_RETENTION_DAYS,
    assistantMessageCount,
    roleExcludedCount,
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
        sourceOfTruthBacklog: "docs/paralegal-assistant/SOURCE_OF_TRUTH_MATRIX.md",
        evaluationBacklog: "backend/ai/paralegalSupportEvalCorpus.js",
      }))
      .sort((left, right) => right.count - left.count),
    failureSamples,
    privacy: {
      rawMessageTextRead: false,
      rawToolOutputRead: false,
      customerIdentityProjected: false,
      unknownQuestionContentStored: false,
      attorneyMetricsIncluded: false,
    },
  };
}

module.exports = {
  PARALEGAL_RELIABILITY_CONTRACT_VERSION,
  PARALEGAL_RELIABILITY_THRESHOLDS,
  PARALEGAL_SUPPORT_TELEMETRY_RETENTION_DAYS,
  buildParalegalQuestionFamilySignal,
  buildSyntheticParalegalReliabilityMessages,
  classifyParalegalToolOutcome,
  getParalegalSupportOperationalMode,
  isCriticalParalegalValidationFailure,
  normalizeParalegalEvidenceState,
  normalizeParalegalQuestionForFingerprint,
  paralegalFailureRegressionLink,
  percentile,
  rate,
  summarizeParalegalReliability,
  summarizeParalegalToolCall,
};
