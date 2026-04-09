const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const ApprovalTask = require("../models/ApprovalTask");
const AutonomousAction = require("../models/AutonomousAction");
const AutonomyPreference = require("../models/AutonomyPreference");
const Incident = require("../models/Incident");
const IncidentApproval = require("../models/IncidentApproval");
const MarketingBrief = require("../models/MarketingBrief");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const aiAdminRouter = require("../routes/aiAdmin");
const adminApprovalsRouter = require("../routes/adminApprovals");
const incidentAdminRouter = require("../routes/incidentAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "autonomy-upgrade-test-secret";
process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK = "true";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/ai", aiAdminRouter);
  instance.use("/api/admin/approvals", adminApprovalsRouter);
  instance.use("/api/admin/incidents", incidentAdminRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err?.statusCode || 500).json({ error: err?.message || "Server error" });
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

async function createAdmin(email = "autonomy-upgrade-admin@lets-paraconnect.test") {
  return User.create({
    firstName: "Admin",
    lastName: "Owner",
    email,
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function createMarketingApprovalItem({
  admin,
  index = 1,
  taskState = "approved",
  packetState = taskState === "pending" ? "pending_review" : taskState,
  decidedAt = null,
}) {
  const brief = await MarketingBrief.create({
    workflowType: "linkedin_company_post",
    channelKey: "linkedin_company",
    title: `Autonomy upgrade brief ${index}`,
    briefSummary: `Founder-reviewed marketing brief ${index}.`,
    targetAudience: "Attorneys",
    objective: "Share platform momentum clearly.",
    contentLane: "updates_momentum",
    updateFacts: [`Fact ${index}`],
    ctaPreference: "Learn more about the platform.",
    requestedBy: {
      actorType: "user",
      userId: admin._id,
      label: admin.email,
    },
    approvalState: packetState === "approved" ? "in_queue" : "draft",
  });

  const packet = await MarketingDraftPacket.create({
    briefId: brief._id,
    workflowType: "linkedin_company_post",
    channelKey: "linkedin_company",
    packetVersion: 1,
    approvalState: packetState,
    briefSummary: brief.briefSummary,
    targetAudience: brief.targetAudience,
    contentLane: brief.contentLane,
    growthObjective: "Keep the feed active.",
    whyThisHelpsPageGrowth: "A clear founder-approved update keeps the company feed credible.",
    messageHierarchy: [`Lead with update ${index}.`],
    claimsToAvoid: [],
    channelDraft: {
      headline: `Marketing headline ${index}`,
      body: `This is a safe marketing draft ${index}.`,
    },
    openQuestions: [],
    whatStillNeedsSamantha: ["Approve or reject the post before external use."],
    generatedBy: { actorType: "system", label: "Marketing Draft Service" },
    packetSummary: `Marketing packet ${index} awaiting founder decision.`,
  });

  await ApprovalTask.create({
    taskType: "marketing_review",
    targetType: "marketing_draft_packet",
    targetId: String(packet._id),
    parentType: "MarketingBrief",
    parentId: String(brief._id),
    title: `Review marketing packet ${index}`,
    summary: packet.packetSummary,
    approvalState: taskState,
    requestedBy: {
      actorType: "user",
      userId: admin._id,
      label: admin.email,
    },
    assignedOwnerLabel: "Samantha",
    decidedBy:
      taskState === "pending"
        ? null
        : {
            actorType: "user",
            userId: admin._id,
            label: admin.email,
          },
    decidedAt: taskState === "pending" ? null : decidedAt || new Date(),
    decisionNote: taskState === "approved" ? "Approved." : taskState === "rejected" ? "Rejected." : "",
  });

  return { brief, packet };
}

async function createIncidentApprovalItem({
  publicId = "INC-AUTONOMY-001",
  status = "pending",
  decidedAt = null,
  admin = null,
}) {
  const incident = await Incident.create({
    publicId,
    source: "admin_created",
    summary: `Incident approval ${publicId}`,
    originalReportText: `Founder approval workflow test for ${publicId}.`,
    state: status === "pending" ? "awaiting_founder_approval" : "verified_release_candidate",
    approvalState: status === "pending" ? "pending" : status,
    userVisibleStatus: "awaiting_internal_review",
    adminVisibleStatus: status === "pending" ? "awaiting_approval" : "active",
    classification: {
      domain: "ui",
      severity: "low",
      riskLevel: "low",
      confidence: "high",
      riskFlags: {
        affectsMoney: false,
        affectsAuth: false,
      },
    },
    context: {
      surface: "admin",
      routePath: "/admin-dashboard.html",
      featureKey: `autonomy-${publicId.toLowerCase()}`,
    },
    orchestration: {
      nextJobType: "none",
      nextJobRunAt: new Date(),
    },
  });

  const approval = await IncidentApproval.create({
    incidentId: incident._id,
    attemptNumber: 1,
    approvalType: "production_deploy",
    status,
    requiredByPolicy: true,
    requestedAt: new Date(),
    decisionByUserId: status === "pending" ? null : admin?._id || null,
    decisionByEmail: status === "pending" ? "" : admin?.email || "",
    decisionRole: status === "pending" ? null : "founder_approver",
    decisionNote: status === "pending" ? "" : "Approved.",
    decisionScope:
      status === "approved"
        ? {
            allowProductionDeploy: true,
            allowUserResolution: false,
            allowManualRepair: false,
          }
        : {
            allowProductionDeploy: false,
            allowUserResolution: false,
            allowManualRepair: false,
          },
    decidedAt: status === "pending" ? null : decidedAt || new Date(),
  });

  incident.currentApprovalId = approval._id;
  await incident.save();
  return { incident, approval };
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

describe("Autonomy upgrade system", () => {
  test("surfaces a one-time marketing upgrade suggestion after three consecutive approvals", async () => {
    const admin = await createAdmin();
    await createMarketingApprovalItem({ admin, index: 1, taskState: "approved", decidedAt: new Date("2026-03-20T12:00:00.000Z") });
    await createMarketingApprovalItem({ admin, index: 2, taskState: "approved", decidedAt: new Date("2026-03-21T12:00:00.000Z") });
    await createMarketingApprovalItem({ admin, index: 3, taskState: "approved", decidedAt: new Date("2026-03-22T12:00:00.000Z") });

    const res = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.view.autonomyUpgradeSuggestion).toEqual(
      expect.objectContaining({
        agentRole: "CMO",
        actionType: "marketing_publish",
        title: "Let Marketing publish these automatically",
      })
    );

    const stored = await AutonomyPreference.findOne({ agentRole: "CMO", actionType: "marketing_publish" }).lean();
    expect(stored).toEqual(
      expect.objectContaining({
        mode: "manual",
        learnedFromCount: 3,
        lastPromptedAt: null,
      })
    );
  });

  test("keep reviewing suppresses the upgrade prompt permanently for that action type", async () => {
    const admin = await createAdmin();
    await createMarketingApprovalItem({ admin, index: 1, taskState: "approved", decidedAt: new Date("2026-03-20T12:00:00.000Z") });
    await createMarketingApprovalItem({ admin, index: 2, taskState: "approved", decidedAt: new Date("2026-03-21T12:00:00.000Z") });
    await createMarketingApprovalItem({ admin, index: 3, taskState: "approved", decidedAt: new Date("2026-03-22T12:00:00.000Z") });

    const initial = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));
    expect(initial.body.view.autonomyUpgradeSuggestion?.actionType).toBe("marketing_publish");

    const rejectPromptRes = await request(app)
      .post("/api/admin/ai/control-room/autonomy-preferences/CMO/marketing_publish/manual")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(rejectPromptRes.status).toBe(200);

    await createMarketingApprovalItem({ admin, index: 4, taskState: "approved", decidedAt: new Date("2026-03-23T12:00:00.000Z") });

    const refreshed = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.view.autonomyUpgradeSuggestion).toBeNull();

    const stored = await AutonomyPreference.findOne({ agentRole: "CMO", actionType: "marketing_publish" }).lean();
    expect(stored.mode).toBe("manual");
    expect(stored.learnedFromCount).toBe(4);
    expect(stored.lastPromptedAt).toBeTruthy();
  });

  test("enabled auto mode removes future marketing decisions from the founder queue and logs autonomous handling", async () => {
    const admin = await createAdmin();
    await createMarketingApprovalItem({ admin, index: 1, taskState: "approved", decidedAt: new Date("2026-03-20T12:00:00.000Z") });
    await createMarketingApprovalItem({ admin, index: 2, taskState: "approved", decidedAt: new Date("2026-03-21T12:00:00.000Z") });
    await createMarketingApprovalItem({ admin, index: 3, taskState: "approved", decidedAt: new Date("2026-03-22T12:00:00.000Z") });

    const enableRes = await request(app)
      .post("/api/admin/ai/control-room/autonomy-preferences/CMO/marketing_publish/enable")
      .set("Cookie", authCookieFor(admin))
      .send({});
    expect(enableRes.status).toBe(200);

    const pending = await createMarketingApprovalItem({ admin, index: 4, taskState: "pending" });

    const founderRes = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));

    expect(founderRes.status).toBe(200);
    expect(founderRes.body.view.autonomyUpgradeSuggestion).toBeNull();
    expect(founderRes.body.view.decisionQueue.some((item) => item.id === `marketing_draft_packet:${pending.packet._id}`)).toBe(
      false
    );
    expect(founderRes.body.view.autoHandledItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRole: "CMO",
          title: "Marketing approved a LinkedIn post automatically",
        }),
      ])
    );

    const packet = await MarketingDraftPacket.findById(pending.packet._id).lean();
    expect(packet.approvalState).toBe("approved");

    const action = await AutonomousAction.findOne({
      agentRole: "CMO",
      actionType: "marketing_publish_auto_approved",
      targetId: pending.packet._id,
    }).lean();
    expect(action).toEqual(
      expect.objectContaining({
        agentRole: "CMO",
        actionType: "marketing_publish_auto_approved",
        status: "completed",
      })
    );
  });

  test("incident approval decisions update CTO learning through the existing approval route", async () => {
    const admin = await createAdmin("founder.approver@lets-paraconnect.test");
    await createIncidentApprovalItem({
      publicId: "INC-AUTONOMY-100",
      status: "approved",
      decidedAt: new Date("2026-03-20T12:00:00.000Z"),
      admin,
    });
    await createIncidentApprovalItem({
      publicId: "INC-AUTONOMY-101",
      status: "approved",
      decidedAt: new Date("2026-03-21T12:00:00.000Z"),
      admin,
    });
    const pending = await createIncidentApprovalItem({
      publicId: "INC-AUTONOMY-102",
      status: "pending",
      admin,
    });

    const res = await request(app)
      .post(`/api/admin/incidents/${encodeURIComponent(pending.incident.publicId)}/approvals/${pending.approval._id}/decision`)
      .set("Cookie", authCookieFor(admin))
      .send({ decision: "approve", note: "" });

    expect(res.status).toBe(200);

    const stored = await AutonomyPreference.findOne({ agentRole: "CTO", actionType: "incident_approval" }).lean();
    expect(stored).toEqual(
      expect.objectContaining({
        mode: "manual",
        learnedFromCount: 3,
      })
    );

    const founderRes = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));

    expect(founderRes.status).toBe(200);
    expect(founderRes.body.view.autonomyUpgradeSuggestion).toEqual(
      expect.objectContaining({
        agentRole: "CTO",
        actionType: "incident_approval",
      })
    );
  });
});
