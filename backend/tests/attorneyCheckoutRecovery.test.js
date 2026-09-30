const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
const mockStripe = { checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } }, paymentIntents: { retrieve: jest.fn(), create: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/payments", require("../routes/payments"));
let owner, other, matter, checkout, intent;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const read = (query = {}, user = owner) => request(app).get(`/api/payments/matter/${matter._id}/checkout`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const resume = (revision, body = {}, user = owner) => request(app).post(`/api/payments/matter/${matter._id}/checkout/resume`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), reviewedRevision: revision, ...body });
const change = patch => Case.collection.updateOne({ _id: matter._id }, { $set: patch });
const records = async () => Promise.all([Case.collection.find({}).sort({ _id: 1 }).toArray(), Operation.collection.find({}).toArray(), Payout.collection.find({}).toArray(), Audit.collection.find({}).toArray()]);
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), Operation.init(), Payout.init(), Audit.init()]); });
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.resetAllMocks();
  [owner, other] = await User.create(["owner", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@checkout-recovery.test`, password: "Synthetic123!", role: "attorney", status: "approved", stripeCustomerId: `cus_${name}` })));
  matter = await Case.create({ title: "River Street original Checkout", details: "Synthetic retained payment.", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: "usd", stripeMode: "test", escrowSessionId: "cs_test_original", escrowStatus: "pending" });
  intent = { id: "pi_original", object: "payment_intent", status: "requires_payment_method", amount: 48800, amount_received: 0, currency: "usd", customer: "cus_owner", livemode: false, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) }, transfer_group: `case_${matter._id}` };
  checkout = { id: "cs_test_original", object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", amount_total: 48800, currency: "usd", livemode: false, customer: "cus_owner", payment_intent: null, client_reference_id: String(matter._id), metadata: { caseId: String(matter._id), privateNote: "PRIVATE" }, ui_mode: "hosted_page", expires_at: Math.floor(Date.now() / 1000) + 1800, url: "https://checkout.stripe.com/c/pay/cs_test_original#synthetic" };
  mockStripe.checkout.sessions.retrieve.mockImplementation(async () => structuredClone(checkout)); mockStripe.paymentIntents.retrieve.mockImplementation(async () => structuredClone(intent));
});
test("review and explicit resumption use the same open Session with no PaymentIntent yet and make no financial writes", async () => {
  const before = await records(), result = await read(); expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { state: "available", canResume: true, fundingVerified: false, totalCents: 48800, currency: "USD", sessionId: checkout.id } });
  expect(result.headers["cache-control"]).toBe("private, no-store"); expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|https:|cus_|clientSecret/);
  const sent = await resume(result.body.revision); expect(sent.status).toBe(200); expect(sent.body.url).toBe(checkout.url); expect(await records()).toEqual(before);
  expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(2); expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled(); expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("the existing funding review offers recovery without preparing a second payment", async () => {
  const result = await request(app).get(`/api/payments/matter/${matter._id}/funding`).query({ expectedOwnerId: String(owner._id) }).set("Cookie", cookie(owner));
  expect(result.body).toMatchObject({ hasOriginalCheckout: true, canPrepare: false, canEditAmount: false }); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
});
test.each(["expired", "processing", "paid"])("%s is retained as a distinct outcome and cannot reopen or replace Checkout", async state => {
  checkout.url = null;
  if (state === "expired") checkout.status = "expired";
  else { checkout.status = "complete"; checkout.payment_intent = intent.id; intent.status = state === "paid" ? "succeeded" : "processing"; if (state === "paid") { checkout.payment_status = "paid"; intent.amount_received = 48800; } }
  const before = await records(), result = await read(); expect(result.status).toBe(200); expect(result.body).toMatchObject({ state, canResume: false, fundingVerified: false }); expect((await resume(result.body.revision)).status).toBe(409); expect(await records()).toEqual(before); expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test.each([{ customer: "cus_other" }, { amount_total: 48801 }, { currency: "eur" }, { livemode: true }, { mode: "subscription" }, { payment_intent: "invalid" }, { status: "complete" }, { client_reference_id: "a".repeat(24) }])("conflicting provider evidence %j exposes no resume URL", async patch => {
  Object.assign(checkout, patch); const result = await read(); expect(result.status).toBe(200); expect(result.body).toMatchObject({ state: "needs_review", canResume: false }); expect((await resume(result.body.revision)).status).toBe(409); expect(JSON.stringify(result.body)).not.toContain("https:");
});
test.each(["https://evil.test/c/pay/cs_test_original", "https://checkout.stripe.com.evil.test/c/pay/cs_test_original", "https://attacker@checkout.stripe.com/c/pay/cs_test_original", "http://checkout.stripe.com/c/pay/cs_test_original", "https://checkout.stripe.com:444/c/pay/cs_test_original", "https://checkout.stripe.com/c/pay/cs_other", null])("untrusted or missing hosted URL %s blocks resumption", async url => {
  checkout.url = url; const result = await read(); expect(result.status).toBe(200); expect(result.body.canResume).toBe(false); expect((await resume(result.body.revision)).status).toBe(409);
});
test.each([{ status: "completed" }, { archived: true }, { readOnly: true }, { paymentReleased: true }, { escrowStatus: "funded" }, { paymentStatus: "refunded" }, { hiringClaimStatus: "processing" }, { pausedAt: new Date() }, { fundingRequestKey: "uncertain" }, { relatedPaymentIntentIds: ["pi_other"] }])("later local activity %j blocks another payment", async patch => {
  await change(patch); const before = await records(), result = await read(); expect(result.status).toBe(200); expect(result.body.canResume).toBe(false); expect((await resume(result.body.revision)).status).toBe(409); expect(await records()).toEqual(before);
});
test("expired links and in-flight intents cannot be treated as an open unpaid form", async () => {
  checkout.expires_at = Math.floor(Date.now() / 1000) - 1; expect((await read()).body.canResume).toBe(false);
  checkout.expires_at += 1800; checkout.payment_intent = intent.id; intent.status = "processing"; expect((await read()).body).toMatchObject({ state: "processing", canResume: false });
});
test("duplicate Session and foreign PaymentIntent associations cannot be resumed", async () => {
  const duplicate = { _id: new mongoose.Types.ObjectId(), attorney: other._id, escrowSessionId: checkout.id }; await Case.collection.insertOne(duplicate); expect((await read()).body.canResume).toBe(false); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  await Case.collection.deleteOne({ _id: duplicate._id }); await Case.collection.insertOne({ attorney: other._id, paymentIntentId: intent.id }); checkout.payment_intent = intent.id; expect((await read()).body).toMatchObject({ state: "needs_review", canResume: false });
});
test("another account and malformed requests fail before a provider read", async () => {
  expect((await read({}, other)).status).toBe(403); expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403); expect((await read({ sessionId: checkout.id })).status).toBe(400); expect((await resume("a".repeat(64), { amount: 1 })).status).toBe(400); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
});
test("account loss or Matter edits during provider retrieval discard the earlier review", async () => {
  mockStripe.checkout.sessions.retrieve.mockImplementationOnce(async () => { await change({ title: "Changed during review" }); return structuredClone(checkout); }); expect((await read()).status).toBe(409);
  mockStripe.checkout.sessions.retrieve.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return structuredClone(checkout); }); expect((await read()).status).toBe(403);
});
test("resumption rechecks expiry, provider and local revisions instead of trusting an old review", async () => {
  const result = await read(); checkout.expires_at -= 1; expect((await resume(result.body.revision)).status).toBe(409);
  const next = await read(); await change({ title: "Changed after review" }); expect((await resume(next.body.revision)).status).toBe(409);
});
test("provider failure stays unavailable and never mutates the retained payment", async () => {
  const before = await records(); mockStripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error("Synthetic provider unavailable")); expect((await read()).status).toBe(502); expect(await records()).toEqual(before);
});

test.each(["pending", "paid", "failed", "reversed", "needs_reconciliation"])("a retained %s payout cannot allow Checkout resumption", async payoutStatus => {
  await change({ payoutStatus }); const before = await records(), result = await read(); expect(result.status).toBe(200); expect(result.body.canResume).toBe(false); expect((await resume(result.body.revision)).status).toBe(409); expect(await records()).toEqual(before);
});
test("an open original intent remains eligible only without an earlier charge or received amount", async () => {
  checkout.payment_intent = intent.id; expect((await read()).body).toMatchObject({ state: "available", canResume: true });
  intent.latest_charge = "ch_previous"; expect((await read()).body.canResume).toBe(false); intent.latest_charge = null; intent.amount_received = 1; expect((await read()).body.canResume).toBe(false);
});
test("a retained chargeback or payment operation blocks opening the original form", async () => {
  await Operation.collection.insertOne({ caseId: matter._id, kind: "chargeback", administrativeStatus: "pending_review" }); const before = await records(); expect((await read()).body.canResume).toBe(false); expect(await records()).toEqual(before);
});
