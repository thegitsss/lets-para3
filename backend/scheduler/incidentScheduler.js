const crypto = require("crypto");
const os = require("os");
const mongoose = require("mongoose");

const Incident = require("../models/Incident");
const { createLogger } = require("../utils/logger");
const { processLockedIncidentJob, buildNextJobFields } = require("../services/incidents/workflowService");

const logger = createLogger("scheduler:incidents");

const CLAIMABLE_JOB_TYPES = Object.freeze([
  "intake_validation",
  "classification",
  "investigation",
  "patch_planning",
  "patch_execution",
  "verification",
  "deployment",
]);
const DEFAULT_LOCK_MS = Number(process.env.INCIDENT_SCHEDULER_LOCK_MS || 60000);
const MAX_JOBS_PER_RUN = Number(process.env.INCIDENT_SCHEDULER_MAX_JOBS || 10);

function defaultWorkerId() {
  return `incident-scheduler:${os.hostname()}:${process.pid}`;
}

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

async function claimNextIncidentJob({
  jobTypes = CLAIMABLE_JOB_TYPES,
  workerId = defaultWorkerId(),
  lockMs = DEFAULT_LOCK_MS,
} = {}) {
  if (!isDbReady()) return null;

  const now = new Date();
  const lockToken = crypto.randomBytes(12).toString("hex");
  const lockExpiresAt = new Date(now.getTime() + Math.max(1000, Number(lockMs) || DEFAULT_LOCK_MS));

  const claimed = await Incident.findOneAndUpdate(
    {
      "orchestration.nextJobType": { $in: jobTypes },
      "orchestration.nextJobRunAt": { $lte: now },
      $or: [
        { "orchestration.lockExpiresAt": null },
        { "orchestration.lockExpiresAt": { $exists: false } },
        { "orchestration.lockExpiresAt": { $lte: now } },
      ],
    },
    {
      $set: {
        "orchestration.lockToken": lockToken,
        "orchestration.lockOwner": workerId,
        "orchestration.lockExpiresAt": lockExpiresAt,
        "orchestration.lastWorkerAt": now,
      },
    },
    {
      returnDocument: "after",
      sort: {
        "orchestration.nextJobRunAt": 1,
        createdAt: 1,
      },
    }
  ).lean();

  if (!claimed) return null;

  return {
    incidentId: String(claimed._id),
    publicId: claimed.publicId || "",
    jobType: claimed.orchestration?.nextJobType || "",
    lockToken,
    workerId,
  };
}

async function renewIncidentJobLock({
  incidentId,
  lockToken,
  workerId = defaultWorkerId(),
  lockMs = DEFAULT_LOCK_MS,
} = {}) {
  if (!isDbReady()) {
    return { ok: false, reason: "db_not_ready" };
  }

  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + Math.max(1000, Number(lockMs) || DEFAULT_LOCK_MS));
  const renewed = await Incident.findOneAndUpdate(
    {
      _id: incidentId,
      "orchestration.lockToken": lockToken,
      "orchestration.lockOwner": workerId,
    },
    {
      $set: {
        "orchestration.lockExpiresAt": lockExpiresAt,
        "orchestration.lastWorkerAt": now,
      },
    },
    { returnDocument: "after" }
  ).lean();

  if (!renewed) {
    return { ok: false, reason: "lock_lost" };
  }

  return {
    ok: true,
    incidentId: String(renewed._id),
    publicId: renewed.publicId || "",
    jobType: renewed.orchestration?.nextJobType || "",
    lockExpiresAt,
  };
}

async function releaseLockAfterFailure(claim, error) {
  const incident = await Incident.findOne({
    _id: claim.incidentId,
    "orchestration.lockToken": claim.lockToken,
  });

  if (!incident) return null;

  incident.orchestration.lockToken = "";
  incident.orchestration.lockOwner = "";
  incident.orchestration.lockExpiresAt = null;
  incident.orchestration.lastWorkerAt = new Date();
  Object.assign(incident.orchestration, buildNextJobFields(claim.jobType, 2 * 60 * 1000));
  await incident.save();

  logger.error("Incident scheduler job failed.", {
    publicId: incident.publicId,
    jobType: claim.jobType,
    error: error?.message || error,
  });

  return incident;
}

async function processClaimedIncidentJob(claim) {
  try {
    const result = await processLockedIncidentJob({
      incidentId: claim.incidentId,
      lockToken: claim.lockToken,
    });

    if (!result) {
      return {
        ok: false,
        skipped: true,
        publicId: claim.publicId,
        jobType: claim.jobType,
      };
    }

    return {
      ok: true,
      publicId: result.incident?.publicId || claim.publicId,
      jobType: claim.jobType,
      state: result.incident?.state || "",
      nextJobType: result.incident?.orchestration?.nextJobType || "none",
    };
  } catch (error) {
    await releaseLockAfterFailure(claim, error);
    return {
      ok: false,
      publicId: claim.publicId,
      jobType: claim.jobType,
      error: error?.message || "Incident scheduler job failed.",
    };
  }
}

async function runIncidentSchedulerOnce({
  maxJobs = MAX_JOBS_PER_RUN,
  workerId = defaultWorkerId(),
  jobTypes = CLAIMABLE_JOB_TYPES,
} = {}) {
  if (!isDbReady()) {
    return { ok: false, reason: "db_not_ready", processed: 0, results: [] };
  }

  const results = [];
  const limit = Math.max(1, Number(maxJobs) || MAX_JOBS_PER_RUN);

  for (let count = 0; count < limit; count += 1) {
    const claim = await claimNextIncidentJob({ workerId, jobTypes });
    if (!claim) break;
    // eslint-disable-next-line no-await-in-loop
    const result = await processClaimedIncidentJob(claim);
    results.push(result);
  }

  return {
    ok: true,
    processed: results.length,
    results,
  };
}

module.exports = {
  CLAIMABLE_JOB_TYPES,
  claimNextIncidentJob,
  renewIncidentJobLock,
  processClaimedIncidentJob,
  runIncidentSchedulerOnce,
};
