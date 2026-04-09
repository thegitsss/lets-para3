const {
  buildLinkedInCompanyPacketStrategy,
  summarizeLinkedInCompanyCadence,
} = require("../services/marketing/linkedinCompanyStrategy");

function buildContext() {
  return {
    positioningCards: [
      {
        key: "platform_lpc_core_explainer",
        title: "What LPC Is",
        statement: "LPC is building a disciplined way for attorneys and paralegals to connect around serious legal work.",
      },
    ],
    distinctivenessCards: [
      {
        key: "platform_lpc_distinctiveness",
        title: "Why LPC Is Distinct",
        statement: "LPC is not trying to be a generic social feed for legal professionals.",
      },
    ],
    valueCards: [
      {
        key: "platform_lpc_value",
        title: "Value",
        statement: "Clear fit, expectations, and workflow discipline matter for credible legal work.",
      },
    ],
    factCards: [
      {
        key: "platform_lpc_approval_fact",
        title: "Approval Fact",
        statement: "The workflow remains approval-based and review-minded.",
      },
    ],
  };
}

describe("LinkedIn company strategy", () => {
  test("standards lane strategy includes lane, growth objective, positioning blocks, and restrained follow CTAs", () => {
    const strategy = buildLinkedInCompanyPacketStrategy({
      brief: {
        title: "LPC standards post",
        targetAudience: "attorneys and paralegals",
        objective: "Build credibility by explaining LPC standards and why the platform is distinct.",
        briefSummary: "Why LPC is taking a standards-first approach.",
        contentLane: "standards_positioning",
      },
      context: buildContext(),
    });

    expect(strategy.contentLane).toBe("standards_positioning");
    expect(strategy.growthObjective).toMatch(/credibility/i);
    expect(strategy.approvedPositioningBlocksUsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "platform_lpc_core_explainer" }),
        expect.objectContaining({ key: "platform_lpc_distinctiveness" }),
      ])
    );
    expect(strategy.ctaOptions.length).toBeGreaterThan(0);
    strategy.ctaOptions.forEach((cta) => {
      expect(cta).toMatch(/follow/i);
      expect(cta).not.toMatch(/guarantee|viral|dominate|best|must-read|game-changing|revolutionary/i);
    });
  });

  test("updates lane strategy shifts to return-visit framing when update facts are present", () => {
    const strategy = buildLinkedInCompanyPacketStrategy({
      brief: {
        title: "LPC progress post",
        targetAudience: "approved attorneys",
        objective: "Share a measured product update.",
        briefSummary: "A small but meaningful product update.",
        updateFacts: ["We tightened review around LinkedIn company draft packets."],
      },
      context: buildContext(),
    });

    expect(strategy.contentLane).toBe("updates_momentum");
    expect(strategy.growthObjective).toMatch(/come back/i);
    expect(strategy.primaryHook).toMatch(/platform update/i);
    expect(strategy.whyThisHelpsPageGrowth).toMatch(/come back|return/i);
  });

  test("cadence guidance recommends the missing lane in the recent queue", () => {
    const cadence = summarizeLinkedInCompanyCadence([
      { workflowType: "linkedin_company_post", contentLane: "platform_explanation" },
      { workflowType: "linkedin_company_post", contentLane: "platform_explanation" },
      { workflowType: "linkedin_company_post", contentLane: "updates_momentum" },
    ]);

    expect(cadence.countsByLane).toEqual(
      expect.objectContaining({
        platform_explanation: 2,
        standards_positioning: 0,
        updates_momentum: 1,
      })
    );
    expect(cadence.suggestedNextLane).toBe("standards_positioning");
    expect(cadence.recommendations.join(" ")).toMatch(/missing/i);
  });
});
