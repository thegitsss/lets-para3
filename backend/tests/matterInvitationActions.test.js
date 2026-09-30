const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/stripe", () => ({}));
jest.mock("../utils/email", () => jest.fn(async () => ({})));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_id, _type, _payload, options = {}) => options.deferDispatch ? async () => {} : ({})) }));
const Case = require("../models/Case"), User = require("../models/User"), Block = require("../models/Block");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@invitation-actions.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved", ...(name === "para" ? { stripeAccountId: "acct_synthetic", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "Synthetic invitation Matter", details: "Invitation review and amount preservation", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40001, tasks: [{ title: "Prepare exhibits" }] });
});
afterEach(() => jest.restoreAllMocks());
const read = (actor = owner) => request(app).get(`/api/cases/${matter._id}/invitation-review/${para._id}?expectedOwnerId=${actor._id}`).set("Cookie", cookie(actor));
const send = (review, profile = false) => request(app).post(`/api/cases/${matter._id}/invite${profile ? "" : `/${para._id}`}`).set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), reviewedRevision: review.revision, ...(profile ? { paralegalId: String(para._id) } : {}) });
test("invitation review reports the exact amount and creates no record or amount lock", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), response = await read(); expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ownerId: String(owner._id), caseId: String(matter._id), paralegalId: String(para._id), amountCents: 40001, amountLocked: false, canInvite: true, invitation: null }); expect(response.headers["cache-control"]).toContain("no-store");
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test.each([false, true])("reviewed invitation through profile=%s records one invitation and locks the displayed amount", async profile => {
  const review = await read(); expect(review.status).toBe(200); const response = await send(review.body, profile); expect(response.status).toBe(200);
  expect(response.body.invitationConfirmation).toMatchObject({ paralegalId: String(para._id), reviewedRevision: review.body.revision, amountCents: 40001 });
  const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved).toMatchObject({ lockedTotalAmount: 40001, __v: 1, invites: [{ status: "pending", paralegalId: para._id }] });
  expect([400, 409]).toContain((await send(review.body, profile)).status); expect((await Case.collection.findOne({ _id: matter._id })).invites).toHaveLength(1);
});
test.each(["amount", "assignment", "claim", "block", "account", "profile", "closed"])("%s changed after display cannot send an invitation", async change => {
  const review = await read(); expect(review.status).toBe(200);
  if (change === "amount") await Case.collection.updateOne({ _id: matter._id }, { $set: { totalAmount: 50000 } });
  if (change === "assignment") await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegalId: para._id } });
  if (change === "claim") await Case.collection.updateOne({ _id: matter._id }, { $set: { hiringClaimToken: "another-hire" } });
  if (change === "block") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  if (change === "account") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } });
  if (change === "profile") await User.collection.updateOne({ _id: para._id }, { $set: { disabled: true } });
  if (change === "closed") await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "closed" } });
  const before = await Case.collection.findOne({ _id: matter._id }); expect([400, 401, 403, 409]).toContain((await send(review.body)).status); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test("a concurrent invitation or amount edit after the final review wins without being overwritten", async () => {
  const review = await read(), original = Case.collection.updateOne.bind(Case.collection);
  jest.spyOn(Case.collection, "updateOne").mockImplementationOnce(async (...args) => { await original({ _id: matter._id }, { $set: { totalAmount: 50000, "retainedEvidence.changed": true } }); return original(...args); });
  expect((await send(review.body)).status).toBe(409); const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved).toMatchObject({ totalAmount: 50000, retainedEvidence: { changed: true } }); expect(saved.invites).toHaveLength(0); expect(saved.lockedTotalAmount).toBeNull();
});
test("reinviting preserves unknown evidence, earlier text IDs and an already locked amount", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: String(owner._id), attorneyId: String(owner._id), totalAmount: 90000, lockedTotalAmount: 40001, invites: [{ paralegalId: String(para._id), status: "declined", retainedEvidence: { earlier: true } }], retainedMatterEvidence: "Keep this" } });
  const review = await read(); expect(review.status).toBe(200); expect(review.body.amountCents).toBe(40001); expect((await send(review.body)).status).toBe(200);
  const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.attorney).toBe(String(owner._id)); expect(saved.invites[0]).toMatchObject({ paralegalId: String(para._id), status: "pending", retainedEvidence: { earlier: true } }); expect(saved).toMatchObject({ lockedTotalAmount: 40001, retainedMatterEvidence: "Keep this" });
});
test("sending another invitation preserves a pending invitation held only in earlier fields", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { pendingParalegalId: other._id, pendingParalegalInvitedAt: null } });
  const review = await read(); expect(review.status).toBe(200); expect((await send(review.body)).status).toBe(200);
  const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.invites).toHaveLength(2); expect(saved.invites[0]).toMatchObject({ paralegalId: other._id, status: "pending", invitedAt: null });
});
test("unknown and duplicate invitation records close new invitation controls without repair", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { invites: [{ paralegalId: para._id, status: "unexpected" }, { paralegalId: para._id, status: "declined" }] } });
  const before = await Case.collection.findOne({ _id: matter._id }), review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canInvite: false, reason: "records_unavailable" }); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test("Matter selection pages beyond the earlier cap with no duplicate or foreign records", async () => {
  await Case.collection.insertMany(Array.from({ length: 205 }, (_, index) => ({ _id: new Types.ObjectId(), title: `Synthetic posting ${index}`, attorney: index % 2 ? String(owner._id) : owner._id, attorneyId: index % 2 ? String(owner._id) : owner._id, status: "open" })));
  await Case.collection.insertOne({ _id: new Types.ObjectId(), title: "Foreign Matter", attorney: other._id, attorneyId: other._id, status: "open" });
  let cursor = "", ids = [];
  do { const response = await request(app).get(`/api/cases/invitation-options/${para._id}?expectedOwnerId=${owner._id}${cursor ? `&cursor=${cursor}` : ""}`).set("Cookie", cookie(owner)); expect(response.status).toBe(200); expect(response.body.matters.length).toBeLessThanOrEqual(25); ids.push(...response.body.matters.map(item => item.caseId)); expect(JSON.stringify(response.body)).not.toContain("Foreign Matter"); cursor = response.body.next; } while (cursor);
  expect(ids).toHaveLength(206); expect(new Set(ids).size).toBe(206);
});
test("nonowners, non-attorneys and changed accounts cannot load invitation details", async () => {
  expect((await read(other)).status).toBe(404); expect((await read(para)).status).toBe(403);
  expect((await request(app).get(`/api/cases/${matter._id}/invitation-review/${para._id}?expectedOwnerId=${other._id}`).set("Cookie", cookie(owner))).status).toBe(403);
});
test("an earlier current-dashboard send cannot overwrite a new locked amount", async () => {
  const stale = await Case.findById(matter._id), review = await read(); expect((await send(review.body)).status).toBe(200);
  const saved = await Case.collection.findOne({ _id: matter._id });
  const result = await require("../services/invitationService").sendInvitation({ caseDoc: stale, paralegalId: other._id });
  expect(result.sent).toBe(false); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(saved);
});
test("existing send contracts also advance the retained revision and protect against a claim in progress", async () => {
  const response = await request(app).post(`/api/cases/${matter._id}/invite/${para._id}`).set("Cookie", cookie(owner)).send({}); expect(response.status).toBe(200);
  expect(await Case.collection.findOne({ _id: matter._id })).toMatchObject({ __v: 1, lockedTotalAmount: 40001 });
  const next = await Case.create({ title: "Synthetic second invitation", details: "Claim protection", attorney: owner._id, attorneyId: owner._id, totalAmount: 40001, tasks: [{ title: "Prepare exhibits" }] });
  const beforeClaim = await Case.findById(next._id); await Case.collection.updateOne({ _id: next._id }, { $set: { hiringClaimToken: "new-hire" } });
  expect((await require("../services/invitationService").sendInvitation({ caseDoc: beforeClaim, paralegalId: para._id })).sent).toBe(false);
});
test.each(["paused", " PAUSED "])("%s replacement invitations distinguish the remaining amount from the original recorded amount", async status => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status, pausedReason: "paralegal_withdrew", payoutFinalizedAt: new Date(), remainingAmount: 12000, lockedTotalAmount: 40001 } });
  const review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canInvite: true, relisted: true, amountCents: 40001, remainingCents: 12000 });
  expect((await send(review.body)).status).toBe(200); expect(await Case.collection.findOne({ _id: matter._id })).toMatchObject({ lockedTotalAmount: 40001, remainingAmount: 12000 });
});
test.each(["unsettled", "no_remaining", "balance_changed"])("%s replacement Matter cannot receive the old invitation", async kind => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "paused", pausedReason: "paralegal_withdrew", payoutFinalizedAt: new Date(), remainingAmount: 12000, lockedTotalAmount: 40001 } });
  const review = await read(); expect({ status: review.status, body: review.body }).toMatchObject({ status: 200, body: { canInvite: true } });
  await Case.collection.updateOne({ _id: matter._id }, { $set: kind === "unsettled" ? { payoutFinalizedAt: null } : { remainingAmount: kind === "no_remaining" ? 0 : 10000 } });
  expect([400, 409]).toContain((await send(review.body)).status); expect((await Case.collection.findOne({ _id: matter._id })).invites).toHaveLength(0);
});


