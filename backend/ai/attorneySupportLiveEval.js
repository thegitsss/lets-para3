const {
  ATTORNEY_EVAL_CORPUS_VERSION,
  buildAttorneyEvaluationCorpus,
} = require("./attorneySupportEvalCorpus");

const PACKAGE_7_SUITE_VERSION = "2026-07-22.package7.v4";
const DEFAULT_ROUTING_REPETITIONS = 2;
const DEFAULT_ANSWER_REPETITIONS = 2;

const ROUTING_MULTI_TURN_CAPABILITIES = Object.freeze([
  "A02_matter_details",
  "A03_deadlines",
  "A07_applications",
  "A15_case_financials",
  "A17_messages",
  "A24_disputes_termination",
  "A25_withdrawal_relist",
  "A27_archive",
]);

const ROUTING_COMPOUND_CAPABILITIES = Object.freeze([
  "A04_scope_tasks",
  "A08_invitations",
  "A10_hiring",
  "A11_posting",
  "A12_funding",
  "A15_case_financials",
  "A24_disputes_termination",
  "A27_archive",
]);

const ROUTING_FAILURE_CAPABILITIES = Object.freeze([
  "A06_files",
  "A10_hiring",
  "A13_payment_method",
  "A16_receipts",
  "A27_archive",
  "A31_product_knowledge",
]);

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function selectFirst(corpus, capabilityId, predicate) {
  return corpus.find((testCase) => testCase.capabilityId === capabilityId && predicate(testCase)) || null;
}

