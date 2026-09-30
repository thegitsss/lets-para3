const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");
const { promisify } = require("util");
const execFile = promisify(require("child_process").execFile);
const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentNotification = require("../models/IncidentNotification");
const Notification = require("../models/Notification");
const { LpcEvent } = require("../models/LpcEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/incidents", require("../routes/incidents"));
// Match the application's generic final error handler; the route itself must
// preserve known ownership, validation, conflict and retry responses.
app.use((_error, _req, res, _next) => res.status(500).send("Server error"));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, status: user.status, email: user.email }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const send = (user, input) => request(app).post("/api/incidents").set("Cookie", cookie(user)).send(input);
const payload = user => ({ requestId: crypto.randomUUID(), reporterId: String(user._id), summary: "Files stopped responding", description: "The upload did not finish after I selected a PDF.", routePath: "/paralegal-v2.html", featureKey: "help", diagnostics: { browser: "test", viewport: { width: 390, height: 844 } } });
let reporter;
// Cold replica-set collection/index preparation may overlap other local
// browser projects. Keep this setup budget separate from 30s test cases.
beforeAll(connect, 90000);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); reporter = await User.create({ firstName: "Pat", lastName: "Reporter", email: "help-idempotency@example.test", password: "Password123!", role: "paralegal", status: "approved", state: "CA" }); });
afterEach(() => jest.restoreAllMocks());
async function counts(expected = 1) {
  expect(await Incident.countDocuments()).toBe(expected);
  expect(await IncidentArtifact.countDocuments()).toBe(expected * 2);
  expect(await IncidentEvent.countDocuments()).toBe(expected);
  expect(await IncidentNotification.countDocuments()).toBe(expected);
  expect(await Notification.countDocuments()).toBe(expected);
  expect(await LpcEvent.countDocuments({ eventType: "incident.created" })).toBe(expected);
}

test("lost response replay returns the original reference and token with exactly one complete intake", async () => {
  const input = payload(reporter), first = await send(reporter, input), replay = await send(reporter, input);
  expect(first.status).toBe(201); expect(replay.status).toBe(200);
  expect(replay.body.incident.publicId).toBe(first.body.incident.publicId);
  expect(replay.body.reporterAccessToken).toBe(first.body.reporterAccessToken);
  expect(replay.body.idempotent).toBe(true); await counts();
  const raw = await Incident.collection.findOne({ publicId: first.body.incident.publicId });
  expect(JSON.stringify(raw)).not.toContain(first.body.reporterAccessToken);
  expect(raw.intakeRequest.encryptedAccessToken).toMatch(/^enc:v1:/);
  expect((await request(app).get(`/api/incidents/${first.body.incident.publicId}`).set("x-incident-access-token", replay.body.reporterAccessToken)).status).toBe(200);
  expect(JSON.stringify(replay.body)).not.toMatch(/fingerprint|encryptedAccessToken|accessTokenHash/);
});

test("concurrent retries converge on the same committed intake", async () => {
  const input = payload(reporter);
  const responses = await Promise.all(Array.from({ length: 6 }, () => send(reporter, input)));
  expect(responses.filter(value => value.status === 201)).toHaveLength(1);
  expect(responses.every(value => [200, 201, 409, 503].includes(value.status))).toBe(true);
  const replay = await send(reporter, input); expect(replay.status).toBe(200);
  for (const response of responses.filter(value => [200, 201].includes(value.status))) expect(response.body.reporterAccessToken).toBe(replay.body.reporterAccessToken);
  await counts();
});

test("expected owner rejects a switched account before writes and keys are scoped to the authenticated reporter", async () => {
  const other = await User.create({ firstName: "Alex", lastName: "Reporter", email: "other-help@example.test", password: "Password123!", role: "attorney", status: "approved", state: "CA" });
  const input = payload(reporter);
  expect((await send(other, input)).status).toBe(403); await counts(0);
  const one = await send(reporter, input), two = await send(other, { ...input, reporterId: String(other._id) });
  expect(one.status).toBe(201); expect(two.status).toBe(201);
  expect(one.body.incident.publicId).not.toBe(two.body.incident.publicId);
  expect(one.body.reporterAccessToken).not.toBe(two.body.reporterAccessToken); await counts(2);
});

