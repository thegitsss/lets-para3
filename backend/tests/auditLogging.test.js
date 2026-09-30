const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const Notification = require("../models/Notification");
const AuthSession = require("../models/AuthSession");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const adminRouter = require("../routes/admin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin", adminRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
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

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Audit logging", () => {
  test.each([
    { name: "a reason", body: { reason: "Security review" }, reasonProvided: true, customMessageProvided: false },
    { name: "a custom notice", body: { reason: "Security review", message: "Contact LPC about your account." }, reasonProvided: true, customMessageProvided: true },
    { name: "only a custom notice", body: { message: "Contact LPC about your account." }, reasonProvided: false, customMessageProvided: true },
    { name: "no notice", body: { reason: "  ", message: "  " }, reasonProvided: false, customMessageProvided: false },
  ])("Admin suspension with $name records safe metadata and preserves the account action", async ({ body, reasonProvided, customMessageProvided }) => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    await AuthSession.create({ userId: attorney._id, sessionId: require("node:crypto").randomUUID(), expiresAt: new Date(Date.now() + 3600000) });
    const matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, title: "Retained active Matter", details: "Preserve funded work", practiceArea: "immigration", status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_local_suspension", totalAmount: 40000 });
    const before = await Case.collection.findOne({ _id: matter._id });

    const res = await request(app)
      .post(`/api/admin/disable/${attorney._id}`)
      .set("Cookie", authCookieFor(admin))
      .send(body);
    expect(res.status).toBe(200);
    expect((await User.findById(attorney._id).select("+authVersion")).disabled).toBe(true);
    expect(await AuthSession.countDocuments({ userId: attorney._id, revokedAt: null })).toBe(0);
    expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);

    const log = await AuditLog.findOne({
      action: "admin.user.suspended",
      targetId: String(attorney._id),
    }).lean();

    expect(log).toBeTruthy();
    expect(String(log.actor)).toBe(String(admin._id));
    expect(log.actorRole).toBe("admin");
    expect(log.targetType).toBe("user");
    expect(log.meta).toMatchObject({ reasonProvided, customMessageProvided, notificationAttempted: reasonProvided || customMessageProvided });
    expect(JSON.stringify(log.meta)).not.toContain("Security review");
    expect(JSON.stringify(log.meta)).not.toContain("Contact LPC about your account.");
    expect(log.meta).not.toHaveProperty("reason");
    expect(log.meta).not.toHaveProperty("message");
    expect(log.path).toMatch(/\/api\/admin\/disable\/.+/);
    const notices = await Notification.find({ userId: attorney._id, type: "account_suspended" }).lean();
    expect(notices).toHaveLength(reasonProvided || customMessageProvided ? 1 : 0);
    if (notices.length) {
      expect(String(notices[0].actorUserId)).toBe(String(admin._id));
      expect(notices[0].payload.reason).toBe(reasonProvided ? body.reason : "Policy review");
      expect(notices[0].payload.customNote).toBe(body.message || "");
      expect(log.meta.notification).toContain("email delivery is not confirmed");
    } else expect(log.meta.notification).toBe("No account notification requested.");
  });
});
