const mongoose = require("mongoose");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require("../utils/email");
const Notice = require("../models/MatterWorkNotification"), Notification = require("../models/Notification");
const User = require("../models/User"), Case = require("../models/Case");
const { notifyUser } = require("../utils/notifyUser");
const { processNotices, noticeStatus } = require("../services/matterWorkNotifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
let attorney, paralegal, matter;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); sendEmail.mockReset(); sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  [attorney, paralegal] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@work-notices.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, title: "Private lease review", details: "Synthetic", status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_work_notice", fundingIntegrityStatus: "verified", hiredAt: new Date() });
});
async function stage() {
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => { await notifyUser(paralegal._id, "case_work_ready", { caseId: matter._id, caseTitle: matter.title }, { session, deferDispatch: true, workReady: true }); }); }
  finally { await session.endSession(); }
}
const read = () => Notice.findOne({ caseId: matter._id }).lean();
test("the obligation retains references, survives dispatch loss and is claimed once by concurrent workers", async () => {
  await stage();
  expect(await Notification.countDocuments()).toBe(1); expect(sendEmail).not.toHaveBeenCalled();
  expect(JSON.stringify(await read())).not.toMatch(/Private|lease|work-notices\.test/);
  expect((await Promise.all([processNotices(), processNotices()])).reduce((a, b) => a + b, 0)).toBe(1);
  expect(await read()).toMatchObject({ status: "accepted", attempts: 1 });
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][0]).toBe(paralegal.email);
  expect(sendEmail.mock.calls[0][2]).toContain(`/case-detail.html?caseId=${matter._id}&amp;tab=work`);
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each([
  ["email_disabled", { "notificationPrefs.email": false }, false],
  ["matter_email_disabled", { "notificationPrefs.emailCase": false }, false],
  ["in_app_disabled", { "notificationPrefs.inApp": false }, true],
])("staging respects independent %s preferences", async (_name, changes, email) => {
  await User.updateOne({ _id: paralegal._id }, { $set: changes }); await stage();
  expect(await Notice.countDocuments()).toBe(email ? 1 : 0);
  expect(await Notification.countDocuments()).toBe(email ? 0 : 1);
});
test.each([
  ["closed", { status: "completed" }], ["unfunded", { escrowStatus: "awaiting_funding" }],
  ["revoked", { paralegalAccessRevokedAt: new Date() }], ["archived", { archived: true }],
  ["reassigned", { paralegal: new mongoose.Types.ObjectId(), paralegalId: new mongoose.Types.ObjectId() }],
  ["same_person_new_assignment", { hiredAt: new Date("2030-01-01") }],
  ["owner_conflict", { attorneyId: new mongoose.Types.ObjectId() }],
  ["funding_unverified", { fundingIntegrityStatus: "pending" }],
])("delivery rechecks %s Matter state and suppresses a stale work invitation", async (_name, changes) => {
  await stage(); await Case.collection.updateOne({ _id: matter._id }, { $set: changes });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test.each(["recipient_disabled", "owner_disabled", "preference_changed"])("delivery rechecks %s", async state => {
  await stage();
  await User.updateOne({ _id: state === "owner_disabled" ? attorney._id : paralegal._id }, { $set: state === "preference_changed" ? { "notificationPrefs.emailCase": false } : { disabled: true } });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test("an address change uses the current recipient address without retaining the old address", async () => {
  await stage(); await User.updateOne({ _id: paralegal._id }, { $set: { email: "new-address@work-notices.test" } });
  await processNotices(); expect(sendEmail.mock.calls[0][0]).toBe("new-address@work-notices.test");
  expect(JSON.stringify(await read())).not.toMatch(/work-notices\.test/);
});
test("unknown SMTP acceptance stays reviewable and is never automatically resent", async () => {
  await stage(); sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic closed connection"), { code: "ECONNECTION", command: "CONN" }));
  await processNotices(); expect(await read()).toMatchObject({ status: "unknown", attempts: 1 });
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
  const status = await noticeStatus(); expect(status.counts.unknown).toBe(1); expect(status.recent[0].revision).toMatch(/^[a-f0-9]{64}$/); expect(status.recent[0].claim).toBeUndefined();
});
test("missing delivery indexes prevent a successful assignment notice commit", async () => {
  jest.spyOn(Notice.collection, "indexes").mockResolvedValueOnce([]);
  await expect(stage()).rejects.toThrow("indexes");
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
});
