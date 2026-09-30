const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const AuditLog = require("../models/AuditLog");
const Case = require("../models/Case");
const Event = require("../models/Event");
const Notification = require("../models/Notification");
const User = require("../models/User");
const eventsRouter = require("../routes/events");
const { addSubscriber } = require("../utils/notificationEvents");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/events", eventsRouter);

function authCookie(user) {
  const token = jwt.sign({
    id: String(user._id),
    role: user.role,
    email: user.email,
    status: user.status,
    av: Number(user.authVersion || 0),
  }, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function approvedUser(role, suffix) {
  return User.create({
    firstName: role === "attorney" ? "Avery" : "Parker",
    lastName: "Deadline",
    email: `${role}-${suffix}@example.com`,
    password: "a sufficiently long test passphrase",
    role,
    status: "approved",
    state: "DE",
    emailVerified: true,
  });
}

async function activeMatter(attorney, paralegal) {
  return Case.create({
    title: "Deadline authority Matter",
    details: "Characterize shared dates and owner-specific reminders.",
    status: "in_progress",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    hiredAt: new Date("2026-09-01T12:00:00.000Z"),
    tasksLocked: true,
    escrowIntentId: "pi_deadline_authority",
    escrowStatus: "funded",
    totalAmount: 100000,
    currency: "usd",
    deadlineDate: "2026-09-20",
    deadline: new Date("2026-09-20T12:00:00.000Z"),
  });
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("Matter-linked calendar Event authority", () => {
  test("rejects query operators and oversized event searches", async () => {
    const owner = await approvedUser("attorney", "filters");
    const cookie = authCookie(owner);
    const operator = await request(app).get("/api/events?type%5B%24ne%5D=deadline").set("Cookie", cookie);
    const oversized = await request(app).get(`/api/events?q=${"a".repeat(201)}`).set("Cookie", cookie);
    expect(operator.status).toBe(400);
    expect(oversized.status).toBe(400);
  });

  test.each(["attorney", "paralegal"])("%s reminder pages retain owner scope and stable date ties beyond fifty records", async role => {
    const owner = await approvedUser(role, "paged"), other = await approvedUser(role, "other");
    const records = Array.from({ length: 203 }, (_, index) => ({
      _id: (index + 1).toString(16).padStart(24, "0"), owner: owner._id,
      title: `Reminder ${index + 1}`, type: "deadline", start: new Date("2027-01-12T12:00:00Z"), isAllDay: true,
    }));
    await Event.insertMany([...records].reverse());
    await Event.create({ owner: other._id, title: "Other account reminder", type: "deadline", start: new Date("2027-01-12T12:00:00Z") });
    const query = { expectedOwnerId: String(owner._id), from: "2026-08-01", to: "2027-02-01", type: "deadline", limit: 200 };
    const first = await request(app).get("/api/events").query({ ...query, page: 1 }).set("Cookie", authCookie(owner));
    const second = await request(app).get("/api/events").query({ ...query, page: 2 }).set("Cookie", authCookie(owner));
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.body).toMatchObject({ ownerId: String(owner._id), page: 1, limit: 200, total: 203, pages: 2 });
    expect(second.body).toMatchObject({ ownerId: String(owner._id), page: 2, total: 203, pages: 2 });
    expect([...first.body.items, ...second.body.items].map(item => item.id)).toEqual(records.map(item => item._id));
    expect(await AuditLog.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
  });

  test("rejects an unexpected read account and invalid date windows, including empty accounts", async () => {
    const owner = await approvedUser("paralegal", "range-owner"), other = await approvedUser("paralegal", "range-other");
    const wrongOwner = await request(app).get("/api/events").query({ expectedOwnerId: String(other._id) }).set("Cookie", authCookie(owner));
    expect(wrongOwner.status).toBe(403); expect(wrongOwner.body).toMatchObject({ code: "EVENT_ACCOUNT_CHANGED" });
    for (const query of [{ from: "invalid" }, { to: "invalid" }, { from: "2027-02-01", to: "2026-08-01" }]) {
      const result = await request(app).get("/api/events").query(query).set("Cookie", authCookie(owner));
      expect(result.status).toBe(400);
    }
    const empty = await request(app).get("/api/events").query({ expectedOwnerId: String(owner._id) }).set("Cookie", authCookie(owner));
    expect(empty.status).toBe(200); expect(empty.body).toMatchObject({ ownerId: String(owner._id), total: 0, pages: 0, items: [] });
  });

  test("keeps Matter deadlines unchanged while each participant owns a separate private reminder list", async () => {
    const attorney = await approvedUser("attorney", "owner");
    const paralegal = await approvedUser("paralegal", "worker");
    const matter = await activeMatter(attorney, paralegal);
    const paralegalCookie = authCookie(paralegal);
    const attorneyCookie = authCookie(attorney);

    const createResponse = await request(app)
      .post("/api/events")
      .set("Cookie", paralegalCookie)
      .send({
        title: "Check final exhibits",
        start: "2026-09-18T12:00:00.000Z",
        end: "2026-09-18T12:00:00.000Z",
        type: "deadline",
        caseId: String(matter._id),
        isAllDay: true,
        visibility: "private",
      });
    expect(createResponse.status).toBe(201);

    const [paralegalList, attorneyList, unchangedMatter] = await Promise.all([
      request(app)
        .get(`/api/events?caseId=${matter._id}&type=deadline&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`)
        .set("Cookie", paralegalCookie),
      request(app)
        .get(`/api/events?caseId=${matter._id}&type=deadline&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`)
        .set("Cookie", attorneyCookie),
      Case.findById(matter._id).lean(),
    ]);

    expect(paralegalList.status).toBe(200);
    expect(paralegalList.body.items).toHaveLength(1);
    expect(paralegalList.body.items[0]).toMatchObject({
      title: "Check final exhibits",
      type: "deadline",
      visibility: "private",
      owner: String(paralegal._id),
    });
    expect(attorneyList.status).toBe(200);
    expect(attorneyList.body.items).toHaveLength(0);
    expect(unchangedMatter.deadlineDate).toBe("2026-09-20");
    expect(unchangedMatter.deadline.toISOString()).toBe(matter.deadline.toISOString());
    expect(await Notification.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: "calendar.event.create" })).toBe(1);
  });

  test("permits owner edit and delete, hides records from the other participant, and writes audit evidence", async () => {
    const attorney = await approvedUser("attorney", "edit-owner");
    const paralegal = await approvedUser("paralegal", "edit-worker");
    const matter = await activeMatter(attorney, paralegal);
    const event = await Event.create({
      owner: paralegal._id,
      caseId: matter._id,
      title: "Review citations",
      start: new Date("2026-09-17T12:00:00.000Z"),
      type: "deadline",
      visibility: "private",
      isAllDay: true,
    });

    const hiddenPatch = await request(app)
      .patch(`/api/events/${event._id}`)
      .set("Cookie", authCookie(attorney))
      .send({ title: "Attorney overwrite" });
    expect(hiddenPatch.status).toBe(404);

    const editResponse = await request(app)
      .patch(`/api/events/${event._id}`)
      .set("Cookie", authCookie(paralegal))
      .send({
        title: "Review final citations",
        start: "2026-09-19T12:00:00.000Z",
        end: "2026-09-19T12:00:00.000Z",
        caseId: String(matter._id),
      });
    expect(editResponse.status).toBe(200);
    expect(await Event.findById(event._id).lean()).toMatchObject({ title: "Review final citations" });

    const hiddenDelete = await request(app)
      .delete(`/api/events/${event._id}`)
      .set("Cookie", authCookie(attorney));
    expect(hiddenDelete.status).toBe(404);

    const deleteResponse = await request(app)
      .delete(`/api/events/${event._id}`)
      .set("Cookie", authCookie(paralegal));
    expect(deleteResponse.status).toBe(200);
    expect(await Event.findById(event._id)).toBeNull();
    expect(await AuditLog.countDocuments({ action: "calendar.event.update", targetId: event._id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: "calendar.event.delete", targetId: event._id })).toBe(1);
  });

  test("rejects an unrelated Matter link and a stale linked edit after participant access is revoked", async () => {
    const attorney = await approvedUser("attorney", "access-owner");
    const paralegal = await approvedUser("paralegal", "access-worker");
    const unrelated = await approvedUser("paralegal", "unrelated");
    const matter = await activeMatter(attorney, paralegal);
    const event = await Event.create({
      owner: paralegal._id,
      caseId: matter._id,
      title: "Private deadline note",
      start: new Date("2026-09-17T12:00:00.000Z"),
      type: "deadline",
    });

    const unrelatedCreate = await request(app)
      .post("/api/events")
      .set("Cookie", authCookie(unrelated))
      .send({ title: "Unauthorized reminder", start: "2026-09-18T12:00:00.000Z", type: "deadline", caseId: String(matter._id) });
    expect(unrelatedCreate.status).toBe(403);

    await Case.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });

    const staleList = await request(app)
      .get(`/api/events?caseId=${matter._id}&type=deadline`)
      .set("Cookie", authCookie(paralegal));
    expect(staleList.status).toBe(403);

    const stalePatch = await request(app)
      .patch(`/api/events/${event._id}`)
      .set("Cookie", authCookie(paralegal))
      .send({ title: "Stale edit" });
    expect(stalePatch.status).toBe(403);
    expect((await Event.findById(event._id).lean()).title).toBe("Private deadline note");

    const staleDelete = await request(app)
      .delete(`/api/events/${event._id}`)
      .set("Cookie", authCookie(paralegal));
    expect(staleDelete.status).toBe(403);
    expect(await Event.findById(event._id)).toBeTruthy();
  });

  test("publishes immediate owner refresh events after private reminder mutations", async () => {
    const attorney = await approvedUser("attorney", "refresh-owner");
    const paralegal = await approvedUser("paralegal", "refresh-worker");
    const matter = await activeMatter(attorney, paralegal);
    const writes = [];
    const unsubscribe = addSubscriber(paralegal._id, { write: (value) => writes.push(String(value)) });

    const created = await request(app)
      .post("/api/events")
      .set("Cookie", authCookie(paralegal))
      .send({
        title: "Live private reminder",
        start: "2026-09-18T12:00:00.000Z",
        type: "deadline",
        caseId: String(matter._id),
      });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/events/${created.body.id}`)
      .set("Cookie", authCookie(paralegal))
      .send({ title: "Updated live private reminder" });
    expect(updated.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/events/${created.body.id}`)
      .set("Cookie", authCookie(paralegal));
    expect(deleted.status).toBe(200);
    unsubscribe();

    const stream = writes.join("\n");
    expect(stream).toContain("calendar_event_created_refresh");
    expect(stream).toContain("calendar_event_updated_refresh");
    expect(stream).toContain("calendar_event_deleted_refresh");
  });

  test("has no authoritative completion state or automatic deadline notification side effect", () => {
    expect(Event.schema.path("status")).toBeUndefined();
    expect(Event.schema.path("completedAt")).toBeUndefined();
    expect(Event.schema.path("type").enumValues).toEqual(["deadline", "meeting", "call", "court", "misc"]);
  });
});
