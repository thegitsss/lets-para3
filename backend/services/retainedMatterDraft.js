const { Types } = require('mongoose');
const Case = require('../models/Case');
const CaseDraft = require('../models/CaseDraft');
const Job = require('../models/Job');
const Application = require('../models/Application');
const PaymentOperation = require('../models/PaymentOperation');
const Payout = require('../models/Payout');
const Message = require('../models/Message');
const Event = require('../models/Event');

const ref = value => /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
const variants = value => [new Types.ObjectId(value), value, value.toUpperCase()];
const fail = () => { throw Object.assign(new Error('This retained draft needs a record review before it can be changed. Contact support from Help.'), { status: 409, publicCode: 'DRAFT_RETAINED_REVIEW_REQUIRED' }); };
const isRetainedDraft = doc => String(doc?.status || '').trim().toLowerCase() === 'draft';

function retainedDraftAllowed(doc) {
  const owners = [doc.attorney, doc.attorneyId].filter(Boolean).map(ref);
  if (!isRetainedDraft(doc) || !owners.length || owners.some(owner => !owner || owner !== owners[0])) return false;
  if (doc.currency && String(doc.currency).toLowerCase() !== 'usd') return false;
  const evidence = ['archived', 'readOnly', 'purgedAt', 'purgeScheduledFor', 'hiredAt', 'paralegal', 'paralegalId',
    'pendingParalegalId', 'withdrawnParalegalId', 'hiringClaimStatus', 'hiringClaimToken', 'hiringClaimParalegalId', 'hiringClaimedAt',
    'completionClaimStatus', 'completionClaimToken', 'completionClaimedAt', 'withdrawalClaimStatus', 'withdrawalClaimToken',
    'paymentReleased', 'escrowIntentId', 'paymentIntentId', 'escrowSessionId', 'hiringClaimPaymentIntentId', 'fundingRequestKey',
    'fundingRequestFingerprint', 'fundingVerifiedAt', 'paidOutAt', 'payoutTransferId', 'payoutFinalizedAt', 'payoutFinalizedType',
    'relistRequestedAt', 'relistPending', 'terminatedAt', 'terminationRequestedAt', 'preEngagement', 'amountLockedAt'];
  if (evidence.some(key => Boolean(doc[key]))) return false;
  if (['feeAttorneyAmount', 'feeParalegalAmount', 'hiringClaimAmount', 'partialPayoutAmount'].some(key => Number(doc[key] || 0) !== 0)) return false;
  if (doc.statusHistory?.some(entry => [entry.from, entry.to].some(status => status && String(status).trim().toLowerCase() !== 'draft'))) return false;
  if (doc.lockedTotalAmount != null || doc.remainingAmount != null || doc.disputeSettlement?.action) return false;
  if (['applicants', 'invites', 'disputes', 'withdrawalHistory', 'withdrawnApplicantIds', 'relatedPaymentIntentIds'].some(key => doc[key]?.length)) return false;
  if (doc.escrowStatus || ![undefined, null, '', 'pending'].includes(doc.paymentStatus) || ![undefined, null, '', 'pending'].includes(doc.fundingIntegrityStatus) || ![undefined, null, '', 'not_started'].includes(doc.payoutStatus)) return false;
  return true;
}

// A draft label alone cannot authorize a financial/history reset. Recheck raw
// records and their links inside the same transaction that edits or publishes.
async function inspectRetainedDraft(doc, session, { deleting = false } = {}) {
  if (isRetainedDraft(doc) && doc.archived) throw Object.assign(new Error("Restore this draft from Archived before continuing."), { status: 409, publicCode: "DRAFT_ARCHIVED" });
  if (!retainedDraftAllowed(doc)) fail();
  const caseId = ref(doc._id), owner = ref(doc.attorney || doc.attorneyId), refs = variants(caseId);
  if (await CaseDraft.collection.findOne({ _id: doc._id }, { session, projection: { _id: 1 } })) fail();
  for (const model of [PaymentOperation, Payout, Message]) {
    if (await model.collection.findOne({ caseId: { $in: refs } }, { session, projection: { _id: 1 } })) fail();
  }
  if (deleting && !await retainedDraftCanDelete(doc, session)) fail();
  const explicit = [doc.jobId, doc.job].filter(Boolean).map(ref);
  if (explicit.some(value => !value) || new Set(explicit).size > 1) fail();
  const jobs = await Job.collection.find({ $or: [{ caseId: { $in: refs } }, ...(explicit.length ? [{ _id: { $in: variants(explicit[0]) } }] : [])] }, { session }).toArray();
  if (jobs.length > 1 || (explicit.length && !jobs.length)) fail();
  const job = jobs[0];
  if (job) {
    if (ref(job.attorneyId) !== owner || (job.caseId && ref(job.caseId) !== caseId) || String(job.status || '').toLowerCase() !== 'draft') fail();
    const jobRefs = variants(ref(job._id));
    if (await Case.collection.findOne({ _id: { $ne: doc._id }, $or: [{ jobId: { $in: jobRefs } }, { job: { $in: jobRefs } }] }, { session, projection: { _id: 1 } })) fail();
    if (await Application.collection.findOne({ jobId: { $in: jobRefs } }, { session, projection: { _id: 1 } })) fail();
  }
  return job || null;
}

async function retainedDraftCanDelete(doc, session) {
  return !doc.files?.length && !await Event.collection.findOne({ caseId: { $in: variants(ref(doc._id)) } }, { session, projection: { _id: 1 } });
}

module.exports = { isRetainedDraft, retainedDraftAllowed, inspectRetainedDraft, retainedDraftCanDelete };
