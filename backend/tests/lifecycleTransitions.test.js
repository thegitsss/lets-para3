const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
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
  test("Open → funded work → paid completion requires the full lifecycle evidence", async () => {
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

    expect(() => caseDoc.transitionTo("in progress")).toThrow(/active_paralegal_required/);

    const fundedAt = new Date("2026-08-01T12:00:00.000Z");
    caseDoc.paralegal = paralegal._id;
    caseDoc.paralegalId = paralegal._id;
    caseDoc.hiredAt = fundedAt;
    caseDoc.escrowIntentId = "pi_lifecycle_verified";
    caseDoc.escrowStatus = "funded";
    caseDoc.fundingIntegrityStatus = "verified";
    caseDoc.transitionTo("in progress");
    expect(caseDoc.status).toBe("in progress");

    expect(() => caseDoc.transitionTo("completed")).toThrow(/payment_release_required/);

    const completedAt = new Date("2026-08-08T12:00:00.000Z");
    caseDoc.paymentReleased = true;
    caseDoc.payoutTransferId = "tr_lifecycle_verified";
    caseDoc.paidOutAt = completedAt;
    caseDoc.completedAt = completedAt;
    caseDoc.archived = true;
    caseDoc.readOnly = true;
    caseDoc.transitionTo("completed");
    await caseDoc.save();

    const stored = await Case.findById(caseDoc._id).lean();
    expect(stored.status).toBe("completed");
    expect(stored.archived).toBe(true);
    expect(stored.readOnly).toBe(true);
    expect(stored.paymentReleased).toBe(true);
  });

  test("Obsolete manual assignment and status mutation endpoints are retired", async () => {
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

    const assignment = await request(app)
      .patch(`/api/admin/assign/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ paralegalId: new mongoose.Types.ObjectId() });
    const statusMutation = await request(app)
      .patch(`/api/admin/cases/${caseDoc._id}/status`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "completed" });
    expect(assignment.status).toBe(404);
    expect(statusMutation.status).toBe(404);
    expect((await Case.findById(caseDoc._id).lean()).status).toBe("open");
  });

  test("Attorney cannot hard-delete an archived completed case with payment history", async () => {
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

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/never-engaged|retained|hiring a paralegal/i);
    expect(await Case.findById(caseDoc._id).lean()).not.toBeNull();
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

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/never-engaged|hiring a paralegal/i);
    expect(await Case.findById(caseDoc._id).lean()).not.toBeNull();
  });
});
