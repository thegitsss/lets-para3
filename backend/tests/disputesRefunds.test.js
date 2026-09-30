const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");

process.env.STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "http://localhost:5050/stripe/connect/return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "http://localhost:5050/stripe/connect/refresh";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";

const mockStripe = {
  refunds: { create: jest.fn(), retrieve: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  transfers: { create: jest.fn() },
  isTransferablePaymentIntent: jest.fn(),
  sanitizeStripeError: jest.fn((_err, message) => message),
  stripeIdempotencyKey: jest.fn((operation, ...parts) => `test_${operation}_${parts.join("_")}`),
};

jest.mock("../utils/stripe", () => mockStripe);

jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));

const User = require("../models/User");
const Case = require("../models/Case");
const PaymentOperation = require("../models/PaymentOperation");
const Payout = require("../models/Payout");
const disputesRouter = require("../routes/disputes");
const paymentsRouter = require("../routes/payments");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { addSubscriber: addCaseSubscriber } = require("../utils/caseEvents");
const { addSubscriber: addNotificationSubscriber } = require("../utils/notificationEvents");
const { addSubscriber: addDiscoverySubscriber } = require("../utils/matterDiscoveryEvents");

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

function refundFixture(caseDoc, { chargeId, refundId, refunded = 0, amount } = {}) {
  const intentId = caseDoc.escrowIntentId, gross = require("../utils/paymentIntegrity").expectedCaseFunding(caseDoc).totalAmount;
  const charge = { id: chargeId, object: "charge", payment_intent: intentId, amount: gross, amount_captured: gross, amount_refunded: refunded, paid: true, captured: true, status: "succeeded", currency: "usd", livemode: false };
  const intent = { id: intentId, object: "payment_intent", status: "succeeded", amount: gross, amount_received: gross, currency: "usd", livemode: false, transfer_group: `case_${caseDoc._id}`, metadata: { caseId: String(caseDoc._id) }, latest_charge: charge };
  const refund = { id: refundId, object: "refund", status: "succeeded", amount, payment_intent: intentId, charge: chargeId, currency: "usd" };
  mockStripe.paymentIntents.retrieve.mockResolvedValue(intent);
  mockStripe.isTransferablePaymentIntent.mockReturnValue({ transferable: true, charge });
  mockStripe.refunds.create.mockResolvedValue(refund);
  mockStripe.refunds.retrieve.mockResolvedValue(refund);
}

beforeAll(async () => {
  await connect();
  await Promise.all([User.init(), Case.init(), PaymentOperation.init(), Payout.init(), require("../models/AuditLog").init(), require("../models/PlatformIncome").init(), require("../models/WebhookEvent").init()]);
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  mockStripe.refunds.create.mockReset();
  mockStripe.refunds.retrieve.mockReset();
  mockStripe.paymentIntents.retrieve.mockReset();
  mockStripe.transfers.create.mockReset();
  mockStripe.isTransferablePaymentIntent.mockReset();
});

