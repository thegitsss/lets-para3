const {
  FAILURE_CLASSES,
  findEvidenceContradictions,
  normalizeAttorneyToolEvidence,
  renderAttorneyEvidenceAnswer,
} = require("../ai/attorneyEvidenceContract");

jest.mock("../ai/supportAgentTools", () => ({
  executeSupportManagerTool: jest.fn(),
  getSupportManagerToolDefinitions: jest.fn(() => []),
}));

const { auditManagerReply, buildValidationSafeFallback } = require("../ai/supportManagerAgent");

function workflowResult(overrides = {}) {
  return {
    ok: true,
    available: true,
    authoritativeWorkflow: true,
    requirements: {
      paymentMethodRequiredBeforePosting: true,
      paymentMethodRequiredBeforeApplications: true,
      paymentMethodRequiredBeforeHiring: true,
      chargeTiming: "charged_when_hire_is_confirmed",
      postHireWorkflow: {
        matterStatus: "in_progress",
        fundingStatus: "funded",
        scopeTasksLocked: true,
        nextStage: "workspace",
        workspaceParticipants: ["attorney", "hired_paralegal"],
        workspaceSupports: ["scope_tasks", "files", "messages"],
        completionStage: "complete_and_release",
      },
      paralegalPayoutTiming: {
        releaseTrigger: "when_attorney_completes_matter",
        allScopeTasksCompleteRequired: true,
        verifiedFundingRequired: true,
        paralegalPayoutSetupRequired: true,
        bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
        bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
        resultingMatterStatus: "completed",
        paymentReleased: true,
      },
    },
    stages: {
      post_matter: { label: "Post a matter" },
      receive_applications: { label: "Receive applications" },
      invite_paralegal: { label: "Invite a paralegal" },
      pre_engagement: { label: "Request pre-engagement items" },
      hire_and_fund: {
        label: "Hire and fund a matter",
        minimumMatterAmountCents: 40000,
        scopeTaskRequired: true,
        paralegalPayoutSetupRequired: true,
        requiredProcessorState: "succeeded",
      },
    },
    ...overrides,
  };
}

function envelope(capability, result = workflowResult()) {
  return normalizeAttorneyToolEvidence({
    toolName: "get_attorney_workflow_readiness",
    args: { capability },
    result,
  });
}

function trace(capability, result = workflowResult()) {
  return {
    name: "get_attorney_workflow_readiness",
    args: { capability },
    result: { ...result, evidence: envelope(capability, result) },
  };
}

function reply(overrides = {}) {
  return {
    reply: "You have 4 completed cases.",
    suggestions: [],
    navigation: null,
    primaryAsk: "test",
    activeTask: "FACT_LOOKUP",
    awaitingField: "",
    responseMode: "DIRECT_ANSWER",
    confidence: "high",
    detailLevel: "concise",
    evidenceCapability: "account_fact",
    ...overrides,
  };
}

