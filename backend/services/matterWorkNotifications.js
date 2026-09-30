const mongoose = require("mongoose");
const Notice = require("../models/MatterWorkNotification");
const User = require("../models/User"), Case = require("../models/Case");
const { active } = require("./attorneyMatterFiles");
const { caseNotificationAccess } = require("./notificationPresentation");
const same = (a, b) => Boolean(a && b && String(a) === String(b));
const approved = (user, role) => user?.role === role && user.status === "approved" && !user.deleted && !user.disabled && !user.suspended;
function currentAssignment(matter, userId, attorneyId, hiredAt) {
  return matter && active(matter) && matter.fundingIntegrityStatus === "verified"
    && same(matter.attorney || matter.attorneyId, attorneyId)
    && (!matter.attorney || !matter.attorneyId || same(matter.attorney, matter.attorneyId))
    && (!matter.paralegal || !matter.paralegalId || same(matter.paralegal, matter.paralegalId))
    && caseNotificationAccess(matter, { _id: userId, role: "paralegal" }, "case_work_ready").relationship === "assigned"
    && Number.isFinite(new Date(hiredAt).getTime()) && new Date(matter.hiredAt).getTime() === new Date(hiredAt).getTime();
}
async function ready() {
  const indexes = await Notice.collection.indexes();
  if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 }))) throw new Error("Work notification delivery indexes are unavailable.");
}
async function stage({ caseId, userId }, session) {
  if (!session?.inTransaction()) throw new Error("Work email requires the assignment transaction.");
  await ready();
  const matter = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(String(caseId)) }, { session });
  const attorneyId = matter?.attorney || matter?.attorneyId;
  if (!currentAssignment(matter, userId, attorneyId, matter?.hiredAt)) throw new Error("Work notification assignment could not be verified.");
  await Notice.create([{ userId, attorneyId, caseId, hiredAt: matter.hiredAt }], { session });
}
async function prepare(notice) {
  const [matter, user, owner] = await Promise.all([
    Case.collection.findOne({ _id: notice.caseId }),
    User.findById(notice.userId).select("email role status deleted disabled suspended notificationPrefs").lean(),
    User.findById(notice.attorneyId).select("role status deleted disabled suspended").lean(),
  ]);
  const { shouldSendEmailForType, emailTemplate } = require("../utils/notifyUser");
  if (!approved(user, "paralegal") || !approved(owner, "attorney")
    || !currentAssignment(matter, notice.userId, notice.attorneyId, notice.hiredAt)
    || !shouldSendEmailForType(user, "case_work_ready")) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(user.email || "")) throw new Error("Recipient email unavailable.");
  return { to: user.email, ...emailTemplate("case_work_ready", { caseId: String(matter._id), caseTitle: matter.title || "Untitled Matter" }) };
}
const { processNotices, noticeStatus } = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "work" });
module.exports = { ready, stage, processNotices, noticeStatus };
