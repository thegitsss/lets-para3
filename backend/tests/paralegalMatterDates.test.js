const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { clearDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const User = require("../models/User"), Case = require("../models/Case"), Event = require("../models/Event"), AuditLog = require("../models/AuditLog");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/events", require("../routes/events"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, server, owner, other, attorney, matter;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri("paralegal-dates"));
  await Promise.all([User.init(), Case.init(), Event.init(), AuditLog.init()]);
  // Keep one owned listener for the suite instead of opening and closing one per request.
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
}, 60000);
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await mongoose.disconnect(); await mongo?.stop();
});
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase();
  [owner, other, attorney] = await User.create(["owner", "other", "attorney"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@paralegal-dates.test`, password: "Synthetic123!", role: name === "attorney" ? "attorney" : "paralegal", status: "approved" })));
  matter = await Case.create({ title: "Private reminder review", details: "Prepare exhibits", attorney: attorney._id, attorneyId: attorney._id, paralegal: owner._id, paralegalId: owner._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_private_dates", totalAmount: 90000, deadlineDate: "2026-09-24" });
});
const read = (query = {}, user = owner) => request(server).get(`/api/events/paralegal/matters/${matter._id}/review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(server).post(`/api/events/paralegal/matters/${matter._id}/reviewed-action`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const values = { title: "Prepare final exhibits", start: "2026-09-23T12:00:00.000Z", end: "2026-09-23T12:00:00.000Z", type: "deadline", isAllDay: true, timezone: "America/New_York" };
const seed = extras => Event.create({ ...values, caseId: matter._id, owner: owner._id, visibility: "private", ...extras });
async function command(action = "create", event = null, changes = values) {
  const review = await read(); expect(review.status).toBe(200);
  return { action, values: changes, requestId: crypto.randomUUID(), reviewedMatterRevision: review.body.revision, ...(event ? { eventId: event.id, reviewedRevision: event.revision } : {}) };
}

test("all 225 equal-date reminders and exact older links retain owner, Matter and deadline scope", async () => {
  const entries = await Event.insertMany(Array.from({ length: 225 }, (_, index) => ({ ...values, title: `Retained reminder ${index + 1}`, caseId: matter._id, owner: owner._id })));
  await seed({ owner: attorney._id, title: "OTHER OWNER" }); await seed({ type: "meeting", title: "OTHER TYPE" }); await seed({ caseId: new mongoose.Types.ObjectId(), title: "OTHER MATTER" });
  const ids = []; let cursor;
  do { const response = await read(cursor ? { cursor } : {}); expect(response.status).toBe(200); expect(response.body.total).toBe(225); expect(response.body.items.length).toBeLessThanOrEqual(50); ids.push(...response.body.items.map(item => item.id)); cursor = response.body.nextCursor; } while (cursor);
  expect(new Set(ids).size).toBe(225);
  const exact = await read({ eventId: String(entries.at(-1)._id) }); expect(exact.body.selectedEvent.id).toBe(String(entries.at(-1)._id)); expect(exact.body.items.some(item => item.id === String(entries.at(-1)._id))).toBe(false);
  expect(JSON.stringify(exact.body)).not.toMatch(/OTHER OWNER|OTHER TYPE|OTHER MATTER/); expect(exact.headers["cache-control"]).toBe("private, no-store");
});

test("creation and its repeated acknowledgement preserve the shared deadline and financial record", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), body = await command(), first = await send(body), repeat = await send(body);
  expect(first.status).toBe(200); expect(repeat.status).toBe(200); expect(repeat.body.operation.eventId).toBe(first.body.operation.eventId); expect(await Event.countDocuments()).toBe(1);
  expect(first.body.operation).toMatchObject({ status: "recorded", action: "create", changedSinceSave: false });
  const after = await Case.collection.findOne({ _id: matter._id });
  for (const key of Object.keys(before).filter(key => !["__v", "updatedAt"].includes(key))) expect(after[key]).toEqual(before[key]);
  expect(await AuditLog.countDocuments({ actor: owner._id, actorRole: "paralegal", "meta.kind": "paralegal_calendar_action" })).toBe(1);
  expect((await read({ requestId: body.requestId })).body.operation.status).toBe("recorded");
  expect((await send({ ...body, values: { ...values, title: "Changed request" } })).status).toBe(409); expect(require("../utils/email")).not.toHaveBeenCalled();
});

test("a lost commit acknowledgement is recovered by a read without creating another reminder", async () => {
  const start = mongoose.startSession.bind(mongoose);
  jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost acknowledgement"); }; return session; });
  const body = await command(); expect((await send(body)).status).toBe(503);
  const recovered = await read({ requestId: body.requestId }); expect(recovered.status).toBe(200); expect(recovered.body.operation.status).toBe("recorded"); expect(await Event.countDocuments()).toBe(1);
  expect((await send(body)).status).toBe(200); expect(await Event.countDocuments()).toBe(1);
});

test("a failed audit record rolls back the reminder and the same request remains safely retryable", async () => {
  const body = await command(); const failure = jest.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
  expect((await send(body)).status).toBe(503); expect(await Event.countDocuments()).toBe(0); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("missing");
  failure.mockRestore(); expect((await send(body)).status).toBe(200); expect(await Event.countDocuments()).toBe(1);
});

test("competing edits preserve one reviewed result and untouched calendar metadata", async () => {
  const event = await seed({ notes: "Retain private notes", color: "#123456", rrule: "FREQ=WEEKLY" });
  const selected = (await read()).body.items[0], first = await command("update", selected, { title: "First edit" }), second = await command("update", selected, { title: "Second edit" });
  const results = await Promise.all([send(first), send(second)]); expect(results.map(value => value.status).sort()).toEqual([200, 409]);
  const saved = await Event.findById(event._id).lean(); expect(saved.title).toBe(results[0].status === 200 ? "First edit" : "Second edit"); expect(saved.notes).toBe("Retain private notes"); expect(saved.rrule).toBe("FREQ=WEEKLY"); expect(saved.color).toBe("#123456");
});

test("confirmed deletion and an older create receipt cannot recreate a removed reminder", async () => {
  const create = await command(), made = await send(create), remove = await command("delete", made.body.operation.event, {});
  expect((await send(remove)).status).toBe(200); expect((await send(remove)).status).toBe(200); expect(await Event.countDocuments()).toBe(0);
  expect((await read({ requestId: remove.requestId })).body.operation).toMatchObject({ status: "recorded", action: "delete", event: null, changedSinceSave: false });
  expect((await send(create)).body.operation).toMatchObject({ status: "recorded", event: null, changedSinceSave: true }); expect(await Event.countDocuments()).toBe(0);
});

test("account mismatch, other participants and expired credentials prevent private reads and writes", async () => {
  await seed(); const body = await command();
  for (const user of [attorney, other]) { expect((await read({}, user)).status).toBe(403); expect((await send(body, user)).status).toBe(403); }
  expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403); expect((await send({ ...body, expectedOwnerId: String(other._id) })).status).toBe(403);
  await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); expect((await send(body)).status).toBe(403); expect(await Event.countDocuments()).toBe(1);
});

