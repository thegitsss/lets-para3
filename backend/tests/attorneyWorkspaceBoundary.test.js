process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_workspace";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const Case = require("../models/Case"), User = require("../models/User"), boundary = require("../services/attorneyWorkspaceBoundary");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, admin, matter;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@workspace.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Private River Street Matter", details: "Confidential lease review details", attorney: owner._id, attorneyId: owner._id, tasks: [{ title: "Review lease" }], totalAmount: 40000 });
});
const read = (user = owner, query = `expectedOwnerId=${user._id}`) => request(app).get(`/api/cases/${matter._id}?${query}`).set("Cookie", cookie(user));
test("the strict workspace returns the same permitted Matter fields and does not expose its guard", async () => {
  const legacy = await read(owner, ""), strict = await read(); expect(legacy.status).toBe(200); expect(strict.status).toBe(200); expect(strict.headers["cache-control"]).toBe("private, no-store"); expect(strict.body).toEqual(legacy.body); expect(strict.body.workspaceSnapshot).toBeUndefined();
});
test("wrong owner, wrong role and foreign account expectations do not return Matter contents", async () => {
  for (const [user, query] of [[other, `expectedOwnerId=${other._id}`], [para, `expectedOwnerId=${owner._id}`], [admin, `expectedOwnerId=${admin._id}`], [owner, `expectedOwnerId=${other._id}`]]) { const result = await read(user, query); expect([403,404]).toContain(result.status); expect(result.body.title).toBeUndefined(); expect(result.body.details).toBeUndefined(); }
  expect((await read(admin, "")).status).toBe(200);
});
test("ownership lost while assembling a Matter discards the earlier confidential response", async () => {
  const finish = boundary.finish; jest.spyOn(boundary, "finish").mockImplementationOnce(async (req, before) => { await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: other._id, attorneyId: other._id } }); return finish(req, before); });
  const response = await read(); expect(response.status).toBe(403); expect(response.body.code).toBe("WORKSPACE_RESTRICTED"); expect(JSON.stringify(response.body)).not.toContain(matter.title);
});
test.each(["authVersion", "disabled", "deleted", "status"])("a changed %s during the protected read withholds the Matter", async field => {
  const finish = boundary.finish; jest.spyOn(boundary, "finish").mockImplementationOnce(async (req, before) => { await User.collection.updateOne({ _id: owner._id }, { $set: { [field]: field === "authVersion" ? 1 : field === "status" ? "pending" : true } }); return finish(req, before); });
  const response = await read(); expect(response.status).toBe(403); expect(response.body.code).toBe("WORKSPACE_ACCOUNT_CHANGED"); expect(response.body.details).toBeUndefined();
});
test("work or lifecycle changes during assembly require a fresh Matter read", async () => {
  const finish = boundary.finish; jest.spyOn(boundary, "finish").mockImplementationOnce(async (req, before) => { await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.0.completed": true } }); return finish(req, before); });
  const response = await read(); expect(response.status).toBe(409); expect(response.body.code).toBe("WORKSPACE_CHANGED"); expect(response.body.tasks).toBeUndefined(); expect((await read()).body.tasks[0].completed).toBe(true);
});
test("unknown workspace query fields cannot widen the read contract", async () => { expect((await read(owner, `expectedOwnerId=${owner._id}&includePrivate=true`)).status).toBe(400); });

test("the same approved paralegal account-bound public posting stays limited to its original public projection", async () => {
  const legacy = await read(para, ""), scoped = await read(para);
  expect(scoped.status).toBe(200); expect(scoped.body).toEqual(legacy.body);
  expect(scoped.body.matterExperience).toMatchObject({ financials: null, work: null, applications: null });
  expect(scoped.body).toMatchObject({ tasks: [], files: [], paralegal: null, submissionSummary: null, paymentReleased: false, escrowStatus: null, zoomLink: "", partialPayoutAmount: null });
});
test("an unassigned paralegal cannot use its expected account to read an active private Matter", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "in progress" } });
  const response = await read(para); expect([403,404]).toContain(response.status);
  expect(response.body.title).toBeUndefined(); expect(response.body.details).toBeUndefined();
});
