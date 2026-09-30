const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { randomUUID } = require("crypto");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_archive";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_userId, _type, _payload, options = {}) => options.deferDispatch ? async () => ({}) : {}) }));
jest.mock("../utils/caseProjectionEvents", () => ({ publishCaseProjectionRefresh: jest.fn() }));
jest.mock("../utils/stripe", () => ({ customers: { retrieve: jest.fn(async () => ({ invoice_settings: { default_payment_method: "pm_synthetic" } })), create: jest.fn(async () => ({ id: "cus_synthetic" })) }, accounts: { retrieve: jest.fn() }, paymentIntents: { create: jest.fn(async () => { throw new Error("No payment should be attempted"); }), retrieve: jest.fn() } }));
const Case = require("../models/Case"), User = require("../models/User"), Job = require("../models/Job"), AuditLog = require("../models/AuditLog");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/jobs", require("../routes/jobs"));
let owner, other, para, admin, matter, job;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@archive.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved", stripeCustomerId: "cus_synthetic", stripeAccountId: "acct_synthetic", stripeOnboarded: true, stripePayoutsEnabled: true, stripeChargesEnabled: true })));
  matter = await Case.create({ title: "Synthetic archive Matter", details: "Recorded public scope", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, practiceArea: "contract law", tasks: [{ title: "Prepare agreement" }], internalNotes: { text: "PRIVATE_ARCHIVE_NOTE" } });
  job = await Job.create({ title: matter.title, description: matter.details, attorneyId: owner._id, caseId: matter._id, practiceArea: "contract law", budget: 400, status: "open" }); await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId: job._id, futureMetadata: { keep: true } } });
});
const call = (method, body, actor = owner, query = "") => request(app)[method](`/api/cases/${matter._id}/archive${query}`).set("Cookie", authCookieFor(actor)).send(body);
const read = async (actor = owner) => { const response = await call("get", undefined, actor); if (response.status !== 200) throw new Error(`Archive read returned ${response.status}: ${JSON.stringify(response.body)}`); return response.body; };
const review = value => ({ expectedOwnerId: String(owner._id), revision: value.revision, requestId: randomUUID(), archived: value.targetArchived });
const raw = () => Case.collection.findOne({ _id: matter._id });
const set = changes => Case.collection.updateOne({ _id: matter._id }, { $set: changes });

