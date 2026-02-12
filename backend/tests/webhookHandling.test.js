const express = require("express");
const request = require("supertest");

process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test";

const mockStripe = {
  webhooks: {
    constructEvent: jest.fn(),
  },
  isTransferablePaymentIntent: jest.fn(() => ({ transferable: true })),
};
const mockNotifyUser = jest.fn(async () => ({ ok: true }));

jest.mock("../utils/stripe", () => mockStripe);

jest.mock("../utils/notifyUser", () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const WebhookEvent = require("../models/WebhookEvent");
const paymentsWebhookRouter = require("../routes/paymentsWebhook");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use("/api/payments/webhook", express.raw({ type: "application/json" }), paymentsWebhookRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return instance;
})();

beforeAll(async () => {
  await connect();
  await WebhookEvent.init();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  mockStripe.webhooks.constructEvent.mockReset();
  mockStripe.isTransferablePaymentIntent.mockClear();
  mockNotifyUser.mockClear();
});

describe("Webhook handling", () => {
  test("PaymentIntent succeeded updates case and logs", async () => {
    // Description: Stripe webhook marks case funded and logs the event.
    // Input values: payment_intent.succeeded with metadata.caseId.
    // Expected result: escrowStatus=funded, paymentStatus=succeeded, AuditLog + WebhookEvent recorded.

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
      details: "Webhook handling test case details.",
      status: "assigned",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "awaiting_funding",
      totalAmount: 100000,
      currency: "usd",
    });

    const event = {
      id: "evt_123",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_123",
          amount: 100000,
          currency: "usd",
          metadata: { caseId: String(caseDoc._id) },
        },
      },
    };

    mockStripe.webhooks.constructEvent.mockImplementation(() => event);

    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({}))); // body is unused by mock

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.escrowStatus).toBe("funded");
    expect(updated.paymentStatus).toBe("succeeded");
    expect(updated.escrowIntentId).toBe("pi_123");
    expect(updated.status).toBe("in progress");

    const webhookRecord = await WebhookEvent.findOne({ eventId: "evt_123" }).lean();
    expect(webhookRecord).toBeTruthy();
    expect(webhookRecord.status).toBe("processed");

    const audit = await AuditLog.findOne({
      action: "payment.intent.succeeded",
      targetId: "pi_123",
    }).lean();
    expect(audit).toBeTruthy();

    expect(mockNotifyUser).toHaveBeenCalled();
  });

  test("Duplicate webhook event is deduped", async () => {
    // Description: Stripe retries same event id.
    // Input values: same event id sent twice.
    // Expected result: second call returns deduped=true and only one WebhookEvent exists.

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
      email: "priya.ng2@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Contract review",
      details: "Webhook dedupe test case details.",
      status: "assigned",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "awaiting_funding",
      totalAmount: 50000,
      currency: "usd",
    });

    const event = {
      id: "evt_dedupe",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_dedupe",
          amount: 50000,
          currency: "usd",
          metadata: { caseId: String(caseDoc._id) },
        },
      },
    };

    mockStripe.webhooks.constructEvent.mockImplementation(() => event);

    const first = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({}))); // body is unused by mock

    expect(first.status).toBe(200);
    expect(first.body.received).toBe(true);

    const second = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({})));

    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);

    const count = await WebhookEvent.countDocuments({ eventId: "evt_dedupe" });
    expect(count).toBe(1);
  });
});
