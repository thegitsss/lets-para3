const {
  ATTORNEY_EVAL_CORPUS_VERSION,
  PACKAGE_7_SUITE_VERSION,
  assertSanitizedLiveEvalPayload,
  buildRoutingMetrics,
  classifyLiveEvalFailure,
  evaluatePackage7Thresholds,
  exactToolRoutingResult,
  inspectSanitizedLiveEvalPayload,
  selectPackage7RoutingCases,
} = require("../ai/attorneySupportLiveEval");

describe("attorney Package 7 live-evaluation contract", () => {
  test("selects every capability plus repeated language, multi-turn, compound, and failure coverage", () => {
    const cases = selectPackage7RoutingCases();
    expect(ATTORNEY_EVAL_CORPUS_VERSION).toBe("2026-07-22.package5.v1");
    expect(PACKAGE_7_SUITE_VERSION).toMatch(/package7/);
    expect(new Set(cases.map((entry) => entry.capabilityId)).size).toBe(32);
    for (const capabilityId of new Set(cases.map((entry) => entry.capabilityId))) {
      const capabilityCases = cases.filter((entry) => entry.capabilityId === capabilityId);
      expect(capabilityCases.some((entry) => entry.languageKind === "canonical")).toBe(true);
      expect(capabilityCases.some((entry) => entry.languageKind === "paraphrase")).toBe(true);
    }
    expect(cases.some((entry) => entry.conversationKind !== "single_turn")).toBe(true);
    expect(cases.some((entry) => entry.languageKind === "compound")).toBe(true);
    expect(cases.some((entry) => /_(?:timeout|failure)$/.test(entry.failureKind))).toBe(true);
  });

  test("accepts synthetic payloads and rejects customer identities, credentials, URLs, and configured secrets", () => {
    expect(assertSanitizedLiveEvalPayload({
      email: "attorney@package7.invalid",
      prompt: "Synthetic matter status?",
    }, { env: {} })).toEqual(expect.objectContaining({ passed: true }));

    const unsafe = [
      { email: "customer@example.com" },
      { uri: "mongodb+srv://user:pass@example.invalid/database" },
      { token: "sk-proj-abcdefghijklmnopqrstuvwxyz" },
      { hook: "whsec_abcdefghijk" },
      { password: "password='customer-password'" },
    ];
    for (const payload of unsafe) {
      expect(inspectSanitizedLiveEvalPayload(payload, { env: {} }).passed).toBe(false);
    }
    expect(inspectSanitizedLiveEvalPayload({ value: "do-not-send-value" }, {
      env: { OPENAI_API_KEY: "do-not-send-value" },
    })).toEqual(expect.objectContaining({ passed: false, errors: ["configured_secret_value"] }));
  });

  test("requires exact tools without omissions, extras, or repeats", () => {
    const testCase = selectPackage7RoutingCases().find((entry) => entry.oracle.requiredTools.length === 1);
    const required = testCase.oracle.requiredTools[0];
    expect(exactToolRoutingResult(testCase, [required])).toEqual(expect.objectContaining({ passed: true }));
    expect(exactToolRoutingResult(testCase, [])).toEqual(expect.objectContaining({
      passed: false,
      errors: [`missing_required_tool:${required}`],
    }));
    expect(exactToolRoutingResult(testCase, [required, "search_lpc_knowledge"])).toEqual(expect.objectContaining({
      passed: false,
      errors: expect.arrayContaining(["unrelated_tool:search_lpc_knowledge"]),
    }));
    expect(exactToolRoutingResult(testCase, [required, required])).toEqual(expect.objectContaining({
      passed: false,
      errors: expect.arrayContaining(["repeated_tool_call"]),
    }));
  });

  test("computes per-capability and conversation-dimension routing metrics", () => {
    const metrics = buildRoutingMetrics([
      { capabilityId: "A01", languageKind: "canonical", conversationKind: "single_turn", passed: true },
      { capabilityId: "A01", languageKind: "paraphrase", conversationKind: "single_turn", passed: true },
      { capabilityId: "A02", languageKind: "compound", conversationKind: "multi_turn_pronoun", passed: false },
    ]);
    expect(metrics).toEqual(expect.objectContaining({ passed: 2, total: 3, passRate: 2 / 3 }));
    expect(metrics.robustness).toEqual(expect.objectContaining({ passed: 1, total: 1, passRate: 1 }));
    expect(metrics.multiTurn).toEqual(expect.objectContaining({ passed: 0, total: 1, passRate: 0 }));
    expect(metrics.compound).toEqual(expect.objectContaining({ passed: 0, total: 1, passRate: 0 }));
  });

  test("enforces zero critical failures and all predefined noncritical thresholds", () => {
    const passingRouting = [];
    for (let index = 0; index < 100; index += 1) {
      passingRouting.push({
        capabilityId: `A${String((index % 32) + 1).padStart(2, "0")}`,
        languageKind: index % 2 ? "paraphrase" : "canonical",
        conversationKind: index % 10 === 0 ? "multi_turn_pronoun" : "single_turn",
        critical: true,
        passed: true,
      });
    }
    const passingAnswers = Array.from({ length: 100 }, () => ({
      critical: true,
      passed: true,
      managerAvailable: true,
      concise: true,
      uiRelevant: true,
    }));
    expect(evaluatePackage7Thresholds({
      routingResults: passingRouting,
      answerResults: passingAnswers,
    })).toEqual(expect.objectContaining({ passed: true, criticalFailureCount: 0 }));

    const criticalFailure = { ...passingAnswers[0], passed: false };
    const failed = evaluatePackage7Thresholds({
      routingResults: passingRouting,
      answerResults: [criticalFailure, ...passingAnswers.slice(1)],
    });
    expect(failed.passed).toBe(false);
    expect(failed.failures).toContain("critical_zero_failure_gate");
  });

  test("classifies retained failures without silently waiving them", () => {
    expect(classifyLiveEvalFailure({ infrastructureError: true })).toBe("infrastructure");
    expect(classifyLiveEvalFailure({ errors: ["missing_required_tool:get_case_details"] })).toBe("routing");
    expect(classifyLiveEvalFailure({ errors: ["wrong_record_answer"] })).toBe("authorization_privacy");
    expect(classifyLiveEvalFailure({ errors: ["wrong_evidence_state"] })).toBe("evidence_state_handling");
    expect(classifyLiveEvalFailure({ errors: ["answer_too_long"] })).toBe("model_factuality");
  });
});
