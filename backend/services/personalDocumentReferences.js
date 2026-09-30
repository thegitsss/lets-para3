const { Types } = require('mongoose');
const Application = require('../models/Application');
const Case = require('../models/Case');
const Job = require('../models/Job');
const { extractPersonalFileKey } = require('../utils/personalFileReference');
const id = value => String(value?._id || value || '');
const refs = value => [new Types.ObjectId(id(value)), id(value)];
function resumeKey(value, ownerId, env = process.env) {
  return extractPersonalFileKey(value, { ownerId, type: 'resume', bucket: env.S3_BUCKET, region: env.S3_REGION, cdnBase: env.S3_CDN_BASE_URL });
}
async function* recordedResumes(ownerId, key, env = process.env) {
  if (!/^[a-f0-9]{24}$/i.test(id(ownerId)) || resumeKey(key, ownerId, env) !== key) return;
  const applications = Application.collection.find({ paralegalId: { $in: refs(ownerId) }, resumeURL: { $nin: ['', null] } }, { projection: { resumeURL: 1, jobId: 1 } });
  try { for await (const record of applications) if (resumeKey(record.resumeURL, ownerId, env) === key) yield { jobId: record.jobId }; }
  finally { await applications.close(); }
  const cases = Case.collection.find({ applicants: { $elemMatch: { paralegalId: { $in: refs(ownerId) }, resumeURL: { $nin: ['', null] } } } }, { projection: { applicants: 1 } });
  try { for await (const record of cases) if (Array.isArray(record.applicants) && record.applicants.some(entry => id(entry.paralegalId) === id(ownerId) && resumeKey(entry.resumeURL, ownerId, env) === key)) yield { caseId: record._id }; }
  finally { await cases.close(); }
}
async function hasRetainedResumeReference(ownerId, key, env = process.env) {
  const records = recordedResumes(ownerId, key, env);
  // Only presence matters; close the generator's database cursor after one result.
  try { return !(await records.next()).done; }
  finally { await records.return(); }
}
async function attorneyCanAccessRecordedResume(req, ownerId, key) {
  const seen = new Set();
  for await (const record of recordedResumes(ownerId, key)) {
    let caseId = record.caseId;
    if (!caseId && /^[a-f0-9]{24}$/i.test(id(record.jobId))) {
      const job = await Job.collection.findOne({ _id: { $in: refs(record.jobId) } }, { projection: { caseId: 1 } });
      caseId = job?.caseId;
    }
    if (!/^[a-f0-9]{24}$/i.test(id(caseId)) || seen.has(id(caseId))) continue;
    seen.add(id(caseId));
    try {
      const selected = await require('./matterApplications').selectedSnapshot({ ...req, params: { caseId: id(caseId), applicantId: id(ownerId) }, query: { expectedOwnerId: id(req.user.id || req.user._id) } });
      if (resumeKey(selected.resumeReference, ownerId) === key) return true;
    } catch (error) {
      // Authorization/source conflicts are not alternate grants. Database failures
      // propagate so callers never treat an incomplete reference read as absence.
      if (!(error.publicCode && error.status >= 400 && error.status < 500)) throw error;
    }
  }
  return false;
}
module.exports = { hasRetainedResumeReference, attorneyCanAccessRecordedResume };
