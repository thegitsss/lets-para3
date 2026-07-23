const mockExecuteSupportManagerTool = jest.fn();
const mockGetSupportManagerToolDefinitions = jest.fn((role) => [
  {
    type: "function",
    name: role === "attorney" ? "get_my_case_overview" : "search_lpc_knowledge",
    description: "Test tool",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
]);

jest.mock("../ai/supportAgentTools", () => ({
  executeSupportManagerTool: (...args) => mockExecuteSupportManagerTool(...args),
  getSupportManagerToolDefinitions: (...args) => mockGetSupportManagerToolDefinitions(...args),
}));

const {
  auditManagerReply,
  buildValidationSafeFallback,
  buildManagerInstructions,
  deriveActiveEntity,
  generateSupportManagerReply,
  selectManagerToolsForEvidencePlan,
  validateManagerReply,
} = require("../ai/supportManagerAgent");
const SupportMessage = require("../models/SupportMessage");
const { normalizeAttorneyToolEvidence } = require("../ai/attorneyEvidenceContract");

const originalManagerRoles = process.env.OPENAI_SUPPORT_MANAGER_ROLES;
const originalAttorneyManagerEnabled = process.env.OPENAI_ATTORNEY_MANAGER_ENABLED;
const originalAttorneyRolloutPercent = process.env.OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT;
const originalAttorneyAllowlist = process.env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST;

function managerReply(overrides = {}) {
  return {
    reply: "You have 4 completed cases.",
    suggestions: ["View completed cases"],
    navigation: null,
    primaryAsk: "completed_case_count",
    activeTask: "FACT_LOOKUP",
    awaitingField: "",
    responseMode: "DIRECT_ANSWER",
    confidence: "high",
    detailLevel: "concise",
    evidenceCapability: "account_fact",
    ...overrides,
  };
}

function workflowTrace(capability, result) {
  const args = { capability };
  return {
    name: "get_attorney_workflow_readiness",
    args,
    result: {
      ...result,
      evidence: normalizeAttorneyToolEvidence({
        toolName: "get_attorney_workflow_readiness",
        args,
        result,
      }),
    },
  };
}

describe("support manager agent", () => {
  beforeEach(() => {
    delete process.env.OPENAI_SUPPORT_MANAGER_ROLES;
    delete process.env.OPENAI_ATTORNEY_MANAGER_ENABLED;
    delete process.env.OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT;
    delete process.env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST;
    mockExecuteSupportManagerTool.mockReset();
    mockGetSupportManagerToolDefinitions.mockClear();
  });

  afterAll(() => {
    if (typeof originalManagerRoles === "undefined") delete process.env.OPENAI_SUPPORT_MANAGER_ROLES;
    else process.env.OPENAI_SUPPORT_MANAGER_ROLES = originalManagerRoles;
    if (typeof originalAttorneyManagerEnabled === "undefined") delete process.env.OPENAI_ATTORNEY_MANAGER_ENABLED;
    else process.env.OPENAI_ATTORNEY_MANAGER_ENABLED = originalAttorneyManagerEnabled;
    if (typeof originalAttorneyRolloutPercent === "undefined") delete process.env.OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT;
    else process.env.OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT = originalAttorneyRolloutPercent;
    if (typeof originalAttorneyAllowlist === "undefined") delete process.env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST;
    else process.env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST = originalAttorneyAllowlist;
  });

  test("lets the model select a live tool, continues the Responses loop, and grounds the final answer", async () => {
    mockExecuteSupportManagerTool.mockResolvedValue({
      ok: true,
      totalCount: 9,
      completedCount: 4,
      activeCount: 5,
    });
    const parse = jest
      .fn()
      .mockResolvedValueOnce({
        id: "resp_tool",
        model: "gpt-5.6-terra",
        output: [
          { type: "reasoning", id: "reasoning_1", summary: [] },
          {
            type: "function_call",
            call_id: "call_cases",
            name: "get_my_case_overview",
            arguments: JSON.stringify({ status_scope: "completed" }),
            parsed_arguments: { status_scope: "completed" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      })
      .mockResolvedValueOnce({
        id: "resp_final",
        model: "gpt-5.6-terra",
        output: [],
        output_parsed: managerReply(),
        usage: { input_tokens: 130, output_tokens: 30, total_tokens: 160 },
      });
    const client = { responses: { parse } };
    const user = { _id: "507f1f77bcf86cd799439011", role: "attorney" };

    const result = await generateSupportManagerReply({
      messageText: "how many matters did i finish?",
      user,
      pageContext: { pathname: "/dashboard-attorney.html", search: "?token=secret" },
      client,
    });

    expect(result).toEqual(
      expect.objectContaining({
        reply: "You have 4 completed cases.",
        provider: "openai_manager",
        grounded: true,
        telemetry: expect.objectContaining({
          agentIterations: 2,
          inputTokens: 230,
          outputTokens: 50,
          totalTokens: 280,
          managerAvailable: true,
          rollout: expect.objectContaining({ rolloutStage: "general", rolloutPercent: 100 }),
          toolCalls: [expect.objectContaining({
            name: "get_my_case_overview",
            ok: true,
            evidenceState: "verified",
            failureClass: "success",
            durationMs: expect.any(Number),
          })],
        }),
      })
    );
    expect(mockExecuteSupportManagerTool).toHaveBeenCalledWith(
      "get_my_case_overview",
      { status_scope: "completed" },
      expect.objectContaining({ user })
    );
    expect(mockExecuteSupportManagerTool.mock.calls[0][2].pageContext).not.toHaveProperty("search");
    expect(parse).toHaveBeenCalledTimes(2);
    const secondInput = parse.mock.calls[1][0].input;
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", id: "reasoning_1" }),
        expect.objectContaining({ type: "function_call", call_id: "call_cases" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_cases" }),
      ])
    );
    expect(secondInput.find((item) => item?.call_id === "call_cases")).not.toHaveProperty("parsed_arguments");
  });

  test("preserves conversation history so 'both' can resolve the previously named matter", async () => {
    const conversationId = "507f1f77bcf86cd799439099";
    jest.spyOn(SupportMessage, "find").mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              sender: "assistant",
              text: "Do you mean the paralegal payout or the amount you were charged for Testing payout?",
            },
            { sender: "user", text: "and how much was that for?" },
          ],
        }),
      }),
    });
    mockGetSupportManagerToolDefinitions.mockReturnValueOnce([
      {
        type: "function",
        name: "get_attorney_case_financials",
        description: "Test financial tool",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        strict: true,
      },
    ]);
    mockExecuteSupportManagerTool.mockResolvedValue({
      ok: true,
      available: true,
      title: "Testing payout",
      totalAttorneyCharge: { cents: 12200, formatted: "$122.00" },
      netParalegalPayout: { cents: 8200, formatted: "$82.00", source: "payout_ledger" },
    });
    const parse = jest
      .fn()
      .mockResolvedValueOnce({
        id: "resp_financial_tool",
        output: [
          {
            type: "function_call",
            call_id: "call_financials",
            name: "get_attorney_case_financials",
            arguments: JSON.stringify({ case_reference: "Testing payout" }),
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        id: "resp_financial_final",
        output: [],
        output_parsed: managerReply({
          reply: "You were charged $122.00, and the paralegal received $82.00.",
          suggestions: [],
          primaryAsk: "case_financials",
        }),
        usage: {},
      });

    const result = await generateSupportManagerReply({
      messageText: "both",
      conversationId,
      user: { _id: "507f1f77bcf86cd799439011", role: "attorney" },
      client: { responses: { parse } },
    });

    expect(result.reply).toBe("You were charged $122.00, and the paralegal received $82.00.");
    expect(mockExecuteSupportManagerTool).toHaveBeenCalledWith(
      "get_attorney_case_financials",
      { case_reference: "Testing payout" },
      expect.any(Object)
    );
    expect(parse.mock.calls[0][0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Testing payout"),
        }),
      ])
    );
  });

  test("rejects a factual direct answer that did not use a tool", async () => {
    const client = {
      responses: {
        parse: jest.fn().mockResolvedValue({
          id: "resp_ungrounded",
          output: [],
          output_parsed: managerReply({ reply: "You have completed cases." }),
          usage: {},
        }),
      },
    };

    await expect(
      generateSupportManagerReply({
        messageText: "how many cases have i completed?",
        user: { _id: "507f1f77bcf86cd799439011", role: "attorney" },
        client,
      })
    ).resolves.toEqual(expect.objectContaining({
      provider: "openai_manager_safe_fallback",
      grounded: false,
      suggestions: [],
      navigation: null,
      telemetry: expect.objectContaining({
        validationExhausted: true,
        retryOutcome: "safe_fallback",
        validationRetries: 2,
        validationFailures: expect.arrayContaining([
          "direct_factual_answer_without_successful_tool_evidence",
        ]),
      }),
    }));
  });

  test("keeps paralegal and admin on the existing fallback during the attorney-only rollout", async () => {
    process.env.OPENAI_SUPPORT_MANAGER_ROLES = "attorney,paralegal,admin";
    const parse = jest.fn();
    const client = { responses: { parse } };

    await expect(
      generateSupportManagerReply({
        messageText: "what needs attention?",
        user: { _id: "507f1f77bcf86cd799439011", role: "paralegal" },
        client,
      })
    ).resolves.toBeNull();
    await expect(
      generateSupportManagerReply({
        messageText: "what needs attention?",
        user: { _id: "507f1f77bcf86cd799439012", role: "admin" },
        client,
      })
    ).resolves.toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  test("honors the attorney-only manager kill switch", async () => {
    process.env.OPENAI_ATTORNEY_MANAGER_ENABLED = "false";
    const parse = jest.fn();
    await expect(generateSupportManagerReply({
      messageText: "How many matters have I completed?",
      user: { _id: "507f1f77bcf86cd799439011", role: "attorney" },
      client: { responses: { parse } },
    })).resolves.toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  test("offers only deterministic evidence-plan tools for workflow prerequisites", () => {
    const selected = selectManagerToolsForEvidencePlan([
      { name: "get_attorney_workflow_readiness" },
      { name: "get_billing_snapshot" },
      { name: "search_lpc_knowledge" },
      { name: "find_navigation_destination" },
    ], {
      requirements: [
        { key: "workflow_readiness", anyOf: ["get_attorney_workflow_readiness"] },
        { key: "billing_method", anyOf: ["get_billing_snapshot"] },
      ],
    });
    expect(selected.map((tool) => tool.name)).toEqual([
      "get_attorney_workflow_readiness",
      "get_billing_snapshot",
    ]);
  });

  test("keeps lifecycle policy and live readiness available beside a matter snapshot", () => {
    const selected = selectManagerToolsForEvidencePlan([
      { name: "get_attorney_case_financials" },
      { name: "get_attorney_matter_readiness" },
      { name: "get_attorney_workflow_readiness" },
      { name: "search_lpc_knowledge" },
      { name: "find_navigation_destination" },
    ], {
      requirements: [
        { key: "matter_financials", anyOf: ["get_attorney_case_financials"] },
      ],
    });
    expect(selected.map((tool) => tool.name)).toEqual([
      "get_attorney_case_financials",
      "get_attorney_matter_readiness",
      "get_attorney_workflow_readiness",
    ]);
  });

  test("does not expose unrelated knowledge or navigation tools during a workflow turn", async () => {
    mockGetSupportManagerToolDefinitions.mockReturnValueOnce([
      { type: "function", name: "get_attorney_workflow_readiness", description: "policy", parameters: {}, strict: true },
      { type: "function", name: "search_lpc_knowledge", description: "knowledge", parameters: {}, strict: true },
      { type: "function", name: "find_navigation_destination", description: "navigation", parameters: {}, strict: true },
    ]);
    mockExecuteSupportManagerTool.mockResolvedValue({
      ok: true,
      available: true,
      evidenceState: "verified",
      authoritativeWorkflow: true,
      requirements: { paymentMethodRequiredBeforePosting: true },
    });
    const parse = jest
      .fn()
      .mockImplementationOnce(async (request) => {
        expect(request.tools.map((tool) => tool.name)).toEqual(["get_attorney_workflow_readiness"]);
        return {
          id: "workflow_tool",
          output: [{
            type: "function_call",
            call_id: "workflow",
            name: "get_attorney_workflow_readiness",
            arguments: "{}",
          }],
          usage: {},
        };
      })
      .mockResolvedValueOnce({
        id: "workflow_answer",
        output: [],
        output_parsed: managerReply({
          reply: "A saved payment method is required before posting.",
          suggestions: [],
          primaryAsk: "posting_readiness",
          activeTask: "EXPLAIN",
        }),
        usage: {},
      });
    const result = await generateSupportManagerReply({
      messageText: "Do I need a payment method before posting?",
      user: { _id: "507f1f77bcf86cd799439011", role: "attorney" },
      client: { responses: { parse } },
    });
    expect(result.provider).toBe("openai_manager");
    expect(result.telemetry.toolCalls).toEqual([
      expect.objectContaining({ name: "get_attorney_workflow_readiness", ok: true }),
    ]);
  });

  test("allows only navigation returned by an authorized navigation tool", () => {
    const evidence = [
      {
        name: "find_navigation_destination",
        result: {
          ok: true,
          available: true,
          ctaLabel: "Billing & payments",
          ctaHref: "dashboard-attorney.html#billing",
        },
      },
    ];
    const accepted = validateManagerReply(
      managerReply({
        reply: "Open billing here.",
        navigation: {
          ctaLabel: "Billing & payments",
          ctaHref: "dashboard-attorney.html#billing",
          inlineLinkText: "here",
        },
        activeTask: "NAVIGATION",
        suggestions: [],
      }),
      { messageText: "where is billing?", toolOutputs: evidence }
    );
    const stripped = validateManagerReply(
      managerReply({
        reply: "Open billing here.",
        navigation: {
          ctaLabel: "Billing",
          ctaHref: "admin-dashboard.html#finance",
          inlineLinkText: "here",
        },
        activeTask: "NAVIGATION",
        suggestions: [],
      }),
      { messageText: "where is billing?", toolOutputs: evidence }
    );

    expect(accepted.navigation?.ctaHref).toBe("dashboard-attorney.html#billing");
    expect(stripped.navigation).toBeNull();
  });

  test("blocks numeric claims that are absent from the tool evidence", () => {
    expect(
      validateManagerReply(managerReply({ reply: "You have 7 completed cases." }), {
        messageText: "how many did i finish?",
        toolOutputs: [{ name: "get_my_case_overview", result: { ok: true, completedCount: 4 } }],
      })
    ).toBeNull();
  });

  test("does not ground a numeric claim from digits embedded in record identifiers", () => {
    const audit = auditManagerReply(managerReply({ reply: "You completed 99 cases.", suggestions: [] }), {
      messageText: "How many cases did I complete?",
      toolOutputs: [{
        name: "get_my_case_overview",
        result: {
          ok: true,
          available: true,
          completedCount: 3,
          recentCases: [{ caseId: "6a6140113892535f99d8139e", title: "Synthetic Matter" }],
        },
      }],
    });
    expect(audit.errors).toContain("numeric_claim_absent_from_evidence");
  });

  test("never treats a number supplied by the user as verified evidence", () => {
    const audit = auditManagerReply(managerReply({ reply: "Yes, you completed 99 cases." }), {
      messageText: "Did I complete 99 cases?",
      toolOutputs: [{ name: "get_my_case_overview", result: { ok: true, completedCount: 4 } }],
    });
    expect(audit.errors).toContain("numeric_claim_absent_from_evidence");
  });

  test("rejects claims that data is unavailable when a tool returned available evidence", () => {
    const audit = auditManagerReply(
      managerReply({ reply: "I don't have that information available." }),
      {
        messageText: "what is the status?",
        toolOutputs: [
          { name: "get_case_details", result: { ok: true, available: true, status: "completed" } },
        ],
      }
    );
    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("claimed_data_unavailable_despite_available_evidence");
  });

  test("requires the authoritative workflow tool for payment prerequisites", () => {
    const audit = auditManagerReply(
      managerReply({
        reply:
          "I couldn’t confirm from the available platform guidance whether a payment method is required first.",
      }),
      {
        messageText: "do i need a payment method first?",
        toolOutputs: [
          {
            name: "get_billing_snapshot",
            result: { ok: true, available: false, source: "stored_missing", isValid: false },
          },
        ],
      }
    );

    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("workflow_prerequisite_without_authoritative_evidence");
  });

  test("rejects a workflow answer that contradicts the executable payment policy", () => {
    const audit = auditManagerReply(
      managerReply({ reply: "No—you don’t need a payment method before posting." }),
      {
        messageText: "do i need a payment method first?",
        toolOutputs: [
          {
            name: "get_attorney_workflow_readiness",
            result: {
              ok: true,
              available: true,
              authoritativeWorkflow: true,
              requirements: { paymentMethodRequiredBeforePosting: true },
            },
          },
        ],
      }
    );

    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("workflow_answer_conflicts_with_authoritative_policy");
  });

  test("accepts a direct answer grounded in the authoritative payment workflow", () => {
    const answer = validateManagerReply(
      managerReply({
        reply:
          "Yes. You need a saved payment method before you can post a matter; LPC charges it when you confirm a hire.",
        suggestions: [],
      }),
      {
        messageText: "do i need a payment method first?",
        toolOutputs: [
          {
            name: "get_attorney_workflow_readiness",
            result: {
              ok: true,
              available: true,
              authoritativeWorkflow: true,
              requirements: {
                paymentMethodRequiredBeforePosting: true,
                chargeTiming: "charged_when_hire_is_confirmed",
              },
            },
          },
        ],
      }
    );

    expect(answer?.reply).toMatch(/^Yes\./);
  });

  test("derives durable matter memory from verified tool output", () => {
    expect(
      deriveActiveEntity([
        {
          name: "get_attorney_case_workspace",
          result: { ok: true, available: true, caseId: "507f1f77bcf86cd799439088", title: "Smith matter" },
        },
      ])
    ).toEqual({
      type: "case",
      id: "507f1f77bcf86cd799439088",
      name: "Smith matter",
      source: "tool:get_attorney_case_workspace",
    });
  });

  test("retries an internally invalid answer and returns the corrected grounded response", async () => {
    mockExecuteSupportManagerTool.mockResolvedValue({
      ok: true,
      available: true,
      completedCount: 4,
    });
    const parse = jest
      .fn()
      .mockResolvedValueOnce({
        id: "resp_retry_tool",
        output: [
          {
            type: "function_call",
            call_id: "call_retry",
            name: "get_my_case_overview",
            arguments: JSON.stringify({ status_scope: "completed" }),
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        id: "resp_retry_invalid",
        output: [],
        output_parsed: managerReply({ reply: "You completed 9 cases." }),
        usage: {},
      })
      .mockResolvedValueOnce({
        id: "resp_retry_corrected",
        output: [],
        output_parsed: managerReply({ reply: "You completed 4 cases." }),
        usage: {},
      });

    const result = await generateSupportManagerReply({
      messageText: "how many cases did i complete?",
      user: { _id: "507f1f77bcf86cd799439011", role: "attorney" },
      client: { responses: { parse } },
    });

    expect(result.reply).toBe("You completed 4 cases.");
    expect(result.telemetry.validationRetries).toBe(1);
    expect(result.telemetry.validationFailures).toContain("numeric_claim_absent_from_evidence");
    expect(result.telemetry.retryOutcome).toBe("corrected");
    expect(result.telemetry.validationExhausted).toBe(false);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  test("blocks false action claims and legal work product", () => {
    const evidence = [{ name: "search_lpc_knowledge", result: { ok: true, found: true } }];
    expect(
      validateManagerReply(managerReply({ reply: "I've approved the case for you." }), {
        messageText: "can you approve this?",
        toolOutputs: evidence,
      })
    ).toBeNull();
    expect(
      validateManagerReply(managerReply({ reply: "Here is a draft motion for your matter." }), {
        messageText: "draft a motion",
        toolOutputs: evidence,
      })
    ).toBeNull();
  });

  test("allows a concise no-tool boundary response that refuses legal drafting", () => {
    expect(
      validateManagerReply(
        managerReply({
          reply: "I can help with LPC matter workflow, but I can’t draft legal documents or provide legal advice.",
          suggestions: [],
          primaryAsk: "legal_drafting_boundary",
          activeTask: "BOUNDARY",
        }),
        { messageText: "draft an NDA for my matter", toolOutputs: [] }
      )
    ).toEqual(expect.objectContaining({ activeTask: "BOUNDARY" }));
  });

  test("keeps the manager read-only and excludes legal drafting", () => {
    const instructions = buildManagerInstructions("attorney");
    expect(instructions).toMatch(/read-only/i);
    expect(instructions).toMatch(/do not draft legal documents/i);
    expect(instructions).toMatch(/call the smallest useful set of tools/i);
    expect(instructions).toMatch(/evidencePlan is mandatory/i);
    expect(instructions).toMatch(/call exactly one offered tool from every evidencePlan requirement/i);
    expect(instructions).toMatch(/do not answer until every evidencePlan requirement/i);
    expect(instructions).toMatch(/semantic capability being answered/i);
    expect(instructions).toMatch(/Never turn policy into live state/i);
  });

  test("accepts a direct authoritative explanation of the post-hire workflow", () => {
    const toolOutputs = [
      {
        name: "get_attorney_workflow_readiness",
        result: {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          requirements: {
            postHireWorkflow: {
              matterStatus: "in_progress",
              fundingStatus: "funded",
              scopeTasksLocked: true,
              nextStage: "workspace",
              workspaceParticipants: ["attorney", "hired_paralegal"],
              workspaceSupports: ["scope_tasks", "files", "messages"],
              completionStage: "complete_and_release",
            },
          },
        },
      },
    ];
    expect(validateManagerReply(managerReply({
      reply: "After you hire and fund the matter, it moves to In Progress and the hired paralegal gets access to the workspace for the agreed scope, tasks, files, and messages. Once all scope tasks are complete, you complete the matter to release the paralegal’s payout.",
      suggestions: [],
      activeTask: "EXPLAIN",
    }), {
      messageText: "What happens after I hire a paralegal?",
      toolOutputs,
    })).not.toBeNull();
  });

  test("rejects a false limitation when verified workflow evidence is available", () => {
    const audit = auditManagerReply(managerReply({
      reply: "I couldn’t produce a reliable answer from the verified LPC information. Please try again.",
      suggestions: [],
      activeTask: "TROUBLESHOOT",
      confidence: "low",
    }), {
      messageText: "What happens after I hire a paralegal?",
      toolOutputs: [
        {
          name: "get_attorney_workflow_readiness",
          result: {
            ok: true,
            available: true,
            authoritativeWorkflow: true,
            requirements: {
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
              },
            },
          },
        },
      ],
    });
    expect(audit.errors).toContain("claimed_data_unavailable_despite_available_evidence");
  });

  test("accepts an authoritative, direct answer for general paralegal payout timing", () => {
    const toolOutputs = [
      {
        name: "get_attorney_workflow_readiness",
        result: {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          requirements: {
            paralegalPayoutTiming: {
              releaseTrigger: "when_attorney_completes_matter",
              allScopeTasksCompleteRequired: true,
              verifiedFundingRequired: true,
              paralegalPayoutSetupRequired: true,
              bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
              bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
            },
          },
        },
      },
    ];
    expect(validateManagerReply(managerReply({
      reply: "The paralegal’s payout is released when you complete the matter, after all scope tasks, funding, and payout setup are ready. Bank deposit typically takes 3–5 business days after release, depending on Stripe and the bank.",
      suggestions: [],
    }), {
      messageText: "When does the paralegal get paid?",
      toolOutputs,
    })).not.toBeNull();
  });

  test("rejects a false payout limitation when verified policy evidence is available", () => {
    const toolOutputs = [
      {
        name: "get_attorney_workflow_readiness",
        result: {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          requirements: {
            paralegalPayoutTiming: {
              releaseTrigger: "when_attorney_completes_matter",
              bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
            },
          },
        },
      },
    ];
    const limitation = auditManagerReply(managerReply({
      reply: "I couldn’t verify the payout timing. Check the matter’s payout status.",
      suggestions: [],
    }), {
      messageText: "When does the paralegal get paid?",
      toolOutputs,
    });
    expect(limitation.errors).toContain("claimed_data_unavailable_despite_available_evidence");
  });

  test("uses verified workflow evidence instead of a generic fallback for payout timing", () => {
    const result = buildValidationSafeFallback({
      messageText: "When does the paralegal get paid?",
      toolOutputs: [
        workflowTrace("deposit_timing", {
            ok: true,
            available: true,
            authoritativeWorkflow: true,
            requirements: {
              paralegalPayoutTiming: {
                releaseTrigger: "when_attorney_completes_matter",
                allScopeTasksCompleteRequired: true,
                verifiedFundingRequired: true,
                paralegalPayoutSetupRequired: true,
                bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
                bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
              },
            },
          }),
      ],
      validationRetries: 2,
      validationFailures: ["generation_unsupported_claim"],
    });
    expect(result).toEqual(expect.objectContaining({
      reply: expect.stringMatching(/matter complete[\s\S]*3–5 business days/i),
      provider: "openai_manager_safe_fallback",
      grounded: true,
      confidence: "high",
      supportFacts: expect.objectContaining({ evidenceStatus: "verified_fallback" }),
      telemetry: expect.objectContaining({
        validationExhausted: true,
        retryOutcome: "safe_fallback",
      }),
    }));
  });

  test("uses the repaired most-specific workflow capability when fallback follows adjacent workflow calls", () => {
    const result = buildValidationSafeFallback({
      response: { output_parsed: { evidenceCapability: "payout_release" } },
      messageText: "How long does the bank part take?",
      toolOutputs: [
        workflowTrace("payout_release", {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          requirements: {
            paralegalPayoutTiming: {
              releaseTrigger: "when_attorney_completes_matter",
              allScopeTasksCompleteRequired: true,
              verifiedFundingRequired: true,
              paralegalPayoutSetupRequired: true,
              bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
              bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
            },
          },
        }),
        workflowTrace("deposit_timing", {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          requirements: {
            paralegalPayoutTiming: {
              releaseTrigger: "when_attorney_completes_matter",
              allScopeTasksCompleteRequired: true,
              verifiedFundingRequired: true,
              paralegalPayoutSetupRequired: true,
              bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
              bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
            },
          },
        }),
      ],
      validationRetries: 2,
      validationFailures: ["repeated_tool_call_without_new_information"],
    });
    expect(result).toEqual(expect.objectContaining({
      reply: expect.stringMatching(/3–5 business days/i),
      primaryAsk: "deposit_timing",
      evidenceCapability: "deposit_timing",
      provider: "openai_manager_safe_fallback",
    }));
  });

  test("uses verified workflow evidence instead of a generic fallback after hiring", () => {
    const result = buildValidationSafeFallback({
      messageText: "What happens after I hire a paralegal?",
      evidencePlan: {
        requirements: [{ key: "workflow_readiness", reason: "workflow policy" }],
      },
      toolOutputs: [
        workflowTrace("post_hire_workflow", {
            ok: true,
            available: true,
            authoritativeWorkflow: true,
            requirements: {
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
              },
            },
          }),
      ],
      validationRetries: 2,
      validationFailures: ["generation_unsupported_claim"],
    });
    expect(result).toEqual(expect.objectContaining({
      reply: expect.stringMatching(/moves to In Progress[\s\S]*workspace/i),
      primaryAsk: "post_hire_workflow",
      provider: "openai_manager_safe_fallback",
      grounded: true,
      confidence: "high",
      supportFacts: expect.objectContaining({ evidenceStatus: "verified_fallback" }),
    }));
  });

  test("requires complete semantic dimensions for workflow capabilities", () => {
    const payoutTrace = workflowTrace("deposit_timing", {
      ok: true,
      available: true,
      authoritativeWorkflow: true,
      requirements: {
        paralegalPayoutTiming: {
          releaseTrigger: "when_attorney_completes_matter",
          bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
        },
      },
    });
    const audit = auditManagerReply(managerReply({
      reply: "Bank deposit usually takes 3–5 business days.",
      evidenceCapability: "deposit_timing",
      suggestions: [],
    }), {
      messageText: "When does the paralegal get paid?",
      toolOutputs: [payoutTrace],
      evidencePlan: { requirements: [{ key: "workflow_readiness", anyOf: ["get_attorney_workflow_readiness"] }] },
    });
    expect(audit.errors).toEqual(expect.arrayContaining([
      "missing_capability_answer_fact:deposit_release_trigger",
      "missing_capability_answer_fact:deposit_release_transition",
    ]));
  });

  test("safe fallback answers every requested workspace dimension", () => {
    const result = buildValidationSafeFallback({
      messageText: "What task is left and which file needs my review?",
      evidencePlan: { requirements: [{ key: "workspace", anyOf: ["get_attorney_case_workspace"] }], compound: false },
      toolOutputs: [{
        name: "get_attorney_case_workspace",
        result: {
          ok: true,
          available: true,
          status: "in_progress",
          tasks: { items: [{ title: "Draft chronology", completed: false, contentTrust: "untrusted_record_content" }] },
          files: { items: [{ name: "Discovery response.pdf", status: "pending_review" }] },
          evidence: normalizeAttorneyToolEvidence({
            toolName: "get_attorney_case_workspace",
            result: {
              ok: true,
              available: true,
              status: "in_progress",
              tasks: { items: [{ title: "Draft chronology", completed: false, contentTrust: "untrusted_record_content" }] },
              files: { items: [{ name: "Discovery response.pdf", status: "pending_review" }] },
            },
          }),
        },
      }],
      validationRetries: 2,
      validationFailures: ["missing_answer_part:file"],
    });
    expect(result.reply).toMatch(/Draft chronology[\s\S]*Discovery response\.pdf/i);
  });

  test("safe fallback combines workflow prerequisites with current billing state", () => {
    const result = buildValidationSafeFallback({
      messageText: "Do I need a saved payment method before I can post a matter?",
      evidencePlan: {
        requirements: [
          { key: "workflow_readiness", anyOf: ["get_attorney_workflow_readiness"] },
          { key: "billing_method", anyOf: ["get_billing_snapshot"] },
        ],
        compound: true,
      },
      toolOutputs: [
        workflowTrace("posting", {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          paymentMethod: { saved: true },
          requirements: { paymentMethodRequiredBeforePosting: true },
        }),
        {
          name: "get_billing_snapshot",
          args: {},
          result: {
            ok: true,
            available: true,
            isValid: true,
            evidence: normalizeAttorneyToolEvidence({
              toolName: "get_billing_snapshot",
              result: { ok: true, available: true, isValid: true },
            }),
          },
        },
      ],
      validationRetries: 2,
      validationFailures: ["platform_requirement_not_distinguished"],
    });
    expect(result.reply).toMatch(/^Yes\.[\s\S]*required[\s\S]*post a matter[\s\S]*already have one saved/i);
  });

  test("uses a natural verified fallback for a general hiring-process question", () => {
    const result = buildValidationSafeFallback({
      messageText: "How do I hire a paralegal?",
      evidencePlan: {
        requirements: [{ key: "workflow_readiness", reason: "authoritative platform workflow process" }],
      },
      toolOutputs: [
        workflowTrace("hiring", {
          ok: true,
          available: true,
          authoritativeWorkflow: true,
          requirements: {
            chargeTiming: "charged_when_hire_is_confirmed",
            postHireWorkflow: {
              matterStatus: "in_progress",
              fundingStatus: "funded",
            },
          },
          stages: {
            post_matter: { label: "Post a matter" },
            receive_applications: { label: "Receive applications" },
            invite_paralegal: { label: "Invite a paralegal" },
            pre_engagement: { label: "Request pre-engagement items" },
            hire_and_fund: { label: "Hire and fund a matter" },
          },
        }),
      ],
      validationRetries: 2,
      validationFailures: ["raw_evidence_fields_exposed"],
    });
    expect(result.reply).toMatch(/Post a matter, review the applications/i);
    expect(result.reply).not.toMatch(/Verified information|results title|results answer/i);
    expect(result.provider).toBe("openai_manager_safe_fallback");
  });

  test("rejects matter-financial answers grounded by the wrong successful tool", () => {
    const audit = auditManagerReply(
      managerReply({ reply: "The matter was $100.00." }),
      {
        messageText: "What was I charged for this matter?",
        conversationState: { activeEntity: { type: "case", id: "case-1", name: "Smith" } },
        toolOutputs: [
          { name: "get_case_details", result: { ok: true, available: true, totalAmount: 10000 } },
        ],
      }
    );
    expect(audit.valid).toBe(false);
    expect(audit.errors).toContain("missing_required_evidence:matter_financials");
  });

  test("requires every authoritative source for a compound account and policy question", () => {
    const base = {
      messageText: "Do I have a saved payment method, and do I need one before posting?",
      toolOutputs: [
        {
          name: "get_billing_snapshot",
          result: { ok: true, available: false, evidenceState: "absent" },
        },
      ],
    };
    expect(auditManagerReply(managerReply({ reply: "No—you do not have one saved." }), base).errors)
      .toContain("missing_required_evidence:workflow_readiness");

    const complete = validateManagerReply(
      managerReply({
        reply: "No—you don’t have a payment method saved. One is required before you can post a matter.",
        suggestions: [],
      }),
      {
        ...base,
        toolOutputs: [
          ...base.toolOutputs,
          {
            name: "get_attorney_workflow_readiness",
            result: {
              ok: true,
              available: true,
              authoritativeWorkflow: true,
              requirements: { paymentMethodRequiredBeforePosting: true },
            },
          },
        ],
      }
    );
    expect(complete?.reply).toMatch(/^No—/);
  });

  test("requires both requested financial dimensions and labels", () => {
    const context = {
      messageText: "both",
      conversationState: {
        activeEntity: { type: "case", id: "case-1", name: "Smith" },
        lastCapabilityIds: ["A15_case_financials"],
        lastRequestedDimensions: ["matter_financials"],
      },
      toolOutputs: [
        {
          name: "get_attorney_case_financials",
          result: {
            ok: true,
            available: true,
            totalAttorneyCharge: { formatted: "$122.00" },
            netParalegalPayout: { formatted: "$82.00" },
          },
        },
      ],
    };
    expect(validateManagerReply(managerReply({
      reply: "You were charged $122.00, and the paralegal received a net payout of $82.00.",
      suggestions: [],
    }), context)).not.toBeNull();
    const audit = auditManagerReply(managerReply({ reply: "The two amounts are $122.00 and $82.00." }), context);
    expect(audit.errors).toEqual(expect.arrayContaining([
      "attorney_charge_not_labeled",
      "paralegal_payout_not_labeled",
    ]));
  });

  test("distinguishes temporary tool failure from a verified absence", () => {
    const unavailable = validateManagerReply(
      managerReply({
        reply: "Your payment-method lookup is temporarily unavailable. Please try again.",
        suggestions: [],
      }),
      {
        messageText: "Do I have a payment method saved?",
        toolOutputs: [
          {
            name: "get_billing_snapshot",
            result: { ok: false, available: false, evidenceState: "temporarily_unavailable" },
          },
        ],
      }
    );
    expect(unavailable).not.toBeNull();
    expect(auditManagerReply(
      managerReply({
        reply: "Your payment-method lookup is temporarily unavailable. Please try again.",
        suggestions: ["Try again", "Open billing"],
      }),
      {
        messageText: "Do I have a payment method saved?",
        toolOutputs: [
          {
            name: "get_billing_snapshot",
            result: { ok: false, available: false, evidenceState: "temporarily_unavailable" },
          },
        ],
      }
    ).errors).toContain("limitation_has_multiple_next_steps");
    const falseAbsence = auditManagerReply(
      managerReply({ reply: "You do not have a payment method." }),
      {
        messageText: "Do I have a payment method saved?",
        toolOutputs: [
          {
            name: "get_billing_snapshot",
            result: { ok: false, available: false, evidenceState: "temporarily_unavailable" },
          },
        ],
      }
    );
    expect(falseAbsence.errors).toContain("unavailable_evidence_reported_as_absent");
  });

  test("blocks generic manual-review language, internal tool names, and overlong simple facts", () => {
    const evidence = [{ name: "get_my_case_overview", result: { ok: true, completedCount: 4 } }];
    expect(auditManagerReply(managerReply({ reply: "I’m sending this to the team for review now." }), {
      messageText: "How many cases did I complete?",
      toolOutputs: evidence,
    }).errors).toContain("forbidden_support_meta_claim");
    expect(auditManagerReply(managerReply({ reply: "The get_my_case_overview tool says 4." }), {
      messageText: "How many cases did I complete?",
      toolOutputs: evidence,
    }).errors).toContain("forbidden_support_meta_claim");
    const repaired = auditManagerReply(managerReply({
      reply: "You completed 4 cases. That is the current count. You can ask about them.",
    }), {
      messageText: "How many cases did I complete?",
      toolOutputs: evidence,
    });
    expect(repaired.valid).toBe(true);
    expect(repaired.warnings).toContain("style_repair_required");
    expect(repaired.data.reply).toBe("You completed 4 cases. That is the current count.");
  });

  test("accepts one focused clarification after an authoritative ambiguous lookup", () => {
    const answer = validateManagerReply(
      managerReply({
        reply: "Which Smith matter do you mean?",
        suggestions: [],
        activeTask: "CLARIFY",
        awaitingField: "case_reference",
        responseMode: "CLARIFY_ONCE",
        confidence: "low",
      }),
      {
        messageText: "What is the status of the Smith matter?",
        toolOutputs: [
          {
            name: "get_case_details",
            result: { ok: true, available: false, clarificationNeeded: true, evidenceState: "unknown" },
          },
        ],
      }
    );
    expect(answer).toEqual(expect.objectContaining({ responseMode: "CLARIFY_ONCE" }));
  });

  test("repairs an overlong inaccessible-matter clarification", () => {
    const audit = auditManagerReply(
      managerReply({
        reply: "I can’t access that matter. Which matter do you mean? Please provide its title.",
        suggestions: [],
        activeTask: "CLARIFY",
        awaitingField: "case_reference",
        responseMode: "CLARIFY_ONCE",
        confidence: "low",
      }),
      {
        messageText: "What is the status of that matter?",
        toolOutputs: [
          {
            name: "get_case_details",
            result: { ok: true, available: false, accessible: false, found: false, clarificationNeeded: true },
          },
        ],
      }
    );
    expect(audit.valid).toBe(true);
    expect(audit.warnings).toContain("style_repair_required");
    expect(audit.data.reply).toBe("I can’t access that matter. Which matter do you mean?");
  });

  test("orchestrates both tools for a compound question and stops with a complete answer", async () => {
    mockGetSupportManagerToolDefinitions.mockReturnValue([
      { type: "function", name: "get_billing_snapshot", description: "billing", parameters: {}, strict: true },
      { type: "function", name: "get_attorney_workflow_readiness", description: "policy", parameters: {}, strict: true },
    ]);
    mockExecuteSupportManagerTool.mockImplementation(async (name) =>
      name === "get_billing_snapshot"
        ? { ok: true, available: false, evidenceState: "absent" }
        : {
            ok: true,
            available: true,
            authoritativeWorkflow: true,
            requirements: { paymentMethodRequiredBeforePosting: true },
          }
    );
    const parse = jest
      .fn()
      .mockResolvedValueOnce({
        id: "compound_tools",
        output: [
          { type: "function_call", call_id: "billing", name: "get_billing_snapshot", arguments: "{}" },
          { type: "function_call", call_id: "policy", name: "get_attorney_workflow_readiness", arguments: "{}" },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        id: "compound_final",
        output: [],
        output_parsed: managerReply({
          reply: "No—you don’t have a payment method saved. One is required before posting.",
          suggestions: [],
        }),
        usage: {},
      });
    const result = await generateSupportManagerReply({
      messageText: "Do I have a saved payment method, and do I need one before posting?",
      user: { _id: "507f1f77bcf86cd799439011", role: "attorney" },
      client: { responses: { parse } },
    });
    expect(result.reply).toMatch(/^No—/);
    expect(mockExecuteSupportManagerTool).toHaveBeenCalledTimes(2);
    expect(result.telemetry.agentIterations).toBe(2);
  });

  test("instructions encode source precedence, corrections, and non-repetition", () => {
    const instructions = buildManagerInstructions("attorney");
    expect(instructions).toMatch(/evidence priority is: shared executable policy, live authorized/i);
    expect(instructions).toMatch(/newly named matter replaces the active matter/i);
    expect(instructions).toMatch(/do not ask the user to repeat/i);
    expect(instructions).toMatch(/stop as soon as you have enough evidence/i);
    expect(instructions).toMatch(/reuse information that is already present, current, and sufficient/i);
    expect(instructions).toMatch(/identifies a different matter/i);
    expect(instructions).toMatch(/earlier result failed or lacked the required facts/i);
    expect(instructions).toMatch(/complete workflow envelope/i);
    expect(instructions).toMatch(/single most-specific semantic capability/i);
    expect(instructions).toMatch(/prompt_like_untrusted/i);
  });

  test("instructions encode structural conversational selection without stored answers", () => {
    const instructions = buildManagerInstructions("attorney");
    expect(instructions).toMatch(/evidence as a menu, not a report/i);
    expect(instructions).toMatch(/first sentence must answer the question/i);
    expect(instructions).toMatch(/yes-or-no state or permission question/i);
    expect(instructions).toMatch(/next useful stage and stop there/i);
    expect(instructions).toMatch(/only the immediate working stage/i);
    expect(instructions).toMatch(/do not volunteer amounts, task counts, dates, deadlines/i);
    expect(instructions).toMatch(/latest user message controls relevance/i);
    expect(instructions).toMatch(/perform a relevance pass/i);
    expect(instructions).toMatch(/do not restate a direct permission answer as backend availability/i);
    expect(instructions).toMatch(/shortest natural unambiguous reference/i);
    expect(instructions).toMatch(/verified release does not prove.*reached.*bank/i);
    expect(instructions).toMatch(/suggestions are optional/i);
    expect(instructions).toMatch(/usually be zero or one/i);
    expect(instructions).not.toMatch(/okay so i hired her now what/i);
    expect(instructions).not.toMatch(/did mine get released yet/i);
  });
});
