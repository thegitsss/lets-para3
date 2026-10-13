const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");

process.env.JWT_SECRET = process.env.JWT_SECRET || "support-admin-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_support_admin";

const mockStripe = {
  accounts: {
    retrieve: jest.fn(),
  },
};

jest.mock("../utils/stripe", () => mockStripe);

const Case = require("../models/Case");
const Incident = require("../models/Incident");
const SupportConversation = require("../models/SupportConversation");
const SupportTicket = require("../models/SupportTicket");
const User = require("../models/User");
const adminSupportRouter = require("../routes/adminSupport");
const supportRouter = require("../routes/support");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/support", supportRouter);
  instance.use("/api/admin/support", adminSupportRouter);
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

async function createUser({
  role = "paralegal",
  status = "approved",
  email,
  firstName = "Support",
  lastName = "User",
  stripeAccountId = "",
  stripeOnboarded = false,
  stripeChargesEnabled = false,
  stripePayoutsEnabled = false,
} = {}) {
  return User.create({
    firstName,
    lastName,
    email,
    password: "Password123!",
    role,
    status,
    state: "CA",
    approvedAt: status === "approved" ? new Date() : null,
    stripeAccountId: stripeAccountId || "",
    stripeOnboarded,
    stripeChargesEnabled,
    stripePayoutsEnabled,
  });
}

async function createCaseDoc({
  attorney,
  paralegal = null,
  title = "Support Admin Case",
  paymentReleased = true,
  paidOutAt = null,
  completedAt = new Date("2026-03-20T14:00:00.000Z"),
} = {}) {
  return Case.create({
    title,
    details: "Support admin case details",
    practiceArea: "Litigation",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal?._id || null,
    paralegalId: paralegal?._id || null,
    status: "in progress",
    escrowIntentId: "pi_support_admin",
    escrowStatus: "funded",
    paymentReleased,
    paidOutAt,
    completedAt,
  });
}

async function createConversation(user, query = {}) {
  return request(app)
    .get("/api/support/conversation")
    .set("Cookie", authCookieFor(user))
    .query(query);
}

async function sendSupportMessage(user, conversationId, payload = {}) {
  return request(app)
    .post(`/api/support/conversation/${conversationId}/messages`)
    .set("Cookie", authCookieFor(user))
    .send(payload);
}

async function escalateConversation(user, conversationId, payload = {}) {
  return request(app)
    .post(`/api/support/conversation/${conversationId}/escalate`)
    .set("Cookie", authCookieFor(user))
    .send(payload);
}

async function seedEscalatedTicket() {
  const admin = await createUser({
    role: "admin",
    email: "support-admin@lets-paraconnect.test",
    firstName: "Samantha",
    lastName: "Founder",
  });
  const attorney = await createUser({
    role: "attorney",
    email: "support-admin-attorney@lets-paraconnect.test",
    firstName: "Taylor",
    lastName: "Attorney",
  });
  const paralegal = await createUser({
    role: "paralegal",
    email: "support-admin-paralegal@lets-paraconnect.test",
    firstName: "Parker",
    lastName: "Paralegal",
    stripeAccountId: "acct_support_admin_ready",
    stripeOnboarded: true,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
  });
  mockStripe.accounts.retrieve.mockResolvedValue({
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
    external_accounts: { data: [] },
  });

  const caseDoc = await createCaseDoc({
    attorney,
    paralegal,
    title: "Founder Support Matter",
    paymentReleased: true,
    paidOutAt: null,
  });

  const conversationRes = await createConversation(paralegal, {
    sourcePage: "/dashboard-paralegal.html",
    viewName: "dashboard-paralegal",
    caseId: String(caseDoc._id),
  });
  const conversationId = conversationRes.body.conversation.id;

  const sendRes = await sendSupportMessage(paralegal, conversationId, {
    text: "Where is my payout?",
    pageContext: {
      pathname: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
      caseId: String(caseDoc._id),
    },
  });

  const assistantMessageId = sendRes.body.assistantMessage.id;
  const escalateRes = await escalateConversation(paralegal, conversationId, {
    messageId: assistantMessageId,
    pageContext: {
      pathname: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
      caseId: String(caseDoc._id),
    },
  });

  return {
    admin,
    attorney,
    paralegal,
    caseDoc,
    conversationId,
    ticketId: escalateRes.body.ticket.id,
    assistantMessageId,
  };
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  jest.clearAllMocks();
  mockStripe.accounts.retrieve.mockResolvedValue({
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
    external_accounts: { data: [] },
  });
});

