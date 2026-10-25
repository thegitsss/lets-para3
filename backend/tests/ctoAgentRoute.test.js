const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const Incident = require("../models/Incident");
const CtoAgentRun = require("../models/CtoAgentRun");
const User = require("../models/User");
const adminEngineeringRouter = require("../routes/adminEngineering");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cto-agent-route-test-secret";

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
    email: "cto-agent-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

beforeAll(connect);
afterAll(closeDatabase);

beforeEach(async () => {
  delete process.env.OPENAI_API_KEY;
  await clearDatabase();
});

describe("Engineering diagnosis route", () => {
  test("diagnoses a canonical incident and persists a linked CTO run", async () => {
    const admin = await createAdmin();
    const incident = await Incident.create({
      publicId: "INC-ENGINEERING-DIAGNOSE",
      source: "help_form",
      reporter: { role: "attorney", email: "user@example.com" },
      context: { surface: "attorney", routePath: "/dashboard-attorney.html" },
      summary: "User reports blank attorney dashboard after login.",
      originalReportText: "My dashboard is blank and the page never finishes loading.",
      state: "reported",
      classification: { domain: "ui", severity: "high", riskLevel: "medium", confidence: "high" },
    });

    const res = await request(app)
      .post(`/api/admin/engineering/items/${incident.publicId}/diagnose`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      reused: false,
      diagnosis: expect.objectContaining({
        ok: true,
        runId: expect.any(String),
        saved: true,
        category: "dashboard_load",
        diagnosisSummary: expect.stringMatching(/dashboard/i),
        approvalRequired: true,
        canAutoDeploy: false,
      }),
      item: expect.objectContaining({ publicId: incident.publicId }),
    }));

    const run = await CtoAgentRun.findById(res.body.diagnosis.runId).lean();
    expect(run).toEqual(expect.objectContaining({
      category: "dashboard_load",
      sourceIssueSnapshot: expect.objectContaining({
        metadata: expect.objectContaining({ incidentId: String(incident._id) }),
      }),
    }));
  });

  test("returns 404 for an unknown incident", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/engineering/items/INC-NOT-FOUND/diagnose")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/incident not found/i);
  });
});
