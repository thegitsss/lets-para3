const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_invitations";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_id, _type, _payload, options = {}) => options.deferDispatch ? async () => {} : ({})) }));
const Case = require("../models/Case"), User = require("../models/User");
const { invitationRecords } = require("../services/matterInvitations");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, other, para, admin, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@invitations.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Synthetic invitations", details: "Private Matter details", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, status: "open", totalAmount: 40000, internalNotes: { text: "PRIVATE_NOTE" }, invites: [{ paralegalId: para._id, status: "accepted", invitedAt: new Date("2026-01-01"), respondedAt: new Date("2026-01-02") }] });
});
afterEach(() => jest.restoreAllMocks());
const read = (actor = owner, query = "") => request(app).get(`/api/cases/${matter._id}/invites${query}`).set("Cookie", authCookieFor(actor));
const raw = () => Case.collection.findOne({ _id: matter._id });

test("only the Matter owner and admins can read invitations, without exposing contact or private Matter data", async () => {
  for (const actor of [owner, admin]) {
    const response = await read(actor); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({ caseId: String(matter._id), ownerId: String(actor._id), caseTitle: matter.title, complete: true, invites: [{ paralegal: { id: String(para._id), name: "Synthetic para", available: true }, status: "accepted", invitedAt: "2026-01-01T00:00:00.000Z", respondedAt: "2026-01-02T00:00:00.000Z" }] });
    expect(JSON.stringify(response.body)).not.toMatch(/email|password|PRIVATE_NOTE|Private Matter details|stripe/);
  }
  for (const actor of [other, para]) expect([403, 404]).toContain((await read(actor)).status);
  expect((await request(app).get(`/api/cases/${matter._id}/invites`)).status).toBe(401);
});
test("account changes and ownership changes during the profile read fail closed", async () => {
  expect((await read(owner, `?expectedOwnerId=${other._id}`)).body.code).toBe("INVITATION_ACCOUNT_CHANGED");
  const original = User.find.bind(User); jest.spyOn(User, "find").mockImplementationOnce((...args) => {
    const query = original(...args); const lean = query.lean.bind(query);
    query.lean = async () => { await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: other._id, attorneyId: other._id } }); return lean(); };
    return query;
  });
  expect((await read()).status).toBe(404);
});
test("legacy string ownership references retain the same owner-only access without migrating the record", async () => {
  for (const field of ["attorney", "attorneyId"]) {
    await Case.collection.updateOne({ _id: matter._id }, { $set: { [field]: String(owner._id) }, $unset: { [field === "attorney" ? "attorneyId" : "attorney"]: "" } });
    const before = await raw(); expect((await read()).status).toBe(200); expect((await read(other)).status).toBe(404); expect(await raw()).toEqual(before);
  }
});
test("viewing legacy invitations never invents a date or updates Matter state", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { invites: [], pendingParalegalId: para._id, futureMetadata: "keep" }, $unset: { pendingParalegalInvitedAt: "" } });
  const before = await raw(); const response = await read(); expect(response.body.invites).toEqual([{ paralegal: expect.objectContaining({ id: String(para._id) }), status: "pending", invitedAt: null, respondedAt: null }]);
  expect(await raw()).toEqual(before); expect(require("../utils/notifyUser").notifyUser).not.toHaveBeenCalled();
});
test("a mixed legacy pending record is included once and invalid records are explicitly incomplete", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { invites: [{ paralegalId: para._id, status: "unexpected", invitedAt: "invalid" }, { paralegalId: "broken", status: "pending" }], pendingParalegalId: para._id } });
  const response = await read(); expect(response.status).toBe(200); expect(response.body.complete).toBe(false); expect(response.body.invites).toHaveLength(1); expect(response.body.invites[0]).toMatchObject({ status: "unknown", invitedAt: null, respondedAt: null });
  const separate = invitationRecords({ invites: [{ paralegalId: para._id, status: "declined" }], pendingParalegalId: other._id }); expect(separate.records).toHaveLength(2);
});
test("empty, archived and final Matters retain truthful invitation history", async () => {
  for (const changes of [{ archived: true }, { status: "completed", paymentReleased: true }]) {
    await Case.collection.updateOne({ _id: matter._id }, { $set: changes }); const response = await read(); expect(response.status).toBe(200); expect(response.body.invites[0].status).toBe("accepted");
  }
  await Case.collection.updateOne({ _id: matter._id }, { $set: { invites: [] } }); expect((await read()).body).toMatchObject({ complete: true, invites: [] });
});
test.each(["disabled", "deleted", "missing"])("%s profiles retain recorded responses without a name, photo or profile link", async field => {
  if (field === "missing") await User.deleteOne({ _id: para._id });
  else await User.collection.updateOne({ _id: para._id }, { $set: { [field]: true, profileImage: "private-photo-key" } });
  const response = await read(); expect(response.status).toBe(200); expect(response.body.invites[0]).toMatchObject({ paralegal: { available: false, name: "Invited paralegal", profileImage: null }, status: "accepted" });
});

test("blocked profiles retain invitation history without exposing a current name or photo", async () => {
  await require('../models/Block').create({blockerId:owner._id,blockedId:para._id,active:true});
  const response=await read();expect(response.status).toBe(200);expect(response.body.invites[0]).toMatchObject({paralegal:{available:false,name:'Invited paralegal',profileImage:null},status:'accepted'});
});
test("conflicting ownership and a changed invitation response cannot return a stale readable list", async () => {
  await Case.collection.updateOne({_id:matter._id},{$set:{attorneyId:other._id}});expect((await read()).status).toBe(409);
  await Case.collection.updateOne({_id:matter._id},{$set:{attorneyId:owner._id}});
  const original=User.find.bind(User);jest.spyOn(User,'find').mockImplementationOnce((...args)=>{const query=original(...args),lean=query.lean.bind(query);query.lean=async()=>{await Case.collection.updateOne({_id:matter._id},{$set:{'invites.0.status':'declined'}});return lean();};return query;});
  const response=await read();expect(response.status).toBe(409);expect(response.body.code).toBe('INVITATION_CHANGED');expect(response.body.invites).toBeUndefined();
});
