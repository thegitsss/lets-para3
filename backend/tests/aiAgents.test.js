const originalOpenAIKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

const mongoose = require("mongoose");

const mockRecords = [];

const mockAgentIssueModel = {
  create: jest.fn(async (doc) => {
    const saved = {
      _id: `mock-${mockRecords.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...doc,
    };
    mockRecords.push(saved);
    return saved;
  }),
  find: jest.fn((query = {}) => {
    const since = query?.createdAt?.$gte ? new Date(query.createdAt.$gte) : null;
    const results = mockRecords.filter((record) => !since || new Date(record.createdAt) >= since);
    return {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn(async () => results),
    };
  }),
  insertMany: jest.fn(async (docs) => {
    docs.forEach((doc) => {
      mockRecords.push({
        _id: `mock-${mockRecords.length + 1}`,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
        ...doc,
      });
    });
    return docs;
  }),
  __reset() {
    mockRecords.length = 0;
    this.create.mockClear();
    this.find.mockClear();
    this.insertMany.mockClear();
  },
  __records() {
    return mockRecords;
  },
};

jest.mock("../models/AgentIssue", () => mockAgentIssueModel);

const AgentIssue = require("../models/AgentIssue");
const {
  classifySupportIssue,
  generateSupportReply,
  triageSupportIssue,
} = require("../ai/supportAgent");
const {
  analyzeRecentIssues,
  generateMonitoringReport,
} = require("../ai/monitoringAgent");

describe("AI agent infrastructure", () => {
  beforeEach(() => {
    AgentIssue.__reset();
    mongoose.connection.readyState = 1;
  });

  afterAll(() => {
    mongoose.connection.readyState = 0;
    if (originalOpenAIKey) {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  test("classifies obvious login issues with fallback rules", async () => {
    const result = await classifySupportIssue("I can't log in and I keep getting access denied.");

    expect(result.ok).toBe(true);
    expect(result.category).toBe("login");
    expect(result.urgency).toBe("high");
    expect(result.provider).toBe("rules");
  });

  test("builds a safe reply draft for payment issues", async () => {
    const result = await generateSupportReply({
      category: "payment",
      urgency: "high",
      messageText: "My card was charged and checkout failed.",
    });

    expect(result.ok).toBe(true);
    expect(result.replyDraft).toMatch(/Thank you for reaching out|Let’s-ParaConnect/i);
    expect(result.replyDraft).not.toMatch(/refund is confirmed|we fixed it/i);
  });

  test("can save triaged support issues for monitoring", async () => {
    const result = await triageSupportIssue({
      messageText: "Stripe onboarding is not letting me finish my payout setup.",
      userEmail: "founder-test@example.com",
      source: "manual",
      saveToDb: true,
    });

    const savedIssue = AgentIssue.__records().find((item) => item.userEmail === "founder-test@example.com");

    expect(result.category).toBe("stripe_onboarding");
    expect(result.saved).toBe(true);
    expect(savedIssue).toBeTruthy();
    expect(savedIssue.category).toBe("stripe_onboarding");
  });

  test("flags repeated login issues in monitoring analysis", async () => {
    await AgentIssue.insertMany([
      {
        userEmail: "a@example.com",
        category: "login",
        urgency: "high",
        originalMessage: "Can't log in",
      },
      {
        userEmail: "b@example.com",
        category: "password_reset",
        urgency: "high",
        originalMessage: "Reset link not working",
      },
      {
        userEmail: "c@example.com",
        category: "login",
        urgency: "high",
        originalMessage: "Locked out",
      },
    ]);

    const analysis = await analyzeRecentIssues({ hours: 12 });

    expect(analysis.alerts.some((alert) => alert.code === "repeated_login_failures")).toBe(true);
    expect(analysis.suggestedActions.length).toBeGreaterThan(0);
  });

  test("generates a structured monitoring report", async () => {
    const report = await generateMonitoringReport({ hours: 6 });

    expect(report).toEqual(
      expect.objectContaining({
        ok: expect.any(Boolean),
        generatedAt: expect.any(String),
        countsByCategory: expect.any(Object),
        countsByUrgency: expect.any(Object),
        alerts: expect.any(Array),
        suggestedActions: expect.any(Array),
      })
    );
  });
});
