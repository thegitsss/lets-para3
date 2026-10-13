const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.JWT_SECRET = process.env.JWT_SECRET || "cco-autonomy-harness-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_cco_autonomy_harness";
process.env.ENABLE_CCO_AUTONOMY_HARNESS = "true";
process.env.APP_ENV = "staging";

const User = require("../models/User");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const SupportTicket = require("../models/SupportTicket");
const SupportMutation = require("../models/SupportMutation");
const { isCcoAutonomyHarnessEnabled } = require("../utils/ccoAutonomyHarnessAccess");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

function expectSavedHarnessOutcome(body) {
  const { inspection, expectedOutcome } = body;
  expect(inspection.tickets).toHaveLength(1);
  expect(inspection.tickets[0].status).toBe(expectedOutcome.ticketStatus);
  expect(inspection.tickets[0].routingSuggestion.ownerKey).toBe(expectedOutcome.routingOwner);
  expect(inspection.tickets[0].linkedIncidentIds.length > 0).toBe(expectedOutcome.incidentLinked);
  expect(inspection.supportRequests).toHaveLength(1);
  const saved = inspection.supportRequests[0];
  expect(saved).toMatchObject({ action: 'send', state: expectedOutcome.requestState, active: false });
  expect(saved.userMessageId).toMatch(/^[a-f0-9]{24}$/);
  expect(saved.assistantMessageId).toMatch(/^[a-f0-9]{24}$/);
  const messageIds = inspection.messages.map(message => message.id);
  expect(messageIds).toEqual(expect.arrayContaining([saved.userMessageId, saved.assistantMessageId]));
  expect(saved).not.toHaveProperty('input');
  expect(saved).not.toHaveProperty('result');
  expect(saved).not.toHaveProperty('claimToken');
  expect(inspection.autonomousActions).toEqual([]);
  expect(inspection.handoffEvents.every(event => event.requestRecordId === saved.id)).toBe(true);
}

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

  test.each(['unseeded', 'changed identity', 'non-synthetic account'])('harness refuses a %s conversation without adding support records', async kind => {
    const app = buildHarnessApp(), admin = await createAdmin();
    const user = await User.create({ firstName: 'Synthetic', lastName: 'Non-harness', email: 'unseeded@support-boundary.test', password: 'Synthetic123!', role: 'attorney', status: 'approved' });
    const conversation = await SupportConversation.create({ userId: user._id, role: user.role, status: 'open', metadata: kind === 'unseeded' ? {} : { support: {
      harnessScenarioKey: 'escalation', harnessSyntheticUserId: String(kind === 'changed identity' ? admin._id : user._id), harnessSeededByAdminId: String(admin._id), harnessSeededAt: new Date(),
    } } });
    const before = await SupportConversation.collection.findOne({ _id: conversation._id });
    const response = await request(app).post('/api/admin/support/dev/cco-autonomy/trigger').set('Cookie', authCookieFor(admin)).send({ conversationId: String(conversation._id), scenario: 'escalation' });
    expect({ status: response.status, messages: await SupportMessage.countDocuments({ conversationId: conversation._id }), tickets: await SupportTicket.countDocuments({ conversationId: conversation._id }), requests: await SupportMutation.countDocuments({ conversationId: conversation._id }) }).toEqual({ status: 403, messages: 0, tickets: 0, requests: 0 });
    expect(await SupportConversation.collection.findOne({ _id: conversation._id })).toEqual(before);
  });

  test("seed and trigger reopen scenario through the harness", async () => {
    const app = buildHarnessApp();
    const admin = await createAdmin();

    const seedRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/seed")
      .set("Cookie", authCookieFor(admin))
      .send({ scenario: "reopen" });

    expect(seedRes.status).toBe(201);
    expect(seedRes.body.seeded.expectedOutcome).toEqual({ requestState: 'succeeded', ticketStatus: 'in_review', routingOwner: 'founder_review', incidentLinked: false });
    expect(seedRes.body.inspection.supportRequests).toEqual([]);
    expect(seedRes.body.inspection.tickets[0].status).toBe("resolved");

    const triggerRes = await request(app)
      .post("/api/admin/support/dev/cco-autonomy/trigger")
      .set("Cookie", authCookieFor(admin))
      .send({
        conversationId: seedRes.body.seeded.conversationId,
      });

    expect(triggerRes.status).toBe(201);
    expectSavedHarnessOutcome(triggerRes.body);
    expect(triggerRes.body.inspection.handoffEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'support.ticket.escalated', actorType: 'user', routingStatus: 'routed' }),
      expect.objectContaining({ eventType: 'support.submission.created', actorType: 'user', routingStatus: 'skipped' }),
    ]));
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
    expectSavedHarnessOutcome(triggerRes.body);
    expect(triggerRes.body.inspection.handoffEvents).toEqual([]);
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
    expectSavedHarnessOutcome(triggerRes.body);
    expect(triggerRes.body.inspection.handoffEvents).toContainEqual(expect.objectContaining({
      eventType: 'support.submission.created', actorType: 'user', routingStatus: 'pending',
      incidentId: triggerRes.body.inspection.incidents[0].id,
    }));
  });
});
