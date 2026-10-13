const mongoose = require("mongoose");
const Message = require("../models/Message"), Notice = require("../models/MatterMessageNotification");
const Case = require("../models/Case"), User = require("../models/User");
const { evaluateMessagingPermission } = require("./attorneyWorkflowPolicy");
const { isBlockedBetween } = require("../utils/blocks");
const { isWorkspacePresenceActive } = require("../utils/workspacePresence");
const { resolveMessageNotificationPolicy } = require("../utils/messageNotificationPolicy");
const id = value => String(value?._id || value || "");
const approved = user => user && ["attorney", "paralegal"].includes(user.role) && user.status === "approved" && !user.disabled && !user.deleted && !user.suspended;

async function source(messageId, session = null) {
  const message = await Message.findById(messageId).select("caseId senderId senderRole createdAt deleted +notificationIntent").session(session).lean();
  if (!message?.notificationIntent || message.deleted) return null;
  const [matter, recipient, sender] = await Promise.all([
    Case.findById(message.caseId).session(session).lean(),
    User.findById(message.notificationIntent.recipientId).select("email firstName lastName role status disabled deleted suspended notificationPrefs messageLastViewedAt").session(session).lean(),
    User.findById(message.senderId).select("firstName lastName role status disabled deleted suspended").session(session).lean(),
  ]);
  if (!matter || !approved(recipient) || !approved(sender) || sender.role === recipient.role || sender.role !== message.senderRole) return null;
  const attorney = id(matter.attorney || matter.attorneyId), para = id(matter.paralegal || matter.paralegalId);
  if (matter.attorney && matter.attorneyId && id(matter.attorney) !== id(matter.attorneyId)
    || matter.paralegal && matter.paralegalId && id(matter.paralegal) !== id(matter.paralegalId)) return null;
  const matches = user => id(user._id) === (user.role === "attorney" ? attorney : para);
  if (!matches(recipient) || !matches(sender) || await isBlockedBetween(sender._id, recipient._id)) return null;
  if (matter.hiredAt && new Date(message.createdAt) < new Date(matter.hiredAt)) return null;
  if (![recipient, sender].every(user => evaluateMessagingPermission({ caseDoc: matter, viewerId: id(user._id), viewerRole: user.role }).ready)) return null;
  return { message, matter, recipient, sender };
}
async function ready() {
  const indexes = await Notice.collection.indexes();
  if (!indexes.some(index => index.unique && JSON.stringify(index.key) === JSON.stringify({ messageId: 1, userId: 1 }))) throw new Error("Message email deduplication index is unavailable.");
}
async function stage({ messageId, userId }, session) {
  if (!session?.inTransaction()) throw new Error("Message email requires its notification transaction.");
  await ready();
  const value = await source(messageId, session);
  if (!value || id(value.recipient._id) !== id(userId)) throw new Error("Message notification recipient changed.");
  await Notice.create([{ messageId, userId, caseId: value.matter._id, senderId: value.sender._id }], { session });
}
async function recordIntent(messageId) {
  let dispatch = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      dispatch = null;
      const retained = await Message.findById(messageId).select("+notificationIntent").session(session).lean();
      if (retained?.notificationIntent?.status !== "pending") return;
      const value = await source(messageId, session);
      let suppress = !value;
      if (value) {
        suppress = await isWorkspacePresenceActive(value.recipient._id, value.matter._id, "messages");
        const previous = await Message.findOne({ caseId: value.matter._id, senderRole: value.sender.role, deleted: { $ne: true },
          $or: [{ createdAt: { $lt: value.message.createdAt } }, { createdAt: value.message.createdAt, _id: { $lt: value.message._id } }],
        }).sort({ createdAt: -1, _id: -1 }).select("createdAt").session(session).lean();
        if (previous && new Date(value.message.createdAt) - new Date(previous.createdAt) < resolveMessageNotificationPolicy().suppressMs) suppress = true;
      }
      if (!suppress) {
        dispatch = await require("../utils/notifyUser").notifyUser(value.recipient._id, "message", {
          caseId: value.matter._id, caseTitle: value.matter.title || "Untitled Matter", messageId,
          fromName: `${value.sender.firstName || ""} ${value.sender.lastName || ""}`.trim(),
        }, { session, deferDispatch: true, actorUserId: value.sender._id, messageNotice: { messageId } });
      }
      const saved = await Message.updateOne({ _id: messageId, "notificationIntent.status": "pending" }, { $set: { "notificationIntent.status": suppress ? "suppressed" : "recorded" } }, { session });
      if (!saved.matchedCount) throw new Error("The message notification intent changed.");
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally { await session.endSession(); }
  if (dispatch) await dispatch();
}
async function prepare(notice) {
  const value = await source(notice.messageId);
  const { shouldSendEmailForType, emailTemplate } = require("../utils/notifyUser");
  if (!value || value.message.notificationIntent.status !== "recorded" || id(value.recipient._id) !== id(notice.userId) || id(value.sender._id) !== id(notice.senderId)
    || id(value.matter._id) !== id(notice.caseId) || !shouldSendEmailForType(value.recipient, "message", { caseId: value.matter._id })) return null;
  return { to: value.recipient.email, ...emailTemplate("message", { caseId: String(value.matter._id), messageId: String(value.message._id), caseTitle: value.matter.title || "Untitled Matter", fromName: `${value.sender.firstName || ""} ${value.sender.lastName || ""}`.trim() }) };
}
const delivery = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "message" });
async function processNotices(options = {}) {
  const { shouldStop = () => false, onProgress = async () => {}, limit = 20 } = options;
  for await (const message of Message.find({ "notificationIntent.status": "pending" }).select("_id").sort({ createdAt: 1, _id: 1 }).limit(limit).lean().cursor()) {
    if (shouldStop()) return 0;
    await recordIntent(message._id); await onProgress();
  }
  return delivery.processNotices(options);
}
module.exports = { ready, stage, recordIntent, prepare, processNotices, noticeStatus: delivery.noticeStatus };
