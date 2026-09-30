const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), crypto = require("crypto");
const { clearDatabase } = require("./helpers/db");
const mongoose = require("mongoose"), { MongoMemoryReplSet } = require("mongodb-memory-server");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_moderation";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_id, _type, _payload, options = {}) => options.deferDispatch ? async () => {} : ({})) }));
const { notifyUser } = require("../utils/notifyUser");
const Case = require("../models/Case"), User = require("../models/User"), Job = require("../models/Job");
const moderation = require("../services/matterModeration");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, other, para, admin, matter;
const call = (method, suffix, data, actor = owner) => request(app)[method](`/api/cases/${matter._id}${suffix}`).set("Cookie", authCookieFor(actor)).send(data);
const read = async () => (await call("get", "/flags/review")).body;
const raw = () => Case.collection.findOne({ _id: matter._id });
const flag = (message = "Please clarify the public scope") => call("post", "/flags/request-edits", { message }, admin);
const sent = value => ({ expectedOwnerId: String(owner._id), revision: value.revision, requestId: crypto.randomUUID() });
const submit = data => call("post", "/flags/mark-resolved", data);
async function edit(changes = { description: "Clarified public scope" }) {
  const current = await request(app).get(`/api/cases/posting/${matter._id}`).set("Cookie", authCookieFor(owner));
  return request(app).patch(`/api/cases/posting/${matter._id}`).set("Cookie", authCookieFor(owner)).send({ changes, revision: current.body.posting.revision, expectedOwnerId: String(owner._id) });
}
let mongo;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("matter-moderation-tests")); await Promise.all(Object.values(mongoose.models).map(model => model.init())); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@moderation.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Synthetic flagged posting", details: "Original scope", attorney: owner._id, attorneyId: owner._id, status: "open", practiceArea: "contract law", totalAmount: 40000, tasks: [{ title: "Prepare agreement" }], internalNotes: { text: "Private attorney preparation" } });
  const job = await Job.create({ title: matter.title, description: matter.details, practiceArea: matter.practiceArea, budget: 400, attorneyId: owner._id, caseId: matter._id, status: "open" });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
});
afterEach(() => jest.restoreAllMocks());

test("admin feedback preserves multiline instructions in the review, private note and notice", async () => {
  const message = "Clarify the public scope.\n\nIdentify the missing exhibit references before requesting review.";
  expect((await flag(message)).status).toBe(200);
  expect((await read()).feedback).toBe(message);
  const stored = await raw();
  expect(stored.moderationEditRequest).toBe(message);
  expect(stored.internalNotes.text).toContain(`Admin requested edits: ${message}`);
  expect(notifyUser.mock.calls.find(call => call[1] === 'case_update')[2].summary).toBe(`Admin requested edits: ${message}`);
});

