const {
  auditParalegalSemanticResponse,
  extractDateClaims,
  repairParalegalResponse,
} = require("../ai/paralegalResponseValidator");

const plan = {
  requirements: [{ key: "matter_financials", anyOf: ["get_paralegal_case_financials"] }],
};

const financialOutput = {
  name: "get_paralegal_case_financials",
  result: {
    ok: true,
    available: true,
    evidenceState: "verified",
    evidence: {
      capabilityId: "P17_matter_financials",
      authorized: true,
      facts: [
        { key: "gross.formatted", value: "$100.00" },
        { key: "platformFee.formatted", value: "$20.00" },
        { key: "net.formatted", value: "$80.00" },
      ],
    },
  },
};

describe("paralegal semantic response validator", () => {
  test("rejects raw evidence and internal fields", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "Verified information: results title: payout; stripeAccountId is acct_123",
      messageText: "what was my payout?",
      toolOutputs: [financialOutput],
      evidencePlan: plan,
    });
    expect(errors).toEqual(expect.arrayContaining(["raw_evidence_leak", "internal_field_leak"]));
  });

  test("rejects attorney billing leakage", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "The attorney platform fee was $22.00.",
      messageText: "what is my payout?",
      toolOutputs: [financialOutput],
      evidencePlan: plan,
    });
    expect(errors).toContain("attorney_financial_data_out_of_scope");
  });

  test("rejects an external bank receipt claim without processor evidence", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "The money reached your bank account.",
      messageText: "has it hit my bank?",
      toolOutputs: [financialOutput],
      evidencePlan: plan,
    });
    expect(errors).toContain("unsupported_bank_receipt_claim");
  });

  test("accepts an explicit bank-receipt limitation without treating it as receipt confirmation", () => {
    const replies = [
      "I can’t confirm that the payout hit your bank.",
      "LPC records the funds as released, but that doesn’t confirm they reached your bank.",
      "Whether the payout reached your bank is not confirmed.",
    ];
    for (const reply of replies) {
      const errors = auditParalegalSemanticResponse({
        reply,
        messageText: "has it hit my bank?",
        toolOutputs: [financialOutput],
        evidencePlan: plan,
      });
      expect(errors).not.toContain("unsupported_bank_receipt_claim");
    }
  });

  test("rejects false mutations, handoffs, and unsupported money", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "I accepted it and I’m sending this to the team. Your payout is $95.00.",
      messageText: "accept it and tell me my payout",
      toolOutputs: [financialOutput],
      evidencePlan: plan,
    });
    expect(errors).toEqual(expect.arrayContaining([
      "false_action_or_handoff_claim",
      "unsupported_monetary_claim",
    ]));
  });

  test("accepts a concise answer fully supported by authorized evidence", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "The gross amount is $100.00, the paralegal platform fee is $20.00, and your net payout is $80.00.",
      messageText: "what is the gross fee and net for this matter?",
      toolOutputs: [financialOutput],
      evidencePlan: plan,
      suggestions: ["Open payouts"],
    });
    expect(errors).toEqual([]);
  });

  test("repairs raw evidence labels without inventing facts", () => {
    expect(repairParalegalResponse("Verified information: results answer: Your payout is ready."))
      .toBe("Your payout is ready.");
  });

  test("rejects unsupported dates, names, statuses, and fee percentages", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "The Smith matter is completed, attorney Jane Doe is assigned, and the deadline is August 9, 2026. The fee is 25%.",
      messageText: "tell me the matter details",
      toolOutputs: [{
        name: "get_paralegal_case_workspace",
        result: {
          ok: true,
          available: true,
          evidenceState: "verified",
          evidence: {
            capabilityId: "P02_matter_details",
            authorized: true,
            facts: [
              { key: "title", value: "Jones" },
              { key: "status", value: "in progress" },
              { key: "attorneyName", value: "Alex Rivera" },
              { key: "deadline", value: "2026-08-10T00:00:00.000Z" },
              { key: "platformFee.percent", value: 20 },
            ],
          },
        },
      }],
      evidencePlan: {
        requirements: [{ key: "workspace", anyOf: ["get_paralegal_case_workspace"] }],
        responseShape: { maximumSentences: 5, maximumClarifyingQuestions: 1 },
      },
    });
    expect(errors).toEqual(expect.arrayContaining([
      "unsupported_date_claim",
      "unsupported_name_claim",
      "unsupported_status_claim",
      "unsupported_fee_claim",
    ]));
  });

  test("accepts supported date, name, status, and fee claims", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "The Jones matter is in progress with attorney Alex Rivera. Its deadline is August 10, 2026, and the paralegal platform fee is 20%.",
      messageText: "what is the status, attorney, deadline, and fee?",
      toolOutputs: [{
        name: "get_paralegal_case_workspace",
        result: {
          ok: true,
          available: true,
          evidenceState: "verified",
          evidence: {
            capabilityId: "P02_matter_details",
            authorized: true,
            facts: [
              { key: "title", value: "Jones" },
              { key: "status", value: "in progress" },
              { key: "attorneyName", value: "Alex Rivera" },
              { key: "deadline", value: "2026-08-10T00:00:00.000Z" },
              { key: "platformFee.percent", value: 20 },
            ],
          },
        },
      }],
      evidencePlan: {
        requirements: [{ key: "workspace", anyOf: ["get_paralegal_case_workspace"] }],
        responseShape: { maximumSentences: 5, maximumClarifyingQuestions: 1 },
      },
    });
    expect(errors).toEqual([]);
  });

  test("keeps workflow and authorization claims tied to their boolean evidence", () => {
    const output = {
      name: "get_paralegal_messaging_state",
      result: {
        ok: true,
        available: true,
        evidenceState: "verified",
        evidence: {
          capabilityId: "P13_message_activity",
          authorized: true,
          facts: [
            { key: "canSend", value: false },
            { key: "blockers", value: ["matter_read_only"] },
          ],
        },
      },
    };
    expect(auditParalegalSemanticResponse({
      reply: "You can message the attorney now.",
      messageText: "can i message her?",
      toolOutputs: [output],
      evidencePlan: {
        requirements: [{ key: "messages", anyOf: ["get_paralegal_messaging_state"] }],
      },
    })).toContain("unsupported_messaging_permission_claim");
    expect(auditParalegalSemanticResponse({
      reply: "You can’t send a message because the matter is read-only.",
      messageText: "can i message her?",
      toolOutputs: [output],
      evidencePlan: {
        requirements: [{ key: "messages", anyOf: ["get_paralegal_messaging_state"] }],
      },
    })).toEqual([]);
    const allowedOutput = JSON.parse(JSON.stringify(output));
    allowedOutput.result.evidence.facts = [{ key: "canSend", value: true }];
    expect(auditParalegalSemanticResponse({
      reply: "You can message the attorney now.",
      messageText: "can i message her?",
      toolOutputs: [allowedOutput],
      evidencePlan: {
        requirements: [{ key: "messages", anyOf: ["get_paralegal_messaging_state"] }],
      },
    })).toEqual([]);
  });

  test("validates profile availability, visibility, and security claims", () => {
    const output = {
      name: "get_paralegal_account_snapshot",
      result: {
        ok: true,
        available: true,
        evidenceState: "verified",
        evidence: {
          capabilityId: "P23_profile",
          authorized: true,
          facts: [
            { key: "profile.resumePresent", value: true },
            { key: "profile.hidden", value: false },
            { key: "security.twoFactorEnabled", value: true },
          ],
        },
      },
    };
    expect(auditParalegalSemanticResponse({
      reply: "Your resume is on file, your profile is visible, and two-factor authentication is enabled.",
      messageText: "is my resume there and is my profile visible and secure?",
      toolOutputs: [output],
      evidencePlan: {
        requirements: [{ key: "account", anyOf: ["get_paralegal_account_snapshot"] }],
        responseShape: { maximumSentences: 3 },
      },
    })).toEqual([]);
    expect(auditParalegalSemanticResponse({
      reply: "Your profile is hidden.",
      messageText: "is my profile visible?",
      toolOutputs: [output],
      evidencePlan: {
        requirements: [{ key: "account", anyOf: ["get_paralegal_account_snapshot"] }],
      },
    })).toContain("unsupported_visibility_claim");
  });

  test("requires truthful limitations for unavailable and unauthorized evidence", () => {
    const unavailable = {
      name: "get_paralegal_case_workspace",
      result: {
        ok: false,
        available: false,
        evidenceState: "temporarily_unavailable",
        evidence: { state: "temporarily_unavailable", authorized: true, facts: [] },
      },
    };
    expect(auditParalegalSemanticResponse({
      reply: "Your matter is active.",
      messageText: "is my matter active?",
      toolOutputs: [unavailable],
      evidencePlan: {
        requirements: [{ key: "workspace", anyOf: ["get_paralegal_case_workspace"] }],
      },
    })).toEqual(expect.arrayContaining([
      "unavailable_evidence_used_as_fact",
      "direct_factual_answer_without_successful_tool_evidence",
    ]));
    expect(auditParalegalSemanticResponse({
      reply: "I can’t verify the matter status right now. Please try again shortly.",
      messageText: "is my matter active?",
      toolOutputs: [unavailable],
      evidencePlan: {
        requirements: [{ key: "workspace", anyOf: ["get_paralegal_case_workspace"] }],
      },
    })).toEqual([]);
  });

  test("requires every compound answer section and enforces restrained UI", () => {
    const errors = auditParalegalSemanticResponse({
      reply: "Your matter is in progress. [Open payouts](profile-settings.html)",
      messageText: "what is the matter status and payout amount?",
      toolOutputs: [{
        name: "get_paralegal_case_workspace",
        result: {
          ok: true,
          available: true,
          evidenceState: "verified",
          evidence: {
            capabilityId: "P02_matter_details",
            authorized: true,
            facts: [{ key: "status", value: "in progress" }],
          },
        },
      }, {
        name: "find_paralegal_navigation_destination",
        result: {
          ok: true,
          available: true,
          ctaLabel: "Payout settings",
          ctaHref: "profile-settings.html",
          evidenceState: "verified",
          evidence: { capabilityId: "P30_navigation", authorized: true, facts: [] },
        },
      }],
      evidencePlan: {
        requirements: [
          { key: "workspace", anyOf: ["get_paralegal_case_workspace"] },
          { key: "matter_financials", anyOf: ["get_paralegal_case_financials"] },
        ],
        responseShape: { maximumSentences: 5, maximumClarifyingQuestions: 1 },
      },
      navigation: { ctaLabel: "Payout settings", ctaHref: "profile-settings.html" },
      suggestions: ["Check the payout", "Open payouts"],
      reviewCard: { reason: "manual_review" },
    });
    expect(errors).toEqual(expect.arrayContaining([
      "missing_answer_section:matter_financials",
      "too_many_suggestions",
      "suggestion_with_navigation",
      "duplicate_inline_and_button_link",
      "manual_review_card_without_executed_escalation",
    ]));
  });

  test("normalizes supported date formats before comparison", () => {
    expect(extractDateClaims("August 10th, 2026 and 2026-08-10")).toEqual(["2026-08-10"]);
  });
});
