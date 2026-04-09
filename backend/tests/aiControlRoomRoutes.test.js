const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");

const User = require("../models/User");
const AiIssueReport = require("../models/AiIssueReport");
const Incident = require("../models/Incident");
const Case = require("../models/Case");
const ApprovalTask = require("../models/ApprovalTask");
const FAQCandidate = require("../models/FAQCandidate");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const SalesAccount = require("../models/SalesAccount");
const SalesDraftPacket = require("../models/SalesDraftPacket");
const AutonomousAction = require("../models/AutonomousAction");
const { LpcAction } = require("../models/LpcAction");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "ai-control-room-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
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
    email: "ai-control-room-admin@lets-paraconnect.test",
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

describe("AI Control Room source hygiene", () => {
  test("summary health is backend-owned and reflects overdue incident pipeline work", async () => {
    const admin = await createAdmin();

    await Incident.create({
      publicId: "INC-20260320-100050",
      source: "help_form",
      summary: "Incident pipeline appears stuck before deployment.",
      originalReportText: "This incident has been waiting on deployment longer than expected.",
      state: "verified_release_candidate",
      userVisibleStatus: "awaiting_internal_review",
      adminVisibleStatus: "active",
      classification: {
        domain: "ui",
        severity: "medium",
        riskLevel: "medium",
        confidence: "high",
      },
      context: {
        surface: "attorney",
        routePath: "/cases/:id",
      },
      orchestration: {
        nextJobType: "deployment",
        nextJobRunAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });

    const res = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.summary.health).toEqual(
      expect.objectContaining({
        value: "Needs Review",
        tone: "blocked",
      })
    );
    expect(res.body.summary.health.note).toMatch(/incident pipeline/i);
    expect(res.body.summary.health.note).toMatch(/INC-20260320-100050/i);
  });

  test("filters QA/dev legacy issue rows and synthetic users from War Room summary data", async () => {
    const admin = await createAdmin();

    await AiIssueReport.create([
      {
        role: "attorney",
        surface: "attorney",
        page: "attorney dashboard qa",
        featureLabel: "attorney dashboard qa",
        issueType: "bug",
        description: "QA attorney issue: the hire button is not working and I cannot submit.",
        blockedSeverity: "high",
        affectsCaseProgress: true,
        status: "new",
      },
      {
        role: "paralegal",
        surface: "paralegal",
        page: "paralegal dashboard qa",
        featureLabel: "paralegal dashboard qa",
        issueType: "bug",
        description: "QA paralegal issue: the application page is broken and the button will not load.",
        blockedSeverity: "high",
        affectsCaseProgress: true,
        status: "reviewed",
      },
      {
        role: "attorney",
        surface: "attorney",
        page: "case detail",
        featureLabel: "hire flow",
        issueType: "bug",
        description: "The hire action is blocked after case submission refresh.",
        blockedSeverity: "high",
        affectsCaseProgress: true,
        status: "new",
      },
    ]);

    await Incident.create([
      {
        publicId: "INC-20260320-100001",
        source: "help_form",
        summary: "Hire action is blocked after refresh.",
        originalReportText: "The hire button stops working after refresh.",
        state: "investigating",
        classification: {
          domain: "ui",
          severity: "high",
          riskLevel: "medium",
          confidence: "high",
        },
        context: {
          surface: "attorney",
          routePath: "/cases/:id",
          featureKey: "hire flow",
        },
      },
      {
        publicId: "INC-20260320-100002",
        source: "help_form",
        summary: "Payout release appears delayed.",
        originalReportText: "A payout-related issue needs founder visibility.",
        state: "investigating",
        classification: {
          domain: "payouts",
          severity: "high",
          riskLevel: "high",
          confidence: "high",
          riskFlags: { affectsMoney: true },
        },
        context: {
          surface: "attorney",
          routePath: "/api/payments/payouts",
          featureKey: "payout hold",
        },
      },
    ]);

    await User.create([
      {
        firstName: "QA",
        lastName: "Paralegal",
        email: "qa.paralegal@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        state: "CA",
        approvedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      },
      {
        firstName: "Paula",
        lastName: "Real",
        email: "paula.real@lets-paraconnect.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        state: "CA",
        approvedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      },
    ]);

    const res = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "cco",
          queues: expect.arrayContaining([
            expect.objectContaining({ label: "Open tickets", value: 0 }),
            expect.objectContaining({ label: "Escalations", value: 1 }),
          ]),
        }),
        expect.objectContaining({
          key: "cfo",
          queues: expect.arrayContaining([
            expect.objectContaining({ label: "Money issues", value: 1 }),
          ]),
        }),
        expect.objectContaining({
          key: "cto",
          queues: expect.arrayContaining([
            expect.objectContaining({ label: "Open items", value: 2 }),
          ]),
        }),
        expect.objectContaining({
          key: "coo",
          queues: expect.arrayContaining([
            expect.objectContaining({ label: "Follow-ups today", value: 1 }),
            expect.objectContaining({ label: "Stalled users", value: 1 }),
          ]),
        }),
        expect.objectContaining({
          key: "cpo",
          queues: expect.arrayContaining([
            expect.objectContaining({ label: "Open issues", value: 1 }),
          ]),
        }),
      ])
    );

    expect(res.body.recentEscalations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "hire flow",
        }),
        expect.objectContaining({
          title: "payout hold",
        }),
      ])
    );
    expect(
      res.body.recentEscalations.some((item) => /dashboard qa/i.test(String(item.title || item.body || "")))
    ).toBe(false);
  });

  test("founder urgent count matches visible founder-priority items instead of raw support blocker totals", async () => {
    const admin = await createAdmin();

    await Incident.create({
      publicId: "INC-20260320-100003",
      source: "help_form",
      summary: "Hire action is blocked after case submission refresh.",
      originalReportText: "The hire action is blocked after case submission refresh.",
      state: "investigating",
      classification: {
        domain: "ui",
        severity: "high",
        riskLevel: "medium",
        confidence: "high",
      },
      context: {
        surface: "attorney",
        routePath: "/cases/:id",
        featureKey: "hire flow",
      },
    });

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));
    expect(summaryRes.status).toBe(200);

    expect(summaryRes.body.summary.urgent.value).toBe("0");
    expect(summaryRes.body.summary.blocked.value).toBe("0");
    const ccoCard = summaryRes.body.cards.find((card) => card.key === "cco");
    expect(ccoCard.queues).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Escalations", value: 1 })])
    );
    expect(ccoCard.decisionState).toEqual(
      expect.objectContaining({
        needsDecisionCount: 0,
      })
    );

    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));
    expect(focusRes.status).toBe(200);
    expect(focusRes.body.view.primary.body).toMatch(/No founder decision is required right now/i);
    expect(focusRes.body.view.tertiary.items).toEqual(
      expect.arrayContaining([
        "No founder decisions are currently waiting in the live approval lanes.",
      ])
    );
  });

  test("lifecycle follow-up counts use distinct users and do not truncate totals to the preview list", async () => {
    const admin = await createAdmin();

    const users = Array.from({ length: 10 }, (_, index) => ({
      firstName: `Paula${index + 1}`,
      lastName: "Lifecycle",
      email: `paula.lifecycle.${index + 1}@lets-paraconnect.com`,
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      approvedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    }));
    await User.create(users);

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.meta).toEqual(
      expect.objectContaining({
        canonicalOpsSources: expect.arrayContaining(["Incident", "LpcAction"]),
        compatibilityOnlySources: expect.arrayContaining(["legacy_lifecycle_snapshot"]),
      })
    );
    const cooCard = summaryRes.body.cards.find((card) => card.key === "coo");
    expect(cooCard.queues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Follow-ups today", value: 10 }),
        expect.objectContaining({ label: "Stalled users", value: 10 }),
      ])
    );
    expect(cooCard.meta).toMatch(/compatibility-only heuristic merge/i);

    const awaitingReviewItem = summaryRes.body.awaitingReview.find((item) => item.badge === "Lifecycle");
    expect(awaitingReviewItem.body).toMatch(/^10 distinct users meet visible follow-up criteria today\./);

    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/lifecycle")
      .set("Cookie", authCookieFor(admin));

    expect(focusRes.status).toBe(200);
    expect(focusRes.body.view.queueLabel).toBe("10 follow-ups recommended today");
    expect(focusRes.body.view.secondary.title).toBe("Current Ops Facts");
    expect(focusRes.body.view.secondary.items).toEqual(
      expect.arrayContaining(["Compatibility-only lifecycle signals still merged: 10"])
    );
    expect(focusRes.body.view.quaternary.items).toEqual(
      expect.arrayContaining([
        "Some legacy lifecycle heuristics are still merged for continuity and remain compatibility-only until migrated.",
      ])
    );
    expect(focusRes.body.view.tertiary.items).toEqual(
      expect.arrayContaining([
        "Distinct users recommended for follow-up today: 10",
      ])
    );
  });

  test("founder view makes operational fallback urgency explicit when no routed founder alert exists", async () => {
    const admin = await createAdmin();

    await Case.create({
      attorney: admin._id,
      attorneyId: admin._id,
      title: "Disputed escrow release",
      details: "A live dispute is open and needs founder visibility.",
      state: "CA",
      status: "disputed",
      disputes: [
        {
          message: "Please review this disputed payout hold.",
          raisedBy: admin._id,
          status: "open",
        },
      ],
    });

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.summary.risk.value).toBe("1");

    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));

    expect(focusRes.status).toBe(200);
    expect(focusRes.body.view.secondary.title).toBe("Current Ops Facts");
    expect(focusRes.body.view.secondary.items).toEqual(
      expect.arrayContaining([
        "1 founder-priority risk item is currently shown from live disputes or money-risk incidents.",
      ])
    );
    expect(focusRes.body.view.quaternary.items).toEqual(
      expect.arrayContaining([
        "When no routed founder alert is open, War Room can still surface live disputes and money-risk incidents as founder-priority operational fallbacks.",
      ])
    );
  });

  test("founder view surfaces attorney and paralegal troubleshooting context on routed support alerts", async () => {
    const admin = await createAdmin();

    await LpcAction.create([
      {
        actionType: "founder_alert",
        status: "open",
        dedupeKey: "founder-alert:support-ticket:paralegal-1",
        title: "Paralegal payout escalation: SUP-PA1234",
        summary: "Where is my payout? Paralegal support request. Case: Released Matter. Surface: dashboard-paralegal.",
        recommendedAction: "Review payout release versus onboarding state.",
        priority: "high",
        subject: {
          entityType: "support_ticket",
          entityId: "paralegal-1",
          publicId: "SUP-PA1234",
        },
        metadata: {
          eventType: "support.ticket.escalated",
          requesterRole: "paralegal",
          requesterName: "Parker Paralegal",
          escalationLane: "payments_review",
          viewName: "dashboard-paralegal",
          caseTitle: "Released Matter",
        },
      },
      {
        actionType: "founder_alert",
        status: "open",
        dedupeKey: "founder-alert:support-ticket:attorney-1",
        title: "Attorney workspace issue: SUP-AT5678",
        summary: "The workspace is blank. Attorney support request. Case: Trial Matter. Surface: case-detail.",
        recommendedAction: "Review workspace availability and route owner.",
        priority: "high",
        subject: {
          entityType: "support_ticket",
          entityId: "attorney-1",
          publicId: "SUP-AT5678",
        },
        metadata: {
          eventType: "support.ticket.escalated",
          requesterRole: "attorney",
          requesterName: "Avery Attorney",
          escalationLane: "case_review",
          viewName: "case-detail",
          caseTitle: "Trial Matter",
        },
      },
    ]);

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.urgentQueue).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Paralegal payout escalation/i),
        expect.stringMatching(/Attorney workspace issue/i),
      ].map((matcher) => expect.objectContaining({ title: matcher })))
    );
    expect(summaryRes.body.urgentQueue.some((item) => /Lane: payments review/i.test(item.body))).toBe(true);
    expect(summaryRes.body.urgentQueue.some((item) => /Surface: dashboard-paralegal/i.test(item.body))).toBe(true);
    expect(summaryRes.body.urgentQueue.some((item) => /Case: Trial Matter/i.test(item.body))).toBe(true);
  });

  test("admissions focus labels visible completeness guidance as heuristic", async () => {
    const admin = await createAdmin();

    await User.create({
      firstName: "Pending",
      lastName: "Attorney",
      email: "pending.attorney@lets-paraconnect.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
      emailVerified: true,
      termsAccepted: true,
      createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get("/api/admin/ai/control-room/admissions")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.view.secondary.title).toBe("Visible Completeness Facts");
    expect(res.body.view.quaternary.title).toBe("Heuristic Follow-Up Cues");
    expect(res.body.view.quaternary.items[0]).toMatch(/visible completeness only/i);
  });

  test("founder operating payload applies centralized lane policy without introducing new approval flows", async () => {
    const admin = await createAdmin();

    const faqCandidate = await FAQCandidate.create({
      key: "billing-safe-faq-1",
      title: "How status updates work",
      question: "How do I know whether my matter is still moving?",
      summary: "Explains where the user sees live status updates.",
      draftAnswer: "Users can follow the live status panel from the dashboard.",
      approvalState: "pending_review",
      repeatCount: 2,
    });
    await ApprovalTask.create({
      taskType: "support_review",
      targetType: "faq_candidate",
      targetId: String(faqCandidate._id),
      title: "Support FAQ approval",
      summary: "Governed FAQ language is pending founder review.",
      approvalState: "pending",
    });

    const marketingPacket = await MarketingDraftPacket.create({
      briefId: new mongoose.Types.ObjectId(),
      workflowType: "founder_linkedin_post",
      packetVersion: 1,
      approvalState: "pending_review",
      packetSummary: "Founder-facing LinkedIn draft is ready for approval.",
      briefSummary: "Quiet momentum post about platform operations.",
    });
    await ApprovalTask.create({
      taskType: "marketing_review",
      targetType: "marketing_draft_packet",
      targetId: String(marketingPacket._id),
      title: "Founder LinkedIn draft",
      summary: "Public-facing draft is waiting on founder approval.",
      approvalState: "pending",
    });

    const salesAccount = await SalesAccount.create({
      name: "Acme Law Group",
      primaryEmail: "partner@acmelawgroup.com",
      sourceFingerprint: "acme-law-group-control-room",
    });
    const salesPacket = await SalesDraftPacket.create({
      accountId: salesAccount._id,
      packetType: "outreach_draft",
      packetVersion: 1,
      approvalState: "pending_review",
      packetSummary: "Outbound outreach copy is ready for founder review.",
    });
    await ApprovalTask.create({
      taskType: "sales_review",
      targetType: "sales_draft_packet",
      targetId: String(salesPacket._id),
      title: "Outbound outreach packet",
      summary: "Outbound content is waiting on founder approval.",
      approvalState: "pending",
    });

    const incidentApprovalId = new mongoose.Types.ObjectId();
    await Incident.create([
      {
        publicId: "INC-20260330-200001",
        source: "help_form",
        summary: "Engineering fix needs founder approval before proceeding.",
        originalReportText: "The workflow fix is staged and awaiting approval.",
        state: "awaiting_founder_approval",
        approvalState: "pending",
        currentApprovalId: incidentApprovalId,
        classification: {
          domain: "ui",
          severity: "high",
          riskLevel: "medium",
          confidence: "high",
        },
        context: {
          surface: "attorney",
          routePath: "/cases/:id",
          featureKey: "case workflow fix",
        },
      },
      {
        publicId: "INC-20260330-200002",
        source: "help_form",
        summary: "Users report dashboard friction after submit.",
        originalReportText: "The dashboard slows down after submit.",
        state: "investigating",
        approvalState: "not_needed",
        classification: {
          domain: "ui",
          severity: "medium",
          riskLevel: "low",
          confidence: "high",
        },
        context: {
          surface: "attorney",
          routePath: "/dashboard",
          featureKey: "dashboard friction",
        },
      },
    ]);

    await AutonomousAction.create({
      agentRole: "CCO",
      actionType: "ticket_reopened",
      confidenceScore: 0.91,
      confidenceReason: "Customer used explicit unresolved language after a prior resolved state.",
      targetModel: "SupportTicket",
      targetId: new mongoose.Types.ObjectId(),
      changedFields: { status: "open" },
      previousValues: { status: "resolved" },
      actionTaken: "Reopened the ticket after the customer said the issue was still broken.",
      status: "completed",
      createdAt: new Date(),
    });

    await User.create([
      {
        firstName: "Riley",
        lastName: "Counsel",
        email: "riley.counsel@lets-paraconnect.com",
        password: "Password123!",
        role: "attorney",
        status: "pending",
        state: "CA",
        emailVerified: true,
        termsAccepted: true,
        barNumber: "BAR-12345",
        lawFirm: "Counsel Group",
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        firstName: "Olivia",
        lastName: "Operator",
        email: "olivia.operator@lets-paraconnect.com",
        password: "Password123!",
        role: "attorney",
        status: "approved",
        state: "CA",
        approvedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      },
    ]);

    await Case.create({
      attorney: admin._id,
      attorneyId: admin._id,
      title: "Disputed payout hold",
      details: "Live dispute should remain informational only in Control Room.",
      state: "CA",
      status: "disputed",
      disputes: [
        {
          message: "Founder visibility needed for a disputed payout hold.",
          raisedBy: admin._id,
          status: "open",
        },
      ],
    });

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));
    expect(summaryRes.status).toBe(200);

    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));
    expect(focusRes.status).toBe(200);

    const decisionQueue = Array.isArray(focusRes.body.view.decisionQueue) ? focusRes.body.view.decisionQueue : [];
    const autoHandledItems = Array.isArray(focusRes.body.view.autoHandledItems) ? focusRes.body.view.autoHandledItems : [];
    const blockedItems = Array.isArray(focusRes.body.view.blockedItems) ? focusRes.body.view.blockedItems : [];
    const infoItems = Array.isArray(focusRes.body.view.infoItems) ? focusRes.body.view.infoItems : [];

    expect(decisionQueue.map((item) => item.agentRole)).toEqual(
      expect.arrayContaining(["CCO", "CMO", "CSO", "CTO", "CAO"])
    );
    expect(decisionQueue.some((item) => ["CFO", "COO", "CPO"].includes(item.agentRole))).toBe(false);

    const ccoDecision = decisionQueue.find((item) => item.agentRole === "CCO");
    const cmoDecision = decisionQueue.find((item) => item.agentRole === "CMO");
    const csoDecision = decisionQueue.find((item) => item.agentRole === "CSO");
    const ctoDecision = decisionQueue.find((item) => item.agentRole === "CTO");
    const caoDecision = decisionQueue.find((item) => item.agentRole === "CAO");

    expect(ccoDecision).toEqual(
      expect.objectContaining({
        policyType: "faq_candidate",
        title: "Use this support answer",
        actionHelperText: expect.stringMatching(/Yes will let support use this answer/i),
        urgencyLabel: expect.stringMatching(/attention today/i),
        actions: expect.objectContaining({
          yes: expect.objectContaining({
            kind: "approval_item",
            decision: "approve",
            label: expect.stringMatching(/use answer/i),
            successMessage: expect.stringMatching(/Support answer approved/i),
          }),
          no: expect.objectContaining({
            kind: "approval_item",
            decision: "reject",
            label: expect.stringMatching(/keep out/i),
            successMessage: expect.stringMatching(/Support answer held back/i),
          }),
          open: expect.objectContaining({ kind: "nav", navSection: "support-ops" }),
        }),
      })
    );
    expect(cmoDecision).toEqual(
      expect.objectContaining({
        policyType: "marketing_draft_packet",
        title: "Publish LinkedIn post",
        actionHelperText: expect.stringMatching(/Yes will approve this LinkedIn post/i),
        actions: expect.objectContaining({
          yes: expect.objectContaining({
            kind: "approval_item",
            decision: "approve",
            label: expect.stringMatching(/publish post/i),
          }),
          no: expect.objectContaining({
            kind: "approval_item",
            decision: "reject",
            label: expect.stringMatching(/keep out/i),
          }),
          open: expect.objectContaining({ kind: "nav", navSection: "marketing-drafts" }),
          edit: expect.objectContaining({ kind: "nav", navSection: "marketing-drafts" }),
        }),
      })
    );
    expect(csoDecision).toEqual(
      expect.objectContaining({
        policyType: "sales_draft_packet",
        title: "Send outreach message",
        actionHelperText: expect.stringMatching(/Yes will allow this outreach message/i),
        actions: expect.objectContaining({
          yes: expect.objectContaining({
            kind: "approval_item",
            decision: "approve",
            label: expect.stringMatching(/allow outreach/i),
          }),
          no: expect.objectContaining({
            kind: "approval_item",
            decision: "reject",
            label: expect.stringMatching(/hold draft/i),
          }),
          open: expect.objectContaining({ kind: "nav", navSection: "sales-workspace" }),
          edit: expect.objectContaining({ kind: "nav", navSection: "sales-workspace" }),
        }),
      })
    );
    expect(ctoDecision).toEqual(
      expect.objectContaining({
        policyType: "incident_approval",
        title: "Approve engineering fix for incident",
        actionHelperText: expect.stringMatching(/Yes will let the current engineering fix path continue/i),
        urgencyLabel: expect.stringMatching(/today/i),
        actions: expect.objectContaining({
          yes: expect.objectContaining({
            kind: "incident_approval",
            decision: "approve",
            label: expect.stringMatching(/move fix forward/i),
            successMessage: expect.stringMatching(/release path can continue/i),
          }),
          no: expect.objectContaining({
            kind: "incident_approval",
            decision: "reject",
            label: expect.stringMatching(/keep paused/i),
            successMessage: expect.stringMatching(/stays paused/i),
          }),
          open: expect.objectContaining({ kind: "nav", navSection: "engineering" }),
        }),
      })
    );
    expect(caoDecision).toEqual(
      expect.objectContaining({
        policyType: "admissions_review",
        title: "Approve applicant for admissions",
        actionHelperText: expect.stringMatching(/Yes will approve this applicant/i),
        actions: expect.objectContaining({
          yes: expect.objectContaining({
            kind: "user_review",
            decision: "approve",
            label: expect.stringMatching(/admit applicant/i),
          }),
          no: expect.objectContaining({
            kind: "user_review",
            decision: "deny",
            label: expect.stringMatching(/deny application/i),
          }),
          open: expect.objectContaining({ kind: "nav", navSection: "user-management" }),
        }),
      })
    );

    expect(autoHandledItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRole: "CCO",
          policyType: "ticket_reopened",
          actionHelperText: expect.stringMatching(/Already handled automatically/i),
          urgencyLabel: "Handled automatically",
          actions: expect.objectContaining({
            yes: null,
            no: null,
            open: expect.objectContaining({ kind: "nav", navSection: "support-ops" }),
          }),
        }),
      ])
    );

    expect(blockedItems.map((item) => item.agentRole)).toEqual(
      expect.arrayContaining(["CCO", "CMO", "CSO", "CTO", "CAO"])
    );
    expect(blockedItems.some((item) => ["CFO", "COO", "CPO"].includes(item.agentRole))).toBe(false);
    expect(blockedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRole: "CTO",
          blockedReason: expect.stringMatching(/approval-gated/i),
          unblockAction: expect.stringMatching(/Approve or reject/i),
          urgencyLabel: expect.stringMatching(/Urgent today/i),
        }),
      ])
    );

    expect(infoItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRole: "CFO",
          policyType: "finance_risk_metric",
          actionHelperText: expect.stringMatching(/informational/i),
          actions: expect.objectContaining({ yes: null, no: null }),
        }),
        expect.objectContaining({
          agentRole: "COO",
          policyType: "ops_follow_up_metric",
          actionHelperText: expect.stringMatching(/Informational only/i),
          actions: expect.objectContaining({ yes: null, no: null }),
        }),
      ])
    );

    const cardsByKey = new Map((summaryRes.body.cards || []).map((card) => [card.key, card]));
    expect(cardsByKey.get("cco").decisionState.topDecision).toEqual(
      expect.objectContaining({ policyType: "faq_candidate" })
    );
    expect(cardsByKey.get("cmo").decisionState.topDecision).toEqual(
      expect.objectContaining({ policyType: "marketing_draft_packet" })
    );
    expect(cardsByKey.get("cso").decisionState.topDecision).toEqual(
      expect.objectContaining({ policyType: "sales_draft_packet" })
    );
    expect(cardsByKey.get("cto").decisionState.topDecision).toEqual(
      expect.objectContaining({ policyType: "incident_approval" })
    );
    expect(cardsByKey.get("cao").decisionState.topDecision).toEqual(
      expect.objectContaining({ policyType: "admissions_review" })
    );
    expect(cardsByKey.get("cfo").decisionState.topDecision).toBeNull();
    expect(cardsByKey.get("coo").decisionState.topDecision).toBeNull();
    expect(cardsByKey.get("cpo").decisionState.topDecision).toBeNull();
    expect(cardsByKey.get("cfo").decisionState.decisionSummary).toMatch(/No founder quick decision available/i);
    expect(cardsByKey.get("coo").decisionState.decisionSummary).toMatch(/No founder decision needed/i);
    expect(cardsByKey.get("cpo").decisionState.decisionSummary).toMatch(/No founder decision available/i);
  });

  test("founder decision queue groups duplicate decision items by lane, action type, and context", async () => {
    const admin = await createAdmin();

    for (let index = 1; index <= 3; index += 1) {
      const packet = await MarketingDraftPacket.create({
        briefId: new mongoose.Types.ObjectId(),
        workflowType: "founder_linkedin_post",
        packetVersion: index,
        approvalState: "pending_review",
        packetSummary: `Founder-facing LinkedIn draft ${index} is ready for approval.`,
        briefSummary: `Quiet momentum post ${index} about platform operations.`,
      });

      await ApprovalTask.create({
        taskType: "marketing_review",
        targetType: "marketing_draft_packet",
        targetId: String(packet._id),
        title: `Founder LinkedIn draft ${index}`,
        summary: `Public-facing draft ${index} is waiting on founder approval.`,
        approvalState: "pending",
      });
    }

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));
    expect(summaryRes.status).toBe(200);

    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", authCookieFor(admin));
    expect(focusRes.status).toBe(200);

    const decisionQueue = Array.isArray(focusRes.body.view.decisionQueue) ? focusRes.body.view.decisionQueue : [];
    expect(decisionQueue).toHaveLength(1);
    expect(focusRes.body.view.queueLabel).toMatch(/1 decision pending/i);

    const groupedDecision = decisionQueue[0];
    expect(groupedDecision).toEqual(
      expect.objectContaining({
        agentRole: "CMO",
        policyType: "marketing_draft_packet",
        groupCount: 3,
        title: "3 posts ready to publish",
        proposedAction: expect.stringMatching(/Publish all 3 LinkedIn company posts/i),
        actionHelperText: expect.stringMatching(/approve all 3 LinkedIn posts/i),
        actions: expect.objectContaining({
          yes: expect.objectContaining({
            kind: "decision_group",
            groupKey: "CMO:marketing_draft_packet:marketing_draft",
            decision: "approve",
            batchActions: expect.arrayContaining([
              expect.objectContaining({
                kind: "approval_item",
                decision: "approve",
              }),
            ]),
          }),
          no: expect.objectContaining({
            kind: "decision_group",
            groupKey: "CMO:marketing_draft_packet:marketing_draft",
            decision: "reject",
            batchActions: expect.arrayContaining([
              expect.objectContaining({
                kind: "approval_item",
                decision: "reject",
              }),
            ]),
          }),
          open: expect.objectContaining({ kind: "nav", navSection: "marketing-drafts" }),
          edit: null,
        }),
      })
    );
    expect(groupedDecision.actions.yes.batchActions).toHaveLength(3);
    expect(groupedDecision.actions.no.batchActions).toHaveLength(3);

    const cardsByKey = new Map((summaryRes.body.cards || []).map((card) => [card.key, card]));
    expect(cardsByKey.get("cmo").decisionState).toEqual(
      expect.objectContaining({
        needsDecisionCount: 1,
        blockedWaitingCount: 3,
        topDecision: expect.objectContaining({
          title: "3 posts ready to publish",
          groupCount: 3,
        }),
      })
    );

    const blockedItems = Array.isArray(focusRes.body.view.blockedItems) ? focusRes.body.view.blockedItems : [];
    expect(blockedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRole: "CMO",
          preview: "3 posts ready to publish",
          explanation: expect.stringMatching(/3 marketing packets/i),
        }),
      ])
    );
  });

  test("legacy issues route is explicitly marked non-canonical", async () => {
    const admin = await createAdmin();
    await AiIssueReport.create({
      role: "attorney",
      surface: "attorney",
      page: "case detail",
      featureLabel: "legacy issue queue item",
      issueType: "bug",
      description: "Legacy issue queue entry retained for compatibility.",
      blockedSeverity: "medium",
      status: "new",
    });

    const res = await request(app)
      .get("/api/admin/ai/issues")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.headers["x-lpc-legacy-route"]).toBe("true");
    expect(res.headers["x-lpc-canonical-ops-source"]).toBe("Incident");
    expect(res.headers.warning).toMatch(/Compatibility-only legacy route/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.meta).toEqual(
      expect.objectContaining({
        legacy: true,
        canonical: false,
        visibility: "compatibility_only",
        deprecationStatus: "non_canonical",
        sourceModel: "AiIssueReport",
        canonicalOpsSource: "Incident",
        replacementRoute: "/api/admin/incidents",
      })
    );
  });

  test("legacy issue patch route keeps legacy metadata visible", async () => {
    const admin = await createAdmin();
    const issue = await AiIssueReport.create({
      role: "attorney",
      surface: "attorney",
      page: "case detail",
      featureLabel: "legacy queue issue",
      issueType: "bug",
      description: "Legacy issue queue patch retained for compatibility.",
      blockedSeverity: "medium",
      status: "new",
    });

    const res = await request(app)
      .patch(`/api/admin/ai/issues/${issue._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "reviewed" });

    expect(res.status).toBe(200);
    expect(res.headers["x-lpc-legacy-route"]).toBe("true");
    expect(res.headers["x-lpc-canonical-ops-source"]).toBe("Incident");
    expect(res.headers.warning).toMatch(/Compatibility-only legacy route/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.meta).toEqual(
      expect.objectContaining({
        legacy: true,
        canonical: false,
        visibility: "compatibility_only",
        deprecationStatus: "non_canonical",
      })
    );
    expect(res.body.issue.status).toBe("reviewed");
  });
});
