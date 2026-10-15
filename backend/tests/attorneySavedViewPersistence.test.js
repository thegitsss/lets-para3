const express = require("express"), cookieParser = require("cookie-parser"), jwt = require("jsonwebtoken"), request = require("supertest"), crypto = require("crypto");
const User = require("../models/User"), accountRouter = require("../routes/account");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/account", accountRouter);
let user, cookie;
const scope = "attorney_matters";
const input = (name = "My view", extra = {}) => ({ scope, name, id: crypto.randomUUID(), revision: null, expectedOwnerId: String(user._id), filters: { view: "archived", archiveStatus: "paused", search: "test", practice: "Probate", deadline: "none", updated: "30_days", sort: "alphabetical" }, ...extra });
const post = (data) => request(app).post("/api/account/dashboard-views").set("Cookie", cookie).send(data);
const remove = (view, extra = {}) => request(app).delete(`/api/account/dashboard-views/${scope}/${view.id}`).set("Cookie", cookie).send({ expectedOwnerId: String(user._id), revision: view.revision, ...extra });
const read = () => request(app).get(`/api/account/dashboard-views?scope=${scope}`).set("Cookie", cookie);
const raw = () => User.collection.findOne({ _id: user._id });
beforeAll(connect);
beforeEach(async () => { await clearDatabase(); user = await User.create({ firstName: "Saved", lastName: "Views", email: "saved-atomic@example.com", password: "Password123!", role: "attorney", status: "approved" }); cookie = `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: "2h" })}`; });
afterEach(() => jest.restoreAllMocks()); afterAll(closeDatabase);

test("a create retry returns one stable view; all seven filters survive a fresh read", async () => {
  const sent = input(); const first = await post(sent), retry = await post(sent);
  expect(first.status).toBe(201); expect(retry.status).toBe(200); expect(retry.body.view).toEqual(first.body.view);
  const result = await read(); expect(result.body.ownerId).toBe(String(user._id)); expect(result.body.views).toHaveLength(1); expect(result.body.views[0].filters).toEqual(sent.filters); expect(result.headers["cache-control"]).toBe("no-store");
});
test("raw legacy metadata, unknown filters, other scopes and unrelated preferences survive updates and deletes", async () => {
  const legacy = { id: "legacy-view", scope, name: "Legacy", filters: { search: "Before", futureFilter: { keep: true } }, futureMetadata: { keep: true }, createdAt: new Date("2020-01-01") };
  const other = { id: "para-view", scope: "paralegal_applications", name: "Para", filters: { future: true }, futureMetadata: 7 };
  await User.collection.updateOne({ _id: user._id }, { $set: { "preferences.dashboardViews": [legacy, other], "preferences.future": { keep: true } } });
  const view = (await read()).body.views[0]; const changed = await post(input("Changed", { id: view.id, revision: view.revision })); expect(changed.status).toBe(200);
  const stored = (await raw()).preferences; expect(stored.future).toEqual({ keep: true }); expect(stored.dashboardViews[1]).toEqual(other); expect(stored.dashboardViews[0]).toMatchObject({ futureMetadata: { keep: true }, filters: { futureFilter: { keep: true } }, createdAt: legacy.createdAt });
  expect((await remove(changed.body.view)).status).toBe(200); expect((await raw()).preferences.dashboardViews).toEqual([other]);
});
test("stale updates and deletes cannot erase another tab's changes", async () => {
  const first = (await post(input())).body.view;
  const newer = (await post(input("Changed elsewhere", { id: first.id, revision: first.revision }))).body.view;
  expect((await post(input("Stale", { id: first.id, revision: first.revision }))).body.code).toBe("SAVED_VIEW_CONFLICT");
  expect((await remove(first)).body.code).toBe("SAVED_VIEW_CONFLICT"); expect((await read()).body.views[0]).toEqual(newer);
  expect((await remove(newer)).status).toBe(200); expect((await remove(newer)).status).toBe(404);
});
test("concurrent distinct creates survive, duplicate names and the 12-view limit remain atomic", async () => {
  const distinct = await Promise.all([post(input("First")), post(input("Second"))]); expect(distinct.map(r => r.status)).toEqual([201, 201]);
  const duplicate = await Promise.all([post(input("Duplicate")), post(input("duplicate"))]); expect(duplicate.map(r => r.status).sort()).toEqual([201, 409]);
  for (let i = 0; i < 8; i++) expect((await post(input(`Extra ${i}`))).status).toBe(201);
  const limited = await Promise.all([post(input("Final A")), post(input("Final B"))]); expect(limited.map(r => r.status).sort()).toEqual([201, 409]); expect((await read()).body.views).toHaveLength(12);
});
test.each([false, true])("preferences saved from an older snapshot retain a newly created view (missing preferences: %s)", async (missing) => {
  if (missing) await User.collection.updateOne({ _id: user._id }, { $unset: { preferences: "" } });
  const original = User.collection.updateOne.bind(User.collection); let injected = false;
  jest.spyOn(User.collection, "updateOne").mockImplementation(async (...args) => {
    if (!injected && args[1]?.$set?.["preferences.fontSize"]) { injected = true; expect((await post(input("During preferences"))).status).toBe(201); }
    return original(...args);
  });
  const result = await request(app).post("/api/account/preferences").set("Cookie", cookie).send({ fontSize: "lg", theme: "light", email: false });
  expect(result.status).toBe(200); expect((await raw()).preferences).toMatchObject({ fontSize: "lg", dashboardViews: [expect.objectContaining({ name: "During preferences" })] });
});
test("a preferences write between saved-view read and CAS is preserved", async () => {
  const original = User.collection.updateOne.bind(User.collection); let injected = false;
  jest.spyOn(User.collection, "updateOne").mockImplementation(async (...args) => {
    if (!injected && args[1]?.$set?.["preferences.dashboardViews"]) { injected = true; await original({ _id: user._id }, { $set: { "preferences.fontSize": "xl", "preferences.future": "retained" } }); }
    return original(...args);
  });
  expect((await post(input())).status).toBe(201); expect((await raw()).preferences).toMatchObject({ fontSize: "xl", future: "retained", dashboardViews: [expect.any(Object)] });
});
test("owner, revision, input size, role and malformed-storage guards fail closed", async () => {
  expect((await post(input("Foreign", { expectedOwnerId: "0".repeat(24) }))).status).toBe(403);
  expect((await post(input("Unreviewed", { revision: undefined }))).status).toBe(428);
  expect((await post(input("x".repeat(49)))).status).toBe(400);
  expect((await post(input("Oversized", { filters: { search: "x".repeat(201) } }))).status).toBe(400);
  expect((await post(input("Other scope", { scope: "paralegal_applications" }))).status).toBe(403);
  expect((await request(app).get(`/api/account/dashboard-views?scope=${scope}&expectedOwnerId=${"0".repeat(24)}`).set("Cookie", cookie)).status).toBe(403);
  await User.collection.updateOne({ _id: user._id }, { $set: { "preferences.dashboardViews": { unexpected: true } } });
  expect((await read()).status).toBe(409); expect((await post(input())).status).toBe(409); expect((await raw()).preferences.dashboardViews).toEqual({ unexpected: true });
});
