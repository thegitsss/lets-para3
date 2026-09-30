const { reportOperationalFailure } = require("../utils/operationalFailure");
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
const SupportMutation = require("../models/SupportMutation");
const SupportTicket = require("../models/SupportTicket");
const Task = require("../models/Task");
const ChecklistTask = require("../models/ChecklistTask");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { AccountWriteError } = require("../utils/accountWriteGuard");
const WeeklyNote = require("../models/WeeklyNote");
const { revokeAllUserSessions } = require("./authSessionService");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const { publishMatterDiscoveryEvent } = require("../utils/matterDiscoveryEvents");
const { publishNotificationEvent } = require("../utils/notificationEvents");
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
const FINANCIAL_CLAIMS = [
  { hiringClaimStatus: { $in: ["claimed", "needs_reconciliation"] } },
  { hiringClaimToken: { $type: "string", $gt: "" } },
  // A released payment keeps its idempotency key as historical evidence.
  // An unpaid release is still blocked independently by pending_payouts.
  { fundingRequestKey: { $type: "string", $gt: "" }, paymentReleased: { $ne: true } },
];
const CLOSURE_USER_FIELDS = "role status disabled deleted +authVersion +password emailVerified twoFactorEnabled twoFactorMethod +twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep +twoFactorChallengeHash +twoFactorFailedAttempts";
const CLOSURE_CASE_FIELDS = "attorney attorneyId paralegal paralegalId withdrawnParalegalId pendingParalegalId hiringClaimParalegalId status archived escrowStatus paymentReleased paidOutAt pausedReason payoutFinalizedAt terminationStatus disputes.status applicants.paralegalId applicants.status invites.paralegalId invites.status hiringClaimToken hiringClaimStatus fundingRequestKey";
const closureError = (status, code, message) => Object.assign(new AccountWriteError(status, code, message), { statusCode: status, publicCode: code });
const closureChanged = () => closureError(409, "ACCOUNT_CLOSURE_CHANGED", "Account participation changed. Review the current closure information before continuing.");
async function readQueries(queries, session) {
  if (!session) return Promise.all(queries);
  const results = [];
  for (const query of queries) results.push(await query.session(session));
  return results;
}
function canonical(value) {
  if (value?.toJSON) return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function closureRevision(value) {
  const key = String(process.env.DATA_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(key)) throw closureError(503, "ACCOUNT_CLOSURE_UNAVAILABLE", "Account closure is temporarily unavailable.");
  return crypto.createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify(canonical(["account-closure-v1", value]))).digest("hex");
}

function buildAttorneyCaseOwnershipFilter(userId) {
  return {
    $or: [{ attorney: userId }, { attorneyId: userId }],
  };
}

function buildParalegalCaseParticipationFilter(userId) {
  return {
    $or: [{ paralegal: userId }, { paralegalId: userId }, { withdrawnParalegalId: userId }, { hiringClaimParalegalId: userId }],
  };
}

function buildClearableAttorneyCaseFilter(userId) {
  return {
    ...buildAttorneyCaseOwnershipFilter(userId),
    status: "open",
    paymentReleased: { $ne: true },
    escrowStatus: { $ne: "funded" },
    $nor: FINANCIAL_CLAIMS,
  };
}

function buildClearableSelectedCaseFilter(userId) {
  return {
    $or: [{ paralegal: userId }, { paralegalId: userId }],
    status: "open",
    paymentReleased: { $ne: true },
    escrowStatus: { $ne: "funded" },
    $nor: FINANCIAL_CLAIMS,
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

async function getAttorneyDeactivationBlockers(userId, session = null) {
  const [activeCases, clearableOpenCases, unresolvedDisputes, unresolvedFunds, pendingPayouts] = await readQueries([
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
            ...FINANCIAL_CLAIMS,
          ],
        },
      ],
    }),
    Case.countDocuments({
      ...buildAttorneyCaseOwnershipFilter(userId),
      paymentReleased: true,
      paidOutAt: null,
    }),
  ], session);
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

async function getParalegalDeactivationBlockers(userId, session = null) {
  const [activeCases, clearableSelectedCases, unresolvedDisputes, unresolvedFunds, pendingPayouts] =
    await readQueries([
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
            ...FINANCIAL_CLAIMS,
            ],
          },
        ],
      }),
      Case.countDocuments({
        ...buildParalegalCaseParticipationFilter(userId),
        paymentReleased: true,
        paidOutAt: null,
      }),
    ], session);
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

async function getAccountDeactivationEligibility(userOrId, { session = null } = {}) {
  const user =
    userOrId && typeof userOrId === "object" && userOrId._id
      ? userOrId
      : await User.findById(userOrId).select("_id role disabled deleted").session(session);
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
      ? await getAttorneyDeactivationBlockers(user._id, session)
      : await getParalegalDeactivationBlockers(user._id, session);

  return {
    canDeactivate: blockers.length === 0,
    blockers,
  };
}

