const {
  PARALEGAL_EVAL_CORPUS_VERSION,
  buildParalegalEvaluationCorpus,
} = require("./paralegalSupportEvalCorpus");

const PACKAGE_7_SUITE_VERSION = "2026-07-23.paralegal.package7.v1";
const DEFAULT_ROUTING_REPETITIONS = 2;
const DEFAULT_ANSWER_REPETITIONS = 2;

const ROUTING_MULTI_TURN_CAPABILITIES = Object.freeze([
  "P02_matter_details",
  "P03_deadlines",
  "P06_applications",
  "P08_invitations",
  "P13_message_activity",
  "P17_matter_financials",
  "P20_withdrawal_outcome",
  "P21_completion_release",
]);

const ROUTING_COMPOUND_CAPABILITIES = Object.freeze([
  "P04_scope_tasks",
  "P09_pre_engagement",
  "P15_payout_timing",
  "P17_matter_financials",
  "P19_withdrawal_eligibility",
  "P20_withdrawal_outcome",
  "P21_completion_release",
  "P29_archive_history",
]);

const ROUTING_FAILURE_CAPABILITIES = Object.freeze([
  "P05_files_deliverables",
  "P10_assignment_start",
  "P14_payout_setup",
  "P16_payout_history",
  "P29_archive_history",
  "P31_product_knowledge",
]);

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function selectFirst(corpus, capabilityId, predicate) {
  return corpus.find((testCase) => testCase.capabilityId === capabilityId && predicate(testCase)) || null;
}

function selectPackage7ParalegalRoutingCases(corpus = buildParalegalEvaluationCorpus()) {
  const capabilityIds = unique(corpus.map((testCase) => testCase.capabilityId));
  const selected = [];
  for (const capabilityId of capabilityIds) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      testCase.source === "generated" &&
      testCase.stateKind === "positive" &&
      testCase.languageKind === "canonical"
    ));
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      testCase.source === "generated" &&
      testCase.stateKind === "positive" &&
      testCase.languageKind === "paraphrase"
    ));
  }
  for (const capabilityId of ROUTING_MULTI_TURN_CAPABILITIES) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      testCase.conversationKind === "multi_turn_follow_up"
    ));
  }
  for (const capabilityId of ROUTING_COMPOUND_CAPABILITIES) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) => testCase.languageKind === "compound"));
  }
  for (const capabilityId of ROUTING_FAILURE_CAPABILITIES) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      testCase.stateKind === "unavailable"
    ));
  }
  return unique(selected.filter(Boolean).map((testCase) => testCase.id))
    .map((id) => corpus.find((testCase) => testCase.id === id));
}