test("invitation Matter search is literal, complete and read-only across all matching pages", async () => {
  await Case.collection.insertMany(Array.from({ length: 107 }, (_, index) => ({ _id: new Types.ObjectId(), title: `Older (NY) [A] .* — Amélie ${index}`, attorney: owner._id, attorneyId: owner._id, status: "open", details: "PRIVATE_SCOPE", totalAmount: 40001 })));
  await Case.collection.insertMany([{ title: "Foreign (NY) [A] .*", attorney: other._id }, { title: "Archived (NY) [A] .*", attorney: owner._id, archived: true }]);
  const before = await Case.collection.find({}).sort({ _id: 1 }).toArray(); let cursor = ""; const ids = [];
  do {
    const response = await request(app).get(`/api/cases/invitation-options/${para._id}`).query({ expectedOwnerId: String(owner._id), q: "  (ny) [a] .*  ", ...(cursor ? { cursor } : {}) }).set("Cookie", cookie(owner));
    expect(response.status).toBe(200); expect(response.body.search).toBe("(ny) [a] .*"); expect(JSON.stringify(response.body)).not.toMatch(/Foreign|Archived|PRIVATE_SCOPE|40001/);
    ids.push(...response.body.matters.map(item => item.caseId)); cursor = response.body.next;
  } while (cursor);
  expect(ids).toHaveLength(107); expect(new Set(ids).size).toBe(107); expect(await Case.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  const noMatch = await request(app).get(`/api/cases/invitation-options/${para._id}`).query({ expectedOwnerId: String(owner._id), q: "not recorded" }).set("Cookie", cookie(owner));
  expect(noMatch.status).toBe(200); expect(noMatch.body).toMatchObject({ search: "not recorded", matters: [], next: null });
});

test("invitation options reject structured or oversized search values without changing a Matter", async () => {
  const before = await Case.collection.findOne({ _id: matter._id });
  for (const q of ["x".repeat(201), ["first", "second"], { $ne: "" }]) {
    const response = await request(app).get(`/api/cases/invitation-options/${para._id}`).query({ expectedOwnerId: String(owner._id), q }).set("Cookie", cookie(owner));
    expect({ status: response.status, body: response.body }).toMatchObject({ status: 400, body: { code: "INVITATION_INVALID" } });
  }
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});


test("invitation choices show open and settled replacement work while omitting unrelated lifecycle states", async () => {
  await Case.deleteMany({});
  const row = (title, extra = {}) => ({ title, attorney: owner._id, attorneyId: owner._id, status: "open", ...extra });
  await Case.collection.insertMany([
    row("Open"), row("Legacy open", { status: " AWAITING_FUNDING " }), row("Pending response", { invites: [{ paralegalId: para._id, status: "pending", invitedAt: new Date() }] }),
    row("Replacement", { status: " PAUSED ", pausedReason: "paralegal_withdrew", payoutFinalizedAt: new Date(), remainingAmount: 12000 }),
    ...["draft", "in progress", "completed", "closed", "disputed", "unknown"].map(status => row(`HIDDEN ${status}`, { status })),
    row("HIDDEN archive", { archived: true }), row("HIDDEN released", { paymentReleased: true }), row("HIDDEN read-only", { readOnly: true }),
    row("HIDDEN assigned", { paralegalId: para._id }), row("HIDDEN claim", { hiringClaimToken: "synthetic-claim" }),
    row("HIDDEN unsettled", { status: "paused", pausedReason: "paralegal_withdrew", remainingAmount: 12000 }),
    row("HIDDEN exhausted", { status: "paused", pausedReason: "paralegal_withdrew", payoutFinalizedAt: new Date(), remainingAmount: 0 }),
  ]);
  const before = await Case.collection.find({}).sort({ _id: 1 }).toArray();
  const response = await request(app).get(`/api/cases/invitation-options/${para._id}`).query({ expectedOwnerId: String(owner._id) }).set("Cookie", cookie(owner));
  expect(response.status).toBe(200); expect(response.body.matters.map(item => item.title).sort()).toEqual(["Legacy open", "Open", "Pending response", "Replacement"]);
  expect(await Case.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
});
