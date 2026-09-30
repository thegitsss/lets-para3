const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { S3Client } = require("@aws-sdk/client-s3");

const mockAdminStripe = {
  disputes: { retrieve: jest.fn() },
  charges: { retrieve: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  balanceTransactions: { retrieve: jest.fn() },
};
jest.mock("../utils/stripe", () => mockAdminStripe);

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const PaymentOperation = require("../models/PaymentOperation");
const FinancialAdjustment = require("../models/FinancialAdjustment");
const AuditLog = require("../models/AuditLog");
const adminRouter = require("../routes/admin");
const authRouter = require("../routes/auth");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const sendEmail = require("../utils/email");
const { addSubscriber: addCaseSubscriber } = require("../utils/caseEvents");
const { addSubscriber: addNotificationSubscriber } = require("../utils/notificationEvents");

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
  await Promise.all([User.init(), Case.init(), PaymentOperation.init(), Payout.init(), PlatformIncome.init(), FinancialAdjustment.init(), AuditLog.init()]);
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  Object.values(mockAdminStripe).forEach((group) => group.retrieve.mockReset());
  sendEmail.mockClear();
  if (sendEmail.sendWelcomePacket?.mockClear) sendEmail.sendWelcomePacket.mockClear();
  if (sendEmail.sendProfilePhotoRejectedEmail?.mockClear) sendEmail.sendProfilePhotoRejectedEmail.mockClear();
});

