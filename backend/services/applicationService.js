const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("services:applicationService");
const mongoose = require("mongoose");
const Application = require("../models/Application");
const Case = require("../models/Case");
const Job = require("../models/Job");

const ACTIVE_APPLICATION_FILTER = { status: { $nin: ["accepted", "rejected", "withdrawn"] } };

function applicationSyncError(err) {
  return String(err?.message || err || "Application mirror synchronization failed").slice(0, 1000);
}

async function markApplicationSynced(applicationId) {
  if (!applicationId) return;
  await Application.updateOne(
    { _id: applicationId },
    { $set: { syncStatus: "synced", syncedAt: new Date(), syncError: "" } }
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

async function syncApplicantsCount(jobId) {
  if (!mongoose.isValidObjectId(jobId)) return 0;
  const count = await Application.countDocuments({ jobId, ...ACTIVE_APPLICATION_FILTER });
  const result = await Job.updateOne({ _id: jobId }, { $set: { applicantsCount: count } });
  if (!result.matchedCount) throw new Error(`Application references missing job ${String(jobId)}`);
  return count;
}

async function syncEmbeddedApplication({
  caseId,
  paralegalId,
  coverLetter,
  resumeURL = "",
  linkedInURL = "",
  profileSnapshot = {},
  status = "submitted",
  appliedAt = new Date(),
}) {
  if (!caseId || !paralegalId) return null;
  if (status === "withdrawn") {
    return Case.updateOne(
      { _id: caseId },
      { $pull: { applicants: { paralegalId } } }
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
        "applicants.$.status": embeddedStatus,
        "applicants.$.appliedAt": appliedAt,
      },
    }
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
          status: embeddedStatus,
          appliedAt,
        },
      },
    }
  );
  if (inserted.matchedCount) return inserted;
  const alreadySynchronized = await Case.exists({
    _id: caseId,
    applicants: { $elemMatch: { paralegalId } },
  });
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

async function syncApplicationMirror({ application, caseId }) {
  if (!application?._id) return null;
  try {
    if (caseId) {
      const mirrorResult = await syncEmbeddedApplication({
        caseId,
        paralegalId: application.paralegalId,
        coverLetter: application.coverLetter,
        resumeURL: application.resumeURL || "",
        linkedInURL: application.linkedInURL || "",
        profileSnapshot: application.profileSnapshot || {},
        status: application.status,
        appliedAt: application.createdAt,
      });
      if (!mirrorResult?.matchedCount) {
        throw new Error(`Application references missing case ${String(caseId)}`);
      }
    }
    await syncApplicantsCount(application.jobId);
    await markApplicationSynced(application._id);
    return { synced: true };
  } catch (err) {
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
