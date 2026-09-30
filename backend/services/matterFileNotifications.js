const Notice = require("../models/MatterFileNotification");
const User = require("../models/User");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Upload = require("../models/MatterFileUpload");
const { decryptCaseFilePayload } = require("../utils/dataEncryption");
const { caseNotificationAccess } = require("./notificationPresentation");
const { active } = require("./attorneyMatterFiles");
const { isRecordVisibleToCurrentAssignment } = require("../utils/matterAssignmentVisibility");
const same = (a, b) => Boolean(a && b && String(a) === String(b));
const approved = user => user && user.status === "approved" && !user.deleted && !user.disabled && !user.suspended;

async function ready() {
  const indexes = await Notice.collection.indexes();
  if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 }))) {
    throw new Error("File notification delivery indexes are unavailable.");
  }
}

async function stage({ uploadId, ...fields }, session) {
  if (!session?.inTransaction()) throw new Error("File email must be staged in the upload transaction.");
  await Notice.create([{ _id: uploadId, ...fields }], { session });
}

async function prepare(notice) {
  const [user, actor, matter, file, upload] = await Promise.all([
    User.findById(notice.userId).select("email role status deleted disabled suspended notificationPrefs").lean(),
    User.findById(notice.actorUserId).select("role status deleted disabled suspended").lean(),
    Case.collection.findOne({ _id: notice.caseId }),
    CaseFile.collection.findOne({ _id: notice.fileId }),
    Upload.collection.findOne({ _id: notice._id }),
  ]);
  const { shouldSendEmailForType, emailTemplate } = require("../utils/notifyUser");
  if (!approved(user) || !approved(actor) || !["attorney", "paralegal"].includes(user.role)
    || actor.role !== (user.role === "attorney" ? "paralegal" : "attorney")
    || !matter || !active(matter)
    || matter.attorney && matter.attorneyId && !same(matter.attorney, matter.attorneyId)
    || matter.paralegal && matter.paralegalId && !same(matter.paralegal, matter.paralegalId)
    || caseNotificationAccess(matter, user, "case_file_uploaded").relationship !== (user.role === "attorney" ? "owner" : "assigned")
    || caseNotificationAccess(matter, actor, "case_file_uploaded").relationship !== (actor.role === "attorney" ? "owner" : "assigned")
    || !file || !same(file.caseId, notice.caseId) || !same(file.userId, notice.actorUserId) || file.uploadedByRole !== actor.role || file.version !== notice.fileVersion
    || !isRecordVisibleToCurrentAssignment(file, matter, { role: user.role, userId: user._id })
    || !isRecordVisibleToCurrentAssignment(file, matter, { role: actor.role, userId: actor._id })
    || !upload || upload.status !== "recorded" || upload.kind !== "upload" || !same(upload.ownerId, notice.actorUserId)
    || !same(upload.caseId, notice.caseId) || !same(upload.fileId, notice.fileId)
    || !shouldSendEmailForType(user, "case_file_uploaded")) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(user.email || "")) throw new Error("Recipient email unavailable.");
  const document = decryptCaseFilePayload(file);
  return { to: user.email, ...emailTemplate("case_file_uploaded", { caseId: String(matter._id), fileId: String(file._id), caseTitle: matter.title || "Untitled Matter", fileName: document.originalName || "A document" }) };
}

const { processNotices, noticeStatus } = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "file" });

module.exports = { ready, stage, processNotices, noticeStatus };
