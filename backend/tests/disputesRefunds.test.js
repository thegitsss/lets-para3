const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "http://localhost:5050/stripe/connect/return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "http://localhost:5050/stripe/connect/refresh";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";

const mockStripe = {
  refunds: { create: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  transfers: { create: jest.fn() },
  isTransferablePaymentIntent: jest.fn(),
  sanitizeStripeError: jest.fn((_err, message) => message),
};

jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => null) }));

const User = require("../models/User");
const Case = require("../models/Case");
const disputesRouter = require("../routes/disputes");
const paymentsRouter = require("../routes/payments");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/disputes", disputesRouter);
  instance.use("/api/payments", paymentsRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
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
  mockStripe.refunds.create.mockReset();
  mockStripe.paymentIntents.retrieve.mockReset();
  mockStripe.transfers.create.mockReset();
  mockStripe.isTransferablePaymentIntent.mockReset();
});

describe("Disputes + refunds", () => {
  test("Open dispute creates dispute and marks case disputed", async () => {
    // Description: Attorney opens a dispute on an active case.
    // Input values: message="Escrow terms dispute".
    // Expected result: 201 Created, disputeId returned, case status becomes disputed.

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
      details: "Case details for dispute test.",
      status: "active",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_test_123",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .post(`/api/disputes/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Escrow terms dispute" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.disputeId).toBeTruthy();

    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.status).toBe("disputed");
    expect(updated.disputes?.length).toBe(1);
  });

  test("Admin adds notes after refund settlement", async () => {
    // Description: Admin resolves a dispute with refund and adds admin notes.
    // Input values: action="refund", notes="Refund approved".
    // Expected result: settlement stored, admin notes saved.

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
      firstName: "Jordan",
      lastName: "Lee",
      email: "jordan.lee@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Morgan",
      lastName: "Chen",
      email: "morgan.chen@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Contract review",
      details: "Case details for refund dispute test.",
      status: "disputed",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_refund_123",
      escrowStatus: "funded",
      totalAmount: 80000,
      currency: "usd",
      disputes: [{ message: "Dispute", raisedBy: attorney._id, status: "open" }],
    });

    const disputeId = caseDoc.disputes[0].disputeId || String(caseDoc.disputes[0]._id);

    mockStripe.refunds.create.mockResolvedValue({ id: "re_123", amount: 80000 });

    const settleRes = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "refund", disputeId });
    expect(settleRes.status).toBe(200);
    expect(settleRes.body.ok).toBe(true);

    const notesRes = await request(app)
      .patch(`/api/disputes/${caseDoc._id}/${disputeId}/admin-notes`)
      .set("Cookie", authCookieFor(admin))
      .send({ notes: "Refund approved" });
    expect(notesRes.status).toBe(200);
    expect(notesRes.body.ok).toBe(true);
    expect(notesRes.body.notes).toBe("Refund approved");
  });

  test("Partial release settles dispute with payout-target input and partial refund", async () => {
    // Description: Admin resolves dispute with partial release.
    // Input values: action="release_partial", payoutAmountCents=41000.
    // Expected result: payout transfer recorded, settlement saved, case closed.

    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner3@lets-paraconnect.com",
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
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng.release@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_123",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await Case.create({
      title: "Immigration filings",
      details: "Case details for partial release dispute test.",
      status: "disputed",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_partial_123",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
      disputes: [{ message: "Partial dispute", raisedBy: attorney._id, status: "open" }],
    });

    const disputeId = caseDoc.disputes[0].disputeId || String(caseDoc.disputes[0]._id);

    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_partial_123",
      status: "succeeded",
      charges: { data: [{ id: "ch_partial_123" }] },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_partial_123" },
    });
    mockStripe.refunds.create.mockResolvedValue({ id: "re_partial", amount: 10000 });
    mockStripe.transfers.create.mockResolvedValue({ id: "tr_123" });

    const res = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "release_partial", disputeId, payoutAmountCents: 41000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.transferId).toBeTruthy();
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_transaction: "ch_partial_123",
      })
    );

    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.disputeSettlement?.action).toBe("release_partial");
    expect(updated.status).toBe("closed");
    expect(updated.paymentReleased).toBe(true);
  });

  test("Partial release retries only the remaining refund delta after a previous refund succeeded", async () => {
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
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone4@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng.retry@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_retry_123",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await Case.create({
      title: "Retry partial release",
      details: "Case details for retrying a partial dispute release.",
      status: "disputed",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_partial_retry_123",
      escrowStatus: "funded",
      totalAmount: 100,
      lockedTotalAmount: 100,
      currency: "usd",
      disputes: [{ message: "Retry dispute", raisedBy: attorney._id, status: "open" }],
    });

    const disputeId = caseDoc.disputes[0].disputeId || String(caseDoc.disputes[0]._id);

    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_partial_retry_123",
      status: "succeeded",
      amount: 122,
      amount_received: 122,
      charges: { data: [{ id: "ch_retry_123", amount: 122, amount_refunded: 61 }] },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_retry_123", amount: 122, amount_refunded: 61 },
    });
    mockStripe.refunds.create.mockResolvedValue({ id: "re_retry_123", amount: 30 });
    mockStripe.transfers.create.mockResolvedValue({ id: "tr_retry_123" });

    const res = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "release_partial", disputeId, payoutAmountCents: 25 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockStripe.refunds.create).toHaveBeenCalledWith({
      payment_intent: "pi_partial_retry_123",
      amount: 24,
    });
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_transaction: "ch_retry_123",
        amount: 25,
      })
    );
  });
});
