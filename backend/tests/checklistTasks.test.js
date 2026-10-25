const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const AuditLog = require("../models/AuditLog");
const Case = require("../models/Case");
const ChecklistTask = require("../models/ChecklistTask");
const User = require("../models/User");
const checklistRouter = require("../routes/checklist");
const { finalizeAccountDataRemoval } = require("../services/userDeletion");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/checklist", checklistRouter);

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
    firstName: role === "attorney" ? "Alex" : "Priya",
    lastName: "Checklist",
    email: `${role}-${suffix}@example.com`,
    password: "a sufficiently long test passphrase",
    role,
    status: "approved",
    state: "DE",
    emailVerified: true,
  });
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("personal checklist tasks", () => {
  test("creates, lists, toggles, and deletes an owner-scoped private task", async () => {
    const attorney = await approvedUser("attorney", "owner");
    const createResponse = await request(app)
      .post("/api/checklist")
      .set("Cookie", authCookie(attorney))
      .send({
        title: "Prepare filing packet",
        notes: "Confirm all exhibits before filing.",
        due: "2026-08-20T16:00:00.000Z",
      });

    expect(createResponse.status).toBe(201);
    const task = await ChecklistTask.findById(createResponse.body.id).lean();
    expect(task).toMatchObject({
      owner: attorney._id,
      title: "Prepare filing packet",
      notes: "Confirm all exhibits before filing.",
      done: false,
    });

    const listResponse = await request(app)
      .get("/api/checklist?status=all")
      .set("Cookie", authCookie(attorney));
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.total).toBe(1);
    expect(listResponse.body.items[0]).toMatchObject({ title: "Prepare filing packet", done: false });

    const toggleResponse = await request(app)
      .post(`/api/checklist/${task._id}/toggle`)
      .set("Cookie", authCookie(attorney));
    expect(toggleResponse.status).toBe(200);
    expect(toggleResponse.body.done).toBe(true);
    expect(toggleResponse.body.completedAt).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: "task.toggle", targetId: task._id })).toBe(1);

    const deleteResponse = await request(app)
      .delete(`/api/checklist/${task._id}`)
      .set("Cookie", authCookie(attorney));
    expect(deleteResponse.status).toBe(200);
    expect(await ChecklistTask.findById(task._id)).toBeNull();
    expect(await AuditLog.countDocuments({ action: "task.delete", targetId: task._id })).toBe(1);
  });

  test("allows a private task to reference an active hired matter without changing matter scope", async () => {
    const attorney = await approvedUser("attorney", "matter-owner");
    const paralegal = await approvedUser("paralegal", "matter-worker");
    const matter = await Case.create({
      title: "Commercial filing",
      details: "Prepare and organize a commercial filing.",
      status: "in_progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      hiredAt: new Date(),
      tasksLocked: true,
      escrowIntentId: "pi_checklist_funded",
      escrowStatus: "funded",
      totalAmount: 120000,
      currency: "usd",
      tasks: [{ title: "File the formation packet", completed: false }],
    });

    const response = await request(app)
      .post("/api/checklist")
      .set("Cookie", authCookie(attorney))
      .send({ title: "Call client after filing", caseId: String(matter._id) });

    expect(response.status).toBe(201);
    const [personalTask, unchangedMatter] = await Promise.all([
      ChecklistTask.findById(response.body.id).lean(),
      Case.findById(matter._id).lean(),
    ]);
    expect(personalTask.caseId).toEqual(matter._id);
    expect(unchangedMatter.tasks).toHaveLength(1);
    expect(unchangedMatter.tasks[0].title).toBe("File the formation packet");
  });

  test("prevents unrelated users from linking, reading by case filter, or mutating another owner's task", async () => {
    const owner = await approvedUser("attorney", "private-owner");
    const unrelated = await approvedUser("attorney", "unrelated");
    const matter = await Case.create({
      title: "Private matter",
      details: "Owner-only checklist test matter.",
      status: "open",
      attorney: owner._id,
      attorneyId: owner._id,
      totalAmount: 100000,
      currency: "usd",
    });
    const task = await ChecklistTask.create({
      owner: owner._id,
      caseId: matter._id,
      title: "Private attorney note",
    });

    const createResponse = await request(app)
      .post("/api/checklist")
      .set("Cookie", authCookie(unrelated))
      .send({ title: "Unauthorized link", caseId: String(matter._id) });
    expect(createResponse.status).toBe(403);

    const listResponse = await request(app)
      .get(`/api/checklist?status=all&caseId=${matter._id}`)
      .set("Cookie", authCookie(unrelated));
    expect(listResponse.status).toBe(403);

    const toggleResponse = await request(app)
      .post(`/api/checklist/${task._id}/toggle`)
      .set("Cookie", authCookie(unrelated));
    expect(toggleResponse.status).toBe(404);
    expect((await ChecklistTask.findById(task._id).lean()).done).toBe(false);
  });

  test("rejects malformed task fields instead of turning validation mistakes into server errors", async () => {
    const attorney = await approvedUser("attorney", "validation");
    const cookie = authCookie(attorney);

    const invalidDate = await request(app)
      .post("/api/checklist")
      .set("Cookie", cookie)
      .send({ title: "Bad date", due: "not-a-date" });
    expect(invalidDate.status).toBe(400);

    const ambiguousDate = await request(app)
      .post("/api/checklist")
      .set("Cookie", cookie)
      .send({ title: "No timezone", due: "2026-08-20T16:00" });
    expect(ambiguousDate.status).toBe(400);

    const impossibleDate = await request(app)
      .post("/api/checklist")
      .set("Cookie", cookie)
      .send({ title: "Impossible date", due: "2026-02-31T16:00:00.000Z" });
    expect(impossibleDate.status).toBe(400);

    const unsupportedField = await request(app)
      .post("/api/checklist")
      .set("Cookie", cookie)
      .send({ title: "Speculative field", priority: "urgent" });
    expect(unsupportedField.status).toBe(400);

    const invalidTitleType = await request(app)
      .post("/api/checklist")
      .set("Cookie", cookie)
      .send({ title: { value: "Coerced title" } });
    expect(invalidTitleType.status).toBe(400);

    const invalidCase = await request(app)
      .post("/api/checklist")
      .set("Cookie", cookie)
      .send({ title: "Bad matter", caseId: "not-an-object-id" });
    expect(invalidCase.status).toBe(400);
    expect(await ChecklistTask.countDocuments()).toBe(0);
  });

  test("paginates deterministically and rejects silently coerced list parameters", async () => {
    const attorney = await approvedUser("attorney", "pagination");
    const cookie = authCookie(attorney);
    await ChecklistTask.insertMany(
      Array.from({ length: 101 }, (_, index) => ({ owner: attorney._id, title: `Private task ${index + 1}` }))
    );

    const firstPage = await request(app)
      .get("/api/checklist?status=all&limit=100&page=1")
      .set("Cookie", cookie);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toMatchObject({ page: 1, limit: 100, total: 101, pages: 2 });
    expect(firstPage.body.items).toHaveLength(100);

    const secondPage = await request(app)
      .get("/api/checklist?status=all&limit=100&page=2")
      .set("Cookie", cookie);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);

    const [oversized, malformedPage, ignoredBoolean] = await Promise.all([
      request(app).get("/api/checklist?limit=101").set("Cookie", cookie),
      request(app).get("/api/checklist?page=1.5").set("Cookie", cookie),
      request(app).get("/api/checklist?overdue=false").set("Cookie", cookie),
    ]);
    expect(oversized.status).toBe(400);
    expect(malformedPage.status).toBe(400);
    expect(ignoredBoolean.status).toBe(400);
  });

  test("keeps the private task API attorney-only", async () => {
    const paralegal = await approvedUser("paralegal", "role-boundary");

    const [listResponse, createResponse] = await Promise.all([
      request(app).get("/api/checklist").set("Cookie", authCookie(paralegal)),
      request(app)
        .post("/api/checklist")
        .set("Cookie", authCookie(paralegal))
        .send({ title: "Should not exist" }),
    ]);

    expect(listResponse.status).toBe(403);
    expect(createResponse.status).toBe(403);
    expect(await ChecklistTask.countDocuments()).toBe(0);
  });

  test("removes personal checklist data during final account-data removal", async () => {
    const attorney = await approvedUser("attorney", "removal");
    await ChecklistTask.create({ owner: attorney._id, title: "Private personal task" });
    attorney.disabled = true;
    attorney.deleted = true;
    attorney.deletedAt = new Date();
    await attorney.save();

    const result = await finalizeAccountDataRemoval(attorney._id);

    expect(result.mode).toBe("purged");
    expect(await ChecklistTask.countDocuments({ owner: attorney._id })).toBe(0);
    expect(await User.findById(attorney._id)).toBeNull();
  });
});
