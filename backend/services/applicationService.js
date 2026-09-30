const { reportOperationalFailure } = require("../utils/operationalFailure");
const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("services:applicationService");
const mongoose = require("mongoose");
const Application = require("../models/Application");
const Case = require("../models/Case");

const ACTIVE_APPLICATION_FILTER = { status: { $nin: ["accepted", "rejected", "withdrawn"] } };

function applicationSyncError(err) {
  return String(err?.message || err || "Application mirror synchronization failed").slice(0, 1000);
}

async function markApplicationSynced(applicationId, { session = null } = {}) {
  if (!applicationId) return;
  await Application.updateOne(
    { _id: applicationId },
    { $set: { syncStatus: "synced", syncedAt: new Date(), syncError: "" } },
    ...(session ? [{ session }] : [])
  );
}

async function markApplicationNeedsReconciliation(applicationId, err) {
  if (!applicationId) return;
  await Application.updateOne(
    { _id: applicationId },
    {
      $set: {
        syncStatus: "needs_reconciliation",
        syncedAt: null,
        syncError: applicationSyncError(err),
      },
    }
  );
}

async function syncApplicantsCount(jobId, { session = null } = {}) {
  if (!mongoose.isValidObjectId(jobId)) return 0;
  return require('./applicationCandidateCounts').refreshCandidateCount(jobId, { session });
}

async function syncEmbeddedApplication({
  caseId,
  paralegalId,
  coverLetter,
  resumeURL = "",
  linkedInURL = "",
  profileSnapshot = {},
  requirementConfirmations = [],
  status = "submitted",
  appliedAt = new Date(),
  session = null,
}) {
  if (!caseId || !paralegalId) return null;
  const options = session ? { session } : {};
  if (status === "withdrawn") {
    return Case.updateOne(
      { _id: caseId },
      { $pull: { applicants: { paralegalId } } },
      options
    );
  }
  const embeddedStatus = status === "submitted" ? "pending" : status;
  const existing = await Case.updateOne(
    { _id: caseId, "applicants.paralegalId": paralegalId },
    {
      $set: {
        "applicants.$.note": coverLetter,
        "applicants.$.resumeURL": resumeURL,
        "applicants.$.linkedInURL": linkedInURL,
        "applicants.$.profileSnapshot": profileSnapshot,
        "applicants.$.requirementConfirmations": requirementConfirmations,
        "applicants.$.status": embeddedStatus,
        "applicants.$.appliedAt": appliedAt,
      },
    },
    options
  );
  if (existing.matchedCount) return existing;
  const inserted = await Case.updateOne(
    { _id: caseId, applicants: { $not: { $elemMatch: { paralegalId } } } },
    {
      $push: {
        applicants: {
          paralegalId,
          note: coverLetter,
          resumeURL,
          linkedInURL,
          profileSnapshot,
          requirementConfirmations,
          status: embeddedStatus,
          appliedAt,
        },
      },
    },
    options
  );
  if (inserted.matchedCount) return inserted;
  const alreadySynchronized = await Case.exists({
    _id: caseId,
    applicants: { $elemMatch: { paralegalId } },
  }).session(session);
  return alreadySynchronized
    ? { acknowledged: true, matchedCount: 1, modifiedCount: 0 }
    : inserted;
}

async function setApplicationStatus({ jobId, caseId, paralegalId, status }) {
  const now = new Date();
  const applicationResult = jobId
    ? await Application.updateOne(
        { jobId, paralegalId, status: { $nin: [status, "withdrawn"] } },
        {
          $set: {
            status,
            withdrawnAt: status === "withdrawn" ? now : null,
            syncStatus: "pending",
            syncedAt: null,
            syncError: "",
          },
          $push: {
            statusHistory: {
              $each: [{ to: status, reason: "status_updated", at: now }],
              $slice: -50,
            },
          },
        }
      )
    : { matchedCount: 0 };
  let caseResult = { matchedCount: 0 };
  try {
    if (caseId) {
      caseResult = await Case.updateOne(
        { _id: caseId, "applicants.paralegalId": paralegalId },
        { $set: { "applicants.$.status": status === "submitted" ? "pending" : status } }
      );
    }
    if (jobId) {
      await syncApplicantsCount(jobId);
      const application = await Application.findOne({ jobId, paralegalId }).select("_id").lean();
      await markApplicationSynced(application?._id);
    }
  } catch (err) {
    if (jobId) {
      const application = await Application.findOne({ jobId, paralegalId }).select("_id").lean();
      await markApplicationNeedsReconciliation(application?._id, err);
    } else {
      throw err;
    }
  }
  return {
    applicationMatched: Number(applicationResult.matchedCount || 0),
    caseMatched: Number(caseResult.matchedCount || 0),
  };
}