describe("Disputes + refunds", () => {
  test("Open dispute creates dispute and marks case disputed", async () => {
    // Description: Attorney opens a dispute on an active case.
    // Input values: message="Escrow terms dispute".
    // Expected result: 201 Created, disputeId returned, case status becomes disputed.

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
      hiredAt: new Date("2026-08-01T12:00:00.000Z"),
      fundingIntegrityStatus: "verified",
      totalAmount: 100000,
      currency: "usd",
    });

    const caseEvents = [];
    const paralegalEvents = [];
    const discoveryEvents = [];
    const unsubscribers = [
      addCaseSubscriber(caseDoc._id, { write: (value) => caseEvents.push(String(value)) }),
      addNotificationSubscriber(paralegal._id, { write: (value) => paralegalEvents.push(String(value)) }),
      addDiscoverySubscriber({ write: (value) => discoveryEvents.push(String(value)) }),
    ];

    const res = await request(app)
      .post(`/api/disputes/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Escrow terms dispute" });
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.disputeId).toBeTruthy();

    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.status).toBe("disputed");
    expect(updated.pausedReason).toBe("dispute");
    expect(updated.adminDisputeDeadlineAt).toBeTruthy();
    expect(updated.disputes?.length).toBe(1);
    expect(caseEvents.join("\n")).toContain("matter_dispute_refresh");
    expect(paralegalEvents.join("\n")).toContain("matter_dispute_refresh");
    expect(discoveryEvents.join("\n")).toContain("matter_dispute_refresh");
  });

  test("Dispute comments refresh every participant workspace after the comment is stored", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Comment",
      email: "dispute-comment-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Comment",
      email: "dispute-comment-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const disputeId = new mongoose.Types.ObjectId().toString();
    const caseDoc = await Case.create({
      title: "Comment refresh",
      details: "A saved review comment must invalidate both open workspaces.",
      status: "disputed",
      pausedReason: "dispute",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_comment_refresh",
      escrowStatus: "funded",
      fundingIntegrityStatus: "verified",
      totalAmount: 100000,
      currency: "usd",
      disputes: [{
        disputeId,
        message: "Review needed",
        raisedBy: attorney._id,
        status: "open",
        comments: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    });
    const attorneyEvents = [];
    const paralegalEvents = [];
    const unsubscribeAttorney = addNotificationSubscriber(attorney._id, { write: (value) => attorneyEvents.push(String(value)) });
    const unsubscribeParalegal = addNotificationSubscriber(paralegal._id, { write: (value) => paralegalEvents.push(String(value)) });

    const response = await request(app)
      .post(`/api/disputes/${caseDoc._id}/${disputeId}/comment`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "The requested supporting detail is attached." });
    unsubscribeAttorney();
    unsubscribeParalegal();

    expect(response.status).toBe(201);
    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.disputes[0].comments).toEqual([
      expect.objectContaining({ text: "The requested supporting detail is attached." }),
    ]);
    expect(attorneyEvents.join("\n")).toContain("matter_dispute_comment_refresh");
    expect(paralegalEvents.join("\n")).toContain("matter_dispute_comment_refresh");
  });

  test("Concurrent dispute requests create exactly one open dispute", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "concurrent-dispute-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "concurrent-dispute-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Concurrent dispute",
      details: "Only one review may be opened.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_concurrent_dispute",
      escrowStatus: "funded",
      hiredAt: new Date(),
      fundingIntegrityStatus: "verified",
      totalAmount: 100000,
      currency: "usd",
    });

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/disputes/${caseDoc._id}`)
        .set("Cookie", authCookieFor(attorney))
        .send({ message: "Attorney review request" }),
      request(app)
        .post(`/api/disputes/${caseDoc._id}`)
        .set("Cookie", authCookieFor(paralegal))
        .send({ message: "Paralegal review request" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.status).toBe("disputed");
    expect(updated.disputes.filter((entry) => entry.status === "open")).toHaveLength(1);
  });

  test("Dispute creation keeps cent inputs exact and rejects duplicates, unfunded matters, and excess claims", async () => {
    const attorney = await User.create({
      firstName: "Casey",
      lastName: "Jordan",
      email: "casey.jordan@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Robin",
      lastName: "Smith",
      email: "robin.smith@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const funded = await Case.create({
      title: "Exact cents dispute",
      details: "Dispute amount contracts must remain exact.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      hiredAt: new Date("2026-08-01T12:00:00.000Z"),
      escrowIntentId: "pi_exact_cents",
      escrowStatus: "funded",
      fundingIntegrityStatus: "verified",
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      currency: "usd",
    });

    const excess = await request(app)
      .post(`/api/disputes/${funded._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Excess", amountCents: 100001 });
    expect(excess.status).toBe(400);

    const created = await request(app)
      .post(`/api/disputes/${funded._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Exact claim", amountCents: 12345 });
    expect(created.status).toBe(201);
    const stored = await Case.findById(funded._id).lean();
    expect(stored.disputes[0].amountRequestedCents).toBe(12345);

    const duplicate = await request(app)
      .post(`/api/disputes/${funded._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Second claim" });
    expect(duplicate.status).toBe(409);

    const unfunded = await Case.create({
      title: "Unfunded matter",
      details: "An open posting cannot enter financial dispute review.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 50000,
      currency: "usd",
    });
    const unfundedResponse = await request(app)
      .post(`/api/disputes/${unfunded._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Not funded" });
    expect(unfundedResponse.status).toBe(409);
  });

  test("Non-financial dispute resolution bypasses are retired", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "retired-disputes@example.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const caseId = new mongoose.Types.ObjectId();
    const disputeId = new mongoose.Types.ObjectId().toString();
    const patchResponse = await request(app)
      .patch(`/api/disputes/${caseId}/${disputeId}`)
      .set("Cookie", authCookieFor(admin))
      .send({ status: "resolved" });
    const resolveResponse = await request(app)
      .post(`/api/disputes/resolve/${disputeId}`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    expect(patchResponse.status).toBe(404);
    expect(resolveResponse.status).toBe(404);
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

    refundFixture(caseDoc, { chargeId: "ch_refund_123", refundId: "re_123", amount: 97600 });

    const settleRes = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "refund", disputeId });
    expect({ status: settleRes.status, body: settleRes.body }).toMatchObject({ status: 200 });
    expect(settleRes.body.ok).toBe(true);

    const notesRes = await request(app)
      .patch(`/api/disputes/${caseDoc._id}/${disputeId}/admin-notes`)
      .set("Cookie", authCookieFor(admin))
      .send({ notes: "Refund approved" });
    expect(notesRes.status).toBe(200);
    expect(notesRes.body.ok).toBe(true);
    expect(notesRes.body.notes).toBe("Refund approved");
  });

  test.each(["recorded", "reversal_before_ledger", "audit_failure"])("Partial release settles dispute with payout-target input and partial refund: %s", async outcome => {
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

    refundFixture(caseDoc, { chargeId: "ch_partial_123", refundId: "re_partial", amount: 61000 });
    mockStripe.transfers.create.mockResolvedValue({ id: "tr_123" });

    let auditFailure;
    if (outcome === "reversal_before_ledger") {
      const update = PaymentOperation.findByIdAndUpdate.bind(PaymentOperation); let reversed = false;
      jest.spyOn(PaymentOperation, "findByIdAndUpdate").mockImplementation(async (...args) => {
        const result = await update(...args);
        if (!reversed && args[1]?.$set?.stripeTransferId === "tr_123") {
          reversed = true;
          const Delivery = require("../models/WebhookEvent"); await Delivery.init();
          const payload = mockStripe.transfers.create.mock.calls[0][0];
          const event = { id: "evt_settlement_reversal", type: "transfer.reversed", created: 1788955200, livemode: false, data: { object: { ...payload, id: "tr_123", object: "transfer", livemode: false, reversed: true, amount_reversed: payload.amount } } };
          const receipt = await Delivery.create({ eventId: event.id, type: event.type, status: "processing", attempts: 1, lastAttemptAt: new Date(), stripeMode: "test" });
          await require("../services/attorneyTransferEvents").record({ event, receiptFilter: { _id: receipt._id, eventId: event.id, status: "processing", attempts: 1, lastAttemptAt: receipt.lastAttemptAt } });
        }
        return result;
      });
    } else if (outcome === "audit_failure") {
      const Audit = require("../models/AuditLog"), create = Audit.create.bind(Audit);
      auditFailure = jest.spyOn(Audit, "create").mockImplementation((...args) => args[0]?.[0]?.action === "dispute.settlement.release" ? Promise.reject(new Error("Synthetic settlement audit unavailable")) : create(...args));
    }

    const res = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "release_partial", disputeId, payoutAmountCents: 41000 });
    if (outcome !== "recorded") {
      expect({ status: res.status, body: res.body }).toMatchObject({ status: 503 });
      expect((await Case.findById(caseDoc._id)).status).not.toBe("closed");
      expect(await Payout.countDocuments({ caseId: caseDoc._id })).toBe(0);
      expect(await require("../models/PlatformIncome").countDocuments({ caseId: caseDoc._id })).toBe(0);
      const operation = await PaymentOperation.findOne({ caseId: caseDoc._id, kind: "dispute_settlement" });
      expect(operation.stripeTransferId).toBe("tr_123"); expect(operation.status).toBe("needs_reconciliation");
      auditFailure?.mockRestore();
      const retry = await request(app).post(`/api/payments/dispute/settle/${caseDoc._id}`).set("Cookie", authCookieFor(admin)).send({ action: "release_partial", disputeId, payoutAmountCents: 41000 });
      expect(retry.status).toBe(outcome === "audit_failure" ? 200 : 409);
      expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1); expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
      return;
    }
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.transferId).toBeTruthy();
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_transaction: "ch_partial_123",
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("dispute_payout") })
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

    refundFixture(caseDoc, { chargeId: "ch_retry_123", refundId: "re_retry_123", refunded: 61, amount: 24 });
    mockStripe.transfers.create.mockResolvedValue({ id: "tr_retry_123" });

    const res = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "release_partial", disputeId, payoutAmountCents: 25 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_partial_retry_123", amount: 24 }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("dispute_partial_refund") })
    );
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_transaction: "ch_retry_123",
        amount: 25,
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("dispute_payout") })
    );
  });

  test("Refund retry reuses recorded Stripe evidence after the case save fails", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Recovery",
      email: "refund.recovery.admin@example.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const attorney = await User.create({
      firstName: "Avery",
      lastName: "Counsel",
      email: "refund.recovery.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Taylor",
      lastName: "Para",
      email: "refund.recovery.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Refund recovery",
      details: "Refund evidence must survive a local persistence failure.",
      status: "disputed",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_refund_recovery",
      escrowStatus: "funded",
      lockedTotalAmount: 80000,
      totalAmount: 80000,
      disputes: [{ message: "Refund this", raisedBy: attorney._id, status: "open" }],
    });
    const disputeId = caseDoc.disputes[0].disputeId || String(caseDoc.disputes[0]._id);
    refundFixture(caseDoc, { chargeId: "ch_refund_recovery", refundId: "re_recovery", amount: 97600 });
    const saveSpy = jest
      .spyOn(Case.prototype, "save")
      .mockRejectedValueOnce(new Error("simulated case persistence failure"));

    const first = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "refund", disputeId });
    saveSpy.mockRestore();

    expect(first.status).toBe(503);
    expect(first.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED");
    let operation = await PaymentOperation.findOne({ caseId: caseDoc._id }).lean();
    expect(operation.status).toBe("needs_reconciliation");
    expect(operation.stripeRefundId).toBe("re_recovery");

    const retry = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "refund", disputeId });

    expect(retry.status).toBe(200);
    expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
    const updated = await Case.findById(caseDoc._id).lean();
    operation = await PaymentOperation.findOne({ caseId: caseDoc._id }).lean();
    expect(updated.status).toBe("closed");
    expect(updated.disputeSettlement.refundId).toBe("re_recovery");
    expect(operation.status).toBe("succeeded");
  });

  test("Release retry reuses the transfer and completes missing local ledgers", async () => {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Recovery",
      email: "release.recovery.admin@example.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const attorney = await User.create({
      firstName: "Drew",
      lastName: "Counsel",
      email: "release.recovery.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Morgan",
      lastName: "Para",
      email: "release.recovery.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_release_recovery",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Release recovery",
      details: "Transfer evidence must prevent a duplicate settlement transfer.",
      status: "disputed",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_release_recovery",
      escrowStatus: "funded",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      disputes: [{ message: "Release after review", raisedBy: attorney._id, status: "open" }],
    });
    const disputeId = caseDoc.disputes[0].disputeId || String(caseDoc.disputes[0]._id);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_release_recovery",
      status: "succeeded",
      amount: 122000,
      amount_received: 122000,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: { caseId: String(caseDoc._id) },
      latest_charge: { id: "ch_release_recovery", amount: 122000, amount_refunded: 0 },
    });
    mockStripe.isTransferablePaymentIntent.mockReturnValue({
      transferable: true,
      charge: { id: "ch_release_recovery", amount: 122000, amount_refunded: 0 },
    });
    mockStripe.transfers.create.mockResolvedValue({ id: "tr_release_recovery" });
    const saveSpy = jest
      .spyOn(Case.prototype, "save")
      .mockRejectedValueOnce(new Error("simulated case persistence failure"));

    const first = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "release_full", disputeId });
    saveSpy.mockRestore();

    expect(first.status).toBe(503);
    expect(first.body.code).toBe("PAYOUT_RECONCILIATION_REQUIRED");
    let operation = await PaymentOperation.findOne({ caseId: caseDoc._id }).lean();
    expect(operation.status).toBe("needs_reconciliation");
    expect(operation.stripeTransferId).toBe("tr_release_recovery");

    const retry = await request(app)
      .post(`/api/payments/dispute/settle/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin))
      .send({ action: "release_full", disputeId });

    expect(retry.status).toBe(200);
    expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
    const updated = await Case.findById(caseDoc._id).lean();
    operation = await PaymentOperation.findOne({ caseId: caseDoc._id }).lean();
    const payouts = await Payout.find({ caseId: caseDoc._id }).lean();
    expect(updated.status).toBe("closed");
    expect(updated.payoutTransferId).toBe("tr_release_recovery");
    expect(operation.status).toBe("succeeded");
    expect(payouts).toHaveLength(1);
    expect(payouts[0].transferId).toBe("tr_release_recovery");
  });
});
