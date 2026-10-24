const express = require("express");
const request = require("supertest");

process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test";

const mockStripe = {
  disputes: { retrieve: jest.fn() },
  refunds: { retrieve: jest.fn(), list: jest.fn() },
  webhooks: {
    constructEvent: jest.fn(),
  },
  paymentIntents: {
    retrieve: jest.fn(),
  },
  charges: {
    retrieve: jest.fn(),
  },
  balanceTransactions: {
    retrieve: jest.fn(),
  },
  isTransferablePaymentIntent: jest.fn(() => ({ transferable: true })),
};
const mockDispatchNotice = jest.fn(async () => ({ ok: true }));
const mockNotifyUser = jest.fn(async (_userId, _type, _payload, options = {}) => options.deferDispatch ? mockDispatchNotice : { ok: true });
const mockSendOwnerAlert = jest.fn(async () => ({ ok: true }));

jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));

jest.mock("../utils/notifyUser", () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));
jest.mock("../utils/opsAlerting", () => ({
  sendOwnerAlert: (...args) => mockSendOwnerAlert(...args),
}));

const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const WebhookEvent = require("../models/WebhookEvent");
const Payout = require("../models/Payout");
const PaymentOperation = require("../models/PaymentOperation");
const FinancialAdjustment = require("../models/FinancialAdjustment");
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
  await Promise.all([User.init(), Case.init(), Payout.init(), PaymentOperation.init(), AuditLog.init(), WebhookEvent.init(), FinancialAdjustment.init(), require("../models/PlatformIncome").init(), require("../models/AuthSession").init()]);
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  mockStripe.webhooks.constructEvent.mockReset();
  mockStripe.paymentIntents.retrieve.mockReset();
  mockStripe.refunds.retrieve.mockReset();
  mockStripe.refunds.list.mockReset();
  mockStripe.charges.retrieve.mockReset();
  mockStripe.balanceTransactions.retrieve.mockReset();
  mockStripe.disputes.retrieve.mockReset();
  mockStripe.isTransferablePaymentIntent.mockClear();
  mockNotifyUser.mockClear();
  mockDispatchNotice.mockClear();
  mockSendOwnerAlert.mockClear();
});

