const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server"), { randomUUID } = require("crypto");
const { clearDatabase } = require("./helpers/db");
jest.mock("../utils/stripe", () => ({ customers: { retrieve: jest.fn() }, paymentIntents: { create: jest.fn() }, sanitizeStripeError: jest.fn((_error, fallback) => fallback) }));
jest.mock("../utils/email", () => jest.fn(async () => ({})));
const Case = require("../models/Case"), Application = require("../models/Application"), Job = require("../models/Job"), User = require("../models/User"), Block = require("../models/Block"), Decision = require("../models/ApplicationDecision");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, owner, other, para, caseId, jobId, applicationId;
const path = () => `/api/cases/${caseId}/application-review/${para._id}/decision`;
const read = (user = owner) => request(app).get(path()).query({ expectedOwnerId: String(user._id) }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(app).post(path()).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const selection = async action => { const response = await read(); expect(response.status).toBe(200); return { revision: response.body.revision, action, requestId: randomUUID() }; };
const raw = () => Promise.all([Case.collection.findOne({ _id: caseId }), Application.collection.findOne({ _id: applicationId }), Job.collection.findOne({ _id: jobId })]);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("application-decision-tests"));
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@decisions.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  caseId = new mongoose.Types.ObjectId(); jobId = new mongoose.Types.ObjectId(); applicationId = new mongoose.Types.ObjectId();
  await Case.collection.insertOne({ _id: caseId, attorney: owner._id, attorneyId: owner._id, title: "Synthetic decision Matter", status: "open", jobId, applicants: [{ paralegalId: para._id, status: "pending", note: "Preserved cover letter", unknown: "PRESERVE", starredBy: [other._id] }], unknown: "CASE_PRESERVE" });
  await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: "submitted", coverLetter: "Preserved cover letter", syncStatus: "synced", starredBy: [other._id], unknown: "APPLICATION_PRESERVE" });
  await Job.collection.insertOne({ _id: jobId, attorneyId: owner._id, caseId, applicantsCount: 1, unknown: "JOB_PRESERVE" });
});
afterEach(() => jest.restoreAllMocks());
test("reads project eligible decisions without changing records, and deny unrelated accounts", async () => {
  const before = await raw(), response = await read(); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store"); expect(response.body.actions).toEqual(["star", "shortlist", "reject"]); expect(response.body.starred).toBe(false); expect(JSON.stringify(response.body)).not.toMatch(/PRESERVE|coverLetter|password|email/); expect(await raw()).toEqual(before);
  expect((await read(other)).status).toBe(404); expect((await read(para)).status).toBe(404); expect((await request(app).get(path())).status).toBe(401);
});
test("missing acknowledgement uniqueness closes both review and direct decision writes", async () => {
  const input = await selection("star"), indexes = await Decision.collection.listIndexes().toArray();
  const index = indexes.find(item => item.unique && item.key.ownerId === 1 && item.key.requestId === 1);
  await Decision.collection.dropIndex(index.name);
  try {
    expect((await read()).body.code).toBe("APPLICATION_REVIEW_DECISION_UNAVAILABLE"); expect((await send(input)).status).toBe(503); expect(await Decision.countDocuments()).toBe(0);
  } finally { await Decision.collection.createIndex({ ownerId: 1, requestId: 1 }, { unique: true, name: index.name }); }
});
test("star, unstar, shortlist, return and reject preserve mirrors, other markers, unknown fields and exact counts", async () => {
  for (const action of ["star", "unstar", "shortlist", "return", "reject"]) {
    const input = await selection(action), response = await send(input); expect(response.status).toBe(200); expect(response.body.receipt.action).toBe(action);
    const [doc, application, job] = await raw(); const expectedStatus = { shortlist: "shortlisted", return: "submitted", reject: "rejected" }[action] || "submitted";
    expect(application.status).toBe(expectedStatus); expect(doc.applicants[0].status).toBe(["submitted", "shortlisted", "viewed"].includes(expectedStatus) ? "pending" : expectedStatus); expect(application.starredBy.map(String)).toContain(String(other._id)); expect(doc.applicants[0].starredBy.map(String)).toContain(String(other._id)); expect(application.starredBy.map(String).includes(String(owner._id))).toBe(action === "star"); expect(job.applicantsCount).toBe(action === "reject" ? 0 : 1); expect(application.coverLetter).toBe("Preserved cover letter"); expect(doc.applicants[0].unknown).toBe("PRESERVE"); expect(doc.unknown).toBe("CASE_PRESERVE"); expect(application.unknown).toBe("APPLICATION_PRESERVE"); expect(job.unknown).toBe("JOB_PRESERVE");
  }
  expect(await Decision.countDocuments()).toBe(5); expect((await Application.findById(applicationId)).statusHistory.map(item => item.to)).toEqual(["shortlisted", "submitted", "rejected"]);
});
test("a saved decision can be recovered and repeated without another history entry or notification", async () => {
  const input = await selection("reject"), first = await send(input); expect(first.status).toBe(200);
  const before = await raw(), repeat = await send(input); expect(repeat.status).toBe(200); expect(repeat.body).toEqual(first.body); expect(await raw()).toEqual(before); expect(await Decision.countDocuments()).toBe(1);
  const saved = await request(app).get(`${path()}/${input.requestId}`).query({ expectedOwnerId: String(owner._id) }).set("Cookie", cookie(owner)); expect(saved.body.receipt).toEqual(first.body.receipt);
  expect((await send({ ...input, action: "star" })).body.code).toBe("APPLICATION_REVIEW_DECISION_REQUEST_REUSED");
});
test("stale and simultaneous reviews cannot overwrite a recorded decision", async () => {
  const first = await selection("shortlist"), second = { ...first, requestId: randomUUID(), action: "reject" };
  const responses = await Promise.all([send(first), send(second)]); expect(responses.map(value => value.status).sort()).toEqual([200, 409]); expect(await Decision.countDocuments()).toBe(1);
  expect((await send({ ...first, requestId: randomUUID() })).status).toBe(409);
});
test.each(["assigned", "hiring", "archived", "readOnly", "funded", "paused", "rejected", "withdrawn", "accepted", "profile_deleted", "blocked", "mirror_diff", "sync_pending"])("%s closes decision controls and refuses direct writes", async kind => {
  const input = await selection("reject");
  const caseChanges = { assigned: { paralegalId: para._id }, hiring: { hiringClaimToken: "claim" }, archived: { archived: true }, readOnly: { readOnly: true }, funded: { escrowStatus: "funded" }, paused: { status: "paused" }, mirror_diff: { "applicants.0.status": "accepted" } }[kind];
  if (caseChanges) await Case.collection.updateOne({ _id: caseId }, { $set: caseChanges });
  if (["accepted", "rejected", "withdrawn"].includes(kind)) await Application.collection.updateOne({ _id: applicationId }, { $set: { status: kind } });
  if (kind === "sync_pending") await Application.collection.updateOne({ _id: applicationId }, { $set: { syncStatus: "needs_reconciliation" } });
  if (kind === "profile_deleted") await User.collection.updateOne({ _id: para._id }, { $set: { deleted: true } });
  if (kind === "blocked") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  const current = await read(); expect(current.status).toBe(200); expect(current.body.actions).toEqual([]);
  expect((await send(input)).status).toBe(409); expect((await send({ ...input, revision: current.body.revision })).status).toBe(409); expect(await Decision.countDocuments()).toBe(0);
});
test("a mirror write failure rolls back the Application, Job and decision acknowledgement", async () => {
  const input = await selection("reject"), before = await raw(); jest.spyOn(Case.collection, "updateOne").mockRejectedValueOnce(new Error("Synthetic mirror failure"));
  expect((await send(input)).body.code).toBe("APPLICATION_REVIEW_DECISION_UNCONFIRMED"); expect(await raw()).toEqual(before); expect(await Decision.countDocuments()).toBe(0);
});
test("a hire committed before the decision's Case update wins without rejecting its application", async () => {
  const input = await selection("reject"), original = Case.collection.updateOne.bind(Case.collection); let once = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (...args) => { if (!once) { once = true; await original({ _id: caseId }, { $set: { paralegalId: para._id, status: "in progress" } }); } return original(...args); });
  expect((await send(input)).status).toBe(409); expect((await Application.findById(applicationId)).status).toBe("submitted"); expect(await Decision.countDocuments()).toBe(0);
});
test.each(["canonical", "earlier_only"])("a %s rejection committed after hire review prevents claiming and charging", async kind => {
  if (kind === "earlier_only") await Application.deleteMany({});
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic_decision" } });
  await User.collection.updateOne({ _id: para._id }, { $set: { stripeAccountId: "acct_synthetic_decision", stripeOnboarded: true, stripePayoutsEnabled: true } });
  await Case.collection.updateOne({ _id: caseId }, { $set: { totalAmount: 40000, lockedTotalAmount: 40000, tasks: [{ title: "Review agreement", completed: false }] } });
  const input = await selection("reject"), stripe = require("../utils/stripe");
  stripe.customers.retrieve.mockImplementationOnce(async () => {
    expect((await send(input)).status).toBe(200);
    return { id: "cus_synthetic_decision", invoice_settings: { default_payment_method: "pm_synthetic_decision" } };
  });
  const response = await request(app).post(`/api/cases/${caseId}/hire/${para._id}`).set("Cookie", cookie(owner)).send({});
  expect(response.status).toBe(409); expect(response.body.code).toBe("HIRE_IN_PROGRESS"); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  const doc = await Case.collection.findOne({ _id: caseId }); expect(doc.applicants[0].status).toBe("rejected"); expect(doc.hiringClaimToken).toBeFalsy(); expect(doc.paralegalId).toBeFalsy(); expect(await Decision.countDocuments()).toBe(1);
});
test.each(["star", "shortlist"])("a fresh hire after %s retains an unknown charge claim and prevents a second charge", async action => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { stripeCustomerId: "cus_synthetic_decision" } });
  await User.collection.updateOne({ _id: para._id }, { $set: { stripeAccountId: "acct_synthetic_decision", stripeOnboarded: true, stripePayoutsEnabled: true } });
  await Case.collection.updateOne({ _id: caseId }, { $set: { totalAmount: 40000, lockedTotalAmount: 40000, tasks: [{ title: "Review agreement", completed: false }] } });
  expect((await send(await selection(action))).status).toBe(200);
  const stripe = require("../utils/stripe");
  stripe.customers.retrieve.mockResolvedValueOnce({ id: "cus_synthetic_decision", invoice_settings: { default_payment_method: "pm_synthetic_decision" } });
  stripe.paymentIntents.create.mockRejectedValueOnce(new Error("Synthetic provider connection loss"));
  const response = await request(app).post(`/api/cases/${caseId}/hire/${para._id}`).set("Cookie", cookie(owner)).send({});
  expect(response.status).toBe(409); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  const doc = await Case.collection.findOne({ _id: caseId }); expect(doc.hiringClaimToken).toBeTruthy(); expect(doc.hiringClaimStatus).toBe("needs_reconciliation"); expect(doc.paralegalId).toBeFalsy(); expect(doc.applicants[0].status).toBe("pending"); expect((await Application.findById(applicationId)).status).toBe(action === "shortlist" ? "shortlisted" : "submitted");
  const repeat = await request(app).post(`/api/cases/${caseId}/hire/${para._id}`).set("Cookie", cookie(owner)).send({});
  expect([400, 409]).toContain(repeat.status); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test.each(["auth_version", "profile", "block", "session"])("%s loss during the transaction rolls it back", async kind => {
  const input = await selection("reject"), original = Decision.collection.insertOne.bind(Decision.collection); let token;
  if (kind === "session") { const { sessionId } = await require("../services/authSessionService").createAuthSession(owner, {}); token = require("jsonwebtoken").sign({ id: String(owner._id), role: owner.role, av: 0, sid: sessionId }, process.env.JWT_SECRET); }
  jest.spyOn(Decision.collection, "insertOne").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (kind === "auth_version") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } });
    if (kind === "profile") await User.collection.updateOne({ _id: para._id }, { $set: { deleted: true } });
    if (kind === "block") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
    if (kind === "session") await require("../services/authSessionService").revokeSession(require("jsonwebtoken").decode(token).sid, owner._id);
    return value;
  });
  const response = await (token ? send(input).set("Cookie", `token=${token}`) : send(input)); expect([403, 409]).toContain(response.status); expect((await Application.findById(applicationId)).status).toBe("submitted"); expect(await Decision.countDocuments()).toBe(0);
});
test("legacy endpoints use the same atomic guard, and earlier Matter-only applications stay earlier-only", async () => {
  await Application.deleteMany({});
  const response = await request(app).post(`/api/cases/${caseId}/applicants/${para._id}/star`).set("Cookie", cookie(owner)).send({ starred: true }); expect(response.status).toBe(200); expect(response.body.starred).toBe(true); expect(await Application.countDocuments()).toBe(0);
  const rejected = await request(app).post(`/api/cases/${caseId}/applicants/${para._id}/reject`).set("Cookie", cookie(owner)).send({}); expect(rejected.status).toBe(200); expect((await Case.collection.findOne({ _id: caseId })).applicants[0].status).toBe("rejected");
  expect((await request(app).post(`/api/cases/${caseId}/applicants/${para._id}/star`).set("Cookie", cookie(owner)).send({ starred: false })).status).toBe(409);
});
test.each([{ action: "hire" }, { requestId: "bad" }, { revision: "bad" }, { expectedOwnerId: "0".repeat(24) }, { ignored: true }])("malformed or foreign-account decision %j cannot write", async patch => {
  const before = await raw(); expect([400, 403]).toContain((await send({ ...await selection("reject"), ...patch })).status); expect(await raw()).toEqual(before);
});

