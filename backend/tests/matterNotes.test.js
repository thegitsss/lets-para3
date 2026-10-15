const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_notes";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_userId, _type, _payload, options = {}) => options.deferDispatch ? async () => ({}) : {}) }));
const { notifyUser } = require("../utils/notifyUser");
const Case = require("../models/Case"), User = require("../models/User"), AuditLog = require("../models/AuditLog");
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, other, para, admin, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map((name) => ({ firstName: "Synthetic", lastName: name, email: `${name}@notes.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Synthetic Matter notes", details: "Synthetic details", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", totalAmount: 40000, internalNotes: { text: "PRIVATE_NOTE_SENTINEL" } });
});
afterEach(() => jest.restoreAllMocks());
const call = (method, suffix, data, user = owner) => request(app)[method](`/api/cases/${matter._id}${suffix}`).set("Cookie", authCookieFor(user)).send(data);
const read = async (user = owner) => (await call("get", "/notes", undefined, user)).body;
const save = (note, revision, user = owner) => call("put", "/notes", { note, revision, expectedOwnerId: String(user._id) }, user);
test("only owner and platform admins can read or write notes and history", async () => {
  for (const user of [owner, admin]) { expect((await read(user)).note).toBe("PRIVATE_NOTE_SENTINEL"); expect((await call("get", "/status-history", undefined, user)).status).toBe(200); }
  for (const user of [other, para]) for (const path of ["/notes", "/status-history"]) { const result = await call("get", path, undefined, user); expect([403, 404]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("PRIVATE_NOTE_SENTINEL"); }
  for (const user of [other, para]) expect([403, 404]).toContain((await save("Unauthorized", (await read()).revision, user)).status);
  expect((await request(app).get(`/api/cases/${matter._id}/notes`)).status).toBe(401);
  expect((await call("get", "/notes")).headers["cache-control"]).toBe("no-store");
});
test("shared summaries and case details never expose attorney notes to paralegals", async () => {
  for (const path of ["/api/cases/my?withFiles=true", `/api/cases/${matter._id}`]) { const response = await request(app).get(path).set("Cookie", authCookieFor(para)); expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_NOTE_SENTINEL|internalNotes/); }
  const mine = await request(app).get("/api/cases/my").set("Cookie", authCookieFor(owner)); expect(JSON.stringify(mine.body)).toContain("PRIVATE_NOTE_SENTINEL");
});
test("notes preserve paragraphs, spacing, unknown metadata and the public posting timestamp", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { "internalNotes.futureMetadata": { keep: true } } });
  const before = await Case.collection.findOne({ _id: matter._id }), initial = await read();
  const note = "  First paragraph.\n\nSecond paragraph.\n\tIndented line.  ";
  const response = await save(note, initial.revision); expect(response.status).toBe(200); expect(response.body.note).toBe(note); expect(response.body.revision).not.toBe(initial.revision);
  const after = await Case.collection.findOne({ _id: matter._id }); expect(after.internalNotes.futureMetadata).toEqual({ keep: true }); expect(after.internalNotes.updatedBy).toEqual(owner._id); expect(after.updatedAt).toEqual(before.updatedAt); expect(after.title).toBe(before.title); expect((await read()).note).toBe(note);
});
test.each([null, {}, 123, "x".repeat(10001)])("invalid or oversize notes fail without truncation (%#)", async (note) => { expect((await save(note, (await read()).revision)).status).toBe(400); expect((await read()).note).toBe("PRIVATE_NOTE_SENTINEL"); });
test("revision and account identity are required, including current-client writes", async () => {
  expect((await save("Unsafe", undefined)).status).toBe(428);
  expect((await call("put", "/notes", { note: "Unsafe", revision: (await read()).revision, expectedOwnerId: String(other._id) })).status).toBe(403); expect((await read()).note).toBe("PRIVATE_NOTE_SENTINEL");
});
test("two competing saves cannot overwrite each other", async () => {
  const { revision } = await read(), results = await Promise.all([save("First", revision), save("Second", revision)]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]); expect((await read()).note).toBe(results.find((result) => result.status === 200).body.note); expect((await save("Stale", revision)).status).toBe(409);
});
test("missing, legacy string and oversize historical notes remain readable without normalization", async () => {
  for (const value of [undefined, "Legacy\n\nparagraph", { text: "x".repeat(10001), future: "keep" }]) {
    await Case.collection.updateOne({ _id: matter._id }, value === undefined ? { $unset: { internalNotes: "" } } : { $set: { internalNotes: value } });
    const current = await read(); expect(current.note).toBe(typeof value === "string" ? value : value?.text || ""); expect((await save("Reviewed replacement", current.revision)).status).toBe(200);
    if (value?.future) expect((await Case.collection.findOne({ _id: matter._id })).internalNotes.future).toBe("keep");
  }
});
test("notes do not qualify a flagged posting as edited", async () => {
  const now = new Date(); await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "open", moderationStatus: "flagged", moderationFlaggedAt: now, updatedAt: now } });
  expect((await save("Private preparation", (await read()).revision)).status).toBe(200);
  const response = await call("post", "/flags/mark-resolved", { expectedOwnerId: String(owner._id), revision: (await call("get", "/flags/review")).body.revision, requestId: require("crypto").randomUUID() }); expect(response.status).toBe(400); expect(response.body.error).toMatch(/Edit the Matter/);
});
test.each(["resolve", "request-edits", "mark-resolved"])("%s appends feedback and invalidates an old notes revision", async (action) => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { "internalNotes.future": "keep", moderationStatus: "flagged", moderationFlaggedAt: new Date("2020-01-01") } });
  if (action === "mark-resolved") await Case.collection.updateOne({ _id: matter._id }, { $set: { moderationPostingBaseline: require("../services/matterModeration").postingFingerprint({ ...matter.toObject(), title: "Prior public title" }) } });
  const old = await read(), actor = action === "mark-resolved" ? owner : admin;
  const response = await call("post", `/flags/${action}`, { note: "Resolved", message: "Please clarify scope", expectedOwnerId: String(actor._id), revision: (await call("get", "/flags/review", undefined, actor)).body.revision, requestId: require("crypto").randomUUID() }, actor); expect(response.status).toBe(200);
  const saved = await read(); expect(saved.note).toContain("PRIVATE_NOTE_SENTINEL"); expect(saved.note).toMatch(/Admin|Attorney/); expect((await save("Stale overwrite", old.revision)).status).toBe(409);
  const raw = await Case.collection.findOne({ _id: matter._id }); expect(raw.internalNotes.future).toBe("keep"); expect(raw.internalNotes.updatedBy).toEqual(actor._id);
  if (action !== "resolve") expect(raw[action === "mark-resolved" ? "moderationResolutionRequestedBy" : "moderationFlaggedBy"]).toEqual(actor._id);
});
test("a note save racing an admin append survives with the admin feedback", async () => {
  const initial = await read(), originalUpdate = Case.collection.updateOne.bind(Case.collection); let raced = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, update, ...rest) => {
    if (!raced && update.$set?.internalNotes?.text?.includes("Admin resolved")) { raced = true; expect((await save("Concurrent attorney edit", initial.revision)).status).toBe(200); }
    return originalUpdate(filter, update, ...rest);
  });
  expect((await call("post", "/flags/resolve", { note: "Reviewed" }, admin)).status).toBe(200); expect((await read()).note).toMatch(/^Concurrent attorney edit\n\n.*Admin resolved flag: Reviewed$/);
});
test("admin feedback never truncates a full note or sends a notice for a rejected append", async () => {
  const full = "x".repeat(10000); await save(full, (await read()).revision);
  const response = await call("post", "/flags/request-edits", { message: "Clarify scope" }, admin); expect(response.status).toBe(409); expect(response.body.code).toBe("NOTE_LIMIT"); expect((await read()).note).toBe(full); expect(notifyUser).not.toHaveBeenCalled();
});
test("history reports an unavailable audit source as partial", async () => {
  jest.spyOn(AuditLog, "find").mockImplementationOnce(() => { throw new Error("synthetic history unavailable"); });
  const response = await call("get", "/status-history"); expect(response.status).toBe(200); expect(response.body.complete).toBe(false); expect(response.body.items.length).toBeGreaterThan(0);
});

test("history names recorded actors without inventing actors for inferred events", async () => {
  await AuditLog.create({ case: matter._id, actor: owner._id, actorRole: "attorney", action: "case.create" });
  const response = await call("get", "/status-history");
  expect(response.status).toBe(200);
  expect(response.body.items.find((item) => item.label === "Posted").actorName).toBe("Synthetic owner");
  expect(response.body.items.find((item) => item.label === "In Progress").actorName).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain(owner.email);
});
