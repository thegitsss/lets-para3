const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Incident = require("../models/Incident");
const FAQCandidate = require("../models/FAQCandidate");
const SupportInsight = require("../models/SupportInsight");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminSupportRouter = require("../routes/adminSupport");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "support-phase2-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use("/api/admin/support", adminSupportRouter);
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
    email: "support-phase2-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function createApprovedUser({ role, email, firstName, lastName }) {
  return User.create({
    firstName,
    lastName,
    email,
    password: "Password123!",
    role,
    status: "approved",
    state: "CA",
    approvedAt: new Date(),
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

describe("Support Phase 2", () => {
  test("creates a governed support ticket with routing and a structured response packet", async () => {
    const admin = await createAdmin();
    const attorney = await createApprovedUser({
      role: "attorney",
      email: "support-attorney@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Attorney",
    });

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    await Incident.create({
      publicId: "INC-20260321-200001",
      source: "help_form",
      summary: "Fee explanation page is generating repeated attorney questions.",
      originalReportText: "Users are asking about platform fees and want clearer support handling.",
      state: "investigating",
      classification: {
        domain: "payments",
        severity: "medium",
        riskLevel: "medium",
        confidence: "high",
        riskFlags: { affectsMoney: true },
      },
      context: {
        surface: "attorney",
        routePath: "/attorney/fees",
        featureKey: "fee explainer",
      },
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });

    const createRes = await request(app)
      .post("/api/admin/support/tickets")
      .set("Cookie", authCookieFor(admin))
      .send({
        requesterRole: "attorney",
        requesterUserId: attorney._id.toString(),
        requesterEmail: attorney.email,
        sourceSurface: "attorney",
        routePath: "/attorney/fees",
        subject: "Why is there a platform fee?",
        message: "I need a support-safe explanation of the LPC platform fee and what it covers.",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.ticket.classification.category).toBe("fees");
    expect(createRes.body.ticket.routingSuggestion.ownerKey).toBe("payments");
    expect(createRes.body.ticket.latestResponsePacket).toEqual(
      expect.objectContaining({
        recommendedReply: expect.stringMatching(/platform fee/i),
        confidence: expect.any(String),
        escalationOwner: "payments",
      })
    );
    expect(createRes.body.ticket.latestResponsePacket.citations.length).toBeGreaterThan(0);
    expect(createRes.body.ticket.latestResponsePacket.riskFlags).toEqual(
      expect.arrayContaining(["money_sensitive"])
    );
    expect(createRes.body.ticket.latestResponsePacket.linkedIncidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicId: "INC-20260321-200001",
        }),
      ])
    );

    const detailRes = await request(app)
      .get(`/api/admin/support/tickets/${createRes.body.ticket._id}`)
      .set("Cookie", authCookieFor(admin));

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.ticket.contextSnapshot).toEqual(
      expect.objectContaining({
        userLabel: "Avery Attorney",
        userRole: "attorney",
      })
    );
  });

  test("generates FAQ candidates and support insights from repeated stable resolved patterns", async () => {
    const admin = await createAdmin();

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    for (let index = 0; index < 2; index += 1) {
      const ticketRes = await request(app)
        .post("/api/admin/support/tickets")
        .set("Cookie", authCookieFor(admin))
        .send({
          requesterRole: "paralegal",
          sourceSurface: "paralegal",
          subject: "Why is LPC approval-based?",
          message: "I want the support-safe explanation for why LPC is approval-based.",
        });

      expect(ticketRes.status).toBe(201);

      const resolveRes = await request(app)
        .post(`/api/admin/support/tickets/${ticketRes.body.ticket._id}/status`)
        .set("Cookie", authCookieFor(admin))
        .send({
          status: "resolved",
          resolutionSummary: "Stable approval-based explanation confirmed.",
          resolutionIsStable: true,
        });

      expect(resolveRes.status).toBe(200);
    }

    const faqRes = await request(app)
      .post("/api/admin/support/faq-candidates/generate")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(faqRes.status).toBe(200);
    expect(faqRes.body.candidates.length).toBeGreaterThan(0);

    const insightRes = await request(app)
      .post("/api/admin/support/insights/refresh")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(insightRes.status).toBe(200);
    expect(insightRes.body.insights.length).toBeGreaterThan(0);

    const [candidate, insight] = await Promise.all([
      FAQCandidate.findOne({}).lean(),
      SupportInsight.findOne({}).lean(),
    ]);

    expect(candidate).toEqual(
      expect.objectContaining({
        approvalState: "pending_review",
        repeatCount: 2,
      })
    );
    expect(candidate.question).toMatch(/approval-based/i);

    expect(insight).toEqual(
      expect.objectContaining({
        state: "active",
        repeatCount: 2,
      })
    );

    const supportFocusRes = await request(app)
      .get("/api/admin/ai/control-room/support")
      .set("Cookie", authCookieFor(admin));

    expect(supportFocusRes.status).toBe(200);
    expect(supportFocusRes.body.view.secondary.items).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/FAQ candidate/i),
        expect.stringMatching(/support insight/i),
      ])
    );
  });
});