describe("Webhook handling", () => {
  test("chargeback webhook interruption replays safely without duplicate operations or adjustments", async () => {
    const [attorney, paralegal] = await User.create([
      { firstName: "Webhook", lastName: "Attorney", email: "chargeback-webhook-attorney@example.com", password: "Password123!", role: "attorney", status: "approved", state: "CA" },
      { firstName: "Webhook", lastName: "Paralegal", email: "chargeback-webhook-paralegal@example.com", password: "Password123!", role: "paralegal", status: "approved", state: "CA" },
    ]);
    const caseDoc = await Case.create({
      title: "Webhook chargeback",
      details: "Chargeback webhook interruption and replay test.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      escrowIntentId: "pi_chargeback_webhook",
      paymentIntentId: "pi_chargeback_webhook",
      paymentReleased: false,
      lockedTotalAmount: 40000,
      totalAmount: 40000,
      currency: "usd",
    });
    const event = {
      id: "evt_chargeback_interrupted",
      type: "charge.dispute.created",
      created: 1_800_000_000,
      livemode: false,
      data: {
        object: {
          id: "dp_chargeback_interrupted",
          object: "dispute",
          amount: 48800,
          currency: "usd",
          status: "needs_response",
          livemode: false,
          charge: "ch_chargeback_interrupted",
          balance_transactions: ["txn_chargeback_interrupted"],
        },
      },
    };
    mockStripe.webhooks.constructEvent.mockImplementation(() => event);
    mockStripe.disputes.retrieve.mockResolvedValue(event.data.object);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_chargeback_webhook", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, latest_charge: "ch_chargeback_interrupted", transfer_group: `case_${caseDoc._id}`, metadata: { caseId: String(caseDoc._id) } });
    mockStripe.charges.retrieve.mockResolvedValue({
      id: "ch_chargeback_interrupted",
      object: "charge",
      status: "succeeded",
      paid: true,
      captured: true,
      livemode: false,
      amount_captured: 48800,
      amount: 48800,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: {
        id: "pi_chargeback_webhook",
        metadata: { caseId: String(caseDoc._id) },
      },
    });
    mockStripe.balanceTransactions.retrieve.mockResolvedValue({
      id: "txn_chargeback_interrupted",
      object: "balance_transaction",
      source: "dp_chargeback_interrupted",
      amount: -48800,
      fee: 1500,
      net: -50300,
      currency: "usd",
      created: 1_800_000_000,
    });
    const auditSpy = jest.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("simulated audit interruption"));
    const first = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({})));
    expect(first.status).toBe(500);
    expect((await WebhookEvent.findOne({ eventId: event.id }).lean()).status).toBe("failed");
    expect(await PaymentOperation.countDocuments({ kind: "chargeback" })).toBe(0);
    expect(await FinancialAdjustment.countDocuments()).toBe(0);

    const replay = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({})));
    auditSpy.mockRestore();

    expect(replay.status).toBe(200);
    expect(await PaymentOperation.countDocuments({ operationKey: "chargeback:dp_chargeback_interrupted" })).toBe(1);
    expect(await FinancialAdjustment.countDocuments({ stripeDisputeId: "dp_chargeback_interrupted" })).toBe(2);
    expect((await WebhookEvent.findOne({ eventId: event.id }).lean()).status).toBe("processed");
    expect(await Case.findById(caseDoc._id).lean()).toEqual(expect.objectContaining({
      status: "in progress",
      paymentReleased: false,
      disputes: [],
    }));
  });

  test("PaymentIntent succeeded updates case and logs", async () => {
    // Description: Stripe webhook marks case funded and logs the event.
    // Input values: a retained PaymentIntent and complete current capture evidence.
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
      escrowIntentId: "pi_123",
      paymentIntentId: "pi_123",
      currency: "usd",
    });

    const event = {
      id: "evt_123",
      livemode: false,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_123",
          object: "payment_intent",
          status: "succeeded",
          amount: 122000,
          amount_received: 122000,
          currency: "usd",
          livemode: false,
          metadata: { caseId: String(caseDoc._id) },
          transfer_group: `case_${caseDoc._id}`,
          latest_charge: { id: "ch_123", amount: 122000, amount_captured: 122000, amount_refunded: 0, paid: true, captured: true, status: "succeeded", currency: "usd", livemode: false, payment_intent: "pi_123", balance_transaction: { id: "txn_123", type: "charge", amount: 122000, fee: 3500, net: 118500, currency: "usd", source: "ch_123" } },
        },
      },
    };

    mockStripe.webhooks.constructEvent.mockImplementation(() => event);
    mockStripe.paymentIntents.retrieve.mockResolvedValue(event.data.object);

    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({}))); // body is unused by mock

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(mockNotifyUser).toHaveBeenCalledWith(String(paralegal._id), "case_work_ready", expect.objectContaining({ caseId: caseDoc._id }), expect.objectContaining({ deferDispatch: true, workReady: true }));
    expect(mockDispatchNotice).toHaveBeenCalledTimes(1);

    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.escrowStatus).toBe("funded");
    expect(updated.paymentStatus).toBe("succeeded");
    expect(updated.escrowIntentId).toBe("pi_123");
    expect(updated.status).toBe("in progress");
    expect(updated.stripeMode).toBe("test");

    const webhookRecord = await WebhookEvent.findOne({ eventId: "evt_123" }).lean();
    expect(webhookRecord).toBeTruthy();
    expect(webhookRecord.status).toBe("processed");
    expect(webhookRecord.stripeMode).toBe("test");

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
          amount: 61000,
          currency: "usd",
          metadata: { caseId: String(caseDoc._id) },
          transfer_group: `case_${caseDoc._id}`,
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

  test("authenticated connected-account refunds stay separate from platform funding", async () => {
    const event = {
      id: "evt_refund_connect",
      type: "refund.updated",
      livemode: false,
      account: "acct_connected_refund",
      data: {
        object: {
          id: "re_connect",
          object: "refund",
          amount: 5000,
          currency: "usd",
          payment_intent: "pi_connect_refund",
        },
      },
    };

    mockStripe.webhooks.constructEvent.mockImplementation(() => event);
    mockStripe.paymentIntents.retrieve.mockRejectedValue(new Error("No such payment_intent"));

    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Stripe-Account", "acct_connected_refund")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({})));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(mockStripe.refunds.retrieve).not.toHaveBeenCalled();

    const audit = await AuditLog.findOne({
      action: "refund.updated",
      "meta.externalRef": "re_connect",
    }).lean();
    expect(audit).toBeTruthy();
    expect(audit.meta.associationProblem).toBe("unsupported_connected_account_refund");

    const webhookRecord = await WebhookEvent.findOne({ eventId: "evt_refund_connect" }).lean();
    expect(webhookRecord.status).toBe("processed");
  });

  test("downstream webhook processing errors are acknowledged instead of returning 500", async () => {
    const attorney = await User.create({
      firstName: "Webhook",
      lastName: "Attorney",
      email: "webhook-processing-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Webhook",
      lastName: "Paralegal",
      email: "webhook-processing-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Webhook processing failure case",
      details: "Trigger a downstream webhook write failure.",
      status: "assigned",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "awaiting_funding",
      totalAmount: 1000,
      currency: "usd",
    });

    const event = {
      id: "evt_processing_failure",
      type: "payment_intent.succeeded",
      livemode: false,
      data: {
        object: {
          id: "pi_processing_failure",
          amount: 1220,
          currency: "usd",
          livemode: false,
          metadata: { caseId: String(caseDoc._id) },
          transfer_group: `case_${caseDoc._id}`,
        },
      },
    };

    mockStripe.webhooks.constructEvent.mockImplementation(() => event);
    const saveSpy = jest.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("audit write failed"));

    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({})));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ received: false, handled: false });

    const webhookRecord = await WebhookEvent.findOne({ eventId: "evt_processing_failure" }).lean();
    expect(webhookRecord.status).toBe("failed");
    expect(webhookRecord.lastError).toMatch(/audit write failed/i);

    saveSpy.mockRestore();

    const retry = await request(app)
      .post("/api/payments/webhook")
      .set("Stripe-Signature", "test-signature")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({})));

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ received: true });

    const processedRecord = await WebhookEvent.findOne({ eventId: "evt_processing_failure" }).lean();
    expect(processedRecord.status).toBe("processed");
    expect(processedRecord.attempts).toBe(2);
  });

  test("a delayed refund failure cannot regress a confirmed full refund", async () => {
    const attorney = await User.create({
      firstName: "Refund",
      lastName: "Attorney",
      email: "refund-ordering-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
    });
    const caseDoc = await Case.create({
      title: "Refund ordering",
      details: "Confirmed refunds remain authoritative.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "closed",
      escrowStatus: "funded",
      escrowIntentId: "pi_refund_ordering",
      paymentIntentId: "pi_refund_ordering",
      paymentStatus: "succeeded",
      totalAmount: 40000,
      lockedTotalAmount: 40000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 8800,
      currency: "usd",
    });
    const charge = { id: "ch_refund_ordering", object: "charge", payment_intent: "pi_refund_ordering", amount: 48800, amount_captured: 48800, amount_refunded: 48800, paid: true, captured: true, refunded: true, disputed: false, status: "succeeded", currency: "usd", livemode: false };
    const refund = { id: "re_ordering", object: "refund", status: "succeeded", amount: 48800, currency: "usd", payment_intent: "pi_refund_ordering", charge: charge.id, created: 1788951600 };
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_refund_ordering", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, metadata: { caseId: String(caseDoc._id) }, transfer_group: `case_${caseDoc._id}`, latest_charge: charge });
    mockStripe.charges.retrieve.mockResolvedValue(charge);
    mockStripe.refunds.retrieve.mockResolvedValue(refund);
    mockStripe.refunds.list.mockResolvedValue({ data: [refund], has_more: false });
    mockStripe.webhooks.constructEvent
      .mockReturnValueOnce({ id: "evt_refund_succeeded_ordering", type: "refund.updated", livemode: false, created: 1788955200, data: { object: refund } })
      .mockReturnValueOnce({ id: "evt_refund_failed_late", type: "refund.failed", livemode: false, created: 1788955199, data: { object: { ...refund, status: "failed" } } });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app)
        .post("/api/payments/webhook")
        .set("Stripe-Signature", "test-signature")
        .set("Content-Type", "application/json")
        .send(Buffer.from(JSON.stringify({})));
      expect(response.status).toBe(200);
    }
    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated.paymentStatus).toBe("refunded");
    expect(updated.paymentReleased).toBe(false);
  });

  test("a delayed transfer.created event cannot regress a reversed payout", async () => {
    const attorney = await User.create({
      firstName: "Transfer",
      lastName: "Attorney",
      email: "transfer-ordering-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
    });
    const paralegal = await User.create({
      firstName: "Transfer",
      lastName: "Paralegal",
      email: "transfer-ordering-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "NY",
    });
    const caseDoc = await Case.create({
      title: "Transfer ordering",
      details: "Reversed payout remains visible.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "completed",
      escrowStatus: "funded",
      escrowIntentId: "pi_transfer_ordering",
      paymentReleased: true,
      payoutTransferId: "tr_transfer_ordering",
      payoutStatus: "paid",
      totalAmount: 40000,
      lockedTotalAmount: 40000,
    });
    await Payout.create({
      caseId: caseDoc._id,
      paralegalId: paralegal._id,
      amountPaid: 32800,
      transferId: "tr_transfer_ordering",
      status: "paid",
      stripeMode: "test",
    });
    const transfer = {
      id: "tr_transfer_ordering",
      object: "transfer",
      amount: 32800,
      currency: "usd",
      destination: "acct_transfer_ordering",
      livemode: false,
      reversed: true,
      amount_reversed: 32800,
      transfer_group: `case_${caseDoc._id}`,
    };
    mockStripe.webhooks.constructEvent
      .mockReturnValueOnce({ id: "evt_transfer_reversed_first", type: "transfer.reversed", created: 1788955200, livemode: false, data: { object: transfer } })
      .mockReturnValueOnce({ id: "evt_transfer_created_late", type: "transfer.created", created: 1788868800, livemode: false, data: { object: { ...transfer, reversed: false, amount_reversed: 0 } } });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app)
        .post("/api/payments/webhook")
        .set("Stripe-Signature", "test-signature")
        .set("Content-Type", "application/json")
        .send(Buffer.from(JSON.stringify({})));
      expect(response.status).toBe(200);
    }
    const [updatedCase, updatedPayout] = await Promise.all([
      Case.findById(caseDoc._id).lean(),
      Payout.findOne({ caseId: caseDoc._id }).lean(),
    ]);
    expect(updatedCase.payoutStatus).toBe("reversed");
    expect(updatedCase.paymentReleased).toBe(false);
    expect(updatedPayout.status).toBe("reversed");
  });
});
