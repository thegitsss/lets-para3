"use strict";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), jwt = require("jsonwebtoken"), mongoose = require("mongoose");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const User = require("../models/User"), Case = require("../models/Case"), CaseDraft = require("../models/CaseDraft");
const Vector = require("../models/ParalegalSearchVector"), Preparation = require("../models/MatterPreparation"), Session = require("../models/DocumentEditorSession");
const Connection = require("../models/ClioConnection"), OAuthState = require("../models/ClioOAuthState"), Handoff = require("../models/ClioHandoff"), Transfer = require("../models/ClioTransfer");
const lifecycle = require("../services/connectedWorkspace/lifecycle");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser(), express.json());
app.use("/api/account", require("../routes/account")); app.use("/api/case-drafts", require("../routes/caseDrafts"));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message }));
const oid = () => new mongoose.Types.ObjectId();
const cookie = user => "token=" + jwt.sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
let owner, other;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [owner, other] = await User.create(["owner", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: name + "@connected-lifecycle.test", password: "Synthetic123!", role: "attorney", status: "approved" })));
});
async function seedOwner(userId, label) {
  const caseId = oid(), draftId = oid();
  await Connection.collection.insertOne({ ownerId: userId, credentials: "SYNTHETIC-PROTECTED-CREDENTIALS", clioUserId: label, revision: label });
  await OAuthState.collection.insertOne({ ownerId: userId, tokenHash: label, expiresAt: new Date(Date.now() + 600000) });
  await Handoff.collection.insertOne({ ownerId: userId, draftId, requestId: label, payload: "SYNTHETIC-CONFIDENTIAL-HANDOFF" });
  await Transfer.collection.insertOne({ ownerId: userId, caseId, requestId: label, direction: "export" });
  await Vector.collection.insertOne({ userId, profileHash: label, model: "synthetic", embedding: [1, 0] });
  await Session.collection.insertOne({ caseId, fileId: oid(), documentKey: label, participants: [{ userId, role: "attorney", authVersion: 0 }], state: "open" });
  return { caseId, draftId };
}
const ownerModels = [Connection, OAuthState, Handoff, Transfer];
test("the actual account deactivation route removes credentials, OAuth state, handoffs, vectors and editing sessions only for that owner", async () => {
  await seedOwner(owner._id, "owner"); await seedOwner(other._id, "other");
  const response = await request(app).delete("/api/account/deactivate").set("Cookie", cookie(owner));
  expect(response.status).toBe(200); expect(response.body.deactivated).toBe(true);
  for (const Model of ownerModels) {
    expect(await Model.countDocuments({ ownerId: owner._id })).toBe(0);
    expect(await Model.countDocuments({ ownerId: other._id })).toBe(1);
  }
  expect(await Vector.countDocuments({ userId: owner._id })).toBe(0);
  expect(await Vector.countDocuments({ userId: other._id })).toBe(1);
  expect(await Session.countDocuments({ "participants.userId": owner._id })).toBe(0);
  expect(await Session.countDocuments({ "participants.userId": other._id })).toBe(1);
  expect((await User.findById(owner._id)).disabled).toBe(true);
});
test("owner cleanup participates in its caller's transaction and an aborted closure retains every record", async () => {
  await seedOwner(owner._id, "owner");
  const session = await mongoose.startSession();
  try { session.startTransaction(); await lifecycle.cleanupOwner(owner._id, { session }); await session.abortTransaction(); }
  finally { await session.endSession(); }
  for (const Model of ownerModels) expect(await Model.countDocuments({ ownerId: owner._id })).toBe(1);
  expect(await Vector.countDocuments({ userId: owner._id })).toBe(1);
  expect(await Session.countDocuments({ "participants.userId": owner._id })).toBe(1);
});
test("Matter cleanup removes only its preparation, editing, transfer and linked published-draft handoff records", async () => {
  const first = await seedOwner(owner._id, "first"), second = await seedOwner(other._id, "second");
  await CaseDraft.collection.insertMany([{ _id: first.draftId, owner: owner._id, publishedCaseId: first.caseId }, { _id: second.draftId, owner: other._id, publishedCaseId: second.caseId }]);
  await Preparation.collection.insertMany([{ caseId: first.caseId, assignmentKey: "first", requestId: "first", encryptedPayload: "SYNTHETIC-FIRST" }, { caseId: second.caseId, assignmentKey: "second", requestId: "second", encryptedPayload: "SYNTHETIC-SECOND" }]);
  await lifecycle.cleanupMatter(first.caseId);
  for (const Model of [Preparation, Session, Transfer]) {
    expect(await Model.countDocuments({ caseId: first.caseId })).toBe(0);
    expect(await Model.countDocuments({ caseId: second.caseId })).toBe(1);
  }
  expect(await Handoff.countDocuments({ draftId: first.draftId })).toBe(0);
  expect(await Handoff.countDocuments({ draftId: second.draftId })).toBe(1);
  expect(await Connection.countDocuments()).toBe(2);
  expect(await Vector.countDocuments()).toBe(2);
});
test("revision-checked draft deletion removes its confidential handoff atomically and preserves unrelated handoffs", async () => {
  const created = await request(app).post("/api/case-drafts").set("Cookie", cookie(owner)).send({ title: "Synthetic draft", description: "Prepare a review", compAmount: "400", practiceArea: "Contract Law", state: "VA", tasks: [{ title: "Prepare review" }] });
  expect(created.status).toBe(201);
  const draft = created.body.draft, unrelated = oid();
  await Handoff.collection.insertMany([{ ownerId: owner._id, draftId: new mongoose.Types.ObjectId(draft.id), requestId: "selected", payload: "SYNTHETIC-CONFIDENTIAL-SELECTED" }, { ownerId: owner._id, draftId: unrelated, requestId: "unrelated", payload: "SYNTHETIC-CONFIDENTIAL-OTHER" }]);
  const stale = await request(app).delete("/api/case-drafts/" + draft.id).set("Cookie", cookie(owner)).send({ revision: "a".repeat(64) });
  expect(stale.status).toBe(409); expect(await Handoff.countDocuments()).toBe(2);
  const removed = await request(app).delete("/api/case-drafts/" + draft.id).set("Cookie", cookie(owner)).send({ revision: draft.revision });
  expect(removed.status).toBe(200);
  expect(await CaseDraft.findById(draft.id)).toBeNull();
  expect(await Handoff.countDocuments({ draftId: draft.id })).toBe(0);
  expect(await Handoff.countDocuments({ draftId: unrelated })).toBe(1);
});
