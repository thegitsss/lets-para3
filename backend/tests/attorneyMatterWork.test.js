process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_work";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const Case = require("../models/Case"), User = require("../models/User"), account = require("../services/attorneyAccountBoundary");
const app = express(); app.use(cookieParser(), express.json());
const authenticationFailures = [];
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode === 401) authenticationFailures.push({ method: req.method, path: req.originalUrl, cookieHeaderPresent: Boolean(req.headers.cookie), tokenParsed: Boolean(req.cookies?.token), userPresent: Boolean(req.user), authPresent: Boolean(req.auth) });
  });
  next();
});
app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, matter;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  authenticationFailures.length = 0;
  await clearDatabase(); [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@work.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Lease work review", practiceArea: "contract law", state: "New York", details: "Review the lease and exhibits.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, tasks: [{ title: "Review exhibit", completed: false }, { title: "Review exhibit", completed: false }], tasksLocked: true, hiredAt: new Date(), status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_work", totalAmount: 40000 });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.0.retainedEvidence": { source: "original", unknownField: 42 }, "tasks.1.retainedEvidence": "Keep this too" } });
});
const read = (user = owner) => request(app).get(`/api/cases/${matter._id}/work-review`).query({ expectedOwnerId: String(user._id) }).set("Cookie", cookie(user));
const update = (review, index = 0, completed = true, user = owner) => request(app).post(`/api/cases/${matter._id}/work-review`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), reviewedRevision: review.revision, index, completed });
const legacy = body => request(app).patch(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)).send(body);
test("completion changes the selected duplicate-title item and preserves all task and Matter metadata", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), review = await read(); expect(review.status).toBe(200);
  const result = await update(review.body, 1); expect(result.status).toBe(200); expect(result.body.work.items.map(item => item.completed)).toEqual([false, true]);
  const after = await Case.collection.findOne({ _id: matter._id }); expect(after.tasks[0]).toEqual(before.tasks[0]); expect(after.tasks[1]).toEqual({ ...before.tasks[1], completed: true }); expect(after.escrowIntentId).toBe(before.escrowIntentId); expect(after.totalAmount).toBe(before.totalAmount); expect(after.taskRevision).toBe(Number(before.taskRevision || 0) + 1);
});
test("the current-client and paralegal reads see a recorded task change", async () => {
  const review = (await read()).body; expect((await update(review)).status).toBe(200);
  for (const user of [owner, para]) { const response = await request(app).get(`/api/cases/${matter._id}`).set("Cookie", cookie(user)); expect(response.status).toBe(200); expect(response.body.tasks[0].completed).toBe(true); expect(response.body.taskRevision).toBe(1); }
});
test("a stale review cannot overwrite another tab's work or a replacement assignment", async () => {
  const original = (await read()).body; expect((await update(original)).status).toBe(200); expect((await update(original, 1)).status).toBe(409);
  const current = (await read()).body; await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: other._id, paralegalId: other._id } }); expect((await update(current, 1)).status).toBe(409);
  expect((await Case.collection.findOne({ _id: matter._id })).tasks.map(task => task.completed)).toEqual([true, false]);
});
test.each(["paused", "completed", "closed", "disputed"])("%s work remains readable and cannot be modified", async status => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status } }); const response = await read(); expect(response.status).toBe(200); expect(response.body.canToggle).toBe(false); expect((await update(response.body)).status).toBe(403);
});
test("completion claims, read-only flags, archives and missing funding deny work changes", async () => {
  for (const patch of [{ completionClaimStatus: "claimed" }, { readOnly: true }, { archived: true }, { escrowStatus: "unfunded" }]) {
    await Case.collection.updateOne({ _id: matter._id }, { $set: { completionClaimStatus: null, readOnly: false, archived: false, escrowStatus: "funded", ...patch } }); const response = await read(); expect(response.body.canToggle).toBe(false); expect((await update(response.body)).status).toBe(403);
  }
});
test("completed work cannot be reopened after withdrawal and rehire, but remaining work can be reviewed", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: other._id, "tasks.0.completed": true } }); const review = (await read()).body; expect(review.items.map(item => item.canToggle)).toEqual([false, true]); expect((await update(review, 0, false)).status).toBe(403); expect((await update(review, 1, true)).status).toBe(200);
});
test("wrong role, owner, expected account and invalid indices never write", async () => {
  expect([403, 404]).toContain((await read(other)).status); expect((await read(para)).status).toBe(403);
  const review = (await read()).body; expect((await update(review, 0, true, para)).status).toBe(403); expect((await update(review, -1)).status).toBe(400); expect((await update(review, 90)).status).toBe(403); expect((await update({ revision: "unknown" })).status).toBe(400); expect((await Case.findById(matter._id)).tasks.every(task => !task.completed)).toBe(true);
});
test("withdrawal winning immediately before the task write prevents a late completion change", async () => {
  const initial = await read();
  expect({ status: initial.status, failure: initial.status === 200 ? null : initial.body, authenticationFailures }).toEqual({ status: 200, failure: null, authenticationFailures: [] });
  const review = initial.body, write = Case.collection.updateOne.bind(Case.collection); let withdrawn = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, change, options) => {
    if (!withdrawn && change?.$set?.["tasks.0"]) { withdrawn = true; const response = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", cookie(para)); expect(response.status).toBe(200); }
    return write(filter, change, options);
  });
  const response = await update(review);
  expect({ status: response.status, failure: response.status === 409 ? null : response.body, authenticationFailures }).toEqual({ status: 409, failure: null, authenticationFailures: [] });
  const after = await Case.collection.findOne({ _id: matter._id }); expect(after.status).toBe("paused"); expect(after.tasks[0].completed).toBe(false); expect(after.payoutFinalizedType).toBe("zero_auto");
});
test("a completion claim winning immediately before the task write keeps its reviewed work unchanged", async () => {
  const review = (await read()).body, write = Case.collection.updateOne.bind(Case.collection); let claimed = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, change, options) => { if (!claimed && change?.$set?.["tasks.0"]) { claimed = true; await write({ _id: matter._id }, { $set: { completionClaimStatus: "claimed" } }); } return write(filter, change, options); });
  expect((await update(review)).status).toBe(409); expect((await Case.findById(matter._id)).tasks[0].completed).toBe(false);
});
test("revocation just before writing prevents the task change", async () => {
  const review = (await read()).body, original = account.read; let calls = 0;
  jest.spyOn(account, "read").mockImplementation(async (...args) => { if (++calls === 2) await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return original(...args); });
  expect((await update(review)).status).toBe(403); expect((await Case.findById(matter._id)).tasks[0].completed).toBe(false);
});
test("existing task-list writes preserve metadata and reject an earlier displayed revision", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }); const tasks = before.tasks.map(task => ({ title: task.title, completed: true }));
  const response = await legacy({ tasks, expectedTaskRevision: 0 }); expect(response.status).toBe(200); expect(response.body.taskRevision).toBe(1); const after = await Case.collection.findOne({ _id: matter._id }); expect(after.tasks).toEqual(before.tasks.map(task => ({ ...task, completed: true })));
  expect((await legacy({ tasks: tasks.map(task => ({ ...task, completed: false })), expectedTaskRevision: 0 })).status).toBe(409);
});
test("existing clients cannot update work after withdrawal wins the final write", async () => {
  const write = Case.collection.updateOne.bind(Case.collection); let withdrawn = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, change, options) => {
    if (!withdrawn && Array.isArray(change?.$set?.tasks)) { withdrawn = true; const response = await request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", cookie(para)); expect(response.status).toBe(200); } return write(filter, change, options);
  });
  const response = await legacy({ tasks: [{ title: "Review exhibit", completed: true }, { title: "Review exhibit", completed: false }] }); expect(response.status).toBe(409); expect((await Case.findById(matter._id)).tasks.every(task => !task.completed)).toBe(true);
});
test("earlier string scope items and completion aliases remain readable through both attorney contracts", async () => {
  const tasks = [{ title: "Earlier completed item", done: true, retainedEvidence: "Earlier evidence" }, "Earlier remaining item"];
  await Case.collection.updateOne({ _id: matter._id }, { $set: { tasks } });
  const strict = await read(); expect(strict.status).toBe(200); expect(strict.body.items.map(item => [item.title, item.completed])).toEqual([["Earlier completed item", true], ["Earlier remaining item", false]]);
  const current = await request(app).get(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)); expect(current.status).toBe(200); expect(current.body.tasks).toEqual([{ title: "Earlier completed item", completed: true }, { title: "Earlier remaining item", completed: false }]);
  const saved = await legacy({ tasks: current.body.tasks.map(task => ({ ...task, completed: true })), expectedTaskRevision: current.body.taskRevision }); expect(saved.status).toBe(200);
  const stored = await Case.collection.findOne({ _id: matter._id }); expect(stored.tasks[0]).toEqual({ ...tasks[0], completed: true }); expect(stored.tasks[1]).toEqual({ title: tasks[1], completed: true });
});