test("reviewed archive/restore changes only the flag, timestamp and receipt; no Job or private-data rewrites", async () => {
  const original = await raw(), originalJob = await Job.collection.findOne({ _id: job._id });
  const first = await read(); expect(JSON.stringify(first)).not.toMatch(/PRIVATE_ARCHIVE_NOTE|futureMetadata|email|paymentIntent/);
  expect((await call("get")).headers["cache-control"]).toBe("no-store");
  const archive = await call("patch", review(first)); expect(archive.status).toBe(200); expect(archive.body.archive).toMatchObject({ archived: true, status: "open", canChange: true });
  const after = await raw(); for (const key of Object.keys(original).filter(key => !["archived", "updatedAt", "archiveReceipt"].includes(key))) expect(after[key]).toEqual(original[key]);
  const restore = await call("patch", review(await read())); expect(restore.status).toBe(200); expect(restore.body.archive).toMatchObject({ archived: false, status: "open" });
  expect(await Job.collection.findOne({ _id: job._id })).toEqual(originalJob); expect(publishCaseProjectionRefresh).toHaveBeenCalledTimes(2);
});
test("exact request replay returns its receipt once without another audit or refresh; mismatched reuse is rejected", async () => {
  const data = review(await read()); expect((await call("patch", data)).status).toBe(200); const original = await raw(), auditCount = await AuditLog.countDocuments({});
  const again = await call("patch", data); expect(again.status).toBe(200); expect(again.body.replayed).toBe(true); expect(again.body.archive.receipt).toMatchObject({ requestId: data.requestId, revision: data.revision, archived: true });
  expect(await raw()).toEqual(original); expect(await AuditLog.countDocuments({})).toBe(auditCount); expect(publishCaseProjectionRefresh).toHaveBeenCalledTimes(1);
  expect((await call("patch", { ...data, archived: false })).body.code).toBe("ARCHIVE_REQUEST_REUSED");
});
test("only the current owner/admin can read or change archive state, including legacy owner references", async () => {
  const data = review(await read());
  for (const actor of [other, para]) for (const method of ["get", "patch"]) expect([403, 404]).toContain((await call(method, { ...data, expectedOwnerId: String(actor._id) }, actor)).status);
  expect((await request(app).get(`/api/cases/${matter._id}/archive`)).status).toBe(401);
  expect((await call("get", undefined, owner, `?expectedOwnerId=${other._id}`)).body.code).toBe("ARCHIVE_ACCOUNT_CHANGED");
  expect((await call("patch", { ...data, expectedOwnerId: String(other._id) })).body.code).toBe("ARCHIVE_ACCOUNT_CHANGED");
  for (const field of ["attorney", "attorneyId"]) {
    await Case.collection.updateOne({ _id: matter._id }, { $set: { [field]: String(owner._id) }, $unset: { [field === "attorney" ? "attorneyId" : "attorney"]: "" } });
    expect((await read()).canChange).toBe(true);
  }
  const adminReview = await read(admin); expect((await call("patch", { ...review(adminReview), expectedOwnerId: String(admin._id) }, admin)).status).toBe(200); expect((await read()).receipt).toBeNull();
});
test("blind old writers and malformed reviews cannot mutate archive state", async () => {
  const data = review(await read());
  for (const invalid of [{ ...data, revision: undefined }, { ...data, requestId: "bad" }, { ...data, archived: "true" }, { ...data, status: "open" }]) expect([400, 428]).toContain((await call("patch", invalid)).status);
  expect((await call("patch", { archived: true })).status).toBe(403); expect((await raw()).archived).toBe(false);
});
test.each([{ paralegal: "para" }, { paralegalId: "para" }, { hiringClaimStatus: "claimed" }, { hiringClaimStatus: "needs_reconciliation", hiringClaimPaymentIntentId: "pi_saved" }, { completionClaimToken: "busy" }])("archive is unavailable during assignment or an active operation: %p", async changes => {
  await set(Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value === "para" ? para._id : value])));
  const value = await read(); expect(value.canChange).toBe(false); expect((await call("patch", review(value))).status).toBe(409); expect((await raw()).archived).toBe(false);
});
test.each([{ status: "completed" }, { status: "closed" }, { paymentReleased: true }, { purgeScheduledFor: new Date("2027-01-01") }, { purgedAt: new Date() }, { status: "unrecognized" }])("final, retained or unknown Matters cannot be restored: %p", async changes => {
  await set({ ...changes, archived: true }); const value = await read(); expect(value.canChange).toBe(false); expect((await call("patch", review(value))).status).toBe(409); expect((await raw()).archived).toBe(true);
});
test.each(["paused", "disputed", "in_progress"])("restoring preserves %s and all read-only restrictions", async status => {
  await set({ status, archived: true, readOnly: true, ...(status === "in_progress" ? { paralegal: para._id, paralegalId: para._id } : {}) }); const value = await read(); expect(value.canChange).toBe(true); expect((await call("patch", review(value))).status).toBe(200);
  const saved = await raw(); expect(saved.status).toBe(status); expect(saved.readOnly).toBe(true); expect(saved.archived).toBe(false);
  if (status === "paused") expect((await read()).reason).toBe("history");
});
test("draft restoration stays private while the empty-status compatibility rule remains explicit", async () => {
  for (const status of ["draft", ""]) { await set({ archived: true, status }); const value = await read(); expect(value.legacyReopen).toBe(status === ""); expect(value.restoredView).toBe(status === "draft" ? "draft" : "active"); expect((await call("patch", review(value))).status).toBe(200); expect((await raw()).status).toBe(status === "draft" ? "draft" : "open"); }
});
test("a changed title or archive/restore cycle invalidates old confirmation", async () => {
  const old = review(await read()); await set({ title: "Changed title" }); expect((await call("patch", old)).body.code).toBe("ARCHIVE_CHANGED");
  const current = review(await read()); expect((await call("patch", current)).status).toBe(200); expect((await call("patch", review(await read()))).status).toBe(200);
  expect((await call("patch", { ...current, requestId: randomUUID() })).body.code).toBe("ARCHIVE_CHANGED");
});
test("simultaneous archive requests accept one change and preserve concurrent private notes", async () => {
  const value = await read(); await set({ "internalNotes.text": "Concurrent private edit", unrelated: true });
  const results = await Promise.all([call("patch", review(value)), call("patch", review(value))]); expect(results.map(r => r.status).sort()).toEqual([200, 409]); expect((await raw()).internalNotes.text).toBe("Concurrent private edit"); expect((await raw()).unrelated).toBe(true);
});
test("ownership or assignment changes between load and archive CAS prevent the write", async () => {
  for (const changed of [{ attorney: other._id, attorneyId: other._id }, { paralegalId: para._id }, { hiringClaimStatus: "claimed", hiringClaimToken: "concurrent_hire" }]) {
    await set({ attorney: owner._id, attorneyId: owner._id, paralegalId: null }); const data = review(await read()); const original = Case.collection.updateOne.bind(Case.collection);
    const spy = jest.spyOn(Case.collection, "updateOne").mockImplementationOnce(async (filter, update, ...args) => { await original({ _id: matter._id }, { $set: changed }); return original(filter, update, ...args); });
    expect((await call("patch", data)).status).toBe(409); expect((await raw()).archived).toBe(false); spy.mockRestore();
  }
});
test("a lost database acknowledgement can be confirmed by the persisted receipt without another write", async () => {
  const data = review(await read()), original = Case.collection.updateOne.bind(Case.collection);
  jest.spyOn(Case.collection, "updateOne").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Synthetic lost acknowledgement"); });
  expect((await call("patch", data)).status).toBe(503); expect((await read()).receipt.requestId).toBe(data.requestId); expect((await call("patch", data)).body.replayed).toBe(true);
});
test.each(["caseId", "jobId", "job"])("archived listings cannot leak through legacy %s mirrors and restoration never rewrites the Job", async field => {
  if (field !== "caseId") {
    await Job.collection.updateOne({ _id: job._id }, { $unset: { caseId: "" } });
    await Case.collection.updateOne({ _id: matter._id }, { $set: { [field]: job._id }, ...(field === "job" ? { $unset: { jobId: "" } } : {}) });
  }
  const jobs = async () => { const r = await request(app).get("/api/jobs/open").set("Cookie", authCookieFor(para)); expect(r.status).toBe(200); return JSON.stringify(r.body); };
  expect(await jobs()).toContain(matter.title); const before = await Job.collection.findOne({ _id: job._id });
  expect((await call("patch", review(await read()))).status).toBe(200); expect(await jobs()).not.toContain(matter.title);
  expect((await call("patch", review(await read()))).status).toBe(200); expect(await jobs()).toContain(matter.title); expect(await Job.collection.findOne({ _id: job._id })).toEqual(before);
});
test("archiving immediately before the hiring claim blocks funding", async () => {
  await set({ applicants: [{ paralegalId: para._id, status: "pending", appliedAt: new Date() }], lockedTotalAmount: 40000, amountLockedAt: new Date() });
  const archiveReview = review(await read()), original = Case.findOneAndUpdate.bind(Case); let raced = false;
  jest.spyOn(Case, "findOneAndUpdate").mockImplementation(async (filter, update, options) => {
    if (!raced && update.$set?.hiringClaimToken) { raced = true; expect((await call("patch", archiveReview)).status).toBe(200); }
    return original(filter, update, options);
  });
  const response = await request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", authCookieFor(owner)).send({});
  expect({ raced, body: response.body }).toMatchObject({ raced: true }); expect(response.status).toBe(409); expect(require("../utils/stripe").paymentIntents.create).not.toHaveBeenCalled(); expect((await raw()).archived).toBe(true); expect((await raw()).paralegalId).toBeNull();
});

