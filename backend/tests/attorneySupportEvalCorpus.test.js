process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_attorney_eval_corpus";

const {
  ATTORNEY_EVAL_CORPUS_VERSION,
  EXTERNAL_DEPENDENCIES,
  buildAttorneyEvaluationCorpus,
  buildAttorneyEvaluationCoverageReport,
  buildPassingAttorneyEvalResult,
  buildProductionRegressionCases,
  evaluateAttorneyEvalResult,
  evaluateAttorneyRoutingPlan,
  inferUniversalAnswerClaims,
  validateAttorneyEvaluationCorpus,
} = require("../ai/attorneySupportEvalCorpus");
const {
  ATTORNEY_ENTITY_CAPABILITY_IDS,
  getAttorneySupportCapabilities,
} = require("../ai/attorneySupportCapabilities");
const { getAttorneyProductionDefects } = require("../ai/attorneySupportProductionDefects");
const { buildAttorneyEvidencePlan } = require("../ai/attorneyConversationPolicy");

describe("attorney Package 5 evaluation corpus", () => {
  const capabilities = getAttorneySupportCapabilities();
  const corpus = buildAttorneyEvaluationCorpus();

  test("is versioned, structurally valid, unique, and covers all 32 capabilities", () => {
    expect(ATTORNEY_EVAL_CORPUS_VERSION).toMatch(/^2026-07-22\.package5\.v\d+$/);
    expect(capabilities).toHaveLength(32);
    expect(corpus.length).toBeGreaterThan(450);
    expect(new Set(corpus.map((testCase) => testCase.id)).size).toBe(corpus.length);
    expect(new Set(corpus.map((testCase) => testCase.capabilityId)).size).toBe(32);
    expect(validateAttorneyEvaluationCorpus(corpus)).toEqual({ passed: true, errors: [] });
  });

  test("gives every capability canonical, paraphrase, typo, shorthand, and short/incomplete language", () => {
    for (const capability of capabilities) {
      const kinds = new Set(corpus
        .filter((testCase) => testCase.capabilityId === capability.id)
        .map((testCase) => testCase.languageKind));
      for (const required of ["canonical", "paraphrase", "typo", "shorthand", "short_incomplete"]) {
        expect(kinds.has(required)).toBe(true);
      }
      expect(corpus.filter((testCase) =>
        testCase.capabilityId === capability.id && testCase.languageKind === "canonical"
      ).length).toBeGreaterThanOrEqual(3);
      expect(corpus.filter((testCase) =>
        testCase.capabilityId === capability.id && testCase.languageKind === "paraphrase"
      ).length).toBeGreaterThanOrEqual(3);
    }
  });

  test("includes negative and compound prompts for every applicable capability", () => {
    for (const capability of capabilities.filter((entry) => !entry.boundary)) {
      const cases = corpus.filter((testCase) => testCase.capabilityId === capability.id);
      expect(cases.some((testCase) => testCase.languageKind === "negative_question")).toBe(true);
      expect(cases.some((testCase) => testCase.languageKind === "compound")).toBe(true);
    }
  });

  test("gives every entity-bearing capability vague, pronoun, correction, and subject-change turns", () => {
    for (const capabilityId of ATTORNEY_ENTITY_CAPABILITY_IDS) {
      const kinds = new Set(corpus
        .filter((testCase) => testCase.capabilityId === capabilityId)
        .map((testCase) => testCase.conversationKind));
      for (const expected of [
        "multi_turn_vague_reference",
        "multi_turn_pronoun",
        "multi_turn_correction",
        "multi_turn_subject_change",
      ]) {
        expect(kinds.has(expected)).toBe(true);
      }
    }
  });

  test("gives every capability normal, empty, and exceptional/conflicting states", () => {
    for (const capability of capabilities) {
      const states = new Set(corpus
        .filter((testCase) => testCase.capabilityId === capability.id)
        .map((testCase) => testCase.stateKind));
      expect(states.has("normal")).toBe(true);
      expect(states.has("empty")).toBe(true);
      expect(states.has("exceptional_conflicting")).toBe(true);
    }
  });

  test("covers success, absence, timeout, and failure for every external dependency", () => {
    for (const [capabilityId, dependencies] of Object.entries(EXTERNAL_DEPENDENCIES)) {
      const cases = corpus.filter((testCase) => testCase.capabilityId === capabilityId);
      for (const dependency of dependencies) {
        for (const state of ["success", "absence", "timeout", "failure"]) {
          expect(cases.some((testCase) => testCase.failureKind === `${dependency}_${state}`)).toBe(true);
        }
      }
    }
  });

  test("includes an inaccessible-record case for every authorization-sensitive capability", () => {
    const exempt = new Set(["A31_product_knowledge", "A32_boundary"]);
    for (const capability of capabilities.filter((entry) => !exempt.has(entry.id))) {
      const inaccessible = corpus.find((testCase) =>
        testCase.capabilityId === capability.id && testCase.failureKind === "unauthorized_record"
      );
      expect(inaccessible).toBeTruthy();
      expect(inaccessible.oracle.expectedEvidenceState).toBe("unauthorized");
      expect(inaccessible.oracle.forbiddenClaims).toEqual(expect.arrayContaining([
        "other_user_fact",
        "sensitive_field",
      ]));
    }
  });

  test("every case declares exact required tools and a complete final-answer/UI oracle", () => {
    for (const testCase of corpus) {
      const oracle = testCase.oracle;
      expect(Array.isArray(oracle.requiredTools)).toBe(true);
      expect(Array.isArray(oracle.forbiddenTools)).toBe(true);
      expect(Array.isArray(oracle.requiredClaims)).toBe(true);
      expect(oracle.requiredClaims.length).toBeGreaterThan(0);
      expect(Array.isArray(oracle.forbiddenClaims)).toBe(true);
      expect(oracle.clarification).toEqual(expect.objectContaining({
        permitted: expect.any(Boolean),
        min: expect.any(Number),
        max: expect.any(Number),
      }));
      expect(Array.isArray(oracle.allowedNavigation)).toBe(true);
      expect(Array.isArray(oracle.allowedActions)).toBe(true);
      expect(oracle.maxPrimaryActions).toBe(1);
      expect(oracle.detail).toEqual(expect.objectContaining({
        expected: expect.any(String),
        maxSentences: expect.any(Number),
        directAnswerFirst: true,
      }));
      expect(oracle.inspectFinalAnswer).toBe(true);
      expect(oracle.riskLabels.length).toBeGreaterThan(0);
    }
  });

  test("all generated deterministic routing evaluations select exactly the declared evidence", () => {
    const failures = corpus.flatMap((testCase) => {
      if (testCase.planningMode === "semantic_capability") return [];
      const plan = buildAttorneyEvidencePlan({
        messageText: testCase.prompt,
        conversationHistory: testCase.history,
        conversationState: testCase.conversationState,
      });
      const evaluation = evaluateAttorneyRoutingPlan(testCase, plan);
      return evaluation.passed ? [] : [{ id: testCase.id, ...evaluation }];
    });
    expect(failures).toEqual([]);
  });

  test("all deterministic passing final-answer fixtures satisfy every case oracle", () => {
    const failures = corpus.flatMap((testCase) => {
      const evaluation = evaluateAttorneyEvalResult(testCase, buildPassingAttorneyEvalResult(testCase));
      return evaluation.passed ? [] : [{ id: testCase.id, errors: evaluation.errors }];
    });
    expect(failures).toEqual([]);
  });

  test("the final-answer oracle rejects missing tools, claims, bad states, clarification, UI, and presentation", () => {
    const testCase = corpus.find((entry) => entry.capabilityId === "A13_payment_method" && entry.stateKind === "normal");
    const passing = buildPassingAttorneyEvalResult(testCase);
    const firstTool = testCase.oracle.requiredTools[0];
    const firstClaim = testCase.oracle.requiredClaims[0];
    const mutations = [
      [{ ...passing, toolCalls: [] }, `missing_required_tool:${firstTool}`],
      [{ ...passing, claims: [] }, `missing_required_claim:${firstClaim}`],
      [{ ...passing, claims: [...passing.claims, "manual_review_sent"] }, "forbidden_claim:manual_review_sent"],
      [{ ...passing, evidenceState: "verified" === passing.evidenceState ? "absent" : "verified" }, "wrong_evidence_state"],
      [{ ...passing, clarifications: 2 }, "clarification_count_out_of_range"],
      [{ ...passing, actions: [{ key: "open_admin", authorized: false }] }, "unauthorized_action:open_admin"],
      [{ ...passing, navigation: { key: "admin_finance", authorized: false } }, "unauthorized_navigation:admin_finance"],
      [{ ...passing, suggestions: ["Billing", "Billing"] }, "duplicate_suggestions"],
      [{ ...passing, directAnswerFirst: false }, "direct_answer_not_first"],
      [{ ...passing, sentenceCount: 20 }, "answer_too_long"],
      [{ ...passing, finalAnswer: "" }, "final_answer_missing"],
      [{ ...passing, authorizationProtected: false }, "authorization_not_protected"],
    ];
    for (const [actual, expectedError] of mutations) {
      expect(evaluateAttorneyEvalResult(testCase, actual)).toEqual(expect.objectContaining({
        passed: false,
        errors: expect.arrayContaining([expectedError]),
      }));
    }
  });

  test("inspects raw final-answer text for phantom escalation, false actions, legal work, and internal tools", () => {
    expect(inferUniversalAnswerClaims(
      "I approved it and am sending this to the team. The get_attorney_case_workspace tool confirms it."
    )).toEqual(expect.arrayContaining([
      "mutation_completed",
      "manual_review_sent",
      "team_escalation_claim",
      "raw_tool_output",
    ]));
    expect(inferUniversalAnswerClaims("Here is a draft motion for your case.")).toContain("legal_advice");

    const testCase = corpus.find((entry) => entry.capabilityId === "A01_matter_overview" && entry.stateKind === "normal");
    const actual = {
      ...buildPassingAttorneyEvalResult(testCase),
      finalAnswer: "I’m sending this to the team for manual review.",
    };
    expect(evaluateAttorneyEvalResult(testCase, actual)).toEqual(expect.objectContaining({
      passed: false,
      errors: expect.arrayContaining([
        "forbidden_claim:manual_review_sent",
        "forbidden_claim:team_escalation_claim",
      ]),
    }));
  });

  test("labels financial, policy, privacy, ownership, and boundary cases as critical", () => {
    const requiredLabels = new Set([
      "financial",
      "workflow_policy",
      "privacy_authorization",
      "ownership",
      "read_only_legal_boundary",
    ]);
    const seen = new Set(corpus.flatMap((testCase) => testCase.oracle.riskLabels));
    for (const label of requiredLabels) expect(seen.has(label)).toBe(true);
    expect(corpus.filter((testCase) => testCase.oracle.critical).every((testCase) =>
      evaluateAttorneyEvalResult(testCase, buildPassingAttorneyEvalResult(testCase)).passed
    )).toBe(true);
  });

  test("automatically converts every registered production defect into a permanent named regression", () => {
    const defects = getAttorneyProductionDefects();
    const regressions = buildProductionRegressionCases(defects);
    expect(regressions).toHaveLength(defects.length);
    expect(regressions.map((testCase) => testCase.id)).toEqual(
      defects.map((defect) => `regression.${defect.id}`)
    );
    expect(regressions.every((testCase) => testCase.source === "production_defect" && testCase.permanent)).toBe(true);

    const synthetic = {
      id: "PD999_synthetic_registration_test",
      capabilityId: "A01_matter_overview",
      prompt: "Synthetic reported defect",
      requiredEvidence: ["case_overview"],
      requiredTools: ["get_my_case_overview"],
      requiredClaims: ["matter_overview"],
      forbiddenClaims: ["manual_review_sent"],
      riskLabels: ["privacy_authorization"],
    };
    expect(buildProductionRegressionCases([...defects, synthetic]).at(-1)).toEqual(
      expect.objectContaining({
        id: "regression.PD999_synthetic_registration_test",
        permanent: true,
        source: "production_defect",
      })
    );
  });

  test("coverage report lists capability, state, language, multi-turn, failure, and assertion coverage", () => {
    const report = buildAttorneyEvaluationCoverageReport(corpus);
    expect(report).toEqual(expect.objectContaining({
      passed: true,
      capabilityCount: 32,
      readyCapabilityCount: 23,
      caseCount: corpus.length,
      productionRegressionCount: 9,
      criticalCaseCount: expect.any(Number),
      multiTurnCaseCount: expect.any(Number),
      failureCaseCount: expect.any(Number),
    }));
    expect(report.capabilityCoverage).toHaveLength(32);
    for (const item of report.capabilityCoverage) {
      expect(item.languageCoverage.length).toBeGreaterThanOrEqual(5);
      expect(item.stateCoverage).toEqual(expect.arrayContaining(["normal", "empty", "exceptional_conflicting"]));
      expect(item.assertionCoverage).toEqual(expect.arrayContaining([
        "required_claims",
        "forbidden_claims",
        "evidence_state",
        "clarification",
        "navigation",
        "actions",
        "concision",
        "final_answer",
      ]));
    }
  });
});
