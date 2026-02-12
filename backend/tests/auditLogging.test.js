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
  test("Admin case status update writes audit log", async () => {
    // Description: Admin changes a case status and the action is logged.
    // Input values: status="assigned" on open case.
    // Expected result: AuditLog entry with action="admin.case.status.update".

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

    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "Audit logging test case details.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .patch(`/api/admin/cases/${caseDoc._id}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "assigned" });
    expect(res.status).toBe(200);

    const log = await AuditLog.findOne({
      action: "admin.case.status.update",
      targetId: String(caseDoc._id),
    }).lean();

    expect(log).toBeTruthy();
    expect(String(log.actor)).toBe(String(admin._id));
    expect(log.actorRole).toBe("admin");
    expect(log.targetType).toBe("case");
    expect(String(log.case)).toBe(String(caseDoc._id));
    expect(log.meta?.status).toBe("assigned");
    expect(log.path).toMatch(/\/api\/admin\/cases\/.+\/status/);
  });
});
