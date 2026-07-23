const {
  auditAttorneyToolTrace,
  buildAttorneyEvidencePlan,
  isAccountWideSubjectChange,
  mergeVerifiedEntities,
  prepareConversationState,
} = require("../ai/attorneyConversationPolicy");
const {
  ATTORNEY_ENTITY_CAPABILITY_IDS,
  buildAttorneyRoutingEvalCases,
} = require("../ai/attorneySupportCapabilities");

function requirementKeys(plan) {
  return plan.requirements.map((requirement) => requirement.key);
}

describe("attorney conversation evidence and memory policy", () => {
  test("decomposes a compound account-state and platform-requirement question", () => {
    const plan = buildAttorneyEvidencePlan({
      messageText: "Do I have a saved payment method, and do I need one before posting?",
    });
    expect(requirementKeys(plan)).toEqual(expect.arrayContaining(["billing_method", "workflow_readiness"]));
    expect(plan.compound).toBe(true);
  });

  test("does not add prompt-specific PD007 or PD008 evidence-plan branches", () => {
    const plans = [
      buildAttorneyEvidencePlan({ messageText: "when do they actually receive the money" }),
      buildAttorneyEvidencePlan({ messageText: "okay so i picked her now what" }),
    ];
    plans.forEach((plan) => {
      expect(plan.requirements.some((item) => /payout timing|post-hire/i.test(item.reason))).toBe(false);
    });
  });

  test.each([
    ["What was I charged for this matter?", { activeEntity: { type: "case", id: "case-1" } }, "matter_financials"],
    ["Show all my receipts", {}, "receipt_history"],
    ["What files are waiting in this matter?", {}, "workspace"],
    ["Can I complete this matter?", {}, "matter_readiness"],
    ["How much have I spent? Show my billing summary.", {}, "billing_summary"],
    ["What needs my attention?", {}, "attention"],
  ])("requires the authoritative evidence for %s", (messageText, conversationState, expected) => {
    expect(requirementKeys(buildAttorneyEvidencePlan({ messageText, conversationState }))).toContain(expected);
  });

  test("preserves the financial subject for a one-word follow-up", () => {
    const plan = buildAttorneyEvidencePlan({
      messageText: "both",
      conversationHistory: [
        { role: "user", content: "How much was the Smith matter?" },
        { role: "assistant", content: "Do you mean your charge or the paralegal payout?" },
      ],
      conversationState: {
        activeEntity: { type: "case", id: "case-1", name: "Smith matter" },
        lastCapabilityIds: ["A15_case_financials"],
      },
    });
    expect(plan.followUp).toBe(true);
    expect(requirementKeys(plan)).toContain("matter_financials");
  });

  test("uses the historical matter snapshot instead of general knowledge for a named platform fee", () => {
    const plan = buildAttorneyEvidencePlan({
      messageText: "What was the platform fee for this matter?",
      conversationState: { activeEntity: { type: "case", id: "case-1", name: "Smith matter" } },
    });
    expect(requirementKeys(plan)).toContain("matter_financials");
    expect(requirementKeys(plan)).not.toContain("knowledge");
  });

  test("uses the compact case-details source for a plain named-matter status question", () => {
    const plan = buildAttorneyEvidencePlan({
      messageText: "I thought the Smith matter was completed. What is its actual status?",
    });
    const requirement = plan.requirements.find((entry) => entry.key === "case_details");
    expect(requirement?.anyOf).toEqual(["get_case_details"]);
  });

  test("normalizes realistic typos and shorthand before planning", () => {
    expect(requirementKeys(buildAttorneyEvidencePlan({
      messageText: "do i have a paymnt saved bfore posting",
    }))).toEqual(expect.arrayContaining(["billing_method", "workflow_readiness"]));
    expect(requirementKeys(buildAttorneyEvidencePlan({
      messageText: "show my reciepts",
    }))).toContain("receipt_history");
    expect(requirementKeys(buildAttorneyEvidencePlan({
      messageText: "am i waiting on a paralgal msg",
    }))).toContain("pending_paralegal");
  });

  test("keeps multiple verified matters durable and moves the active subject", () => {
    const entities = mergeVerifiedEntities(
      [{ type: "case", id: "case-1", name: "Smith matter", source: "tool:workspace" }],
      { type: "case", id: "case-2", name: "Jones matter", source: "tool:workspace" }
    );
    expect(entities.map((entry) => entry.id)).toEqual(["case-2", "case-1"]);
    const state = prepareConversationState("I meant the other case", {
      activeEntity: entities[0],
      verifiedEntities: entities,
    });
    expect(state.activeEntity.id).toBe("case-1");
    expect(state.correctionAmbiguous).toBe(false);
  });

  test("requires clarification when 'the other case' has multiple verified alternatives", () => {
    const state = prepareConversationState("I meant the other case", {
      activeEntity: { type: "case", id: "case-1", name: "Smith" },
      verifiedEntities: [
        { type: "case", id: "case-1", name: "Smith" },
        { type: "case", id: "case-2", name: "Jones" },
        { type: "case", id: "case-3", name: "Acme" },
      ],
    });
    expect(state.activeEntity).toBeNull();
    expect(state.correctionAmbiguous).toBe(true);
  });

  test("clears stale active matter context for an account-wide subject change", () => {
    expect(isAccountWideSubjectChange("How many cases have I completed?")).toBe(true);
    const state = prepareConversationState("Show my billing summary", {
      activeEntity: { type: "case", id: "case-1", name: "Smith" },
    });
    expect(state.activeEntity).toBeNull();
    expect(state.verifiedEntities).toHaveLength(1);
  });

  test("tool trace requires every compound source and detects repeated successful calls", () => {
    const plan = buildAttorneyEvidencePlan({
      messageText: "Do I have a saved card, and do I need it before posting?",
    });
    const partial = auditAttorneyToolTrace(plan, [
      { name: "get_billing_snapshot", result: { ok: true } },
    ]);
    expect(partial.sufficient).toBe(false);
    expect(partial.missing.map((entry) => entry.key)).toContain("workflow_readiness");
    const sufficientBillingResult = {
      ok: true,
      available: true,
      evidenceState: "verified",
      evidence: {
        authorized: true,
        facts: [{ key: "payment_method", value: "saved" }],
        missingFacts: [],
      },
    };
    const complete = auditAttorneyToolTrace(plan, [
      { name: "get_billing_snapshot", result: sufficientBillingResult },
      { name: "get_attorney_workflow_readiness", result: { ok: true } },
      { name: "get_billing_snapshot", result: sufficientBillingResult },
    ]);
    expect(complete.sufficient).toBe(true);
    expect(complete.repeated).toEqual(["get_billing_snapshot"]);
    const unrelated = auditAttorneyToolTrace(plan, [
      { name: "get_billing_snapshot", result: { ok: true } },
      { name: "get_attorney_workflow_readiness", result: { ok: true } },
      { name: "get_my_case_overview", result: { ok: true } },
    ]);
    expect(unrelated.unrelated).toEqual(["get_my_case_overview"]);
  });

  test("allows a repeated tool only for a different matter or insufficient first result", () => {
    const plan = { requirements: [] };
    const evidence = (matterId, overrides = {}) => ({
      ok: true,
      available: true,
      evidenceState: "verified",
      evidence: {
        authorized: true,
        matterId,
        facts: [{ key: "status", value: "in progress" }],
        missingFacts: [],
      },
      ...overrides,
    });
    const differentMatters = auditAttorneyToolTrace(plan, [
      { name: "get_case_details", args: { case_reference: "Smith" }, result: evidence("matter-1") },
      { name: "get_case_details", args: { case_reference: "Jones" }, result: evidence("matter-2") },
    ]);
    expect(differentMatters.repeated).toEqual([]);

    const retryAfterMissingFacts = auditAttorneyToolTrace(plan, [
      {
        name: "get_attorney_workflow_readiness",
        args: { capability: "payout_release" },
        result: evidence("", { evidence: { authorized: true, matterId: "", facts: [], missingFacts: ["release_trigger"] } }),
      },
      {
        name: "get_attorney_workflow_readiness",
        args: { capability: "deposit_timing" },
        result: evidence(""),
      },
    ]);
    expect(retryAfterMissingFacts.repeated).toEqual([]);

    const redundant = auditAttorneyToolTrace(plan, [
      { name: "get_case_details", args: { case_reference: "Smith" }, result: evidence("matter-1") },
      { name: "get_case_details", args: { case_reference: "matter-1" }, result: evidence("matter-1") },
    ]);
    expect(redundant.repeated).toEqual(["get_case_details"]);
  });

  test("requires policy when a compound answer connects work state to payment state", () => {
    const plan = buildAttorneyEvidencePlan({
      messageText: "Which payout is still not released, and which scope task is incomplete on this matter?",
      conversationState: { activeEntity: { type: "case", id: "case-1", name: "Smith" } },
    });
    expect(plan.requirements.map((requirement) => requirement.key)).toEqual(
      expect.arrayContaining(["matter_financials", "workspace", "workflow_readiness"])
    );
  });

  test("every entity-bearing capability generates pronoun, subject-change, and correction cases", () => {
    const cases = buildAttorneyRoutingEvalCases();
    for (const capabilityId of ATTORNEY_ENTITY_CAPABILITY_IDS) {
      const kinds = new Set(
        cases.filter((entry) => entry.capabilityId === capabilityId).map((entry) => entry.referenceKind)
      );
      expect(kinds.has("pronoun")).toBe(true);
      expect(kinds.has("subject_change")).toBe(true);
      expect(kinds.has("correction")).toBe(true);
    }
  });
});
