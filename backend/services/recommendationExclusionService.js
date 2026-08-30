const mongoose = require("mongoose");
const Application = require("../models/Application");
const Job = require("../models/Job");
const Case = require("../models/Case");

function addId(target, value) {
  const id = String(value?._id || value?.id || value || "").trim();
  if (id) target.add(id);
}

function objectIds(values = []) {
  return [...values]
    .filter((value) => mongoose.isValidObjectId(value))
    .map((value) => new mongoose.Types.ObjectId(value));
}

/**
 * Returns every known Job and Case identity associated with the paralegal's
 * canonical Application history. Application status is intentionally not a
 * filter: applying once permanently excludes the Matter from Recommendations.
 *
 * Browse visibility and direct-application authorization remain separate.
 */
async function getHistoricalRecommendationExclusions(paralegalId) {
  if (!mongoose.isValidObjectId(paralegalId)) {
    return { applicationCount: 0, jobIds: [], caseIds: [], matterIds: [] };
  }

  const applications = await Application.find({ paralegalId })
    .select("jobId")
    .lean();
  const jobIds = new Set();
  applications.forEach((application) => addId(jobIds, application.jobId));

  const historicalJobObjectIds = objectIds(jobIds);
  if (!historicalJobObjectIds.length) {
    return { applicationCount: applications.length, jobIds: [], caseIds: [], matterIds: [] };
  }

  const [historicalJobs, linkedCases] = await Promise.all([
    Job.find({ _id: { $in: historicalJobObjectIds } }).select("_id caseId").lean(),
    Case.find({ jobId: { $in: historicalJobObjectIds } }).select("_id jobId").lean(),
  ]);

  const caseIds = new Set();
  historicalJobs.forEach((job) => {
    addId(jobIds, job._id);
    addId(caseIds, job.caseId);
  });
  linkedCases.forEach((caseDoc) => {
    addId(caseIds, caseDoc._id);
    addId(jobIds, caseDoc.jobId);
  });

  const caseObjectIds = objectIds(caseIds);
  if (caseObjectIds.length) {
    const [currentCases, currentJobs] = await Promise.all([
      Case.find({ _id: { $in: caseObjectIds } }).select("_id jobId").lean(),
      Job.find({ caseId: { $in: caseObjectIds } }).select("_id caseId").lean(),
    ]);
    currentCases.forEach((caseDoc) => {
      addId(caseIds, caseDoc._id);
      addId(jobIds, caseDoc.jobId);
    });
    currentJobs.forEach((job) => {
      addId(caseIds, job.caseId);
      addId(jobIds, job._id);
    });
  }

  const sortedJobIds = [...jobIds].sort();
  const sortedCaseIds = [...caseIds].sort();
  return {
    applicationCount: applications.length,
    jobIds: sortedJobIds,
    caseIds: sortedCaseIds,
    matterIds: [...new Set([...sortedCaseIds, ...sortedJobIds])].sort(),
  };
}

module.exports = {
  getHistoricalRecommendationExclusions,
};