async function clearPendingParalegalParticipation(userId, now = new Date(), { session, effects } = {}) {
  const pendingApplications = await Application.find({
    paralegalId: userId,
    status: { $in: [...ACTIVE_APPLICATION_STATUSES, "accepted"] },
  }).select("_id jobId status").session(session);
  const affectedJobIds = [...new Set(pendingApplications.map((application) => String(application.jobId)))];
  const affectedJobs = affectedJobIds.length
    ? await Job.find({ _id: { $in: affectedJobIds } }).select("attorneyId").session(session).lean()
    : [];
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
      },
      { session }
    );
    // Retained Applications can outlive their posting. Reject their pending
    // participation, but only reconcile counts on Jobs present in this snapshot.
    for (const job of affectedJobs) {
      const jobId = job._id;
      const count = await Application.countDocuments({ jobId, status: { $nin: ["accepted", "rejected", "withdrawn"] } }).session(session);
      const updated = await Job.updateOne({ _id: jobId }, { $set: { applicantsCount: count } }, { session });
      if (!updated.matchedCount) throw new Error("Application references missing job during account closure");
    }
  }

  const cases = await Case.find({
    $or: [
      { "applicants.paralegalId": userId },
      { "invites.paralegalId": userId },
      { pendingParalegalId: userId },
      buildClearableSelectedCaseFilter(userId),
    ],
  }).select(
    "attorney attorneyId applicants invites pendingParalegalId pendingParalegalInvitedAt paralegal paralegalId paralegalNameSnapshot hiredAt tasksLocked status paymentReleased escrowStatus"
  ).session(session);

  for (const caseDoc of cases) {
    const affectedUserIds = [
      userId,
      caseDoc.attorney,
      caseDoc.attorneyId,
      caseDoc.paralegal,
      caseDoc.paralegalId,
      caseDoc.pendingParalegalId,
      ...(caseDoc.applicants || []).map((entry) => entry?.paralegalId),
      ...(caseDoc.invites || []).map((entry) => entry?.paralegalId),
    ].filter(Boolean);
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
    await caseDoc.save({ validateBeforeSave: false, session });
    effects.push(() => publishCaseProjectionRefresh(caseDoc, "account_participation_refresh", {
      additionalUserIds: affectedUserIds,
      discovery: false,
    }));
  }
  affectedJobs.forEach((job) => {
    if (!job?.attorneyId) return;
    effects.push(() => publishNotificationEvent(job.attorneyId, "notifications", {
      at: new Date().toISOString(),
      type: "account_participation_refresh",
    }));
  });
  if (affectedJobIds.length || cases.length) effects.push(() => publishMatterDiscoveryEvent("matter_visibility_refresh"));
}

async function clearPendingAttorneyParticipation(userId, now = new Date(), { session, effects } = {}) {
  const affectedJobs = await Job.find({ attorneyId: userId, status: { $in: ACTIVE_JOB_STATUSES } })
    .select("_id")
    .session(session).lean();
  const affectedJobIds = affectedJobs.map((job) => job._id);
  const affectedApplications = affectedJobIds.length
    ? await Application.find({ jobId: { $in: affectedJobIds } }).select("paralegalId").session(session).lean()
    : [];
  await Job.updateMany({ attorneyId: userId, status: { $in: ACTIVE_JOB_STATUSES } }, { $set: { status: "closed" } }, { session });

  const cases = await Case.find(buildClearableAttorneyCaseFilter(userId)).select(
    "attorney attorneyId applicants invites disputes pendingParalegalId pendingParalegalInvitedAt paralegal paralegalId paralegalNameSnapshot hiredAt tasksLocked status paymentReleased escrowStatus paymentStatus archived"
  ).session(session);

  for (const caseDoc of cases) {
    const affectedUserIds = [
      userId,
      caseDoc.paralegal,
      caseDoc.paralegalId,
      caseDoc.pendingParalegalId,
      ...(caseDoc.applicants || []).map((entry) => entry?.paralegalId),
      ...(caseDoc.invites || []).map((entry) => entry?.paralegalId),
    ].filter(Boolean);
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
    await caseDoc.save({ validateBeforeSave: false, session });
    effects.push(() => publishCaseProjectionRefresh(caseDoc, "account_participation_refresh", {
      additionalUserIds: affectedUserIds,
      discovery: false,
    }));
  }
  affectedApplications.forEach((application) => {
    if (!application?.paralegalId) return;
    effects.push(() => publishNotificationEvent(application.paralegalId, "notifications", {
      at: new Date().toISOString(),
      type: "account_participation_refresh",
    }));
  });
  if (affectedJobIds.length || cases.length) effects.push(() => publishMatterDiscoveryEvent("matter_visibility_refresh"));
}

