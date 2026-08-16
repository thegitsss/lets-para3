const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("services:userDeletion");
const crypto = require("crypto");
const Application = require("../models/Application");
const AuthChallenge = require("../models/AuthChallenge");
const AuthSession = require("../models/AuthSession");
const Block = require("../models/Block");
const Case = require("../models/Case");
const CaseDraft = require("../models/CaseDraft");
const CaseFile = require("../models/CaseFile");
const Event = require("../models/Event");
const Job = require("../models/Job");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const PasskeyCredential = require("../models/PasskeyCredential");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const SupportTicket = require("../models/SupportTicket");
const Task = require("../models/Task");
const ChecklistTask = require("../models/ChecklistTask");
const User = require("../models/User");
const WeeklyNote = require("../models/WeeklyNote");
const { revokeAllUserSessions } = require("./authSessionService");
const { syncApplicantsCount } = require("./applicationService");
const {
  USER_STORAGE_FIELDS,
  activatePersonalStorageDeletion,
  cancelPersonalStorageDeletion,
  collectUserPersonalStorageKeys,
  stagePersonalStorageDeletion,
} = require("./personalStorageDeletion");

const ACTIVE_JOB_STATUSES = ["open", "in_review", "assigned"];
const ACTIVE_CASE_STATUSES = ["open", "in progress", "in_progress", "paused", "disputed"];
const ACTIVE_APPLICATION_STATUSES = ["submitted", "viewed", "shortlisted"];

function buildAttorneyCaseOwnershipFilter(userId) {
  return {
    $or: [{ attorney: userId }, { attorneyId: userId }],
  };
}

function buildParalegalCaseParticipationFilter(userId) {
  return {
    $or: [{ paralegal: userId }, { paralegalId: userId }, { withdrawnParalegalId: userId }],
  };
}

function buildClearableAttorneyCaseFilter(userId) {
  return {
    ...buildAttorneyCaseOwnershipFilter(userId),
    status: "open",
    paymentReleased: { $ne: true },
    escrowStatus: { $ne: "funded" },
  };
}

function buildClearableSelectedCaseFilter(userId) {
  return {
    $or: [{ paralegal: userId }, { paralegalId: userId }],
    status: "open",
    paymentReleased: { $ne: true },
    escrowStatus: { $ne: "funded" },
  };
}

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
  const [activeCases, clearableOpenCases, unresolvedDisputes, unresolvedFunds, pendingPayouts] = await Promise.all([
    Case.countDocuments({
      ...buildAttorneyCaseOwnershipFilter(userId),
      status: { $in: ACTIVE_CASE_STATUSES },
    }),
    Case.countDocuments(buildClearableAttorneyCaseFilter(userId)),
    Case.countDocuments({
      $and: [
        buildAttorneyCaseOwnershipFilter(userId),
        {
          $or: [
            { "disputes.status": "open" },
            { status: "disputed" },
            { pausedReason: "dispute" },
            { terminationStatus: "disputed" },
          ],
        },
      ],
    }),
    Case.countDocuments({
      $and: [
        buildAttorneyCaseOwnershipFilter(userId),
        {
          $or: [
            { escrowStatus: "funded", paymentReleased: { $ne: true } },
            { pausedReason: "paralegal_withdrew", payoutFinalizedAt: null },
          ],
        },
      ],
    }),
    Case.countDocuments({
      ...buildAttorneyCaseOwnershipFilter(userId),
      paymentReleased: true,
      paidOutAt: null,
    }),
  ]);
  const blockingActiveCases = Math.max(0, activeCases - clearableOpenCases);

  return uniqueBlockers([
    blockingActiveCases
      ? makeBlocker(
          "active_matters",
          "Finish or close your active matters before deactivating your account.",
          blockingActiveCases
        )
      : null,
    unresolvedDisputes
      ? makeBlocker("open_disputes", "Resolve all open disputes before deactivating your account.", unresolvedDisputes)
      : null,
    unresolvedFunds
      ? makeBlocker(
          "unresolved_financials",
          "Deactivation is unavailable while funded payments, withdrawal decisions, or other unresolved financial relationships remain.",
          unresolvedFunds
        )
      : null,
    pendingPayouts
      ? makeBlocker("pending_payouts", "Wait for pending payouts to complete before deactivating your account.", pendingPayouts)
      : null,
  ].filter(Boolean));
}