for (const failure of ["in_app", "audit"]) test(`a failed ${failure} nonselection notice effect leaves the decision uncommitted and retry records it once`, async () => {
  const Notification = require("../models/Notification"), Audit = require("../models/AuditLog");
  const input = await selection("reject"), before = await raw();
  const interruption = jest.spyOn(failure === "in_app" ? Notification : Audit, "create").mockRejectedValueOnce(new Error("Synthetic decision effect interruption"));
  const response = await send(input);
  expect({ status: response.status, unchanged: JSON.stringify(await raw()) === JSON.stringify(before), decisions: await Decision.countDocuments(), notices: await Notification.countDocuments(), audits: await Audit.countDocuments({ case: caseId }) }).toEqual({ status: 503, unchanged: true, decisions: 0, notices: 0, audits: 0 });
  interruption.mockRestore();
  expect((await send(input)).status).toBe(200);
  expect((await send(input)).status).toBe(200);
  expect(await Decision.countDocuments()).toBe(1);
  expect(await Notification.countDocuments({ userId: para._id, type: "application_denied" })).toBe(1);
  expect(await Audit.countDocuments({ case: caseId, action: "case.applicant.rejected" })).toBe(1);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});

test.each(["inApp", "inAppCase", "email", "emailCase"])("nonselection preserves the applicant's %s preference without enabling email", async pref => {
  const Notification = require("../models/Notification"), Audit = require("../models/AuditLog");
  await User.updateOne({ _id: para._id }, { $set: { [`notificationPrefs.${pref}`]: false } });
  const response = await send(await selection("reject")); expect(response.status).toBe(200);
  expect(await Notification.countDocuments()).toBe(pref.startsWith("inApp") ? 0 : 1);
  expect(await Audit.countDocuments({ case: caseId, action: "case.applicant.rejected" })).toBe(1);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("star and shortlist decisions create no applicant rejection notice or audit", async () => {
  for (const action of ["star", "unstar", "shortlist", "return"]) expect((await send(await selection(action))).status).toBe(200);
  expect(await require("../models/Notification").countDocuments()).toBe(0);
  expect(await require("../models/AuditLog").countDocuments({ case: caseId })).toBe(0);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});
test.each(["canonical", "earlier_only"])("legacy %s rejection retains exactly one original applicant notice and audit", async kind => {
  if (kind === "earlier_only") await Application.deleteMany({});
  const url = `/api/cases/${caseId}/applicants/${para._id}/reject`;
  const response = await request(app).post(url).set("Cookie", cookie(owner)).send({}); expect(response.status).toBe(200);
  expect((await request(app).post(url).set("Cookie", cookie(owner)).send({})).status).toBe(409);
  const notices = await require("../models/Notification").find({}).lean(); expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ type: "application_denied", userRole: "paralegal", payload: { outcome: "not_selected" } });
  expect(String(notices[0].userId)).toBe(String(para._id)); expect(String(notices[0].actorUserId)).toBe(String(owner._id));
  const audits = await require("../models/AuditLog").find({ case: caseId }).lean(); expect(audits).toHaveLength(1);
  expect(audits[0].meta.requestId).toBe(response.body.receipt.requestId);
  expect(await Application.countDocuments()).toBe(kind === "earlier_only" ? 0 : 1);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("a rejected applicant retains factual notification history without Matter workspace access", async () => {
  const input = await selection("reject"), response = await send(input); expect(response.status).toBe(200);
  const notices = await require("../models/Notification").find({}).lean(); expect(notices).toHaveLength(1);
  const { presentNotification } = require("../services/notificationPresentation");
  const shown = presentNotification(notices[0], { viewer: { id: String(para._id), role: "paralegal" }, caseDoc: (await raw())[0], blockedIds: new Set() });
  expect(shown.message).toContain("was not selected");
  expect(shown.action).toEqual({ label: "View applications", href: "/dashboard-paralegal.html#cases" });
  const posting = await request(app).get(`/api/cases/${caseId}`).set("Cookie", cookie(para));
  expect(posting.status).toBe(200);
  expect(posting.body).toMatchObject({ tasks: [], files: [], downloadUrl: [], submissionSummary: null, escrowStatus: null, remainingAmount: null });
  expect(posting.body.attorney).not.toHaveProperty("email");
  expect((await request(app).get(`/api/cases/${caseId}/downloads`).set("Cookie", cookie(para))).status).toBe(404);
  expect((await request(app).get(`/api/cases/${caseId}/work-review`).set("Cookie", cookie(para))).status).toBe(404);
  expect((await send(input)).body.receipt).toEqual(response.body.receipt);
  expect(await require("../models/Notification").countDocuments()).toBe(1);
});
