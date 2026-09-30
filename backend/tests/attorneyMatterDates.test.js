const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server"), { clearDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const User = require("../models/User"), Case = require("../models/Case"), Event = require("../models/Event"), AuditLog = require("../models/AuditLog");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/events", require("../routes/events"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, owner, other, para, matter;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("attorney-dates")); await Promise.all([User.init(), Case.init(), Event.init(), AuditLog.init()]); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@dates.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "River Street lease", details: "Review exhibits", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_dates", deadlineDate: new Date("2027-03-14T12:00:00Z") });
});
const read = (query = {}, user = owner) => request(app).get(`/api/events/matters/${matter._id}/review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(app).post(`/api/events/matters/${matter._id}/reviewed-action`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const values = { title: "Review hearing exhibits", start: "2027-03-14T16:00:00.000Z", end: "2027-03-14T17:00:00.000Z", isAllDay: false, type: "meeting", timezone: "America/New_York", where: "Conference room", notes: "Bring the original exhibits." };
async function command(action, event, changes = values, extras = {}) { const review = await read(); expect(review.status).toBe(200); return { requestId: crypto.randomUUID(), reviewedMatterRevision: review.body.revision, action, values: changes, ...(event ? { eventId: event.id, reviewedRevision: event.revision } : {}), ...extras }; }
const seed = extras => Event.create({ ...values, caseId: matter._id, owner: owner._id, ...extras });
test("equal-date paging exposes all 225 private calendar entries and exact older links", async () => {
  const entries = await Event.insertMany(Array.from({ length: 225 }, (_, index) => ({ ...values, title: `Exhibit meeting ${index}`, caseId: matter._id, owner: owner._id })));
  await seed({ owner: para._id, visibility: "case_team", title: "PRIVATE PARA ENTRY" });
  const ids = []; let cursor; do { const result = await read(cursor ? { cursor } : {}); expect(result.status).toBe(200); expect(result.body.total).toBe(225); expect(result.body.items.length).toBeLessThanOrEqual(50); ids.push(...result.body.items.map(entry => entry.id)); cursor = result.body.nextCursor; } while (cursor);
  expect(new Set(ids).size).toBe(225); const exact = await read({ eventId: String(entries.at(-1)._id) }); expect(exact.body.selectedEvent.id).toBe(String(entries.at(-1)._id)); expect(exact.body.items.some(entry => entry.id === String(entries.at(-1)._id))).toBe(false); expect(JSON.stringify(exact.body)).not.toContain("PRIVATE PARA ENTRY"); expect(exact.headers["cache-control"]).toBe("private, no-store");
});
test("date filters return actual counts without hiding older records from exact links", async () => {
  const earlier = await seed({ start: new Date("2026-01-01"), end: new Date("2026-01-01") }); await seed(); const result = await read({ from: values.start, to: values.end, eventId: String(earlier._id) }); expect(result.body.total).toBe(1); expect(result.body.items).toHaveLength(1); expect(result.body.selectedEvent.id).toBe(String(earlier._id));
  expect((await read({ from: "invalid" })).status).toBe(400); expect((await read({ from: values.end, to: values.start })).status).toBe(400); expect((await read({ cursor: "e30" })).status).toBe(400);
});
test("creating a calendar entry preserves the separate Matter deadline and existing readers", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), body = await command("create"), result = await send(body); expect(result.status).toBe(200); expect(result.body.operation).toMatchObject({ status: "recorded", action: "create", changedSinceSave: false });
  const stored = await Event.findById(result.body.operation.eventId).lean(); expect(stored.visibility).toBe("private"); expect(stored.timezone).toBe("America/New_York"); expect((await Case.collection.findOne({ _id: matter._id })).deadlineDate).toEqual(before.deadlineDate);
  const legacy = await request(app).get("/api/events").query({ caseId: String(matter._id), from: "2020-01-01", to: "2030-01-01" }).set("Cookie", cookie(owner)); expect(legacy.status).toBe(200); expect(legacy.body.items.map(entry => entry.id)).toContain(String(stored._id)); expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("a repeated create request uses its transaction audit and changed contents cannot reuse it", async () => {
  const body = await command("create"), first = await send(body), second = await send(body); expect(second.status).toBe(200); expect(second.body.operation.eventId).toBe(first.body.operation.eventId); expect(await Event.countDocuments()).toBe(1);
  const ack = await read({ requestId: body.requestId }); expect(ack.body.operation.status).toBe("recorded"); expect((await send({ ...body, values: { ...values, title: "Changed request" } })).status).toBe(409); expect(await AuditLog.countDocuments({ "meta.kind": "attorney_calendar_action" })).toBe(1);
});
test("unknown commit acknowledgement is recoverable without another create", async () => {
  const original = mongoose.startSession.bind(mongoose); jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await original(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost commit acknowledgement"); }; return session; });
  const body = await command("create"), result = await send(body); expect(result.status).toBe(503); expect((await read({ requestId: body.requestId })).body.operation.status).toBe("recorded"); expect(await Event.countDocuments()).toBe(1); expect((await send(body)).status).toBe(200); expect(await Event.countDocuments()).toBe(1);
});
test("partial updates preserve unknown metadata, original references and recorded calendar settings", async () => {
  const event = await seed({ visibility: "case_team", source: "system", color: "#123456", rrule: "FREQ=WEEKLY;BYDAY=MO", attendees: [{ email: "person@synthetic.test", response: "accepted" }], reminders: [{ minutesBefore: 30, method: "email" }] });
  await Event.collection.updateOne({ _id: event._id }, { $set: { owner: String(owner._id), caseId: String(matter._id), retainedUnknown: { preserve: true }, "attendees.0.unknownEvidence": "KEEP", "reminders.0.unknownEvidence": "KEEP" } });
  const before = await Event.collection.findOne({ _id: event._id }), selected = (await read()).body.items[0]; expect((await send(await command("update", selected, { title: "Revised hearing preparation" }))).status).toBe(200);
  const after = await Event.collection.findOne({ _id: event._id }); for (const key of Object.keys(before).filter(key => !["title", "updatedAt"].includes(key))) expect(after[key]).toEqual(before[key]);
});
test("attendee and reminder records retain prior nested metadata without sending invitations or reminders", async () => {
  const event = await seed({ attendees: [{ email: "first@synthetic.test", name: "First attendee", response: "accepted" }], reminders: [{ minutesBefore: 10, method: "none" }] }); await Event.collection.updateOne({ _id: event._id }, { $set: { "attendees.0.unknownEvidence": "KEEP", "reminders.0.unknownEvidence": "KEEP" } });
  const before = await Event.collection.findOne({ _id: event._id }); let selected = (await read()).body.items[0]; const attendee = { name: "Second attendee", email: "second@synthetic.test", role: "guest", response: "tentative", required: false };
  expect((await send(await command("attendee", selected, attendee))).status).toBe(200); selected = (await read()).body.items[0]; expect((await send(await command("attendee", selected, attendee))).status).toBe(200); selected = (await read()).body.items[0]; expect((await send(await command("reminder", selected, { minutesBefore: 60, method: "email" }))).status).toBe(200);
  const after = await Event.collection.findOne({ _id: event._id }); expect(after.attendees).toHaveLength(2); expect(after.attendees[0]).toEqual(before.attendees[0]); expect(after.reminders[0]).toEqual(before.reminders[0]); expect(after.reminders).toHaveLength(2); expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("a stale edit cannot overwrite another tab or a legacy writer", async () => {
  const event = await seed(), selected = (await read()).body.items[0], body = await command("update", selected, { notes: "Stale instruction" });
  const legacy = await request(app).patch(`/api/events/${event._id}`).set("Cookie", cookie(owner)).send({ notes: "Instruction from the existing screen" }); expect(legacy.status).toBe(200); expect((await send(body)).status).toBe(409); expect((await Event.findById(event._id)).notes).toBe("Instruction from the existing screen");
});
test("competing edits confirm only one result and retain its contents", async () => {
  await seed(); const selected = (await read()).body.items[0], first = await command("update", selected, { notes: "First edit" }), second = await command("update", selected, { notes: "Second edit" }); const results = await Promise.all([send(first), send(second)]); expect(results.map(value => value.status).sort()).toEqual([200, 409]); expect((await Event.findById(selected.id)).notes).toBe(results[0].status === 200 ? "First edit" : "Second edit");
});
test("deletion is recorded atomically and an earlier create cannot recreate a removed event", async () => {
  const create = await command("create"), made = await send(create), selected = made.body.operation.event, remove = await command("delete", selected, {}); expect((await send(remove)).status).toBe(200); expect(await Event.countDocuments()).toBe(0); expect((await read({ requestId: remove.requestId })).body.operation).toMatchObject({ status: "recorded", action: "delete", event: null, changedSinceSave: false });
  const recovered = await send(create); expect(recovered.body.operation).toMatchObject({ status: "recorded", event: null, changedSinceSave: true }); expect(await Event.countDocuments()).toBe(0); expect((await send(remove)).status).toBe(200);
});
test("fresh account and Matter access prevent foreign reads and writes", async () => {
  await seed(); const body = await command("create"); for (const user of [other, para]) { expect((await read({}, user)).status).toBe(403); expect((await send(body, user)).status).toBe(403); }
  expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403); await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); expect((await send(body)).status).toBe(403); expect(await Event.countDocuments()).toBe(1);
});
test("an account revoked before commit leaves no calendar entry or successful action record", async () => {
  const body = await command("create"), boundary = require("../services/attorneyAccountBoundary"), original = boundary.read; let calls = 0;
  jest.spyOn(boundary, "read").mockImplementation(async (...args) => { if (++calls === 4) await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return original(...args); });
  expect((await send(body)).status).toBe(403); expect(await Event.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ "meta.kind": "attorney_calendar_action" })).toBe(0);
});
test.each([{ title: "" }, { start: "invalid" }, { end: "2027-01-01T00:00:00.000Z" }, { timezone: "Not/AZone" }, { owner: "forged" }, { title: "x".repeat(501) }])("invalid creation %j cannot change the calendar", async change => {
  expect((await send(await command("create", null, { ...values, ...change }))).status).toBe(400); expect(await Event.countDocuments()).toBe(0);
});
test("transaction support is required and a failed transaction does not fall back to a partial save", async () => {
  const body = await command("create"); jest.spyOn(mongoose, "startSession").mockResolvedValue({ startTransaction() { throw new Error("Transactions unavailable"); }, inTransaction: () => false, endSession: async () => {} });
  expect((await send(body)).status).toBe(503); expect(await Event.countDocuments()).toBe(0); expect(await AuditLog.countDocuments({ "meta.kind": "attorney_calendar_action" })).toBe(0);
});
test("the paged owner/Matter/date/id index is present", async () => { expect((await Event.collection.indexes()).some(index => JSON.stringify(index.key) === JSON.stringify({ owner: 1, caseId: 1, start: 1, _id: 1 }))).toBe(true); });
test("calendar transactions wait for configured model initialization to finish", async () => {
  const body = await command("create"); let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), initializing = new Promise(resolve => { arrived = resolve; }), original = Event.init.bind(Event), session = jest.spyOn(mongoose, "startSession");
  jest.spyOn(Event, "init").mockImplementation(async (...args) => { arrived(); await gate; return original(...args); });
  const running = send(body).then(result => result);
  try { await initializing; expect(session).not.toHaveBeenCalled(); } finally { release(); }
  expect((await running).status).toBe(200); expect(session).toHaveBeenCalledTimes(1);
});
