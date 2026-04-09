const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");

const User = require("../models/User");
const KnowledgeItem = require("../models/KnowledgeItem");
const KnowledgeRevision = require("../models/KnowledgeRevision");
const ApprovalTask = require("../models/ApprovalTask");
const MarketingBrief = require("../models/MarketingBrief");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const MarketingPublishAttempt = require("../models/MarketingPublishAttempt");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminMarketingRouter = require("../routes/adminMarketing");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "knowledge-marketing-phase1-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use("/api/admin/marketing", adminMarketingRouter);
  instance.use("/api/admin/ai", aiAdminRouter);
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
    email: "phase1-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Knowledge and marketing Phase 1", () => {
  test("knowledge sync seeds approved records from current repo sources", async () => {
    const admin = await createAdmin();

    const syncRes = await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.summary).toEqual(
      expect.objectContaining({
        syncedSources: expect.any(Number),
        createdItems: expect.any(Number),
        pendingRevisions: expect.any(Number),
      })
    );
    expect(syncRes.body.summary.createdItems).toBeGreaterThan(0);

    const overviewRes = await request(app)
      .get("/api/admin/knowledge/overview")
      .set("Cookie", authCookieFor(admin));

    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.counts.items).toBeGreaterThan(0);
    expect(overviewRes.body.counts.pendingApprovals).toBe(0);

    const founderVoiceItem = await KnowledgeItem.findOne({ key: "founder_voice_core_style" }).lean();
    expect(founderVoiceItem).toBeTruthy();
    expect(founderVoiceItem.approvalState).toBe("approved");

    const founderVoiceRevision = await KnowledgeRevision.findById(founderVoiceItem.currentApprovedRevisionId).lean();
    expect(founderVoiceRevision).toBeTruthy();
    expect(founderVoiceRevision.approvalState).toBe("approved");
    expect(founderVoiceRevision.content.rules).toEqual(
      expect.arrayContaining(["Answer the actual point first."])
    );

    const coreExplainer = await KnowledgeItem.findOne({ key: "platform_lpc_core_explainer" }).lean();
    expect(coreExplainer).toBeTruthy();
    expect(coreExplainer.title).toBe("What LPC Is");

    const detailRes = await request(app)
      .get(`/api/admin/knowledge/items/${coreExplainer._id}`)
      .set("Cookie", authCookieFor(admin));

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.item.title).toBe("What LPC Is");
    expect(detailRes.body.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approvalState: "approved",
          content: expect.objectContaining({
            summary: expect.stringMatching(/baseline explanation of LPC/i),
          }),
          citations: expect.arrayContaining([
            expect.objectContaining({
              filePath: "backend/ai/prompts.js",
            }),
          ]),
        }),
      ])
    );
  });

  test("founder LinkedIn workflow creates a structured pending-review packet", async () => {
    const admin = await createAdmin();

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    const briefRes = await request(app)
      .post("/api/admin/marketing/briefs")
      .set("Cookie", authCookieFor(admin))
      .send({
        workflowType: "founder_linkedin_post",
        title: "Founding attorney signal",
        targetAudience: "founding attorneys",
        objective: "Introduce LPC with distinctiveness and standards.",
        briefSummary: "Introduce LPC through standards, workflow, and audience fit.",
        ctaPreference: "Invite the right attorneys to take a closer look.",
      });

    expect(briefRes.status).toBe(201);
    expect(briefRes.body.brief.workflowType).toBe("founder_linkedin_post");

    const packetRes = await request(app)
      .post(`/api/admin/marketing/briefs/${briefRes.body.brief._id}/drafts`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(packetRes.status).toBe(201);
    expect(packetRes.body.packet.approvalState).toBe("pending_review");
    expect(packetRes.body.packet.messageHierarchy.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.approvedFactCards.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.claimsToAvoid.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.hookOptions.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.ctaOptions.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.founderVoiceNotes.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.citations.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.whatStillNeedsSamantha).toEqual(
      expect.arrayContaining(["Approve the final claim set before any external use."])
    );
    expect(packetRes.body.packet.channelDraft).toEqual(
      expect.objectContaining({
        channel: "linkedin",
        body: expect.any(String),
      })
    );

    const approvalsRes = await request(app)
      .get("/api/admin/marketing/approvals")
      .set("Cookie", authCookieFor(admin));

    expect(approvalsRes.status).toBe(200);
    expect(approvalsRes.body.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskType: "marketing_review",
          approvalState: "pending",
        }),
      ])
    );
  });

  test("linkedin company drafts are lane-aware and use restrained follow-oriented CTAs", async () => {
    const admin = await createAdmin();

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    const briefRes = await request(app)
      .post("/api/admin/marketing/briefs")
      .set("Cookie", authCookieFor(admin))
      .send({
        workflowType: "linkedin_company_post",
        title: "LPC standards post",
        targetAudience: "attorneys and paralegals",
        objective: "Build credibility by explaining LPC standards and why the platform is distinct.",
        briefSummary: "Why LPC is taking a standards-first approach.",
        contentLane: "standards_positioning",
      });

    expect(briefRes.status).toBe(201);
    expect(briefRes.body.brief.contentLane).toBe("standards_positioning");

    const packetRes = await request(app)
      .post(`/api/admin/marketing/briefs/${briefRes.body.brief._id}/drafts`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(packetRes.status).toBe(201);
    expect(packetRes.body.packet).toEqual(
      expect.objectContaining({
        workflowType: "linkedin_company_post",
        contentLane: "standards_positioning",
        growthObjective: expect.stringMatching(/credibility/i),
        whyThisHelpsPageGrowth: expect.stringMatching(/credible|trust|distinct/i),
      })
    );
    expect(packetRes.body.packet.approvedPositioningBlocksUsed.length).toBeGreaterThan(0);
    expect(packetRes.body.packet.channelDraft).toEqual(
      expect.objectContaining({
        channel: "linkedin_company",
        contentLane: "standards_positioning",
        growthObjective: expect.stringMatching(/credibility/i),
        primaryHook: expect.any(String),
        alternateHooks: expect.any(Array),
        coreMessage: expect.any(String),
        followOrientedCtaOptions: expect.any(Array),
      })
    );
    expect(packetRes.body.packet.channelDraft.followOrientedCtaOptions.length).toBeGreaterThan(0);
    packetRes.body.packet.channelDraft.followOrientedCtaOptions.forEach((cta) => {
      expect(cta).toMatch(/follow/i);
      expect(cta).not.toMatch(/guarantee|viral|dominate|best|must-read|game-changing|revolutionary/i);
    });
    expect(packetRes.body.packet.whatStillNeedsSamantha.join(" ")).toMatch(/follow/i);
  });

  test("platform update workflow and AI Control Room marketing card stay draft-only", async () => {
    const admin = await createAdmin();

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    const briefRes = await request(app)
      .post("/api/admin/marketing/briefs")
      .set("Cookie", authCookieFor(admin))
      .send({
        workflowType: "platform_update_announcement",
        title: "Platform update test",
        targetAudience: "approved attorneys",
        objective: "Explain a restrained platform update.",
        briefSummary: "Announce a platform update without hype.",
        updateFacts: ["A new approval-based knowledge layer now supports governed messaging.", "Marketing packets are draft-only and approval-based in Phase 1."],
        ctaPreference: "Invite readers to review the update in a measured, factual way.",
      });

    const packetRes = await request(app)
      .post(`/api/admin/marketing/briefs/${briefRes.body.brief._id}/drafts`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(packetRes.status).toBe(201);
    expect(packetRes.body.packet.workflowType).toBe("platform_update_announcement");
    expect(packetRes.body.packet.channelDraft).toEqual(
      expect.objectContaining({
        channel: "platform_update_announcement",
        headline: expect.any(String),
      })
    );

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(summaryRes.status).toBe(200);
    const marketingCard = summaryRes.body.cards.find((card) => card.key === "cmo");
    expect(marketingCard).toBeTruthy();
    expect(marketingCard.queues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Pending review", value: 1 }),
        expect.objectContaining({ label: "Blocked cycles", value: 0 }),
      ])
    );

    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/marketing")
      .set("Cookie", authCookieFor(admin));

    expect(focusRes.status).toBe(200);
    expect(focusRes.body.view.primary.body).toMatch(/awaiting Samantha review/i);
    expect(focusRes.body.view.quaternary.items).toEqual(
      expect.arrayContaining([
        "Draft-only and approval-based.",
        "LinkedIn company publish exists only for approved packets with an active configured connection.",
      ])
    );

    const approvalTask = await ApprovalTask.findOne({ taskType: "marketing_review" }).lean();
    expect(approvalTask).toBeTruthy();
    expect(approvalTask.approvalState).toBe("pending");
  });

  test("marketing status endpoint returns diagnostics without changing CMO status rules", async () => {
    const admin = await createAdmin();
    const brief = await MarketingBrief.create({
      workflowType: "platform_update_announcement",
      title: "Diagnostics brief",
      briefSummary: "Diagnostics summary",
      targetAudience: "approved attorneys",
      objective: "Check diagnostics",
      requestedBy: { actorType: "user", userId: admin._id, label: admin.email },
    });

    const packet = await MarketingDraftPacket.create({
      briefId: brief._id,
      workflowType: "platform_update_announcement",
      packetVersion: 1,
      approvalState: "pending_review",
      packetSummary: "Pending founder review",
    });

    const attemptCompletedAt = new Date("2026-03-24T15:30:00.000Z");
    await MarketingPublishAttempt.create({
      intentId: new mongoose.Types.ObjectId(),
      packetId: packet._id,
      channelKey: "linkedin_company",
      provider: "linkedin",
      attemptNumber: 1,
      status: "succeeded",
      requestedBy: { actorType: "system", label: "Marketing Publishing Scheduler" },
      startedAt: new Date("2026-03-24T15:20:00.000Z"),
      completedAt: attemptCompletedAt,
    });

    const res = await request(app)
      .get("/api/admin/marketing/status")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        diagnostics: expect.objectContaining({
          mongo: expect.objectContaining({
            readyState: 1,
            state: "connected",
          }),
          counts: expect.objectContaining({
            marketingBriefs: 1,
            pendingReview: 1,
          }),
          cmoStatus: "Needs Review",
          latestBriefAt: expect.any(String),
          latestSuccessfulAgentRunAt: attemptCompletedAt.toISOString(),
        }),
      })
    );
  });
});
