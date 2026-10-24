const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentEvent = require("../models/IncidentEvent");
const { createAuthSession } = require("../services/authSessionService");
const { generateReporterAccessToken } = require("../utils/incidentAccess");
const incidentsRouter = require("../routes/incidents");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser(), express.json());
app.use("/api/incidents", incidentsRouter);
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
let owner;
let stranger;
let incident;
let access;

async function actor(name, role = "attorney") {
  const user = await User.create({ firstName: "Synthetic", lastName: name, email: `${name}@incident-timeline.test`, password: "SyntheticTimeline123!", role, status: "approved" });
  const { sessionId } = await createAuthSession(user, {});
  const token = jwt.sign({ id: String(user._id), role, av: Number(user.authVersion || 0), sid: sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { user, cookie: `token=${token}` };
}

function event(seq, overrides = {}) {
  return { incidentId: incident._id, seq, eventType: "state_changed", actor: { type: "system", role: "system" }, summary: "PRIVATE_INTERNAL_EVENT", toState: "investigating", detail: { private: "PRIVATE_DETAILS" }, createdAt: new Date(Date.UTC(2026, 8, 9) + seq * 1000), ...overrides };
}

async function seed(count) { if (count) await IncidentEvent.insertMany(Array.from({ length: count }, (_, index) => event(index + 1))); }

function get(query = {}, viewer = owner, publicId = incident.publicId) {
  const req = request(app).get(`/api/incidents/${encodeURIComponent(publicId)}/timeline`).query(query);
  return viewer ? req.set("Cookie", viewer.cookie) : req;
}

async function page(query = {}, viewer = owner) {
  const response = await get({ paged: "1", ...query }, viewer);
  expect(response.status).toBe(200);
  expect(Object.keys(response.body).sort()).toEqual(["events", "hasMore", "incident", "nextCursor", "ok"]);
  expect(response.body.ok).toBe(true);
  expect(response.body.hasMore).toBe(response.body.nextCursor !== null);
  expect(JSON.stringify(response.body.events)).not.toMatch(/PRIVATE_|detail|artifactIds|actor/);
  return response.body;
}

// Imported incident services register many indexed models; only bootstrap
// receives a larger budget. Route assertions retain the standard timeout.
beforeAll(connect, 120000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [owner, stranger] = await Promise.all([actor("owner"), actor("stranger", "paralegal")]);
  access = generateReporterAccessToken();
  incident = await Incident.create({ publicId: "INC-20260909-123456", source: "help_form", reporter: { userId: owner.user._id, role: owner.user.role, accessTokenHash: access.hash }, context: { surface: owner.user.role }, summary: "A synthetic reported problem", originalReportText: "PRIVATE_ORIGINAL_REPORT" });
});

describe("mounted complete reporter timeline", () => {
  test.each([0, 1, 100, 101, 237])("%i state events remain reachable without omissions or duplicates", async total => {
    await seed(total); const seen = []; let cursor;
    do {
      const result = await page({ limit: "20", ...(cursor ? { cursor } : {}) });
      seen.push(...result.events.map(entry => entry.seq)); cursor = result.nextCursor;
      if (cursor) expect(cursor).toBe(String(result.events.at(-1).seq));
      expect(seen.length).toBeLessThanOrEqual(total);
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(new Set(seen).size).toBe(total);
  });

  test("legacy first-50, capped-100 and parseInt limit shapes remain unchanged", async () => {
    await seed(125);
    for (const [query, length] of [[{}, 50], [{ limit: "500" }, 100], [{ limit: "2trailing" }, 2]]) {
      const res = await get(query); expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["events", "incident", "ok"]);
      expect(res.body.events).toHaveLength(length);
    }
    expect((await page({ limit: "100" })).events).toHaveLength(100);
  });

  test("cursor alone opts in and uses sequence gaps, not offsets or dates", async () => {
    await IncidentEvent.insertMany([event(1), event(2, { eventType: "classification_written" }), event(7), event(30, { createdAt: new Date("2020-01-01") }), event(100)]);
    const first = await page({ limit: "2" });
    expect(first.events.map(entry => entry.seq)).toEqual([1, 7]); expect(first.nextCursor).toBe("7");
    const next = await get({ cursor: first.nextCursor, limit: "2" });
    expect(next.status).toBe(200); expect(next.body.events.map(entry => entry.seq)).toEqual([30, 100]);
    expect(next.body).toMatchObject({ hasMore: false, nextCursor: null });
  });

  test("deleting a boundary and appending new state events preserve later history and current status", async () => {
    await seed(3);
    const first = await page({ limit: "2" });
    await IncidentEvent.deleteOne({ incidentId: incident._id, seq: 2 });
    await IncidentEvent.create(event(8, { toState: "resolved" }));
    await Incident.updateOne({ _id: incident._id }, { $set: { state: "resolved", userVisibleStatus: "fixed_live" } });
    const next = await page({ cursor: first.nextCursor });
    expect(next.events.map(entry => entry.seq)).toEqual([3, 8]);
    expect(next.incident.userVisibleStatus).toBe("fixed_live");
    expect(next.nextCursor).toBeNull();
    expect((await page({ cursor: "9007199254740991" })).events).toEqual([]);
  });

  test.each(["", "0", "-1", "1.5", "1e2", "01", " 1", "NaN", "9007199254740992"])("invalid cursor %j returns 400 for an authorized incident", async cursor => {
    const response = await get({ cursor }); expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/cursor/i);
  });

  test.each(["", "0", "-1", "101", "1.5", "20tail"])("invalid paged limit %j returns 400", async limit => {
    const response = await get({ paged: "1", limit }); expect(response.status).toBe(400);
  });

  test("duplicate cursor and paged query values are rejected", async () => {
    const path = `/api/incidents/${incident.publicId}/timeline`;
    for (const query of ["cursor=1&cursor=2", "paged=1&paged=1", "paged=1&limit=1&limit=2", "paged=0"]) {
      const response = await request(app).get(`${path}?${query}`).set("Cookie", owner.cookie);
      expect(response.status).toBe(400);
    }
  });

  test("every page reauthorizes the current owner; missing and unrelated remain 404", async () => {
    await seed(3); const first = await page({ limit: "1" });
    expect((await get({ cursor: first.nextCursor }, stranger)).status).toBe(404);
    expect((await get({ cursor: first.nextCursor }, null)).status).toBe(404);
    expect((await get({ cursor: "bad" }, stranger)).status).toBe(404);
    expect((await get({ paged: "1" }, owner, "INC-20990101-999999")).status).toBe(404);
    await Incident.updateOne({ _id: incident._id }, { $set: { "reporter.userId": stranger.user._id } });
    expect((await get({ cursor: first.nextCursor })).status).toBe(404);
    expect((await page({ cursor: first.nextCursor }, stranger)).events.map(entry => entry.seq)).toEqual([2, 3]);
  });

  test("existing reporter token and admin access are preserved for paged safe history", async () => {
    await seed(3);
    const tokenResponse = await get({ paged: "1", limit: "1" }, null).set("x-incident-access-token", access.token);
    expect(tokenResponse.status).toBe(200); expect(tokenResponse.body.nextCursor).toBe("1");
    const next = await get({ cursor: "1" }, null).set("x-incident-access-token", access.token);
    expect(next.status).toBe(200); expect(next.body.events.map(entry => entry.seq)).toEqual([2, 3]);
    const admin = await actor("admin", "admin"); expect((await page({}, admin)).events).toHaveLength(3);
  });
  test.each(["", "/timeline"])("optional expected owner guards reporter GET %s without removing token compatibility", async suffix => {
    await seed(2);
    const path = `/api/incidents/${incident.publicId}${suffix}`;
    const query = { expectedOwnerId: String(owner.user._id), ...(suffix ? { paged: "1" } : {}) };
    const own = await request(app).get(path).query(query).set("Cookie", owner.cookie);
    expect(own.status).toBe(200); expect(own.headers["cache-control"]).toBe("private, no-store");
    for (const cookie of [null, stranger.cookie]) {
      let req = request(app).get(path).query(query);
      if (cookie) req = req.set("Cookie", cookie);
      const res = await req; expect(res.status).toBe(403); expect(res.body.code).toBe("ACCOUNT_CHANGED");
      expect(JSON.stringify(res.body)).not.toContain(incident.summary);
    }
    const tokenGuard = await request(app).get(path).query(query).set("x-incident-access-token", access.token);
    expect(tokenGuard.status).toBe(403);
    for (const expectedOwnerId of ["", "invalid", [String(owner.user._id), String(owner.user._id)]]) {
      const res = await request(app).get(path).query({ expectedOwnerId }).set("Cookie", owner.cookie);
      expect(res.status).toBe(400); expect(res.body.code).toBe("INVALID_EXPECTED_OWNER");
    }
    const legacyToken = await request(app).get(path).set("x-incident-access-token", access.token);
    expect(legacyToken.status).toBe(200);
  });

});
