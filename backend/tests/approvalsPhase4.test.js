const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const ApprovalTask = require("../models/ApprovalTask");
const FAQCandidate = require("../models/FAQCandidate");
const KnowledgeItem = require("../models/KnowledgeItem");
const KnowledgeRevision = require("../models/KnowledgeRevision");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const SalesDraftPacket = require("../models/SalesDraftPacket");
const adminApprovalsRouter = require("../routes/adminApprovals");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminMarketingRouter = require("../routes/adminMarketing");
const adminSalesRouter = require("../routes/adminSales");
const adminSupportRouter = require("../routes/adminSupport");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "approvals-phase4-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/approvals", adminApprovalsRouter);
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use("/api/admin/marketing", adminMarketingRouter);
  instance.use("/api/admin/support", adminSupportRouter);
  instance.use("/api/admin/sales", adminSalesRouter);
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
    email: "approvals-phase4-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function createPendingKnowledgeReviewTask(admin) {
  await request(app)
    .post("/api/admin/knowledge/sync")
    .set("Cookie", authCookieFor(admin))
    .send({});

  const item = await KnowledgeItem.findOne({ key: "platform_lpc_core_explainer" });
  const approvedRevision = await KnowledgeRevision.findById(item.currentApprovedRevisionId);
  const pendingRevision = await KnowledgeRevision.create({
    knowledgeItemId: item._id,
    revisionNumber: Number(approvedRevision.revisionNumber || 1) + 1,
    fingerprint: `phase4-${Date.now()}`,
    content: {
      ...(approvedRevision.content || {}),
      summary:
        "Pending review refinement for the approved LPC explainer, kept truthful and aligned with the current platform description.",
    },
    citations: approvedRevision.citations || [],
    approvalState: "pending_review",
    changeSummary: "Refined the governed explainer summary for review in the unified approvals workspace.",
    createdBy: {
      actorType: "user",
      userId: admin._id,
      label: admin.email,
    },
    createdFrom: "phase4_test",
  });

  item.approvalState = "pending_review";
  item.currentRevisionId = pendingRevision._id;
  await item.save();

  await ApprovalTask.create({
    taskType: "knowledge_review",
    targetType: "knowledge_revision",
    targetId: String(pendingRevision._id),
    parentType: "KnowledgeItem",
    parentId: String(item._id),
    title: `Review knowledge revision: ${item.title}`,
    summary: "A governed knowledge revision is awaiting Samantha review.",
    approvalState: "pending",
    requestedBy: {
      actorType: "user",
      userId: admin._id,
      label: admin.email,
    },
    assignedOwnerLabel: "Samantha",
  });

  return { item, pendingRevision };
}

async function createMarketingPacket(admin) {
  const briefRes = await request(app)
    .post("/api/admin/marketing/briefs")
    .set("Cookie", authCookieFor(admin))
    .send({
      workflowType: "founder_linkedin_post",
      title: "Phase 4 approvals review",
      targetAudience: "founding attorneys",
      objective: "Create a founder-grade review item for the unified approvals workspace.",
      briefSummary: "A restrained founder-facing packet for unified approvals testing.",
      ctaPreference: "Invite the right attorneys to learn more.",
    });

  const packetRes = await request(app)
    .post(`/api/admin/marketing/briefs/${briefRes.body.brief._id}/drafts`)
    .set("Cookie", authCookieFor(admin))
    .send({});

  return packetRes.body.packet;
}

