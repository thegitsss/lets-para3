const {
  sanitizeParalegalResponseUi,
  stripLinks,
  suggestionIsRelevant,
} = require("../ai/paralegalResponseUiPolicy");

const navigationOutput = {
  name: "find_paralegal_navigation_destination",
  result: {
    ok: true,
    available: true,
    ctaLabel: "Contact Us",
    ctaHref: "contact.html",
  },
};

describe("paralegal response UI policy", () => {
  test("shows one verified action and removes its duplicate inline link", () => {
    const result = sanitizeParalegalResponseUi({
      reply: "The support team responds promptly. [Contact Us](contact.html)",
      messageText: "I need a human",
      toolOutputs: [navigationOutput],
      navigation: { ctaLabel: "Contact Us", ctaHref: "contact.html" },
      suggestions: ["Contact Us", "Open help"],
    });
    expect(result.reply).toBe("The support team responds promptly. Contact Us");
    expect(result.navigation).toEqual({ ctaLabel: "Contact Us", ctaHref: "contact.html" });
    expect(result.suggestions).toEqual([]);
    expect(result.reviewCard).toBeNull();
  });

  test("removes unverified navigation and keeps at most one relevant suggestion", () => {
    const result = sanitizeParalegalResponseUi({
      reply: "Your payout setup is incomplete.",
      messageText: "where are my payout settings?",
      toolOutputs: [],
      navigation: { ctaLabel: "Admin billing", ctaHref: "admin.html" },
      suggestions: ["Payout settings", "Post a case", "Billing help"],
    });
    expect(result.navigation).toBeNull();
    expect(result.suggestions).toEqual(["Payout settings"]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "unsupported_navigation_removed",
      "suggestions_filtered",
    ]));
  });

  test("allows multiple choices only for a tested required clarification", () => {
    const result = sanitizeParalegalResponseUi({
      reply: "Which matter do you mean?",
      clarification: {
        required: true,
        question: "Which matter do you mean?",
        choices: ["Smith", "Smith Estate", "Jones"],
      },
      suggestions: ["Unrelated"],
    });
    expect(result.suggestions).toEqual(["Smith", "Smith Estate", "Jones"]);
  });

  test("suppresses a review card without proof of an executed escalation", () => {
    const unverified = sanitizeParalegalResponseUi({
      reply: "Contact the team.",
      escalation: { reason: "request_human_help", available: true },
    });
    expect(unverified.reviewCard).toBeNull();

    const executed = sanitizeParalegalResponseUi({
      reply: "Your request was created.",
      escalation: {
        reason: "request_human_help",
        executed: true,
        referenceId: "support-123",
      },
    });
    expect(executed.reviewCard).toEqual({
      reason: "request_human_help",
      referenceId: "support-123",
    });
  });

  test("strips markdown and raw web links without changing ordinary prose", () => {
    expect(stripLinks("Use [Contact Us](contact.html) or https://example.com now."))
      .toBe("Use Contact Us or now.");
    expect(suggestionIsRelevant("Payout settings", "Where are my payout settings?")).toBe(true);
    expect(suggestionIsRelevant("Post a case", "Where are my payout settings?")).toBe(false);
  });
});
