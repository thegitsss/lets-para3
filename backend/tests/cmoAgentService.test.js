const {
  buildAgenticTopicPlan,
  evaluateAgenticQueueReadiness,
  selectAgenticLinkedInCompanyLane,
} = require("../services/marketing/cmoAgentService");

describe("CMO agent service", () => {
  test("does not select updates lane without explicit update signals", () => {
    const lane = selectAgenticLinkedInCompanyLane(
      {
        countsByLane: {
          platform_explanation: 2,
          standards_positioning: 2,
          updates_momentum: 0,
        },
      },
      { allowUpdates: false }
    );

    expect(lane).toBe("platform_explanation");
  });

  test("can select updates lane only when updates are explicitly allowed", () => {
    const lane = selectAgenticLinkedInCompanyLane(
      {
        countsByLane: {
          platform_explanation: 2,
          standards_positioning: 2,
          updates_momentum: 0,
        },
      },
      { allowUpdates: true }
    );

    expect(lane).toBe("updates_momentum");
  });

  test("suppresses agentic creation when pending review backlog exists", () => {
    const decision = evaluateAgenticQueueReadiness({
      cadence: { isHealthyMix: false },
      pendingReviewCount: 2,
      latestLinkedInPacket: null,
      selectedLane: "platform_explanation",
    });

    expect(decision).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "pending_review_backlog",
      })
    );
  });

  test("suppresses repeating the same lane too soon", () => {
    const decision = evaluateAgenticQueueReadiness({
      cadence: { isHealthyMix: false },
      pendingReviewCount: 0,
      latestLinkedInPacket: {
        contentLane: "platform_explanation",
        createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      },
      selectedLane: "platform_explanation",
    });

    expect(decision).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "repeat_lane_too_soon",
      })
    );
  });

  test("selects the strongest fact-backed Jr. CMO opportunity for the next topic", () => {
    const plan = buildAgenticTopicPlan({
      context: {
        positioningCards: [{ statement: "LPC is building for disciplined marketplace fit." }],
        distinctivenessCards: [],
        valueCards: [],
        factCards: [],
      },
      jrBriefing: {
        cadence: {
          suggestedNextLane: "standards_positioning",
          countsByLane: {
            platform_explanation: 2,
            standards_positioning: 0,
            updates_momentum: 0,
          },
        },
        facts: [
          {
            factKey: "fact-1",
            title: "Disciplined intake",
            statement: "LPC is defining quality and fit before trying to scale volume.",
            contentLaneHints: ["standards_positioning"],
          },
          {
            factKey: "fact-2",
            title: "Selective marketplace bar",
            statement: "The platform is being shaped around standards and selective fit.",
            contentLaneHints: ["standards_positioning"],
          },
        ],
        opportunities: [
          {
            opportunityKey: "fresh-signal:standards_positioning",
            opportunityType: "fresh_positioning",
            priority: "recommended",
            contentLane: "standards_positioning",
            title: "Fresh positioning support is available",
            summary: "Approved facts are available to support a standards and positioning post.",
            rationale: "The Jr. CMO has enough approved facts to support a stronger standards / positioning post right now.",
          },
        ],
      },
    });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: true,
        selectedLane: "standards_positioning",
        selectedOpportunity: expect.objectContaining({
          opportunityKey: "fresh-signal:standards_positioning",
        }),
        supportingFacts: expect.arrayContaining([
          expect.objectContaining({ factKey: "fact-1" }),
          expect.objectContaining({ factKey: "fact-2" }),
        ]),
      })
    );
  });

  test("allows updates only when update-grade fact support is strong enough", () => {
    const plan = buildAgenticTopicPlan({
      context: {
        positioningCards: [{ statement: "LPC keeps progress framing measured." }],
        distinctivenessCards: [],
        valueCards: [],
        factCards: [],
      },
      jrBriefing: {
        cadence: {
          suggestedNextLane: "updates_momentum",
          countsByLane: {
            platform_explanation: 2,
            standards_positioning: 2,
            updates_momentum: 0,
          },
        },
        facts: [
          {
            factKey: "update-1",
            title: "Workflow update",
            statement: "LPC rolled out an improved workflow review step this week.",
            contentLaneHints: ["updates_momentum"],
          },
          {
            factKey: "update-2",
            title: "Progress milestone",
            statement: "The team shipped a tighter approval flow and documented the milestone.",
            contentLaneHints: ["updates_momentum"],
          },
        ],
        opportunities: [
          {
            opportunityKey: "fresh-signal:updates_momentum",
            opportunityType: "fresh_update",
            priority: "recommended",
            contentLane: "updates_momentum",
            title: "Fresh momentum support is available",
            summary: "Approved facts are available to support a measured momentum update.",
            rationale: "The Jr. CMO has at least two update-grade facts, so a measured momentum post is now supportable.",
          },
        ],
      },
    });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: true,
        selectedLane: "updates_momentum",
        supportingFacts: expect.arrayContaining([
          expect.objectContaining({ factKey: "update-1" }),
          expect.objectContaining({ factKey: "update-2" }),
        ]),
      })
    );
  });
});