test.each([
  { requestId: "not-a-uuid" }, { requestId: "" }, { reporterId: "" }, { reporterId: "invalid" },
])("rejects malformed or incomplete keyed contract %j", async patch => {
  expect((await send(reporter, { ...payload(reporter), ...patch })).status).toBe(400); await counts(0);
});

test("same key rejects changed content while equivalent nested diagnostic key ordering replays", async () => {
  const input = payload(reporter); expect((await send(reporter, input)).status).toBe(201);
  for (const patch of [{ description: "Different report" }, { routePath: "/other" }, { diagnostics: { browser: "different" } }]) expect((await send(reporter, { ...input, ...patch })).status).toBe(409);
  const replay = await send(reporter, { ...input, diagnostics: { viewport: { height: 844, width: 390 }, browser: "test" } });
  expect(replay.status).toBe(200); await counts();
});

test.each([
  ["incident", Incident, "create"],
  ["artifacts", IncidentArtifact, "insertMany"], ["initial event", IncidentEvent, "create"],
  ["app receipt", Notification, "create"], ["incident receipt", IncidentNotification, "create"],
  ["LPC event", LpcEvent, "create"],
])("failure writing %s rolls back all core records and the same key succeeds afterward", async (_label, Model, method) => {
  const input = payload(reporter), failure = jest.spyOn(Model, method).mockRejectedValueOnce(new Error("Synthetic core write failure"));
  expect((await send(reporter, input)).status).toBe(503); await counts(0); failure.mockRestore();
  expect((await send(reporter, input)).status).toBe(201); await counts();
});

test("a failed transaction commit leaves no partial records and retry recovers", async () => {
  const original = mongoose.startSession.bind(mongoose), input = payload(reporter);
  const spy = jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => {
    const session = await original(...args); session.commitTransaction = async () => { throw new Error("Synthetic interrupted commit"); }; return session;
  });
  expect((await send(reporter, input)).status).toBe(503); await counts(0); spy.mockRestore();
  expect((await send(reporter, input)).status).toBe(201); await counts();
});

test("unknown commit acknowledgement keeps committed records and replay recovers original reporter access", async () => {
  const original = mongoose.startSession.bind(mongoose), input = payload(reporter);
  const spy = jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => {
    const session = await original(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost commit acknowledgement"); }; return session;
  });
  expect((await send(reporter, input)).status).toBe(503); await counts(); spy.mockRestore();
  const prior = await Incident.findOne().lean(), replay = await send(reporter, input);
  expect(replay.status).toBe(200); expect(replay.body.incident.publicId).toBe(prior.publicId);
  expect((await request(app).get(`/api/incidents/${prior.publicId}`).set("x-incident-access-token", replay.body.reporterAccessToken)).status).toBe(200);
  await counts();
});

test("missing required unique index fails closed before creating an intake", async () => {
  const index = (await Incident.collection.indexes()).find(value => value.key["intakeRequest.requestId"]);
  expect(index).toBeDefined(); await Incident.collection.dropIndex(index.name);
  try { expect((await send(reporter, payload(reporter))).status).toBe(503); await counts(0); }
  finally { await Incident.createIndexes(); }
});

test("unavailable transactions never fall back to partial keyed writes", async () => {
  jest.spyOn(mongoose, "startSession").mockResolvedValue({ startTransaction() { throw new Error("Transactions unavailable"); }, inTransaction: () => false, endSession: async () => {} });
  expect((await send(reporter, payload(reporter))).status).toBe(503); await counts(0);
});