async function readClosureState(user, session) {
  const userId = user._id, attorney = String(user.role).toLowerCase() === "attorney";
  const cases = await Case.find(attorney ? buildAttorneyCaseOwnershipFilter(userId) : { $or: [
    buildParalegalCaseParticipationFilter(userId), { pendingParalegalId: userId },
    { "applicants.paralegalId": userId }, { "invites.paralegalId": userId },
  ] }).select(CLOSURE_CASE_FIELDS).sort({ _id: 1 }).session(session).lean();
  let jobs, applications;
  if (attorney) {
    jobs = await Job.find({ attorneyId: userId, status: { $in: ACTIVE_JOB_STATUSES } }).select("_id attorneyId status caseId").sort({ _id: 1 }).session(session).lean();
    applications = await Application.find({ jobId: { $in: jobs.map(job => job._id) } }).select("_id jobId paralegalId status").sort({ _id: 1 }).session(session).lean();
  } else {
    applications = await Application.find({ paralegalId: userId, status: { $in: [...ACTIVE_APPLICATION_STATUSES, "accepted"] } }).select("_id jobId paralegalId status").sort({ _id: 1 }).session(session).lean();
    jobs = await Job.find({ _id: { $in: applications.map(application => application.jobId) } }).select("_id attorneyId status caseId").sort({ _id: 1 }).session(session).lean();
  }
  const auth = ["_id", "role", "status", "disabled", "deleted", "authVersion", "password", "emailVerified", "twoFactorEnabled", "twoFactorMethod", "twoFactorBackupCodes", "totpSecretEncrypted"].map(field => [field, user.get(field) ?? null]);
  return { cases, jobs, applications, revision: closureRevision({ auth, cases, jobs, applications }) };
}

async function getAccountDeactivationReview(userOrId) {
  const userId = userOrId?._id || userOrId, session = await User.db.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" } });
    const user = await User.findById(userId).select(CLOSURE_USER_FIELDS).session(session);
    if (!user) throw closureError(404, "ACCOUNT_NOT_FOUND", "User not found.");
    const state = await readClosureState(user, session);
    const eligibility = await getAccountDeactivationEligibility(user, { session });
    await session.commitTransaction();
    return { ...eligibility, revision: state.revision };
  } finally {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.userDeletion.transaction_abort"));
    await session.endSession();
  }
}

