const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const mongoose = require("mongoose");
const User = require("../models/User");
const Case = require("../models/Case");
const Notification = require("../models/Notification");
const WorkspacePresence = require("../models/WorkspacePresence");
const presence = require("../utils/workspacePresence");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { readReadyState } = require("./helpers/mongoHarnessState");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express();
app.use(cookieParser()); app.use(express.json());
app.use("/api/notifications", require("../routes/notifications"));
app.use("/api/messages", require("../routes/messages"));
app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
let attorney, paralegal, matter;
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const lease = (presenceId = randomUUID(), revision = 1) => ({ presenceId, revision });
const update = (method, user, body) => request(app)[method]("/api/notifications/workspace-presence").set("Cookie", cookie(user)).send(body);
const active = (surface = "messages") => presence.isWorkspacePresenceActive(attorney._id, matter._id, surface);

beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  const users = await Promise.all(["attorney", "paralegal"].map(role => User.create({ firstName: role, lastName: "Presence", email: `${role}-presence@example.com`, password: "Password123!", role, status: "approved", state: "CA" })));
  [attorney, paralegal] = users;
  matter = await Case.create({ title: "Presence Matter", practiceArea: "immigration", details: "Local presence acceptance", attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_local_presence", totalAmount: 40000, currency: "usd" });
});
afterEach(() => jest.restoreAllMocks());

async function otherProcess(action, value) {
  const script = `const mongoose = require(${JSON.stringify(require.resolve("mongoose"))}); const presence = require(${JSON.stringify(require.resolve("../utils/workspacePresence"))});
    (async()=>{ try { await mongoose.connect(process.argv[1], {dbName:process.argv[2],autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:5000});
      const result = process.argv[5] === 'mark' ? await presence.markWorkspacePresence(process.argv[3],process.argv[4],'messages',JSON.parse(process.argv[6])) : await presence.isWorkspacePresenceActive(process.argv[3],process.argv[4],'messages');
      process.stdout.write(JSON.stringify(result)); } finally { await mongoose.disconnect(); } })().catch(error=>{process.stderr.write(error.message);process.exitCode=1;});`;
  const result = await promisify(execFile)(process.execPath, ["--eval", script, readReadyState().uri, mongoose.connection.name, String(attorney._id), String(matter._id), action, JSON.stringify(value || {})], { timeout: 10000 });
  return JSON.parse(result.stdout);
}

test("presence is shared with another process and survives the writing process exiting", async () => {
  const first = lease();
  await presence.markWorkspacePresence(attorney._id, matter._id, "messages", first);
  expect(await otherProcess("read")).toBe(true);
  await presence.clearWorkspacePresence(attorney._id, matter._id, "messages", { ...first, revision: 2 });
  expect(await otherProcess("read")).toBe(false);
  expect(await otherProcess("mark", lease())).toBe(true);
  expect(await active()).toBe(true);
});

test("closing one of two tabs on Messages preserves the other tab and suppression", async () => {
  const first = lease(), second = lease(), body = { caseId: String(matter._id), surface: "messages" };
  expect((await update("post", attorney, { ...body, ...first })).status).toBe(200);
  expect((await update("post", attorney, { ...body, ...second })).status).toBe(200);
  expect((await update("delete", attorney, { ...body, ...first, revision: 2 })).status).toBe(200);
  expect(await active()).toBe(true);
  const sent = await request(app).post(`/api/messages/${matter._id}`).set("Cookie", cookie(paralegal)).send({ text: "Still visible in the second tab." });
  expect(sent.status).toBe(201);
  expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(0);
  await update("delete", attorney, { ...body, ...second, revision: 2 });
  expect(await active()).toBe(false);
});

test("a late heartbeat cannot restore a cleared tab or suppress its next message", async () => {
  const current = lease(), body = { caseId: String(matter._id), surface: "messages" };
  await update("post", attorney, { ...body, ...current });
  await update("delete", attorney, { ...body, ...current, revision: 3 });
  await update("post", attorney, { ...body, ...current, revision: 2 });
  expect(await active()).toBe(false);
  const sent = await request(app).post(`/api/messages/${matter._id}`).set("Cookie", cookie(paralegal)).send({ text: "Notify after both tabs have left." });
  expect(sent.status).toBe(201);
  expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(1);
  await update("post", attorney, { ...body, ...current, revision: 4 });
  await update("delete", attorney, { ...body, ...current, revision: 3 });
  expect(await active()).toBe(true);
});

