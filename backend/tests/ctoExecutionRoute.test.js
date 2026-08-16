const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const Incident = require("../models/Incident");
const CtoAgentRun = require("../models/CtoAgentRun");
const CtoExecutionRun = require("../models/CtoExecutionRun");
const User = require("../models/User");
const adminEngineeringRouter = require("../routes/adminEngineering");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cto-execution-route-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/engineering", adminEngineeringRouter);
  return instance;
})();

function authCookieFor(user) {
  return `token=${jwt.sign({
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  }, process.env.JWT_SECRET, { expiresIn: "2h" })}`;
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

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("Engineering execution route", () => {
  test("builds and persists an execution packet for a diagnosed incident", async () => {
    const admin = await createAdmin();
    const incident = await Incident.create({
      publicId: "INC-ENGINEERING-EXECUTION",
      source: "help_form",
      reporter: { role: "attorney", email: "user@example.com" },
      context: { surface: "attorney", routePath: "/cases/example" },
      summary: "Confirm Hire action fails.",
      originalReportText: "The Confirm Hire button does not complete the hire.",
      state: "investigating",
      classification: { domain: "matching", severity: "high", riskLevel: "medium", confidence: "high" },
    });
    const ctoRun = await CtoAgentRun.create({
      category: "hire_flow",
      urgency: "high",
      technicalSeverity: "high",
      diagnosisSummary: "Likely Confirm Hire action failure in attorney flow.",
      likelyRootCauses: ["Missing click handler", "Backend hire route blocked by guard"],
      filesToInspect: ["frontend/assets/scripts/attorney-tabs.js", "backend/routes/cases.js"],
      recommendedFixStrategy: "Inspect Confirm Hire handling and the backend response path.",
      testPlan: ["Click Confirm Hire", "Verify the request and funded state"],
      deploymentRisk: "Medium to high",
      metadata: { incidentId: String(incident._id), incidentPublicId: incident.publicId },
    });

    const res = await request(app)
      .post(`/api/admin/engineering/items/${incident.publicId}/execution`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      reused: false,
      execution: expect.objectContaining({
        ok: true,
        ctoRunId: String(ctoRun._id),
        executionRunId: expect.any(String),
        executionStatus: "awaiting_approval",
        saved: true,
        canAutoDeploy: false,
      }),
      item: expect.objectContaining({ publicId: incident.publicId }),
    }));

    const execution = await CtoExecutionRun.findById(res.body.execution.executionRunId).lean();
    expect(execution).toEqual(expect.objectContaining({
      ctoRunId: ctoRun._id,
      category: "hire_flow",
      executionStatus: "awaiting_approval",
    }));
  });

  test("returns 409 when an incident has not been diagnosed", async () => {
    const admin = await createAdmin();
    const incident = await Incident.create({
      publicId: "INC-ENGINEERING-NO-DIAGNOSIS",
      source: "help_form",
      reporter: { role: "attorney", email: "user@example.com" },
      context: { surface: "attorney", routePath: "/cases/example" },
      summary: "Hire action issue.",
      originalReportText: "The hire action needs diagnosis.",
      state: "reported",
      classification: { domain: "matching", severity: "medium", riskLevel: "medium", confidence: "high" },
    });

    const res = await request(app)
      .post(`/api/admin/engineering/items/${incident.publicId}/execution`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/needs a diagnosis/i);
  });
});
