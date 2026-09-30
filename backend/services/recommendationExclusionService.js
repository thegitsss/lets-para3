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

const references = values => objectIds(values).flatMap(value => [value, String(value)]);

/**
 * Returns every known Job and Case identity associated with the paralegal's
 * application history. Canonical Application records are authoritative, while
 * retained Case.applicants entries are treated as historical evidence when an
 * older or partially synchronized workflow has no canonical Application.
 * Application status is intentionally not a filter: applying once permanently
 * excludes the Matter from Recommendations.
 *
 * Browse visibility and direct-application authorization remain separate.
 */
async function getHistoricalRecommendationExclusions(paralegalId) {
  if (!mongoose.isValidObjectId(paralegalId)) {
    return {
      applicationCount: 0,
      legacyApplicantEvidenceCount: 0,
      jobIds: [],
      caseIds: [],
      matterIds: [],
    };
  }

  const viewerReferences = references([paralegalId]);
  const [applications, applicantCases] = await Promise.all([
    Application.collection.find({ paralegalId: { $in: viewerReferences } }, { projection: { jobId: 1 } }).toArray(),
    Case.collection.find({ applicants: { $elemMatch: { paralegalId: { $in: viewerReferences } } } },
      { projection: { _id: 1, jobId: 1, job: 1, "applicants.paralegalId": 1 } }).toArray(),
  ]);
  const jobIds = new Set();
  const caseIds = new Set();
  applications.forEach((application) => addId(jobIds, application.jobId));
  applicantCases.forEach((caseDoc) => {
    addId(caseIds, caseDoc._id);
    addId(jobIds, caseDoc.jobId);
    addId(jobIds, caseDoc.job);
  });

  const historicalJobObjectIds = objectIds(jobIds), historicalJobReferences = references(jobIds);
  const [historicalJobs, linkedCases] = historicalJobObjectIds.length
    ? await Promise.all([
        Job.find({ _id: { $in: historicalJobObjectIds } }).select("_id caseId").lean(),
        Case.collection.find({ $or: [{ jobId: { $in: historicalJobReferences } }, { job: { $in: historicalJobReferences } }] },
          { projection: { _id: 1, jobId: 1, job: 1 } }).toArray(),
      ])
    : [[], []];

  historicalJobs.forEach((job) => {
    addId(jobIds, job._id);
    addId(caseIds, job.caseId);
  });
  linkedCases.forEach((caseDoc) => {
    addId(caseIds, caseDoc._id);
    addId(jobIds, caseDoc.jobId);
    addId(jobIds, caseDoc.job);
  });

  const caseObjectIds = objectIds(caseIds);
  if (caseObjectIds.length) {
    const [currentCases, currentJobs] = await Promise.all([
      Case.collection.find({ _id: { $in: caseObjectIds } }, { projection: { _id: 1, jobId: 1, job: 1 } }).toArray(),
      Job.collection.find({ caseId: { $in: references(caseIds) } }, { projection: { _id: 1, caseId: 1 } }).toArray(),
    ]);
    currentCases.forEach((caseDoc) => {
      addId(caseIds, caseDoc._id);
      addId(jobIds, caseDoc.jobId);
      addId(jobIds, caseDoc.job);
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
    legacyApplicantEvidenceCount: applicantCases.length,
    jobIds: sortedJobIds,
    caseIds: sortedCaseIds,
    matterIds: [...new Set([...sortedCaseIds, ...sortedJobIds])].sort(),
  };
}

module.exports = {
  getHistoricalRecommendationExclusions,
};