test.each(["tasks", "history"])("viewing %s keeps message and file alerts eligible and clears its exact lease", async surface => {
  const current = lease(), body = { caseId: String(matter._id), surface, ...current };
  expect((await update("post", attorney, body)).status).toBe(200);
  expect(await active(surface)).toBe(true);
  expect(await active("messages")).toBe(false);
  expect(await active("files")).toBe(false);
  const sent = await request(app).post(`/api/messages/${matter._id}`).set("Cookie", cookie(paralegal)).send({ text: "A message outside the section being viewed." });
  expect(sent.status).toBe(201);
  expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(1);
  expect((await update("delete", attorney, { ...body, revision: 2 })).status).toBe(200);
  expect(await active(surface)).toBe(false);
});

test("simultaneous first writes retain the newest revision across a shared lease", async () => {
  const current = lease();
  await Promise.all(Array.from({ length: 12 }, (_, index) => presence.markWorkspacePresence(attorney._id, matter._id, index % 2 ? "files" : "messages", { ...current, revision: index + 1 })));
  expect(await WorkspacePresence.countDocuments({ userId: attorney._id })).toBe(1);
  expect((await WorkspacePresence.findOne({ userId: attorney._id }).lean()).revision).toBe(12);
  expect(await active("files")).toBe(true);
  expect(await active("messages")).toBe(false);
});

test("expiry is enforced before TTL cleanup and legacy clears cannot remove new tabs", async () => {
  const current = lease();
  await presence.markWorkspacePresence(attorney._id, matter._id, "messages", current);
  await presence.markWorkspacePresence(attorney._id, matter._id);
  expect(await active("files")).toBe(true);
  await presence.clearWorkspacePresence(attorney._id);
  expect(await active("messages")).toBe(true);
  expect(await active("files")).toBe(false);
  await WorkspacePresence.updateMany({ userId: attorney._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await active()).toBe(false);
  const indexes = await WorkspacePresence.collection.indexes();
  expect(indexes.find(index => index.key.expiresAt === 1 && Object.keys(index.key).length === 1)?.expireAfterSeconds).toBe(0);
});

test("invalid leases and unrelated accounts cannot create another user's presence", async () => {
  const body = { caseId: String(matter._id), surface: "messages" };
  for (const invalid of [{ presenceId: "short", revision: 1 }, { presenceId: randomUUID() }, { revision: 1 }, { ...lease(), revision: "1" }, { ...lease(), revision: 0 }]) {
    expect((await update("post", attorney, { ...body, ...invalid })).status).toBe(400);
    expect((await update("delete", attorney, { ...body, ...invalid })).status).toBe(400);
  }
  expect((await update("post", attorney, { ...body, ...lease(), caseId: "invalid" })).status).toBe(400);
  expect((await update("post", attorney, { ...body, ...lease(), expectedOwnerId: String(paralegal._id) })).status).toBe(403);
  expect((await update("post", attorney, { ...body, ...lease(), caseId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
  expect(await WorkspacePresence.countDocuments({})).toBe(0);
});

test("presence-store failures do not claim a successful heartbeat or suppress delivery", async () => {
  jest.spyOn(WorkspacePresence, "updateOne").mockRejectedValueOnce(new Error("Synthetic presence write failure"));
  const result = await update("post", attorney, { caseId: String(matter._id), surface: "messages", ...lease() });
  expect(result.status).toBe(500);
  expect(result.body.success).not.toBe(true);
  jest.spyOn(WorkspacePresence, "exists").mockRejectedValueOnce(new Error("Synthetic presence read failure"));
  const sent = await request(app).post(`/api/messages/${matter._id}`).set("Cookie", cookie(paralegal)).send({ text: "Do not suppress delivery when presence is unknown." });
  expect(sent.status).toBe(201);
  expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(1);
});
