// backend/services/userDeletion.js
const Application = require("../models/Application");
const AuditLog = require("../models/AuditLog");
const Block = require("../models/Block");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Event = require("../models/Event");
const Job = require("../models/Job");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const Task = require("../models/Task");
const User = require("../models/User");
const { deleteCaseFolder } = require("./caseLifecycle");

async function purgeAttorneyAccount(userId) {
  const [caseDocs, jobDocs] = await Promise.all([
    Case.find({ $or: [{ attorney: userId }, { attorneyId: userId }] }).select("_id").lean(),
    Job.find({ attorneyId: userId }).select("_id caseId").lean(),
  ]);

  const caseIds = [];
  const caseIdSet = new Set();
  const addCaseId = (id) => {
    if (!id) return;
    const key = String(id);
    if (caseIdSet.has(key)) return;
    caseIdSet.add(key);
    caseIds.push(id);
  };

  caseDocs.forEach((doc) => addCaseId(doc._id));
  jobDocs.forEach((doc) => addCaseId(doc.caseId));

  const jobIds = jobDocs.map((doc) => doc._id).filter(Boolean);

  for (const caseId of caseIds) {
    try {
      // Best-effort cleanup of uploaded artifacts and archives.
      // eslint-disable-next-line no-await-in-loop
      await deleteCaseFolder(String(caseId));
    } catch (err) {
      console.warn("[userDeletion] deleteCaseFolder failed", caseId, err?.message || err);
    }
  }

  const deleteOps = [
    Message.deleteMany({ senderId: userId }),
    Event.deleteMany({ owner: userId }),
    Notification.deleteMany({ $or: [{ userId }, { actorUserId: userId }] }),
    Block.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] }),
    AuditLog.deleteMany({ $or: [{ actor: userId }, { targetId: userId }] }),
    CaseFile.deleteMany({ userId }),
  ];

  if (jobIds.length) {
    deleteOps.push(Application.deleteMany({ jobId: { $in: jobIds } }));
  }

  if (caseIds.length) {
    deleteOps.push(
      Message.deleteMany({ caseId: { $in: caseIds } }),
      CaseFile.deleteMany({ caseId: { $in: caseIds } }),
      Task.deleteMany({ caseId: { $in: caseIds } }),
      Event.deleteMany({ caseId: { $in: caseIds } }),
      Payout.deleteMany({ caseId: { $in: caseIds } }),
      PlatformIncome.deleteMany({ caseId: { $in: caseIds } }),
      AuditLog.deleteMany({ case: { $in: caseIds } }),
      Case.deleteMany({ _id: { $in: caseIds } })
    );
  }

  if (jobIds.length) {
    deleteOps.push(Job.deleteMany({ _id: { $in: jobIds } }));
  }

  await Promise.all(deleteOps);
  await User.deleteOne({ _id: userId });

  return { caseIds, jobIds };
}

module.exports = { purgeAttorneyAccount };
