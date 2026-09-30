process.env.STRIPE_SECRET_KEY = "sk_test_stub";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
jest.mock("../utils/email", () => jest.fn(async () => ({ disabled: true })));
jest.mock("../services/caseLifecycle", () => ({
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4 synthetic")),
  uploadPdfToS3: jest.fn(async () => ({ key: "synthetic/receipt.pdf" })),
}));
const Case = require("../models/Case"), Job = require("../models/Job"), User = require("../models/User");
const Notification = require("../models/Notification"), Audit = require("../models/AuditLog"), Notice = require("../models/MatterWithdrawalNotification");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use(cookieParser(), express.json());
app.use("/api/cases", require("../routes/cases"));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 503).json({ error: "Synthetic request could not be confirmed." }));
let attorney, paralegal, matter, job;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [attorney, paralegal] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@withdrawal-notice.test`, password: "Synthetic123!", role, status: "approved", state: "NY" })));
  matter = await Case.create({ title: "Lease review", details: "Synthetic Matter with unfinished work.", practiceArea: "contract law", state: "NY", attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: "in progress", hiredAt: new Date(), escrowStatus: "funded", escrowIntentId: "pi_withdrawal_notice", fundingIntegrityStatus: "verified", lockedTotalAmount: 70000, totalAmount: 70000, remainingAmount: 70000, currency: "usd", tasks: [{ title: "Review lease", completed: false }, { title: "Prepare revisions", completed: false }] });
  job = await Job.create({ caseId: matter._id, attorneyId: attorney._id, title: matter.title, description: matter.details, practiceArea: "contract law", state: "NY", budget: 700, status: "assigned" });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id } });
});
const raw = () => Case.collection.findOne({ _id: matter._id });
const send = () => request(app).post(`/api/cases/${matter._id}/withdraw`).set("Cookie", `token=${require("jsonwebtoken").sign({ id: String(paralegal._id), role: "paralegal", av: paralegal.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`).send({});
test.each(["in_app", "audit", "posting"])("a failed %s write leaves withdrawal uncommitted and retry records it once", async failure => {
  const before = await raw(), postingBefore = await Job.collection.findOne({ _id: job._id });
  const target = failure === "in_app" ? Notification : failure === "audit" ? Audit : Job;
  const method = failure === "posting" ? "findByIdAndUpdate" : "create";
  const unavailable = jest.spyOn(target, method).mockRejectedValueOnce(new Error("Synthetic persistence interruption"));
  expect((await send()).status).toBeGreaterThanOrEqual(500);
  expect(await raw()).toEqual(before);
  expect(await Job.collection.findOne({ _id: job._id })).toEqual(postingBefore);
  expect(await Notification.countDocuments()).toBe(0);
  expect(await Audit.countDocuments({ case: matter._id })).toBe(0);
  expect(await Notice.countDocuments()).toBe(0);
  unavailable.mockRestore();
  expect((await send()).status).toBe(200);
  expect((await send()).body.alreadyProcessed).toBe(true);
  expect(await Notification.countDocuments({ "payload.caseId": String(matter._id) })).toBe(2);
  expect(await Audit.countDocuments({ case: matter._id, action: "case.withdrawal.requested" })).toBe(1);
  expect(await Notice.countDocuments({ caseId: matter._id, status: "pending" })).toBe(2);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});

for (const partial of [false, true]) {
  test(`a ${partial ? 'partially completed' : 'zero-work'} withdrawal cannot commit without its email obligation`, async () => {
    if (partial) await Case.updateOne({ _id: matter._id }, { $set: { "tasks.0.completed": true } });
    const before = await raw(), postingBefore = await Job.collection.findOne({ _id: job._id });
    jest.spyOn(Notice, "create").mockRejectedValueOnce(new Error("Synthetic email obligation write failed"));
    expect((await send()).status).toBeGreaterThanOrEqual(500);
    expect(await raw()).toEqual(before); expect(await Job.collection.findOne({ _id: job._id })).toEqual(postingBefore);
    expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0); expect(await Audit.countDocuments({ case: matter._id })).toBe(0);
    expect((await send()).status).toBe(200);
    expect(await Notice.countDocuments({ outcome: partial ? "awaiting_attorney_decision" : "zero_auto" })).toBe(2);
  });
  test(`concurrent ${partial ? 'partial' : 'zero-work'} withdrawal requests record one outcome and two notices`, async () => {
    if (partial) await Case.updateOne({ _id: matter._id }, { $set: { "tasks.0.completed": true } });
    const before = await raw();
    const responses = await Promise.all([send(), send()]);
    expect(responses.map(item => item.status)).toEqual([200, 200]);
    expect(responses.filter(item => item.body.alreadyProcessed)).toHaveLength(1);
    const after = await raw();
    expect(after).toMatchObject({ status: "paused", pausedReason: "paralegal_withdrew", paralegal: null, paralegalId: null });
    for (const field of ["totalAmount", "lockedTotalAmount", "remainingAmount", "escrowIntentId", "fundingIntegrityStatus", "tasks", "withdrawalHistory"]) expect(after[field]).toEqual(before[field]);
    expect(await Notice.countDocuments({ caseId: matter._id })).toBe(2);
    expect(await Notification.countDocuments()).toBe(2);
    expect(await Audit.countDocuments({ case: matter._id, action: "case.withdrawal.requested" })).toBe(1);
    expect((await Job.findById(job._id)).status).toBe(partial ? "assigned" : "open");
  });
}
test.each(["email", "emailCase", "inApp", "inAppCase"])("withdrawal respects independent %s preferences", async pref => {
  await User.updateMany({}, { $set: { [`notificationPrefs.${pref}`]: false } });
  expect((await send()).status).toBe(200);
  const emailOff = pref.startsWith("email");
  expect(await Notice.countDocuments()).toBe(emailOff ? 0 : 2);
  expect(await Notification.countDocuments()).toBe(emailOff ? 2 : 0);
  expect(require("../utils/email")).not.toHaveBeenCalled();
});
test("missing delivery indexes leave the assignment and posting untouched", async () => {
  const before = await raw(); jest.spyOn(Notice.collection, "indexes").mockResolvedValueOnce([]);
  expect((await send()).status).toBeGreaterThanOrEqual(500); expect(await raw()).toEqual(before);
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
});
test.each(["missing", "foreign_owner", "foreign_matter", "conflicting_link"])("a %s posting cannot be reopened by withdrawal", async state => {
  const mongoose = require("mongoose");
  if (state === "missing") await Job.deleteOne({ _id: job._id });
  else if (state === "conflicting_link") await Case.collection.updateOne({ _id: matter._id }, { $set: { job: new mongoose.Types.ObjectId() } });
  else await Job.collection.updateOne({ _id: job._id }, { $set: { [state === "foreign_owner" ? "attorneyId" : "caseId"]: new mongoose.Types.ObjectId() } });
  const before = await raw(), postingBefore = await Job.collection.findOne({ _id: job._id });
  expect((await send()).status).toBe(409); expect(await raw()).toEqual(before);
  expect(await Job.collection.findOne({ _id: job._id })).toEqual(postingBefore);
  expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});
test("a zero-work withdrawal creates its missing posting within the same transaction", async () => {
  await Job.deleteOne({ _id: job._id }); await Case.updateOne({ _id: matter._id }, { $set: { jobId: null } });
  const before = await raw(); jest.spyOn(Notice, "create").mockRejectedValueOnce(new Error("Synthetic interruption after posting creation"));
  expect((await send()).status).toBeGreaterThanOrEqual(500); expect(await raw()).toEqual(before); expect(await Job.countDocuments()).toBe(0);
  expect((await send()).status).toBe(200); expect(await Job.countDocuments({ caseId: matter._id, status: "open" })).toBe(1);
});
test("a concurrent account suspension prevents withdrawal from committing", async () => {
  const before = await raw(), update = User.collection.updateOne.bind(User.collection); let changed = false;
  jest.spyOn(User.collection, "updateOne").mockImplementation(async (filter, values, options) => {
    if (!changed && String(filter._id) === String(paralegal._id) && options?.session && values.$inc?.__v === 1) {
      changed = true; await update({ _id: paralegal._id }, { $set: { disabled: true } });
    }
    return update(filter, values, options);
  });
  expect((await send()).status).toBe(403); expect(changed).toBe(true); expect(await raw()).toEqual(before);
  expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});
test.each(["case_reference", "posting_backlink"])("a retained string %s resolves the same existing posting without creating another", async state => {
  if (state === "case_reference") {
    await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId: String(job._id) } });
    await Job.collection.updateOne({ _id: job._id }, { $unset: { caseId: "" } });
  } else {
    await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId: null } });
    await Job.collection.updateOne({ _id: job._id }, { $set: { caseId: String(matter._id) } });
  }
  expect((await send()).status).toBe(200);
  expect(String((await raw()).jobId)).toBe(String(job._id));
  expect(await Job.countDocuments()).toBe(1); expect((await Job.findById(job._id)).status).toBe("open");
  expect(await Notice.countDocuments()).toBe(2);
});

for (const partial of [false, true]) test(`a token version revoked during ${partial ? 'partial' : 'zero-work'} withdrawal preparation cannot commit`, async () => {
  if (partial) await Case.updateOne({ _id: matter._id }, { $set: { 'tasks.0.completed': true } });
  const before = await raw(), postingBefore = await Job.collection.findOne({ _id: job._id });
  const update = User.collection.updateOne.bind(User.collection); let revoked = false;
  jest.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, values, options) => {
    if (!revoked && String(filter._id) === String(paralegal._id) && options?.session && values.$inc?.__v === 1) {
      revoked = true; await update({ _id: paralegal._id }, { $inc: { authVersion: 1 } });
    }
    return update(filter, values, options);
  });
  const response = await send();
  expect({ revoked, status: response.status }).toEqual({ revoked: true, status: 403 });
  expect(await raw()).toEqual(before); expect(await Job.collection.findOne({ _id: job._id })).toEqual(postingBefore);
  expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0); expect(await Audit.countDocuments({ case: matter._id })).toBe(0);
});