async function syncApplicationMirror({ application, caseId, session: parentSession = null }) {
  if (!application?._id) return null;
  const session = parentSession || await mongoose.startSession();
  try {
    if (!parentSession) session.startTransaction();
    // Deferred synchronization may hold an old submitted object after closure
    // rejected the canonical record. Read and lock the current source instead.
    const current = await Application.findById(application._id).session(session);
    if (!current) throw new Error("Application no longer exists during synchronization");
    await Application.collection.updateOne({ _id: current._id }, { $inc: { __v: 1 } }, { session });
    if (caseId) {
      const matter = await Case.findById(caseId).select("status archived").session(session).lean();
      if (!matter) throw new Error(`Application references missing case ${String(caseId)}`);
      await Case.collection.updateOne({ _id: matter._id }, { $inc: { __v: 1 } }, { session });
      // Attorney closure retains canonical application history but rejects its
      // embedded pending participation. Do not reopen that closed projection.
      const closed = matter.archived || String(matter.status).toLowerCase() === "closed";
      if (!(closed && ["submitted", "viewed", "shortlisted", "accepted"].includes(current.status))) {
        const mirrorResult = await syncEmbeddedApplication({
          caseId, paralegalId: current.paralegalId, coverLetter: current.coverLetter,
          resumeURL: current.resumeURL || "", linkedInURL: current.linkedInURL || "",
          profileSnapshot: current.profileSnapshot || {}, requirementConfirmations:current.requirementConfirmations || [], status: current.status,
          appliedAt: current.createdAt, session,
        });
        if (!mirrorResult?.matchedCount) throw new Error(`Application references missing case ${String(caseId)}`);
      }
    }
    await syncApplicantsCount(current.jobId, { session });
    await markApplicationSynced(current._id, { session });
    if (!parentSession) await session.commitTransaction();
    return { synced: true };
  } catch (err) {
    if (parentSession) throw err;
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.applicationService.transaction_abort"));
    try {
      await markApplicationNeedsReconciliation(application._id, err);
    } catch (markErr) {
      runtimeLogger.error(
        "[applications] unable to mark mirror reconciliation",
        application._id,
        markErr?.message || markErr
      );
    }
    runtimeLogger.error("[applications] mirror synchronization deferred", application._id, err?.message || err);
    return { synced: false, error: applicationSyncError(err) };
  }
  finally { if (!parentSession) await session.endSession(); }
}

async function setApplicationStar({ jobId, caseId, paralegalId, userId, starred }) {
  const applicationUpdate = starred
    ? { $addToSet: { starredBy: userId } }
    : { $pull: { starredBy: userId } };
  const caseUpdate = starred
    ? { $addToSet: { "applicants.$.starredBy": userId } }
    : { $pull: { "applicants.$.starredBy": userId } };
  const applicationResult = jobId
    ? await Application.updateOne(
        { jobId, paralegalId, status: { $in: ["submitted", "viewed", "shortlisted"] } },
        applicationUpdate
      )
    : { matchedCount: 0 };
  let caseResult = { matchedCount: 0 };
  try {
    caseResult = caseId
      ? await Case.updateOne({ _id: caseId, "applicants.paralegalId": paralegalId }, caseUpdate)
      : { matchedCount: 0 };
    if (jobId) {
      const application = await Application.findOne({ jobId, paralegalId }).select("_id").lean();
      await markApplicationSynced(application?._id);
    }
  } catch (err) {
    if (jobId) {
      const application = await Application.findOne({ jobId, paralegalId }).select("_id").lean();
      await markApplicationNeedsReconciliation(application?._id, err);
    } else {
      throw err;
    }
  }
  return {
    applicationMatched: Number(applicationResult.matchedCount || 0),
    caseMatched: Number(caseResult.matchedCount || 0),
  };
}

module.exports = {
  ACTIVE_APPLICATION_FILTER,
  markApplicationNeedsReconciliation,
  markApplicationSynced,
  setApplicationStar,
  setApplicationStatus,
  syncApplicationMirror,
  syncApplicantsCount,
  syncEmbeddedApplication,
};