test("admin feedback captures public content and only real posting changes qualify for review", async () => {
  expect((await flag()).status).toBe(200); const initial = await read(); expect(initial).toMatchObject({ status: "flagged", canRequestReview: false, reason: "edit_required", feedback: "Please clarify the public scope" });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { updatedAt: new Date(Date.now() + 1000), "tasks.0.completed": true, "internalNotes.text": "Unrelated note" } });
  expect((await read()).canRequestReview).toBe(false); expect((await submit(sent(await read()))).status).toBe(400);
  expect((await edit({ title: matter.title })).status).toBe(200); expect((await read()).canRequestReview).toBe(false);
  expect((await edit()).status).toBe(200); expect((await read()).canRequestReview).toBe(true);
  expect((await edit({ description: "Original scope" })).status).toBe(200); expect((await read()).canRequestReview).toBe(false);
});
test("a reviewed request records a receipt, keeps flags, appends once and repeats no notifications on retry", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { flags: [{ reason: "PRIVATE_REPORT_REASON", details: "Confidential reporter details", reportedBy: para._id, futureReportMetadata: true }] } });
  await flag(); await edit(); const value = await read(); expect(JSON.stringify(value)).not.toContain("PRIVATE_REPORT_REASON"); expect(JSON.stringify(value)).not.toContain(String(para._id)); const data = sent(value);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { "internalNotes.future": "keep", futureMatterField: true } });
  const flags = (await raw()).flags; notifyUser.mockClear(); const result = await submit(data); expect(result.status).toBe(200); expect(result.body.review).toMatchObject({ status: "resolution_requested", canRequestReview: false, receipt: { requestId: data.requestId, revision: data.revision } });
  const calls = notifyUser.mock.calls.length; expect(calls).toBe(1);
  const again = await submit(data); expect(again.status).toBe(200); expect(again.body.replayed).toBe(true); expect(notifyUser).toHaveBeenCalledTimes(calls);
  const saved = await raw(); expect(saved.flags).toEqual(flags); expect(saved.futureMatterField).toBe(true); expect(saved.internalNotes.future).toBe("keep"); expect(saved.internalNotes.text.match(/Attorney marked flag resolved/g)).toHaveLength(1);
  expect((await submit({ ...data, revision: "0".repeat(64) })).status).toBe(409);
});
test("new admin feedback and later posting edits invalidate a previously reviewed request", async () => {
  await flag(); await edit(); const prior = sent(await read()); await flag("New admin requirements");
  expect((await submit(prior)).status).toBe(409); expect((await read()).feedback).toBe("New admin requirements"); expect((await read()).canRequestReview).toBe(false);
  await edit({ title: "Second public edit" }); const stale = sent(await read()); await edit({ title: "Third public edit" }); expect((await submit(stale)).status).toBe(409);
});
test("two tabs cannot duplicate the transition or append over concurrent attorney notes", async () => {
  await flag(); await edit(); const snapshot = await read();
  const results = await Promise.all([submit(sent(snapshot)), submit(sent(snapshot))]); expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  await flag("Another admin request"); await edit({ title: "Next edit" }); const data = sent(await read());
  const original = Case.collection.updateOne.bind(Case.collection); let raced = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (!raced && args[1]?.$set?.moderationStatus === "resolution_requested") { raced = true; await original({ _id: matter._id }, { $set: { internalNotes: { text: "Concurrent private edit", future: true } } }); } return original(...args); });
  expect((await submit(data)).status).toBe(200); expect((await raw()).internalNotes).toMatchObject({ text: expect.stringMatching(/^Concurrent private edit\n\n/), future: true });
});
test("a posting change between read and write cannot receive an outdated review request", async () => {
  await flag(); await edit(); const data = sent(await read()); const original = Case.collection.updateOne.bind(Case.collection); let raced = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (!raced && args[1]?.$set?.moderationStatus === "resolution_requested") { raced = true; await original({ _id: matter._id }, { $set: { details: "Unreviewed content changed without relying on timestamp" } }); } return original(...args); });
  expect((await submit(data)).status).toBe(409); expect((await read()).status).toBe("flagged");
});
test("older flags require a fresh actual edit and acquire a baseline in the posting transaction", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { moderationStatus: "flagged", moderationFlaggedAt: new Date("2020-01-01") }, $unset: { moderationPostingBaseline: "" } });
  expect((await read()).reason).toBe("legacy_edit_required"); expect((await edit({ title: matter.title })).status).toBe(200); expect((await raw()).moderationPostingBaseline).toBeUndefined();
  expect((await edit()).status).toBe(200); expect((await read()).canRequestReview).toBe(true); expect((await raw()).moderationPostingBaseline).toMatch(/^[a-f0-9]{64}$/);
});
test("only authorized accounts see feedback; owner/revision/archived/read-only guards fail closed", async () => {
  await flag("PRIVATE_ADMIN_FEEDBACK"); await edit();
  for (const actor of [other, para]) { const result = await call("get", "/flags/review", undefined, actor); expect([403, 404]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("PRIVATE_ADMIN_FEEDBACK"); }
  for (const action of ["resolve", "request-edits"]) expect((await call("post", `/flags/${action}`, { message: "Attorney cannot administer flags" })).status).toBe(403);
  expect((await submit({})).status).toBe(403); expect((await submit({ expectedOwnerId: String(owner._id) })).status).toBe(428);
  expect((await submit({ ...sent(await read()), expectedOwnerId: String(other._id) })).status).toBe(403);
  for (const field of ["archived", "readOnly"]) { await Case.collection.updateOne({ _id: matter._id }, { $set: { [field]: true } }); const value = await read(); expect(value.canRequestReview).toBe(false); expect([400, 409]).toContain((await submit(sent(value))).status); await Case.collection.updateOne({ _id: matter._id }, { $set: { [field]: false } }); }
  expect((await call("get", "/flags/review")).headers["cache-control"]).toBe("no-store");
});
test("admin resolution preserves the receipt for recovery and a full note blocks transition without notification", async () => {
  await flag(); await edit(); const data = sent(await read()); await submit(data);
  expect((await call("post", "/flags/resolve", { note: "Reviewed" }, admin)).status).toBe(200);
  expect((await read()).status).toBe("none"); expect((await read()).receipt.requestId).toBe(data.requestId);
  await flag(); await edit({ title: "Changed once more" }); await Case.collection.updateOne({ _id: matter._id }, { $set: { "internalNotes.text": "x".repeat(10000) } }); notifyUser.mockClear();
  const result = await submit(sent(await read())); expect(result.status).toBe(409); expect(result.body.code).toBe("NOTE_LIMIT"); expect((await read()).status).toBe("flagged"); expect(notifyUser).not.toHaveBeenCalled();
});
test("public fingerprints ignore task progress and unrelated timestamps", () => {
  const doc = matter.toObject(); expect(moderation.postingFingerprint(doc)).toBe(moderation.postingFingerprint({ ...doc, updatedAt: new Date(0), tasks: [{ ...doc.tasks[0], completed: true, completedAt: new Date() }] }));
});