test.each([{ paralegalAccessRevokedAt: new Date() }, { status: "completed" }, { paymentReleased: true }, { paralegal: null, paralegalId: null }])("revoked or closed assignment %j clears private access", async change => {
  await seed(); const body = await command(); await Case.collection.updateOne({ _id: matter._id }, { $set: change });
  expect((await read()).status).toBe(403); expect((await send(body)).status).toBe(403); expect(await Event.countDocuments()).toBe(1);
});

test("read-only assignments retain permitted reads but cannot create, edit or delete", async () => {
  await seed(); const selected = (await read()).body.items[0], body = await command();
  await Case.collection.updateOne({ _id: matter._id }, { $set: { readOnly: true } }); expect((await read()).status).toBe(200);
  for (const value of [body, await command("update", selected, { title: "Not writable" }), await command("delete", selected, {})]) expect((await send(value)).status).toBe(409);
  expect(await Event.countDocuments()).toBe(1);
});

test.each([{ type: "meeting" }, { isAllDay: false }, { owner: "forged" }, { title: "" }, { start: "invalid" }, { timezone: "Not/AZone" }])("invalid reminder creation %j performs no write", async change => {
  expect((await send(await command("create", null, { ...values, ...change }))).status).toBe(400); expect(await Event.countDocuments()).toBe(0);
});

test("transaction support is required and an unavailable transaction never falls back to a partial save", async () => {
  const body = await command(); jest.spyOn(mongoose, "startSession").mockResolvedValue({ startTransaction() { throw new Error("Transactions unavailable"); }, inTransaction: () => false, endSession: async () => {} });
  expect((await send(body)).status).toBe(503); expect(await Event.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ "meta.kind": "paralegal_calendar_action" })).toBe(0);
});

test("revocation while a reminder transaction is open prevents both the reminder and its action receipt", async () => {
  const body = await command(), update = Case.collection.updateOne.bind(Case.collection);
  let revoked = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, change, options) => {
    if (!revoked && options?.session) {
      revoked = true;
      await update({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });
    }
    return update(filter, change, options);
  });
  expect((await send(body)).status).toBe(409); expect(revoked).toBe(true);
  expect(await Event.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ "meta.kind": "paralegal_calendar_action" })).toBe(0);
  expect((await read()).status).toBe(403);
});

test("an account role change during a reviewed request rolls back the reminder before confirmation", async () => {
  const body = await command(), boundary = require("../services/financialAccountBoundary"), original = boundary.read;
  let calls = 0;
  jest.spyOn(boundary, "read").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (++calls === 3) await User.collection.updateOne({ _id: owner._id }, { $set: { role: "attorney" } });
    return value;
  });
  expect((await send(body)).status).toBe(403); expect(calls).toBeGreaterThanOrEqual(3);
  expect(await Event.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ "meta.kind": "paralegal_calendar_action" })).toBe(0);
});
