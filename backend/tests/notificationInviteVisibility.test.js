const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { Types } = require("mongoose");

const User = require("../models/User");
const Case = require("../models/Case");
const Block = require("../models/Block");
const Notification = require("../models/Notification");
const { createAuthSession, revokeSession } = require("../services/authSessionService");
const notificationsRouter = require("../routes/notifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

// Exercise the mounted route's real Case projection, access presentation and
// token/account/session checks. No auth, query or presentation mocks are used.
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/notifications", notificationsRouter);
app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message || "Server error" });
});

const ENDPOINTS = ["/api/notifications", "/api/notifications/unread-count"];
const INVITED_AT = new Date("2026-09-01T12:00:00.000Z");
let owner;
let first;
let later;

async function actor(name, role = "paralegal") {
  const user = await User.create({
    firstName: "Synthetic",
    lastName: name,
    email: `${name}@notification-invite.test`,
    password: "SyntheticInvite123!",
    role,
    status: "approved",
    state: "CA",
  });
  const { sessionId } = await createAuthSession(user, {});
  const token = jwt.sign({
    id: String(user._id),
    role: user.role,
    av: Number(user.authVersion || 0),
    sid: sessionId,
  }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { user, sessionId, cookie: `token=${token}` };
}

function invite(recipient, index = 0, status = "pending") {
  return {
    paralegalId: recipient.user._id,
    status,
    invitedAt: new Date(INVITED_AT.getTime() + index * 1000),
  };
}

async function matter(overrides = {}) {
  return Case.create({
    title: "Synthetic invitation visibility",
    details: "Private Matter details must not appear in the notification DTO.",
    practiceArea: "Civil Litigation",
    attorney: owner.user._id,
    attorneyId: owner.user._id,
    status: "open",
    totalAmount: 50000,
    currency: "usd",
    pendingParalegalId: first.user._id,
    pendingParalegalInvitedAt: INVITED_AT,
    invites: [invite(first), invite(later, 1)],
    applicants: [],
    ...overrides,
  });
}

async function notification(recipient, caseDoc, overrides = {}) {
  return Notification.create({
    userId: recipient.user._id,
    type: "case_invite",
    read: false,
    isRead: false,
    actorUserId: owner.user._id,
    payload: { caseId: caseDoc._id, caseTitle: caseDoc.title },
    ...overrides,
  });
}

async function readNotifications(recipient) {
  const [list, count] = await Promise.all(ENDPOINTS.map(endpoint =>
    request(app).get(endpoint).set("Cookie", recipient.cookie)
  ));
  expect(list.status).toBe(200);
  expect(count.status).toBe(200);
  expect(Array.isArray(list.body)).toBe(true);
  expect(Number.isInteger(count.body.count)).toBe(true);
  return { items: list.body, count: count.body.count };
}

function expectVisible(result, records, unreadCount = records.length) {
  expect(result.items.map(item => item.id).sort()).toEqual(
    records.map(record => String(record._id)).sort()
  );
  expect(result.count).toBe(unreadCount);
  expect(result.items.every(item => item.available === true)).toBe(true);
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [owner, first, later] = await Promise.all([
    actor("owner", "attorney"),
    actor("first"),
    actor("later"),
  ]);
});