function findUnsafeEmail(text = "") {
  const emails = String(text || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return emails.find((email) => !/\.(?:invalid|test)$/i.test(email)) || "";
}

function configuredSecretValues(env = process.env) {
  return unique([
    env.OPENAI_API_KEY,
    env.MONGO_URI,
    env.STRIPE_SECRET_KEY,
    env.STRIPE_WEBHOOK_SECRET,
    env.JWT_SECRET,
    env.DATA_ENCRYPTION_KEY,
  ].map((value) => String(value || "").trim()).filter((value) => value.length >= 8));
}

function inspectSanitizedParalegalLiveEvalPayload(payload, { env = process.env } = {}) {
  const text = JSON.stringify(payload);
  const errors = [];
  const unsafeEmail = findUnsafeEmail(text);
  if (unsafeEmail) errors.push("non_synthetic_email");
  if (/mongodb(?:\+srv)?:\/\//i.test(text)) errors.push("database_connection_string");
  if (/\bsk-(?:proj-)?[a-z0-9_-]{12,}\b/i.test(text)) errors.push("api_key_pattern");
  if (/\bwhsec_[a-z0-9_-]{8,}\b/i.test(text)) errors.push("webhook_secret_pattern");
  if (/\b(?:password|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*["'][^"']{4,}/i.test(text)) {
    errors.push("credential_assignment");
  }
  for (const secret of configuredSecretValues(env)) {
    if (text.includes(secret)) {
      errors.push("configured_secret_value");
      break;
    }
  }
  return {
    passed: errors.length === 0,
    errors: unique(errors),
    byteLength: Buffer.byteLength(text),
  };
}

function assertSanitizedParalegalLiveEvalPayload(payload, options = {}) {
  const inspection = inspectSanitizedParalegalLiveEvalPayload(payload, options);
  if (!inspection.passed) {
    const error = new Error(`Paralegal Package 7 sanitization preflight failed: ${inspection.errors.join(", ")}`);
    error.code = "PARALEGAL_PACKAGE_7_UNSAFE_EVAL_PAYLOAD";
    error.sanitizationErrors = inspection.errors;
    throw error;
  }
  return inspection;
}

function expectedToolsFor(testCase = {}, { evidencePlan = null } = {}) {
  if (testCase.planningMode === "semantic_capability" && evidencePlan) {
    return unique(
      (evidencePlan.requirements || []).flatMap((requirement) => requirement.anyOf || [])
    );
  }
  return unique(testCase.oracle?.routing?.expectedNewToolCalls || testCase.oracle?.routing?.requiredTools || []);
}

function selectParalegalToolsForEvidencePlan(availableTools = [], evidencePlan = {}) {
  const plannedNames = new Set(
    (evidencePlan.requirements || []).flatMap((requirement) => requirement.anyOf || [])
  );
  return (Array.isArray(availableTools) ? availableTools : [])
    .filter((tool) => plannedNames.has(tool?.name));
}

function buildSyntheticParalegalLiveEvalContext(testCase = {}, plannedTools = []) {
  const suppliedState =
    testCase.conversationState && typeof testCase.conversationState === "object"
      ? testCase.conversationState
      : {};
  const requiresMatterReference = plannedTools.some((tool) =>
    Array.isArray(tool?.parameters?.required) &&
    tool.parameters.required.includes("case_reference")
  );
  if (!requiresMatterReference || suppliedState.activeEntity?.id) {
    return {
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(suppliedState.activeEntity?.matterId || suppliedState.activeEntity?.id || ""),
      },
      conversationState: suppliedState,
    };
  }
  const activeEntity = {
    id: "matter-package7-smith",
    matterId: "matter-package7-smith",
    type: "matter",
    name: "Smith matter",
    source: "verified_fixture",
  };
  return {
    pageContext: {
      pathname: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
      caseId: activeEntity.id,
    },
    conversationState: {
      ...suppliedState,
      activeEntity,
      verifiedEntities: [activeEntity, ...(suppliedState.verifiedEntities || [])],
    },
  };
}

function exactParalegalToolRoutingResult(testCase = {}, calledTools = [], options = {}) {
  const required = expectedToolsFor(testCase, options);
  const called = unique(calledTools);
  const missing = required.filter((tool) => !called.includes(tool));
  const unrelated = called.filter((tool) => !required.includes(tool));
  const repeated = calledTools.length !== called.length;
  return {
    passed: missing.length === 0 && unrelated.length === 0 && !repeated,
    required,
    called,
    errors: [
      ...missing.map((tool) => `missing_required_tool:${tool}`),
      ...unrelated.map((tool) => `unrelated_tool:${tool}`),
      ...(repeated ? ["repeated_tool_call"] : []),
    ],
  };
}

function rate(passed = 0, total = 0) {
  return total > 0 ? passed / total : 0;
}

function buildParalegalRoutingMetrics(results = []) {
  const passed = results.filter((result) => result.passed).length;
  const grouped = new Map();
  for (const result of results) {
    const entries = grouped.get(result.capabilityId) || [];
    entries.push(result);
    grouped.set(result.capabilityId, entries);
  }
  const perCapability = [...grouped.entries()].map(([capabilityId, entries]) => ({
    capabilityId,
    passed: entries.filter((entry) => entry.passed).length,
    total: entries.length,
    passRate: rate(entries.filter((entry) => entry.passed).length, entries.length),
  }));
  const robustness = results.filter((result) =>
    ["paraphrase", "typo", "shorthand"].includes(result.languageKind)
  );
  const multiTurn = results.filter((result) => result.conversationKind !== "single_turn");
  const compound = results.filter((result) => result.languageKind === "compound");
  const metric = (entries) => ({
    passed: entries.filter((entry) => entry.passed).length,
    total: entries.length,
    passRate: rate(entries.filter((entry) => entry.passed).length, entries.length),
  });
  return {
    passed,
    total: results.length,
    passRate: rate(passed, results.length),
    perCapability,
    robustness: metric(robustness),
    multiTurn: metric(multiTurn),
    compound: metric(compound),
  };
}

function classifyParalegalLiveEvalFailure(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.infrastructureError) return "infrastructure";
  if (errors.some((error) => /unauthorized|ownership|wrong_record|sensitive|privacy/i.test(error))) {
    return "authorization_privacy";
  }
  if (errors.some((error) => /policy|workflow/i.test(error))) return "policy_conflict";
  if (errors.some((error) => /evidence_state|unavailable|absence/i.test(error))) {
    return "evidence_state_handling";
  }
  if (errors.some((error) => /entity|reference|correction/i.test(error))) return "conversation_resolution";
  if (errors.some((error) => /tool/i.test(error))) return "routing";
  if (errors.some((error) => /answer|claim|amount|fact|status/i.test(error))) return "model_factuality";
  if (errors.some((error) => /suggestion|navigation|action|concise|sentence|(?:^|_)ui(?:_|$)/i.test(error))) {
    return "response_ui_concision";
  }
  return "semantic_validation";
}

function evaluateParalegalPackage7Thresholds({ routingResults = [], answerResults = [] } = {}) {
  const routing = buildParalegalRoutingMetrics(routingResults);
  const answerPassed = answerResults.filter((result) => result.passed).length;
  const criticalFailures = [...routingResults, ...answerResults].filter(
    (result) => result.critical === true && result.passed !== true
  );
  const managerAvailable = answerResults.filter((result) => result.managerAvailable === true).length;
  const concise = answerResults.filter((result) => result.concise === true).length;
  const uiRelevant = answerResults.filter((result) => result.uiRelevant === true).length;
  const failures = [];
  if (criticalFailures.length) failures.push("critical_zero_failure_gate");
  if (routingResults.length && routing.passRate < 0.98) failures.push("routing_overall_below_98_percent");
  if (routing.perCapability.some((entry) => entry.passRate < 0.95)) {
    failures.push("routing_capability_below_95_percent");
  }
  if (routing.robustness.total && routing.robustness.passRate < 0.95) {
    failures.push("routing_robustness_below_95_percent");
  }
  if (routing.multiTurn.total && routing.multiTurn.passRate < 0.98) {
    failures.push("routing_multiturn_below_98_percent");
  }
  if (routing.compound.total && routing.compound.passRate < 0.98) {
    failures.push("routing_compound_below_98_percent");
  }
  if (answerResults.length && rate(answerPassed, answerResults.length) < 0.98) {
    failures.push("answer_success_below_98_percent");
  }
  if (answerResults.length && rate(managerAvailable, answerResults.length) < 0.99) {
    failures.push("manager_availability_below_99_percent");
  }
  if (answerResults.length && rate(concise, answerResults.length) < 0.95) {
    failures.push("concision_below_95_percent");
  }
  if (answerResults.length && rate(uiRelevant, answerResults.length) < 0.95) {
    failures.push("ui_relevance_below_95_percent");
  }
  return {
    passed: failures.length === 0,
    failures,
    criticalFailureCount: criticalFailures.length,
    routing,
    answers: {
      passed: answerPassed,
      total: answerResults.length,
      passRate: rate(answerPassed, answerResults.length),
      managerAvailabilityRate: rate(managerAvailable, answerResults.length),
      concisionPassRate: rate(concise, answerResults.length),
      uiRelevancePassRate: rate(uiRelevant, answerResults.length),
    },
  };
}

module.exports = {
  DEFAULT_ANSWER_REPETITIONS,
  DEFAULT_ROUTING_REPETITIONS,
  PACKAGE_7_SUITE_VERSION,
  PARALEGAL_EVAL_CORPUS_VERSION,
  assertSanitizedParalegalLiveEvalPayload,
  buildParalegalRoutingMetrics,
  classifyParalegalLiveEvalFailure,
  evaluateParalegalPackage7Thresholds,
  exactParalegalToolRoutingResult,
  expectedToolsFor,
  inspectSanitizedParalegalLiveEvalPayload,
  buildSyntheticParalegalLiveEvalContext,
  selectParalegalToolsForEvidencePlan,
  selectPackage7ParalegalRoutingCases,
};