function selectPackage7RoutingCases(corpus = buildAttorneyEvaluationCorpus()) {
  const capabilityIds = unique(corpus.map((testCase) => testCase.capabilityId));
  const selected = [];
  for (const capabilityId of capabilityIds) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      testCase.source === "generated" &&
      testCase.stateKind === "normal" &&
      testCase.languageKind === "canonical"
    ));
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      testCase.source === "generated" &&
      testCase.stateKind === "normal" &&
      testCase.languageKind === "paraphrase"
    ));
  }
  for (const capabilityId of ROUTING_MULTI_TURN_CAPABILITIES) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      ["multi_turn_pronoun", "multi_turn_correction"].includes(testCase.conversationKind)
    ));
  }
  for (const capabilityId of ROUTING_COMPOUND_CAPABILITIES) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) => testCase.languageKind === "compound"));
  }
  for (const capabilityId of ROUTING_FAILURE_CAPABILITIES) {
    selected.push(selectFirst(corpus, capabilityId, (testCase) =>
      /_(?:timeout|failure)$/.test(String(testCase.failureKind || ""))
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

function inspectSanitizedLiveEvalPayload(payload, { env = process.env } = {}) {
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
  return { passed: errors.length === 0, errors: unique(errors), byteLength: Buffer.byteLength(text) };
}

function assertSanitizedLiveEvalPayload(payload, options = {}) {
  const inspection = inspectSanitizedLiveEvalPayload(payload, options);
  if (!inspection.passed) {
    const error = new Error(`Package 7 sanitization preflight failed: ${inspection.errors.join(", ")}`);
    error.code = "PACKAGE_7_UNSAFE_EVAL_PAYLOAD";
    error.sanitizationErrors = inspection.errors;
    throw error;
  }
  return inspection;
}

function exactToolRoutingResult(testCase = {}, calledTools = []) {
  const required = unique(testCase.oracle?.requiredTools || []);
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

function buildRoutingMetrics(results = []) {
  const passes = results.filter((result) => result.passed).length;
  const grouped = new Map();
  for (const result of results) {
    const current = grouped.get(result.capabilityId) || [];
    current.push(result);
    grouped.set(result.capabilityId, current);
  }
  const perCapability = [...grouped.entries()].map(([capabilityId, entries]) => ({
    capabilityId,
    passed: entries.filter((entry) => entry.passed).length,
    total: entries.length,
    passRate: rate(entries.filter((entry) => entry.passed).length, entries.length),
  }));
  const robustness = results.filter((result) =>
    ["paraphrase", "typo", "shorthand", "short_incomplete"].includes(result.languageKind)
  );
  const multiTurn = results.filter((result) => result.conversationKind !== "single_turn");
  const compound = results.filter((result) => result.languageKind === "compound");
  return {
    passed: passes,
    total: results.length,
    passRate: rate(passes, results.length),
    perCapability,
    robustness: {
      passed: robustness.filter((entry) => entry.passed).length,
      total: robustness.length,
      passRate: rate(robustness.filter((entry) => entry.passed).length, robustness.length),
    },
    multiTurn: {
      passed: multiTurn.filter((entry) => entry.passed).length,
      total: multiTurn.length,
      passRate: rate(multiTurn.filter((entry) => entry.passed).length, multiTurn.length),
    },
    compound: {
      passed: compound.filter((entry) => entry.passed).length,
      total: compound.length,
      passRate: rate(compound.filter((entry) => entry.passed).length, compound.length),
    },
  };
}

function classifyLiveEvalFailure(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.infrastructureError) return "infrastructure";
  if (errors.some((error) => /unauthorized|ownership|wrong_record|sensitive/i.test(error))) return "authorization_privacy";
  if (errors.some((error) => /policy|workflow/i.test(error))) return "policy_conflict";
  if (errors.some((error) => /evidence_state|unavailable|absence/i.test(error))) return "evidence_state_handling";
  if (errors.some((error) => /entity|reference|correction/i.test(error))) return "conversation_resolution";
  if (errors.some((error) => /answer|claim|amount|fact/i.test(error))) return "model_factuality";
  if (errors.some((error) => /suggestion|navigation|action|concise|sentence/i.test(error))) return "response_ui_concision";
  if (errors.some((error) => /tool/i.test(error))) return "routing";
  return "semantic_validation";
}

function evaluatePackage7Thresholds({ routingResults = [], answerResults = [] } = {}) {
  const routing = buildRoutingMetrics(routingResults);
  const answerPassed = answerResults.filter((result) => result.passed).length;
  const criticalFailures = [...routingResults, ...answerResults].filter(
    (result) => result.critical === true && result.passed !== true
  );
  const managerAvailable = answerResults.filter((result) => result.managerAvailable === true).length;
  const conciseEligible = answerResults.filter((result) => result.measureConcision !== false);
  const concisePassed = conciseEligible.filter((result) => result.concise === true).length;
  const uiEligible = answerResults.filter((result) => result.measureUi !== false);
  const uiPassed = uiEligible.filter((result) => result.uiRelevant === true).length;
  const failures = [];
  if (criticalFailures.length) failures.push("critical_zero_failure_gate");
  if (routing.passRate < 0.98) failures.push("routing_overall_below_98_percent");
  if (routing.perCapability.some((entry) => entry.passRate < 0.95)) failures.push("routing_capability_below_95_percent");
  if (routing.robustness.total && routing.robustness.passRate < 0.95) failures.push("routing_robustness_below_95_percent");
  if (routing.multiTurn.total && routing.multiTurn.passRate < 0.98) failures.push("routing_multiturn_below_98_percent");
  if (routing.compound.total && routing.compound.passRate < 0.98) failures.push("routing_compound_below_98_percent");
  if (rate(answerPassed, answerResults.length) < 0.98) failures.push("answer_success_below_98_percent");
  if (rate(managerAvailable, answerResults.length) < 0.99) failures.push("manager_availability_below_99_percent");
  if (conciseEligible.length && rate(concisePassed, conciseEligible.length) < 0.95) failures.push("concision_below_95_percent");
  if (uiEligible.length && rate(uiPassed, uiEligible.length) < 0.95) failures.push("ui_relevance_below_95_percent");
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
      concisionPassRate: rate(concisePassed, conciseEligible.length),
      uiRelevancePassRate: rate(uiPassed, uiEligible.length),
    },
  };
}

module.exports = {
  ATTORNEY_EVAL_CORPUS_VERSION,
  DEFAULT_ANSWER_REPETITIONS,
  DEFAULT_ROUTING_REPETITIONS,
  PACKAGE_7_SUITE_VERSION,
  assertSanitizedLiveEvalPayload,
  buildRoutingMetrics,
  classifyLiveEvalFailure,
  evaluatePackage7Thresholds,
  exactToolRoutingResult,
  inspectSanitizedLiveEvalPayload,
  selectPackage7RoutingCases,
};
