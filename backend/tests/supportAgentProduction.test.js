const mockResponsesParse = jest.fn();

jest.mock("openai", () =>
  class MockOpenAI {
    constructor() {
      this.responses = { parse: mockResponsesParse };
      this.chat = { completions: { create: jest.fn() } };
    }
  }
);

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "test-production-support-key";

const { generateSupportConversationReply } = require("../ai/supportAgent");

describe("production support agent contract", () => {
  afterAll(() => {
    if (typeof originalOpenAiApiKey === "undefined") delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  });

  beforeEach(() => {
    mockResponsesParse.mockReset();
  });

  test("uses Responses structured output without storing requests and receives only sanitized page context", async () => {
    mockResponsesParse.mockResolvedValue({
      id: "resp_support_123",
      model: "gpt-5.6-terra",
      output_parsed: {
        reply: "The verified queue has two open tickets.",
        suggestions: ["Open Support Ops"],
        navigation: {
          ctaLabel: "Support Ops",
          ctaHref: "admin-dashboard.html#support-ops",
          inlineLinkText: "here",
        },
        category: "unknown",
        categoryLabel: "Admin operations",
        primaryAsk: "admin_operational_summary",
        activeTask: "FACT_LOOKUP",
        awaitingField: "",
        responseMode: "DIRECT_ANSWER",
        needsEscalation: false,
        escalationReason: "",
        paymentSubIntent: "",
        confidence: "high",
        urgency: "low",
        sentiment: "neutral",
        frustrationScore: 0,
        escalationPriority: "normal",
        detailLevel: "concise",
      },
      usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
    });

    const reply = await generateSupportConversationReply({
      messageText: "What needs attention?",
      userRole: "admin",
      pageContext: {
        pathname: "/admin-dashboard.html",
        search: "?token=must-not-leave-server",
        href: "https://example.test/admin-dashboard.html?token=must-not-leave-server",
        viewName: "admin-dashboard",
      },
      verifiedSupportFacts: { openTickets: 2 },
      serverDecision: { canonicalReply: "There are two open tickets." },
      safetyIdentifier: "lpc_safe_user",
    });

    expect(reply).toEqual(
      expect.objectContaining({
        reply: "The verified queue has two open tickets.",
        provider: "openai",
        telemetry: expect.objectContaining({ responseId: "resp_support_123", totalTokens: 160 }),
      })
    );
    expect(mockResponsesParse).toHaveBeenCalledTimes(1);
    const [request] = mockResponsesParse.mock.calls[0];
    expect(request).toEqual(
      expect.objectContaining({
        store: false,
        safety_identifier: "lpc_safe_user",
        reasoning: { effort: "low" },
        text: { format: expect.any(Object) },
      })
    );
    expect(request.instructions).toMatch(/LPC administrator/i);
    const prompt = JSON.parse(request.input.at(-1).content);
    expect(prompt.verifiedSupportFacts).toEqual({ openTickets: 2 });
    expect(prompt.pageContext).not.toHaveProperty("search");
    expect(prompt.pageContext).not.toHaveProperty("href");
  });
});