describe("mounted notification invitation visibility", () => {
  test("all pending invitees see their own invitation, including later invitees without applications", async () => {
    const third = await actor("third");
    const caseDoc = await matter({ invites: [invite(first), invite(later, 1), invite(third, 2)] });
    expect(caseDoc.applicants).toHaveLength(0);
    expect(caseDoc.paralegalId).toBeFalsy();
    expect(String(caseDoc.pendingParalegalId)).toBe(String(first.user._id));

    for (const recipient of [first, later, third]) {
      const record = await notification(recipient, caseDoc);
      const result = await readNotifications(recipient);
      expectVisible(result, [record]);
      expect(result.items[0].action).toEqual({
        label: "View invitation",
        href: `/dashboard-paralegal.html?inviteCase=${caseDoc._id}#home`,
      });
      expect(result.items[0].context.caseId).toBe(String(caseDoc._id));
      expect(JSON.stringify(result.items)).not.toContain(caseDoc.details);
    }
    expect(await Notification.countDocuments()).toBe(3);
  });

  test("a later invitee's exact unread count includes eligible records beyond the 100-item list", async () => {
    const caseDoc = await matter();
    const records = Array.from({ length: 107 }, (_, index) => ({
      userId: later.user._id,
      type: "case_invite",
      payload: { caseId: caseDoc._id },
      read: index >= 105,
      isRead: index >= 105,
      createdAt: new Date(INVITED_AT.getTime() + index),
    }));
    await Notification.insertMany(records);
    await notification(later, { _id: new Types.ObjectId() });

    const result = await readNotifications(later);
    expect(result.items).toHaveLength(100);
    expect(result.count).toBe(105);
    expect(result.items.filter(item => !item.read && !item.isRead)).toHaveLength(98);
    expect(result.items.every(item => item.available && item.context.caseId === String(caseDoc._id))).toBe(true);
    expect(await Notification.countDocuments({ userId: later.user._id })).toBe(108);
  });

  test.each(["accepted", "declined", "expired"])(
    "a %s invite without another relationship does not gain access from a stale legacy pending field",
    async status => {
      const caseDoc = await matter({
        pendingParalegalId: later.user._id,
        invites: [invite(first), invite(later, 1, status)],
      });
      await notification(later, caseDoc);
      expectVisible(await readNotifications(later), []);
      expect(await Notification.countDocuments({ userId: later.user._id })).toBe(1);
    }
  );

  test("acceptance with an accepted application preserves the existing current-access policy", async () => {
    const caseDoc = await matter({
      invites: [invite(first), invite(later, 1, "accepted")],
      applicants: [{ paralegalId: later.user._id, status: "accepted" }],
    });
    const invitation = await notification(later, caseDoc);
    const update = await notification(later, caseDoc, { type: "case_update" });
    expectVisible(await readNotifications(later), [invitation, update]);
  });

  test.each(["pending", "accepted", "rejected"])(
    "a retained raw applicants.paralegal alias keeps the existing %s application policy",
    async status => {
      const caseDoc = await matter({ invites: [], pendingParalegalId: null });
      // Current writes require paralegalId. Seed an earlier stored shape through
      // the collection so Mongoose cannot silently normalize the retained alias
      // that notificationPresentation.findApplicant explicitly supports.
      await Case.collection.updateOne({ _id: caseDoc._id }, {
        $set: { applicants: [{ paralegal: later.user._id, status }] },
      });
      const stored = await Case.collection.findOne({ _id: caseDoc._id });
      expect(stored.applicants[0]).not.toHaveProperty("paralegalId");
      const record = await notification(later, caseDoc, { type: "case_update" });
      expectVisible(await readNotifications(later), status === "rejected" ? [] : [record]);
      expect(await Notification.countDocuments()).toBe(1);
    }
  );

  test("revoking a later invitation removes its target from both responses without deleting its record", async () => {
    const caseDoc = await matter();
    const firstRecord = await notification(first, caseDoc);
    const laterRecord = await notification(later, caseDoc);
    expectVisible(await readNotifications(later), [laterRecord]);

    await Case.updateOne({ _id: caseDoc._id }, {
      $pull: { invites: { paralegalId: later.user._id } },
    });
    expectVisible(await readNotifications(later), []);
    expectVisible(await readNotifications(first), [firstRecord]);
    expect(await Notification.countDocuments()).toBe(2);
  });

  test("a missing Matter and an unrelated recipient stay absent from both list and count", async () => {
    const unrelated = await actor("unrelated");
    const caseDoc = await matter();
    const missingId = new Types.ObjectId();
    await notification(unrelated, caseDoc);
    await notification(later, { _id: missingId });

    expectVisible(await readNotifications(unrelated), []);
    expectVisible(await readNotifications(later), []);
    expect(await Notification.countDocuments()).toBe(2);
  });

  test.each(["attorney", "paralegal"])(
    "an active block created by the %s suppresses the later invitee while an inactive block does not",
    async blockerRole => {
      const caseDoc = await matter();
      const firstRecord = await notification(first, caseDoc);
      const laterRecord = await notification(later, caseDoc);
      const blocker = blockerRole === "attorney" ? owner : later;
      const blocked = blockerRole === "attorney" ? later : owner;
      const block = await Block.create({
        blockerId: blocker.user._id,
        blockedId: blocked.user._id,
        blockerRole: blocker.user.role,
        blockedRole: blocked.user.role,
        sourceType: "legacy",
        active: true,
      });

      expectVisible(await readNotifications(later), []);
      expectVisible(await readNotifications(first), [firstRecord]);
      await Block.updateOne({ _id: block._id }, { $set: { active: false } });
      expectVisible(await readNotifications(later), [laterRecord]);
      expect(await Notification.countDocuments()).toBe(2);
    }
  );

  test("declined invitation and rejected application history remain self-scoped without reopening the Matter", async () => {
    const caseDoc = await matter({
      invites: [invite(first), invite(later, 1, "declined")],
      applicants: [{ paralegalId: later.user._id, status: "rejected" }],
    });
    await notification(later, caseDoc);
    const response = await notification(later, caseDoc, {
      type: "case_invite_response",
      payload: { caseId: caseDoc._id, response: "filled" },
    });
    const rejection = await notification(later, caseDoc, { type: "application_denied" });
    const result = await readNotifications(later);
    expectVisible(result, [response, rejection]);
    expect(result.items.find(item => item.id === String(response._id)).action.href).toBe("/browse-jobs.html");
    expect(result.items.find(item => item.id === String(rejection._id)).action.href).toBe("/dashboard-paralegal.html#cases");
    expect(await Notification.countDocuments()).toBe(3);
  });

  test("withdrawn users retain safe payout and review history but lose prior workspace notifications", async () => {
    const withdrawnAt = new Date("2026-09-02T12:00:00.000Z");
    const caseDoc = await matter({
      status: "paused",
      invites: [],
      pendingParalegalId: null,
      paralegal: first.user._id,
      paralegalId: first.user._id,
      withdrawnParalegalId: later.user._id,
      paralegalAccessRevokedAt: withdrawnAt,
      pausedAt: withdrawnAt,
    });
    await notification(later, caseDoc, { type: "message", createdAt: INVITED_AT });
    await notification(later, caseDoc, { type: "case_update", createdAt: INVITED_AT });
    const payout = await notification(later, caseDoc, { type: "payout_released" });
    const review = await notification(later, caseDoc, { type: "dispute_opened" });
    const update = await notification(later, caseDoc, {
      type: "case_update",
      createdAt: new Date(withdrawnAt.getTime() + 1000),
    });

    const result = await readNotifications(later);
    expectVisible(result, [payout, review, update]);
    expect(result.items.every(item =>
      item.action.href === `/dashboard-paralegal.html?highlightCase=${caseDoc._id}#cases-completed`
    )).toBe(true);
    expect(await Notification.countDocuments()).toBe(5);
  });

  test("the owner and admin retain their own authorized notices without exposing them to another attorney", async () => {
    const unrelatedAttorney = await actor("unrelated-attorney", "attorney");
    const admin = await actor("admin", "admin");
    const caseDoc = await matter({ invites: [], pendingParalegalId: null });
    const ownerRecord = await notification(owner, caseDoc, { type: "case_update" });
    const adminRecord = await notification(admin, caseDoc, { type: "case_update" });
    await notification(unrelatedAttorney, caseDoc, { type: "case_update" });

    expectVisible(await readNotifications(owner), [ownerRecord]);
    expectVisible(await readNotifications(admin), [adminRecord]);
    expectVisible(await readNotifications(unrelatedAttorney), []);
    expect(await Notification.countDocuments()).toBe(3);
  });

  test("both routes reject an absent token and a revoked managed session", async () => {
    const caseDoc = await matter();
    await notification(later, caseDoc);
    for (const endpoint of ENDPOINTS) {
      expect((await request(app).get(endpoint)).status).toBe(401);
    }
    await revokeSession(later.sessionId, later.user._id, "synthetic-test-revocation");
    for (const endpoint of ENDPOINTS) {
      const result = await request(app).get(endpoint).set("Cookie", later.cookie);
      expect(result.status).toBe(403);
      expect(result.body).not.toHaveProperty("count");
      expect(Array.isArray(result.body)).toBe(false);
    }
    expect(await Notification.countDocuments()).toBe(1);
  });
});
