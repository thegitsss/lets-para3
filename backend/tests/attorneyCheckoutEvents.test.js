const express = require("express"), request = require("supertest"), mongoose = require("mongoose");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_checkout_events";
const mockStripe = { webhooks: { constructEvent: jest.fn() }, checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } }, paymentIntents: { retrieve: jest.fn(), create: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let owner, matter, checkout, intent, event;
const send = headers => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set(headers || {}).set("Content-Type", "application/json").send("{}");
const raw = () => Case.collection.findOne({ _id: matter._id });
const select = () => { event = { id: `evt_${new mongoose.Types.ObjectId()}`, type: "checkout.session.completed", livemode: false, created: 1788955200, data: { object: structuredClone(checkout) } }; mockStripe.webhooks.constructEvent.mockReturnValue(event); };
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Audit.init(), Delivery.init(), require("../models/PlatformIncome").init(), require("../models/AuthSession").init(), require("../models/FinancialAdjustment").init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); mockStripe.checkout.sessions.retrieve.mockReset(); mockStripe.paymentIntents.retrieve.mockReset();
  owner = await User.create({ firstName: "Synthetic", lastName: "Attorney", email: "owner@checkout-events.test", password: "Synthetic123!", role: "attorney", status: "approved", stripeCustomerId: "cus_checkout_owner" });
  matter = await Case.create({ title: "River Street original payment", details: "Retained original Checkout payment association.", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: "usd", stripeMode: "test", escrowSessionId: "cs_test_original", escrowIntentId: "", paymentIntentId: "", escrowStatus: "pending" });
  intent = { id: "pi_checkout_original", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", customer: owner.stripeCustomerId, livemode: false, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, transfer_group: `case_${matter._id}` };
  checkout = { id: "cs_test_original", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_subtotal: 48800, amount_total: 48800, currency: "usd", livemode: false, customer: owner.stripeCustomerId, payment_intent: intent.id, client_reference_id: String(matter._id), metadata: { caseId: String(matter._id) }, created: 1788951600 };
  mockStripe.checkout.sessions.retrieve.mockImplementation(async () => structuredClone(checkout)); mockStripe.paymentIntents.retrieve.mockImplementation(async () => structuredClone(intent)); select();
});
test("Checkout metadata alone cannot attach a payment to a Matter without its original session reference", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $unset: { escrowSessionId: "" } }); const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("a different Checkout callback cannot replace the retained original session", async () => {
  checkout.id = "cs_test_different"; select(); const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("an unavailable current Checkout remains retryable without changing payment references", async () => {
  const before = await raw(); mockStripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error("Synthetic Checkout unavailable")); expect((await send()).status).toBe(500); expect(await raw()).toEqual(before);
});
test("the original payment reference comes from current provider evidence instead of a delayed event fragment", async () => {
  event.data.object.payment_intent = "pi_old_fragment"; expect((await send()).status).toBe(200); expect(await raw()).toMatchObject({ paymentIntentId: intent.id, escrowIntentId: intent.id }); expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalled();
});
test("a failed Checkout audit leaves the original Matter unchanged", async () => {
  const before = await raw(); jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic Checkout audit unavailable")); expect((await send()).status).toBe(500); expect(await raw()).toEqual(before);
});
test("a changed Checkout amount cannot establish the Matter's payment reference", async () => {
  checkout.amount_total = 48801; const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("a PaymentIntent already retained by another Matter cannot be borrowed by Checkout", async () => {
  await Case.create({ title: "Other original payment", details: "Conflicting retained payment reference.", attorney: owner._id, attorneyId: owner._id, paymentIntentId: intent.id }); const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("Checkout cannot create disagreement between existing payment aliases", async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { paymentIntentId: "pi_existing_original" } }); const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before);
});
test("a connected-account Checkout cannot be interpreted as the platform's original payment", async () => {
  event.account = "acct_connected_checkout"; const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
});
test("a later completed and refunded Matter retains its financial outcome when the original references are recovered", async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { status: "completed", archived: true, paymentReleased: true, paymentStatus: "refunded", payoutStatus: "paid", payoutTransferId: "tr_later_payout", remainingAmount: 0 } });
  const paraId = new mongoose.Types.ObjectId(), paid = await Payout.create({ caseId: matter._id, paralegalId: paraId, amountPaid: 32800, transferId: "tr_later_payout", status: "paid", stripeMode: "test" });
  const paidBefore = await Payout.findById(paid._id).lean(); expect((await send()).status).toBe(200); expect(await raw()).toMatchObject({ status: "completed", archived: true, paymentReleased: true, paymentStatus: "refunded", payoutStatus: "paid", payoutTransferId: "tr_later_payout", remainingAmount: 0, paymentIntentId: intent.id, escrowIntentId: intent.id });
  expect(await Payout.findById(paid._id).lean()).toEqual(paidBefore); expect(await Operation.countDocuments()).toBe(0); expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled(); expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("receipt finalization failure rolls back both Checkout association and audit", async () => {
  const before = await raw(), update = Delivery.updateOne.bind(Delivery); jest.spyOn(Delivery, "updateOne").mockImplementation((filter, patch, options) => patch.$set?.status === "processed" ? Promise.reject(new Error("Synthetic receipt unavailable")) : update(filter, patch, options));
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Audit.countDocuments()).toBe(0);
});
test("a lost commit acknowledgement cannot reopen a processed original Checkout", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false; jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic Checkout acknowledgement lost"); } }; return session; });
  expect((await send()).status).toBe(500); const before = await raw(); expect((await Delivery.findOne({ eventId: event.id })).status).toBe("processed"); expect((await send()).body.deduped).toBe(true); expect(await raw()).toEqual(before); expect(await Audit.countDocuments()).toBe(1);
});
test("a retained Checkout business event survives receipt expiry without re-reading the provider", async () => {
  expect((await send()).status).toBe(200); const before = await raw(); await Delivery.deleteOne({ eventId: event.id }); mockStripe.checkout.sessions.retrieve.mockClear();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled(); expect(await Audit.countDocuments()).toBe(1);
});
test("different event contents cannot reuse a Checkout identity after receipt expiry", async () => {
  expect((await send()).status).toBe(200); const before = await raw(); await Delivery.deleteOne({ eventId: event.id }); event.data.object.amount_total = 1;
  expect((await send()).status).toBe(500); expect(await raw()).toEqual(before); expect(await Audit.countDocuments()).toBe(1);
});
test("a replaced Checkout callback attempt cannot change the replacement's completed result", async () => {
  let arrive, release; const waiting = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  mockStripe.checkout.sessions.retrieve.mockImplementationOnce(async () => { arrive(); await gate; return structuredClone(checkout); }); const first = send().then(response => response);
  try { await waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } }); expect((await send()).status).toBe(200); const before = await raw(); release(); expect((await first).status).toBe(500); expect(await raw()).toEqual(before); } finally { release(); await first; }
  expect(await Audit.countDocuments()).toBe(1);
});
test("another retained customer stops Checkout verification before a PaymentIntent read", async () => {
  checkout.customer = "cus_other_account"; const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("a paid live Checkout cannot be adopted in the test-mode application", async () => {
  checkout.livemode = true; event.livemode = true; const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("a delayed failed event uses the current original Checkout without claiming funding was recorded", async () => {
  event.type = "checkout.session.async_payment_failed"; event.data.object.payment_status = "unpaid"; expect((await send()).status).toBe(200); expect(await raw()).toMatchObject({ paymentIntentId: intent.id, escrowIntentId: intent.id, escrowStatus: "pending", paymentStatus: "pending" });
  expect((await Audit.findOne()).meta.checkoutPaymentStatus).toBe("paid"); expect(await Operation.countDocuments()).toBe(0);
});
test("an expired Checkout with no PaymentIntent remains retained without creating another payment", async () => {
  checkout.status = "expired"; checkout.payment_status = "unpaid"; checkout.payment_intent = null; event.type = "checkout.session.expired"; const before = await raw();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled(); expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled(); expect((await Audit.findOne()).meta.problem).toBe("checkout_payment_unavailable");
});
test("duplicate retained sessions cannot be resolved by matching metadata", async () => {
  await Case.create({ title: "Other retained Checkout", details: "Ambiguous session reference.", attorney: owner._id, attorneyId: owner._id, escrowSessionId: checkout.id }); const before = await raw();
  expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
});
test("an unsigned account header cannot choose Checkout provider context", async () => {
  expect((await send({ "Stripe-Account": "acct_unsigned_checkout" })).status).toBe(200); expect(mockStripe.checkout.sessions.retrieve.mock.calls[0]).toEqual([checkout.id, { expand: ["payment_intent"] }]);
});
test("an existing operation's different original payment cannot be displaced by Checkout", async () => {
  await Operation.create({ caseId: matter._id, operationKey: "funding:retained_other_intent", kind: "funding", fingerprint: "other_original_intent", amount: 48800, stripePaymentIntentId: "pi_other_original", stripeObjectId: "pi_other_original", status: "succeeded" });
  const before = await raw(); expect((await send()).status).toBe(200); expect(await raw()).toEqual(before); expect((await Audit.findOne()).meta.problem).toBe("checkout_retained_payment_conflict");
});
test("a Matter changed before Checkout commit remains unchanged and can be checked by a fresh retry", async () => {
  const start = mongoose.startSession.bind(mongoose); let arrive, release; const waiting = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  jest.spyOn(mongoose, "startSession").mockImplementationOnce(async () => { arrive(); await gate; return start(); }); const first = send().then(response => response);
  try { await waiting; await Case.updateOne({ _id: matter._id }, { $set: { archived: true, paymentStatus: "refunded" } }); const changed = await raw(); release(); expect((await first).status).toBe(500); expect(await raw()).toEqual(changed); expect(await Audit.countDocuments()).toBe(0); } finally { release(); await first; }
  expect((await send()).status).toBe(200); expect(await raw()).toMatchObject({ archived: true, paymentStatus: "refunded", paymentIntentId: intent.id, escrowIntentId: intent.id });
});
