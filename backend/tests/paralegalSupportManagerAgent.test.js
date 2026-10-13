process.env.STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "sk_test_package9_paralegal_manager";

const SupportMessage = require("../models/SupportMessage");
const {
  PARALEGAL_ROLLOUT_CONTRACT_VERSION,
} = require("../services/support/paralegalRolloutService");
const {
  generateParalegalSupportManagerReply,
  selectParalegalManagerToolsForPlan,
} = require("../ai/paralegalSupportManagerAgent");

const rolloutEnv = {
  OPENAI_SUPPORT_MANAGER_ENABLED: "true",
  OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
  OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "100",
  OPENAI_PARALEGAL_LEGACY_FALLBACK: "false",
};

const user = {
  _id: "507f1f77bcf86cd799439021",
  email: "manager-paralegal@package9.invalid",
  role: "paralegal",
};

function managerAnswer(overrides = {}) {
  return {
    reply: "You have 5 assigned matters.",
    suggestions: [],
    navigation: null,
    primaryAsk: "assigned_matter_overview",
    activeTask: "FACT_LOOKUP",
    awaitingField: "",
    responseMode: "DIRECT_ANSWER",
    confidence: "high",
    detailLevel: "concise",
    ...overrides,
  };
}

function overviewResult(observedAt = new Date().toISOString()) {
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    totalCount: 5,
    activeCount: 3,
    completedCount: 2,
    items: [],
    evidence: {
      capabilityId: "P01_assigned_overview",
      state: "verified",
      authorized: true,
      observedAt,
      subjectType: "account",
      subjectId: String(user._id),
      facts: [
        { key: "totalCount", value: 5 },
        { key: "activeCount", value: 3 },
        { key: "completedCount", value: 2 },
      ],
      missingFacts: [],
    },
  };
}

function routingCall({
  callId = "call_overview",
  name = "get_paralegal_case_overview",
  args = { status_scope: "all" },
} = {}) {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    parsed_arguments: args,
  };
}

function routingResponse(output = [routingCall()]) {
  return {
    id: "resp_paralegal_routing",
    model: "gpt-5.6-terra",
    output,
    usage: { input_tokens: 80, output_tokens: 12, total_tokens: 92 },
  };
}

function answerResponse(answer = managerAnswer(), id = "resp_paralegal_answer") {
  return {
    id,
    model: "gpt-5.6-terra",
    output: [],
    output_parsed: answer,
    usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
  };
}

