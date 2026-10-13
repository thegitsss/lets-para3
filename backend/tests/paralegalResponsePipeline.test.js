const {
  MAX_CORRECTION_ATTEMPTS,
  buildParalegalGenerationInstructions,
  runParalegalResponsePipeline,
} = require("../ai/paralegalResponsePipeline");

const financialPlan = {
  requirements: [{ key: "matter_financials", anyOf: ["get_paralegal_case_financials"] }],
  answerOrder: ["matter_financials"],
  requestedDimensions: ["amount"],
  responseShape: { maximumSentences: 2, maximumClarifyingQuestions: 1 },
};
const financialOutput = {
  name: "get_paralegal_case_financials",
  result: {
    ok: true,
    available: true,
    evidenceState: "verified",
    evidence: {
      capabilityId: "P17_matter_financials",
      state: "verified",
      authorized: true,
      subjectType: "matter",
      subjectId: "matter-1",
      matterId: "matter-1",
      facts: [
        { key: "title", value: "Smith" },
        { key: "gross.formatted", value: "$100.00" },
        { key: "platformFee.formatted", value: "$20.00" },
        { key: "net.formatted", value: "$80.00" },
        { key: "finalized", value: false },
      ],
    },
  },
};

describe("paralegal response pipeline", () => {
  test("accepts the first fully supported generated answer", async () => {
    const generate = jest.fn().mockResolvedValue({
      reply: "The matter gross is $100.00, the paralegal platform fee is $20.00, and your current net payout is $80.00.",
      suggestions: [],
    });
    const result = await runParalegalResponsePipeline({
      generate,
      messageText: "what are the gross, fee, and net?",
      evidencePlan: financialPlan,
      toolOutputs: [financialOutput],
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("openai_manager_paralegal");
    expect(result.validation).toEqual(expect.objectContaining({
      correctionAttempts: 0,
      exhausted: false,
      retryOutcome: "not_needed",
    }));
  });

  test("passes structural validation failures into a bounded correction attempt", async () => {
    const generate = jest.fn()
      .mockResolvedValueOnce({
        reply: "Verified information: your payout is $95.00.",
        suggestions: [],
      })
      .mockResolvedValueOnce({
        reply: "Your current net payout is $80.00.",
        suggestions: [],
      });
    const result = await runParalegalResponsePipeline({
      generate,
      messageText: "what is my net payout?",
      evidencePlan: financialPlan,
      toolOutputs: [financialOutput],
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].correction.failureClasses).toEqual(expect.arrayContaining([
      "raw_evidence_leak",
      "unsupported_monetary_claim",
    ]));
    expect(result.reply).toBe("Your current net payout is $80.00.");
    expect(result.validation.retryOutcome).toBe("corrected");
  });

  test("uses an evidence-backed fallback after exactly two failed corrections", async () => {
    const generate = jest.fn().mockResolvedValue({
      reply: "Verified information: the payout is $95.00.",
      suggestions: ["Billing", "Post a case"],
      escalation: { available: true, reason: "manual_review" },
    });
    const result = await runParalegalResponsePipeline({
      generate,
      messageText: "what is the gross, fee, and net?",
      evidencePlan: financialPlan,
      toolOutputs: [financialOutput],
    });
    expect(generate).toHaveBeenCalledTimes(MAX_CORRECTION_ATTEMPTS + 1);
    expect(result.provider).toBe("openai_manager_paralegal_safe_fallback");
    expect(result.reply).toContain("gross amount is $100.00");
    expect(result.reply).toContain("paralegal platform fee is $20.00");
    expect(result.reply).toContain("current estimated net payout is $80.00");
    expect(result.suggestions).toEqual([]);
    expect(result.navigation).toBeNull();
    expect(result.reviewCard).toBeNull();
    expect(result.validation).toEqual(expect.objectContaining({
      correctionAttempts: 2,
      exhausted: true,
      retryOutcome: "safe_fallback",
    }));
  });

  test("uses a truthful safe fallback when required evidence is unavailable", async () => {
    const result = await runParalegalResponsePipeline({
      generate: jest.fn().mockRejectedValue(new Error("model unavailable")),
      messageText: "is my Smith matter in progress?",
      evidencePlan: {
        requirements: [{ key: "workspace", anyOf: ["get_paralegal_case_workspace"] }],
        answerOrder: ["workspace"],
        responseShape: { maximumSentences: 2, maximumClarifyingQuestions: 1 },
      },
      toolOutputs: [{
        name: "get_paralegal_case_workspace",
        result: {
          ok: false,
          available: false,
          evidenceState: "temporarily_unavailable",
          evidence: {
            capabilityId: "P02_matter_details",
            state: "temporarily_unavailable",
            authorized: true,
            facts: [],
          },
        },
      }],
    });
    expect(result.reply).toBe("I can’t verify that information right now. Please try again shortly.");
    expect(result.grounded).toBe(false);
    expect(result.validation.exhausted).toBe(true);
  });

  test("generation instructions expose only the selected evidence contract", () => {
    const instructions = buildParalegalGenerationInstructions({
      messageText: "what is my payout?",
      evidencePlan: financialPlan,
      toolOutputs: [financialOutput],
      validationErrors: ["unsupported_monetary_claim"],
    });
    expect(instructions.role).toBe("paralegal_support_assistant");
    expect(instructions.answerOrder).toEqual(["matter_financials"]);
    expect(instructions.evidence).toHaveLength(1);
    expect(instructions.evidence[0]).toEqual(expect.objectContaining({
      toolName: "get_paralegal_case_financials",
      capabilityId: "P17_matter_financials",
      authorized: true,
    }));
    expect(instructions.correction.failureClasses).toEqual(["unsupported_monetary_claim"]);
    expect(JSON.stringify(instructions)).not.toMatch(/caseDoc|stripeAccountId|transferId/);
  });
});
