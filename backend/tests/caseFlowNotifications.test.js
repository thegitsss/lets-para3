const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Notification = require("../models/Notification");
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";
const casesRouter = require("../routes/cases");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
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

describe("Case flow notifications", () => {
  test("Paralegal application creates application_submitted notification for attorney", async () => {
    // Description: Paralegal applies to an open case.
    // Input values: attorney + paralegal, open case with at least one scope task.
    // Expected result: Notification type application_submitted is created for the attorney.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Immigration support",
      practiceArea: "immigration",
      details: "Case details for application notification test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 60000,
      currency: "usd",
      tasks: [{ title: "Draft initial filing", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/apply`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(res.status).toBe(201);

    const notif = await Notification.findOne({
      userId: attorney._id,
      type: "application_submitted",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif.payload?.caseId || "")).toBe(String(caseDoc._id));
  });

  test("Attorney hire creates case_work_ready notification for paralegal", async () => {
    // Description: Attorney hires a paralegal on a relisted funded case.
    // Input values: paused case with payout finalized and remaining amount > 0.
    // Expected result: Notification type case_work_ready is created for the hired paralegal.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1+1@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Relist and hire notification",
      practiceArea: "immigration",
      details: "Case details for hire notification test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "paused",
      pausedReason: "paralegal_withdrew",
      escrowStatus: "funded",
      escrowIntentId: "pi_relist_test",
      payoutFinalizedAt: new Date(Date.now() - 60 * 60 * 1000),
      totalAmount: 100000,
      remainingAmount: 60000,
      currency: "usd",
      tasks: [{ title: "Prepare next filing", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/hire/${paralegal._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const notif = await Notification.findOne({
      userId: paralegal._id,
      type: "case_work_ready",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif.payload?.caseId || "")).toBe(String(caseDoc._id));
  });
});
