const mongoose = require("mongoose");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require("../utils/email");
const Notice = require("../models/MatterPaymentNotification"), Notification = require("../models/Notification");
const User = require("../models/User"), Case = require("../models/Case");
const { notifyUser } = require("../utils/notifyUser");
const { processNotices, noticeStatus } = require("../services/matterPaymentNotifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
let owner, matter;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); sendEmail.mockReset(); sendEmail.mockImplementation(async to => ({ accepted: [to] }));
  owner = await User.create({ firstName: "Synthetic", lastName: "Counsel", email: "owner@payment-notices.test", password: "Synthetic123!", role: "attorney", status: "approved" });
  matter = await Case.create({ attorney: owner._id, attorneyId: owner._id, title: "Private lease review", details: "Synthetic", status: "open", escrowStatus: "awaiting_funding", paymentStatus: "requires_action", paymentIntentId: "pi_payment_notice", escrowIntentId: "pi_payment_notice" });
});
async function stage() {
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => { await notifyUser(owner._id, "case_update", { caseId: matter._id, caseTitle: matter.title, outcome: "payment_action_required", summary: "Payment requires your attention." }, { session, deferDispatch: true, paymentAction: { paymentIntentId: "pi_payment_notice", paymentStatus: "requires_action" } }); }); }
  finally { await session.endSession(); }
}
const read = () => Notice.findOne({ caseId: matter._id }).lean();
test("current payment email survives dispatch loss and concurrent workers send it once", async () => {
  await stage(); expect(await Notification.countDocuments()).toBe(1); expect(sendEmail).not.toHaveBeenCalled();
  expect(JSON.stringify(await read())).not.toMatch(/Private|lease|payment-notices\.test/);
  expect((await Promise.all([processNotices(), processNotices()])).reduce((a, b) => a + b, 0)).toBe(1);
  expect(await read()).toMatchObject({ status: "accepted", attempts: 1 });
  expect(sendEmail.mock.calls[0][0]).toBe(owner.email);
  expect(sendEmail.mock.calls[0][2]).toContain(`/case-detail.html?caseId=${matter._id}&amp;tab=financials`);
  expect(sendEmail.mock.calls[0][2]).not.toContain("pi_payment_notice");
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
});
test.each([
  ["email_disabled", { "notificationPrefs.email": false }, false],
  ["matter_email_disabled", { "notificationPrefs.emailCase": false }, false],
  ["in_app_disabled", { "notificationPrefs.inApp": false }, true],
])("staging respects independent %s preferences", async (_name, changes, email) => {
  await User.updateOne({ _id: owner._id }, { $set: changes }); await stage();
  expect(await Notice.countDocuments()).toBe(email ? 1 : 0); expect(await Notification.countDocuments()).toBe(email ? 0 : 1);
});
test.each([
  ["completed", { status: "completed" }], ["funded", { escrowStatus: "funded" }],
  ["paid", { paymentStatus: "succeeded" }], ["different_action", { paymentStatus: "requires_payment_method" }],
  ["archived", { archived: true }], ["read_only", { readOnly: true }],
  ["different_payment", { paymentIntentId: "pi_replacement", escrowIntentId: "pi_replacement" }],
  ["conflicting_payment", { paymentIntentId: "pi_other" }],
  ["missing_payment", { paymentIntentId: "", escrowIntentId: "" }],
  ["owner_conflict", { attorneyId: new mongoose.Types.ObjectId() }],
  ["verified_capture", { fundingIntegrityStatus: "verified" }],
  ["paused", { pausedAt: new Date() }],
  ["withdrawal", { withdrawnParalegalId: new mongoose.Types.ObjectId() }],
  ["payout_started", { payoutStatus: "processing" }],
  ["completion_claim", { completionClaimToken: "synthetic-claim" }],
  ["dispute", { disputes: [new mongoose.Types.ObjectId()] }],
])("delivery suppresses a %s payment action", async (_name, changes) => {
  await stage(); await Case.collection.updateOne({ _id: matter._id }, { $set: changes });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test.each(["PaymentOperation", "Payout"])("delivery suppresses a later %s ledger record even before its Matter projection", async model => {
  await stage();
  await require(`../models/${model}`).collection.insertOne({ caseId: String(matter._id), kind: "refund", status: "pending" });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test.each([{ disabled: true }, { deleted: true }, { role: "paralegal" }, { status: "pending" }, { "notificationPrefs.emailCase": false }])("delivery rechecks owner state %j", async changes => {
  await stage(); await User.updateOne({ _id: owner._id }, { $set: changes });
  await processNotices(); expect(await read()).toMatchObject({ status: "skipped" }); expect(sendEmail).not.toHaveBeenCalled();
});
test("an address change uses the current email without storing it in the queue", async () => {
  await stage(); await User.updateOne({ _id: owner._id }, { $set: { email: "current@payment-notices.test" } });
  await processNotices(); expect(sendEmail.mock.calls[0][0]).toBe("current@payment-notices.test"); expect(JSON.stringify(await read())).not.toMatch(/payment-notices\.test/);
});
test("lost SMTP acknowledgement is visible for review and never automatically resent", async () => {
  await stage(); sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic closed connection"), { code: "ECONNECTION", command: "CONN" }));
  await processNotices(); expect(await read()).toMatchObject({ status: "unknown", attempts: 1 });
  await processNotices(); expect(sendEmail).toHaveBeenCalledTimes(1);
  const status = await noticeStatus(); expect(status.counts.unknown).toBe(1); expect(status.recent[0].revision).toMatch(/^[a-f0-9]{64}$/); expect(status.recent[0].claim).toBeUndefined();
});
test("missing payment-delivery indexes roll back the in-app notice as well", async () => {
  jest.spyOn(Notice.collection, "indexes").mockResolvedValueOnce([]); await expect(stage()).rejects.toThrow("indexes");
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
});

async function stageCompleted() {
  const para=await User.create({firstName:"Synthetic",lastName:"Paralegal",email:"para@payment-notices.test",password:"Synthetic123!",role:"paralegal",status:"approved"});
  const at=new Date();
  await Case.updateOne({_id:matter._id},{$set:{paralegal:para._id,paralegalId:para._id,totalAmount:10000,lockedTotalAmount:10000,status:"completed",archived:true,readOnly:true,completedAt:at,paralegalAccessRevokedAt:at,paymentReleased:true,payoutTransferId:"tr_completed_notice",payoutStatus:"paid",paidOutAt:at,stripeMode:"test"}});
  const payout=await require("../models/Payout").create({caseId:matter._id,paralegalId:para._id,amountPaid:8200,transferId:"tr_completed_notice",status:"paid",stripeMode:"test"});
  const session=await mongoose.startSession();try{await session.withTransaction(()=>require("../services/matterPaymentNotifications").stageCompletion(matter,session));}finally{await session.endSession();}
  return {para,payout,at};
}
test("historical funding-action rows without a kind remain deliverable",async()=>{
  await stage();await Notice.collection.updateMany({},{$unset:{kind:""}});await processNotices();expect(sendEmail).toHaveBeenCalledTimes(1);expect(await read()).toMatchObject({status:"accepted"});
});
test.each([
 ["not_completed",{status:"in progress"}], ["not_archived",{archived:false}], ["writable",{readOnly:false}],
 ["completion_changed",{completedAt:new Date('2024-01-01')}], ["missing_revocation",{paralegalAccessRevokedAt:null}],
 ["owner_conflict",{attorneyId:new mongoose.Types.ObjectId()}], ["payee_conflict",{paralegalId:new mongoose.Types.ObjectId()}],
 ["payout_reversed",{payoutStatus:"reversed"}], ["reconciliation",{payoutStatus:"needs_reconciliation"}], ["purged",{purgedAt:new Date()}],
])("a delayed completion notice skips %s source changes",async(_name,change)=>{
 await stageCompleted();await Case.collection.updateOne({_id:matter._id},{$set:change});await processNotices();expect(sendEmail).not.toHaveBeenCalled();expect(await Notice.countDocuments({status:"skipped"})).toBe(2);
});
test.each([
 ["missing_status",{$unset:{status:""}}], ["reversed",{$set:{status:"reversed",reversedAt:new Date()}}],
 ["different_transfer",{$set:{transferId:"tr_replaced"}}], ["changed_amount",{$set:{amountPaid:8000}}], ["different_mode",{$set:{stripeMode:"live"}}],
])("completion mail does not promote %s payout evidence into success",async(_name,change)=>{
 const {payout}=await stageCompleted();await require("../models/Payout").collection.updateOne({_id:payout._id},change);await processNotices();expect(sendEmail).not.toHaveBeenCalled();expect(await Notice.countDocuments({status:"skipped"})).toBe(2);
});
test.each([
 {disabled:true},{deleted:true},{suspended:true},{status:"pending"},{role:"attorney"},{"notificationPrefs.email":false},{"notificationPrefs.emailCase":false},
])("completion email rechecks the current paralegal %j",async changes=>{
 const {para}=await stageCompleted();await User.collection.updateOne({_id:para._id},{$set:changes});await processNotices();expect(sendEmail).toHaveBeenCalledTimes(1);expect(sendEmail.mock.calls[0][0]).toBe(owner.email);expect(await Notice.findOne({userId:para._id}).lean()).toMatchObject({status:"skipped"});
});
test("completion delivery resolves the current address without storing email content",async()=>{
 const {para}=await stageCompleted();await User.updateOne({_id:para._id},{$set:{email:"current-para@payment-notices.test"}});await processNotices();expect(sendEmail.mock.calls.map(call=>call[0]).sort()).toEqual([owner.email,"current-para@payment-notices.test"].sort());expect(JSON.stringify(await Notice.find().lean())).not.toMatch(/Private|payment-notices.test/);
});
