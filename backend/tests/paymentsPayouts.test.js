const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Payout = require("../models/Payout");

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
};

jest.mock("../utils/stripe", () => mockStripe);

jest.mock("../services/caseLifecycle", () => ({
  generateArchiveZip: jest.fn(async () => ({ key: "cases/mock/archive.zip", readyAt: new Date() })),
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%mock")),
  uploadPdfToS3: jest.fn(async () => ({ key: "cases/mock/receipt.pdf" })),
  getReceiptKey: jest.fn((caseId, kind) => `cases/${caseId}/receipt-${kind}.pdf`),
}));

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
  mockStripe.paymentIntents.retrieve.mockReset();
  mockStripe.transfers.create.mockReset();
  mockStripe.isTransferablePaymentIntent.mockReset();
  mockStripe.sanitizeStripeError.mockClear();
});

describe("Payments + payouts", () => {
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
    });

    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_test_123",
      status: "succeeded",
      currency: "usd",
      charges: { data: [{ id: "ch_test_123", transfer_group: `case_${caseDoc._id}` }] },
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

    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.paymentReleased).toBe(true);
    expect(refreshed.payoutTransferId).toBe("tr_test_123");
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
    });

    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_test_456",
      status: "succeeded",
      currency: "usd",
      charges: { data: [{ id: "ch_test_456", transfer_group: `case_${caseDoc._id}` }] },
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

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transfer failed/i);

    const payoutDoc = await Payout.findOne({ caseId: caseDoc._id }).lean();
    expect(payoutDoc).toBeNull();

    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.payoutTransferId).toBeFalsy();
    expect(refreshed.paymentReleased).not.toBe(true);
  });
});
