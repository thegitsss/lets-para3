const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { S3Client } = require("@aws-sdk/client-s3");

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const PaymentOperation = require("../models/PaymentOperation");
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
  test("Admin cannot approve a profile photo when its retained original fails malware scanning", async () => {
    const priorBucket = process.env.S3_BUCKET;
    const priorRegion = process.env.S3_REGION;
    const priorRequired = process.env.S3_MALWARE_SCAN_REQUIRED;
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_MALWARE_SCAN_REQUIRED = "true";
    const scanSpy = jest.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({
        TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
      })
      .mockResolvedValueOnce({
        TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "THREATS_FOUND" }],
      });

    try {
      const admin = await User.create({
        firstName: "Admin",
        lastName: "Reviewer",
        email: "photo-review-admin@example.com",
        password: "Password123!",
        role: "admin",
        status: "approved",
        state: "CA",
      });
      const candidate = await User.create({
        firstName: "Photo",
        lastName: "Candidate",
        email: "photo-candidate@example.com",
        password: "Password123!",
        role: "attorney",
        status: "approved",
        state: "CA",
      });
      candidate.pendingProfileImage = `profile-photos/${candidate._id}/profile-1760000000000.jpg`;
      candidate.pendingProfileImageKey = candidate.pendingProfileImage;
      candidate.pendingProfileImageOriginal = `profile-photos/${candidate._id}/original-1760000000001.jpg`;
      candidate.pendingProfileImageOriginalKey = candidate.pendingProfileImageOriginal;
      candidate.profilePhotoStatus = "pending_review";
      await candidate.save();

      const response = await request(app)
        .post(`/api/admin/profile-photos/${candidate._id}/approve`)
        .set("Cookie", authCookieFor(admin))
        .send({});

      expect(response.status).toBe(422);
      expect(response.body.code).toBe("FILE_SECURITY_BLOCKED");
      expect(scanSpy).toHaveBeenCalledTimes(2);
      const unchanged = await User.findById(candidate._id).select("+pendingProfileImageKey +pendingProfileImageOriginalKey");
      expect(unchanged.profilePhotoStatus).toBe("pending_review");
      expect(unchanged.pendingProfileImageOriginalKey).toContain("original-");
    } finally {
      scanSpy.mockRestore();
      if (priorBucket == null) delete process.env.S3_BUCKET;
      else process.env.S3_BUCKET = priorBucket;
      if (priorRegion == null) delete process.env.S3_REGION;
      else process.env.S3_REGION = priorRegion;
      if (priorRequired == null) delete process.env.S3_MALWARE_SCAN_REQUIRED;
      else process.env.S3_MALWARE_SCAN_REQUIRED = priorRequired;
    }
  });

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
      emailVerified: true,
      state: "CA",
    });

    const pendingLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body.msg).toMatch(/under review/i);

    const approveRes = await request(app)
      .post(`/api/admin/users/${attorney._id}/approve`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Looks good" });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.ok).toBe(true);
    expect(approveRes.body.user.status).toBe("approved");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [approvalEmailTo, approvalEmailSubject, approvalEmailHtml] = sendEmail.mock.calls[0];
    expect(approvalEmailTo).toBe(attorney.email);
    expect(approvalEmailSubject).toBe("Welcome to Let’s-ParaConnect");
    expect(approvalEmailHtml).toContain("Welcome to Let&rsquo;s-ParaConnect");
    expect(approvalEmailHtml).toContain("Congratulations! We are pleased to inform you that you have been accepted to Let&rsquo;s-ParaConnect.");
    expect(approvalEmailHtml).toContain("What You Can Use LPC For:");
    expect(approvalEmailHtml).toContain("Next Steps:");
    expect(approvalEmailHtml).toContain("Go to Your Dashboard");
    expect(approvalEmailHtml).toContain("https://www.linkedin.com/company/lets-paraconnect/");
    expect(approvalEmailHtml).not.toMatch(/facebook|instagram/i);
    expect(approvalEmailHtml).not.toContain("Attorney launch begins today");

    const updated = await User.findById(attorney._id);
    expect(updated.status).toBe("approved");
    expect(updated.approvedAt).toBeTruthy();
    expect(updated.emailVerified).toBe(true);

    const approvedLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(approvedLogin.status).toBe(200);
    expect(approvedLogin.body.success).toBe(true);
    expect(approvedLogin.body.user.isFirstLogin).toBe(true);
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

  test("Bulk email enforces campaign audience, consent, active-account, and size rules", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Campaigns",
      email: "campaign-admin@example.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const [missingPhoto, uploadedPhoto, optedOutPhoto, disabledParalegal, pendingParalegal, attorney] = await User.create([
      {
        firstName: "Missing",
        lastName: "Photo",
        email: "missing-photo@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        state: "CA",
      },
      {
        firstName: "Uploaded",
        lastName: "Photo",
        email: "uploaded-photo@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        profileImage: "profile-photos/uploaded/profile.jpg",
        state: "CA",
      },
      {
        firstName: "Opted",
        lastName: "Out",
        email: "opted-out@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        profileImage: "profile-photos/opted-out/profile.jpg",
        emailPref: { product: true, marketing: false },
        state: "CA",
      },
      {
        firstName: "Disabled",
        lastName: "Paralegal",
        email: "disabled-paralegal@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        disabled: true,
        state: "CA",
      },
      {
        firstName: "Pending",
        lastName: "Paralegal",
        email: "pending-paralegal@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "pending",
        state: "CA",
      },
      {
        firstName: "First",
        lastName: "Matter",
        email: "first-matter-attorney@example.com",
        password: "Password123!",
        role: "attorney",
        status: "approved",
        state: "CA",
      },
    ]);
    const cookie = authCookieFor(admin);

    const profileReminder = await request(app)
      .post("/api/admin/bulk-email")
      .set("Cookie", cookie)
      .send({
        type: "complete_profile",
        userIds: [missingPhoto, uploadedPhoto, disabledParalegal, pendingParalegal, attorney].map((user) => user._id),
      });

    expect(profileReminder.status).toBe(200);
    expect(profileReminder.body).toEqual(expect.objectContaining({ total: 5, sent: 1, skipped: 4, failed: 0 }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe(missingPhoto.email);
    expect(sendEmail.mock.calls[0][1]).toBe("Add your profile photo on Let’s-ParaConnect");
    expect(sendEmail.mock.calls[0][2]).toContain("Open Profile Settings");

    sendEmail.mockClear();
    const launchNotice = await request(app)
      .post("/api/admin/bulk-email")
      .set("Cookie", cookie)
      .send({
        type: "attorney_launch",
        userIds: [uploadedPhoto, missingPhoto, optedOutPhoto].map((user) => user._id),
      });

    expect(launchNotice.status).toBe(200);
    expect(launchNotice.body).toEqual(expect.objectContaining({ total: 3, sent: 1, skipped: 2, failed: 0 }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe(uploadedPhoto.email);
    expect(sendEmail.mock.calls[0][1]).toBe("Attorney Access Is Now Open");
    expect(sendEmail.mock.calls[0][2]).toContain("your paralegal profile");
    expect(sendEmail.mock.calls[0][2]).toContain("Stripe Connect payout setup");
    expect(sendEmail.mock.calls[0][2]).not.toMatch(/add a payment method|fund a Matter when you are ready to hire/i);
    expect(sendEmail.mock.calls[0][2]).not.toMatch(/launch begins today/i);
    expect(sendEmail.mock.calls[0][2]).not.toMatch(/facebook|instagram/i);

    sendEmail.mockClear();
    const launchSetupNotice = await request(app)
      .post("/api/admin/bulk-email")
      .set("Cookie", cookie)
      .send({
        type: "attorney_launch_setup",
        userIds: [missingPhoto, uploadedPhoto].map((user) => user._id),
      });

    expect(launchSetupNotice.status).toBe(200);
    expect(launchSetupNotice.body).toEqual(expect.objectContaining({ total: 2, sent: 1, skipped: 1, failed: 0 }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe(missingPhoto.email);
    expect(sendEmail.mock.calls[0][2]).toContain("add your paralegal profile photo");
    expect(sendEmail.mock.calls[0][2]).toContain("Stripe Connect payout setup");
    expect(sendEmail.mock.calls[0][2]).not.toMatch(/add a payment method|facebook|instagram/i);

    sendEmail.mockClear();
    const firstMatterReminder = await request(app)
      .post("/api/admin/bulk-email")
      .set("Cookie", cookie)
      .send({
        type: "attorney_first_matter",
        userIds: [attorney._id, missingPhoto._id],
      });

    expect(firstMatterReminder.status).toBe(200);
    expect(firstMatterReminder.body).toEqual(expect.objectContaining({ total: 2, sent: 1, skipped: 1, failed: 0 }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe(attorney.email);
    expect(sendEmail.mock.calls[0][2]).not.toMatch(/facebook|instagram/i);

    const obsoleteDecisionCampaign = await request(app)
      .post("/api/admin/bulk-email")
      .set("Cookie", cookie)
      .send({ type: "acceptance", userIds: [missingPhoto._id] });
    expect(obsoleteDecisionCampaign.status).toBe(400);

    const oversizedCampaign = await request(app)
      .post("/api/admin/bulk-email")
      .set("Cookie", cookie)
      .send({ type: "complete_profile", userIds: Array(201).fill(String(missingPhoto._id)) });
    expect(oversizedCampaign.status).toBe(400);
    expect(oversizedCampaign.body.msg).toMatch(/limited to 200/i);
  });

  test("Admin email change keeps the current login email active until the new email is verified", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner5@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const attorney = await User.create({
      firstName: "Riley",
      lastName: "West",
      email: "riley.west@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });

    const res = await request(app)
      .patch(`/api/admin/users/${attorney._id}/email`)
      .set("Cookie", authCookieFor(admin))
      .send({ email: "riley.new@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe("riley.west@example.com");
    expect(res.body.user.pendingEmail).toBe("riley.new@example.com");

    const updated = await User.findById(attorney._id);
    expect(updated.email).toBe("riley.west@example.com");
    expect(updated.pendingEmail).toBe("riley.new@example.com");
    expect(updated.emailVerified).toBe(true);

    expect(sendEmail).toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][0]).toBe("riley.new@example.com");
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

  test("Admin cannot hard-delete hired funded matters from the posts workflow", async () => {
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
      details: "Funded matter history must remain auditable.",
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

    expect(res.status).toBe(409);
    expect(res.body.msg).toMatch(/never-engaged|retained|audit|payment/i);

    const [retainedCase, retainedJob, retainedApplication] = await Promise.all([
      Case.findById(caseDoc._id).lean(),
      Job.findById(job._id).lean(),
      Application.findOne({ jobId: job._id, paralegalId: paralegal._id }).lean(),
    ]);

    expect(retainedCase).toBeTruthy();
    expect(retainedJob).toBeTruthy();
    expect(retainedApplication).toBeTruthy();
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
        escrowStatus: "funded",
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
        escrowStatus: "funded",
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
    await Payout.create({
      paralegalId: paralegal._id,
      caseId: testCase._id,
      amountPaid: 41000,
      transferId: "tr_reversed_123",
      stripeMode: "test",
      status: "reversed",
    });

    await PaymentOperation.create([
      {
        operationKey: `funding:${liveCase._id}:pi_live_admin`,
        caseId: liveCase._id,
        kind: "funding",
        fingerprint: "live-funding-evidence",
        status: "succeeded",
        amount: 122000,
        stripePaymentIntentId: "pi_live_admin",
        stripeChargeId: "ch_live_admin",
        stripeBalanceTransactionId: "txn_live_admin",
        grossAmount: 122000,
        processingFeeAmount: 3838,
        netAmount: 118162,
        currency: "usd",
        stripeMode: "live",
        livemode: true,
        evidenceVerifiedAt: new Date(),
      },
      {
        operationKey: `funding:${testCase._id}:pi_test_admin`,
        caseId: testCase._id,
        kind: "funding",
        fingerprint: "test-funding-evidence",
        status: "succeeded",
        amount: 61000,
        stripePaymentIntentId: "pi_test_admin",
        stripeChargeId: "ch_test_admin",
        stripeBalanceTransactionId: "txn_test_admin",
        grossAmount: 61000,
        processingFeeAmount: 1799,
        netAmount: 59201,
        currency: "usd",
        stripeMode: "test",
        livemode: false,
        evidenceVerifiedAt: new Date(),
      },
    ]);

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
    expect(analyticsRes.body.escrowMetrics.totalEscrowHeld).toBe(50000);
    expect(analyticsRes.body.revenueMetrics.platformFeesCollected).toBe(60000);
    expect(analyticsRes.body.payoutMetrics).toEqual({ totalRecorded: 82000, count: 1 });
    expect(analyticsRes.body).not.toHaveProperty("taxSummary");
    expect(analyticsRes.body).not.toHaveProperty("expenses");
    expect(analyticsRes.body.pendingPayoutQueue).toHaveLength(1);
    expect(analyticsRes.body.pendingPayoutQueue[0]).toEqual(expect.objectContaining({
      recipient: "Taylor Paralegal",
      matterDeadline: null,
    }));

    const payoutsRes = await request(app)
      .get("/api/admin/payouts")
      .set("Cookie", authCookieFor(admin));

    expect(payoutsRes.status).toBe(200);
    expect(payoutsRes.body.totalAmount).toBe(82000);
    expect(payoutsRes.body.count).toBe(1);

    const fundingEvidenceRes = await request(app)
      .get("/api/admin/funding-evidence")
      .set("Cookie", authCookieFor(admin));
    expect(fundingEvidenceRes.status).toBe(200);
    expect(fundingEvidenceRes.body.items).toHaveLength(2);
    expect(fundingEvidenceRes.body.totalsByMode).toEqual({
      live: { count: 1, grossAmount: 122000, processingFeeAmount: 3838, netAmount: 118162 },
      test: { count: 1, grossAmount: 61000, processingFeeAmount: 1799, netAmount: 59201 },
    });

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
