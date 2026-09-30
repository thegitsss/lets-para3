const { Types } = require('mongoose');
const Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application'), User = require('../models/User');
const { id, validId, refs, one, uniqueRecords } = require('./applicationIdentity');
const { fingerprint } = require('./matterDraftRevision');
const { withActiveAccountWrite } = require('../utils/activeAccountWrite');
const { notifyUser } = require('../utils/notifyUser');
const { publishCaseProjectionRefresh } = require('../utils/caseProjectionEvents');
const { buildObjectDeepLink } = require('./objectDeepLinks');

const fail = (status, publicCode, message) => { throw Object.assign(new Error(message), { status, publicCode }); };
const changed = () => fail(409, 'APPLICATION_CONFLICT', 'This application or Matter changed. Review its current state before withdrawing.');
const key = value => String(value || '').toLowerCase();
const revisionFor = (doc, entry) => fingerprint([id(doc._id), id(doc.attorneyId || doc.attorney), entry]);

// Shared read/write availability. This action concerns an earlier application,
// never an accepted invitation, funded engagement, or hiring reconciliation.
function presentWithdrawal(doc, job, entry) {
  const invites = Array.isArray(doc.invites) ? doc.invites : [];
  const available = !!entry && ['pending', 'accepted'].includes(key(entry.status))
    && key(doc.status) === 'open' && !doc.archived && !doc.readOnly && !doc.relistPending
    && !doc.paralegal && !doc.paralegalId && !doc.hiredAt && !doc.paymentReleased
    && key(doc.escrowStatus) !== 'funded' && !doc.escrowIntentId && !doc.paymentIntentId && !doc.fundingRequestKey
    && !doc.hiringClaimToken && !doc.hiringClaimStatus && !doc.hiringClaimPaymentIntentId
    && (!(doc.job || doc.jobId) || !!job) && (!job || key(job.status) === 'open')
    && (!doc.invites || Array.isArray(doc.invites))
    && !invites.some(invite => id(invite.paralegalId) === id(entry.paralegalId) && (key(invite.status) === 'accepted' || ['pending', 'needs_reconciliation'].includes(invite.syncStatus)));
  return { available, revision: available ? revisionFor(doc, entry) : null };
}

