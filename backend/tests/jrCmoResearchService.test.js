const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const MarketingDayContext = require("../models/MarketingDayContext");
const MarketingBrief = require("../models/MarketingBrief");
const MarketingEvaluation = require("../models/MarketingEvaluation");
const MarketingFact = require("../models/MarketingFact");
const MarketingOpportunity = require("../models/MarketingOpportunity");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const User = require("../models/User");
const SupportInsight = require("../models/SupportInsight");
const KnowledgeInsight = require("../models/KnowledgeInsight");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const {
  cleanupJrCmoLibrary,
  getJrCmoBriefing,
  refreshJrCmoLibrary,
} = require("../services/marketing/jrCmoResearchService");
const { recordPacketOutcomeEvaluation } = require("../services/marketing/evaluationService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "jr-cmo-research-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function createAdmin() {
  return User.create({
    firstName: "Admin",
    lastName: "Owner",
    email: "jr-cmo-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function seedKnowledge(admin) {
  const res = await request(app)
    .post("/api/admin/knowledge/sync")
    .set("Cookie", authCookieFor(admin))
    .send({});
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED = "false";
  await clearDatabase();
});

describe("Jr. CMO research service", () => {
  test("refresh builds the daily context, opportunity, fact, and weekly evaluation library", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    await SupportInsight.create({
      patternKey: "what-is-lpc",
      category: "platform_explainer",
      insightType: "confusion_pattern",
      title: "Support keeps seeing 'what is LPC?'",
      summary: "Users are still asking foundational questions about what LPC is and who it is for.",
      state: "active",
      repeatCount: 3,
      priority: "needs_review",
    });

    await KnowledgeInsight.create({
      sourceType: "manual",
      sourceId: "marketing-safe-update-1",
      title: "Approval workflow tightening is marketing-safe",
      summary: "A recent workflow update tightened approval handling and is safe for marketing planning.",
      audienceScopes: ["marketing_safe", "public_approved"],
      status: "promoted",
      tags: ["update", "workflow"],
    });

    const result = await refreshJrCmoLibrary();
    expect(result.dayContext).toEqual(
      expect.objectContaining({
        sourceMode: "internal_only",
        toneRecommendation: expect.any(String),
        status: "active",
      })
    );
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.opportunities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opportunityKey: expect.stringMatching(/^support-signal:/),
        }),
      ])
    );
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "knowledge_insight",
        }),
      ])
    );
    expect(result.evaluation).toEqual(
      expect.objectContaining({
        evaluationType: "weekly",
        status: "active",
      })
    );

    const briefing = await getJrCmoBriefing({ forceRefresh: false });
    expect(briefing.dayContext).toBeTruthy();
    expect(briefing.opportunities.length).toBeGreaterThan(0);
    expect(briefing.facts.length).toBeGreaterThan(0);

    expect(await MarketingDayContext.countDocuments({ status: "active" })).toBeGreaterThan(0);
    expect(await MarketingOpportunity.countDocuments({ status: "active" })).toBeGreaterThan(0);
    expect(await MarketingFact.countDocuments({ status: "active" })).toBeGreaterThan(0);
    expect(await MarketingEvaluation.countDocuments({ status: "active" })).toBeGreaterThan(0);
  });

  test("cleanup archives stale Jr. CMO library records", async () => {
    const staleDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);

    await MarketingDayContext.create({
      dayKey: "2025-01-01",
      calendarDate: staleDate,
      weekday: "Wednesday",
      toneRecommendation: "measured",
      status: "active",
      refreshedAt: staleDate,
      expiresAt: staleDate,
    });
    await MarketingOpportunity.create({
      opportunityKey: "stale-opportunity",
      opportunityType: "lane_gap",
      contentLane: "platform_explanation",
      title: "Stale opportunity",
      status: "active",
      lastSeenAt: staleDate,
      expiresAt: staleDate,
    });
    await MarketingFact.create({
      factKey: "stale-fact",
      sourceType: "knowledge_card",
      title: "Stale fact",
      status: "active",
      safetyStatus: "approved",
      lastReviewedAt: staleDate,
      expiresAt: staleDate,
    });
    await MarketingEvaluation.create({
      evaluationKey: "weekly:2025-01-01",
      evaluationType: "weekly",
      title: "Stale evaluation",
      status: "active",
      expiresAt: staleDate,
    });

    const cleanup = await cleanupJrCmoLibrary();
    expect(cleanup).toEqual(
      expect.objectContaining({
        archivedDayContexts: 1,
        archivedOpportunities: 1,
        archivedFacts: 1,
        archivedEvaluations: 1,
      })
    );

    expect((await MarketingDayContext.findOne({ dayKey: "2025-01-01" }).lean()).status).toBe("archived");
    expect((await MarketingOpportunity.findOne({ opportunityKey: "stale-opportunity" }).lean()).status).toBe("archived");
    const fact = await MarketingFact.findOne({ factKey: "stale-fact" }).lean();
    expect(fact.status).toBe("archived");
    expect(fact.safetyStatus).toBe("expired");
    expect((await MarketingEvaluation.findOne({ evaluationKey: "weekly:2025-01-01" }).lean()).status).toBe("archived");
  });

  test("stored briefing keeps cadence and queue state when read without refresh", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const brief = await MarketingBrief.create({
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      title: "Existing explainer brief",
      briefSummary: "Seed one explainer brief for the Jr. CMO library.",
      targetAudience: "approved attorneys and paralegals",
      objective: "Make the page worth following.",
      contentLane: "platform_explanation",
      requestedBy: { actorType: "agent", label: "Marketing CMO Agent" },
      approvalState: "in_queue",
    });

    await MarketingDraftPacket.create({
      briefId: brief._id,
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      packetVersion: 1,
      title: "Existing explainer packet",
      approvalState: "pending_review",
      contentLane: "platform_explanation",
      generatedBy: { actorType: "system", label: "Test Seeder" },
      channelDraft: {
        channel: "linkedin_company",
        contentLane: "platform_explanation",
        growthObjective: "Make the LPC page worth following.",
        primaryHook: "Why legal operations teams need a calmer way to match.",
        alternateHooks: ["What LPC is actually building for attorneys and paralegals."],
        coreMessage: "LPC is building a premium, standards-driven matching workflow.",
        followOrientedCtaOptions: ["Follow LPC for practical platform explainers."],
        whyThisHelpsPageGrowth: "It gives the page a repeatable explainer role.",
      },
    });

    await refreshJrCmoLibrary();
    const briefing = await getJrCmoBriefing({ forceRefresh: false });

    expect(briefing.cadence.countsByLane.platform_explanation).toBe(1);
    expect(briefing.pendingReviewCount).toBe(1);
    expect(briefing.opportunities[0]).toEqual(
      expect.objectContaining({
        priority: "hold",
      })
    );
  });

  test("weekly briefing incorporates packet outcome learning memory", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const brief = await MarketingBrief.create({
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      title: "Weekly learning brief",
      briefSummary: "Seed weekly learning.",
      targetAudience: "approved attorneys and paralegals",
      objective: "Make the page worth following.",
      contentLane: "platform_explanation",
      requestedBy: { actorType: "agent", label: "Marketing CMO Agent" },
      approvalState: "in_queue",
    });

    const packet = await MarketingDraftPacket.create({
      briefId: brief._id,
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      packetVersion: 1,
      approvalState: "rejected",
      contentLane: "platform_explanation",
      generatedBy: { actorType: "system", label: "Test Seeder" },
      channelDraft: {
        channel: "linkedin_company",
        primaryHook: "What LPC is building should be clear enough to be worth following.",
      },
    });

    await recordPacketOutcomeEvaluation({
      packet,
      brief,
      decision: "rejected",
      note: "Too generic and too promotional.",
      actor: { actorType: "user", label: "Samantha" },
    });

    const result = await refreshJrCmoLibrary();

    expect(result.evaluation.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/thin or generic/i),
        expect.stringMatching(/more restrained/i),
      ])
    );
  });
});
