const express = require("express"), request = require("supertest");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_delivery";
const mockStripe = { webhooks: { constructEvent: jest.fn() } }, mockAlert = jest.fn(async () => ({ ok: true }));
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: (...args) => mockAlert(...args) }));
const Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent"), { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use("/api/payments/webhook", require("../routes/paymentsWebhook"));
let event;
const send = () => request(app).post("/api/payments/webhook").set("Stripe-Signature", "synthetic-signature").set("Content-Type", "application/json").send("{}");
const current = () => Delivery.findOne({ eventId: event.id }).lean();
const gate = () => { let release, arrive; return { waiting: new Promise(resolve => { arrive = resolve; }), held: new Promise(resolve => { release = resolve; }), release: () => release(), arrive: () => arrive() }; };
beforeAll(async () => { await connect(); await Promise.all([Audit.init(), Delivery.init()]); }); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => { await clearDatabase(); jest.clearAllMocks(); event = { id: "evt_synthetic_delivery", type: "synthetic.delivery", livemode: false, data: { object: { id: "synthetic" } } }; mockStripe.webhooks.constructEvent.mockImplementation(() => event); });
test("an earlier delivery cannot mark its replacement attempt processed", async () => {
  const firstGate = gate(), secondGate = gate(), create = Audit.create.bind(Audit); let calls = 0;
  jest.spyOn(Audit, "create").mockImplementation(async value => { const selected = ++calls === 1 ? firstGate : secondGate; selected.arrive(); await selected.held; return create(value); });
  const first = send().then(value => value); let second;
  try {
    await firstGate.waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } }); second = send().then(value => value); await secondGate.waiting;
    firstGate.release(); expect((await first).status).toBe(500); expect(await current()).toMatchObject({ status: "processing", attempts: 2 });
  } finally { firstGate.release(); secondGate.release(); await first; if (second) await second; }
  expect(await current()).toMatchObject({ status: "processed", attempts: 2 }); expect(mockAlert).not.toHaveBeenCalled();
});
test("an earlier failing delivery cannot mark an active replacement attempt failed", async () => {
  const firstGate = gate(), secondGate = gate(), create = Audit.create.bind(Audit); let calls = 0;
  jest.spyOn(Audit, "create").mockImplementation(async value => { const first = ++calls === 1, selected = first ? firstGate : secondGate; selected.arrive(); await selected.held; if (first) throw new Error("Synthetic earlier worker failure"); return create(value); });
  const first = send().then(value => value); let second;
  try { await firstGate.waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } }); second = send().then(value => value); await secondGate.waiting; firstGate.release(); expect((await first).status).toBe(500); expect(await current()).toMatchObject({ status: "processing", attempts: 2 }); }
  finally { firstGate.release(); secondGate.release(); await first; if (second) await second; }
  expect(await current()).toMatchObject({ status: "processed", attempts: 2 }); expect(mockAlert).not.toHaveBeenCalled();
});
test("an earlier failure cannot reopen an already processed replacement delivery", async () => {
  const firstGate = gate(), create = Audit.create.bind(Audit); let calls = 0;
  jest.spyOn(Audit, "create").mockImplementation(async value => { if (++calls === 1) { firstGate.arrive(); await firstGate.held; throw new Error("Synthetic late failure"); } return create(value); });
  const first = send().then(value => value);
  try { await firstGate.waiting; await Delivery.updateOne({ eventId: event.id }, { $set: { lastAttemptAt: new Date(Date.now() - 660000) } }); expect((await send()).status).toBe(200); firstGate.release(); expect((await first).status).toBe(500); expect(await current()).toMatchObject({ status: "processed", attempts: 2 }); }
  finally { firstGate.release(); await first; }
  expect(mockAlert).not.toHaveBeenCalled();
});
test("an unacknowledged processed write is not reset to failed and its retry is deduped", async () => {
  const update = Delivery.updateOne.bind(Delivery); let interrupted = false;
  jest.spyOn(Delivery, "updateOne").mockImplementation(async (...args) => { const result = await update(...args); if (!interrupted && args[1].$set?.status === "processed") { interrupted = true; throw new Error("Synthetic lost database acknowledgement"); } return result; });
  expect((await send()).status).toBe(500); expect(await current()).toMatchObject({ status: "processed", attempts: 1 }); expect(mockAlert).not.toHaveBeenCalled();
  const retry = await send(); expect(retry.status).toBe(200); expect(retry.body.deduped).toBe(true); expect(await Audit.countDocuments()).toBe(1); expect((await current()).attempts).toBe(1);
});
test("a current failed delivery records its failure and a later retry retains normal recovery", async () => {
  jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic current failure")); expect((await send()).status).toBe(500); expect(await current()).toMatchObject({ status: "failed", attempts: 1, lastError: "Synthetic current failure" }); expect(mockAlert).toHaveBeenCalledTimes(1);
  expect((await send()).status).toBe(200); expect(await current()).toMatchObject({ status: "processed", attempts: 2, lastError: "" }); expect(await Audit.countDocuments()).toBe(1);
});
test("a fresh in-progress delivery excludes a competing handler and a processed delivery stays read-only", async () => {
  const waiting = gate(), create = Audit.create.bind(Audit); jest.spyOn(Audit, "create").mockImplementationOnce(async value => { waiting.arrive(); await waiting.held; return create(value); }); const first = send().then(value => value);
  try { await waiting.waiting; const competing = await send(); expect(competing.status).toBe(503); expect(competing.body.retryable).toBe(true); expect((await current()).attempts).toBe(1); }
  finally { waiting.release(); await first; }
  const before = await current(); expect((await send()).body.deduped).toBe(true); expect(await current()).toEqual(before); expect(await Audit.countDocuments()).toBe(1); expect(mockAlert).not.toHaveBeenCalled();
});
test("without the existing unique delivery index no event handler runs", async () => {
  await Delivery.collection.dropIndex("eventId_1");
  try { const value = await send(); expect(value.status).toBe(503); expect(value.body.retryable).toBe(true); expect(await Audit.countDocuments()).toBe(0); expect(await Delivery.countDocuments()).toBe(0); }
  finally { await Delivery.collection.createIndex({ eventId: 1 }, { unique: true }); }
});
test.each([{ id: "" }, { id: null }, { id: "not-an-event" }, { type: "" }, { type: null }])("a signed envelope with no usable delivery identity %j is not handled", async patch => { Object.assign(event, patch); expect((await send()).status).toBe(503); expect(await Audit.countDocuments()).toBe(0); expect(await Delivery.countDocuments()).toBe(0); });