describe("Admin support operations", () => {
  test("lists escalated support tickets for admin review", async () => {
    const { admin, ticketId } = await seedEscalatedTicket();

    const response = await request(app)
      .get("/api/admin/support/tickets?status=open")
      .set("Cookie", authCookieFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ticketId,
          reference: expect.stringMatching(/^SUP-/),
          requester: expect.objectContaining({
            role: "paralegal",
          }),
        }),
      ])
    );
  });

  test("returns ticket detail with linked conversation history and support facts", async () => {
    const { admin, ticketId, conversationId } = await seedEscalatedTicket();

    const response = await request(app)
      .get(`/api/admin/support/tickets/${ticketId}`)
      .set("Cookie", authCookieFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.ticket).toEqual(
      expect.objectContaining({
        id: ticketId,
        conversation: expect.objectContaining({
          id: conversationId,
          status: "escalated",
        }),
        latestSupportFactsSnapshot: expect.objectContaining({
          payoutState: expect.objectContaining({
            paymentReleased: true,
          }),
        }),
      })
    );
    expect(response.body.ticket.conversationMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sender: "user" }),
        expect.objectContaining({ sender: "assistant" }),
      ])
    );
  });

  test("updates ticket status and linked conversation state", async () => {
    const { admin, ticketId, conversationId } = await seedEscalatedTicket();

    const response = await request(app)
      .patch(`/api/admin/support/tickets/${ticketId}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "resolved" });

    expect(response.status).toBe(200);
    expect(response.body.ticket.status).toBe("resolved");

    const conversation = await SupportConversation.findById(conversationId).lean();
    expect(conversation.status).toBe("resolved");
  });

  test("creates an internal note on the support ticket", async () => {
    const { admin, ticketId } = await seedEscalatedTicket();

    const response = await request(app)
      .post(`/api/admin/support/tickets/${ticketId}/note`)
      .set("Cookie", authCookieFor(admin))
      .send({ text: "Confirmed payout release internally. Waiting on user confirmation." });

    expect(response.status).toBe(201);
    expect(response.body.note).toEqual(
      expect.objectContaining({
        adminName: "Samantha Founder",
        text: "Confirmed payout release internally. Waiting on user confirmation.",
      })
    );

    const stored = await SupportTicket.findById(ticketId).lean();
    expect(stored.internalNotes).toHaveLength(1);
  });

  test("admin reply writes a team message into the linked support conversation", async () => {
    const { admin, paralegal, ticketId, conversationId } = await seedEscalatedTicket();

    const replyRes = await request(app)
      .post(`/api/admin/support/tickets/${ticketId}/reply`)
      .set("Cookie", authCookieFor(admin))
      .send({
        text: "We confirmed LPC released the payment. Bank timing depends on Stripe and your bank processing.",
        status: "waiting_on_user",
      });

    expect(replyRes.status).toBe(201);
    expect(replyRes.body.replyMessage).toEqual(
      expect.objectContaining({
        sender: "system",
        metadata: expect.objectContaining({
          kind: "team_reply",
          teamLabel: "LPC Team",
          ticketStatus: "waiting_on_user",
        }),
      })
    );

    const userMessages = await request(app)
      .get(`/api/support/conversation/${conversationId}/messages`)
      .set("Cookie", authCookieFor(paralegal));

    expect(userMessages.status).toBe(200);
    expect(userMessages.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender: "system",
          metadata: expect.objectContaining({
            kind: "team_reply",
            ticketReference: expect.stringMatching(/^SUP-/),
            ticketStatus: "waiting_on_user",
          }),
        }),
      ])
    );
  });

  test("overview counts blockers only from the support-owned queue", async () => {
    const admin = await createUser({
      role: "admin",
      email: "support-overview-admin@lets-paraconnect.test",
      firstName: "Samantha",
      lastName: "Founder",
    });

    await SupportTicket.create([
      {
        subject: "Support-owned blocker",
        message: "User cannot update payout settings",
        status: "open",
        urgency: "high",
        requesterRole: "paralegal",
        sourceSurface: "paralegal",
        sourceLabel: "Support chat",
        requesterEmail: "owner@example.com",
        classification: {
          category: "account_access",
          confidence: "high",
          patternKey: "support-owned-blocker",
          matchedKnowledgeKeys: [],
        },
        routingSuggestion: {
          ownerKey: "support_ops",
          priority: "high",
          queueLabel: "Founder review",
          reason: "High-priority support issue.",
        },
        riskFlags: ["account_access"],
      },
      {
        subject: "Engineering-owned blocker one",
        message: "Save Preferences button is broken",
        status: "open",
        urgency: "high",
        requesterRole: "paralegal",
        sourceSurface: "paralegal",
        sourceLabel: "Support chat",
        requesterEmail: "handoff-one@example.com",
        classification: {
          category: "incident_watch",
          confidence: "high",
          patternKey: "handoff-blocker-one",
          matchedKnowledgeKeys: [],
        },
        routingSuggestion: {
          ownerKey: "incident_watch",
          priority: "high",
          queueLabel: "Engineering",
          reason: "Product issue handed off to engineering.",
        },
        riskFlags: ["active_incident"],
        linkedIncidentIds: [new mongoose.Types.ObjectId()],
      },
      {
        subject: "Engineering-owned blocker two",
        message: "Messaging send action fails",
        status: "in_review",
        urgency: "high",
        requesterRole: "attorney",
        sourceSurface: "attorney",
        sourceLabel: "Support chat",
        requesterEmail: "handoff-two@example.com",
        classification: {
          category: "incident_watch",
          confidence: "high",
          patternKey: "handoff-blocker-two",
          matchedKnowledgeKeys: [],
        },
        routingSuggestion: {
          ownerKey: "incident_watch",
          priority: "high",
          queueLabel: "Engineering",
          reason: "Product issue handed off to engineering.",
        },
        riskFlags: ["active_incident"],
        linkedIncidentIds: [new mongoose.Types.ObjectId()],
      },
    ]);

    const response = await request(app)
      .get("/api/admin/support/overview")
      .set("Cookie", authCookieFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.counts).toEqual(
      expect.objectContaining({
        open: 1,
        blockers: 1,
        handedOffToEngineering: 2,
      })
    );
  });

  test("overview reconciles stale open engineering handoffs after the linked incident is resolved", async () => {
    const admin = await createUser({
      role: "admin",
      email: "support-overview-reconcile-admin@lets-paraconnect.test",
      firstName: "Samantha",
      lastName: "Founder",
    });

    const incident = await Incident.create({
      publicId: "INC-20260325-510001",
      source: "inline_help",
      summary: "Save Preferences issue",
      originalReportText: "The Save Preferences button is not working.",
      state: "resolved",
      classification: {
        domain: "profile",
        severity: "medium",
        riskLevel: "medium",
        confidence: "high",
      },
      context: {
        surface: "paralegal",
        routePath: "/profile-settings.html",
        featureKey: "preferences",
      },
      userVisibleStatus: "fixed_live",
      adminVisibleStatus: "resolved",
      resolution: {
        code: "fixed_deployed",
        summary: "The Save Preferences workflow was fixed and verified.",
        resolvedAt: new Date("2026-03-25T10:15:00.000Z"),
        closedAt: null,
      },
    });

    const staleTicket = await SupportTicket.create({
      subject: "Engineering handoff still marked open",
      message: "Save Preferences button is broken",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterEmail: "stale-handoff@example.com",
      classification: {
        category: "incident_watch",
        confidence: "high",
        patternKey: "stale-handoff",
        matchedKnowledgeKeys: [],
      },
      routingSuggestion: {
        ownerKey: "incident_watch",
        priority: "high",
        queueLabel: "Engineering",
        reason: "Product issue handed off to engineering.",
      },
      riskFlags: ["active_incident"],
      linkedIncidentIds: [incident._id],
    });

    const response = await request(app)
      .get("/api/admin/support/overview")
      .set("Cookie", authCookieFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.counts.handedOffToEngineering).toBe(0);

    const refreshedTicket = await SupportTicket.findById(staleTicket._id).lean();
    expect(refreshedTicket.status).toBe("resolved");
    expect(refreshedTicket.resolutionIsStable).toBe(true);
    expect(refreshedTicket.resolutionSummary).toMatch(/fixed and verified/i);
  });
});
