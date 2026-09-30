const mongoose = require("mongoose");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require("../utils/email");
const Notice = require("../models/MatterWithdrawalNotification"), Notification = require("../models/Notification");
const User = require("../models/User"), Case = require("../models/Case"), Job = require("../models/Job");
const { notifyUser } = require("../utils/notifyUser");
const { processNotices, noticeStatus, stageDecision } = require("../services/matterWithdrawalNotifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
let attorney, paralegal, matter;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); sendEmail.mockReset(); sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  [attorney, paralegal] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@withdrawal-delivery.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, withdrawnParalegalId: paralegal._id, title: "Private lease review", details: "Synthetic", status: "paused", pausedReason: "paralegal_withdrew", pausedAt: new Date(), escrowStatus: "funded", escrowIntentId: "pi_withdrawal_delivery", fundingIntegrityStatus: "verified", tasks: [{ title: "Review", completed: true }, { title: "Finish", completed: false }] });
});
async function stage(user = attorney) {
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => { await notifyUser(user._id, "case_update", { caseId: String(matter._id), caseTitle: matter.title, outcome: "paralegal_withdrawn" }, { session, deferDispatch: true, withdrawalRequest: true }); }); }
  finally { await session.endSession(); }
}
const read = () => Notice.findOne({ caseId: matter._id }).lean();
test.each(["attorney", "paralegal"])("%s delivery survives dispatch loss, has a relevant destination and is claimed once", async role => {
  const user = role === "attorney" ? attorney : paralegal;
  await stage(user);
  expect(await Notification.countDocuments()).toBe(1); expect(sendEmail).not.toHaveBeenCalled();
  expect(JSON.stringify(await read())).not.toMatch(/Private|lease|withdrawal-delivery\.test/);
  expect((await Promise.all([processNotices(), processNotices()])).reduce((a, b) => a + b, 0)).toBe(1);
  expect(await read()).toMatchObject({ status: "accepted", attempts: 1 });
  expect(sendEmail).toHaveBeenCalledTimes(1); expect(sendEmail.mock.calls[0][0]).toBe(user.email);
  const destination = require("../services/objectDeepLinks").buildObjectDeepLink({ type: role === "attorney" ? "matter" : "completed_matter", caseId: String(matter._id), role, tab: "financials" });
  expect(sendEmail.mock.calls[0][2]).toContain(destination.replace(/&/g, "&amp;"));
  expect(sendEmail.mock.calls[0][2]).toContain(role === "attorney" ? "Review withdrawal" : "View Matter history");
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each([
  ["closed", { status: "completed" }], ["archived", { archived: true }],
  ["new_assignment", { paralegal: new mongoose.Types.ObjectId(), paralegalId: new mongoose.Types.ObjectId() }],
  ["new_withdrawal", { pausedAt: new Date("2030-01-01") }],
  ["different_withdrawn_member", { withdrawnParalegalId: new mongoose.Types.ObjectId() }],
  ["owner_conflict", { attorneyId: new mongoose.Types.ObjectId() }],
  ["decision_recorded", { payoutFinalizedAt: new Date(), payoutFinalizedType: "partial_attorney" }],
  ["review_window", { disputeDeadlineAt: new Date() }],
  ["decision_processing", { withdrawalClaimStatus: "claimed", withdrawalClaimToken: "synthetic" }],
  ["payment_released", { paymentReleased: true }],
])("delivery rechecks %s and suppresses an obsolete withdrawal request", async (_name, changes) => {
  await stage(); await Case.collection.updateOne({ _id: matter._id }, { $set: changes });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test.each(["disabled", "deleted", "suspended", "wrong_role", "unapproved", "email_off", "case_email_off"])("delivery rechecks a %s recipient", async state => {
  await stage();
  await User.collection.updateOne({ _id: attorney._id }, { $set: state === "wrong_role" ? { role: "paralegal" } : state === "unapproved" ? { status: "pending" } : state === "email_off" ? { "notificationPrefs.email": false } : state === "case_email_off" ? { "notificationPrefs.emailCase": false } : { [state]: true } });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test("delivery uses the current email address and escaped current Matter title", async () => {
  await stage(); await User.updateOne({ _id: attorney._id }, { $set: { email: "current@withdrawal-delivery.test" } });
  await Case.updateOne({ _id: matter._id }, { $set: { title: "Lease <draft> & exhibits" } });
  await processNotices(); expect(sendEmail.mock.calls[0][0]).toBe("current@withdrawal-delivery.test");
  expect(sendEmail.mock.calls[0][2]).toContain("Lease &lt;draft&gt; &amp; exhibits");
  expect(JSON.stringify(await read())).not.toMatch(/withdrawal-delivery\.test|Lease|draft/);
});
test.each([true, false])("zero-work email requires a currently open posting: %s", async open => {
  const job = await Job.create({ caseId: matter._id, attorneyId: attorney._id, title: matter.title, description: matter.details, practiceArea: "contract law", state: "NY", budget: 700, status: "open" });
  await Case.updateOne({ _id: matter._id }, { $set: { jobId: job._id, payoutFinalizedType: "zero_auto", partialPayoutAmount: 0, payoutFinalizedAt: matter.pausedAt, relistRequestedAt: matter.pausedAt, postingSyncStatus: "synced" } });
  await stage();
  if (!open) await Job.updateOne({ _id: job._id }, { $set: { status: "closed" } });
  await processNotices(); expect((await read()).status).toBe(open ? "accepted" : "skipped");
  if (open) expect(sendEmail.mock.calls[0][2]).toContain("No payout is due"); else expect(sendEmail).not.toHaveBeenCalled();
});
test("unknown SMTP acceptance remains reviewable without automatic duplicate delivery", async () => {
  await stage(); sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic closed connection"), { code: "ECONNECTION", command: "CONN" }));
  await processNotices(); expect(await read()).toMatchObject({ status: "unknown", attempts: 1 });
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
  const status = await noticeStatus(); expect(status.counts.unknown).toBe(1); expect(status.recent[0].revision).toMatch(/^[a-f0-9]{64}$/); expect(status.recent[0].claim).toBeUndefined();
});
test("a definite rejection retries after its backoff", async () => {
  await stage(); sendEmail.mockImplementationOnce(async to => ({ rejected: [to] }));
  await processNotices(); expect((await read()).status).toBe("failed");
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
  await Notice.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  await processNotices(); expect((await read()).status).toBe("accepted"); expect(sendEmail).toHaveBeenCalledTimes(2);
});

async function decision(kind, amount = 20000) {
  const at = new Date();
  const change = kind === "reject" ? { disputeDeadlineAt: new Date(Date.now() + 86400000) }
    : { payoutFinalizedAt: at, payoutFinalizedType: kind === "expired" || kind === "relist" ? "expired_zero" : "partial_attorney", partialPayoutAmount: kind === "partial" ? amount : 0, remainingAmount: 70000 - (kind === "partial" ? amount : 0), disputeDeadlineAt: null };
  if (kind === "relist") {
    const job = await Job.create({ caseId: matter._id, attorneyId: attorney._id, title: matter.title, description: matter.details, practiceArea: "contract law", state: "NY", budget: 700, status: "open" });
    Object.assign(change, { jobId: job._id, relistRequestedAt: at, postingSyncStatus: "synced" });
  }
  await Case.collection.updateOne({ _id: matter._id }, { $set: change });
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => stageDecision(await Case.collection.findOne({ _id: matter._id }, { session }), kind, session, attorney._id)); }
  finally { await session.endSession(); }
}
test.each([
  ["partial", 20000, "partial_recorded", "Withdrawal decision recorded"],
  ["partial", 0, "zero_recorded", "Withdrawal decision recorded"],
  ["reject", 0, "review_window", "Withdrawal payment review"],
  ["relist", 0, "relisted", "Matter relisted"],
  ["expired", 0, "expired_zero", "Withdrawal review ended"],
])("%s %i retains and delivers both current outcome notices once", async (kind, amount, outcome, subject) => {
  await decision(kind, amount);
  const retained = await Notice.find().lean(); expect(retained).toHaveLength(2); expect(retained.every(item => item.kind === kind && item.outcome === outcome && item.eventAt)).toBe(true);
  expect(await Notification.countDocuments()).toBe(2); expect(sendEmail).not.toHaveBeenCalled();
  expect(JSON.stringify(retained)).not.toMatch(/Private|lease|withdrawal-delivery\.test|amountCents|remainingAmount/);
  expect((await Promise.all([processNotices(), processNotices()])).reduce((a, b) => a + b, 0)).toBe(2);
  expect(sendEmail).toHaveBeenCalledTimes(2);
  for (const user of [attorney, paralegal]) {
    const call = sendEmail.mock.calls.find(item => item[0] === user.email); expect(call[1]).toBe(`${subject} on LPC`);
    const href = require("../services/objectDeepLinks").buildObjectDeepLink({ type: user.role === "attorney" ? "matter" : "completed_matter", caseId: String(matter._id), role: user.role, tab: "financials" });
    expect(call[2]).toContain(href.replace(/&/g, "&amp;")); expect(call[2]).not.toContain('Paid in full');
  }
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(2);
});
test.each([
  ["different withdrawal", "partial", { pausedAt: new Date("2030-01-01") }],
  ["different decision", "partial", { payoutFinalizedAt: new Date("2030-01-01") }],
  ["different payee", "partial", { withdrawnParalegalId: new mongoose.Types.ObjectId() }],
  ["different owner", "partial", { attorney: new mongoose.Types.ObjectId() }],
  ["new assignment", "partial", { paralegalId: new mongoose.Types.ObjectId() }],
  ["open dispute", "partial", { disputes: [{ status: "open" }] }],
  ["read only", "partial", { readOnly: true }],
  ["closed Matter", "expired", { status: "completed" }],
  ["closed deadline", "reject", { disputeDeadlineAt: new Date(Date.now() - 1000) }],
  ["replaced deadline", "reject", { disputeDeadlineAt: new Date("2030-01-01") }],
  ["later finalized decision", "reject", { payoutFinalizedAt: new Date() }],
  ["replaced relisting", "relist", { relistRequestedAt: new Date("2030-01-01") }],
  ["changed outcome", "expired", { payoutFinalizedType: "admin", partialPayoutAmount: 20000 }],
])("a %s suppresses delayed %s notices", async (_label, kind, change) => {
  await decision(kind); await Case.collection.updateOne({ _id: matter._id }, { $set: change });
  await processNotices(); expect(await Notice.countDocuments({ status: "skipped" })).toBe(2); expect(sendEmail).not.toHaveBeenCalled();
});
test("a relisting email cannot advertise a closed or conflicting posting", async () => {
  await decision("relist"); await Job.updateMany({}, { $set: { status: "closed" } });
  await processNotices(); expect(await Notice.countDocuments({ status: "skipped" })).toBe(2); expect(sendEmail).not.toHaveBeenCalled();
});
test("relisting notices preserve the retained full-decision type supported by receipt history", async () => {
  await decision("relist"); await Case.collection.updateOne({ _id: matter._id }, { $set: { payoutFinalizedType: "full" } });
  await processNotices(); expect(await Notice.countDocuments({ status: "accepted" })).toBe(2); expect(sendEmail).toHaveBeenCalledTimes(2);
});
test.each(["email", "emailCase", "inApp", "inAppCase"])("decision notices honor independent %s preferences", async pref => {
  await User.updateMany({}, { $set: { [`notificationPrefs.${pref}`]: false } });
  await decision("partial"); const emailOff = pref.startsWith("email");
  expect(await Notice.countDocuments()).toBe(emailOff ? 0 : 2); expect(await Notification.countDocuments()).toBe(emailOff ? 2 : 0);
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(emailOff ? 0 : 2);
});
test("delayed decision delivery reads current recipient eligibility and preferences", async () => {
  await decision("partial"); await User.updateOne({ _id: attorney._id }, { $set: { disabled: true } });
  await User.updateOne({ _id: paralegal._id }, { $set: { "notificationPrefs.emailCase": false } });
  await processNotices(); expect(await Notice.countDocuments({ status: "skipped" })).toBe(2); expect(sendEmail).not.toHaveBeenCalled();
});
test("a saved review notice describes its event after the window expires while its email is suppressed", async () => {
  await decision("reject");
  await Case.collection.updateOne({ _id: matter._id }, { $set: { disputeDeadlineAt: new Date(Date.now() - 1000) } });
  const current = await Case.collection.findOne({ _id: matter._id });
  const present = require("../services/notificationPresentation").presentNotification;
  for (const user of [attorney, paralegal]) {
    const retained = await Notification.findOne({ userId: user._id }).lean();
    expect(present(retained, { viewer: user, caseDoc: current }).message).toBe("Private lease review: Release was declined and a payment-review window was opened.");
  }
  await processNotices(); expect(await Notice.countDocuments({ status: "skipped" })).toBe(2); expect(sendEmail).not.toHaveBeenCalled();
});
