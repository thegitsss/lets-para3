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

const ACTIVE_JOB_STATUSES = ["open", "in_review", "assigned"];
const ACTIVE_CASE_STATUSES = ["open", "in progress", "in_progress", "paused", "disputed"];
const ACTIVE_APPLICATION_STATUSES = ["submitted", "viewed", "shortlisted"];

function uniqueBlockers(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeBlocker(code, message, count = 0) {
  return { code, message, count: Number(count) || 0 };
}

async function getAttorneyDeactivationBlockers(userId) {
  const [activeJobs, activeCases, unresolvedDisputes, unresolvedFunds, pendingPayouts] = await Promise.all([
    Job.countDocuments({ attorneyId: userId, status: { $in: ACTIVE_JOB_STATUSES } }),
    Case.countDocuments({
      $or: [{ attorney: userId }, { attorneyId: userId }],
      status: { $in: ACTIVE_CASE_STATUSES },
    }),
    Case.countDocuments({
      $or: [{ attorney: userId }, { attorneyId: userId }],
      $or: [
        { "disputes.status": "open" },
        { status: "disputed" },
        { pausedReason: "dispute" },
        { terminationStatus: "disputed" },
      ],
    }),
    Case.countDocuments({
      $or: [{ attorney: userId }, { attorneyId: userId }],
      $or: [
        { escrowStatus: "funded", paymentReleased: { $ne: true } },
        { pausedReason: "paralegal_withdrew", payoutFinalizedAt: null },
      ],
    }),
    Case.countDocuments({
      $or: [{ attorney: userId }, { attorneyId: userId }],
      paymentReleased: true,
      paidOutAt: null,
    }),
  ]);

  return uniqueBlockers([
    activeJobs
      ? makeBlocker("active_jobs", "Close your open or in-review jobs before deactivating your account.", activeJobs)
      : null,
    activeCases
      ? makeBlocker("active_matters", "Finish or close your active matters before deactivating your account.", activeCases)
      : null,
    unresolvedDisputes
      ? makeBlocker("open_disputes", "Resolve all open disputes before deactivating your account.", unresolvedDisputes)
      : null,
    unresolvedFunds
      ? makeBlocker(
          "unresolved_financials",
          "Deactivation is unavailable while escrowed funds, withdrawal decisions, or other unresolved financial relationships remain.",
          unresolvedFunds
        )
      : null,
    pendingPayouts
      ? makeBlocker("pending_payouts", "Wait for pending payouts to complete before deactivating your account.", pendingPayouts)
      : null,
  ].filter(Boolean));
}

async function getParalegalDeactivationBlockers(userId) {
  const [activeCases, unresolvedDisputes, unresolvedFunds, pendingPayouts, acceptedApplications] =
    await Promise.all([
      Case.countDocuments({
        $or: [{ paralegal: userId }, { paralegalId: userId }],
        status: { $in: ACTIVE_CASE_STATUSES },
      }),
      Case.countDocuments({
        $or: [{ paralegal: userId }, { paralegalId: userId }, { withdrawnParalegalId: userId }],
        $or: [
          { "disputes.status": "open" },
          { status: "disputed" },
          { pausedReason: "dispute" },
          { terminationStatus: "disputed" },
        ],
      }),
      Case.countDocuments({
        $or: [{ paralegal: userId }, { paralegalId: userId }, { withdrawnParalegalId: userId }],
        $or: [
          { escrowStatus: "funded", paymentReleased: { $ne: true } },
          { pausedReason: "paralegal_withdrew", payoutFinalizedAt: null },
        ],
      }),
      Case.countDocuments({
        $or: [{ paralegal: userId }, { paralegalId: userId }, { withdrawnParalegalId: userId }],
        paymentReleased: true,
        paidOutAt: null,
      }),
      Application.countDocuments({ paralegalId: userId, status: "accepted" }),
    ]);

  return uniqueBlockers([
    activeCases
      ? makeBlocker("active_matters", "Finish or close your active matters before deactivating your account.", activeCases)
      : null,
    unresolvedDisputes
      ? makeBlocker("open_disputes", "Resolve all open disputes before deactivating your account.", unresolvedDisputes)
      : null,
    unresolvedFunds
      ? makeBlocker(
          "unresolved_financials",
          "Deactivation is unavailable while escrowed funds, withdrawal decisions, or other unresolved financial relationships remain.",
          unresolvedFunds
        )
      : null,
    pendingPayouts
      ? makeBlocker("pending_payouts", "Wait for pending payouts to complete before deactivating your account.", pendingPayouts)
      : null,
    acceptedApplications
      ? makeBlocker(
          "accepted_applications",
          "Resolve accepted applications or pending hires before deactivating your account.",
          acceptedApplications
        )
      : null,
  ].filter(Boolean));
}

async function getAccountDeactivationEligibility(userOrId) {
  const user =
    userOrId && typeof userOrId === "object" && userOrId._id
      ? userOrId
      : await User.findById(userOrId).select("_id role disabled deleted");
  if (!user) {
    return {
      canDeactivate: false,
      blockers: [makeBlocker("not_found", "User not found.")],
    };
  }
  if (user.deleted || user.disabled) {
    return {
      canDeactivate: false,
      blockers: [makeBlocker("already_deactivated", "This account is already deactivated.")],
    };
  }

  const role = String(user.role || "").toLowerCase();
  const blockers =
    role === "attorney"
      ? await getAttorneyDeactivationBlockers(user._id)
      : await getParalegalDeactivationBlockers(user._id);

  return {
    canDeactivate: blockers.length === 0,
    blockers,
  };
}

async function clearPendingParalegalParticipation(userId, now = new Date()) {
  await Application.updateMany(
    { paralegalId: userId, status: { $in: ACTIVE_APPLICATION_STATUSES } },
    { $set: { status: "rejected" } }
  );

  const cases = await Case.find({
    $or: [
      { "applicants.paralegalId": userId },
      { "invites.paralegalId": userId },
      { pendingParalegalId: userId },
    ],
  }).select("applicants invites pendingParalegalId pendingParalegalInvitedAt");

  for (const caseDoc of cases) {
    if (Array.isArray(caseDoc.applicants)) {
      caseDoc.applicants.forEach((applicant) => {
        if (
          String(applicant?.paralegalId || "") === String(userId) &&
          String(applicant?.status || "").toLowerCase() === "pending"
        ) {
          applicant.status = "rejected";
        }
      });
    }
    if (Array.isArray(caseDoc.invites)) {
      caseDoc.invites.forEach((invite) => {
        if (
          String(invite?.paralegalId || "") === String(userId) &&
          String(invite?.status || "").toLowerCase() === "pending"
        ) {
          invite.status = "expired";
          invite.respondedAt = now;
        }
      });
    }
    if (String(caseDoc.pendingParalegalId || "") === String(userId)) {
      caseDoc.pendingParalegalId = null;
      caseDoc.pendingParalegalInvitedAt = null;
    }
    await caseDoc.save({ validateBeforeSave: false });
  }
}

async function deactivateUserAccount(userOrId, { now = new Date() } = {}) {
  const user =
    userOrId && typeof userOrId === "object" && userOrId._id
      ? userOrId
      : await User.findById(userOrId);
  if (!user) {
    const err = new Error("User not found.");
    err.statusCode = 404;
    throw err;
  }

  const eligibility = await getAccountDeactivationEligibility(user);
  if (!eligibility.canDeactivate) {
    const err = new Error(eligibility.blockers[0]?.message || "This account cannot be deactivated yet.");
    err.statusCode = 409;
    err.blockers = eligibility.blockers;
    throw err;
  }

  if (String(user.role || "").toLowerCase() === "paralegal") {
    await clearPendingParalegalParticipation(user._id, now);
  }

  user.deleted = true;
  user.deletedAt = now;
  user.disabled = true;
  user.status = "denied";
  user.pushSubscription = null;
  user.pendingHire = null;
  user.twoFactorTempCode = null;
  user.twoFactorExpiresAt = null;
  await user.save();

  return { userId: user._id, role: user.role };
}

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

module.exports = {
  deactivateUserAccount,
  getAccountDeactivationEligibility,
  purgeAttorneyAccount,
};