async function deactivateUserAccount(userOrId, { now = new Date(), expectedOwnerId, expectedClosureRevision, authSessionId, authVersion, req } = {}) {
  const userId = userOrId?._id || userOrId, guarded = expectedOwnerId !== undefined;
  if (guarded && (typeof expectedOwnerId !== "string" || !/^[a-f0-9]{24}$/i.test(expectedOwnerId) || typeof expectedClosureRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedClosureRevision))) throw closureError(400, "ACCOUNT_GUARD_INVALID", "Refresh this account before continuing.");
  if (guarded && expectedOwnerId.toLowerCase() !== String(userId).toLowerCase()) throw closureError(403, "ACCOUNT_CHANGED", "Your signed-in account changed. Verify the account before continuing.");
  const session = await User.db.startSession(), effects = [];
  let result;
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    if (authSessionId) {
      const active = await AuthSession.collection.updateOne({ userId: new User.db.base.Types.ObjectId(userId), sessionId: String(authSessionId), revokedAt: null, expiresAt: { $gt: now } }, { $inc: { __v: 1 } }, { session });
      if (!active.matchedCount) throw closureError(403, "ACCOUNT_CHANGED", "This session expired. Sign in again before continuing.");
    }
    const user = await User.findById(userId).select(CLOSURE_USER_FIELDS).session(session);
    if (!user) throw closureError(404, "ACCOUNT_NOT_FOUND", "User not found.");
    if (guarded && (user.status !== "approved" || Number(authVersion ?? 0) !== Number(user.authVersion || 0))) throw closureError(403, "ACCOUNT_CHANGED", "Your signed-in account changed. Sign in again before continuing.");
    if (user.disabled || user.deleted) {
      const eligibility = await getAccountDeactivationEligibility(user, { session });
      throw Object.assign(closureChanged(), { blockers: eligibility.blockers });
    }
    // This real write serializes closure with fresh relationship/session writers.
    await User.collection.updateOne({ _id: user._id }, { $inc: { __v: 1 } }, { session });
    const state = await readClosureState(user, session);
    if (guarded && state.revision !== expectedClosureRevision) throw closureChanged();
    // Protect every reviewed relationship against concurrent decisions/funding,
    // including changes whose final write is on a Case rather than the User.
    for (const [Model, rows] of [[Case, state.cases], [Job, state.jobs], [Application, state.applications]]) {
      if (rows.length) await Model.collection.updateMany({ _id: { $in: rows.map(row => row._id) } }, { $inc: { __v: 1 } }, { session });
    }
    const eligibility = await getAccountDeactivationEligibility(user, { session });
    if (!eligibility.canDeactivate) throw Object.assign(closureError(409, "ACCOUNT_CLOSURE_BLOCKED", eligibility.blockers[0]?.message || "This account cannot be deactivated yet."), { blockers: eligibility.blockers });
    if (String(user.role).toLowerCase() === "paralegal") await clearPendingParalegalParticipation(user._id, now, { session, effects });
    else if (String(user.role).toLowerCase() === "attorney") await clearPendingAttorneyParticipation(user._id, now, { session, effects });
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
    await user.save({ session, pathsToSave: ["deleted", "deletedAt", "disabled", "status", "pendingHire", "authVersion", "twoFactorEnabled", "twoFactorTempCode", "twoFactorExpiresAt", "twoFactorChallengeHash", "twoFactorFailedAttempts", "twoFactorBackupCodes", "totpSecretEncrypted", "totpLastUsedTimeStep", "updatedAt"] });
    await revokeAllUserSessions(user._id, "account_deactivated", { session });
    await AuthChallenge.deleteMany({ userId: user._id }).session(session);
    if (req) await AuditLog.create([{ actor: req.user?.id || req.user?._id, actorRole: req.user?.role || "system", action: "account.deactivate", targetType: "user", targetId: String(user._id), ip: req.ip, ua: req.headers?.["user-agent"], method: req.method, path: req.originalUrl, meta: { role: user.role } }], { session });
    result = { userId: user._id, role: user.role, auditRecorded: Boolean(req) };
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.userDeletion.transaction_abort"));
    if (error?.hasErrorLabel?.("UnknownTransactionCommitResult")) throw closureError(503, "ACCOUNT_CLOSURE_UNCONFIRMED", "Account closure could not be confirmed. Check the result before trying again.");
    if (error?.code === 112 || error?.hasErrorLabel?.("TransientTransactionError")) throw closureChanged();
    throw error;
  } finally { await session.endSession(); }
  for (const effect of effects) {
    try { effect(); } catch (error) { runtimeLogger.warn("[userDeletion] committed closure refresh failed", error?.message || error); }
  }
  return result;
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
  const AdminDraft = require("../models/AdminDraft");
  const AdminInboundMail = require("../models/AdminInboundMail");
  const AdminCommunicationAlert = require("../models/AdminCommunicationAlert");
  const conversations = await SupportConversation.find({ userId }).select("_id").lean();
  const conversationIds = conversations.map((entry) => entry._id);
  const account = await User.findById(userId).select('email').lean();
  const ticketFilter = {$or:[{userId},{requesterUserId:userId},...(account?.email?[{requestKind:'email',requesterEmail:account.email}]:[])]};
  const ticketIds = (await SupportTicket.find(ticketFilter).select('_id').lean()).map(t=>t._id);
  await Promise.all([
    AdminDraft.deleteMany({$or:[{owner:userId},{kind:'account',recordId:userId},{kind:'inquiry',recordId:{$in:ticketIds}}]}),
    // Retain provider-ID tombstones so a later mailbox scan cannot restore erased bodies.
    AdminInboundMail.updateMany({$or:[{ticketId:{$in:ticketIds}},...(account?.email?[{sender:account.email}]:[])]},{$set:{content:'',sender:'',subject:'',messageId:'',ignored:true,applied:true}}),
    AdminCommunicationAlert.updateMany({$or:[{kind:'signup',targetId:userId},{targetId:{$in:ticketIds}}],status:{$in:['pending','failed','unknown','disabled']}},{$set:{status:'skipped',failure:''}}),
    SupportTicket.updateMany({_id:{$in:ticketIds},requestKind:'email'},{$set:{subject:'Removed email inquiry',message:'[Removed during account data minimization]'}}),
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
    SupportMutation.deleteMany({ ownerId: userId }),
    SupportTicket.updateMany(
      ticketFilter,
      {
        $set: {
          userId: null,
          requesterUserId: null,
          requesterEmail: "",
          pageContext: {},
          contextSnapshot: {},
          supportFactsSnapshot: {},
          latestUserMessage: "[Removed during account data minimization]",
          emailReplies: [],
          nextAction: "",
          followUpAt: null,
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
  user.paralegalQualification = "";
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
  getAccountDeactivationReview,
};
