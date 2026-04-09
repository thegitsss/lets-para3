const MarketingBrief = require("../models/MarketingBrief");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const MarketingEvaluation = require("../models/MarketingEvaluation");
const {
  buildWeeklyEvaluation,
  recordPacketOutcomeEvaluation,
} = require("../services/marketing/evaluationService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Marketing evaluation service", () => {
  test("records packet outcome evaluations with reusable learning signals", async () => {
    const brief = await MarketingBrief.create({
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      title: "Explainer brief",
      briefSummary: "Explain what LPC is.",
      targetAudience: "approved attorneys and paralegals",
      objective: "Make the page worth following.",
      contentLane: "platform_explanation",
      approvalState: "in_queue",
      requestedBy: { actorType: "agent", label: "Marketing CMO Agent" },
    });

    const packet = await MarketingDraftPacket.create({
      briefId: brief._id,
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      packetVersion: 1,
      approvalState: "pending_review",
      briefSummary: brief.briefSummary,
      targetAudience: brief.targetAudience,
      contentLane: "platform_explanation",
      growthObjective: "Make the LPC page worth following through clear platform explanation.",
      whyThisHelpsPageGrowth: "It gives the page a repeatable explanatory role.",
      generatedBy: { actorType: "agent", label: "Marketing Draft Service" },
      channelDraft: {
        channel: "linkedin_company",
        primaryHook: "What LPC is building should be clear enough to be worth following.",
      },
    });

    const evaluation = await recordPacketOutcomeEvaluation({
      packet,
      brief,
      decision: "rejected",
      note: "Too generic and not grounded in enough concrete facts.",
      actor: { actorType: "user", label: "Samantha" },
    });

    expect(evaluation).toEqual(
      expect.objectContaining({
        evaluationType: "packet_outcome",
        outcome: "rejected",
        contentLane: "platform_explanation",
        score: expect.any(Number),
      })
    );
    expect(evaluation.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/concrete approved facts/i),
      ])
    );
    expect(await MarketingEvaluation.countDocuments({ evaluationType: "packet_outcome" })).toBe(1);
  });

  test("weekly evaluation learns from packet outcomes and reviewer notes", () => {
    const weekly = buildWeeklyEvaluation({
      packets: [
        { approvalState: "approved" },
        { approvalState: "rejected" },
        { approvalState: "pending_review" },
      ],
      outcomeEvaluations: [
        {
          outcome: "approved",
          contentLane: "standards_positioning",
          decisionNote: "Strong and credible.",
        },
        {
          outcome: "rejected",
          contentLane: "platform_explanation",
          decisionNote: "Too generic and too promotional.",
        },
      ],
    });

    expect(weekly.findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/approved, 1 pending review, and 1 rejected/i),
        expect.stringMatching(/1 packet outcome evaluations were positive and 1 were negative/i),
      ])
    );
    expect(weekly.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Recent approvals favor standards \/ positioning/i),
        expect.stringMatching(/thin or generic/i),
        expect.stringMatching(/more restrained, premium tone/i),
      ])
    );
  });
});
