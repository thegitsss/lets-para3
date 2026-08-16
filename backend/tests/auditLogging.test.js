const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
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
  test("Admin account suspension writes an audit log", async () => {
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

    const res = await request(app)
      .post(`/api/admin/disable/${attorney._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ reason: "Security review" });
    expect(res.status).toBe(200);

    const log = await AuditLog.findOne({
      action: "admin.user.suspended",
      targetId: String(attorney._id),
    }).lean();

    expect(log).toBeTruthy();
    expect(String(log.actor)).toBe(String(admin._id));
    expect(log.actorRole).toBe("admin");
    expect(log.targetType).toBe("user");
    expect(log.meta).toMatchObject({ reasonProvided: true, customMessageProvided: false });
    expect(JSON.stringify(log.meta)).not.toContain("Security review");
    expect(log.path).toMatch(/\/api\/admin\/disable\/.+/);
  });
});
