const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const PaymentOperation = require("../models/PaymentOperation");
const Notification = require("../models/Notification");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

const mockStripe = {
  paymentIntents: {
    retrieve: jest.fn(),
  },
  transfers: {
    create: jest.fn(),
  },
  isTransferablePaymentIntent: jest.fn(),
  sanitizeStripeError: jest.fn((err, fallback) => err?.message || fallback),
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  customers: { create: jest.fn(), retrieve: jest.fn() },
  caseTransferGroup: jest.fn((caseId) => `case_${caseId}`),
  stripeIdempotencyKey: jest.fn((operation, ...parts) => `test_${operation}_${parts.join("_")}`),
};

jest.mock("../utils/stripe", () => mockStripe);

jest.mock("../services/caseLifecycle", () => ({
  generateArchiveZip: jest.fn(async () => ({ key: "cases/mock/archive.zip", readyAt: new Date() })),
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%mock")),
  uploadPdfToS3: jest.fn(async () => ({ key: "cases/mock/receipt.pdf" })),
  getReceiptKey: jest.fn((caseId, kind) => `cases/${caseId}/receipt-${kind}.pdf`),
}));

const casesRouter = require("../routes/cases");
const disputesRouter = require("../routes/disputes");
const paymentsRouter = require("../routes/payments");
const caseLifecycle = require("../services/caseLifecycle");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use("/api/disputes", disputesRouter);
  instance.use("/api/payments", paymentsRouter);
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
  mockStripe.paymentIntents.retrieve.mockReset();
  mockStripe.transfers.create.mockReset();
  mockStripe.isTransferablePaymentIntent.mockReset();
  mockStripe.sanitizeStripeError.mockClear();
  caseLifecycle.generateArchiveZip.mockReset();
  caseLifecycle.generateArchiveZip.mockResolvedValue({ key: "cases/mock/archive.zip", readyAt: new Date() });
  caseLifecycle.buildReceiptPdfBuffer.mockClear();
});