describe("Admin workflows", () => {
  test("chargeback projection is admin-only and acknowledgment is audited and idempotent", async () => {
    const [admin, attorney, paralegal] = await User.create([
      { firstName: "Admin", lastName: "Chargebacks", email: "chargeback-admin@example.com", password: "Password123!", role: "admin", status: "approved", state: "CA" },
      { firstName: "Attorney", lastName: "Chargebacks", email: "chargeback-attorney-admin-test@example.com", password: "Password123!", role: "attorney", status: "approved", state: "CA" },
      { firstName: "Paralegal", lastName: "Chargebacks", email: "chargeback-paralegal-admin-test@example.com", password: "Password123!", role: "paralegal", status: "approved", state: "CA" },
    ]);
    const caseDoc = await Case.create({
      title: "Admin chargeback projection",
      details: "Separate Stripe chargeback administrative projection test.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      escrowIntentId: "pi_admin_chargeback",
      paymentIntentId: "pi_admin_chargeback",
      lockedTotalAmount: 40000,
      totalAmount: 40000,
      currency: "usd",
    });
    const operation = await PaymentOperation.create({
      operationKey: "chargeback:dp_admin_projection",
      caseId: caseDoc._id,
      kind: "chargeback",
      fingerprint: "chargeback-admin-projection",
      status: "needs_reconciliation",
      amount: 48800,
      currency: "usd",
      stripeObjectId: "dp_admin_projection",
      stripeDisputeId: "dp_admin_projection",
      processorStatus: "under_review",
      processorEventCreatedAt: new Date("2026-08-30T12:00:00.000Z"),
      administrativeStatus: "pending_review",
      payoutPosition: "pre_payout",
      evidenceStatus: "verified",
      stripeMode: "test",
    });
    await FinancialAdjustment.create({
      idempotencyKey: "chargeback-adjustment:dp_admin_projection:txn_admin:principal:debit",
      paymentOperationId: operation._id,
      caseId: caseDoc._id,
      adjustmentType: "chargeback_principal",
      direction: "debit",
      amount: 48800,
      currency: "usd",
      stripeDisputeId: "dp_admin_projection",
      stripeChargeId: "ch_admin_projection",
      stripeBalanceTransactionId: "txn_admin",
      stripeEventId: "evt_admin_projection",
      stripeMode: "test",
    });

    const denied = await request(app)
      .get("/api/admin/chargebacks")
      .set("Cookie", authCookieFor(attorney));
    expect(denied.status).toBe(403);
    const deniedAction = await request(app)
      .post(`/api/admin/chargebacks/${operation._id}/acknowledge`)
      .set("Cookie", authCookieFor(attorney))
      .send({});
    expect(deniedAction.status).toBe(403);

    const projection = await request(app)
      .get("/api/admin/chargebacks")
      .set("Cookie", authCookieFor(admin));
    expect(projection.status).toBe(200);
    expect(projection.body.items[0]).toEqual(expect.objectContaining({
      chargebackAmount: 48800,
      processorFees: 0,
      payoutPosition: "pre_payout",
      payoutHold: true,
      stripeMode: "test",
      processorStatus: "under_review",
      administrativeStatus: "pending_review",
      netExposure: 48800,
      evidenceStatus: "verified",
    }));
    expect(JSON.stringify(projection.body)).not.toMatch(/payment_method|customer|card/i);

    const first = await request(app)
      .post(`/api/admin/chargebacks/${operation._id}/acknowledge`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    const replay = await request(app)
      .post(`/api/admin/chargebacks/${operation._id}/acknowledge`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    expect(first.body).toEqual(expect.objectContaining({ ok: true, changed: true, administrativeStatus: "acknowledged" }));
    expect(replay.body).toEqual(expect.objectContaining({ ok: true, changed: false, administrativeStatus: "acknowledged" }));
    expect(await AuditLog.countDocuments({ action: "chargeback.admin.acknowledge" })).toBe(1);
    expect(await FinancialAdjustment.findOne({ paymentOperationId: operation._id }).lean())
      .toEqual(expect.objectContaining({ amount: 48800, direction: "debit" }));
  });

  test("only an eligible processor win can be explicitly cleared by an admin", async () => {
    const [admin, attorney, paralegal] = await User.create([
      { firstName: "Admin", lastName: "Hold", email: "chargeback-hold-admin@example.com", password: "Password123!", role: "admin", status: "approved", state: "CA" },
      { firstName: "Attorney", lastName: "Hold", email: "chargeback-hold-attorney@example.com", password: "Password123!", role: "attorney", status: "approved", state: "CA" },
      { firstName: "Paralegal", lastName: "Hold", email: "chargeback-hold-paralegal@example.com", password: "Password123!", role: "paralegal", status: "approved", state: "CA" },
    ]);
    const caseDoc = await Case.create({
      title: "Eligible chargeback hold",
      details: "Explicit administrative hold-clear test.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      escrowIntentId: "pi_admin_hold",
      lockedTotalAmount: 40000,
      totalAmount: 40000,
      currency: "usd",
    });
    const operation = await PaymentOperation.create({
      operationKey: "chargeback:dp_admin_hold",
      caseId: caseDoc._id,
      kind: "chargeback",
      fingerprint: "chargeback-admin-hold",
      status: "needs_reconciliation",
      amount: 48800,
      currency: "usd",
      stripeDisputeId: "dp_admin_hold",
      processorStatus: "won",
      administrativeStatus: "pending_review",
      payoutPosition: "pre_payout",
      evidenceStatus: "verified",
    });
    const response = await request(app)
      .post(`/api/admin/chargebacks/${operation._id}/clear-hold`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ ok: true, changed: true, administrativeStatus: "hold_cleared" }));
    expect(await AuditLog.countDocuments({ action: "chargeback.admin.hold_clear" })).toBe(1);
  });

  test("admin reconciliation fills missing immutable evidence without clearing a hold", async () => {
    const [admin, attorney, paralegal] = await User.create([
      { firstName: "Admin", lastName: "Reconcile", email: "chargeback-reconcile-admin@example.com", password: "Password123!", role: "admin", status: "approved", state: "CA" },
      { firstName: "Attorney", lastName: "Reconcile", email: "chargeback-reconcile-attorney@example.com", password: "Password123!", role: "attorney", status: "approved", state: "CA" },
      { firstName: "Paralegal", lastName: "Reconcile", email: "chargeback-reconcile-paralegal@example.com", password: "Password123!", role: "paralegal", status: "approved", state: "CA" },
    ]);
    const caseDoc = await Case.create({
      title: "Chargeback reconciliation",
      details: "Admin fills missing processor evidence without releasing payout.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      escrowIntentId: "pi_admin_reconcile",
      paymentIntentId: "pi_admin_reconcile",
      lockedTotalAmount: 40000,
      totalAmount: 40000,
      currency: "usd",
    });
    const operation = await PaymentOperation.create({
      operationKey: "chargeback:dp_admin_reconcile",
      caseId: caseDoc._id,
      kind: "chargeback",
      fingerprint: "chargeback-admin-reconcile",
      status: "needs_reconciliation",
      amount: 48800,
      currency: "usd",
      stripeObjectId: "dp_admin_reconcile",
      stripeDisputeId: "dp_admin_reconcile",
      stripeEventId: "evt_admin_reconcile",
      stripeChargeId: "ch_admin_reconcile",
      stripePaymentIntentId: "pi_admin_reconcile",
      processorStatus: "under_review",
      processorEventCreatedAt: new Date("2026-08-30T12:00:00.000Z"),
      administrativeStatus: "pending_review",
      payoutPosition: "pre_payout",
      evidenceStatus: "needs_reconciliation",
      stripeMode: "test",
    });
    const charge = { id: "ch_admin_reconcile", object: "charge", amount: 48800, amount_captured: 48800, amount_refunded: 0, currency: "usd", status: "succeeded", paid: true, captured: true, livemode: false, payment_intent: "pi_admin_reconcile", metadata: { caseId: String(caseDoc._id) } };
    const intent = { id: "pi_admin_reconcile", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, latest_charge: charge.id, transfer_group: `case_${caseDoc._id}`, metadata: { caseId: String(caseDoc._id) } };
    mockAdminStripe.charges.retrieve.mockResolvedValue(charge);
    mockAdminStripe.paymentIntents.retrieve.mockResolvedValue(intent);
    mockAdminStripe.disputes.retrieve.mockResolvedValue({
      id: "dp_admin_reconcile", object: "dispute", amount: 48800, currency: "usd", status: "under_review", livemode: false, charge: charge.id, payment_intent: intent.id,
      balance_transactions: [{ id: "txn_admin_reconcile", object: "balance_transaction", source: "dp_admin_reconcile", amount: -48800, fee: 1500, net: -50300, currency: "usd" }],
    });

    const response = await request(app)
      .post(`/api/admin/chargebacks/${operation._id}/reconcile`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, evidenceStatus: "verified" });
    expect(await FinancialAdjustment.countDocuments({ paymentOperationId: operation._id })).toBe(2);
    const updated = await PaymentOperation.findById(operation._id).lean();
    expect(updated.administrativeStatus).toBe("pending_review");
    expect(updated.evidenceStatus).toBe("verified");
    expect(await AuditLog.countDocuments({ action: "chargeback.admin.reconcile" })).toBe(1);
  });

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
    expect(approvalEmailHtml).toContain("Welcome to Let’s-ParaConnect!");
    expect(approvalEmailHtml).toContain("create a Matter outlining the scope");
    expect(approvalEmailHtml).toContain(">Get started</a>");
    expect(sendEmail.mock.calls[0][3].text).toContain("/login.html");
    expect(approvalEmailHtml).not.toMatch(/linkedin|facebook|instagram/i);

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
    expect(sendEmail.mock.calls[0][1]).toBe("Explore Matters on LPC");
    expect(sendEmail.mock.calls[0][2]).toContain("You choose which Matters to apply to");
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
    expect(sendEmail.mock.calls[0][2]).toContain("Have work you’re ready to delegate?");
    expect(sendEmail.mock.calls[0][2]).not.toMatch(/account is ready|if you have not posted|application is approved/i);
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

  test("Admin deletion of a never-engaged posting invalidates applicant and deep-link projections immediately", async () => {
    const [admin, attorney, paralegal] = await User.create([
      { firstName: "Admin", lastName: "Delete", email: "admin-delete-open@example.com", password: "Password123!", role: "admin", status: "approved", state: "CA" },
      { firstName: "Avery", lastName: "Delete", email: "attorney-delete-open@example.com", password: "Password123!", role: "attorney", status: "approved", state: "CA" },
      { firstName: "Jamie", lastName: "Applicant", email: "applicant-delete-open@example.com", password: "Password123!", role: "paralegal", status: "approved", state: "CA" },
    ]);
    const caseDoc = await Case.create({
      title: "Admin removable posting",
      practiceArea: "probate",
      details: "This posting has not been hired or funded and can be removed safely.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      applicants: [{ paralegalId: paralegal._id, status: "pending", appliedAt: new Date() }],
      status: "open",
      totalAmount: 50000,
      currency: "usd",
    });
    const job = await Job.create({
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      title: caseDoc.title,
      practiceArea: "probate",
      description: "This posting has not been hired or funded and can be removed safely.",
      budget: 500,
      status: "open",
    });
    caseDoc.jobId = job._id;
    caseDoc.job = job._id;
    await caseDoc.save();
    await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "I am available to assist with this probate Matter.",
      status: "submitted",
    });

    const caseSignals = [];
    const paralegalSignals = [];
    const stopCase = addCaseSubscriber(caseDoc._id, { write: (value) => caseSignals.push(String(value)) });
    const stopParalegal = addNotificationSubscriber(paralegal._id, { write: (value) => paralegalSignals.push(String(value)) });
    const response = await request(app)
      .delete(`/api/admin/cases/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ reason: "Duplicate test posting", message: "This listing has been removed." });
    stopCase();
    stopParalegal();

    expect(response.status).toBe(200);
    expect(caseSignals.join("\n")).toContain("matter_deleted_refresh");
    expect(paralegalSignals.join("\n")).toContain("matter_deleted_refresh");
    expect(await Case.findById(caseDoc._id)).toBeNull();
    expect(await Job.findById(job._id)).toBeNull();
    expect(await Application.findOne({ jobId: job._id })).toBeNull();
  });

  test("Admin analytics keeps incomplete legacy evidence out of confirmed totals", async () => {
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
    expect(analyticsRes.body.escrowMetrics.totalEscrowReleased).toBe(0);
    expect(analyticsRes.body.escrowMetrics.totalEscrowHeld).toBeNull();
    expect(analyticsRes.body.revenueMetrics.platformFeesCollected).toBeNull();
    expect(analyticsRes.body.payoutMetrics).toMatchObject({ totalRecorded: 0, count: 0, states: { needs_review: 1, reversed: 1 } });
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
    expect(payoutsRes.body.totalAmount).toBe(0);
    expect(payoutsRes.body.count).toBe(0);

    const fundingEvidenceRes = await request(app)
      .get("/api/admin/funding-evidence")
      .set("Cookie", authCookieFor(admin));
    expect(fundingEvidenceRes.status).toBe(200);
    expect(fundingEvidenceRes.body.items).toHaveLength(2);
    expect(fundingEvidenceRes.body.totalsByMode).toEqual({
      live: { count: 0, grossAmount: 0, processingFeeAmount: 0, netAmount: 0 },
      test: { count: 0, grossAmount: 0, processingFeeAmount: 0, netAmount: 0 },
    });

    const incomeRes = await request(app)
      .get("/api/admin/income")
      .set("Cookie", authCookieFor(admin));

    expect(incomeRes.status).toBe(200);
    expect(incomeRes.body.totalAmount).toBeNull();
    expect(incomeRes.body.count).toBe(0);
    expect(incomeRes.body.items).toHaveLength(2);
    expect(incomeRes.body.items.every(row => row.amount === null && row.state === "needs_review")).toBe(true);
    expect(fundingEvidenceRes.body.summary.requiresReview).toBe(2);
  });

  test("Admin reporting start filters old flows but cannot erase an unverified current balance", async () => {
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
      expect(analyticsRes.body.escrowMetrics.totalEscrowHeld).toBeNull();
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
