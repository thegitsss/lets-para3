const {
  PARALEGAL_EVAL_CORPUS_VERSION,
  buildParalegalEvaluationCorpus,
  buildParalegalEvaluationCoverageReport,
  buildPassingParalegalEvalResult,
  buildProductionRegressionCases,
  evaluateParalegalEvalResult,
  evaluateParalegalRoutingPlan,
  inferParalegalUniversalClaims,
  validateParalegalEvaluationCorpus,
} = require("../ai/paralegalSupportEvalCorpus");
const {
  buildParalegalEvidencePlan,
} = require("../ai/paralegalConversationPolicy");
const {
  getParalegalSupportCapabilities,
} = require("../ai/paralegalSupportCapabilities");
const {
  getParalegalProductionDefects,
} = require("../ai/paralegalSupportProductionDefects");

describe("paralegal Package 5 generated evaluation corpus", () => {
  const capabilities = getParalegalSupportCapabilities();
  const corpus = buildParalegalEvaluationCorpus();

  test("is versioned, unique, structurally valid, and covers all P01-P32 families", () => {
    expect(PARALEGAL_EVAL_CORPUS_VERSION).toMatch(/^2026-07-23\.package5\.v\d+$/);
    expect(capabilities).toHaveLength(32);
    expect(corpus.length).toBeGreaterThan(500);
    expect(new Set(corpus.map((testCase) => testCase.id)).size).toBe(corpus.length);
    expect(new Set(corpus.map((testCase) => testCase.capabilityId)).size).toBe(32);
    expect(validateParalegalEvaluationCorpus(corpus)).toEqual({ passed: true, errors: [] });
  });

  test("covers every required Package 5 dimension for every capability", () => {
    const required = [
      "positive",
      "absent",
      "unavailable",
      "unauthorized",
      "ambiguous",
      "adversarial",
      "paraphrase",
      "typo",
      "follow_up",
      "compound",
      "repeated_question",
    ];
    for (const capability of capabilities) {
      const dimensions = new Set(
        corpus
          .filter((testCase) => testCase.capabilityId === capability.id)
          .map((testCase) => testCase.dimension)
      );
      required.forEach((dimension) => expect(dimensions.has(dimension)).toBe(true));
    }
  });

  test("gives each capability multiple natural positives and paraphrases plus typo and shorthand cases", () => {
    for (const capability of capabilities) {
      const cases = corpus.filter((testCase) => testCase.capabilityId === capability.id);
      expect(cases.filter((testCase) => testCase.dimension === "positive").length)
        .toBeGreaterThanOrEqual(3);
      expect(cases.filter((testCase) => testCase.dimension === "paraphrase").length)
        .toBeGreaterThanOrEqual(3);
      expect(cases.some((testCase) => testCase.dimension === "typo")).toBe(true);
      expect(cases.some((testCase) => testCase.languageKind === "shorthand")).toBe(true);
    }
  });

  test("declares complete routing, evidence, answer, privacy, and UI expectations", () => {
    for (const testCase of corpus) {
      const oracle = testCase.oracle;
      expect(oracle.routing).toEqual(expect.objectContaining({
        requiredEvidence: expect.any(Array),
        requiredTools: expect.any(Array),
        expectedNewToolCalls: expect.any(Array),
        forbiddenTools: expect.any(Array),
      }));
      expect(oracle.evidence).toEqual(expect.objectContaining({
        expectedState: expect.any(String),
        authorizationRequired: expect.any(Boolean),
      }));
      expect(oracle.answer).toEqual(expect.objectContaining({
        requiredClaims: expect.any(Array),
        forbiddenClaims: expect.any(Array),
        answerOrder: expect.any(Array),
        maxSentences: expect.any(Number),
        directAnswerFirst: true,
      }));
      expect(oracle.answer.requiredClaims.length).toBeGreaterThan(0);
      expect(oracle.privacy.forbiddenDataClasses).toEqual(expect.arrayContaining([
        "attorney_billing",
        "other_paralegal_records",
        "internal_admin_notes",
        "raw_processor_objects",
        "secrets",
      ]));
      expect(oracle.ui).toEqual(expect.objectContaining({
        maxPrimaryActions: 1,
        maxSuggestions: 1,
        duplicateInlineButtonLinkAllowed: false,
        manualReviewCardAllowed: false,
      }));
      expect(oracle.riskLabels.length).toBeGreaterThan(0);
      expect(oracle.critical).toBe(true);
    }
  });

  test("all deterministic evidence plans and repeated-question reuse cases meet their exact routing oracle", () => {
    const failures = corpus.flatMap((testCase) => {
      const plan = buildParalegalEvidencePlan({
        messageText: testCase.prompt,
        conversationHistory: testCase.history,
        conversationState: testCase.conversationState,
      });
      const result = evaluateParalegalRoutingPlan(testCase, plan);
      return result.passed ? [] : [{ id: testCase.id, errors: result.errors }];
    });
    expect(failures).toEqual([]);
  });

  test("all generated passing answer fixtures satisfy the complete oracle with zero critical failures", () => {
    const failures = corpus.flatMap((testCase) => {
      const result = evaluateParalegalEvalResult(
        testCase,
        buildPassingParalegalEvalResult(testCase)
      );
      return result.passed && result.criticalPassed
        ? []
        : [{ id: testCase.id, errors: result.errors }];
    });
    expect(failures).toEqual([]);
  });

  test("the answer oracle rejects routing, evidence, claim, privacy, UI, and presentation failures", () => {
    const testCase = corpus.find((item) =>
      item.capabilityId === "P17_matter_financials" &&
      item.dimension === "positive"
    );
    const passing = buildPassingParalegalEvalResult(testCase);
    const requiredTool = testCase.oracle.routing.expectedNewToolCalls[0];
    const requiredClaim = testCase.oracle.answer.requiredClaims[0];
    const mutations = [
      [{ ...passing, toolCalls: [] }, `missing_required_tool:${requiredTool}`],
      [{ ...passing, toolCalls: [...passing.toolCalls, "get_paralegal_account_snapshot"] }, "forbidden_tool:get_paralegal_account_snapshot"],
      [{ ...passing, toolCalls: [...passing.toolCalls, ...passing.toolCalls] }, "repeated_tool_call"],
      [{ ...passing, claims: [] }, `missing_required_claim:${requiredClaim}`],
      [{ ...passing, evidenceState: "absent" }, "wrong_evidence_state"],
      [{ ...passing, authorizationProtected: false }, "authorization_not_protected"],
      [{ ...passing, exposedDataClasses: ["attorney_billing"] }, "forbidden_data_exposed:attorney_billing"],
      [{ ...passing, clarifications: 2 }, "clarification_count_out_of_range"],
      [{ ...passing, actions: [{ key: "admin_finance", authorized: false }] }, "unauthorized_action:admin_finance"],
      [{ ...passing, suggestions: ["Payouts", "Billing"], suggestionsRelevant: false }, "too_many_suggestions"],
      [{ ...passing, reviewCard: { reason: "manual_review" } }, "manual_review_card_not_allowed"],
      [{ ...passing, directAnswerFirst: false }, "direct_answer_not_first"],
      [{ ...passing, sentenceCount: 20 }, "answer_too_long"],
      [{ ...passing, finalAnswer: "" }, "final_answer_missing"],
      [{ ...passing, fallbackUsed: true }, "unexpected_fallback"],
      [{ ...passing, answerOrder: [] }, "missing_answer_order_section:matter_financials"],
    ];
    for (const [actual, expectedError] of mutations) {
      expect(evaluateParalegalEvalResult(testCase, actual)).toEqual(expect.objectContaining({
        passed: false,
        errors: expect.arrayContaining([expectedError]),
      }));
    }

    const repeated = corpus.find((item) =>
      item.capabilityId === "P17_matter_financials" &&
      item.dimension === "repeated_question"
    );
    const repeatedPassing = buildPassingParalegalEvalResult(repeated);
    expect(evaluateParalegalEvalResult(repeated, {
      ...repeatedPassing,
      toolCalls: ["get_paralegal_case_financials"],
    })).toEqual(expect.objectContaining({
      passed: false,
      errors: expect.arrayContaining([
        "unexpected_tool_call:get_paralegal_case_financials",
      ]),
    }));
  });

  test("inspects final prose for raw evidence, internal fields, false actions, phantom review, legal work, and bank overclaims", () => {
    expect(inferParalegalUniversalClaims(
      "Verified information: stripeAccountId is acct_1. I accepted it and am sending it to the team."
    )).toEqual(expect.arrayContaining([
      "raw_evidence",
      "generic_verified_information",
      "internal_field",
      "mutation_completed",
      "manual_review_sent",
      "team_escalation_claim",
    ]));
    expect(inferParalegalUniversalClaims("Here is a final motion for you.")).toContain("legal_advice");
    expect(inferParalegalUniversalClaims("The payout landed in your bank."))
      .toContain("bank_receipt_confirmed");
  });

  test("automatically converts every registered production defect into a permanent regression", () => {
    const defects = getParalegalProductionDefects();
    const regressions = buildProductionRegressionCases(defects);
    expect(regressions).toHaveLength(defects.length);
    expect(regressions.map((testCase) => testCase.id)).toEqual(
      defects.map((defect) => `regression.${defect.id}`)
    );
    expect(regressions.every((testCase) =>
      testCase.permanent === true && testCase.source === "production_defect"
    )).toBe(true);

    const synthetic = {
      id: "PPD999_synthetic_registration",
      capabilityId: "P01_assigned_overview",
      prompt: "Synthetic reported paralegal defect",
      requiredEvidence: ["case_overview"],
      requiredTools: ["get_paralegal_case_overview"],
      requiredClaims: ["assigned_overview"],
      forbiddenClaims: ["raw_evidence"],
      riskLabels: ["privacy_authorization"],
    };
    expect(buildProductionRegressionCases([...defects, synthetic]).at(-1)).toEqual(
      expect.objectContaining({
        id: "regression.PPD999_synthetic_registration",
        permanent: true,
        source: "production_defect",
      })
    );
  });

  test("coverage reporting proves full family, failure, multi-turn, regression, and assertion coverage", () => {
    const report = buildParalegalEvaluationCoverageReport(corpus);
    expect(report).toEqual(expect.objectContaining({
      passed: true,
      capabilityCount: 32,
      caseCount: corpus.length,
      criticalCaseCount: corpus.length,
      multiTurnCaseCount: expect.any(Number),
      failureCaseCount: expect.any(Number),
      productionRegressionCount: getParalegalProductionDefects().length,
    }));
    expect(report.capabilityCoverage).toHaveLength(32);
    for (const item of report.capabilityCoverage) {
      expect(item.assertionCoverage).toEqual([
        "routing",
        "evidence",
        "answer",
        "privacy",
        "ui",
      ]);
      expect(item.dimensions).toEqual(expect.arrayContaining([
        "positive",
        "unavailable",
        "adversarial",
        "repeated_question",
      ]));
    }
  });
});
