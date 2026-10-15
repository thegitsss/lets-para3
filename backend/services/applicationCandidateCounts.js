const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require('mongoose');
const Application = require('../models/Application'), Job = require('../models/Job'), Case = require('../models/Case');
const { id, validId, refs, one, uniqueRecords } = require('./applicationIdentity');
const invalid = () => { throw Object.assign(new Error('Application records need verification before their count can be updated.'), { status: 409, publicCode: 'APPLICATION_SOURCE_INVALID' }); };
const pending = value => ['pending', 'submitted', 'viewed', 'shortlisted'].includes(String(value || '').toLowerCase());

function countCandidates(canonical, earlier = []) {
  if (!Array.isArray(earlier)) invalid();
  const represented = new Set(), embedded = new Set();
  for (const item of canonical) {
    if (!validId(item.paralegalId) || represented.has(id(item.paralegalId))) invalid();
    represented.add(id(item.paralegalId));
  }
  for (const item of earlier) {
    if (!validId(item.paralegalId) || embedded.has(id(item.paralegalId))) invalid();
    embedded.add(id(item.paralegalId));
  }
  return canonical.filter(item => pending(item.status)).length + earlier.filter(item => !represented.has(id(item.paralegalId)) && pending(item.status)).length;
}

async function refreshInSession(jobId, session) {
  const job = await one(Job, jobId, undefined, session);
  if (!job || !validId(job.attorneyId)) invalid();
  const matter = job.caseId ? await one(Case, job.caseId, undefined, session) : null;
  if (matter) {
    if (id(matter.attorneyId || matter.attorney) !== id(job.attorneyId)
      || matter.attorney && matter.attorneyId && id(matter.attorney) !== id(matter.attorneyId)
      || [matter.job, matter.jobId].some(value => value && id(value) !== id(job._id))) invalid();
    const postings = await uniqueRecords(Job, { caseId: { $in: refs(matter._id) } }, { _id: 1 }, session);
    if (postings.length !== 1 || id(postings[0]._id) !== id(job._id)) invalid();
    if (matter.__v != null && (!Number.isSafeInteger(matter.__v) || matter.__v < 0)) invalid();
  }
  const canonical = await uniqueRecords(Application, { jobId: { $in: refs(jobId) } }, { paralegalId: 1, status: 1 }, session);
  const count = countCandidates(canonical, matter?.applicants || []);
  // Both older and canonical applicant writers touch this Case. A real write
  // prevents their changes from racing a separately committed recount.
  if (matter && (await Case.collection.updateOne({ _id: matter._id }, { $inc: { __v: 1 } }, { session })).matchedCount !== 1) invalid();
  if ((await Job.collection.updateOne({ _id: job._id }, { $set: { applicantsCount: count } }, { session })).matchedCount !== 1) invalid();
  return count;
}

async function refreshCandidateCount(jobId, { session = null } = {}) {
  if (session) return refreshInSession(jobId, session);
  const ownedSession = await mongoose.startSession();
  try {
    ownedSession.startTransaction();
    const count = await refreshInSession(jobId, ownedSession);
    await ownedSession.commitTransaction();
    return count;
  } catch (error) {
    if (ownedSession.inTransaction()) await ownedSession.abortTransaction().catch(reportOperationalFailure("services.applicationCandidateCounts.transaction_abort"));
    throw error;
  } finally { await ownedSession.endSession(); }
}

module.exports = { countCandidates, refreshCandidateCount };
