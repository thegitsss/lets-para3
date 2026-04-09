const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const CtoAgentRun = require("../models/CtoAgentRun");
const CtoExecutionRun = require("../models/CtoExecutionRun");
const User = require("../models/User");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cto-execution-route-test-secret";

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
    email: "cto-execution-admin@lets-paraconnect.test",
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

describe("CTO execution admin route", () => {
  test("can build and persist an execution packet from an existing CTO run", async () => {
    const admin = await createAdmin();
    const ctoRun = await CtoAgentRun.create({
      category: "hire_flow",
      urgency: "high",
      technicalSeverity: "high",
      diagnosisSummary: "Likely Confirm Hire action failure in attorney flow.",
      likelyRootCauses: [
        "Missing click handler",
        "Disabled state never clears",
        "Backend hire route blocked by guard",
      ],
      filesToInspect: [
        "frontend/assets/scripts/views/case-detail.js",
        "frontend/assets/scripts/attorney-tabs.js",
        "backend/routes/cases.js",
      ],
      recommendedFixStrategy: "Inspect Confirm Hire click handling and backend route response path.",
      testPlan: [
        "Open case detail as attorney",
        "Click Confirm Hire",
        "Verify request fires and UI updates",
      ],
      deploymentRisk: "Medium to high",
      approvalRequired: true,
      canAutoDeploy: false,
      notifyUserWhenResolved: true,
      generatedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/admin/ai/cto-execution-test")
      .set("Cookie", authCookieFor(admin))
      .send({
        ctoRunId: String(ctoRun._id),
        saveRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        ctoRunId: String(ctoRun._id),
        executionRunId: expect.any(String),
        category: "hire_flow",
        executionStatus: "awaiting_approval",
        codexExecutionPrompt: expect.stringMatching(/Implement a narrow LPC production fix/i),
        deploymentReadiness: expect.objectContaining({
          status: "not_ready",
          riskLevel: "medium",
        }),
        resolutionMessageDraft: expect.stringMatching(/We’re actively working on the issue/i),
        saved: true,
        saveSkippedReason: "",
      })
    );

    const executionRun = await CtoExecutionRun.findById(res.body.executionRunId).lean();
    expect(executionRun).toEqual(
      expect.objectContaining({
        ctoRunId: ctoRun._id,
        category: "hire_flow",
        executionStatus: "awaiting_approval",
      })
    );
  });

  test("returns a structured error when the CTO run cannot be found", async () => {
    const admin = await createAdmin();
    const missingId = "67e1d7d0d4c0f2d3b4a12345";

    const res = await request(app)
      .post("/api/admin/ai/cto-execution-test")
      .set("Cookie", authCookieFor(admin))
      .send({
        ctoRunId: missingId,
        saveRun: true,
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: false,
        ctoRunId: missingId,
        executionRunId: null,
        saved: false,
        saveSkippedReason: "CtoAgentRun not found.",
      })
    );
  });
});
