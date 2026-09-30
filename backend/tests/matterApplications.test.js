const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const authCookieFor = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, email: user.email, status: user.status, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_application_review";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({})) }));
const Case = require("../models/Case"), User = require("../models/User"), Job = require("../models/Job"), Application = require("../models/Application"), Block = require("../models/Block");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, other, para, admin, matter, jobId, applicationId;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@application-review.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  jobId = new Types.ObjectId(); applicationId = new Types.ObjectId();
  const profileSnapshot = { bio: "Experience when applying", yearsExperience: 3, location: "New York", availability: "Weekdays", languages: ["English"], specialties: ["Contracts"] };
  matter = await Case.create({ title: "Synthetic application Matter", details: "PRIVATE_MATTER_DETAILS", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, jobId, applicants: [{ paralegalId: para._id, status: "pending", note: "Synthetic cover letter", profileSnapshot }] });
  await Job.collection.insertOne({ _id: jobId, caseId: matter._id, attorneyId: owner._id });
  await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: "submitted", coverLetter: "Synthetic cover letter", createdAt: new Date("2026-01-01"), profileSnapshot, syncStatus: "synced", syncError: "PRIVATE_SYNC_ERROR", starredBy: [owner._id], statusHistory: [{ from: "", to: "submitted", at: new Date("2026-01-01"), actorId: para._id, reason: "PRIVATE_REASON" }] });
});
afterEach(() => jest.restoreAllMocks());
const read = (actor = owner, query = "") => request(app).get(`/api/cases/${matter._id}/application-review?expectedOwnerId=${actor._id}${query}`).set("Cookie", authCookieFor(actor));
const raw = () => Promise.all([Case.collection.findOne({ _id: matter._id }), Job.collection.findOne({ _id: jobId }), Application.collection.findOne({ _id: applicationId })]);

