const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");
const User = require("../models/User");
const Case = require("../models/Case");
const Incident = require("../models/Incident");
const Notification = require("../models/Notification");
const { createAuthSession } = require("../services/authSessionService");
const { stageHelpReportReceived } = require("../services/incidents/notificationService");
const notificationsRouter = require("../routes/notifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser(), express.json());
app.use("/api/notifications", notificationsRouter);
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
let paralegal;
let attorney;
let sequence;

async function actor(role) {
  const user = await User.create({ firstName: "Synthetic", lastName: role, email: `${role}@notification-incident.test`, password: "SyntheticIncident123!", role, status: "approved" });
  const { sessionId } = await createAuthSession(user, {});
  const token = jwt.sign({ id: String(user._id), role, av: Number(user.authVersion || 0), sid: sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { user, cookie: `token=${token}` };
}

async function incident(reporter = paralegal, overrides = {}) {
  sequence += 1;
  return Incident.create({ publicId: `INC-20260909-${String(sequence).padStart(6, "0")}`, source: "help_form", reporter: { userId: reporter.user._id, role: reporter.user.role, email: reporter.user.email, accessTokenHash: "PRIVATE_TOKEN_HASH" }, context: { surface: reporter.user.role }, summary: "PRIVATE_REPORT_SUMMARY", originalReportText: "PRIVATE_REPORT_CONTENT", ...overrides });
}

async function notice(recipient, doc, overrides = {}) {
  return Notification.create({ userId: recipient.user._id, userRole: recipient.user.role, type: "incident_update", message: "PRIVATE_UNTRUSTED_MESSAGE", link: "https://untrusted.invalid/private", payload: { incidentPublicId: doc?.publicId, status: "received", state: "PRIVATE_INTERNAL_STATE" }, read: false, isRead: false, ...overrides });
}

async function views(viewer = paralegal) {
  const [list, page, unread] = await Promise.all(["", "/page", "/unread-count"].map(path => request(app).get(`/api/notifications${path}`).set("Cookie", viewer.cookie)));
  for (const response of [list, page, unread]) expect(response.status).toBe(200);
  return { list: list.body, page: page.body, count: unread.body.count };
}

function expectAbsent(result) {
  expect(result).toEqual({ list: [], page: { items: [], hasMore: false, nextCursor: null }, count: 0 });
}

// Imported incident services register many indexed models; only bootstrap
// receives a larger budget. Route assertions retain the standard timeout.
beforeAll(connect, 120000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); sequence = 0;
  [paralegal, attorney] = await Promise.all([actor("paralegal"), actor("attorney")]);
});

describe("mounted reporter notification visibility", () => {
  test.each(["attorney", "paralegal"])("%s sees an owned incident with safe message and exact Help context", async role => {
    const reporter = role === "attorney" ? attorney : paralegal;
    const doc = await incident(reporter);
    const record = await notice(reporter, doc);
    const result = await views(reporter);
    expect(result.list).toHaveLength(1);
    expect(result.page.items).toEqual(result.list);
    expect(result.count).toBe(1);
    expect(result.list[0]).toMatchObject({ id: String(record._id), type: "incident_update", available: true, message: `Report ${doc.publicId} received.`, context: { incidentPublicId: doc.publicId }, action: { label: "View report", href: `${role === "attorney" ? "/help.html" : "/paralegalhelp.html"}?incident=${doc.publicId}` }, read: false, isRead: false });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|untrusted|accessToken|reporter|artifact|caseId/);
  });

  test("the real transactional Help receipt reaches the reporter list and exact badge", async () => {
    const doc = await incident();
    const session = await mongoose.startSession();
    try { await session.withTransaction(() => stageHelpReportReceived({ incident: doc, session })); }
    finally { await session.endSession(); }
    const result = await views();
    expect(result.list).toHaveLength(1);
    expect(result.list[0].context.incidentPublicId).toBe(doc.publicId);
    expect(result.count).toBe(1);
  });

  test.each([
    ["investigating", "Report {id} is under review."],
    ["testing_fix", "A fix for report {id} is being tested."],
    ["awaiting_internal_review", "Report {id} is under review."],
    ["fixed_live", "Report {id} was fixed."],
    ["needs_more_info", "More information is needed for report {id}."],
    ["closed", "Report {id} was closed."],
    ["unknown_internal_stage", "Report {id} has an update."],
  ])("historical %s milestone is safe and does not become the current status", async (status, message) => {
    const doc = await incident(paralegal, { userVisibleStatus: "fixed_live" });
    await notice(paralegal, doc, { payload: { incidentPublicId: doc.publicId, status, privateNotes: "PRIVATE_NOTES" } });
    const result = await views();
    expect(result.list[0].message).toBe(message.replace("{id}", doc.publicId));
    expect(result.count).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  test("two owned reports are distinguishable by verified reference without disclosing report text", async () => {
    const one = await incident(); const two = await incident();
    await notice(paralegal, one); await notice(paralegal, two);
    const result = await views();
    expect(result.list.map(item => item.message).sort()).toEqual([`Report ${one.publicId} received.`, `Report ${two.publicId} received.`]);
    expect(result.count).toBe(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  test.each(["missing", "unrelated", "no_reporter", "unknown_reference", "object_reference"])("%s incident cannot create visible rows or unread count", async mode => {
    let doc = mode === "unrelated" ? await incident(attorney) : await incident();
    if (mode === "missing") await Incident.deleteOne({ _id: doc._id });
    if (mode === "no_reporter") await Incident.updateOne({ _id: doc._id }, { $set: { "reporter.userId": null } });
    if (mode === "unknown_reference") doc = { publicId: "INC-20990101-999999" };
    if (mode === "object_reference") doc = { publicId: { $ne: null } };
    await notice(paralegal, doc);
    expectAbsent(await views());
  });

  test("a valid Matter relationship cannot authorize an unrelated incident or leak Matter content", async () => {
    const doc = await incident(paralegal);
    const matter = await Case.create({ title: "PRIVATE_MATTER", details: "Private", attorney: attorney.user._id, status: "open", totalAmount: 50000 });
    await notice(attorney, doc, { payload: { incidentPublicId: doc.publicId, status: "received", caseId: matter._id } });
    expectAbsent(await views(attorney));
  });

  test("current reporter ownership is rechecked on each cursor page", async () => {
    const docs = [await incident(), await incident()];
    const records = await Promise.all(docs.map(doc => notice(paralegal, doc)));
    const first = await request(app).get("/api/notifications/page?limit=1").set("Cookie", paralegal.cookie);
    expect(first.status).toBe(200); expect(first.body.hasMore).toBe(true);
    const remaining = records.find(record => String(record._id) !== first.body.items[0].id);
    await Incident.updateOne({ publicId: remaining.payload.incidentPublicId }, { $set: { "reporter.userId": attorney.user._id } });
    const next = await request(app).get("/api/notifications/page").query({ limit: 1, cursor: first.body.nextCursor }).set("Cookie", paralegal.cookie);
    expect(next.body).toEqual({ items: [], hasMore: false, nextCursor: null });
    expect((await views()).count).toBe(1);
  });

  test("hidden raw batches cannot crowd out owned Help notifications beyond 100", async () => {
    const doc = await incident();
    const records = Array.from({ length: 335 }, (_, index) => ({ userId: paralegal.user._id, type: "incident_update", payload: { incidentPublicId: index < 205 ? "INC-20990101-999999" : doc.publicId, status: "received" }, read: index >= 330, isRead: false, createdAt: new Date(Date.UTC(2026, 8, 9) - index * 1000) }));
    await Notification.insertMany(records);
    const first = await views();
    expect(first.list).toHaveLength(100); expect(first.count).toBe(125);
    let cursor; const seen = [];
    do {
      const res = await request(app).get("/api/notifications/page").query({ unread: "1", limit: "50", ...(cursor ? { cursor } : {}) }).set("Cookie", paralegal.cookie);
      expect(res.status).toBe(200); seen.push(...res.body.items.map(item => item.id)); cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(125);
  });

  test("read, mark-all and dismissal keep incident list/count parity", async () => {
    const doc = await incident(); const records = [await notice(paralegal, doc), await notice(paralegal, doc)];
    const body = { expectedOwnerId: String(paralegal.user._id) };
    expect((await views()).count).toBe(2);
    expect((await request(app).post(`/api/notifications/${records[0]._id}/read`).set("Cookie", paralegal.cookie).send(body)).status).toBe(200);
    expect((await views()).count).toBe(1);
    expect((await request(app).post("/api/notifications/read-all").set("Cookie", paralegal.cookie).send(body)).status).toBe(200);
    expect((await views()).count).toBe(0);
    expect((await request(app).delete(`/api/notifications/${records[0]._id}`).set("Cookie", paralegal.cookie).send(body)).status).toBe(200);
    expect((await views()).list).toHaveLength(1);
  });

  test.each(["paralegal_welcome", "account_suspended", "incident_approval_required", "unknown_non_matter_type"])("%s gains no generic fallback from the incident fix", async type => {
    const doc = await incident(); await notice(paralegal, doc, { type });
    expectAbsent(await views());
  });
});
