const express = require("express");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const cookieParser = require("cookie-parser");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const User = require("../models/User");
const Case = require("../models/Case");
const { LpcEvent } = require("../models/LpcEvent");
const { LpcAction } = require("../models/LpcAction");
const { publishEvent } = require("../services/lpcEvents/publishEventService");
const { emitIncompleteProfileWindowEvents } = require("../services/lpcEvents/timedTriggerService");
const {
  buildFounderFocusView,
  buildLifecycleFocusView,
  getFounderCopilotRollup,
} = require("../services/founderCopilot/rollupService");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

async function createUser(overrides = {}) {
  return User.create({
    firstName: "Test",
    lastName: "User",
    email: `user-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    role: "paralegal",
    status: "pending",
    state: "NY",
    termsAccepted: true,
    emailVerified: true,
    ...overrides,
  });
}

function signCookie(user) {
  const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
  return `token=${token}`;
}

describe("LPC Phase 1 event routing", () => {
  beforeAll(async () => {
    await connect();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("publishes a signup event and routes a lifecycle follow-up", async () => {
    const user = await createUser({ role: "attorney", status: "pending", lawFirm: "" });

    const { event, created } = await publishEvent({
      eventType: "user.signup.created",
      eventFamily: "platform_user",
      idempotencyKey: `user:${user._id}:signup`,
      correlationId: `user:${user._id}`,
      actor: {
        actorType: "user",
        userId: user._id,
        role: user.role,
        email: user.email,
      },
      subject: {
        entityType: "user",
        entityId: String(user._id),
      },
      related: {
        userId: user._id,
      },
      source: {
        surface: "public",
        route: "/api/auth/register",
        service: "auth",
        producer: "route",
      },
      facts: {
        after: {
          email: user.email,
          role: user.role,
          status: user.status,
        },
      },
      signals: {
        confidence: "high",
        priority: "normal",
      },
    });

    expect(created).toBe(true);
    expect(event.eventType).toBe("user.signup.created");
    expect(event.routing.status).toBe("routed");

    const actions = await LpcAction.find({ actionType: "lifecycle_follow_up", status: "open" }).lean();
    expect(actions).toHaveLength(1);
    expect(actions[0].dedupeKey).toBe(`lifecycle:user-signup:${user._id}`);
    expect(actions[0].related.userId?.toString()).toBe(String(user._id));
  });

  test("dedupes event publishing by idempotency key", async () => {
    const user = await createUser();

    const payload = {
      eventType: "user.signup.created",
      eventFamily: "platform_user",
      idempotencyKey: `user:${user._id}:signup`,
      correlationId: `user:${user._id}`,
      actor: {
        actorType: "user",
        userId: user._id,
        role: user.role,
        email: user.email,
      },
      subject: {
        entityType: "user",
        entityId: String(user._id),
      },
      related: { userId: user._id },
      source: { surface: "public", route: "/api/auth/register", service: "auth", producer: "route" },
      facts: { after: { email: user.email, role: user.role, status: user.status } },
      signals: { confidence: "high", priority: "normal" },
    };

    const first = await publishEvent(payload);
    const second = await publishEvent(payload);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await LpcEvent.countDocuments({})).toBe(1);
    expect(await LpcAction.countDocuments({ actionType: "lifecycle_follow_up", status: "open" })).toBe(1);
  });

  test("dedupes founder alerts across repeated dispute events", async () => {
    const attorney = await createUser({ role: "attorney", status: "approved" });
    const caseDoc = await Case.create({
      attorney: attorney._id,
      attorneyId: attorney._id,
      title: "Disputed matter",
      details: "Matter details",
      status: "disputed",
      totalAmount: 10000,
      lockedTotalAmount: 10000,
    });

    await publishEvent({
      eventType: "dispute.opened",
      eventFamily: "platform_case",
      idempotencyKey: `case:${caseDoc._id}:dispute:d1:event1`,
      correlationId: `case:${caseDoc._id}`,
      subject: { entityType: "case", entityId: String(caseDoc._id) },
      related: { caseId: caseDoc._id, userId: attorney._id },
      source: { surface: "attorney", route: `/api/disputes/${caseDoc._id}`, service: "disputes", producer: "route" },
      facts: {
        disputeId: "d1",
        caseTitle: caseDoc.title,
        summary: "Initial dispute event",
      },
      signals: { confidence: "high", priority: "urgent", founderVisible: true, moneyRisk: true },
    });

    await publishEvent({
      eventType: "dispute.opened",
      eventFamily: "platform_case",
      idempotencyKey: `case:${caseDoc._id}:dispute:d1:event2`,
      correlationId: `case:${caseDoc._id}`,
      subject: { entityType: "case", entityId: String(caseDoc._id) },
      related: { caseId: caseDoc._id, userId: attorney._id },
      source: { surface: "attorney", route: `/api/disputes/${caseDoc._id}`, service: "disputes", producer: "route" },
      facts: {
        disputeId: "d1",
        caseTitle: caseDoc.title,
        summary: "Repeated dispute event",
      },
      signals: { confidence: "high", priority: "urgent", founderVisible: true, moneyRisk: true },
    });

    const alerts = await LpcAction.find({ actionType: "founder_alert", status: "open" }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sourceEventIds).toHaveLength(2);
    expect(alerts[0].dedupeKey).toBe(`founder-alert:dispute:${caseDoc._id}:d1`);
  });

  test("creates lifecycle follow-up for public contact routing", async () => {
    const { event } = await publishEvent({
      eventType: "public.contact.submitted",
      eventFamily: "public_signal",
      actor: {
        actorType: "user",
        role: "visitor",
        email: "lead@example.com",
        label: "Lead Person",
      },
      subject: {
        entityType: "public_contact",
        entityId: "lead@example.com",
      },
      source: {
        surface: "public",
        route: "/api/public/contact",
        service: "public",
        producer: "route",
      },
      facts: {
        after: {
          email: "lead@example.com",
          subject: "Need more information",
        },
      },
      signals: {
        confidence: "high",
        priority: "normal",
      },
    });

    expect(event.routing.status).toBe("routed");
    const followUp = await LpcAction.findOne({ dedupeKey: "lifecycle:public-contact:lead@example.com" }).lean();
    expect(followUp).toBeTruthy();
    expect(followUp.actionType).toBe("lifecycle_follow_up");
  });

  test("emits timed incomplete-profile trigger once and creates lifecycle follow-up", async () => {
    const staleCreatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const user = await createUser({
      role: "paralegal",
      status: "pending",
      emailVerified: false,
      termsAccepted: false,
      resumeURL: "",
      certificateURL: "",
      yearsExperience: 0,
      createdAt: staleCreatedAt,
    });

    await User.updateOne({ _id: user._id }, { $set: { createdAt: staleCreatedAt } });

    const firstRun = await emitIncompleteProfileWindowEvents();
    const secondRun = await emitIncompleteProfileWindowEvents();

    expect(firstRun.emittedCount).toBe(1);
    expect(secondRun.emittedCount).toBe(0);
    expect(await LpcEvent.countDocuments({ eventType: "user.profile.incomplete_window_elapsed" })).toBe(1);

    const action = await LpcAction.findOne({
      dedupeKey: `lifecycle:user-profile-incomplete:${user._id}`,
      status: "open",
    }).lean();
    expect(action).toBeTruthy();
    expect(action.metadata.missingFields).toEqual(
      expect.arrayContaining(["email verification", "accepted terms", "resume", "certificate", "experience history"])
    );
  });

  test("builds founder copilot rollup from open actions", async () => {
    const user = await createUser({ status: "approved" });
    await LpcAction.create({
      actionType: "founder_alert",
      status: "open",
      dedupeKey: "founder-alert:test:1",
      ownerLabel: "Samantha",
      title: "Founder alert",
      summary: "Review this alert",
      recommendedAction: "Open the alert",
      priority: "urgent",
      subject: { entityType: "case", entityId: "case-1" },
      related: { userId: user._id },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      openedBy: { actorType: "system", label: "Test" },
    });
    await LpcAction.create({
      actionType: "lifecycle_follow_up",
      status: "open",
      dedupeKey: "lifecycle:test:1",
      ownerLabel: "Samantha",
      title: "Lifecycle item",
      summary: "Review this follow-up",
      recommendedAction: "Open the follow-up",
      priority: "normal",
      subject: { entityType: "user", entityId: String(user._id) },
      related: { userId: user._id },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      dueAt: new Date(Date.now() - 60 * 1000),
      openedBy: { actorType: "system", label: "Test" },
    });

    const rollup = await getFounderCopilotRollup();
    const founderView = buildFounderFocusView(rollup);
    const lifecycleView = buildLifecycleFocusView(rollup);

    expect(rollup.founder.urgentCount).toBe(1);
    expect(rollup.founder.reviewCount).toBe(2);
    expect(rollup.lifecycle.followUpTodayCount).toBe(1);
    expect(founderView.title).toBe("Founder Copilot");
    expect(lifecycleView.title).toBe("Lifecycle & Follow-Up");
  });

  test("founder control-room endpoint uses the event-backed rollup", async () => {
    const admin = await createUser({
      role: "admin",
      status: "approved",
      email: "admin@example.com",
    });
    await LpcAction.create({
      actionType: "founder_alert",
      status: "open",
      dedupeKey: "founder-alert:test-route:1",
      ownerLabel: "Samantha",
      title: "Founder alert from route test",
      summary: "Route-backed rollup",
      recommendedAction: "Review it",
      priority: "urgent",
      subject: { entityType: "case", entityId: "case-route" },
      related: {},
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      openedBy: { actorType: "system", label: "Test" },
    });

    const app = express();
    app.use(cookieParser());
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/admin/ai", require("../routes/aiAdmin"));
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err?.message || "Unknown error" });
    });

    const res = await request(app)
      .get("/api/admin/ai/control-room/founder")
      .set("Cookie", signCookie(admin));

    expect(res.status).toBe(200);
    expect(res.body.view.title).toBe("Founder Copilot");
    expect(res.body.view.queueLabel).toMatch(/1 urgent item/i);
  });
});