test("replay after operator updates returns current safe status without changing triage or resending receipt", async () => {
  const input = payload(reporter), created = await send(reporter, input);
  await Incident.updateOne({ publicId: created.body.incident.publicId }, { $set: { state: "investigating", userVisibleStatus: "investigating", adminVisibleStatus: "investigating" } });
  const replay = await send(reporter, input); expect(replay.status).toBe(200); expect(replay.body.incident.state).toBe("investigating"); await counts();
});

test("legacy callers without the keyed contract retain the original creation response", async () => {
  const { requestId, reporterId, ...input } = payload(reporter);
  const response = await send(reporter, input); expect(response.status).toBe(201); expect(response.body.reporterAccessToken).toHaveLength(48); await counts();
});

test("a fresh Node process recovers the original receipt from durable records", async () => {
  const input = payload(reporter), initial = await send(reporter, input);
  expect(initial.status).toBe(201);
  const code = `
    const mongoose = require("mongoose");
    const User = require("./models/User");
    const { createIncidentFromHelpReport } = require("./services/incidents/intakeService");
    (async () => {
      await mongoose.connect(process.env.LPC_HELP_RESTART_URI, { dbName: process.env.LPC_HELP_RESTART_DB, autoCreate: false, autoIndex: false });
      const input = JSON.parse(process.argv[1]);
      const user = await User.findById(input.reporterId).lean();
      const result = await createIncidentFromHelpReport({ user, input });
      await mongoose.disconnect();
      process.stdout.write(JSON.stringify(result));
    })().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
  `;
  const { stdout } = await execFile(process.execPath, ["-e", code, JSON.stringify(input)], {
    cwd: require("path").resolve(__dirname, ".."),
    env: { ...process.env, LPC_HELP_RESTART_URI: mongoose.connection.getClient().s.url, LPC_HELP_RESTART_DB: mongoose.connection.name }, timeout: 20000,
  });
  const replay = JSON.parse(stdout);
  expect(replay.idempotent).toBe(true);
  expect(replay.incident.publicId).toBe(initial.body.incident.publicId);
  expect(replay.reporterAccessToken).toBe(initial.body.reporterAccessToken); await counts();
});

test("absent encryption fails closed before any database connection or credential write", async () => {
  const code = `
    const { createIncidentFromHelpReport } = require("./services/incidents/intakeService");
    createIncidentFromHelpReport({ user: { id: process.argv[1], role: "paralegal" }, input: JSON.parse(process.argv[2]) })
      .then(() => { throw new Error("Unexpected intake success"); })
      .catch(error => { process.stdout.write(JSON.stringify({ status: error.statusCode, code: error.publicCode })); });
  `;
  const { stdout } = await execFile(process.execPath, ["-e", code, String(reporter._id), JSON.stringify(payload(reporter))], {
    cwd: require("path").resolve(__dirname, ".."), env: { ...process.env, DATA_ENCRYPTION_KEY: "" }, timeout: 10000,
  });
  expect(JSON.parse(stdout)).toEqual({ status: 503, code: "HELP_INTAKE_UNAVAILABLE" }); await counts(0);
});

test("index preparation is repeatable, preserves legacy records and does not remove other indexes", async () => {
  const { checkHelpIntakeIndex, ensureHelpIntakeIndex } = require("../scripts/help-intake-indexes");
  const { requestId, reporterId, ...input } = payload(reporter);
  expect((await send(reporter, input)).status).toBe(201); expect((await send(reporter, input)).status).toBe(201);
  await Incident.collection.createIndex({ summary: 1 }, { name: "help_test_existing_index" });
  try {
    await Incident.collection.dropIndex("help_reporter_request_unique"); expect(await checkHelpIntakeIndex()).toBe(false);
    await ensureHelpIntakeIndex(); await ensureHelpIntakeIndex(); expect(await checkHelpIntakeIndex()).toBe(true);
    expect((await Incident.collection.indexes()).some(index => index.name === "help_test_existing_index")).toBe(true);
    await counts(2); expect((await send(reporter, payload(reporter))).status).toBe(201); await counts(3);
  } finally { await Incident.collection.dropIndex("help_test_existing_index"); }
});
