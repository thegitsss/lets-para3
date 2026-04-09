const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

const User = require("../models/User");
const Case = require("../models/Case");
const adminRouter = require("../routes/admin");
const casesRouter = require("../routes/cases");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin", adminRouter);
  instance.use("/api/cases", casesRouter);
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

describe("Case lifecycle transitions", () => {
  test("Open (with assignee) → in progress → completed → archived", async () => {
    // Description: Admin and attorney move a case through lifecycle.
    // Input values: status transitions + archive=true.
    // Expected result: status updates in order and archived=true.

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
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "Lifecycle test case details.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const assignRes = await request(app)
      .patch(`/api/admin/assign/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ paralegalId: paralegal._id });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.case.status).toBe("open");
    const assignedParalegal =
      assignRes.body.case.paralegal?._id ||
      assignRes.body.case.paralegalId?._id ||
      assignRes.body.case.paralegal ||
      assignRes.body.case.paralegalId;
    expect(String(assignedParalegal)).toBe(String(paralegal._id));

    const inProgressRes = await request(app)
      .patch(`/api/admin/cases/${caseDoc._id}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "in progress" });
    expect(inProgressRes.status).toBe(200);
    expect(inProgressRes.body.case.status).toMatch(/in progress/i);

    const completedRes = await request(app)
      .patch(`/api/admin/cases/${caseDoc._id}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "completed" });
    expect(completedRes.status).toBe(200);
    expect(completedRes.body.case.status).toBe("completed");

    const archiveRes = await request(app)
      .patch(`/api/cases/${caseDoc._id}/archive`)
      .set("Cookie", authCookieFor(attorney))
      .send({ archived: true });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.archived).toBe(true);
  });

  test("Guardrail: invalid transition is blocked", async () => {
    // Description: Admin attempts invalid transition open → completed.
    // Input values: status="completed" on open case.
    // Expected result: 400 with invalid transition message.

    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner2@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone2@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Contract review",
      details: "Lifecycle test case details.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .patch(`/api/admin/cases/${caseDoc._id}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "completed" });
    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/Invalid transition/i);
  });

  test("Attorney can delete an archived completed case after hiring and payment release", async () => {
    const attorney = await User.create({
      firstName: "Dana",
      lastName: "Hart",
      email: "dana.hart@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Robin",
      lastName: "Cole",
      email: "robin.cole@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Archived completion delete",
      details: "Completed archived cases should be removable from the dashboard archive.",
      status: "completed",
      archived: true,
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      paymentReleased: true,
      hiredAt: new Date("2026-03-01T00:00:00.000Z"),
      completedAt: new Date("2026-03-10T00:00:00.000Z"),
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .delete(`/api/cases/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await Case.findById(caseDoc._id).lean()).toBeNull();
  });

  test("Attorney still cannot delete an active hired funded case", async () => {
    const attorney = await User.create({
      firstName: "Morgan",
      lastName: "Bell",
      email: "morgan.bell@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Taylor",
      lastName: "Reed",
      email: "taylor.reed@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Active hire delete guardrail",
      details: "Active hired cases should still be protected from deletion.",
      status: "in progress",
      archived: false,
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      paymentReleased: false,
      hiredAt: new Date("2026-03-05T00:00:00.000Z"),
      totalAmount: 80000,
      currency: "usd",
    });

    const res = await request(app)
      .delete(`/api/cases/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot delete a case after hiring a paralegal");
    expect(await Case.findById(caseDoc._id).lean()).not.toBeNull();
  });
});
