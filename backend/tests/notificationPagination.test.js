const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { Types } = require("mongoose");
const User = require("../models/User");
const Case = require("../models/Case");
const Block = require("../models/Block");
const Notification = require("../models/Notification");
const { createAuthSession, revokeSession } = require("../services/authSessionService");
const notificationsRouter = require("../routes/notifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser(), express.json());
app.use("/api/notifications", notificationsRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

const FIXED_DATE = new Date("2026-09-01T12:00:00.000Z");
let recipient;
let other;
let attorney;

async function actor(name, role = "paralegal") {
  const user = await User.create({ firstName: "Synthetic", lastName: name, email: `${name}@notification-page.test`, password: "SyntheticPages123!", role, status: "approved" });
  const { sessionId } = await createAuthSession(user, {});
  const token = jwt.sign({ id: String(user._id), role, av: Number(user.authVersion || 0), sid: sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { user, sessionId, cookie: `token=${token}` };
}

function row(index, overrides = {}) {
  return {
    _id: new Types.ObjectId((index + 1).toString(16).padStart(24, "0")),
    userId: recipient.user._id,
    type: "profile_approved",
    message: `Synthetic update ${index}`,
    read: false,
    isRead: false,
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

async function seed(count, overrides = {}) {
  const records = Array.from({ length: count }, (_, index) => row(index, overrides));
  if (records.length) await Notification.collection.insertMany(records);
  return records;
}

function getPage(query = {}, viewer = recipient) {
  return request(app).get("/api/notifications/page").query(query).set("Cookie", viewer.cookie);
}

async function page(query = {}, viewer = recipient) {
  const response = await getPage(query, viewer);
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(Object.keys(response.body).sort()).toEqual(["hasMore", "items", "nextCursor"]);
  expect(Array.isArray(response.body.items)).toBe(true);
  expect(typeof response.body.hasMore).toBe("boolean");
  expect(response.body.hasMore).toBe(response.body.nextCursor !== null);
  if (response.body.hasMore) expect(typeof response.body.nextCursor).toBe("string");
  return response.body;
}

async function count(viewer = recipient) {
  const response = await request(app).get("/api/notifications/unread-count").set("Cookie", viewer.cookie);
  expect(response.status).toBe(200);
  return response.body.count;
}

async function invitedMatter() {
  return Case.create({ title: "Synthetic pending invitation", details: "Private matter contents", attorney: attorney.user._id, attorneyId: attorney.user._id, status: "open", totalAmount: 50000, pendingParalegalId: other.user._id, invites: [{ paralegalId: other.user._id, status: "pending" }, { paralegalId: recipient.user._id, status: "pending" }], applicants: [] });
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [recipient, other, attorney] = await Promise.all([actor("recipient"), actor("other"), actor("attorney", "attorney")]);
});
afterEach(() => jest.restoreAllMocks());

describe("complete notification pagination", () => {
  test.each([0, 1, 50, 51, 100, 101, 237])("%i same-time records have no page omissions or duplicates", async total => {
    const records = await seed(total);
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const result = await page(cursor ? { cursor } : {});
      expect(result.items.length).toBeLessThanOrEqual(50);
      expect(result.items.length).toBe(Math.min(50, total - seen.length));
      seen.push(...result.items.map(item => item.id));
      cursor = result.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(Math.max(1, Math.ceil(total / 50)));
    } while (cursor);
    expect(seen).toEqual(records.reverse().map(record => String(record._id)));
    expect(new Set(seen).size).toBe(total);
    expect(await count()).toBe(total);
  });

  test("limit 100 and legacy array responses preserve their separate contracts", async () => {
    await seed(130);
    const firstPage = await page({ limit: "100" });
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);
    const legacy = await request(app).get("/api/notifications").set("Cookie", recipient.cookie);
    expect(legacy.status).toBe(200);
    expect(Array.isArray(legacy.body)).toBe(true);
    expect(legacy.body).toEqual(firstPage.items);
    const next = await page({ limit: "7", cursor: firstPage.nextCursor });
    expect(next.items).toHaveLength(7);
    expect(next.items[0].id).toBe(new Types.ObjectId((30).toString(16).padStart(24, "0")).toString());
    expect(await count()).toBe(130);
  });

  test("hidden batches before, between and after eligible records cannot truncate pagination", async () => {
    const missing = new Types.ObjectId();
    const records = Array.from({ length: 710 }, (_, index) => row(index, { type: "case_update", payload: { caseId: missing } }));
    const visible = [110, 310, 510].map(index => records[index] = row(index));
    await Notification.collection.insertMany(records);
    const a = await page({ limit: "1" });
    const b = await page({ limit: "1", cursor: a.nextCursor });
    const c = await page({ limit: "1", cursor: b.nextCursor });
    expect([a.items[0].id, b.items[0].id, c.items[0].id]).toEqual(visible.reverse().map(record => String(record._id)));
    expect(c.hasMore).toBe(false);
    expect(await count()).toBe(3);
    expect(await Notification.countDocuments()).toBe(710);
  });

  test("an entirely inaccessible history is exhausted without placeholder rows or a continuation", async () => {
    await seed(205, { type: "case_update", payload: { caseId: new Types.ObjectId() } });
    expect(await page()).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(await count()).toBe(0);
  });

  test("date order, same-date ties, null dates and missing dates remain reachable", async () => {
    const missingDate = row(4);
    delete missingDate.createdAt;
    const records = [row(0, { createdAt: new Date("2026-09-03T00:00:00.000Z") }), row(1), row(2), row(3, { createdAt: null }), missingDate, row(5, { createdAt: new Date("1960-01-01T00:00:00.000Z") })];
    await Notification.collection.insertMany(records);
    const seen = [];
    let cursor;
    do {
      const result = await page({ limit: "1", ...(cursor ? { cursor } : {}) });
      seen.push(...result.items);
      cursor = result.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(6);
    } while (cursor);
    expect(seen.map(item => item.id)).toEqual([records[0], records[2], records[1], records[5], records[4], records[3]].map(record => String(record._id)));
    expect(seen.slice(-2).every(item => item.createdAt === null)).toBe(true);
  });

  test("new newest records and deletion of the boundary do not shift the older page", async () => {
    const records = await seed(5);
    const firstPage = await page({ limit: "2" });
    await Notification.collection.insertOne(row(10, { createdAt: new Date("2026-09-05T00:00:00.000Z") }));
    await Notification.deleteOne({ _id: records[3]._id });
    const older = await page({ limit: "3", cursor: firstPage.nextCursor });
    expect(older.items.map(item => item.id)).toEqual(records.slice(0, 3).reverse().map(record => String(record._id)));
    expect(older.hasMore).toBe(false);
    expect((await page({ limit: "1" })).items[0].id).toBe(String(row(10)._id));
  });

  test("either persisted read flag counts and presents a record as read", async () => {
    const caseDoc = await invitedMatter();
    const flags = [{ read: true, isRead: false }, { read: false, isRead: true }, { read: false, isRead: false }, { read: true, isRead: true }, {}, { read: true }, { isRead: true }];
    const records = flags.flatMap((flag, index) => ["profile_approved", "case_invite"].map((type, offset) => {
      const record = row(index * 2 + offset, { type, payload: { caseId: caseDoc._id } });
      delete record.read;
      delete record.isRead;
      return { ...record, ...flag };
    }));
    await Notification.collection.insertMany(records);
    const all = await page();
    const unread = await page({ unread: "1", limit: "3" });
    const remainder = await page({ unread: "1", cursor: unread.nextCursor });
    const unreadIds = records.filter(record => record.read !== true && record.isRead !== true).map(record => String(record._id)).reverse();
    expect([...unread.items, ...remainder.items].map(item => item.id)).toEqual(unreadIds);
    expect(await count()).toBe(4);
    for (const record of records) {
      const item = all.items.find(value => value.id === String(record._id));
      const isRead = record.read === true || record.isRead === true;
      expect(item.read).toBe(isRead);
      expect(item.isRead).toBe(isRead);
    }
    const legacy = await request(app).get("/api/notifications").set("Cookie", recipient.cookie);
    expect(legacy.body).toEqual(all.items);
  });

  test.each(["removed", "blocked"])("a %s invitation is reauthorized on the later page", async change => {
    const caseDoc = await invitedMatter();
    await Notification.collection.insertMany([row(3), row(2), row(1, { type: "case_invite", payload: { caseId: caseDoc._id } })]);
    const initial = await page({ limit: "2" });
    expect(initial.hasMore).toBe(true);
    if (change === "removed") await Case.updateOne({ _id: caseDoc._id }, { $pull: { invites: { paralegalId: recipient.user._id } } });
    else await Block.create({ blockerId: attorney.user._id, blockedId: recipient.user._id, blockerRole: "attorney", blockedRole: "paralegal", sourceType: "legacy" });
    expect(await page({ cursor: initial.nextCursor })).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(await Notification.countDocuments()).toBe(3);
  });

  test("later pages preserve invitation, legacy-applicant and safe withdrawn-history policy", async () => {
    const invitation = await invitedMatter();
    const application = await invitedMatter();
    await Case.collection.updateOne({ _id: application._id }, { $set: { invites: [], pendingParalegalId: null, applicants: [{ paralegal: recipient.user._id, status: "accepted" }] } });
    const withdrawn = await invitedMatter();
    await Case.updateOne({ _id: withdrawn._id }, { $set: { invites: [], pendingParalegalId: null, withdrawnParalegalId: recipient.user._id, pausedAt: FIXED_DATE, paralegalAccessRevokedAt: FIXED_DATE, paralegal: other.user._id, paralegalId: other.user._id } });
    await Notification.collection.insertMany([row(5), row(4, { type: "case_invite", payload: { caseId: invitation._id } }), row(3, { type: "case_update", payload: { caseId: application._id } }), row(2, { type: "payout_released", payload: { caseId: withdrawn._id } }), row(1, { type: "message", payload: { caseId: withdrawn._id } })]);
    const initial = await page({ limit: "1" });
    const older = await page({ cursor: initial.nextCursor });
    expect(older.items.map(item => item.type)).toEqual(["case_invite", "case_update", "payout_released"]);
    expect(older.items[2].action.href).toBe(`/dashboard-paralegal.html?highlightCase=${withdrawn._id}#cases-completed`);
    expect(older.hasMore).toBe(false);
  });

  test("self-message suppression and account scoping apply to every page", async () => {
    const caseDoc = await invitedMatter();
    await Notification.collection.insertMany([row(3), row(2, { type: "message", actorUserId: recipient.user._id, payload: { caseId: caseDoc._id } }), row(1, { userId: other.user._id }), row(0)]);
    const initial = await page({ limit: "1" });
    const older = await page({ cursor: initial.nextCursor });
    expect(older.items.map(item => item.id)).toEqual([String(row(0)._id)]);
    expect(await count()).toBe(2);
  });

  test("cursors cannot switch recipient or unread mode and tampering is rejected", async () => {
    await seed(3);
    const initial = await page({ limit: "1" });
    expect((await getPage({ cursor: initial.nextCursor }, other)).status).toBe(400);
    expect((await getPage({ cursor: initial.nextCursor, unread: "1" })).status).toBe(400);
    const last = initial.nextCursor.at(-1);
    const changed = initial.nextCursor.slice(0, -1) + (last === "A" ? "B" : "A");
    expect((await getPage({ cursor: changed })).status).toBe(400);
    expect(await count()).toBe(3);
  });

  test.each(["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=abc", "limit=", "limit=01", "limit=2&limit=3", "limit[x]=2", "unread=0", "unread=true", "unread=1&unread=1", "cursor=", "cursor=not-a-cursor", "cursor[x]=bad", "future=1"])("invalid query %s is an explicit failure", async query => {
    const response = await request(app).get(`/api/notifications/page?${query}`).set("Cookie", recipient.cookie);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty("items");
  });

  test("an oversized cursor is rejected without a successful empty page", async () => {
    const response = await getPage({ cursor: "a".repeat(2000) });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty("items");
  });

  test("missing or revoked sessions and changed approval cannot retrieve a page", async () => {
    await seed(2);
    expect((await request(app).get("/api/notifications/page")).status).toBe(401);
    const initial = await page({ limit: "1" });
    await revokeSession(recipient.sessionId, recipient.user._id, "synthetic-pagination-test");
    expect((await getPage({ cursor: initial.nextCursor })).status).toBe(403);
    await User.updateOne({ _id: other.user._id }, { $set: { status: "pending" } });
    expect((await getPage({}, other)).status).toBe(403);
  });

  test("an unavailable Case lookup stays a retryable error, not a terminal empty page", async () => {
    const caseDoc = await invitedMatter();
    await seed(1, { type: "case_invite", payload: { caseId: caseDoc._id } });
    jest.spyOn(Case, "find").mockImplementation(() => { throw new Error("Synthetic lookup failure"); });
    const response = await getPage();
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty("items");
    expect(await Notification.countDocuments()).toBe(1);
  });

  test("the initialized recipient/date/id index serves the ordered recipient query", async () => {
    await seed(3);
    const indexes = await Notification.collection.indexes();
    const index = indexes.find(entry => JSON.stringify(entry.key) === JSON.stringify({ userId: 1, createdAt: -1, _id: -1 }));
    expect(index).toBeDefined();
    const plan = await Notification.collection.find({ userId: recipient.user._id })
      .sort({ createdAt: -1, _id: -1 }).explain("queryPlanner");
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(index.name);
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toMatch(/"stage":"(?:SORT|COLLSCAN)"/);
  });
});

describe("notification mutation account binding", () => {
  test.each(["/api/notifications/page", "/api/notifications", "/api/notifications/unread-count"])(
    "%s binds the initial read to an optional expected account",
    async endpoint => {
      await seed(1);
      const wrong = await request(app).get(endpoint).query({ expectedOwnerId: String(recipient.user._id) }).set("Cookie", other.cookie);
      expect(wrong.status).toBe(403);
      expect(wrong.body).not.toHaveProperty("items");
      expect(wrong.body).not.toHaveProperty("count");
      const malformed = await request(app).get(endpoint).query({ expectedOwnerId: [String(recipient.user._id), String(other.user._id)] }).set("Cookie", recipient.cookie);
      expect(malformed.status).toBe(400);
      const own = await request(app).get(endpoint).query({ expectedOwnerId: String(recipient.user._id) }).set("Cookie", recipient.cookie);
      expect(own.status).toBe(200);
    }
  );

  test.each(["read", "read-all", "dismiss", "clear"])("%s rejects the previous account's expectedOwnerId without writing", async action => {
    await seed(1);
    await Notification.collection.insertOne(row(2, { userId: other.user._id }));
    const endpoint = action === "read" ? `/api/notifications/${row(2)._id}/read` : action === "read-all" ? "/api/notifications/read-all" : action === "dismiss" ? `/api/notifications/${row(2)._id}` : "/api/notifications";
    const method = ["dismiss", "clear"].includes(action) ? "delete" : "post";
    const response = await request(app)[method](endpoint).set("Cookie", other.cookie).send({ expectedOwnerId: String(recipient.user._id) });
    expect(response.status).toBe(403);
    expect(await Notification.countDocuments()).toBe(2);
    expect(await Notification.countDocuments({ $or: [{ read: true }, { isRead: true }] })).toBe(0);
  });

  test.each([null, "", 42, {}, "not-an-id"])("malformed expectedOwnerId %j is rejected", async expectedOwnerId => {
    await seed(1);
    expect((await request(app).delete("/api/notifications").set("Cookie", recipient.cookie).send({ expectedOwnerId })).status).toBe(400);
    expect(await Notification.countDocuments()).toBe(1);
  });

  test("matching expectations support all four mutations and old consumers remain compatible", async () => {
    await seed(4);
    await Notification.collection.insertOne(row(10, { userId: other.user._id }));
    const expectation = { expectedOwnerId: String(recipient.user._id) };
    expect((await request(app).post(`/api/notifications/${row(0)._id}/read`).set("Cookie", recipient.cookie).send(expectation)).status).toBe(200);
    expect(await count()).toBe(3);
    expect((await request(app).post("/api/notifications/read-all").set("Cookie", recipient.cookie).send(expectation)).status).toBe(200);
    expect(await count()).toBe(0);
    expect((await request(app).delete(`/api/notifications/${row(1)._id}`).set("Cookie", recipient.cookie).send(expectation)).status).toBe(200);
    expect((await request(app).delete("/api/notifications").set("Cookie", recipient.cookie).send(expectation)).status).toBe(200);
    expect(await Notification.countDocuments()).toBe(1);
    expect((await request(app).post("/api/notifications/read-all").set("Cookie", other.cookie).send({})).status).toBe(200);
    expect(await count(other)).toBe(0);
    expect((await request(app).delete("/api/notifications").set("Cookie", other.cookie)).status).toBe(200);
    expect(await Notification.countDocuments()).toBe(0);
  });
});


test("mark unread persists both flags and enforces recipient and account binding", async () => {
  const [record] = await seed(1, {read:true, isRead:true});
  const path = `/api/notifications/${record._id}/unread`;
  expect((await request(app).post(path).set("Cookie", other.cookie).send({expectedOwnerId:String(other.user._id)})).status).toBe(404);
  expect((await request(app).post(path).set("Cookie", recipient.cookie).send({expectedOwnerId:String(other.user._id)})).status).toBe(403);
  expect(await count()).toBe(0);
  expect((await request(app).post(path).set("Cookie", recipient.cookie).send({expectedOwnerId:String(recipient.user._id)})).status).toBe(200);
  const saved = await Notification.findById(record._id).lean();
  expect(saved.read).toBe(false);
  expect(saved.isRead).toBe(false);
  expect(await count()).toBe(1);
  expect((await request(app).post('/api/notifications/invalid/unread').set("Cookie", recipient.cookie).send({})).status).toBe(400);
});
