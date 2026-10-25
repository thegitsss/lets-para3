const mongoose = require("mongoose");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
const email = require("../utils/email");
const Message = require("../models/Message"), Notice = require("../models/MatterMessageNotification");
const User = require("../models/User"), Case = require("../models/Case"), Notification = require("../models/Notification");
const service = require("../services/matterMessageNotifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { resetWorkspacePresence } = require("../utils/workspacePresence");
let owner, para, matter, message;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); await resetWorkspacePresence(); email.mockClear();
  [owner, para] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@message-notice.test`, password: "Synthetic123!", role, status: "approved" })));
  matter = await Case.create({ title: "Message recovery", details: "Synthetic", attorney: owner._id, paralegal: para._id, status: "in progress", totalAmount: 40000, escrowIntentId: "pi_synthetic_message", escrowStatus: "funded" });
  message = await Message.create({ caseId: matter._id, senderId: owner._id, senderRole: "attorney", type: "text", text: "CONFIDENTIAL_BODY", notificationIntent: { recipientId: para._id, status: "pending" } });
});
const retained = () => Message.collection.findOne({ _id: message._id });
test.each(["in_app", "email"])("a saved message survives %s staging failure and recovery creates one notification", async failure => {
  const model = failure === "in_app" ? Notification : Notice;
  const spy = jest.spyOn(model, "create").mockRejectedValueOnce(new Error("Synthetic staging interruption"));
  await expect(service.recordIntent(message._id)).rejects.toThrow(); spy.mockRestore();
  expect((await retained()).text).toMatch(/^enc:v1:/);
  expect((await retained()).notificationIntent.status).toBe("pending");
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0);
  await service.processNotices(); await service.processNotices();
  expect(await Notification.countDocuments()).toBe(1); expect(await Notice.countDocuments()).toBe(1);
  expect((await retained()).notificationIntent.status).toBe("recorded");
  expect(email).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await Notification.findOne().lean())).not.toContain("CONFIDENTIAL_BODY");
  expect(email.mock.calls[0][2]).not.toContain("CONFIDENTIAL_BODY");
});
test("lost notification commit acknowledgement does not duplicate in-app or email delivery", async () => {
  const start = mongoose.startSession.bind(mongoose); let interrupted = false;
  const spy = jest.spyOn(mongoose, "startSession").mockImplementation(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); if (!interrupted) { interrupted = true; throw new Error("Synthetic acknowledgement lost"); } }; return session; });
  await expect(service.recordIntent(message._id)).rejects.toThrow(); spy.mockRestore();
  expect((await retained()).notificationIntent.status).toBe("recorded");
  await service.processNotices(); await service.processNotices();
  expect(await Notification.countDocuments()).toBe(1); expect(email).toHaveBeenCalledTimes(1);
});
test.each(["reassigned", "revoked", "suspended", "closed"])("recovery cannot notify an unauthorized recipient after %s", async change => {
  if (change === "reassigned") await Case.updateOne({ _id: matter._id }, { $set: { paralegal: new mongoose.Types.ObjectId() } });
  if (change === "revoked") await Case.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });
  if (change === "suspended") await User.updateOne({ _id: para._id }, { $set: { status: "suspended" } });
  if (change === "closed") await Case.updateOne({ _id: matter._id }, { $set: { status: "closed" } });
  await service.processNotices();
  expect((await retained()).notificationIntent.status).toBe("suppressed");
  expect(await Notification.countDocuments()).toBe(0); expect(await Notice.countDocuments()).toBe(0); expect(email).not.toHaveBeenCalled();
});
test("email preference is rechecked after a notice is staged", async () => {
  await service.recordIntent(message._id);
  await User.updateOne({ _id: para._id }, { $set: { "notificationPrefs.emailMessages": false } });
  await service.processNotices();
  expect((await Notice.findOne().lean()).status).toBe("skipped"); expect(email).not.toHaveBeenCalled();
});


test('bulk Message insertion encrypts content and attachment metadata instead of bypassing save hooks', async () => {
 const value = 'enc:v1:marker-looking confidential text';
 const [bulk] = await Message.insertMany([{ caseId: matter._id, senderId: owner._id, senderRole: 'attorney', text: value, content: { files: [{ name: 'Private.pdf', key: `cases/${matter._id}/documents/private.pdf` }] } }]);
 const stored = await Message.collection.findOne({_id:bulk._id});
 expect(stored.text).not.toBe(value); expect(stored.content.files[0].name).toMatch(/^enc:v1:/);
 expect(require('../utils/dataEncryption').decryptMessagePayload(stored)).toMatchObject({text:value,content:{files:[{name:'Private.pdf'}]}});
});

test('a recipient who opens the thread before the worker sends does not receive a stale message email',async()=>{
 await service.recordIntent(message._id); await User.updateOne({_id:para._id},{$set:{[`messageLastViewedAt.${matter._id}`]:new Date()}});
 await service.processNotices(); expect((await Notice.findOne().lean()).status).toBe('skipped'); expect(email).not.toHaveBeenCalled();
});
