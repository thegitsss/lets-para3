const { Types } = require('mongoose');
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const { isRetainedDraft, inspectRetainedDraft } = require('./retainedMatterDraft');

const reference = value => {
  const text = typeof value === 'string' ? value : value instanceof Types.ObjectId ? value.toHexString() : '';
  return /^[a-f0-9]{24}$/i.test(text) ? text.toLowerCase() : null;
};
const changed = () => {
  throw Object.assign(new Error('The linked posting records need verification before this Matter can be deleted. Contact support for help reviewing them.'), { status: 409, publicCode: 'MATTER_DELETE_RECORDS_CHANGED' });
};
function references(field, ids) {
  const values = [...new Set(ids)].map(value => new Types.ObjectId(value));
  // Keep ordinary indexed identities and match earlier BSON string references,
  // including mixed-case hexadecimal text, without casting stored records.
  return { $or: [
    { [field]: { $in: values.flatMap(value => [value, String(value)]) } },
    { $expr: { $in: [{ $convert: { input: `$${field}`, to: 'objectId', onError: null, onNull: null } }, values] } },
  ] };
}

function assertPostingDeletionAllowed(doc) {
  if (String(doc.status || '').trim().toLowerCase() !== 'open') {
    throw Object.assign(new Error('Only open, never-engaged postings can be permanently deleted.'), { status: 409, publicCode: 'MATTER_DELETE_RETAINED' });
  }
  // An earlier client may still offer deletion for an open posting with retained
  // engagement evidence. Check the fresh raw record, including private claims.
  if (doc.paralegal || doc.paralegalId || doc.hiredAt || doc.hiringClaimStatus || doc.hiringClaimToken ||
    doc.completionClaimToken || doc.completionClaimStatus || doc.withdrawalClaimToken || doc.withdrawalClaimStatus ||
    String(doc.escrowStatus || '').toLowerCase() === 'funded' || doc.paymentReleased || doc.escrowIntentId ||
    doc.paymentIntentId || doc.payoutTransferId || doc.payoutFinalizedAt || doc.hiringClaimPaymentIntentId ||
    doc.fundingRequestKey || doc.escrowSessionId || doc.disputes?.length || doc.withdrawalHistory?.length ||
    doc.withdrawnParalegalId || doc.readOnly) {
    throw Object.assign(new Error('Matters with engagement, payment or dispute history, or read-only restrictions, must be retained.'), { status: 409, publicCode: 'MATTER_DELETE_RETAINED' });
  }
}

// The caller authorizes the fresh Matter and holds its transaction. Do not
// expose partial cleanup or turn a conflicting link into deletion authority.
async function deletePostingRecords(doc, session, { allowDraft = false } = {}) {
  if (!session?.inTransaction()) throw new Error('Posting deletion requires a transaction');
  if (allowDraft && isRetainedDraft(doc)) await inspectRetainedDraft(doc, session, { deleting: true });
  else assertPostingDeletionAllowed(doc);
  const caseId = reference(doc._id), owners = [doc.attorney, doc.attorneyId].filter(value => value != null && value !== '').map(reference);
  if (!caseId || !owners.length || owners.some(value => !value || value !== owners[0])) changed();
  const explicit = [doc.jobId, doc.job].filter(value => value != null && value !== '').map(reference);
  if (explicit.some(value => !value)) changed();
  const jobs = await Job.collection.find({ $or: [references('caseId', [caseId]), ...(explicit.length ? [references('_id', explicit)] : [])] }, { session }).toArray();
  const jobIds = jobs.map(job => reference(job._id));
  if (jobIds.some(value => !value) || explicit.some(value => !jobIds.includes(value))) changed();
  for (const job of jobs) {
    if (reference(job.attorneyId) !== owners[0]) changed();
    if (job.caseId != null && job.caseId !== '' && reference(job.caseId) !== caseId) changed();
    if ((job.caseId == null || job.caseId === '') && !explicit.includes(reference(job._id))) changed();
  }
  if (jobIds.length) {
    const otherMatter = await Case.collection.findOne({ _id: { $ne: doc._id }, $or: [references('jobId', jobIds), references('job', jobIds)] }, { session, projection: { _id: 1 } });
    if (otherMatter) changed();
  }
  const applications = jobIds.length ? await Application.collection.find(references('jobId', jobIds), { session, projection: { _id: 1, paralegalId: 1 } }).toArray() : [];
  const result = await Case.collection.deleteOne({ _id: doc._id }, { session });
  if (result.deletedCount !== 1) changed();
  if (jobs.length) {
    const deletedJobs = await Job.collection.deleteMany({ _id: { $in: jobs.map(job => job._id) } }, { session });
    if (deletedJobs.deletedCount !== jobs.length) changed();
    const deletedApplications = await Application.collection.deleteMany(references('jobId', jobIds), { session });
    if (deletedApplications.deletedCount !== applications.length) changed();
  }
  return { doc, recipients: [...new Set([
    doc.pendingParalegalId,
    ...(Array.isArray(doc.applicants) ? doc.applicants.map(value => value?.paralegalId) : []),
    ...(Array.isArray(doc.invites) ? doc.invites.map(value => value?.paralegalId) : []),
    ...applications.map(value => value.paralegalId),
  ].map(reference).filter(Boolean))] };
}

module.exports = { assertPostingDeletionAllowed, deletePostingRecords };
