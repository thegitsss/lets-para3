const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const adminRouter = require("../routes/admin");
const authRouter = require("../routes/auth");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const sendEmail = require("../utils/email");

jest.mock("../utils/email", () => {
  const fn = jest.fn();
  fn.sendWelcomePacket = jest.fn();
  fn.sendProfilePhotoRejectedEmail = jest.fn();
  return fn;
});

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/auth", authRouter);
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
  sendEmail.mockClear();
  if (sendEmail.sendWelcomePacket?.mockClear) sendEmail.sendWelcomePacket.mockClear();
  if (sendEmail.sendProfilePhotoRejectedEmail?.mockClear) sendEmail.sendProfilePhotoRejectedEmail.mockClear();
});

describe("Admin workflows", () => {
  test("Admin approves attorney registration and login succeeds", async () => {
    // Description: Admin approves a pending attorney and the attorney can log in.
    // Input values: admin role=admin; attorney status=pending; approval note="Looks good".
    // Expected result: status=approved, approvedAt set, login returns success=true.

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
      status: "pending",
      state: "CA",
    });

    const pendingLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body.msg).toMatch(/pending admin approval/i);

    const approveRes = await request(app)
      .post(`/api/admin/users/${attorney._id}/approve`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Looks good" });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.ok).toBe(true);
    expect(approveRes.body.user.status).toBe("approved");

    const updated = await User.findById(attorney._id);
    expect(updated.status).toBe("approved");
    expect(updated.approvedAt).toBeTruthy();

    const approvedLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(approvedLogin.status).toBe(200);
    expect(approvedLogin.body.success).toBe(true);
  });

  test("Admin denies attorney registration and denial email is sent", async () => {
    // Description: Admin denies a pending attorney and a denial email is sent.
    // Input values: admin role=admin; attorney status=pending; denial note="Missing docs".
    // Expected result: status=denied, sendEmail called with denial subject, login blocked.

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
      firstName: "Morgan",
      lastName: "Lee",
      email: "morgan.lee@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    const denyRes = await request(app)
      .post(`/api/admin/users/${attorney._id}/deny`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Missing docs" });
    expect(denyRes.status).toBe(200);
    expect(denyRes.body.ok).toBe(true);
    expect(denyRes.body.user.status).toBe("denied");

    const updated = await User.findById(attorney._id);
    expect(updated.status).toBe("denied");

    expect(sendEmail).toHaveBeenCalled();
    const [to, subject] = sendEmail.mock.calls[0];
    expect(to).toBe(attorney.email);
    expect(subject).toMatch(/not approved/i);

    const deniedLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(deniedLogin.status).toBe(403);
    expect(deniedLogin.body.msg).toMatch(/not approved/i);
  });

  test("Non-admin cannot approve attorney registrations", async () => {
    // Description: A non-admin user attempts to approve an attorney.
    // Input values: actor role=attorney; target status=pending.
    // Expected result: 403 forbidden.

    const actor = await User.create({
      firstName: "Avery",
      lastName: "Cruz",
      email: "avery.cruz@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const target = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    const res = await request(app)
      .post(`/api/admin/users/${target._id}/approve`)
      .set("Cookie", authCookieFor(actor))
      .send({ note: "Trying to approve" });
    expect(res.status).toBe(403);
  });

  test("Admin deactivated-users list only returns actually deactivated accounts", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner3@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const deactivatedUser = await User.create({
      firstName: "Dee",
      lastName: "Activated",
      email: "dee.activated@example.com",
      password: "Password123!",
      role: "attorney",
      status: "denied",
      disabled: true,
      deleted: true,
      deletedAt: new Date("2026-03-16T12:00:00.000Z"),
      state: "CA",
    });

    await User.create({
      firstName: "Susie",
      lastName: "Denied",
      email: "susie.denied@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "denied",
      disabled: true,
      deleted: false,
      state: "CA",
    });

    const res = await request(app)
      .get("/api/admin/pending-users?status=deactivated")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users).toHaveLength(1);
    expect(String(res.body.users[0].id)).toBe(String(deactivatedUser._id));
    expect(res.body.users[0].deleted).toBe(true);
    expect(res.body.users[0].deletedAt).toBeTruthy();
  });

  test("Admin can force-delete a hired funded case from the posts workflow", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner4@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const attorney = await User.create({
      firstName: "Avery",
      lastName: "Stone",
      email: "avery.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Jamie",
      lastName: "Lee",
      email: "jamie.lee@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Force delete test",
      practiceArea: "probate",
      details: "Admin delete should override hired and funded restrictions.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_force_delete",
      totalAmount: 50000,
      currency: "usd",
    });

    const job = await Job.create({
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      title: "Force delete test",
      practiceArea: "probate",
      description: "Linked job should also be removed.",
      budget: 500,
      status: "assigned",
    });

    await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "Interested in helping.",
      status: "accepted",
    });

    const res = await request(app)
      .delete(`/api/admin/cases/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ reason: "Policy violation", message: "Remove immediately." });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const [deletedCase, deletedJob, deletedApplication] = await Promise.all([
      Case.findById(caseDoc._id).lean(),
      Job.findById(job._id).lean(),
      Application.findOne({ jobId: job._id, paralegalId: paralegal._id }).lean(),
    ]);

    expect(deletedCase).toBeNull();
    expect(deletedJob).toBeNull();
    expect(deletedApplication).toBeNull();
  });

  test("Admin analytics aggregates payment totals for the dashboard", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "analytics-owner@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const attorney = await User.create({
      firstName: "Jamie",
      lastName: "Attorney",
      email: "jamie.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Taylor",
      lastName: "Paralegal",
      email: "taylor.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const [liveCase, testCase, unknownCase] = await Case.create([
      {
        title: "Live funded case",
        details: "Live payment data",
        status: "completed",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        lockedTotalAmount: 100000,
        totalAmount: 100000,
        paymentReleased: true,
        stripeMode: "live",
        paidOutAt: new Date("2026-03-10T12:00:00.000Z"),
      },
      {
        title: "Test funded case",
        details: "Test payment data",
        status: "completed",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        lockedTotalAmount: 50000,
        totalAmount: 50000,
        paymentReleased: false,
        stripeMode: "test",
        completedAt: new Date("2026-03-11T12:00:00.000Z"),
      },
      {
        title: "Unknown funded case",
        details: "Legacy payment data",
        status: "open",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        lockedTotalAmount: 25000,
        totalAmount: 25000,
        paymentReleased: false,
        stripeMode: "unknown",
      },
    ]);

    await Payout.create({
      paralegalId: paralegal._id,
      caseId: liveCase._id,
      amountPaid: 82000,
      transferId: "tr_live_123",
      stripeMode: "live",
    });

    await PlatformIncome.create([
      {
        caseId: liveCase._id,
        attorneyId: attorney._id,
        paralegalId: paralegal._id,
        feeAmount: 40000,
        stripeMode: "live",
      },
      {
        caseId: testCase._id,
        attorneyId: attorney._id,
        paralegalId: paralegal._id,
        feeAmount: 20000,
        stripeMode: "test",
      },
    ]);

    const analyticsRes = await request(app)
      .get("/api/admin/analytics")
      .set("Cookie", authCookieFor(admin));

    expect(analyticsRes.status).toBe(200);
    expect(analyticsRes.body.escrowMetrics.totalEscrowReleased).toBe(100000);
    expect(analyticsRes.body.escrowMetrics.totalEscrowHeld).toBe(75000);
    expect(analyticsRes.body.revenueMetrics.platformFeesCollected).toBe(60000);

    const payoutsRes = await request(app)
      .get("/api/admin/payouts")
      .set("Cookie", authCookieFor(admin));

    expect(payoutsRes.status).toBe(200);
    expect(payoutsRes.body.totalAmount).toBe(82000);
    expect(payoutsRes.body.count).toBe(1);

    const incomeRes = await request(app)
      .get("/api/admin/income")
      .set("Cookie", authCookieFor(admin));

    expect(incomeRes.status).toBe(200);
    expect(incomeRes.body.totalAmount).toBe(60000);
    expect(incomeRes.body.count).toBe(2);
  });

  test("Admin financial reporting start date hides older money totals", async () => {
    const originalStart = process.env.ADMIN_FINANCIAL_REPORTING_START_AT;
    process.env.ADMIN_FINANCIAL_REPORTING_START_AT = "2030-01-01T00:00:00Z";

    try {
      const admin = await User.create({
        firstName: "Admin",
        lastName: "Owner",
        email: "baseline-owner@lets-paraconnect.com",
        password: "Password123!",
        role: "admin",
        status: "approved",
        state: "CA",
      });

      const attorney = await User.create({
        firstName: "Future",
        lastName: "Attorney",
        email: "future.attorney@example.com",
        password: "Password123!",
        role: "attorney",
        status: "approved",
        state: "CA",
      });

      const paralegal = await User.create({
        firstName: "Future",
        lastName: "Paralegal",
        email: "future.paralegal@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        state: "CA",
      });

      const caseDoc = await Case.create({
        title: "Old funded case",
        details: "Should be hidden by reporting baseline",
        status: "completed",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        lockedTotalAmount: 90000,
        totalAmount: 90000,
        paymentReleased: true,
        stripeMode: "live",
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
      });

      await Payout.create({
        paralegalId: paralegal._id,
        caseId: caseDoc._id,
        amountPaid: 70000,
        transferId: "tr_old_hidden",
        stripeMode: "live",
        createdAt: new Date("2026-03-02T12:00:00.000Z"),
      });

      await PlatformIncome.create({
        caseId: caseDoc._id,
        attorneyId: attorney._id,
        paralegalId: paralegal._id,
        feeAmount: 20000,
        stripeMode: "live",
        createdAt: new Date("2026-03-02T12:00:00.000Z"),
      });

      const analyticsRes = await request(app)
        .get("/api/admin/analytics")
        .set("Cookie", authCookieFor(admin));

      expect(analyticsRes.status).toBe(200);
      expect(analyticsRes.body.escrowMetrics.totalEscrowHeld).toBe(0);
      expect(analyticsRes.body.escrowMetrics.totalEscrowReleased).toBe(0);
      expect(analyticsRes.body.revenueMetrics.platformFeesCollected).toBe(0);

      const payoutsRes = await request(app)
        .get("/api/admin/payouts")
        .set("Cookie", authCookieFor(admin));

      expect(payoutsRes.status).toBe(200);
      expect(payoutsRes.body.totalAmount).toBe(0);
      expect(payoutsRes.body.count).toBe(0);

      const incomeRes = await request(app)
        .get("/api/admin/income")
        .set("Cookie", authCookieFor(admin));

      expect(incomeRes.status).toBe(200);
      expect(incomeRes.body.totalAmount).toBe(0);
      expect(incomeRes.body.count).toBe(0);
    } finally {
      if (originalStart == null) {
        delete process.env.ADMIN_FINANCIAL_REPORTING_START_AT;
      } else {
        process.env.ADMIN_FINANCIAL_REPORTING_START_AT = originalStart;
      }
    }
  });
});