async function getParalegalDeactivationBlockers(userId) {
  const [activeCases, clearableSelectedCases, unresolvedDisputes, unresolvedFunds, pendingPayouts] =
    await Promise.all([
      Case.countDocuments({
        ...buildParalegalCaseParticipationFilter(userId),
        status: { $in: ACTIVE_CASE_STATUSES },
      }),
      Case.countDocuments(buildClearableSelectedCaseFilter(userId)),
      Case.countDocuments({
        $and: [
          buildParalegalCaseParticipationFilter(userId),
          {
            $or: [
              { "disputes.status": "open" },
              { status: "disputed" },
              { pausedReason: "dispute" },
              { terminationStatus: "disputed" },
            ],
          },
        ],
      }),
      Case.countDocuments({
        $and: [
          buildParalegalCaseParticipationFilter(userId),
          {
            $or: [
              { escrowStatus: "funded", paymentReleased: { $ne: true } },
              { pausedReason: "paralegal_withdrew", payoutFinalizedAt: null },
            ],
          },
        ],
      }),
      Case.countDocuments({
        ...buildParalegalCaseParticipationFilter(userId),
        paymentReleased: true,
        paidOutAt: null,
      }),
    ]);
  const blockingActiveCases = Math.max(0, activeCases - clearableSelectedCases);

  return uniqueBlockers([
    blockingActiveCases
      ? makeBlocker(
          "active_matters",
          "Finish or close your active matters before deactivating your account.",
          blockingActiveCases
        )
      : null,
    unresolvedDisputes
      ? makeBlocker("open_disputes", "Resolve all open disputes before deactivating your account.", unresolvedDisputes)
      : null,
    unresolvedFunds
      ? makeBlocker(
          "unresolved_financials",
          "Deactivation is unavailable while funded payments, withdrawal decisions, or other unresolved financial relationships remain.",
          unresolvedFunds
        )
      : null,
    pendingPayouts
      ? makeBlocker("pending_payouts", "Wait for pending payouts to complete before deactivating your account.", pendingPayouts)
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
  const pendingApplications = await Application.find({
    paralegalId: userId,
    status: { $in: [...ACTIVE_APPLICATION_STATUSES, "accepted"] },
  }).select("_id jobId status");
  if (pendingApplications.length) {
    await Application.updateMany(
      { _id: { $in: pendingApplications.map((application) => application._id) } },
      {
        $set: {
          status: "rejected",
          syncStatus: "synced",
          syncedAt: now,
          syncError: "",
        },
        $push: {
          statusHistory: {
            $each: [{
              to: "rejected",
              reason: "account_deactivated",
              actorId: userId,
              at: now,
            }],
            $slice: -50,
          },
        },
      }
    );
    const affectedJobIds = [...new Set(pendingApplications.map((application) => String(application.jobId)))];
    const countResults = await Promise.allSettled(
      affectedJobIds.map((jobId) => syncApplicantsCount(jobId))
    );
    countResults.forEach((result, index) => {
      if (result.status === "rejected") {
        runtimeLogger.error(
          "[userDeletion] application count reconciliation deferred",
          affectedJobIds[index],
          result.reason?.message || result.reason
        );
      }
    });
  }

  const cases = await Case.find({
    $or: [
      { "applicants.paralegalId": userId },
      { "invites.paralegalId": userId },
      { pendingParalegalId: userId },
      buildClearableSelectedCaseFilter(userId),
    ],
  }).select(
    "applicants invites pendingParalegalId pendingParalegalInvitedAt paralegal paralegalId paralegalNameSnapshot hiredAt tasksLocked status paymentReleased escrowStatus"
  );

  for (const caseDoc of cases) {
    if (Array.isArray(caseDoc.applicants)) {
      caseDoc.applicants.forEach((applicant) => {
        if (
          String(applicant?.paralegalId || "") === String(userId) &&
          ["pending", "accepted"].includes(String(applicant?.status || "").toLowerCase())
        ) {
          applicant.status = "rejected";
        }
      });
    }
    if (Array.isArray(caseDoc.invites)) {
      caseDoc.invites.forEach((invite) => {
        if (
          String(invite?.paralegalId || "") === String(userId) &&
          ["pending", "accepted"].includes(String(invite?.status || "").toLowerCase())
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
    const assignedParalegalId = String(caseDoc.paralegalId || caseDoc.paralegal || "");
    const clearAssignedSelection =
      assignedParalegalId === String(userId) &&
      String(caseDoc.status || "").toLowerCase() === "open" &&
      String(caseDoc.escrowStatus || "").toLowerCase() !== "funded" &&
      caseDoc.paymentReleased !== true;
    if (clearAssignedSelection) {
      caseDoc.paralegal = null;
      caseDoc.paralegalId = null;
      caseDoc.paralegalNameSnapshot = "";
      caseDoc.hiredAt = null;
      caseDoc.tasksLocked = false;
      caseDoc.pendingParalegalId = null;
      caseDoc.pendingParalegalInvitedAt = null;
    }
    await caseDoc.save({ validateBeforeSave: false });
  }
}

async function clearPendingAttorneyParticipation(userId, now = new Date()) {
  await Job.updateMany({ attorneyId: userId, status: { $in: ACTIVE_JOB_STATUSES } }, { $set: { status: "closed" } });

  const cases = await Case.find(buildClearableAttorneyCaseFilter(userId)).select(
    "attorney attorneyId applicants invites disputes pendingParalegalId pendingParalegalInvitedAt paralegal paralegalId paralegalNameSnapshot hiredAt tasksLocked status paymentReleased escrowStatus paymentStatus archived"
  );

  for (const caseDoc of cases) {
    if (Array.isArray(caseDoc.applicants)) {
      caseDoc.applicants.forEach((applicant) => {
        if (["pending", "accepted"].includes(String(applicant?.status || "").toLowerCase())) {
          applicant.status = "rejected";
        }
      });
    }
    if (Array.isArray(caseDoc.invites)) {
      caseDoc.invites.forEach((invite) => {
        if (["pending", "accepted"].includes(String(invite?.status || "").toLowerCase())) {
          invite.status = "expired";
          invite.respondedAt = invite.respondedAt || now;
        }
      });
    }
    caseDoc.pendingParalegalId = null;
    caseDoc.pendingParalegalInvitedAt = null;
    caseDoc.paralegal = null;
    caseDoc.paralegalId = null;
    caseDoc.paralegalNameSnapshot = "";
    caseDoc.hiredAt = null;
    caseDoc.tasksLocked = false;
    caseDoc.escrowStatus = null;
    caseDoc.paymentStatus = "cancelled";
    caseDoc.archived = true;
    caseDoc.ensureLifecycleStatus("closed");
    await caseDoc.save({ validateBeforeSave: false });
  }
}

async function deactivateUserAccount(userOrId, { now = new Date() } = {}) {
  const user =
    userOrId && typeof userOrId === "object" && userOrId._id
      ? await User.findById(userOrId._id).select("+authVersion +twoFactorChallengeHash +twoFactorFailedAttempts +twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep")
      : await User.findById(userOrId).select("+authVersion +twoFactorChallengeHash +twoFactorFailedAttempts +twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep");
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
  } else if (String(user.role || "").toLowerCase() === "attorney") {
    await clearPendingAttorneyParticipation(user._id, now);
  }

  user.deleted = true;
  user.deletedAt = now;
  user.disabled = true;
  user.status = "denied";
  user.pendingHire = null;
  user.authVersion = Number(user.authVersion || 0) + 1;
  user.twoFactorEnabled = false;
  user.twoFactorTempCode = null;
  user.twoFactorExpiresAt = null;
  user.twoFactorChallengeHash = null;
  user.twoFactorFailedAttempts = 0;
  user.twoFactorBackupCodes = [];
  user.totpSecretEncrypted = null;
  user.totpLastUsedTimeStep = null;
  await user.save();
  await Promise.all([
    revokeAllUserSessions(user._id, "account_deactivated"),
    AuthChallenge.deleteMany({ userId: user._id }),
  ]);

  return { userId: user._id, role: user.role };
}

function accountRecordFilters(userId) {
  return {
    matters: {
      $or: [
        { attorney: userId },
        { attorneyId: userId },
        { paralegal: userId },
        { paralegalId: userId },
        { pendingParalegalId: userId },
        { withdrawnParalegalId: userId },
        { "applicants.paralegalId": userId },
        { "invites.paralegalId": userId },
        { "disputes.raisedBy": userId },
        { "disputes.comments.by": userId },
        { "flags.by": userId },
        { "files.uploadedBy": userId },
      ],
    },
    jobs: { attorneyId: userId },
    applications: {
      $or: [
        { paralegalId: userId },
        { starredBy: userId },
        { "statusHistory.actorId": userId },
      ],
    },
    messages: {
      $or: [
        { senderId: userId },
        { readBy: userId },
        { "readReceipts.user": userId },
        { pinnedBy: userId },
        { deletedBy: userId },
      ],
    },
    caseFiles: { userId },
    tasks: { paralegalId: userId },
    payouts: { paralegalId: userId },
    platformIncome: { $or: [{ attorneyId: userId }, { paralegalId: userId }] },
    caseEvents: {
      caseId: { $ne: null },
      $or: [{ owner: userId }, { "attendees.user": userId }],
    },
    safetyBlocks: { $or: [{ blockerId: userId }, { blockedId: userId }] },
  };
}

async function getDurableAccountRecordSummary(userId) {
  const filters = accountRecordFilters(userId);
  const entries = await Promise.all([
    ["matters", Case.countDocuments(filters.matters)],
    ["jobs", Job.countDocuments(filters.jobs)],
    ["applications", Application.countDocuments(filters.applications)],
    ["messages", Message.countDocuments(filters.messages)],
    ["caseFiles", CaseFile.countDocuments(filters.caseFiles)],
    ["tasks", Task.countDocuments(filters.tasks)],
    ["payouts", Payout.countDocuments(filters.payouts)],
    ["platformIncome", PlatformIncome.countDocuments(filters.platformIncome)],
    ["caseEvents", Event.countDocuments(filters.caseEvents)],
    ["safetyBlocks", Block.countDocuments(filters.safetyBlocks)],
  ].map(async ([name, query]) => [name, await query]));
  return Object.fromEntries(entries.filter(([, count]) => Number(count) > 0));
}

async function removeEphemeralAccountData(userId) {
  const conversations = await SupportConversation.find({ userId }).select("_id").lean();
  const conversationIds = conversations.map((entry) => entry._id);
  await Promise.all([
    AuthChallenge.deleteMany({ userId }),
    AuthSession.deleteMany({ userId }),
    PasskeyCredential.deleteMany({ userId }),
    Notification.deleteMany({ $or: [{ userId }, { actorUserId: userId }] }),
    CaseDraft.deleteMany({ owner: userId }),
    WeeklyNote.deleteMany({ userId }),
    ChecklistTask.deleteMany({ owner: userId }),
    Event.deleteMany({ owner: userId, caseId: null }),
    conversationIds.length
      ? SupportMessage.deleteMany({ conversationId: { $in: conversationIds } })
      : Promise.resolve(),
    SupportConversation.deleteMany({ userId }),
    SupportTicket.updateMany(
      { $or: [{ userId }, { requesterUserId: userId }] },
      {
        $set: {
          userId: null,
          requesterUserId: null,
          requesterEmail: "",
          pageContext: {},
          contextSnapshot: {},
          supportFactsSnapshot: {},
          latestUserMessage: "[Removed during account data minimization]",
        },
      }
    ),
  ]);
}

function minimizeUserDocument(user, now) {
  const id = String(user._id);
  user.firstName = "Deactivated";
  user.lastName = "User";
  user.email = `deleted-${id}@redacted.invalid`;
  user.pendingEmail = null;
  user.pendingEmailRequestedAt = null;
  user.password = crypto.randomBytes(48).toString("base64url");
  user.emailVerified = false;
  user.phoneNumber = null;
  user.phoneVerified = false;
  user.barNumber = "";
  user.resumeURL = null;
  user.certificateURL = "";
  user.writingSampleURL = "";
  user.bio = "";
  user.about = "";
  user.availability = "Unavailable";
  user.availabilityDetails = { status: "unavailable", nextAvailable: null, updatedAt: now };
  user.avatarURL = "";
  user.profileImage = null;
  user.profileImageKey = "";
  user.profileImageOriginal = "";
  user.profileImageOriginalKey = "";
  user.pendingProfileImage = "";
  user.pendingProfileImageKey = "";
  user.pendingProfileImageOriginal = "";
  user.pendingProfileImageOriginalKey = "";
  user.profilePhotoStatus = "unsubmitted";
  user.lawFirm = "";
  user.firmWebsite = "";
  user.state = "";
  user.timezone = "UTC";
  user.location = "";
  user.practiceAreas = [];
  user.primaryPracticeArea = "";
  user.preferredPracticeAreas = [];
  user.collaborationStyle = "";
  user.bestFor = [];
  user.specialties = [];
  user.jurisdictions = [];
  user.stateExperience = [];
  user.skills = [];
  user.yearsExperience = 0;
  user.languages = [];
  user.writingSamples = [];
  user.experience = [];
  user.education = [];
  user.publications = [];
  user.resetPasswordTokenHash = null;
  user.resetPasswordExpiresAt = null;
  user.resetPasswordRequestedAt = null;
  user.failedLogins = 0;
  user.lockedUntil = null;
  user.notificationsLastViewedAt = null;
  user.messageLastViewedAt = new Map();
  user.twoFactorEnabled = false;
  user.twoFactorTempCode = null;
  user.twoFactorExpiresAt = null;
  user.twoFactorChallengeHash = null;
  user.twoFactorFailedAttempts = 0;
  user.twoFactorBackupCodes = [];
  user.totpSecretEncrypted = null;
  user.totpLastUsedTimeStep = null;
  user.authProviders = [];
  user.blockedUsers = [];
  user.notifications = {};
  user.notificationPrefs = {};
  user.preferences = { theme: "light", fontSize: "md", hideProfile: true, dashboardViews: [] };
  user.onboarding = {};
  user.pendingHire = null;
  user.digestFrequency = "off";
  user.emailPref = { marketing: false, product: false };
  user.linkedInURL = null;
  user.disabled = true;
  user.deleted = true;
  user.deletedAt = user.deletedAt || now;
  user.status = "denied";
  user.authVersion = Number(user.authVersion || 0) + 1;
  user.personalDataStatus = "minimized";
  user.personalDataMinimizedAt = now;
  return user;
}

async function finalizeAccountDataRemoval(userId, { now = new Date() } = {}) {
  const user = await User.findById(userId).select(
    `_id role status disabled deleted deletedAt personalDataStatus ${USER_STORAGE_FIELDS} ` +
      "+password +authVersion +resetPasswordTokenHash +resetPasswordExpiresAt " +
      "+resetPasswordRequestedAt +twoFactorTempCode +twoFactorExpiresAt +twoFactorChallengeHash " +
      "+twoFactorFailedAttempts +twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep +authProviders"
  );
  if (!user) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!user.deleted || !user.disabled) {
    const error = new Error("Deactivate the account before processing personal-data removal.");
    error.statusCode = 409;
    throw error;
  }
  if (["admin", "director"].includes(String(user.role || "").toLowerCase())) {
    const error = new Error("Operational accounts require a separately approved offboarding procedure.");
    error.statusCode = 409;
    throw error;
  }

  const recordSummary = await getDurableAccountRecordSummary(user._id);
  const retainedRecordTypes = Object.keys(recordSummary);
  const storageTaskIds = await stagePersonalStorageDeletion({
    ownerId: user._id,
    keys: collectUserPersonalStorageKeys(user),
    reason: "account_data_removal",
    now,
  });

  try {
    await removeEphemeralAccountData(user._id);
    if (retainedRecordTypes.length) {
      minimizeUserDocument(user, now);
      await user.save();
    } else {
      await User.deleteOne({ _id: user._id });
    }
  } catch (error) {
    await cancelPersonalStorageDeletion(storageTaskIds, { now }).catch(
      logPromiseFailure(runtimeLogger, "[user-deletion] personal storage rollback failed")
    );
    throw error;
  }

  await activatePersonalStorageDeletion(storageTaskIds, { now }).catch((error) => {
    runtimeLogger.error("[userDeletion] account storage cleanup activation deferred", {
      errorCode: String(error?.name || error?.code || "STORAGE_TASK_TRANSITION_FAILED"),
    });
  });

  return {
    mode: retainedRecordTypes.length ? "minimized" : "purged",
    retainedRecordTypes,
    retainedRecordCounts: recordSummary,
    storageTaskCount: storageTaskIds.length,
  };
}

module.exports = {
  deactivateUserAccount,
  finalizeAccountDataRemoval,
  getDurableAccountRecordSummary,
  getAccountDeactivationEligibility,
};
