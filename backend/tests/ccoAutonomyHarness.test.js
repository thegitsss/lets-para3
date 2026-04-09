const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cco-autonomy-harness-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_cco_autonomy_harness";
process.env.ENABLE_CCO_AUTONOMY_HARNESS = "true";
process.env.APP_ENV = "staging";

const User = require("../models/User");
const { isCcoAutonomyHarnessEnabled } = require("../utils/ccoAutonomyHarnessAccess");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

function buildHarnessApp() {
  const routerPath = require.resolve("../routes/ccoAutonomyHarness");
  delete require.cache[routerPath];
  const harnessRouter = require("../routes/ccoAutonomyHarness");

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/admin/support/dev/cco-autonomy", harnessRouter);
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err?.statusCode || 500).json({ error: err?.message || "Server error" });
  });
  return app;
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

async function createAdmin() {
  return User.create({
    firstName: "Harness",
    lastName: "Admin",
    email: `cco-harness-admin+${Date.now()}@lets-paraconnect.test`,
    password: "Password123!",
    role: "admin",
    status: "approved",
    approvedAt: new Date(),
    emailVerified: true,
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

describe("CCO autonomy harness", () => {
  test("harness access helper is enabled in test/staging mode", () => {
    expect(isCcoAutonomyHarnessEnabled(process.env)).toBe(true);
    expect(
      isCcoAutonomyHarnessEnabled({
        NODE_ENV: "production",
        APP_ENV: "production",
        ENABLE_CCO_AUTONOMY_HARNESS: "false",
      })
    ).toBe(false);
  });

  test("seed and trigger reopen scenario through the harness", async () => {
    const app = buildHarnessApp();
    const admin = await createAdmin();

    const seedRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/seed")
      .set("Cookie", authCookieFor(admin))
      .send({ scenario: "reopen" });

    expect(seedRes.status).toBe(201);
    expect(seedRes.body.seeded.expectedActionType).toBe("ticket_reopened");
    expect(seedRes.body.inspection.tickets[0].status).toBe("resolved");

    const triggerRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/trigger")
      .set("Cookie", authCookieFor(admin))
      .send({
        conversationId: seedRes.body.seeded.conversationId,
      });

    expect(triggerRes.status).toBe(201);
    expect(triggerRes.body.inspection.tickets[0].status).toBe("open");
    expect(
      triggerRes.body.inspection.autonomousActions.some((action) => action.actionType === "ticket_reopened")
    ).toBe(true);
  });

  test("seed and trigger escalation scenario through the harness", async () => {
    const app = buildHarnessApp();
    const admin = await createAdmin();

    const seedRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/seed")
      .set("Cookie", authCookieFor(admin))
      .send({ scenario: "escalation" });

    const triggerRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/trigger")
      .set("Cookie", authCookieFor(admin))
      .send({
        conversationId: seedRes.body.seeded.conversationId,
      });

    expect(triggerRes.status).toBe(201);
    expect(
      triggerRes.body.inspection.autonomousActions.some((action) => action.actionType === "ticket_escalated")
    ).toBe(true);
  });

  test("seed and trigger incident routing scenario through the harness", async () => {
    const app = buildHarnessApp();
    const admin = await createAdmin();

    const seedRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/seed")
      .set("Cookie", authCookieFor(admin))
      .send({ scenario: "incident_routing" });

    const triggerRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/trigger")
      .set("Cookie", authCookieFor(admin))
      .send({
        conversationId: seedRes.body.seeded.conversationId,
      });

    expect(triggerRes.status).toBe(201);
    expect(triggerRes.body.inspection.incidents.length).toBeGreaterThan(0);
    expect(
      triggerRes.body.inspection.autonomousActions.some(
        (action) => action.actionType === "incident_routed_from_support"
      )
    ).toBe(true);
  });
});