async function createFaqCandidate(admin) {
  for (let index = 0; index < 2; index += 1) {
    const ticketRes = await request(app)
      .post("/api/admin/support/tickets")
      .set("Cookie", authCookieFor(admin))
      .send({
        requesterRole: "paralegal",
        sourceSurface: "paralegal",
        subject: "Why is LPC approval-based?",
        message: "Please explain why LPC remains approval-based in support-safe language.",
      });

    await request(app)
      .post(`/api/admin/support/tickets/${ticketRes.body.ticket._id}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({
        status: "resolved",
        resolutionSummary: "Stable explanation confirmed.",
        resolutionIsStable: true,
      });
  }

  const faqRes = await request(app)
    .post("/api/admin/support/faq-candidates/generate")
    .set("Cookie", authCookieFor(admin))
    .send({});

  return faqRes.body.candidates[0];
}

async function createSalesPacket(admin) {
  const accountRes = await request(app)
    .post("/api/admin/sales/accounts")
    .set("Cookie", authCookieFor(admin))
    .send({
      name: "Phase 4 Counsel",
      primaryEmail: "phase4-counsel@example.test",
      audienceType: "attorney",
      companyName: "Phase 4 Counsel",
      roleLabel: "Managing attorney",
      accountSummary: "Attorney lead used to validate unified approvals review flow.",
    });

  await request(app)
    .post(`/api/admin/sales/accounts/${accountRes.body.account._id}/interactions`)
    .set("Cookie", authCookieFor(admin))
    .send({
      interactionType: "objection_note",
      direction: "inbound",
      summary: "Asked how LPC should be explained truthfully.",
      objections: ["Need a clear explanation of LPC workflow and standards."],
      rawText: "Please keep it truthful and specific.",
    });

  const packetRes = await request(app)
    .post(`/api/admin/sales/accounts/${accountRes.body.account._id}/outreach-draft`)
    .set("Cookie", authCookieFor(admin))
    .send({
      outreachGoal: "Draft internal awareness language for this attorney lead.",
    });

  return packetRes.body.packet;
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

describe("Approvals Phase 4", () => {
  test("aggregates pending review items across knowledge, marketing, support, and sales", async () => {
    const admin = await createAdmin();

    const knowledge = await createPendingKnowledgeReviewTask(admin);
    const marketingPacket = await createMarketingPacket(admin);
    const faqCandidate = await createFaqCandidate(admin);
    const salesPacket = await createSalesPacket(admin);

    const overviewRes = await request(app)
      .get("/api/admin/approvals/overview")
      .set("Cookie", authCookieFor(admin));

    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.counts).toEqual(
      expect.objectContaining({
        total: 5,
        pending: 5,
        knowledge: 1,
        marketing: 1,
        support: 1,
        sales: 2,
      })
    );

    const itemsRes = await request(app)
      .get("/api/admin/approvals/items?status=pending")
      .set("Cookie", authCookieFor(admin));

    expect(itemsRes.status).toBe(200);
    expect(itemsRes.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemType: "knowledge_revision",
          sourcePillar: "knowledge",
          workKey: `knowledge_revision:${knowledge.pendingRevision._id}`,
        }),
        expect.objectContaining({
          itemType: "marketing_draft_packet",
          sourcePillar: "marketing",
          workKey: `marketing_draft_packet:${marketingPacket._id}`,
        }),
        expect.objectContaining({
          itemType: "faq_candidate",
          sourcePillar: "support",
          workKey: `faq_candidate:${faqCandidate._id}`,
        }),
        expect.objectContaining({
          itemType: "sales_draft_packet",
          sourcePillar: "sales",
          workKey: `sales_draft_packet:${salesPacket._id}`,
        }),
      ])
    );

    const marketingOnlyRes = await request(app)
      .get("/api/admin/approvals/items?pillar=marketing&status=pending")
      .set("Cookie", authCookieFor(admin));

    expect(marketingOnlyRes.status).toBe(200);
    expect(marketingOnlyRes.body.items).toHaveLength(1);
    expect(marketingOnlyRes.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePillar: "marketing",
          workKey: `marketing_draft_packet:${marketingPacket._id}`,
        }),
      ])
    );

    const detailRes = await request(app)
      .get(`/api/admin/approvals/items/${encodeURIComponent(`sales_draft_packet:${salesPacket._id}`)}`)
      .set("Cookie", authCookieFor(admin));

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.item).toEqual(
      expect.objectContaining({
        sourcePillar: "sales",
        title: expect.stringMatching(/outreach draft/i),
        actionable: expect.objectContaining({ approve: true, reject: true, requestChanges: false }),
      })
    );
    expect(detailRes.body.item.detail).toEqual(
      expect.objectContaining({
        accountName: "Phase 4 Counsel",
      })
    );
  });

  test("approve and reject actions update the underlying pillar records through the unified workspace", async () => {
    const admin = await createAdmin();

    const { item: knowledgeItem, pendingRevision } = await createPendingKnowledgeReviewTask(admin);
    const marketingPacket = await createMarketingPacket(admin);
    const faqCandidate = await createFaqCandidate(admin);
    const salesPacket = await createSalesPacket(admin);

    const approveKnowledgeRes = await request(app)
      .post(`/api/admin/approvals/items/${encodeURIComponent(`knowledge_revision:${pendingRevision._id}`)}/approve`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Approved in the unified workspace." });

    const rejectMarketingRes = await request(app)
      .post(`/api/admin/approvals/items/${encodeURIComponent(`marketing_draft_packet:${marketingPacket._id}`)}/reject`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Hold until messaging is tightened." });

    const approveSupportRes = await request(app)
      .post(`/api/admin/approvals/items/${encodeURIComponent(`faq_candidate:${faqCandidate._id}`)}/approve`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Approved for governed FAQ use." });

    const rejectSalesRes = await request(app)
      .post(`/api/admin/approvals/items/${encodeURIComponent(`sales_draft_packet:${salesPacket._id}`)}/reject`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Needs a tighter next step before use." });

    expect(approveKnowledgeRes.status).toBe(200);
    expect(rejectMarketingRes.status).toBe(200);
    expect(approveSupportRes.status).toBe(200);
    expect(rejectSalesRes.status).toBe(200);

    const [updatedKnowledgeItem, updatedKnowledgeRevision, updatedMarketingPacket, updatedFaqCandidate, updatedSalesPacket] =
      await Promise.all([
        KnowledgeItem.findById(knowledgeItem._id).lean(),
        KnowledgeRevision.findById(pendingRevision._id).lean(),
        MarketingDraftPacket.findById(marketingPacket._id).lean(),
        FAQCandidate.findById(faqCandidate._id).lean(),
        SalesDraftPacket.findById(salesPacket._id).lean(),
      ]);

    expect(updatedKnowledgeRevision.approvalState).toBe("approved");
    expect(String(updatedKnowledgeItem.currentApprovedRevisionId)).toBe(String(pendingRevision._id));
    expect(updatedMarketingPacket.approvalState).toBe("rejected");
    expect(updatedFaqCandidate.approvalState).toBe("approved");
    expect(updatedSalesPacket.approvalState).toBe("rejected");

    const tasks = await ApprovalTask.find({}).lean();
    const taskByTargetType = new Map(tasks.map((task) => [`${task.targetType}:${task.targetId}`, task]));

    expect(taskByTargetType.get(`knowledge_revision:${pendingRevision._id}`).approvalState).toBe("approved");
    expect(taskByTargetType.get(`marketing_draft_packet:${marketingPacket._id}`).approvalState).toBe("rejected");
    expect(taskByTargetType.get(`faq_candidate:${faqCandidate._id}`).approvalState).toBe("approved");
    expect(taskByTargetType.get(`sales_draft_packet:${salesPacket._id}`).approvalState).toBe("rejected");
  });
});
