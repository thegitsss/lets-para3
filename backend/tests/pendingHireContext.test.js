process.env.STRIPE_SECRET_KEY = "sk_test_pending_hire_synthetic";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({})));
jest.mock("../utils/stripe", () => ({ customers: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() }, paymentMethods: { retrieve: jest.fn(), attach: jest.fn() }, setupIntents: { create: jest.fn(), retrieve: jest.fn() }, stripeIdempotencyKey: jest.fn((...parts) => parts.join("_")) }));
const User = require("../models/User"), Case = require("../models/Case"), Block = require("../models/Block"), stripe = require("../utils/stripe");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/users", require("../routes/users")); app.use("/api/payments", require("../routes/payments"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@payment-setup.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Synthetic selected application", details: "Payment-setup return verification", attorney: owner._id, attorneyId: owner._id, totalAmount: 40001, tasks: [{ title: "Prepare exhibits" }], applicants: [{ paralegalId: para._id, status: "pending" }] });
  stripe.customers.create.mockResolvedValue({ id: "cus_synthetic", object: "customer", livemode: false }); stripe.customers.retrieve.mockResolvedValue({ id: "cus_synthetic", object: "customer", livemode: false, invoice_settings: { default_payment_method: "pm_synthetic" } }); stripe.customers.update.mockResolvedValue({ id: "cus_synthetic", object: "customer", livemode: false, invoice_settings: { default_payment_method: "pm_synthetic" } });
  stripe.paymentMethods.retrieve.mockResolvedValue({ id: "pm_synthetic", object: "payment_method", livemode: false, type: "card", customer: "cus_synthetic", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } });
  stripe.setupIntents.retrieve.mockResolvedValue({ id: "seti_synthetic", object: "setup_intent", livemode: false, status: "succeeded", customer: "cus_synthetic", metadata: { userId: String(owner._id) }, payment_method: "pm_synthetic" });
  stripe.setupIntents.create.mockResolvedValue({ id: "seti_synthetic", object: "setup_intent", livemode: false, status: "requires_payment_method", customer: "cus_synthetic", metadata: { userId: String(owner._id) }, client_secret: "seti_synthetic_secret_synthetic" });
});
afterEach(() => jest.restoreAllMocks());
const read = () => request(app).get(`/api/users/me/pending-hire?expectedOwnerId=${owner._id}`).set("Cookie", cookie(owner));
const save = revision => request(app).put("/api/users/me/pending-hire").set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), reviewedRevision: revision, caseId: String(matter._id), paralegalId: String(para._id) });
const clear = revision => request(app).delete("/api/users/me/pending-hire").set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), reviewedRevision: revision });
test("empty hiring return is a verified read without a write or provider request", async () => {
  const before = await User.collection.findOne({ _id: owner._id }), response = await read(); expect(response.status).toBe(200); expect(response.body).toMatchObject({ ownerId: String(owner._id), pending: null }); expect(response.body.revision).toMatch(/^[a-f0-9]{64}$/); expect(await User.collection.findOne({ _id: owner._id })).toEqual(before); expect(stripe.customers.create).not.toHaveBeenCalled();
});
test("saving records the exact application and generates its local return address", async () => {
  const first = await read(); expect((await save(first.body.revision)).status).toBe(200);
  const next = await read(); expect(next.status).toBe(200); expect(next.body.pending).toMatchObject({ state: "available", caseId: String(matter._id), paralegalId: String(para._id), caseTitle: matter.title, paralegalName: "Synthetic para" });
  const stored = await User.collection.findOne({ _id: owner._id }); expect(stored.pendingHire.fundUrl).toBe(`/attorney-v2.html#/matters/${matter._id}/applications?applicantId=${para._id}`); expect(stripe.customers.create).not.toHaveBeenCalled();
  expect((await clear(next.body.revision)).status).toBe(200); expect((await read()).body.pending).toBeNull();
});
test("an older tab cannot replace or clear a newer hiring return", async () => {
  const first = await read(); expect((await save(first.body.revision)).status).toBe(200); const stored = await User.collection.findOne({ _id: owner._id });
  expect((await save(first.body.revision)).status).toBe(409); expect((await clear(first.body.revision)).status).toBe(409); expect(await User.collection.findOne({ _id: owner._id })).toEqual(stored);
});
test("a change after final account verification prevents stale context persistence", async () => {
  const first = await read(), original = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, "updateOne").mockImplementationOnce(async (...args) => { await original({ _id: owner._id }, { $set: { pendingHire: { caseId: matter._id, paralegalName: "Newer saved context", updatedAt: new Date() } } }); return original(...args); });
  expect((await save(first.body.revision)).status).toBe(409); expect((await User.collection.findOne({ _id: owner._id })).pendingHire.paralegalName).toBe("Newer saved context");
});
test("earlier return addresses cannot become external or inferred candidate links", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { pendingHire: { caseId: matter._id, paralegalName: "Unverified name", fundUrl: "https://outside.example/private", retainedEvidence: "Keep this" } } });
  const first = await read(); expect(first.status).toBe(200); expect(first.body.pending).toMatchObject({ state: "earlier", paralegalId: null }); expect(JSON.stringify(first.body)).not.toContain("outside.example"); expect(JSON.stringify(first.body)).not.toContain("Unverified name");
  expect((await save(first.body.revision)).status).toBe(200); expect((await User.collection.findOne({ _id: owner._id })).pendingHire.retainedEvidence).toBe("Keep this");
});
test.each(["rejected", "blocked", "profile", "assigned", "closed", "foreign"])("%s application cannot be saved as a hiring return", async kind => {
  const first = await read();
  if (kind === "rejected") await Case.collection.updateOne({ _id: matter._id }, { $set: { "applicants.0.status": "rejected" } });
  if (kind === "blocked") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  if (kind === "profile") await User.collection.updateOne({ _id: para._id }, { $set: { disabled: true } });
  if (kind === "assigned") await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegalId: para._id } });
  if (kind === "closed") await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "closed" } });
  if (kind === "foreign") await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: other._id, attorneyId: other._id } });
  expect([404, 409]).toContain((await save(first.body.revision)).status); expect((await read()).body.pending).toBeNull();
});
test("saved context becomes unavailable when its application is removed", async () => {
  const first = await read(); await save(first.body.revision); await Case.collection.updateOne({ _id: matter._id }, { $set: { applicants: [] } }); const current = await read(); expect(current.status).toBe(200); expect(current.body.pending.state).toBe("unavailable"); expect((await clear(current.body.revision)).status).toBe(200);
});
test("changed account and token version cannot read or change the hiring return", async () => {
  expect((await request(app).get(`/api/users/me/pending-hire?expectedOwnerId=${other._id}`).set("Cookie", cookie(owner))).status).toBe(403);
  await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); expect([401, 403]).toContain((await read()).status);
});
const payment = () => request(app).get(`/api/payments/payment-method/default?expectedOwnerId=${owner._id}`).set("Cookie", cookie(owner));
test("failed provider card reads are unavailable rather than no saved card", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } }); stripe.paymentMethods.retrieve.mockRejectedValueOnce(new Error("Synthetic processor unavailable"));
  const response = await payment(); expect(response.status).toBe(502); expect(response.body.hasDefault).toBeUndefined();
});
test("a card read cannot return a card from an account reference changed during the request", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } }); stripe.paymentMethods.retrieve.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_new" } }); return { id: "pm_synthetic", type: "card", card: { last4: "4242" } }; });
  expect((await payment()).status).toBe(409);
});
test("invalid setup idempotency cannot create a customer; a valid key binds setup to the owner", async () => {
  const call = key => request(app).post("/api/payments/payment-method/setup-intent").set("Cookie", cookie(owner)).set("Idempotency-Key", key).send({ expectedOwnerId: String(owner._id) });
  expect((await call("invalid")).status).toBe(400); expect(stripe.customers.create).not.toHaveBeenCalled();
  const key = "00000000-0000-4000-8000-000000000000"; const response = await call(key); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store"); expect(stripe.setupIntents.create.mock.calls[0][0]).toMatchObject({ customer: "cus_synthetic", usage: "off_session", metadata: { userId: String(owner._id) } }); expect(stripe.setupIntents.create.mock.calls[0][1].idempotencyKey).toContain(key);
});
test("another customer's card is never attached or made the default", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } }); stripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: "pm_foreign", type: "card", customer: "cus_foreign" });
  const response = await request(app).post("/api/payments/payment-method/default").set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), paymentMethodId: "pm_foreign", intentId: "seti_synthetic" }); expect(response.status).toBe(409); expect(stripe.paymentMethods.attach).not.toHaveBeenCalled(); expect(stripe.customers.update).not.toHaveBeenCalled();
});
test("account revocation during card lookup prevents setting a default", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } }); stripe.paymentMethods.retrieve.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return { id: "pm_synthetic", type: "card", customer: "cus_synthetic" }; });
  const response = await request(app).post("/api/payments/payment-method/default").set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), paymentMethodId: "pm_synthetic", intentId: "seti_synthetic" }); expect(response.status).toBe(403); expect(stripe.customers.update).not.toHaveBeenCalled();
});
const setupReturn = () => request(app).get(`/api/payments/payment-method/setup-intent/seti_synthetic?expectedOwnerId=${owner._id}`).set("Cookie", cookie(owner));
test("setup returns verify the owner, customer and attached card without exposing the client secret", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } });
  stripe.setupIntents.retrieve.mockResolvedValueOnce({ id: "seti_synthetic", object: "setup_intent", livemode: false, status: "succeeded", customer: "cus_synthetic", metadata: { userId: String(owner._id) }, payment_method: "pm_synthetic", client_secret: "must-not-return" });
  const value = await setupReturn(); expect(value.status).toBe(200); expect(value.body).toMatchObject({ ownerId: String(owner._id), intentId: "seti_synthetic", status: "succeeded", paymentMethod: { id: "pm_synthetic", last4: "4242" } }); expect(JSON.stringify(value.body)).not.toContain("must-not-return"); expect(stripe.customers.update).not.toHaveBeenCalled();
});
test.each(["owner", "customer", "card", "incomplete"])("%s mismatch cannot set a card as default from a setup return", async kind => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } });
  if (kind === "card") stripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: "pm_synthetic", type: "card", customer: "cus_foreign" });
  else stripe.setupIntents.retrieve.mockResolvedValueOnce({ id: "seti_synthetic", status: kind === "incomplete" ? "processing" : "succeeded", customer: kind === "customer" ? "cus_foreign" : "cus_synthetic", metadata: { userId: String(kind === "owner" ? other._id : owner._id) }, payment_method: "pm_synthetic" });
  const value = await request(app).post("/api/payments/payment-method/default").set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), paymentMethodId: "pm_synthetic", intentId: "seti_synthetic" }); expect(value.status).toBe(409); expect(stripe.customers.update).not.toHaveBeenCalled();
});
test("verified setup can become the default without changing saved application context", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } }); const first = await read(); await save(first.body.revision);
  const value = await request(app).post("/api/payments/payment-method/default").set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), paymentMethodId: "pm_synthetic", intentId: "seti_synthetic" }); expect(value.status).toBe(200); expect(stripe.customers.update).toHaveBeenCalledWith("cus_synthetic", { invoice_settings: { default_payment_method: "pm_synthetic" } }, { timeout: 10000, maxNetworkRetries: 0 }); expect((await read()).body.pending.paralegalId).toBe(String(para._id));
});
test("a removed provider customer is unavailable rather than an empty saved-card state", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic" } }); stripe.customers.retrieve.mockResolvedValueOnce({ id: "cus_synthetic", deleted: true }); const value = await payment(); expect(value.status).toBe(502); expect(value.body.hasDefault).toBeUndefined();
});