test("owner/admin read a private explicit projection; other attorneys and paralegals cannot read it", async () => {
  for (const actor of [owner, admin]) {
    const response = await read(actor); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({ caseId: String(matter._id), ownerId: String(actor._id), applications: [{ applicationId: String(applicationId), applicantId: String(para._id), status: "submitted", appliedAt: "2026-01-01T00:00:00.000Z", profileSnapshot: { bio: "Experience when applying" }, history: [{ from: "unknown", to: "submitted" }] }] });
    expect(JSON.stringify(response.body)).not.toMatch(/email|password|PRIVATE_|actorId|stripe|syncError/);
  }
  for (const actor of [other, para]) expect([403, 404]).toContain((await read(actor)).status);
  expect((await request(app).get(`/api/cases/${matter._id}/application-review`)).status).toBe(401);
});
test("reading and opening a selected application never writes status, snapshots, mirrors, or notifications", async () => {
  const before = await raw(); await User.collection.updateOne({ _id: para._id }, { $set: { bio: "Changed current profile", yearsExperience: 10 } });
  const response = await read(owner, `&applicantId=${para._id}`); expect(response.status).toBe(200);
  expect(response.body.applications[0].profileSnapshot.bio).toBe("Experience when applying"); expect(response.body.applications[0].starred).toBe(true);
  expect(await raw()).toEqual(before); expect(require("../utils/notifyUser").notifyUser).not.toHaveBeenCalled();
});
test("LinkedIn references come from submitted records and invalid addresses never become links", async () => {
  await User.collection.updateOne({ _id: para._id }, { $set: { linkedInURL: "https://www.linkedin.com/in/current-profile" } });
  for (const [recorded, expected] of [["https://www.linkedin.com/in/submitted-profile", "https://www.linkedin.com/in/submitted-profile"], ["http://linkedin.com/in/earlier-profile", "http://linkedin.com/in/earlier-profile"], ["", null], ["javascript:alert(1)", null], ["https://linkedin.com.attacker.test/in/person", null], ["https://linkedin.com@attacker.test", null], ["https://user:password@linkedin.com/in/person", null], ["https://attacker.test/linkedin.com", null]]) {
    await Application.collection.updateOne({ _id: applicationId }, { $set: { linkedInURL: recorded } });
    const before = await raw(), response = await read(); expect({ status: response.status, body: response.body, recorded }).toMatchObject({ status: 200 });
    expect(response.body.applications[0]).toMatchObject({ linkedInRecorded: !!recorded, linkedInReference: expected }); expect(await raw()).toEqual(before);
  }
  await Application.deleteMany({});
  await Case.collection.updateOne({ _id: matter._id }, { $set: { "applicants.0.linkedInURL": "https://www.linkedin.com/in/earlier-application" } });
  expect((await read()).body.applications[0]).toMatchObject({ applicationId: null, linkedInReference: "https://www.linkedin.com/in/earlier-application" });
});
test.each(["viewed", "shortlisted", "accepted", "rejected", "withdrawn", "unexpected"])("%s application history stays visible with explicit mirror disagreement", async state => {
  await Application.collection.updateOne({ _id: applicationId }, { $set: { status: state, syncStatus: "needs_reconciliation", withdrawnAt: state === "withdrawn" ? new Date("2026-01-02") : null } });
  const response = await read(); expect(response.status).toBe(200); expect(response.body.applications).toHaveLength(1);
  expect(response.body.applications[0]).toMatchObject({ status: state === "unexpected" ? "unknown" : state, matterStatus: "submitted", warnings: ["viewed", "shortlisted"].includes(state) ? ["sync_pending"] : ["sync_pending", "records_differ"] });
});
test("withdrawal's removed Matter entry does not fabricate a missing-mirror fault", async () => {
  await Application.collection.updateOne({ _id: applicationId }, { $set: { status: "withdrawn" } });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { applicants: [] } });
  expect((await read()).body.applications[0].warnings).toEqual([]);
});
test("missing posting, earlier text aliases and malformed entries remain honest and unchanged", async () => {
  await Job.deleteOne({ _id: jobId });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: String(owner._id), attorneyId: String(owner._id), applicants: [{ paralegalId: String(para._id), status: "pending", note: "Earlier letter" }, { paralegalId: "broken" }] } });
  const before = await raw(), response = await read(); expect(response.status).toBe(200);
  expect(response.body.warnings).toEqual(["posting_missing", "unreadable_records"]);
  expect(response.body.applications[0]).toMatchObject({ applicationId: null, appliedAt: null, coverLetter: "Earlier letter", warnings: ["earlier_record"] });
  expect(await raw()).toEqual(before);
});
test.each(["foreign_owner", "foreign_matter", "conflicting_alias", "conflicting_owner", "duplicate_job"])("%s posting linkage fails closed without returning another Matter's letter", async kind => {
  if (kind === "foreign_owner") await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: other._id } });
  if (kind === "foreign_matter") await Job.collection.updateOne({ _id: jobId }, { $set: { caseId: new Types.ObjectId() } });
  if (kind === "conflicting_alias") await Case.collection.updateOne({ _id: matter._id }, { $set: { job: new Types.ObjectId() } });
  if (kind === "conflicting_owner") await Case.collection.updateOne({ _id: matter._id }, { $set: { attorneyId: other._id } });
  if (kind === "duplicate_job") { await Case.collection.updateOne({ _id: matter._id }, { $unset: { jobId: "" } }); await Job.collection.insertOne({ caseId: String(matter._id), attorneyId: owner._id }); }
  const before = await raw(), response = await read(); expect(response.status).toBe(409);
  expect(response.body.code).toBe(kind === "conflicting_owner" ? "CASE_IDENTITY_CONFLICT" : "APPLICATION_REVIEW_SOURCE_INVALID");
  if (kind === "conflicting_owner") expect(response.body).toEqual({ code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." });
  expect(JSON.stringify(response.body)).not.toContain("Synthetic cover letter");
  expect(await raw()).toEqual(before);
});
test("legacy Job reverse links and text references are read without migration", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $unset: { jobId: "" } });
  await Job.collection.updateOne({ _id: jobId }, { $set: { caseId: String(matter._id), attorneyId: String(owner._id) } });
  await Application.collection.updateOne({ _id: applicationId }, { $set: { jobId: String(jobId), paralegalId: String(para._id) } });
  const before = await raw(); expect((await read()).body.applications[0].applicationId).toBe(String(applicationId)); expect(await raw()).toEqual(before);
});
test.each(["disabled", "deleted", "missing", "blocked"])("%s profiles retain application evidence but no current profile identity or link eligibility", async kind => {
  if (kind === "missing") await User.deleteOne({ _id: para._id });
  else if (kind === "blocked") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  else await User.collection.updateOne({ _id: para._id }, { $set: { [kind]: true } });
  const response = await read(); expect(response.status).toBe(200); expect(response.body.applications[0]).toMatchObject({ name: "Paralegal applicant", profileAvailable: false, coverLetter: "Synthetic cover letter" });
});
test("more than 100 applications page without duplicating mirrors, including earlier-only entries and selected lookup", async () => {
  const entries = Array.from({ length: 105 }, () => ({ _id: new Types.ObjectId(), jobId, paralegalId: new Types.ObjectId(), status: "rejected", coverLetter: "Earlier decision", syncStatus: "synced" }));
  await Application.collection.insertMany(entries);
  const legacy = Array.from({ length: 30 }, () => ({ paralegalId: new Types.ObjectId(), note: "Legacy only", status: "pending" }));
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: { $each: legacy } } });
  let cursor = "", seen = [];
  do { const response = await read(owner, cursor ? `&cursor=${cursor}` : ""); expect(response.status).toBe(200); expect(response.body.applications.length).toBeLessThanOrEqual(25); seen.push(...response.body.applications.map(item => item.applicantId)); cursor = response.body.next; } while (cursor);
  expect(seen).toHaveLength(136); expect(new Set(seen).size).toBe(136);
  const selected = await read(owner, `&applicantId=${entries[40].paralegalId}`); expect(selected.body.applications).toHaveLength(1); expect(selected.body.next).toBeNull();
});
test("archived empty Matters and missing selected applicants have truthful empty lists", async () => {
  await Application.deleteMany({}); await Case.collection.updateOne({ _id: matter._id }, { $set: { applicants: [], archived: true } });
  expect((await read()).body).toMatchObject({ archived: true, applications: [], warnings: [], next: null });
  expect((await read(owner, `&applicantId=${para._id}`)).body.applications).toEqual([]);
});
test.each(["cursor=garbage", "cursor=m:-1", "cursor=m:10000", "cursor=a:bad", "applicantId=wrong", "applicantId[$ne]=x"])("malformed query %s is rejected", async query => {
  expect((await read(owner, `&${query}`)).status).toBe(400);
});
test("a changed account and nonzero token version are handled by the verified token contract", async () => {
  expect((await request(app).get(`/api/cases/${matter._id}/application-review?expectedOwnerId=${other._id}`).set("Cookie", authCookieFor(owner))).status).toBe(403);
  await User.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); owner.authVersion = 1;
  expect((await read()).status).toBe(200);
});
test.each(["owner", "session", "application", "profile", "block"])("%s changes while a review loads discard the old application", async change => {
  const original = User.collection.find.bind(User.collection); let altered = false, reads = 0;
  jest.spyOn(User.collection, "find").mockImplementation((...args) => {
    const cursor = original(...args), toArray = cursor.toArray.bind(cursor);
    // Place the race after the candidate profile read, not the separate fresh
    // account lookup, which now also uses the raw identity reader.
    if (!args[0]?._id?.$in?.some(value => String(value).toLowerCase() === String(para._id))) return cursor;
    cursor.toArray = async () => { const value = await toArray(); reads++; if (!altered && (change !== "block" || reads === 2)) {
      altered = true;
      if (change === "owner") await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: other._id, attorneyId: other._id } });
      if (change === "session") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } });
      if (change === "application") await Application.collection.updateOne({ _id: applicationId }, { $set: { status: "withdrawn" } });
      if (change === "profile") await User.collection.updateOne({ _id: para._id }, { $set: { deleted: true } });
      if (change === "block") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id });
    } return value; }; return cursor;
  });
  const response = await read(); expect([403, 404, 409]).toContain(response.status); expect(JSON.stringify(response.body)).not.toContain("Synthetic cover letter");
});
