const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const mongoose = require("mongoose");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_search_not_a_provider_key";
process.env.S3_BUCKET = "synthetic-search-no-provider";
const User = require("../models/User");
const Case = require("../models/Case");
const AuthSession = require("../models/AuthSession");
const Block = require("../models/Block");
const { createAuthSession } = require("../services/authSessionService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use(cookieParser(), express.json());
app.use("/api/cases", require("../routes/cases"));
app.use((error, _req, res, _next) => res.status(500).json({ error: "Search unavailable" }));
let owner, other, session;
const id = () => new mongoose.Types.ObjectId();
const userFields = (overrides = {}) => ({ firstName: "Search", lastName: "Owner", email: `${id()}@example.test`, password: "Synthetic search acceptance password", role: "attorney", status: "approved", ...overrides });
const publicFields = (overrides = {}) => ({ ...userFields({ role: "paralegal" }), bio: "Public profile", resumeURL: "https://example.test/resume", skills: ["Review"], practiceAreas: ["Civil Litigation"], specialties: [], profilePhotoStatus: "approved", profileImage: "https://example.test/photo", pendingProfileImage: "", ...overrides });
const caseFields = (overrides = {}) => ({ _id: id(), attorney: owner._id, attorneyId: owner._id, title: "Search Matter", practiceArea: "Civil Litigation", details: "Private report canary", status: "open", totalAmount: 123456, currency: "usd", createdAt: new Date("2020-01-01"), updatedAt: new Date("2020-01-01"), ...overrides });
async function identity(user) {
  const managed = await createAuthSession(user, { headers: { "user-agent": "Synthetic search acceptance" } });
  return { id: managed.sessionId, cookie: `token=${jwt.sign({ id: String(user._id), sid: managed.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
}
function search(query = "Search", options = {}) {
  const qs = options.raw ?? `q=${encodeURIComponent(query)}&types=${options.types || "matter"}${options.guarded === false ? "" : `&expectedOwnerId=${options.expectedOwnerId || owner._id}`}`;
  return request(app).get(`/api/cases/search?${qs}`).set("Cookie", (options.session || session).cookie);
}
beforeAll(connect, 150000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  owner = await User.create(userFields()); other = await User.create(userFields()); session = await identity(owner);
});
afterEach(() => jest.restoreAllMocks());

test("guarded success echoes the verified owner and unguarded success retains its envelope", async () => {
  const guarded = await search(); expect(guarded.status).toBe(200); expect(guarded.body.ownerId).toBe(String(owner._id));
  expect(guarded.headers["cache-control"]).toBe("private, no-store");
  const legacy = await search("Search", { guarded: false }); expect(legacy.status).toBe(200);
  expect(Object.keys(legacy.body).sort()).toEqual(["query", "results", "types"]);
});

test("replacement-account cookies reject the old expectation before search data is read", async () => {
  const find = jest.spyOn(Case, "find"), aggregate = jest.spyOn(Case, "aggregate");
  const response = await search("Search", { session: await identity(other) });
  expect(response.status).toBe(403); expect(response.body.code).toBe("ACCOUNT_CHANGED");
  expect(response.headers["cache-control"]).toBe("private, no-store"); expect(find).not.toHaveBeenCalled(); expect(aggregate).not.toHaveBeenCalled();
});

test.each([
  "q=Search&q=Matter", "q[]=Search", "q[text]=Search", "q=Search&q[]=Matter",
  "q=Search&expectedOwnerId=bad", "q=Search&expectedOwnerId=", "q=Search&expectedOwnerId[]=bad",
  "q=Search&expectedOwnerId[text]=bad", "q=Search&expectedOwnerId=OWNER&expectedOwnerId=OWNER",
])("rejects malformed scalar query shape: %s", async raw => {
  const response = await search("", { raw: raw.replaceAll("OWNER", String(owner._id)) });
  expect(response.status).toBe(400); expect(response.headers["cache-control"]).toBe("private, no-store");
});

test("retains flat repeated types compatibility but rejects nested type inputs", async () => {
  const response = await search("", { raw: `q=Search&types=matter&types=profile&expectedOwnerId=${owner._id}` });
  expect(response.status).toBe(200); expect(response.body.types).toEqual(["matter", "profile"]);
  expect((await search("", { raw: "q=Search&types[0][value]=matter" })).status).toBe(400);
});

test.each(["matter", "profile"])("old exact and prefix %s matches rank ahead of more than 36 newer token matches", async type => {
  const exactId = id(), prefixId = id();
  if (type === "matter") {
    await Case.collection.insertMany([
      caseFields({ _id: exactId, title: "Search Matter" }),
      caseFields({ _id: prefixId, title: "Search Matter extended" }),
      ...Array.from({ length: 160 }, (_, i) => caseFields({ title: `Matter search token ${i}`, updatedAt: new Date(2030, 0, 1, 0, 0, i) })),
      ...Array.from({ length: 400 }, (_, i) => caseFields({ attorney: other._id, attorneyId: other._id, title: `Search Matter private ${i}`, updatedAt: new Date("2040-01-01") })),
    ]);
  } else {
    await User.collection.insertMany([
      { _id: exactId, ...publicFields({ firstName: "Search", lastName: "Matter", updatedAt: new Date("2020-01-01") }) },
      { _id: prefixId, ...publicFields({ firstName: "Search", lastName: "Matter extended", updatedAt: new Date("2020-01-01") }) },
      ...Array.from({ length: 160 }, (_, i) => publicFields({ firstName: "Matter", lastName: `Search ${i}`, updatedAt: new Date(2030, 0, 1, 0, 0, i) })),
    ]);
  }
  const response = await search("Search Matter", { types: type }); expect(response.status).toBe(200);
  const rows = response.body.results[type === "matter" ? "matters" : "profiles"];
  expect(rows).toHaveLength(6); expect(rows.slice(0, 2).map(row => row.id)).toEqual([String(exactId), String(prefixId)]);
});

test.each(["matter", "profile"])("requires token nine for %s matches", async type => {
  const query = "one two three four five six seven eight nine";
  const good = id(), bad = id();
  if (type === "matter") await Case.collection.insertMany([caseFields({ _id: good, title: query }), caseFields({ _id: bad, title: "one two three four five six seven eight" })]);
  else await User.collection.insertMany([{ _id: good, ...publicFields({ firstName: query }) }, { _id: bad, ...publicFields({ firstName: "one two three four five six seven eight" }) }]);
  const response = await search(query, { types: type }); expect(response.status).toBe(200);
  expect(response.body.results[type === "matter" ? "matters" : "profiles"].map(row => row.id)).toEqual([String(good)]);
});

test("six results per type remain independent and preserve minimal DTOs and stored evidence", async () => {
  const rows = Array.from({ length: 9 }, (_, i) => caseFields({ title: `Search ${i}`, escrowIntentId: "pi_private_canary", files: [{ filename: "private.pdf", key: "private/storage-key" }], applicants: [{ paralegalId: id(), status: "pending", note: "Private application canary" }] }));
  await Case.collection.insertMany(rows);
  await User.collection.insertMany(Array.from({ length: 9 }, (_, i) => publicFields({ firstName: "Search", lastName: `Profile ${i}` })));
  const before = await Case.collection.find({}).sort({ _id: 1 }).toArray();
  const response = await search("Search", { types: "matter,profile" }); expect(response.status).toBe(200);
  expect(response.body.results.matters).toHaveLength(6); expect(response.body.results.profiles).toHaveLength(6);
  expect(Object.keys(response.body.results.matters[0]).sort()).toEqual(["attention", "id", "nextAction", "practiceArea", "relationship", "status", "title", "type"]);
  expect(Object.keys(response.body.results.profiles[0]).sort()).toEqual(["headline", "id", "location", "nextAction", "practiceAreas", "title", "type"]);
  expect(JSON.stringify(response.body)).not.toMatch(/pi_private_canary|private\/storage|Private application|resume|email|totalAmount|escrow/);
  expect(await Case.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
});

test("normalizes query compatibility characters and ranks whitespace-normalized primary text before recency", async () => {
  const exact = caseFields({ title: "  Café\t\nMatter  " }), prefix = caseFields({ title: "Café Matter extension", updatedAt: new Date("2030-01-01") });
  await Case.collection.insertMany([exact, prefix]);
  const response = await search(" Ｃａｆé   Matter "); expect(response.status).toBe(200); expect(response.body.query).toBe("Café Matter");
  expect(response.body.results.matters.map(row => row.id)).toEqual([String(exact._id), String(prefix._id)]);
});

test("equal ranking and dates use deterministic descending IDs, including missing dates", async () => {
  const rows = Array.from({ length: 8 }, () => { const row = caseFields(); delete row.updatedAt; return row; });
  await Case.collection.insertMany(rows);
  const expected = rows.map(row => String(row._id)).sort().reverse().slice(0, 6);
  expect((await search("Search Matter")).body.results.matters.map(row => row.id)).toEqual(expected);
  expect((await search("Search Matter")).body.results.matters.map(row => row.id)).toEqual(expected);
});

test.each(["matter", "profile"])("preserves compatibility, combining and Unicode-space %s ranking beyond the old candidate cap", async type => {
  const exactIds = [id(), id(), id()];
  const names = ["Ｃａｆé Matter", "Cafe\u0301 Matter", "Café\u3000Matter"];
  if (type === "matter") await Case.collection.insertMany([
    ...names.map((title, index) => caseFields({ _id: exactIds[index], title, practiceArea: "Café Matter" })),
    ...Array.from({ length: 80 }, (_, index) => caseFields({ title: `Café Matter extension ${index}`, updatedAt: new Date("2030-01-01") })),
  ]);
  else await User.collection.insertMany([
    ...names.map((firstName, index) => ({ _id: exactIds[index], ...publicFields({ firstName, lastName: "", practiceAreas: ["Café Matter"], updatedAt: new Date("2020-01-01") }) })),
    ...Array.from({ length: 80 }, (_, index) => publicFields({ firstName: "Café", lastName: `Matter extension ${index}`, updatedAt: new Date("2030-01-01") })),
  ]);
  const response = await search("Café Matter", { types: type }); expect(response.status).toBe(200);
  expect(response.body.results[type === "matter" ? "matters" : "profiles"].slice(0, 3).map(row => row.id)).toEqual(exactIds.map(String).sort().reverse());
});

test("retains literal stored-field matching when no other field supplies the normalized query", async () => {
  const raw = caseFields({ title: "Ｃａｆé Matter" }); await Case.collection.insertOne(raw);
  expect((await search("Café Matter")).body.results.matters).toEqual([]);
});

test("ranks a realistic many-match fixture with bounded returned metadata and records query plans", async () => {
  const exact = caseFields({ title: "Search Matter" });
  await Case.collection.insertMany([
    exact,
    ...Array.from({ length: 1000 }, (_, index) => caseFields({ title: `Matter Search ${index}`, updatedAt: new Date("2030-01-01") })),
    ...Array.from({ length: 300 }, (_, index) => caseFields({ title: `Mátter Search ${index}`, practiceArea: "Search Matter", updatedAt: new Date("2030-01-01") })),
    ...Array.from({ length: 1000 }, () => caseFields({ attorney: other._id, attorneyId: other._id, title: "Search Matter", updatedAt: new Date("2040-01-01") })),
  ]);
  const aggregate = jest.spyOn(Case, "aggregate"); const started = Date.now();
  const response = await search("Search Matter"); const elapsedMs = Date.now() - started;
  expect(response.status).toBe(200); expect(response.body.results.matters).toHaveLength(6); expect(response.body.results.matters[0].id).toBe(String(exact._id));
  const pipelines = aggregate.mock.calls.map(([pipeline]) => pipeline);
  expect(pipelines).toHaveLength(2);
  expect(pipelines[0]).toContainEqual({ $limit: 6 });
  const plans = [];
  for (const pipeline of pipelines) plans.push(await Case.aggregate(pipeline).explain("executionStats"));
  if (process.env.LPC_SEARCH_PLAN_EVIDENCE) require("fs").writeFileSync(process.env.LPC_SEARCH_PLAN_EVIDENCE, JSON.stringify({ fixture: { authorizedAscii: 1001, authorizedUnicode: 300, unrelated: 1000 }, elapsedMs, returned: response.body.results.matters.length, plans }, null, 2));
});

test.each(["revoked", "expired", "disabled", "deleted", "version"])("rejects a %s current managed identity", async state => {
  if (state === "revoked") await AuthSession.updateOne({ sessionId: session.id }, { $set: { revokedAt: new Date() } });
  else if (state === "expired") await AuthSession.updateOne({ sessionId: session.id }, { $set: { expiresAt: new Date(0) } });
  else if (state === "version") await User.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } });
  else await User.updateOne({ _id: owner._id }, { $set: { [state]: true } });
  const response = await search(); expect([401, 403]).toContain(response.status); expect(response.body.results).toBeUndefined();
});

test("source failure is unavailable instead of an empty successful group", async () => {
  const error = new Error("Synthetic search database failure");
  jest.spyOn(Case, "find").mockImplementation(() => { throw error; });
  jest.spyOn(Case, "aggregate").mockImplementation(() => { throw error; });
  const response = await search(); expect(response.status).toBe(500); expect(response.body.results).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("private, no-store");
});

test("mounted managed-user rate limit returns private 429 with a bounded retry delay", async () => {
  const mode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    for (let index = 0; index < 60; index += 1) expect((await search("No match")).status).toBe(200);
    const limited = await search("No match"); expect(limited.status).toBe(429);
    expect(limited.headers["cache-control"]).toBe("private, no-store");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0); expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(limited.body.results).toBeUndefined();
    expect((await search("No match", { expectedOwnerId: String(other._id), session: await identity(other) })).status).toBe(200);
  } finally { process.env.NODE_ENV = mode; }
});

test("preserves attorney alias and retained history while raw string aliases remain characterized", async () => {
  const alias = caseFields({ attorney: null, status: "completed", archived: true, paymentReleased: true });
  const rawString = caseFields({ attorney: null, attorneyId: String(owner._id) });
  await Case.collection.insertMany([alias, rawString]);
  const response = await search(); expect(response.status).toBe(200);
  expect(response.body.results.matters.map(row => row.id)).toEqual([String(alias._id)]);
});

test("preserves paralegal withdrawal, archive, invite, application alias and symmetric block boundaries", async () => {
  const para = await User.create(publicFields()); const paraSession = await identity(para);
  const assigned = overrides => caseFields({ status: "in progress", paralegalId: para._id, ...overrides });
  const active = assigned({ archived: true }), app = caseFields({ status: "in progress", applicants: [{ paralegalId: para._id, status: "accepted" }] });
  const relisted = caseFields({ status: "paused", relistRequestedAt: new Date() });
  await Case.collection.insertMany([
    active, app, relisted,
    assigned({ withdrawnParalegalId: para._id }), assigned({ status: "completed" }), assigned({ paymentReleased: true }), assigned({ paralegalAccessRevokedAt: new Date() }),
    caseFields({ archived: true }), caseFields({ status: "paused" }),
    caseFields({ status: "in progress", invites: [{ paralegalId: para._id, status: "pending" }], pendingParalegalId: para._id }),
    caseFields({ status: "in progress", applicants: [{ paralegal: para._id, status: "pending" }] }),
    caseFields({ status: "in progress", applicants: [{ paralegalId: para._id }] }),
    caseFields({ attorney: other._id, attorneyId: other._id }),
  ]);
  await Block.create({ blockerId: other._id, blockedId: para._id, blockerRole: "attorney", blockedRole: "paralegal", sourceType: "legacy" });
  const response = await search("Search", { expectedOwnerId: String(para._id), session: paraSession, types: "matter,profile" });
  expect(response.status).toBe(200); expect(response.body.results.profiles).toEqual([]);
  expect(response.body.results.matters.map(row => row.id).sort()).toEqual([active, app, relisted].map(row => String(row._id)).sort());
});
