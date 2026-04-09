const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const ApprovalTask = require("../models/ApprovalTask");
const FounderDailyLog = require("../models/FounderDailyLog");
const MarketingBrief = require("../models/MarketingBrief");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const MarketingEvaluation = require("../models/MarketingEvaluation");
const MarketingPublishingCycle = require("../models/MarketingPublishingCycle");
const MarketingPublishingSettings = require("../models/MarketingPublishingSettings");
const User = require("../models/User");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminMarketingRouter = require("../routes/adminMarketing");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "marketing-publishing-phase1-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use("/api/admin/marketing", adminMarketingRouter);
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
    email: "marketing-publishing-phase1-admin@lets-paraconnect.test",
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

describe("Marketing publishing Phase 1", () => {
  test("settings persist and cadence can be configured", async () => {
    const admin = await createAdmin();

    const initialRes = await request(app)
      .get("/api/admin/marketing/publishing/settings")
      .set("Cookie", authCookieFor(admin));

    expect(initialRes.status).toBe(200);
    expect(initialRes.body.settings).toEqual(
      expect.objectContaining({
        isEnabled: false,
        cadenceMode: "manual_only",
        timezone: "America/New_York",
        preferredHourLocal: 9,
        enabledChannels: expect.arrayContaining(["linkedin_company", "facebook_page"]),
        maxOpenCycles: 1,
      })
    );

    const updateRes = await request(app)
      .post("/api/admin/marketing/publishing/settings")
      .set("Cookie", authCookieFor(admin))
      .send({
        isEnabled: true,
        cadenceMode: "every_2_days",
        timezone: "America/New_York",
        preferredHourLocal: 7,
        enabledChannels: ["linkedin_company", "facebook_page"],
        pauseReason: "",
        maxOpenCycles: 1,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.settings).toEqual(
      expect.objectContaining({
        isEnabled: true,
        cadenceMode: "every_2_days",
        timezone: "America/New_York",
        preferredHourLocal: 7,
        enabledChannels: ["linkedin_company", "facebook_page"],
        maxOpenCycles: 1,
      })
    );
    expect(updateRes.body.settings.nextDueAt).toBeTruthy();

    const stored = await MarketingPublishingSettings.findOne({ singletonKey: "marketing_publishing" }).lean();
    expect(stored).toBeTruthy();
    expect(stored.cadenceMode).toBe("every_2_days");
    expect(stored.isEnabled).toBe(true);
  });

  test("manual cycle creation generates paired channel briefs, packets, and approval tasks", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const cycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({
        cycleLabel: "Weekly awareness loop",
        targetAudience: "approved attorneys",
        objective: "Create paired review-ready company/page social drafts.",
        briefSummary: "Use approved LPC knowledge and keep both channels restrained.",
      });

    expect(cycleRes.status).toBe(201);
    expect(cycleRes.body.created).toBe(true);
    expect(cycleRes.body.cycle.status).toBe("awaiting_approval");
    expect(cycleRes.body.cycle.channels.linkedin_company.status).toBe("awaiting_approval");
    expect(cycleRes.body.cycle.channels.facebook_page.status).toBe("awaiting_approval");
    expect(cycleRes.body.cycle.channels.linkedin_company.readiness.status).toBe("not_connected");
    expect(cycleRes.body.cycle.channels.facebook_page.readiness.status).toBe("blocked");

    const briefs = await MarketingBrief.find({ cycleId: cycleRes.body.cycle.id }).sort({ createdAt: 1 }).lean();
    const packets = await MarketingDraftPacket.find({
      briefId: { $in: briefs.map((brief) => brief._id) },
    }).lean();
    const tasks = await ApprovalTask.find({
      taskType: "marketing_review",
      approvalState: "pending",
    }).lean();

    expect(briefs).toHaveLength(2);
    expect(briefs.map((brief) => brief.channelKey).sort()).toEqual(["facebook_page", "linkedin_company"]);
    expect(briefs.map((brief) => brief.workflowType).sort()).toEqual(["facebook_page_post", "linkedin_company_post"]);
    expect(packets).toHaveLength(2);
    expect(packets.map((packet) => packet.channelKey).sort()).toEqual(["facebook_page", "linkedin_company"]);
    const linkedinPacket = packets.find((packet) => packet.channelKey === "linkedin_company");
    expect(linkedinPacket).toEqual(
      expect.objectContaining({
        contentLane: "platform_explanation",
        growthObjective: expect.stringMatching(/worth following/i),
        whyThisHelpsPageGrowth: expect.any(String),
        channelDraft: expect.objectContaining({
          channel: "linkedin_company",
          contentLane: "platform_explanation",
          growthObjective: expect.stringMatching(/worth following/i),
          primaryHook: expect.any(String),
          alternateHooks: expect.any(Array),
          coreMessage: expect.any(String),
          followOrientedCtaOptions: expect.arrayContaining([expect.stringMatching(/follow/i)]),
          whyThisHelpsPageGrowth: expect.any(String),
        }),
      })
    );
    expect(tasks).toHaveLength(2);
  });

  test("publishing overview includes LinkedIn cadence guidance without changing approval-first cycle behavior", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const cycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({ cycleLabel: "Cadence guidance cycle" });

    expect(cycleRes.status).toBe(201);
    expect(cycleRes.body.cycle.status).toBe("awaiting_approval");

    const overviewRes = await request(app)
      .get("/api/admin/marketing/publishing/overview")
      .set("Cookie", authCookieFor(admin));

    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.linkedinCadenceGuidance).toEqual(
      expect.objectContaining({
        suggestedNextLane: expect.any(String),
        countsByLane: expect.objectContaining({
          platform_explanation: 1,
          standards_positioning: 0,
          updates_momentum: 0,
        }),
        recommendations: expect.arrayContaining([expect.stringMatching(/missing/i)]),
      })
    );
    expect(overviewRes.body.latestCycles[0].status).toBe("awaiting_approval");
  });

  test("jr cmo library endpoint returns day context, opportunities, facts, and weekly learning", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const res = await request(app)
      .get("/api/admin/marketing/jr-cmo/library")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.library).toEqual(
      expect.objectContaining({
        dayContext: expect.objectContaining({
          toneRecommendation: expect.any(String),
          sourceMode: expect.any(String),
        }),
        opportunities: expect.any(Array),
        facts: expect.any(Array),
        evaluation: expect.objectContaining({
          evaluationType: "weekly",
        }),
      })
    );
  });

  test("founder daily log endpoint returns summary, quick actions, and ready posts from current marketing state", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const cycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({ cycleLabel: "Founder daily log cycle" });

    expect(cycleRes.status).toBe(201);

    const res = await request(app)
      .get("/api/admin/marketing/founder-daily-log")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.log).toEqual(
      expect.objectContaining({
        summary: expect.any(String),
        whatChanged: expect.any(Array),
        needsFounder: expect.any(Array),
        blockers: expect.any(Array),
        recommendedActions: expect.any(Array),
        quickActions: expect.arrayContaining([
          expect.objectContaining({
            actionType: expect.stringMatching(/open_packet|approve_packet|open_marketing_queue/),
          }),
        ]),
        readyPosts: expect.arrayContaining([
          expect.objectContaining({
            channelKey: "linkedin_company",
            status: expect.stringMatching(/Ready to review|Ready to post|Blocked|Awaiting approval/),
          }),
          expect.objectContaining({
            channelKey: "facebook_page",
          }),
        ]),
        compactStatus: expect.objectContaining({
          pendingReviewCount: expect.any(Number),
        }),
      })
    );

    const refreshRes = await request(app)
      .post("/api/admin/marketing/founder-daily-log/refresh")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.log.quickActions.length).toBeGreaterThan(0);
    expect(await FounderDailyLog.countDocuments({})).toBe(1);
  });

  test("scheduled due slot creates an agent-authored marketing cycle with lane-aware LinkedIn input", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    await request(app)
      .post("/api/admin/marketing/publishing/settings")
      .set("Cookie", authCookieFor(admin))
      .send({
        isEnabled: true,
        cadenceMode: "daily",
        timezone: "America/New_York",
        preferredHourLocal: 8,
        enabledChannels: ["linkedin_company", "facebook_page"],
        maxOpenCycles: 1,
      });

    await MarketingPublishingSettings.updateOne(
      { singletonKey: "marketing_publishing" },
      { $set: { nextDueAt: new Date(Date.now() - 60 * 1000) } }
    );

    const scheduledRes = await request(app)
      .post("/api/admin/marketing/publishing/run-scheduled")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(scheduledRes.status).toBe(200);
    expect(scheduledRes.body.created).toBe(true);
    expect(scheduledRes.body.cycle.cycleLabel).toMatch(/CMO Agent/i);
    expect(scheduledRes.body.agenticPlan).toEqual(
      expect.objectContaining({
        linkedinCompanyContentLane: expect.stringMatching(/platform_explanation|standards_positioning/),
        objective: expect.stringMatching(/worth following|credibility/i),
        toneRecommendation: expect.any(String),
        researchMode: "internal_only",
        whyNow: expect.any(String),
        plannerReasoning: expect.any(String),
        selectedFactTitles: expect.any(Array),
      })
    );

    const linkedinBrief = await MarketingBrief.findById(scheduledRes.body.cycle.channels.linkedin_company.briefId).lean();
    const linkedinPacket = await MarketingDraftPacket.findById(scheduledRes.body.cycle.channels.linkedin_company.packetId).lean();

    expect(linkedinBrief).toEqual(
      expect.objectContaining({
        workflowType: "linkedin_company_post",
        contentLane: expect.stringMatching(/platform_explanation|standards_positioning/),
        objective: expect.stringMatching(/worth following|credibility/i),
        requestedBy: expect.objectContaining({
          actorType: "agent",
          label: "Marketing CMO Agent",
        }),
        updateFacts: expect.any(Array),
      })
    );
    expect(linkedinBrief.contentLane).not.toBe("updates_momentum");
    expect(linkedinBrief.updateFacts.length).toBeGreaterThan(0);

    expect(linkedinPacket).toEqual(
      expect.objectContaining({
        contentLane: linkedinBrief.contentLane,
        growthObjective: expect.stringMatching(/worth following|credibility/i),
        generatedBy: expect.objectContaining({
          actorType: "agent",
          label: "Marketing CMO Agent",
        }),
        channelDraft: expect.objectContaining({
          channel: "linkedin_company",
          primaryHook: expect.any(String),
        }),
      })
    );
  });

  test("scheduled due slot does nothing when a pending-review marketing packet already exists", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const briefRes = await request(app)
      .post("/api/admin/marketing/briefs")
      .set("Cookie", authCookieFor(admin))
      .send({
        workflowType: "founder_linkedin_post",
        title: "Pending queue blocker",
        targetAudience: "founding attorneys",
        objective: "Create one founder draft and leave it pending.",
        briefSummary: "This packet should keep the CMO agent from creating more work.",
      });

    expect(briefRes.status).toBe(201);

    const packetRes = await request(app)
      .post(`/api/admin/marketing/briefs/${briefRes.body.brief._id}/drafts`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(packetRes.status).toBe(201);

    await request(app)
      .post("/api/admin/marketing/publishing/settings")
      .set("Cookie", authCookieFor(admin))
      .send({
        isEnabled: true,
        cadenceMode: "daily",
        timezone: "America/New_York",
        preferredHourLocal: 8,
        enabledChannels: ["linkedin_company", "facebook_page"],
        maxOpenCycles: 1,
      });

    await MarketingPublishingSettings.updateOne(
      { singletonKey: "marketing_publishing" },
      { $set: { nextDueAt: new Date(Date.now() - 60 * 1000) } }
    );

    const scheduledRes = await request(app)
      .post("/api/admin/marketing/publishing/run-scheduled")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(scheduledRes.status).toBe(200);
    expect(scheduledRes.body.created).toBe(false);
    expect(scheduledRes.body.reason).toBe("pending_review_backlog");
    expect(scheduledRes.body.agenticPlan).toEqual(
      expect.objectContaining({
        ok: false,
        decision: expect.objectContaining({
          pendingReviewCount: 1,
        }),
      })
    );
    expect(await MarketingPublishingCycle.countDocuments({})).toBe(0);
  });

  test("manual and scheduled creation do not flood extra open cycles", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const firstCycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({ cycleLabel: "Open cycle" });

    expect(firstCycleRes.status).toBe(201);
    expect(await MarketingPublishingCycle.countDocuments({})).toBe(1);

    const secondCycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({ cycleLabel: "Should not create" });

    expect(secondCycleRes.status).toBe(200);
    expect(secondCycleRes.body.created).toBe(false);
    expect(secondCycleRes.body.reason).toBe("open_cycle_exists");
    expect(await MarketingPublishingCycle.countDocuments({})).toBe(1);

    await request(app)
      .post("/api/admin/marketing/publishing/settings")
      .set("Cookie", authCookieFor(admin))
      .send({
        isEnabled: true,
        cadenceMode: "daily",
        timezone: "America/New_York",
        preferredHourLocal: 8,
        enabledChannels: ["linkedin_company", "facebook_page"],
        maxOpenCycles: 1,
      });

    await MarketingPublishingSettings.updateOne(
      { singletonKey: "marketing_publishing" },
      { $set: { nextDueAt: new Date(Date.now() - 60 * 1000) } }
    );

    const scheduledRes = await request(app)
      .post("/api/admin/marketing/publishing/run-scheduled")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(scheduledRes.status).toBe(200);
    expect(scheduledRes.body.created).toBe(false);
    expect(scheduledRes.body.reason).toBe("open_cycle_exists");
    expect(await MarketingPublishingCycle.countDocuments({})).toBe(1);
  });

  test("cycle detail status stays truthful for awaiting approval, blocked, skipped, and ready_to_publish", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const cycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({ cycleLabel: "Truthful status cycle" });

    const cycleId = cycleRes.body.cycle.id;
    const linkedinPacketId = cycleRes.body.cycle.channels.linkedin_company.packetId;
    const facebookPacketId = cycleRes.body.cycle.channels.facebook_page.packetId;

    const awaitingRes = await request(app)
      .get(`/api/admin/marketing/publishing/cycles/${cycleId}`)
      .set("Cookie", authCookieFor(admin));

    expect(awaitingRes.status).toBe(200);
    expect(awaitingRes.body.cycle.status).toBe("awaiting_approval");

    await request(app)
      .post(`/api/admin/marketing/draft-packets/${linkedinPacketId}/reject`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Hold this channel." });

    const blockedRes = await request(app)
      .get(`/api/admin/marketing/publishing/cycles/${cycleId}`)
      .set("Cookie", authCookieFor(admin));

    expect(blockedRes.status).toBe(200);
    expect(blockedRes.body.cycle.status).toBe("blocked");
    expect(blockedRes.body.cycle.channels.linkedin_company.status).toBe("blocked");

    const skippedRes = await request(app)
      .post(`/api/admin/marketing/publishing/cycles/${cycleId}/skip`)
      .set("Cookie", authCookieFor(admin))
      .send({ reason: "Skipping this cycle." });

    expect(skippedRes.status).toBe(200);
    expect(skippedRes.body.cycle.status).toBe("skipped");

    await clearDatabase();
    const secondAdmin = await createAdmin();
    await seedKnowledge(secondAdmin);

    const secondCycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(secondAdmin))
      .send({ cycleLabel: "Ready cycle" });

    const secondCycleId = secondCycleRes.body.cycle.id;
    const secondLinkedinPacketId = secondCycleRes.body.cycle.channels.linkedin_company.packetId;
    const secondFacebookPacketId = secondCycleRes.body.cycle.channels.facebook_page.packetId;

    await request(app)
      .post(`/api/admin/marketing/draft-packets/${secondLinkedinPacketId}/approve`)
      .set("Cookie", authCookieFor(secondAdmin))
      .send({ note: "Approved." });
    await request(app)
      .post(`/api/admin/marketing/draft-packets/${secondFacebookPacketId}/approve`)
      .set("Cookie", authCookieFor(secondAdmin))
      .send({ note: "Approved." });

    const readyRes = await request(app)
      .get(`/api/admin/marketing/publishing/cycles/${secondCycleId}`)
      .set("Cookie", authCookieFor(secondAdmin));

    expect(readyRes.status).toBe(200);
    expect(readyRes.body.cycle.status).toBe("ready_to_publish");
    expect(readyRes.body.cycle.channels.linkedin_company.status).toBe("ready_to_publish");
    expect(readyRes.body.cycle.channels.facebook_page.status).toBe("ready_to_publish");
  });

  test("approval decisions create packet outcome evaluations for weekly learning memory", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const cycleRes = await request(app)
      .post("/api/admin/marketing/publishing/cycles")
      .set("Cookie", authCookieFor(admin))
      .send({ cycleLabel: "Learning memory cycle" });

    const linkedinPacketId = cycleRes.body.cycle.channels.linkedin_company.packetId;

    const rejectRes = await request(app)
      .post(`/api/admin/marketing/draft-packets/${linkedinPacketId}/reject`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Too generic and not grounded in enough concrete facts." });

    expect(rejectRes.status).toBe(200);

    const evaluation = await MarketingEvaluation.findOne({
      packetId: linkedinPacketId,
      evaluationType: "packet_outcome",
    }).lean();

    expect(evaluation).toEqual(
      expect.objectContaining({
        outcome: "rejected",
        contentLane: expect.any(String),
        decisionNote: expect.stringMatching(/concrete facts/i),
        recommendations: expect.arrayContaining([
          expect.stringMatching(/concrete approved facts/i),
        ]),
      })
    );
  });
});
