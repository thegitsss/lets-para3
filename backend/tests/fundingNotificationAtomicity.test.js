const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_funding_notifications";
const mockStripe = { webhooks: { constructEvent: jest.fn() }, paymentIntents: { retrieve: jest.fn(), create: jest.fn() }, charges: { retrieve: jest.fn() }, balanceTransactions: { retrieve: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/email", () => jest.fn(async () => ({ disabled: true })));
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Audit = require("../models/AuditLog"), Notification = require("../models/Notification"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
app.use(cookieParser(), express.json());
app.use("/api/payments", require("../routes/payments"));
let owner, para, matter, event;
const raw = () => Case.collection.findOne({ _id: matter._id });
const cookie = () => `token=${require("jsonwebtoken").sign({ id: String(owner._id), role: "attorney", av: owner.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const webhook = () => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic").set("Content-Type", "application/json").send("{}");
async function manualRequest() {
  const endpoint = `/api/payments/matter/${matter._id}/funding`, expectedOwnerId = String(owner._id);
  const review = await request(app).get(endpoint).query({ expectedOwnerId }).set("Cookie", cookie());
  expect(review.status).toBe(200);
  const body = { expectedOwnerId, reviewedRevision: review.body.revision, requestId: crypto.randomUUID(), action: "check" };
  return () => request(app).post(endpoint).set("Cookie", cookie()).send(body);
}
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@funding-notice.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ title: "Funding notice recovery", details: "Synthetic Matter", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "open", totalAmount: 100001, lockedTotalAmount: 100001, remainingAmount: 100001, feeAttorneyPct: 22, feeAttorneyAmount: 22000, currency: "usd", stripeMode: "test", paymentIntentId: "pi_notice", escrowIntentId: "pi_notice" });
  const intent = { id: "pi_notice", object: "payment_intent", status: "succeeded", amount: 122001, amount_received: 122001, currency: "usd", livemode: false, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, latest_charge: { id: "ch_notice", amount: 122001, amount_captured: 122001, amount_refunded: 0, paid: true, captured: true, refunded: false, disputed: false, status: "succeeded", currency: "usd", livemode: false, payment_intent: "pi_notice", balance_transaction: { id: "txn_notice", type: "charge", amount: 122001, fee: 3500, net: 118501, currency: "usd", source: "ch_notice" } } };
  event = { id: `evt_${new mongoose.Types.ObjectId()}`, type: "payment_intent.succeeded", livemode: false, created: 1788955200, data: { object: intent } };
  mockStripe.webhooks.constructEvent.mockReturnValue(event); mockStripe.paymentIntents.retrieve.mockResolvedValue(intent);
});
test.each([
  ["manual", "in_app"], ["webhook", "in_app"], ["manual", "email"], ["webhook", "email"],
])("%s funding cannot commit without its %s notice and retry records both exactly once", async (source, failure) => {
  const send = source === "manual" ? await manualRequest() : webhook, before = await raw();
  const WorkNotice = require("../models/MatterWorkNotification");
  jest.spyOn(failure === "in_app" ? Notification : WorkNotice, "create").mockRejectedValueOnce(new Error("Synthetic notification write unavailable"));
  expect((await send()).status).toBe(source === "manual" ? 503 : 500);
  expect(await raw()).toEqual(before);
  expect(await Operation.countDocuments()).toBe(0);
  expect(await Notification.countDocuments()).toBe(0);
  expect(await WorkNotice.countDocuments()).toBe(0);
  expect(await Audit.countDocuments({ case: matter._id })).toBe(0);
  if (source === "webhook") expect((await Delivery.findOne({ eventId: event.id })).status).not.toBe("processed");
  expect((await send()).status).toBe(200);
  expect(await raw()).toMatchObject({ escrowStatus: "funded", status: "in progress" });
  expect(await Operation.countDocuments()).toBe(1);
  expect(await Notification.countDocuments({ userId: para._id, type: "case_work_ready" })).toBe(1);
  expect((await send()).status).toBe(200);
  const opposite = source === "manual" ? webhook : await manualRequest();
  expect((await opposite()).status).toBe(200);
  expect(await Notification.countDocuments({ userId: para._id, type: "case_work_ready" })).toBe(1);
  expect(await Operation.countDocuments()).toBe(1);
  expect(await WorkNotice.countDocuments({ userId: para._id, status: "pending" })).toBe(1);
  expect(require("../utils/email")).not.toHaveBeenCalled();
  expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
});

for (const source of ["manual", "webhook"]) {
  test.each(["disabled", "deleted", "unapproved", "wrong_role", "missing"])(`${source} records captured funding without opening work for a %s paralegal`, async state => {
    if (state === "missing") await User.collection.deleteOne({ _id: para._id });
    else await User.collection.updateOne({ _id: para._id }, { $set: state === "unapproved" ? { status: "pending" } : state === "wrong_role" ? { role: "attorney" } : { [state]: true } });
    const send = source === "manual" ? await manualRequest() : webhook;
    expect((await send()).status).toBe(200);
    expect(await raw()).toMatchObject({ status: "open", fundingIntegrityStatus: "verified" });
    expect((await raw()).escrowStatus).not.toBe("funded");
    expect(await Operation.countDocuments({ status: "succeeded" })).toBe(1);
    expect(await Notification.countDocuments()).toBe(0);
    expect(await require("../models/MatterWorkNotification").countDocuments()).toBe(0);
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });
  test.each(["disabled", "wrong_role"])(`${source} activation arbitrates a concurrent %s account change`, async state => {
    const send = source === "manual" ? await manualRequest() : webhook, before = await raw();
    const update = User.collection.updateOne.bind(User.collection); let interleaved = false;
    const changed = jest.spyOn(User.collection, "updateOne").mockImplementation(async (filter, values, options) => {
      if (!interleaved && String(filter._id) === String(para._id) && values.$inc?.__v === 1 && options?.session) {
        interleaved = true;
        await update({ _id: para._id }, { $set: state === "disabled" ? { disabled: true } : { role: "attorney" } });
      }
      return update(filter, values, options);
    });
    expect((await send()).status).toBe(source === "manual" ? 409 : 500);
    expect(interleaved).toBe(true); expect(await raw()).toEqual(before);
    expect(await Operation.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
    expect(await require("../models/MatterWorkNotification").countDocuments()).toBe(0);
    changed.mockRestore();
    const retry = source === "manual" ? await manualRequest() : webhook;
    expect((await retry()).status).toBe(200); expect((await raw()).status).toBe("open");
    expect(await Operation.countDocuments({ status: "succeeded" })).toBe(1);
    expect(await Notification.countDocuments()).toBe(0); expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });
}