async function withdraw(req) {
  const ownerId = id(req.user?.id || req.user?._id), caseId = id(req.params.caseId);
  if (!validId(caseId)) fail(400, 'APPLICATION_INVALID', 'Invalid Matter.');
  if (req.body?.expectedOwnerId !== ownerId) fail(403, 'APPLICATION_ACCOUNT_CHANGED', 'The signed-in account changed. Sign in again before continuing.');
  const revision = req.body?.expectedRevision;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) fail(400, 'APPLICATION_REVISION_REQUIRED', 'Review this application before withdrawing.');
  await require('./accountApplicationProjections').assertAccount(req, 'paralegal');
  const result = await withActiveAccountWrite([ownerId], async session => {
    const actor = await one(User, ownerId, { role: 1 }, session);
    if (actor?.role !== 'paralegal') fail(403, 'APPLICATION_ACCOUNT_CHANGED', 'This account can no longer withdraw applications.');
    const doc = await one(Case, caseId, undefined, session);
    if (!doc) fail(404, 'APPLICATION_NOT_FOUND', 'Application not found.');
    const attorneyId = id(doc.attorneyId || doc.attorney);
    if (!validId(attorneyId) || doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) changed();
    if (!Array.isArray(doc.applicants)) changed();
    const people = new Set();
    for (const entry of doc.applicants) {
      if (!validId(entry.paralegalId) || people.has(id(entry.paralegalId))) changed();
      people.add(id(entry.paralegalId));
    }
    const entry = doc.applicants.find(item => id(item.paralegalId) === ownerId);
    if (!entry) fail(404, 'APPLICATION_NOT_FOUND', 'Application not found.');
    const linkedId = doc.jobId || doc.job;
    if (linkedId && !validId(linkedId) || doc.job && doc.jobId && id(doc.job) !== id(doc.jobId)) changed();
    const jobs = await uniqueRecords(Job, { $or: [{ caseId: { $in: refs(caseId) } }, ...(linkedId ? [{ _id: { $in: refs(linkedId) } }] : [])] }, undefined, session);
    const job = jobs[0];
    if (jobs.length > 1 || job && (id(job.caseId) !== caseId || id(job.attorneyId) !== attorneyId || linkedId && id(job._id) !== id(linkedId)) || linkedId && !job) changed();
    const canonical = job ? await uniqueRecords(Application, { jobId: { $in: refs(job._id) } }, { paralegalId: 1, status: 1 }, session) : [];
    const represented = new Set();
    for (const application of canonical) {
      if (!validId(application.paralegalId) || represented.has(id(application.paralegalId))) changed();
      represented.add(id(application.paralegalId));
    }
    if (represented.has(ownerId)) changed();
    if (key(entry.status) === 'withdrawn' && entry.withdrawalRevision === revision) return { alreadyRevoked: true };
    if (!presentWithdrawal(doc, job, entry).available || revisionFor(doc, entry) !== revision) changed();
    if (doc.__v != null && (!Number.isSafeInteger(doc.__v) || doc.__v < 0)) changed();
    const at = new Date();
    const nextEntry = { ...entry, status: 'withdrawn', withdrawnAt: at, withdrawalRevision: revision,
      statusHistory: [...(Array.isArray(entry.statusHistory) ? entry.statusHistory : []), { from: entry.status, to: 'withdrawn', reason: 'revoked_by_paralegal', actorId: new Types.ObjectId(ownerId), at }].slice(-50) };
    const applicants = doc.applicants.map(item => item === entry ? nextEntry : item);
    const increments = { __v: 1 }, changes = { applicants, updatedAt: at };
    if (id(doc.preEngagement?.requestedParalegalId) === ownerId) {
      const preRevision = doc.preEngagement.revision;
      if (preRevision != null && (!Number.isSafeInteger(preRevision) || preRevision < 0)) changed();
      changes['preEngagement.revision'] = (preRevision || 0) + 1;
    }
    const updated = await Case.collection.updateOne({ _id: doc._id, applicants: { $eq: doc.applicants }, __v: doc.__v === undefined ? { $exists: false } : doc.__v }, {
      $set: changes, $addToSet: { withdrawnApplicantIds: new Types.ObjectId(ownerId) }, $inc: increments,
    }, { session });
    if (updated.matchedCount !== 1) changed();
    if (job) {
      const count = require('./applicationCandidateCounts').countCandidates(canonical, applicants);
      if ((await Job.collection.updateOne({ _id: job._id }, { $set: { applicantsCount: count, updatedAt: at } }, { session })).matchedCount !== 1) changed();
    }
    const dispatch = await notifyUser(attorneyId, 'case_update', {
      caseId, caseTitle: doc.title || 'Matter application', applicantId: ownerId, outcome: 'application_withdrawn',
      summary: 'A paralegal withdrew their application.', link: buildObjectDeepLink({ type: 'retained_application', caseId, applicantId: ownerId }),
    }, { session, deferDispatch: true, actorUserId: ownerId, applicationWithdrawal: {} });
    if (typeof dispatch !== 'function') fail(503, 'APPLICATION_WITHDRAWAL_UNAVAILABLE', 'The application withdrawal could not be saved. Try again.');
    return { alreadyRevoked: false, caseDoc: { ...doc, applicants }, dispatch };
  }, { ownerId, authVersion: req.auth?.payload?.av || 0 });
  if (!result.alreadyRevoked) {
    publishCaseProjectionRefresh(result.caseDoc, 'application_withdrawn_refresh', { additionalUserIds: [ownerId] });
    // The transaction is confirmed; a transport failure must not turn it into
    // an apparently failed withdrawal that invites another write.
    await result.dispatch?.().catch(error => require('../utils/logger').createLogger('earlierApplicationWithdrawal').warn('Withdrawal notification dispatch failed', error?.message));
  }
  return { success: true, caseId, status: 'withdrawn', alreadyRevoked: result.alreadyRevoked };
}

module.exports = { presentWithdrawal, withdraw };
