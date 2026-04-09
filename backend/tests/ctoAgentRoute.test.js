const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const AgentIssue = require("../models/AgentIssue");
const CtoAgentRun = require("../models/CtoAgentRun");
const User = require("../models/User");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cto-agent-route-test-secret";

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
    email: "cto-agent-admin@lets-paraconnect.test",
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
  delete process.env.OPENAI_API_KEY;
  await clearDatabase();
});

describe("CTO agent admin route", () => {
  test("can diagnose from AgentIssue id and persist a CTO run", async () => {
    const admin = await createAdmin();
    const issue = await AgentIssue.create({
      category: "dashboard_load",
      urgency: "high",
      originalMessage: "My dashboard is blank and the page never finishes loading.",
      internalSummary: "User reports blank attorney dashboard after login.",
      userEmail: "user@example.com",
      metadata: {
        page: "/dashboard-attorney.html",
        role: "attorney",
      },
      status: "new",
      source: "support_agent",
    });

    const res = await request(app)
      .post("/api/admin/ai/cto-diagnose-test")
      .set("Cookie", authCookieFor(admin))
      .send({
        issueId: String(issue._id),
        saveRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        issueId: String(issue._id),
        runId: expect.any(String),
        saved: true,
        saveSkippedReason: "",
        category: "dashboard_load",
        diagnosisSummary: expect.stringMatching(/dashboard/i),
        readyToApply: true,
        filesToInspect: expect.arrayContaining([
          "frontend/dashboard-attorney.html",
          "frontend/assets/scripts/attorney-dashboard.js",
          "backend/routes/attorneyDashboard.js",
        ]),
        approvalRequired: true,
        canAutoDeploy: false,
      })
    );

    const run = await CtoAgentRun.findById(res.body.runId).lean();
    expect(run).toEqual(
      expect.objectContaining({
        issueId: issue._id,
        category: "dashboard_load",
        sourceIssueSnapshot: expect.objectContaining({
          originalMessage: expect.stringMatching(/blank/i),
        }),
      })
    );
  });
});
