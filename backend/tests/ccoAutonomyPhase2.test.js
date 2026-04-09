const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cco-autonomy-phase2-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_cco_autonomy_phase2";

const mockGenerateSupportConversationReply = jest.fn();

jest.mock("../ai/supportAgent", () => ({
  generateSupportConversationReply: (...args) => mockGenerateSupportConversationReply(...args),
  triageSupportIssue: jest.fn(),
}));

const AutonomousAction = require("../models/AutonomousAction");
const Incident = require("../models/Incident");
const SupportConversation = require("../models/SupportConversation");
const SupportTicket = require("../models/SupportTicket");
const User = require("../models/User");
const supportRouter = require("../routes/support");
const { routeSupportSubmissionEvent } = require("../services/lpcEvents/supportRoutingService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/support", supportRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

function buildAssistantReply({
  primaryAsk = "general_support",
  needsEscalation = false,
  category = "general_support",
  currentIssueLabel = "issue",
  currentIssueSummary = "Support issue context",
  reply = "Here is the next support step.",
  escalationReason = "",
} = {}) {
  return {
    reply,
    suggestions: [],
    navigation: null,
    actions: [],
    provider: "openai",
    category,
    categoryLabel: category,
    confidence: "high",
    urgency: "medium",
    needsEscalation,
    escalationReason,
    paymentSubIntent: "",
    supportFacts: {},
    primaryAsk,
    activeTask: "ANSWER",
    awaitingField: "",
    responseMode: needsEscalation ? "ESCALATE" : "DIRECT_ANSWER",
    sentiment: "neutral",
    frustrationScore: 0,
    escalationPriority: needsEscalation ? "high" : "normal",
    currentIssueLabel,
    currentIssueSummary,
    compoundIntent: "",
    lastCompoundBranch: "",
    selectionTopics: [],
    lastSelectionTopic: "",
    topicKey: "",
    topicLabel: "",
    topicMode: "",
    turnKind: primaryAsk === "issue_reopen" ? "issue_reopened" : "",
    recentTopics: [],
    awaitingClarification: false,
    intakeMode: false,
    detailLevel: "concise",
    grounded: true,
  };
}

function authCookieFor(user) {
  const token = jwt.sign(
    {
      id: String(user._id),
      role: user.role,
      email: user.email,
      status: user.status,
    },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
  return `token=${token}`;
}

async function createApprovedUser({
  role = "paralegal",
  email,
  firstName = "Support",
  lastName = "User",
} = {}) {
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

async function createConversationFor(user, query = {}) {
  const res = await request(app)
    .get("/api/support/conversation")
    .set("Cookie", authCookieFor(user))
    .query(query);
  return res.body.conversation;
}

async function postSupportMessage(user, conversationId, payload = {}) {
  return request(app)
    .post(`/api/support/conversation/${conversationId}/messages`)
    .set("Cookie", authCookieFor(user))
    .send(payload);
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
  mockGenerateSupportConversationReply.mockResolvedValue(
    buildAssistantReply({
      reply: "Default support reply.",
    })
  );
});

describe("CCO autonomy phase 2", () => {
  test("autonomous ticket reopen logs a valid AutonomousAction when confidence passes", async () => {
    const user = await createApprovedUser({
      role: "paralegal",
      email: "cco-reopen@lets-paraconnect.test",
    });
    const conversation = await createConversationFor(user, {
      sourcePage: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
    });

    const ticket = await SupportTicket.create({
      subject: "Support reopen test",
      message: "The issue was resolved earlier.",
      status: "resolved",
      resolvedAt: new Date("2026-03-29T12:00:00.000Z"),
      resolutionSummary: "Marked resolved earlier.",
      resolutionIsStable: true,
      userId: user._id,
      requesterUserId: user._id,
      requesterEmail: user.email,
      conversationId: conversation.id,
      latestUserMessage: "It was fixed.",
    });

    const conversationDoc = await SupportConversation.findById(conversation.id);
    conversationDoc.metadata = {
      ...(conversationDoc.metadata || {}),
      support: {
        ...(conversationDoc.metadata?.support || {}),
        proactiveTicketId: ticket._id,
        proactiveIssueState: "resolved",
        proactiveTicketStatus: "resolved",
      },
    };
    await conversationDoc.save();

    mockGenerateSupportConversationReply.mockResolvedValueOnce(
      buildAssistantReply({
        primaryAsk: "issue_reopen",
        currentIssueLabel: "support issue",
        currentIssueSummary: "Issue still happening after a resolved ticket.",
        reply: "I’m reopening this for you now.",
      })
    );

    const res = await postSupportMessage(user, conversation.id, {
      text: "This is still broken.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(res.status).toBe(201);

    const refreshedTicket = await SupportTicket.findById(ticket._id).lean();
    expect(refreshedTicket.status).toBe("open");

    const action = await AutonomousAction.findOne({ actionType: "ticket_reopened" }).lean();
    expect(action).toEqual(
      expect.objectContaining({
        agentRole: "CCO",
        actionType: "ticket_reopened",
        targetModel: "SupportTicket",
        targetId: ticket._id,
        status: "completed",
      })
    );
  });

  test("reopen does not execute autonomously when a disqualifier is present", async () => {
    const user = await createApprovedUser({
      role: "paralegal",
      email: "cco-reopen-money@lets-paraconnect.test",
    });
    const conversation = await createConversationFor(user, {
      sourcePage: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
    });

    const ticket = await SupportTicket.create({
      subject: "Payout issue",
      message: "Payout is still missing.",
      status: "resolved",
      resolvedAt: new Date("2026-03-29T12:00:00.000Z"),
      resolutionSummary: "Closed earlier.",
      resolutionIsStable: true,
      userId: user._id,
      requesterUserId: user._id,
      requesterEmail: user.email,
      conversationId: conversation.id,
      classification: {
        category: "payments_risk",
        confidence: "high",
        patternKey: "",
        matchedKnowledgeKeys: [],
      },
      riskFlags: ["money_sensitive"],
    });

    const conversationDoc = await SupportConversation.findById(conversation.id);
    conversationDoc.metadata = {
      ...(conversationDoc.metadata || {}),
      support: {
        ...(conversationDoc.metadata?.support || {}),
        proactiveTicketId: ticket._id,
        proactiveIssueState: "resolved",
        proactiveTicketStatus: "resolved",
      },
    };
    await conversationDoc.save();

    mockGenerateSupportConversationReply.mockResolvedValueOnce(
      buildAssistantReply({
        primaryAsk: "issue_reopen",
        category: "payment",
        currentIssueLabel: "payout issue",
        currentIssueSummary: "Payout issue still happening.",
        reply: "I’m reopening this issue now.",
      })
    );

    const res = await postSupportMessage(user, conversation.id, {
      text: "My payout is still broken.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
      },
    });

    expect(res.status).toBe(201);

    const refreshedTicket = await SupportTicket.findById(ticket._id).lean();
    expect(refreshedTicket.status).toBe("open");
    expect(await AutonomousAction.countDocuments({ actionType: "ticket_reopened" })).toBe(0);
  });

  test("autonomous escalation logs correctly when confidence passes", async () => {
    const user = await createApprovedUser({
      role: "attorney",
      email: "cco-escalate@lets-paraconnect.test",
    });
    const conversation = await createConversationFor(user, {
      sourcePage: "/dashboard-attorney.html",
      viewName: "dashboard-attorney",
    });

    await SupportTicket.create({
      subject: "Same support issue",
      message: "Existing issue context.",
      status: "open",
      userId: user._id,
      requesterUserId: user._id,
      requesterEmail: user.email,
      conversationId: conversation.id,
    });

    mockGenerateSupportConversationReply.mockResolvedValueOnce(
      buildAssistantReply({
        primaryAsk: "request_human_help",
        needsEscalation: true,
        currentIssueLabel: "support issue",
        currentIssueSummary: "User asked for team help on an existing issue.",
        escalationReason: "support_review_recommended",
        reply: "I’m sending this to the team.",
      })
    );

    const res = await postSupportMessage(user, conversation.id, {
      text: "I need human help with this issue now.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
      },
    });

    expect(res.status).toBe(201);

    const action = await AutonomousAction.findOne({ actionType: "ticket_escalated" }).lean();
    expect(action).toEqual(
      expect.objectContaining({
        actionType: "ticket_escalated",
        targetModel: "SupportTicket",
        status: "completed",
      })
    );

    const tickets = await SupportTicket.find({ conversationId: conversation.id }).lean();
    expect(tickets[0].routingSuggestion.ownerKey).toBe("founder_review");
  });

  test("escalation does not execute autonomously when below threshold", async () => {
    const user = await createApprovedUser({
      role: "attorney",
      email: "cco-escalate-low@lets-paraconnect.test",
    });
    const conversation = await createConversationFor(user, {
      sourcePage: "/dashboard-attorney.html",
      viewName: "dashboard-attorney",
    });

    mockGenerateSupportConversationReply.mockResolvedValueOnce(
      buildAssistantReply({
        primaryAsk: "request_human_help",
        needsEscalation: true,
        currentIssueLabel: "new issue",
        currentIssueSummary: "First-time request for human help.",
        escalationReason: "support_review_recommended",
        reply: "I’m sending this to the team.",
      })
    );

    const res = await postSupportMessage(user, conversation.id, {
      text: "I need human help.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
      },
    });

    expect(res.status).toBe(201);
    expect(await SupportTicket.countDocuments({ conversationId: conversation.id })).toBe(1);
    expect(await AutonomousAction.countDocuments({ actionType: "ticket_escalated" })).toBe(0);
  });

  test("autonomous incident routing logs correctly when confidence passes", async () => {
    const user = await createApprovedUser({
      role: "attorney",
      email: "cco-routing@lets-paraconnect.test",
    });

    const result = await routeSupportSubmissionEvent({
      actor: {
        actorType: "system",
        userId: user._id,
        role: user.role,
        email: user.email,
        label: "CCO Router",
      },
      related: {
        userId: user._id,
      },
      source: {
        surface: "attorney",
        route: "/create-case.html",
      },
      facts: {
        after: {
          role: user.role,
          email: user.email,
          name: "Routing User",
          routePath: "/create-case.html",
          pageUrl: "https://example.test/create-case.html",
          featureKey: "create case",
          subject: "Create case bug",
          message: "The create case submit button is broken and blocked with an error.",
        },
      },
    });

    expect(result.incident?._id).toBeTruthy();

    const action = await AutonomousAction.findOne({ actionType: "incident_routed_from_support" }).lean();
    expect(action).toEqual(
      expect.objectContaining({
        actionType: "incident_routed_from_support",
        targetModel: "SupportTicket",
        status: "completed",
      })
    );

    const routedTicket = await SupportTicket.findById(result.ticket._id || result.ticket.id).lean();
    expect((routedTicket.linkedIncidentIds || []).length).toBeGreaterThan(0);
  });

  test("routing does not execute autonomously when a disqualifier is present", async () => {
    const user = await createApprovedUser({
      role: "paralegal",
      email: "cco-routing-money@lets-paraconnect.test",
    });

    const result = await routeSupportSubmissionEvent({
      actor: {
        actorType: "system",
        userId: user._id,
        role: user.role,
        email: user.email,
        label: "CCO Router",
      },
      related: {
        userId: user._id,
      },
      source: {
        surface: "paralegal",
        route: "/dashboard-paralegal.html",
      },
      facts: {
        after: {
          role: user.role,
          email: user.email,
          name: "Routing User",
          routePath: "/dashboard-paralegal.html",
          pageUrl: "https://example.test/dashboard-paralegal.html",
          featureKey: "payout",
          subject: "Payout bug",
          message: "My payout failed and billing is broken with an error.",
        },
      },
    });

    expect(result.incident?._id).toBeTruthy();
    expect(await AutonomousAction.countDocuments({ actionType: "incident_routed_from_support" })).toBe(0);
  });

  test("no autonomous ticket resolution is introduced in this phase", async () => {
    const user = await createApprovedUser({
      role: "paralegal",
      email: "cco-resolve@lets-paraconnect.test",
    });
    const conversation = await createConversationFor(user, {
      sourcePage: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
    });

    const ticket = await SupportTicket.create({
      subject: "Resolvable issue",
      message: "This can be resolved.",
      status: "open",
      userId: user._id,
      requesterUserId: user._id,
      requesterEmail: user.email,
      conversationId: conversation.id,
    });

    mockGenerateSupportConversationReply.mockResolvedValueOnce(
      buildAssistantReply({
        primaryAsk: "issue_resolved",
        currentIssueLabel: "support issue",
        currentIssueSummary: "User confirmed the issue is fixed.",
        reply: "Glad that fixed it.",
      })
    );

    const res = await postSupportMessage(user, conversation.id, {
      text: "That fixed it.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
      },
    });

    expect(res.status).toBe(201);

    const refreshedTicket = await SupportTicket.findById(ticket._id).lean();
    expect(refreshedTicket.status).toBe("resolved");
    expect(await AutonomousAction.countDocuments({ actionType: "ticket_resolved" })).toBe(0);
    expect(await AutonomousAction.countDocuments({})).toBe(0);
  });
});