describe("attorney normalized evidence contract", () => {
  test("normalizes the complete evidence envelope and atomic workflow facts", () => {
    const evidence = envelope("post_hire_workflow");
    expect(evidence).toEqual(expect.objectContaining({
      capability: "post_hire_workflow",
      capabilityId: "A10_hiring",
      sourceType: "executable_workflow_policy",
      policyOrLiveState: "mixed",
      subjectType: "lpc_workflow",
      retrievedAt: expect.any(String),
      authorized: true,
      facts: expect.any(Array),
      allowedActions: expect.any(Array),
      prohibitedActions: expect.any(Array),
      citations: ["attorneyWorkflowPolicy"],
      missingFacts: [],
    }));
    expect(evidence).toHaveProperty("subjectId");
    expect(evidence).toHaveProperty("matterId");
    expect(evidence.facts.map((fact) => fact.key)).toEqual(expect.arrayContaining([
      "hiring.resulting_matter_status",
      "hiring.resulting_funding_status",
      "workspace.participants",
      "workspace.supports",
      "completion.actor",
      "completion.resulting_matter_status",
      "completion.payout_release_trigger",
      "payout.bank_deposit_estimate_business_days",
    ]));
  });

  test.each([
    "okay so i picked her now what",
    "what changes once they’re hired",
    "after i choose a para where do we work",
    "does the matter start automatically",
    "what happens next",
    "and then what?",
  ])("renders post-hire evidence independently of prompt wording: %s", (_unseenWording) => {
    const rendered = renderAttorneyEvidenceAnswer({
      capability: "post_hire_workflow",
      evidenceEnvelopes: [envelope("post_hire_workflow")],
    });
    expect(rendered.ok).toBe(true);
    expect(rendered.reply).toMatch(/moves to In progress/i);
    expect(rendered.reply).toMatch(/scope tasks, files, messages/i);
  });

  test("renders hiring guidance as a natural workflow instead of serialized evidence fields", () => {
    const rendered = renderAttorneyEvidenceAnswer({
      capability: "hiring",
      evidenceEnvelopes: [envelope("hiring")],
    });
    expect(rendered.ok).toBe(true);
    expect(rendered.reply).toMatch(/Post a matter, review the applications/i);
    expect(rendered.reply).toMatch(/charges your saved payment method when you confirm/i);
    expect(rendered.reply).not.toMatch(/Verified information|results title|results answer/i);
  });

  test("renders approved knowledge as ordinary prose without internal result labels", () => {
    const evidence = normalizeAttorneyToolEvidence({
      toolName: "search_lpc_knowledge",
      args: { query: "platform fee" },
      result: {
        ok: true,
        found: true,
        results: [{ title: "Attorney Platform Fee", answer: "LPC applies the approved attorney platform fee." }],
      },
    });
    const rendered = renderAttorneyEvidenceAnswer({
      capability: "A31_product_knowledge",
      evidenceEnvelopes: [evidence],
    });
    expect(rendered.reply).toBe("LPC applies the approved attorney platform fee.");
    expect(rendered.reply).not.toMatch(/Verified information|results title|results answer/i);
  });

  test.each([
    "when do they actually receive the money",
    "how long till it hits their bank",
    "does marking it done pay them",
    "are they paid when hired or after",
    "when does para get funds",
    "okay but when is it deposited?",
  ])("renders deposit policy independently of prompt wording: %s", (_unseenWording) => {
    const rendered = renderAttorneyEvidenceAnswer({
      capability: "deposit_timing",
      evidenceEnvelopes: [envelope("deposit_timing")],
    });
    expect(rendered.reply).toMatch(/attorney marks the matter complete/i);
    expect(rendered.reply).toMatch(/3–5 business days/i);
  });

  test("attributes one shared workflow tool to the selected semantic capability", () => {
    expect(envelope("posting").capabilityId).toBe("A11_posting");
    expect(envelope("hiring").capabilityId).toBe("A10_hiring");
    expect(envelope("completion").capabilityId).toBe("A26_completion");
    expect(envelope("deposit_timing").capabilityId).toBe("A15_case_financials");
  });

  test("keeps a verified core answer and removes an irrelevant suggestion", () => {
    const audit = auditManagerReply(reply({ suggestions: ["Open billing"] }), {
      messageText: "How many cases have I completed?",
      toolOutputs: [{ name: "get_my_case_overview", result: { ok: true, available: true, completedCount: 4 } }],
    });
    expect(audit.valid).toBe(true);
    expect(audit.data.reply).toBe("You have 4 completed cases.");
    expect(audit.data.suggestions).toEqual([]);
    expect(audit.failureClasses).toContain(FAILURE_CLASSES.OPTIONAL_UI_INVALID);
  });

  test("keeps a verified core answer and removes an unauthorized button", () => {
    const audit = auditManagerReply(reply({
      navigation: {
        ctaLabel: "Admin finance",
        ctaHref: "admin-dashboard.html#finance",
        inlineLinkText: "here",
      },
    }), {
      messageText: "How many cases have I completed?",
      toolOutputs: [{ name: "get_my_case_overview", result: { ok: true, available: true, completedCount: 4 } }],
    });
    expect(audit.valid).toBe(true);
    expect(audit.data.navigation).toBeNull();
    expect(audit.failureClasses).toContain(FAILURE_CLASSES.OPTIONAL_UI_INVALID);
  });

  test("removes an unsupported secondary sentence while preserving the supported answer", () => {
    const audit = auditManagerReply(reply({
      reply: "You have 4 completed cases. Your current matter is disputed.",
    }), {
      messageText: "How many cases have I completed?",
      toolOutputs: [{ name: "get_my_case_overview", result: { ok: true, available: true, completedCount: 4 } }],
    });
    expect(audit.valid).toBe(true);
    expect(audit.data.reply).toBe("You have 4 completed cases.");
    expect(audit.warnings).toContain("unsupported_secondary_claim_removed");
  });

  test("rejects a contradicted amount in the core answer", () => {
    const audit = auditManagerReply(reply({ reply: "The total attorney charge was $99.00." }), {
      messageText: "What was I charged for this matter?",
      conversationState: { activeEntity: { type: "case", id: "case-1" } },
      toolOutputs: [{
        name: "get_attorney_case_financials",
        result: { ok: true, available: true, totalAttorneyCharge: { cents: 12200, formatted: "$122.00" } },
      }],
    });
    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("numeric_claim_absent_from_evidence");
  });

  test("rejects policy presented as completed live state", () => {
    const audit = auditManagerReply(reply({
      reply: "Your matter is in progress.",
      activeTask: "EXPLAIN",
    }), {
      messageText: "Is my matter in progress?",
      toolOutputs: [trace("post_hire_workflow")],
    });
    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("policy_presented_as_live_state");
    expect(audit.failureClasses).toContain(FAILURE_CLASSES.GENERATION_POLICY_LIVE_STATE_CONFUSION);
  });

  test("accepts a policy-backed payment release transition stored as a boolean fact", () => {
    const audit = auditManagerReply(reply({
      reply: "When the attorney completes the matter, payment is released to the paralegal.",
      activeTask: "EXPLAIN",
      evidenceCapability: "completion",
    }), {
      messageText: "What happens at completion?",
      toolOutputs: [trace("completion")],
    });
    expect(audit.valid).toBe(true);
  });

  test("classifies a declared workflow capability backed by the wrong source", () => {
    const audit = auditManagerReply(reply({
      reply: "After hiring, the matter moves into its work stage.",
      activeTask: "EXPLAIN",
      evidenceCapability: "post_hire_workflow",
    }), {
      messageText: "what changes once they’re hired",
      toolOutputs: [{ name: "search_lpc_knowledge", result: { ok: true, found: true, results: [] } }],
    });
    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("planner_wrong_source");
    expect(audit.failureClasses).toContain(FAILURE_CLASSES.PLANNER_WRONG_SOURCE);
  });

  test("renders available payout facts and names only the missing deposit estimate", () => {
    const result = workflowResult();
    delete result.requirements.paralegalPayoutTiming.bankDepositEstimateBusinessDays;
    const rendered = renderAttorneyEvidenceAnswer({
      capability: "deposit_timing",
      evidenceEnvelopes: [envelope("deposit_timing", result)],
    });
    expect(rendered.ok).toBe(true);
    expect(rendered.reply).toMatch(/released when the attorney marks the matter complete/i);
    expect(rendered.reply).toMatch(/bank-deposit estimate is not available/i);
    expect(rendered.missingFacts).toContain("payout.bank_deposit_estimate_business_days");
  });

  test("refuses evidence rendering when lifecycle evidence contradicts itself", () => {
    const first = envelope("post_hire_workflow");
    const changed = workflowResult();
    changed.requirements.postHireWorkflow.matterStatus = "open";
    const second = envelope("post_hire_workflow", changed);
    expect(findEvidenceContradictions([first, second])).toContain("hiring.resulting_matter_status");
    expect(renderAttorneyEvidenceAnswer({
      capability: "post_hire_workflow",
      evidenceEnvelopes: [first, second],
    })).toEqual(expect.objectContaining({ ok: false, failureClass: FAILURE_CLASSES.EVIDENCE_CONTRADICTION }));
  });

  test("uses the same evidence-rendered answer after repeated generation failure regardless of prompt", () => {
    const toolOutputs = [trace("post_hire_workflow")];
    const first = buildValidationSafeFallback({ messageText: "okay so i picked her now what", toolOutputs, validationRetries: 2 });
    const second = buildValidationSafeFallback({ messageText: "and then what?", toolOutputs, validationRetries: 2 });
    expect(first.reply).toBe(second.reply);
    expect(first.grounded).toBe(true);
    expect(first.telemetry.failureClasses).toContain("generation_replaced_from_verified_evidence");
  });
});
