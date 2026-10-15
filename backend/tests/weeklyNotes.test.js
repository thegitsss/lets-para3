const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { execFileSync } = require("child_process");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
const User = require("../models/User");
const WeeklyNote = require("../models/WeeklyNote");
const { legacyStorageWeek } = require("../services/weeklyNotes");
const { readReadyState } = require("./helpers/mongoHarnessState");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use("/api/users", require("../routes/users"));
const weekStart = "2026-08-31";
const blank = () => Array(7).fill("");
const call = (method, user, body, week = weekStart) => request(app)[method](`/api/users/me/weekly-notes${method === "get" ? `?weekStart=${encodeURIComponent(week)}` : ""}`).set("Cookie", authCookieFor(user)).send(body);
let owner;
beforeAll(async () => { await connect(); await WeeklyNote.init(); });
beforeEach(async () => { await clearDatabase(); owner = await User.create({ firstName: "Notes", lastName: "Owner", email: "notes-owner@example.invalid", password: "Synthetic123!", role: "attorney", status: "approved", state: "NY" }); });
afterAll(closeDatabase);

test("weekly note paragraphs survive retained-record reads and an explicit versioned save", async () => {
  const notes = ["Prepare the scope.\n\nReview the references.", ...blank().slice(1)];
  const inserted = await WeeklyNote.collection.insertOne({ userId: owner._id, weekStart: legacyStorageWeek(weekStart), notes, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02') });
  const before = await WeeklyNote.collection.findOne({ _id: inserted.insertedId });
  const initial = await call('get', owner); expect(initial.status).toBe(200); expect(initial.body.notes).toEqual(notes);
  expect(await WeeklyNote.collection.findOne({ _id: inserted.insertedId })).toEqual(before);
  notes[1] = 'Keep the original labels.\n\nConfirm missing references.';
  const saved = await call('put', owner, { weekStart, notes, revision: initial.body.revision });
  expect(saved.status).toBe(200); expect(saved.body.notes).toEqual(notes);
  expect((await call('get', owner)).body.notes).toEqual(notes);
  expect((await WeeklyNote.collection.findOne({ _id: inserted.insertedId })).notes).toEqual(notes);
});

test("legacy rows retain their ID, physical date and day positions; only an explicit save adds a logical week", async () => {
  const notes = ["Monday legacy", "Tuesday legacy", "", "", "", "", "Sunday legacy"];
  const result = await WeeklyNote.collection.insertOne({ userId: owner._id, weekStart: legacyStorageWeek(weekStart), notes, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02") });
  const before = await WeeklyNote.findById(result.insertedId).lean();
  const read = await call("get", owner);
  expect(read.status).toBe(200); expect(read.body.weekStart).toBe(weekStart); expect(read.body.notes).toEqual(notes); expect(read.headers["cache-control"]).toBe("no-store");
  expect(await WeeklyNote.findById(result.insertedId).lean()).toEqual(before);
  notes[2] = "Wednesday new";
  const saved = await call("put", owner, { weekStart, notes, revision: read.body.revision });
  expect(saved.status).toBe(200); expect(saved.body.notes).toEqual(notes); expect(saved.body.revision).not.toBe(read.body.revision);
  const after = await WeeklyNote.findById(result.insertedId).lean();
  expect(after.weekStart).toEqual(before.weekStart); expect(after.calendarWeek).toBe(weekStart); expect(after.revision).toBe(1); expect(await WeeklyNote.countDocuments()).toBe(1);
  expect((await call("get", owner)).body).toEqual(saved.body);
});

test.each([false, true])("atomic saves reject one of two simultaneous writers (existing=%s)", async (existing) => {
  let initial = await call("get", owner);
  expect(initial.status).toBe(200);
  if (existing) {
    initial = await call("put", owner, { weekStart, notes: blank(), revision: initial.body.revision });
    expect({ status: initial.status, body: initial.body }).toEqual({ status: 200, body: expect.objectContaining({ revision: expect.any(String) }) });
  }
  const attempts = await Promise.all(["First writer", "Second writer"].map((text) => call("put", owner, { weekStart, notes: [text, ...blank().slice(1)], revision: initial.body.revision })));
  expect(attempts.map((res) => res.status).sort()).toEqual([200, 409]);
  expect(attempts.find((res) => res.status === 409).body.code).toBe("weekly_notes_changed");
  expect((await call("get", owner)).body.notes).toEqual(attempts.find((res) => res.status === 200).body.notes);
  expect(await WeeklyNote.countDocuments()).toBe(1);
});

test("unversioned and stale writes fail without replacing a saved note", async () => {
  const initial = await call("get", owner);
  expect((await call("put", owner, { weekStart, notes: blank() })).status).toBe(428);
  expect(await WeeklyNote.countDocuments()).toBe(0);
  const notes = ["Keep me", ...blank().slice(1)];
  const saved = await call("put", owner, { weekStart, notes, revision: initial.body.revision });
  expect(saved.status).toBe(200);
  expect((await call("put", owner, { weekStart, notes: blank(), revision: initial.body.revision })).status).toBe(409);
  expect((await call("get", owner)).body.notes).toEqual(notes);
});

test("owner isolation applies to both stored and empty revision tokens and disabled accounts lose access", async () => {
  const other = await User.create({ firstName: "Other", lastName: "Owner", email: "notes-other@example.invalid", password: "Synthetic123!", role: "paralegal", status: "approved", state: "NY" });
  const initial = await call("get", owner);
  expect((await call("put", other, { weekStart, notes: blank(), revision: initial.body.revision })).status).toBe(409);
  const saved = await call("put", owner, { weekStart, notes: ["Private", ...blank().slice(1)], revision: initial.body.revision });
  expect((await call("get", other)).body.notes).toEqual(blank());
  expect((await call("put", other, { weekStart, notes: blank(), revision: saved.body.revision })).status).toBe(409);
  const own = await call("get", other);
  expect((await call("put", other, { weekStart, notes: ["Other private", ...blank().slice(1)], revision: own.body.revision })).status).toBe(200);
  expect((await call("get", owner)).body.notes[0]).toBe("Private");
  await User.updateOne({ _id: owner._id }, { $set: { disabled: true } });
  expect([401, 403]).toContain((await call("get", owner)).status);
  expect([401, 403]).toContain((await call("put", owner, { weekStart, notes: blank(), revision: saved.body.revision })).status);
});

test("invalid calendar weeks and malformed notes are rejected before database changes", async () => {
  for (const week of ["2026-02-30", "2026-09-01", "2026-08-31T00:00:00Z", "invalid", ""]) expect((await call("get", owner, undefined, week)).status).toBe(400);
  for (const notes of [[], ["short"], Array(7).fill({ text: "bad" }), Array(7).fill("x".repeat(2001))]) expect((await call("put", owner, { weekStart, notes, revision: "bad" })).status).toBe(400);
  expect(await WeeklyNote.countDocuments()).toBe(0);
});

test("an ambiguous physical key is held for review instead of returning a different tagged week", async () => {
  await WeeklyNote.create({ userId: owner._id, weekStart: legacyStorageWeek(weekStart), calendarWeek: "2026-08-24", notes: ["Different logical week", ...blank().slice(1)] });
  const res = await call("get", owner);
  expect(res.status).toBe(409); expect(res.body.code).toBe("week_mapping_conflict"); expect(JSON.stringify(res.body)).not.toContain("Different logical week");
});

test("a New York legacy row gains its intended label on save and tagged reads survive different runtime timezones", async () => {
  const physical = new Date("2026-08-24T04:00:00.000Z");
  const inserted = await WeeklyNote.collection.insertOne({ userId: owner._id, weekStart: physical, notes: ["Legacy Monday in New York", "", "", "", "", "", "Legacy Sunday"], createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"), unrelatedLegacyField: "preserve" });
  for (const timezone of ["America/New_York", "UTC", "Pacific/Honolulu", "Pacific/Kiritimati"]) {
    const program = `const assert=require('node:assert/strict'); const mongoose=require('mongoose'); const {readWeeklyNotes,saveWeeklyNotes}=require('./services/weeklyNotes'); (async()=>{ await mongoose.connect(process.env.WEEKLY_TEST_MONGO_URI,{dbName:'jest',serverSelectionTimeoutMS:5000}); const read=await readWeeklyNotes(${JSON.stringify(String(owner._id))},'2026-08-31'); assert.equal(read.weekStart,'2026-08-31'); assert.equal(read.notes[0],'Legacy Monday in New York'); assert.equal(read.notes[6],'Legacy Sunday'); if(process.env.TZ==='America/New_York') await saveWeeklyNotes(${JSON.stringify(String(owner._id))},{...read,weekStart:'2026-08-31'}); await mongoose.disconnect(); })().catch(error=>{console.error(error);process.exit(1);});`;
    execFileSync(process.execPath, ["-e", program], { cwd: require("path").resolve(__dirname, ".."), env: { ...process.env, TZ: timezone, WEEKLY_TEST_MONGO_URI: readReadyState().uri }, stdio: "pipe", timeout: 15000 });
  }
  const after = await WeeklyNote.collection.findOne({ _id: inserted.insertedId });
  expect(after.weekStart).toEqual(physical); expect(after.calendarWeek).toBe(weekStart); expect(after.unrelatedLegacyField).toBe("preserve"); expect(await WeeklyNote.countDocuments()).toBe(1);
});

test.each(["UTC", "America/New_York", "Pacific/Honolulu", "Pacific/Kiritimati"])("calendar labels and compatibility lookup preserve their separate meanings in %s", (timezone) => {
  execFileSync(process.execPath, ["-e", `const assert=require('node:assert/strict'); const {calendarWeek,legacyStorageWeek}=require(${JSON.stringify(require.resolve("../services/weeklyNotes"))}); for(const key of ['2026-08-31','2026-03-02','2026-03-09','2026-10-26','2026-11-02','2025-12-29','2024-02-26']) { assert.equal(calendarWeek(key),key); const previous=new Date(key); previous.setDate(previous.getDate()-(previous.getDay()+6)%7); previous.setHours(0,0,0,0); assert.equal(legacyStorageWeek(key).getTime(),previous.getTime()); } assert.throws(()=>calendarWeek('2026-02-30'));`], { env: { ...process.env, TZ: timezone }, stdio: "pipe" });
});
