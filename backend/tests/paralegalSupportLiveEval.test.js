const {
  PACKAGE_7_SUITE_VERSION,
  PARALEGAL_EVAL_CORPUS_VERSION,
  assertSanitizedParalegalLiveEvalPayload,
  buildSyntheticParalegalLiveEvalContext,
  buildParalegalRoutingMetrics,
  classifyParalegalLiveEvalFailure,
  evaluateParalegalPackage7Thresholds,
  exactParalegalToolRoutingResult,
  inspectSanitizedParalegalLiveEvalPayload,
  selectParalegalToolsForEvidencePlan,
  selectPackage7ParalegalRoutingCases,
} = require("../ai/paralegalSupportLiveEval");

describe("paralegal Package 7 live-evaluation contract", () => {
  test("selects all capabilities plus robustness, multi-turn, compound, and failure coverage", () => {
    const cases = selectPackage7ParalegalRoutingCases();
    expect(PARALEGAL_EVAL_CORPUS_VERSION).toBe("2026-07-23.package5.v1");
    expect(PACKAGE_7_SUITE_VERSION).toMatch(/paralegal\.package7/);
    expect(new Set(cases.map((entry) => entry.capabilityId)).size).toBe(32);
    for (const capabilityId of new Set(cases.map((entry) => entry.capabilityId))) {
      const capabilityCases = cases.filter((entry) => entry.capabilityId === capabilityId);
      expect(capabilityCases.some((entry) => entry.languageKind === "canonical")).toBe(true);
      expect(capabilityCases.some((entry) => entry.languageKind === "paraphrase")).toBe(true);
    }
    expect(cases.some((entry) => entry.conversationKind !== "single_turn")).toBe(true);
    expect(cases.some((entry) => entry.languageKind === "compound")).toBe(true);
    expect(cases.some((entry) => entry.stateKind === "unavailable")).toBe(true);
  });

  test("accepts synthetic payloads and rejects identities, credentials, URLs, and configured secrets", () => {
    expect(assertSanitizedParalegalLiveEvalPayload({
      email: "paralegal@package7.invalid",
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
      expect(inspectSanitizedParalegalLiveEvalPayload(payload, { env: {} }).passed).toBe(false);
    }
    expect(inspectSanitizedParalegalLiveEvalPayload({ value: "do-not-send-value" }, {
      env: { OPENAI_API_KEY: "do-not-send-value" },
    })).toEqual(expect.objectContaining({ passed: false, errors: ["configured_secret_value"] }));
  });

  test("requires exact tools without omissions, extras, or repeats", () => {
    const testCase = selectPackage7ParalegalRoutingCases()
      .find((entry) => entry.oracle.routing.expectedNewToolCalls.length === 1);
    const required = testCase.oracle.routing.expectedNewToolCalls[0];
    expect(exactParalegalToolRoutingResult(testCase, [required])).toEqual(
      expect.objectContaining({ passed: true })
    );
    expect(exactParalegalToolRoutingResult(testCase, [])).toEqual(expect.objectContaining({
      passed: false,
      errors: [`missing_required_tool:${required}`],
    }));
    expect(exactParalegalToolRoutingResult(testCase, [required, "search_lpc_knowledge"])).toEqual(
      expect.objectContaining({
        passed: false,
        errors: expect.arrayContaining(["unrelated_tool:search_lpc_knowledge"]),
      })
    );
    expect(exactParalegalToolRoutingResult(testCase, [required, required])).toEqual(
      expect.objectContaining({
        passed: false,
        errors: expect.arrayContaining(["repeated_tool_call"]),
      })
    );
  });

  test("grades semantic follow-ups against the structural evidence plan", () => {
    const semanticCase = {
      planningMode: "semantic_capability",
      oracle: { routing: { expectedNewToolCalls: ["get_paralegal_invitation_activity"] } },
    };
    const evidencePlan = {
      requirements: [
        { key: "workflow", anyOf: ["get_paralegal_workflow_readiness"] },
        { key: "invitations", anyOf: ["get_paralegal_invitation_activity"] },
      ],
    };
    expect(exactParalegalToolRoutingResult(semanticCase, [
      "get_paralegal_workflow_readiness",
      "get_paralegal_invitation_activity",
    ], { evidencePlan })).toEqual(expect.objectContaining({ passed: true }));
  });

  test("offers only structurally planned evidence tools and no tools at the boundary", () => {
    const available = [
      { name: "get_paralegal_case_workspace" },
      { name: "get_paralegal_case_financials" },
      { name: "search_lpc_knowledge" },
    ];
    expect(selectParalegalToolsForEvidencePlan(available, {
      requirements: [
        { key: "workspace", anyOf: ["get_paralegal_case_workspace"] },
        { key: "matter_financials", anyOf: ["get_paralegal_case_financials"] },
      ],
    }).map((tool) => tool.name)).toEqual([
      "get_paralegal_case_workspace",
      "get_paralegal_case_financials",
    ]);
    expect(selectParalegalToolsForEvidencePlan(available, { requirements: [] })).toEqual([]);
  });

  test("supplies a trusted synthetic active matter only when a planned tool requires one", () => {
    const scoped = buildSyntheticParalegalLiveEvalContext({ conversationState: {} }, [{
      name: "get_paralegal_case_workspace",
      parameters: { required: ["case_reference"] },
    }]);
    expect(scoped.pageContext.caseId).toBe("matter-package7-smith");
    expect(scoped.conversationState.activeEntity).toEqual(expect.objectContaining({
      id: "matter-package7-smith",
      source: "verified_fixture",
    }));

    const accountWide = buildSyntheticParalegalLiveEvalContext({ conversationState: {} }, [{
      name: "get_paralegal_payout_history",
      parameters: { required: [] },
    }]);
    expect(accountWide.pageContext.caseId).toBe("");
    expect(accountWide.conversationState.activeEntity).toBeUndefined();
  });

  test("computes capability, robustness, multi-turn, and compound metrics", () => {
    const metrics = buildParalegalRoutingMetrics([
      { capabilityId: "P01", languageKind: "canonical", conversationKind: "single_turn", passed: true },
      { capabilityId: "P01", languageKind: "paraphrase", conversationKind: "single_turn", passed: true },
      { capabilityId: "P02", languageKind: "compound", conversationKind: "multi_turn_follow_up", passed: false },
    ]);
    expect(metrics).toEqual(expect.objectContaining({ passed: 2, total: 3, passRate: 2 / 3 }));
    expect(metrics.robustness).toEqual(expect.objectContaining({ passed: 1, total: 1, passRate: 1 }));
    expect(metrics.multiTurn).toEqual(expect.objectContaining({ passed: 0, total: 1, passRate: 0 }));
    expect(metrics.compound).toEqual(expect.objectContaining({ passed: 0, total: 1, passRate: 0 }));
  });

  test("enforces zero critical failures and predefined thresholds", () => {
    const routingResults = Array.from({ length: 100 }, (_, index) => ({
      capabilityId: `P${String((index % 32) + 1).padStart(2, "0")}`,
      languageKind: index % 2 ? "paraphrase" : "canonical",
      conversationKind: index % 10 === 0 ? "multi_turn_follow_up" : "single_turn",
      critical: true,
      passed: true,
    }));
    const answerResults = Array.from({ length: 100 }, () => ({
      critical: true,
      passed: true,
      managerAvailable: true,
      concise: true,
      uiRelevant: true,
    }));
    expect(evaluateParalegalPackage7Thresholds({
      routingResults,
      answerResults,
    })).toEqual(expect.objectContaining({ passed: true, criticalFailureCount: 0 }));

    answerResults[0] = { ...answerResults[0], passed: false };
    const failed = evaluateParalegalPackage7Thresholds({ routingResults, answerResults });
    expect(failed.passed).toBe(false);
    expect(failed.failures).toContain("critical_zero_failure_gate");
  });

  test("classifies retained failures without silently waiving them", () => {
    expect(classifyParalegalLiveEvalFailure({ infrastructureError: true })).toBe("infrastructure");
    expect(classifyParalegalLiveEvalFailure({
      errors: ["missing_required_tool:get_paralegal_case_workspace"],
    })).toBe("routing");
    expect(classifyParalegalLiveEvalFailure({ errors: ["wrong_record_answer"] })).toBe(
      "authorization_privacy"
    );
    expect(classifyParalegalLiveEvalFailure({ errors: ["wrong_evidence_state"] })).toBe(
      "evidence_state_handling"
    );
    expect(classifyParalegalLiveEvalFailure({ errors: ["answer_too_long"] })).toBe(
      "model_factuality"
    );
  });
});
