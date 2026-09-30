const express = require("express"), request = require("supertest"), mongoose = require("mongoose");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_payment_action";
const mockStripe = { webhooks: { constructEvent: jest.fn() }, paymentIntents: { retrieve: jest.fn(), create: jest.fn() }, charges: { retrieve: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/email", () => jest.fn(async () => ({ disabled: true })));
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Audit = require("../models/AuditLog"), Notification = require("../models/Notification"), Delivery = require("../models/WebhookEvent");
// Register before connect/cleanup so prior suites cannot leave unseen queue records.
const PaymentNotice = require("../models/MatterPaymentNotification");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let owner, para, matter, event;
const raw = () => Case.collection.findOne({ _id: matter._id });
const send = () => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic").set("Content-Type", "application/json").send("{}");
function choose(status) {
  const intent = { id: "pi_action", object: "payment_intent", status, amount: 48800, amount_received: 0, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: null };
  event = { id: `evt_${new mongoose.Types.ObjectId()}`, type: status === "requires_payment_method" ? "payment_intent.payment_failed" : `payment_intent.${status}`, livemode: false, created: 1788955200, data: { object: intent } };
  mockStripe.webhooks.constructEvent.mockReturnValue(event); mockStripe.paymentIntents.retrieve.mockResolvedValue(intent);
}
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@payment-action.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ title: "Payment action notice", details: "Synthetic", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "open", totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: "usd", stripeMode: "test", paymentIntentId: "pi_action", escrowIntentId: "pi_action", escrowStatus: "awaiting_funding" });
});
test.each([
  ["requires_action", "in_app"], ["requires_payment_method", "in_app"], ["canceled", "in_app"],
  ["requires_action", "email"], ["requires_payment_method", "email"], ["canceled", "email"],
])("%s payment state and its %s notice roll back together and recover once", async (status, failure) => {
  choose(status); const before = await raw();
  jest.spyOn(failure === "in_app" ? Notification : PaymentNotice, "create").mockRejectedValueOnce(new Error("Synthetic payment notice unavailable"));
  expect((await send()).status).toBe(500);
  expect(await raw()).toEqual(before); expect(await Notification.countDocuments()).toBe(0); expect(await PaymentNotice.countDocuments()).toBe(0);
  expect(await Audit.countDocuments({ case: matter._id })).toBe(0);
  expect((await Delivery.findOne({ eventId: event.id })).status).not.toBe("processed");
  expect((await send()).status).toBe(200);
  expect(await raw()).toMatchObject({ status: "open", escrowStatus: "awaiting_funding", paymentStatus: status });
  expect(await Notification.countDocuments({ userId: owner._id, type: "case_update" })).toBe(1);
  expect((await send()).status).toBe(200);
  choose(status); expect((await send()).status).toBe(200);
  expect(await Notification.countDocuments({ userId: owner._id, type: "case_update" })).toBe(1);
  expect(await Notification.countDocuments({ userId: para._id })).toBe(0);
  expect(await PaymentNotice.countDocuments({ userId: owner._id, paymentStatus: status, status: "pending" })).toBe(1);
  expect(require("../utils/email")).not.toHaveBeenCalled();
  expect(await Operation.countDocuments()).toBe(0); expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
});