test("manual archival blocks new applications and invitation responses while retaining invitation history", async () => {
  const invited = await request(app).post(`/api/cases/${matter._id}/invite/${para._id}`).set("Cookie", authCookieFor(owner)).send({}); expect(invited.status).toBe(200);
  expect((await call("patch", review(await read()))).status).toBe(200);
  const response = await request(app).post(`/api/cases/${matter._id}/respond-invite`).set("Cookie", authCookieFor(para)).send({ decision: "accept" }); expect([400, 409]).toContain(response.status);
  const application = await request(app).post(`/api/cases/${matter._id}/apply`).set("Cookie", authCookieFor(para)).send({}); expect(application.status).toBe(400);
  const saved = await raw(); expect(saved.invites[0].status).toBe("pending"); expect(saved.paralegalId).toBeNull();
});

test("ambiguous ownership and legacy draft assignment history cannot be reopened through archive controls", async () => {
  for (const changes of [{ attorneyId: other._id }, { paralegalId: para._id }, { hiredAt: new Date() }, { hiringClaimStatus: "claimed" }]) {
    await set({ attorney: owner._id, attorneyId: owner._id, paralegalId: null, hiredAt: null, hiringClaimStatus: null, archived: true, status: "draft", ...changes });
    if (changes.attorneyId) {
      const before = await raw(), response = await call("get");
      expect(response.status).toBe(409); expect(response.body.code).toBe("CASE_IDENTITY_CONFLICT");
      expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_ARCHIVE_NOTE|Synthetic archive Matter/);
      const write = await call("patch", { expectedOwnerId: String(owner._id), requestId: randomUUID(), archived: false });
      expect(write.status).toBe(409); expect(write.body.code).toBe("CASE_IDENTITY_CONFLICT");
      expect(await raw()).toEqual(before);
    } else {
      const value = await read(); expect(value.canChange).toBe(false); expect((await call("patch", review(value))).status).toBe(409); expect((await raw()).status).toBe("draft");
    }
  }
});