describe("paralegal Package 9 support manager", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("runs planning, least-privilege tool execution, generation, validation, UI filtering, and telemetry", async () => {
    const create = jest.fn().mockResolvedValue(routingResponse());
    const parse = jest.fn().mockResolvedValue(answerResponse());
    const toolExecutor = jest.fn().mockResolvedValue(overviewResult());

    const result = await generateParalegalSupportManagerReply({
      messageText: "How many assigned matters do I have?",
      user,
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        search: "?token=do-not-send",
      },
      client: { responses: { create, parse } },
      toolExecutor,
      rolloutEnv,
    });

    expect(result).toEqual(
      expect.objectContaining({
        reply: "You have 5 assigned matters.",
        provider: "openai_manager_paralegal",
        grounded: true,
        supportFacts: expect.objectContaining({
          evidenceStatus: "verified",
          capabilityIds: ["P01_assigned_overview"],
        }),
        telemetry: expect.objectContaining({
          role: "paralegal",
          managerAvailable: true,
          routingAttempts: 1,
          generationAttempts: 1,
          validationRetries: 0,
          validationExhausted: false,
          rollout: expect.objectContaining({
            contractVersion: PARALEGAL_ROLLOUT_CONTRACT_VERSION,
            rolloutStage: "full",
            rolloutPercent: 100,
          }),
          toolCalls: [
            expect.objectContaining({
              name: "get_paralegal_case_overview",
              capabilityId: "P01_assigned_overview",
              ok: true,
              evidenceState: "verified",
            }),
          ],
        }),
      })
    );
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "get_paralegal_case_overview",
        args: { status_scope: "all" },
        context: expect.objectContaining({ user }),
      })
    );
    expect(create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        store: false,
        metadata: {
          feature: "lpc_paralegal_support_manager_routing",
          role: "paralegal",
        },
        tools: [
          expect.objectContaining({ name: "get_paralegal_case_overview" }),
        ],
      })
    );
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain("do-not-send");
    expect(parse.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        store: false,
        text: { format: expect.any(Object) },
        metadata: {
          feature: "lpc_paralegal_support_manager_answer",
          role: "paralegal",
        },
      })
    );
  });

  test("never exposes the paralegal manager to attorney or admin roles", async () => {
    const create = jest.fn();
    const parse = jest.fn();
    for (const role of ["attorney", "admin"]) {
      await expect(
        generateParalegalSupportManagerReply({
          messageText: "What needs attention?",
          user: { ...user, role },
          client: { responses: { create, parse } },
          rolloutEnv,
        })
      ).resolves.toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  test("honors the paralegal manager kill switch before making a model request", async () => {
    const create = jest.fn();
    const parse = jest.fn();
    await expect(
      generateParalegalSupportManagerReply({
        messageText: "How many matters do I have?",
        user,
        client: { responses: { create, parse } },
        rolloutEnv: {
          ...rolloutEnv,
          OPENAI_PARALEGAL_MANAGER_ENABLED: "false",
        },
      })
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  test("offers only the tools selected by the structural evidence plan", () => {
    const selected = selectParalegalManagerToolsForPlan(
      [
        { name: "get_paralegal_case_workspace" },
        { name: "get_paralegal_case_financials" },
        { name: "search_lpc_knowledge" },
        { name: "find_paralegal_navigation_destination" },
      ],
      {
        requirements: [
          {
            key: "workspace",
            anyOf: ["get_paralegal_case_workspace"],
          },
          {
            key: "matter_financials",
            anyOf: ["get_paralegal_case_financials"],
          },
        ],
      }
    );
    expect(selected.map((tool) => tool.name)).toEqual([
      "get_paralegal_case_workspace",
      "get_paralegal_case_financials",
    ]);
  });

  test("blocks repeated tool execution in the same turn", async () => {
    const create = jest.fn().mockResolvedValue(
      routingResponse([
        routingCall({ callId: "first" }),
        routingCall({ callId: "duplicate" }),
      ])
    );
    const parse = jest.fn().mockResolvedValue(answerResponse());
    const toolExecutor = jest.fn().mockResolvedValue(overviewResult());
    const result = await generateParalegalSupportManagerReply({
      messageText: "How many assigned matters do I have?",
      user,
      client: { responses: { create, parse } },
      toolExecutor,
      rolloutEnv,
    });
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result.telemetry.routingWarnings).toContain("repeated_tool_call_blocked");
  });

  test("reuses fresh complete evidence for the same subject without another tool-selection call", async () => {
    const now = Date.parse("2026-07-23T15:00:00.000Z");
    const conversationId = "507f1f77bcf86cd799439099";
    jest.spyOn(SupportMessage, "find").mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              sender: "assistant",
              text: "You have 5 assigned matters.",
              metadata: {
                supportFacts: {
                  toolEvidence: [
                    {
                      name: "get_paralegal_case_overview",
                      args: { status_scope: "all" },
                      result: overviewResult("2026-07-23T14:59:50.000Z"),
                    },
                  ],
                },
              },
            },
            {
              sender: "user",
              text: "How many assigned matters do I have?",
              metadata: {},
            },
          ],
        }),
      }),
    });
    const create = jest.fn();
    const parse = jest.fn().mockResolvedValue(answerResponse());
    const toolExecutor = jest.fn();
    const result = await generateParalegalSupportManagerReply({
      messageText: "and how many are active?",
      user,
      conversationId,
      conversationState: {
        lastCapabilityIds: ["P01_assigned_overview"],
        lastRequestedDimensions: ["status"],
      },
      client: { responses: { create, parse } },
      toolExecutor,
      rolloutEnv,
      now,
    });
    expect(create).not.toHaveBeenCalled();
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result.telemetry.reusedEvidenceCount).toBe(1);
    expect(result.telemetry.toolCalls).toEqual([]);
  });

  test("retries an invalid answer and shows only the corrected validated response", async () => {
    const create = jest.fn().mockResolvedValue(routingResponse());
    const parse = jest
      .fn()
      .mockResolvedValueOnce(
        answerResponse(
          managerAnswer({
            reply:
              "Verified information: results title: assigned overview; results answer: 5.",
          }),
          "resp_invalid"
        )
      )
      .mockResolvedValueOnce(answerResponse(managerAnswer(), "resp_corrected"));
    const result = await generateParalegalSupportManagerReply({
      messageText: "How many assigned matters do I have?",
      user,
      client: { responses: { create, parse } },
      toolExecutor: jest.fn().mockResolvedValue(overviewResult()),
      rolloutEnv,
    });
    expect(result.reply).toBe("You have 5 assigned matters.");
    expect(result.reply).not.toMatch(/verified information|results title/i);
    expect(result.telemetry.validationRetries).toBe(1);
    expect(result.telemetry.retryOutcome).toBe("corrected");
  });

  test("uses the evidence-backed safe fallback after bounded validation exhaustion", async () => {
    const create = jest.fn().mockResolvedValue(routingResponse());
    const parse = jest.fn().mockResolvedValue(
      answerResponse(
        managerAnswer({
          reply:
            "Verified information: results title: assigned overview; results answer: 5.",
        })
      )
    );
    const result = await generateParalegalSupportManagerReply({
      messageText: "How many assigned matters do I have?",
      user,
      client: { responses: { create, parse } },
      toolExecutor: jest.fn().mockResolvedValue(overviewResult()),
      rolloutEnv,
    });
    expect(result.provider).toBe("openai_manager_paralegal_safe_fallback");
    expect(result.reply).not.toMatch(/verified information|results title|tool/i);
    expect(result.telemetry.validationExhausted).toBe(true);
    expect(result.telemetry.retryOutcome).toBe("safe_fallback");
  });

  test("fails closed when the routing model will not call required evidence tools", async () => {
    const create = jest.fn().mockResolvedValue(routingResponse([]));
    const parse = jest.fn();
    const toolExecutor = jest.fn();
    await expect(
      generateParalegalSupportManagerReply({
        messageText: "How many assigned matters do I have?",
        user,
        client: { responses: { create, parse } },
        toolExecutor,
        rolloutEnv,
      })
    ).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(3);
    expect(parse).not.toHaveBeenCalled();
    expect(toolExecutor).not.toHaveBeenCalled();
  });
});