describe("Payments + payouts", () => {
  describe("audited paralegal receipt evidence", () => {
    async function receiptFixture(overrides = {}) {
      const attorney = await User.create({ firstName: "Receipt", lastName: "Attorney", email: "receipt-attorney@example.com", password: "Password123!", role: "attorney", status: "approved" });
      const paralegal = await User.create({ firstName: "Receipt", lastName: "Paralegal", email: "receipt-paralegal@example.com", password: "Password123!", role: "paralegal", status: "approved" });
      const matter = await Case.create({ title: "Receipt evidence", practiceArea: "immigration", details: "Synthetic receipt evidence", attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: "in progress", totalAmount: 100000, lockedTotalAmount: 100000, ...overrides });
      return { matter, paralegal };
    }

    test.each([null, "pending", "failed", "reversed", "needs_reconciliation"])("does not issue a Paid receipt with payout status %s", async (status) => {
      const { matter, paralegal } = await receiptFixture({ paymentReleased: status !== null });
      if (status) await Payout.create({ caseId: matter._id, paralegalId: paralegal._id, amountPaid: 82000, transferId: `tr_${status}`, status });
      const response = await request(app).get(`/api/payments/receipt/paralegal/${matter._id}`).set("Cookie", authCookieFor(paralegal));
      expect(response.status).toBe(409);
      expect(caseLifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
    });

    test("replacement withdrawal preserves the predecessor settlement and receipt", async () => {
      const predecessor = await User.create({ firstName: "Prior", lastName: "Paralegal", email: "prior@example.com", password: "Password123!", role: "paralegal", status: "approved" });
      const { matter, paralegal } = await receiptFixture({
        withdrawnParalegalId: predecessor._id, payoutFinalizedAt: new Date("2026-08-01"), payoutFinalizedType: "partial_attorney",
        partialPayoutAmount: 40000, remainingAmount: 60000, hiredAt: new Date("2026-07-01"),
        paralegal: null, paralegalId: null, status: "paused", pausedReason: "paralegal_withdrew", fundingIntegrityStatus: "verified",
        escrowStatus: "funded", escrowIntentId: "pi_replacement", tasks: [{ title: "Previous approved work", completed: true }, { title: "Remaining work", completed: false }],
      });
      await Payout.create({ caseId: matter._id, paralegalId: predecessor._id, amountPaid: 32800, transferId: "tr_predecessor", status: "paid", stripeMode: "test" });
      await User.updateOne({ _id: paralegal._id }, { $set: { stripeAccountId: "acct_replacement_paid", stripeOnboarded: true, stripePayoutsEnabled: true } });
      await Case.updateOne({ _id: matter._id }, { $push: { applicants: { paralegalId: paralegal._id, status: "pending" } } });
      const attorney = await User.findById(matter.attorneyId);
      const hire = await request(app).post(`/api/cases/${matter._id}/hire/${paralegal._id}`).set("Cookie", authCookieFor(attorney)).send({});
      expect(hire.status).toBe(200);
      const priorReceiptDuringReplacement = await request(app).get(`/api/payments/receipt/paralegal/${matter._id}`).set("Cookie", authCookieFor(predecessor));
      expect(priorReceiptDuringReplacement.status).toBe(200);
      expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(expect.objectContaining({ totalAmount: "$328.00", partyName: "Prior Paralegal" }));
      const withdrawal = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", authCookieFor(paralegal)).send({});
      expect(withdrawal.status).toBe(200);
      expect(withdrawal.body.withdrawalOutcome).toBe("zero_auto");
      const refreshed = await Case.findById(matter._id).lean();
      expect(String(refreshed.withdrawnParalegalId)).toBe(String(paralegal._id));
      expect(refreshed.remainingAmount).toBe(60000);
      expect(refreshed.withdrawalHistory).toEqual(expect.arrayContaining([expect.objectContaining({ partialPayoutAmount: 40000 })]));
      const receipt = await request(app).get(`/api/payments/receipt/paralegal/${matter._id}`).set("Cookie", authCookieFor(predecessor));
      expect(receipt.status).toBe(200);
      expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(expect.objectContaining({ totalAmount: "$328.00", partyName: "Prior Paralegal" }));
      const history = await request(app).get("/api/cases/my-completed").set("Cookie", authCookieFor(predecessor));
      expect(history.status).toBe(200);
      expect(history.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ caseId: String(matter._id), isWithdrawn: true, receiptAvailable: true })]));
      const listing = await request(app).get(`/api/cases/${matter._id}`).set("Cookie", authCookieFor(predecessor));
      // Relisted scope is discoverable, but a historical receipt owner gains no workspace access.
      expect(listing.status).toBe(200);
      expect(listing.body.files).toEqual([]);
      expect(listing.body.tasks).toEqual([]);
      expect(listing.body.submissionSummary).toBeNull();
      expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    });

    test.each([null, "pending", "failed", "reversed", "needs_reconciliation"])("a positive withdrawal receipt also requires confirmed payout evidence: %s", async status => {
      const { matter, paralegal } = await receiptFixture({ paralegal: null, paralegalId: null, payoutFinalizedAt: new Date(), payoutFinalizedType: "partial_attorney", partialPayoutAmount: 40000, pausedReason: "paralegal_withdrew", status: "paused" });
      await Case.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: paralegal._id } });
      if (status) await Payout.create({ caseId: matter._id, paralegalId: paralegal._id, amountPaid: 32800, transferId: `tr_withdrawal_${status}`, status });
      const response = await request(app).get(`/api/payments/receipt/paralegal/${matter._id}`).set("Cookie", authCookieFor(paralegal));
      expect(response.status).toBe(409);
      expect(caseLifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
    });

    test("withdraw, relist, hire a replacement, and withdraw again preserves each assignment", async () => {
      const replacement = await User.create({ firstName: "New", lastName: "Paralegal", email: "replacement-journey@example.com", password: "Password123!", role: "paralegal", status: "approved", stripeAccountId: "acct_replacement_journey", stripeOnboarded: true, stripePayoutsEnabled: true });
      const { matter, paralegal } = await receiptFixture({ escrowStatus: "funded", escrowIntentId: "pi_journey", fundingIntegrityStatus: "verified", hiredAt: new Date("2026-08-01"), tasks: [{ title: "Unfinished scope", completed: false }] });
      const attorney = await User.findById(matter.attorneyId);
      const first = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", authCookieFor(paralegal)).send({});
      expect(first.status).toBe(200);
      expect(first.body.withdrawalOutcome).toBe("zero_auto");
      // The replacement expresses interest in the relisted scope before hire.
      await Case.updateOne({ _id: matter._id }, { $push: { applicants: { paralegalId: replacement._id, status: "pending" } } });
      const hire = await request(app).post(`/api/cases/${matter._id}/hire/${replacement._id}`).set("Cookie", authCookieFor(attorney)).send({});
      expect(hire.status).toBe(200);
      const second = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", authCookieFor(replacement)).send({});
      expect(second.status).toBe(200);
      expect(second.body.withdrawalOutcome).toBe("zero_auto");
      const repeated = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", authCookieFor(replacement)).send({});
      expect(repeated.status).toBe(200);
      expect(repeated.body.alreadyProcessed).toBe(true);
      const final = await Case.findById(matter._id).lean();
      expect(final.remainingAmount).toBe(100000);
      expect(final.withdrawalHistory).toHaveLength(1);
      expect(String(final.withdrawalHistory[0].withdrawnParalegalId)).toBe(String(paralegal._id));
      expect(String(final.withdrawnParalegalId)).toBe(String(replacement._id));
      expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    });

    test.each([
      ["replacement", { remainingAmount: 60000, payoutFinalizedAt: new Date("2026-08-01"), payoutFinalizedType: "partial_attorney", feeParalegalAmount: 10800 }, 49200, "$600.00", "$108.00", "$492.00"],
      ["partial dispute", { feeParalegalAmount: 7200, disputeSettlement: { transferId: "tr_confirmed", action: "release_partial", grossAmount: 40000, feeParalegalPct: 18, feeParalegalAmount: 7200, payoutAmount: 32800 } }, 32800, "$400.00", "$72.00", "$328.00"],
    ])("uses the actual %s settlement gross, fee and net", async (_kind, fields, net, grossLabel, feeLabel, netLabel) => {
      const { matter, paralegal } = await receiptFixture({ paymentReleased: true, payoutTransferId: "tr_confirmed", ...fields });
      await Payout.create({ caseId: matter._id, paralegalId: paralegal._id, amountPaid: net, transferId: "tr_confirmed", status: "paid", stripeMode: "test" });
      const response = await request(app).get(`/api/payments/receipt/paralegal/${matter._id}`).set("Cookie", authCookieFor(paralegal));
      expect(response.status).toBe(200);
      expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(expect.objectContaining({
        lineItems: [{ label: "Gross amount", value: grossLabel }, { label: "Platform fee (18%)", value: feeLabel }],
        totalAmount: netLabel,
      }));
    });
  });

  test("Stripe test payout is created to connected Amex Business account and amount is correct", async () => {
    // Description: Attorney completes case and payout transfers to connected account.
    // Input values: total=100000 cents, paralegal stripeAccountId="acct_amex_business".
    // Expected result: transfer destination matches account; payout=82000 cents (18% platform fee).

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "attorney+payout@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal+payout@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_amex_business",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await Case.create({
      title: "Escrow payout test",
      practiceArea: "immigration",
      details: "Case details for payout test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_test_123",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });

    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      livemode: false,
      id: "pi_test_123",
      status: "succeeded",
      amount: 122000,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: { caseId: String(caseDoc._id) },
      latest_charge: { id: "ch_test_123", transfer_group: `case_${caseDoc._id}` },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_test_123" },
    });

    let lastTransferPayload = null;
    mockStripe.transfers.create.mockImplementation(async (payload) => {
      lastTransferPayload = payload;
      return { id: "tr_test_123" };
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(lastTransferPayload).toBeTruthy();
    expect(lastTransferPayload.destination).toBe("acct_amex_business");

    const expectedPayout = 82000; // 100000 - 18%
    expect(lastTransferPayload.amount).toBe(expectedPayout);

    const payoutDoc = await Payout.findOne({ caseId: caseDoc._id }).lean();
    expect(payoutDoc).toBeTruthy();
    expect(payoutDoc.amountPaid).toBe(expectedPayout);

    const payoutNotif = await Notification.findOne({
      userId: paralegal._id,
      type: "payout_released",
    }).lean();
    expect(payoutNotif).toBeTruthy();

    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.paymentReleased).toBe(true);
    expect(refreshed.payoutTransferId).toBe("tr_test_123");
    expect(refreshed.feeParalegalPct).toBe(18);
    expect(refreshed.feeParalegalAmount).toBe(18000);

    const operation = await PaymentOperation.findOne({
      operationKey: `case_payout:${caseDoc._id}`,
    }).lean();
    expect(operation).toEqual(expect.objectContaining({
      status: "succeeded",
      amount: expectedPayout,
      stripeObjectId: "tr_test_123",
    }));

    const receiptRes = await request(app)
      .get(`/api/payments/receipt/paralegal/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .buffer(true);

    expect(receiptRes.status).toBe(200);
    expect(receiptRes.headers["content-type"]).toMatch(/application\/pdf/);
    expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineItems: expect.arrayContaining([
          expect.objectContaining({ label: "Gross amount", value: "$1,000.00" }),
          expect.objectContaining({ label: "Platform fee (18%)", value: "$180.00" }),
        ]),
        totalAmount: "$820.00",
      })
    );
  });

  test("Concurrent completion attempts create one transfer and one completion", async () => {
    caseLifecycle.generateArchiveZip.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { key: "cases/mock/archive.zip", readyAt: new Date() };
    });
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Concurrent",
      email: "attorney+concurrent-completion@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Concurrent",
      email: "paralegal+concurrent-completion@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_concurrent_completion",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Concurrent completion",
      details: "Only one completion request may own the payout transition.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_concurrent_completion",
      fundingIntegrityStatus: "verified",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      livemode: false,
      id: "pi_concurrent_completion",
      status: "succeeded",
      amount: 122000,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: { caseId: String(caseDoc._id) },
      latest_charge: { id: "ch_concurrent_completion", transfer_group: `case_${caseDoc._id}` },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_concurrent_completion" },
    });
    mockStripe.transfers.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { id: "tr_concurrent_completion" };
    });

    const [first, second] = await Promise.all([
      request(app).post(`/api/cases/${caseDoc._id}/complete`).set("Cookie", authCookieFor(attorney)).send({}),
      request(app).post(`/api/cases/${caseDoc._id}/complete`).set("Cookie", authCookieFor(attorney)).send({}),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const conflict = [first, second].find((response) => response.status === 409);
    expect(conflict.body).toEqual(
      expect.objectContaining({
        code: "COMPLETION_CONFLICT",
      })
    );
    expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.status).toBe("completed");
    expect(refreshed.payoutTransferId).toBe("tr_concurrent_completion");
    expect(refreshed.completionClaimStatus).toBeNull();
  });

  test("Archive preparation failure releases the claim without releasing funds", async () => {
    const attorney = await User.create({
      firstName: "Archive",
      lastName: "Owner",
      email: "archive.failure.owner@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Archive",
      lastName: "Recipient",
      email: "archive.failure.recipient@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_archive_failure",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Archive failure",
      details: "Funds must remain held when the archive cannot be prepared.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_archive_failure",
      fundingIntegrityStatus: "verified",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });
    const archiveError = Object.assign(new Error("A document is still undergoing security scanning."), {
      code: "FILE_SCAN_PENDING",
      statusCode: 423,
    });
    caseLifecycle.generateArchiveZip.mockRejectedValueOnce(archiveError);

    const response = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(response.status).toBe(423);
    expect(response.body.code).toBe("FILE_SCAN_PENDING");
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.status).toBe("in progress");
    expect(refreshed.paymentReleased).not.toBe(true);
    expect(refreshed.completionClaimStatus).toBeNull();
  });

  test("A dispute cannot open after completion claims the matter and before Stripe returns", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Race",
      email: "attorney+completion-dispute-race@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Race",
      email: "paralegal+completion-dispute-race@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_completion_dispute_race",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Completion dispute race",
      details: "Completion ownership excludes a new review before money moves.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_completion_dispute_race",
      fundingIntegrityStatus: "verified",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      livemode: false,
      id: "pi_completion_dispute_race",
      status: "succeeded",
      amount: 122000,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: { caseId: String(caseDoc._id) },
      latest_charge: { id: "ch_completion_dispute_race", transfer_group: `case_${caseDoc._id}` },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_completion_dispute_race" },
    });
    let transferStarted;
    const transferStartedPromise = new Promise((resolve) => { transferStarted = resolve; });
    let releaseTransfer;
    const releaseTransferPromise = new Promise((resolve) => { releaseTransfer = resolve; });
    mockStripe.transfers.create.mockImplementation(async () => {
      transferStarted();
      await releaseTransferPromise;
      return { id: "tr_completion_dispute_race" };
    });

    const completionPromise = Promise.resolve(
      request(app)
        .post(`/api/cases/${caseDoc._id}/complete`)
        .set("Cookie", authCookieFor(attorney))
        .send({})
    );
    await transferStartedPromise;
    const dispute = await request(app)
      .post(`/api/disputes/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ message: "Late review request" });
    releaseTransfer();
    const completion = await completionPromise;

    expect(completion.status).toBe(200);
    expect(dispute.status).toBe(409);
    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.status).toBe("completed");
    expect(refreshed.disputes.filter((entry) => entry.status === "open")).toHaveLength(0);
  });

  test("Paralegal receipt recomputes 18 percent fee when historical snapshot is zero", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "attorney+receipt@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal+receipt@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Historical payout receipt test",
      practiceArea: "immigration",
      details: "Historical payout record with a bad paralegal fee snapshot.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      paymentReleased: true,
      payoutTransferId: "tr_historical_123",
      paidOutAt: new Date("2026-04-10T12:00:00.000Z"),
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      feeParalegalPct: 18,
      feeParalegalAmount: 0,
      currency: "usd",
    });

    await Payout.create({
      caseId: caseDoc._id,
      paralegalId: paralegal._id,
      amountPaid: 82000,
      transferId: "tr_historical_123",
      stripeMode: "test",
    });

    const receiptRes = await request(app)
      .get(`/api/payments/receipt/paralegal/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .buffer(true);

    expect(receiptRes.status).toBe(200);
    expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineItems: expect.arrayContaining([
          expect.objectContaining({ label: "Gross amount", value: "$1,000.00" }),
          expect.objectContaining({ label: "Platform fee (18%)", value: "$180.00" }),
        ]),
        totalAmount: "$820.00",
      })
    );
  });

  test("Failed payout is handled and returns an error", async () => {
    // Description: Transfer creation fails.
    // Input values: transfer throws error.
    // Expected result: 400 with error message and no payout record created.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "attorney+payout2@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal+payout2@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_amex_business",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await Case.create({
      title: "Escrow payout error test",
      practiceArea: "immigration",
      details: "Case details for payout error test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_test_456",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });

    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      livemode: false,
      id: "pi_test_456",
      status: "succeeded",
      amount: 122000,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: { caseId: String(caseDoc._id) },
      latest_charge: { id: "ch_test_456", transfer_group: `case_${caseDoc._id}` },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_test_456" },
    });

    mockStripe.transfers.create.mockRejectedValue(new Error("Transfer failed"));
    mockStripe.sanitizeStripeError.mockReturnValue("Transfer failed");

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED");
    expect(res.body.error).toMatch(/transfer failed/i);

    const payoutDoc = await Payout.findOne({ caseId: caseDoc._id }).lean();
    expect(payoutDoc).toBeNull();

    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.payoutTransferId).toBeFalsy();
    expect(refreshed.paymentReleased).not.toBe(true);
    expect(refreshed.payoutStatus).toBe("needs_reconciliation");

    const operation = await PaymentOperation.findOne({
      operationKey: `case_payout:${caseDoc._id}`,
    }).lean();
    expect(operation.status).toBe("needs_reconciliation");
    expect(operation.evidenceStatus).toBe("needs_reconciliation");
    expect(operation.lastError).toMatch(/transfer failed/i);
  });

  test("A Case-only payout reference requires reconciliation without creating another transfer", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "attorney+reconcile@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal+reconcile@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const paidAt = new Date("2026-08-10T12:00:00.000Z");
    const caseDoc = await Case.create({
      title: "Completion reconciliation",
      practiceArea: "immigration",
      details: "Payout succeeded before the final lifecycle save.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date("2026-08-01T12:00:00.000Z"),
      escrowStatus: "funded",
      escrowIntentId: "pi_reconcile_123",
      fundingIntegrityStatus: "verified",
      paymentReleased: true,
      payoutTransferId: "tr_reconcile_123",
      payoutStatus: "paid",
      paidOutAt: paidAt,
      completedAt: paidAt,
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED");
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    expect(await Payout.countDocuments({ caseId: caseDoc._id })).toBe(0);
    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.status).toBe("in progress");
    expect(refreshed.payoutTransferId).toBe("tr_reconcile_123");
  });

  test("Incomplete payout evidence requires reconciliation instead of returning false success", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "attorney+broken-reconcile@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal+broken-reconcile@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Broken payout evidence",
      practiceArea: "immigration",
      details: "A transfer reference without a paid timestamp cannot be treated as complete.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date("2026-08-01T12:00:00.000Z"),
      escrowStatus: "funded",
      escrowIntentId: "pi_broken_reconcile",
      fundingIntegrityStatus: "verified",
      payoutTransferId: "tr_broken_reconcile",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED");
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    expect((await Case.findById(caseDoc._id).lean()).status).toBe("in progress");
  });

  test("Completion preserves an uncertain transfer for administrative reconciliation without fabricating ledgers", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Recovery",
      email: "attorney+operation-recovery@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Recovery",
      email: "paralegal+operation-recovery@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_operation_recovery",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Operation recovery",
      practiceArea: "immigration",
      details: "The transfer succeeded before either local ledger finalized.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date("2026-08-01T12:00:00.000Z"),
      escrowStatus: "funded",
      escrowIntentId: "pi_operation_recovery",
      fundingIntegrityStatus: "verified",
      payoutStatus: "needs_reconciliation",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });
    await PaymentOperation.create({
      operationKey: `case_payout:${caseDoc._id}`,
      caseId: caseDoc._id,
      kind: "case_payout",
      fingerprint: "recorded-transfer-fingerprint",
      status: "needs_reconciliation",
      amount: 82000,
      transferAmount: 82000,
      currency: "usd",
      stripeObjectId: "tr_operation_recovery",
      stripeTransferId: "tr_operation_recovery",
      lastError: "simulated ledger failure",
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED");
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.status).toBe("in progress");
    expect(refreshed.paymentReleased).toBe(false);
    expect(await Payout.countDocuments({ caseId: caseDoc._id })).toBe(0);
    expect((await PaymentOperation.findOne({ caseId: caseDoc._id })).status).toBe("needs_reconciliation");
  });
});
