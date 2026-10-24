const { Types } = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User"), Application = require('../models/Application'), Job = require('../models/Job');
const { findActiveSession } = require("./authSessionService");
const { id, refs, one, validId } = require('./applicationIdentity');
const conflict = () => { throw Object.assign(new Error("The application or Matter changed. Refresh before withdrawing the application."), { status: 409, publicCode: "APPLICATION_CONFLICT" }); };
async function removeMirror(req, application, job, caseDoc) {
  const actorId = id(req.user?.id || req.user?._id);
  const user = await one(User, actorId, { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 });
  if (!user || user.role !== "paralegal" || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) throw Object.assign(new Error("Your account changed. Sign in again before continuing."), { status: 403, publicCode: "APPLICATION_ACCOUNT_CHANGED" });
  const fields = "attorney attorneyId job jobId paralegal paralegalId escrowStatus paymentReleased hiringClaimToken hiringClaimStatus invites __v".split(" ");
  const raw = await Case.collection.findOne({ _id: caseDoc._id }, { projection: Object.fromEntries(fields.map(key => [key, 1])) });
  if (!raw || id(job?.caseId) !== id(raw._id) || !id(job.attorneyId) || id(raw.attorney || raw.attorneyId) !== id(job.attorneyId) || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId) || [raw.job, raw.jobId].some(ref => ref && id(ref) !== id(job._id))) conflict();
  if (raw.hiringClaimToken || raw.hiringClaimStatus) conflict();
  if ((raw.invites || []).some(invite => id(invite.paralegalId) === actorId && ["pending", "needs_reconciliation"].includes(invite.syncStatus))) conflict();
  const funded = raw.paymentReleased === true || String(raw.escrowStatus || "").toLowerCase() === "funded";
  if (funded && (application.status === "accepted" || [raw.paralegal, raw.paralegalId].some(ref => id(ref) === actorId))) throw Object.assign(new Error("Accepted applications cannot be revoked after funding."), { status: 400, publicCode: "APPLICATION_FUNDED" });
  if (raw.__v != null && (!Number.isSafeInteger(raw.__v) || raw.__v < 0)) conflict();
  const filter = { _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : { $eq: raw[key] }])) };
  const result = await Case.collection.updateOne(filter, { $pull: { applicants: { paralegalId: { $in: refs(actorId) } } }, $addToSet: { withdrawnApplicantIds: new Types.ObjectId(actorId) }, $inc: { __v: 1 }, $set: { updatedAt: new Date() } });
  if (!result.matchedCount) conflict();
}
async function read(req, applicationId) {
  await require('./accountApplicationProjections').assertAccount(req, 'paralegal');
  const application = await one(Application, applicationId);
  if (!application || id(application.paralegalId) !== id(req.user.id || req.user._id)) return null;
  if (!validId(application.jobId)) conflict();
  const candidates = await Application.collection.find({ jobId: { $in: refs(application.jobId) }, paralegalId: { $in: refs(application.paralegalId) } }, { projection: { _id: 1 }, maxTimeMS: 15000 }).limit(2).toArray();
  if (candidates.length !== 1) conflict();
  const job = await one(Job, application.jobId);
  const caseDoc = job?.caseId ? await one(Case, job.caseId) : null;
  return { application, job, caseDoc };
}

// Mirror removal has already acquired the existing hiring interlock. Retain
// the canonical outcome and its recipient obligations together; a failure
// deliberately leaves that earlier removal for explicit reconciliation.
async function record(req, source) {
  const actorId = id(req.user.id || req.user._id);
  return require('../utils/activeAccountWrite').withActiveAccountWrite([actorId], async session => {
    const current = await one(Application, source.application._id, undefined, session);
    if (!current || !same(current.paralegalId, actorId)) conflict();
    if (current.status === 'withdrawn') return { alreadyRevoked: true, application: current };
    const { fingerprint } = require('./matterDraftRevision');
    if (fingerprint(current) !== fingerprint(source.application)) conflict();
    const job = await one(Job, current.jobId, undefined, session);
    if (!job || !source.job || !same(job.attorneyId, source.job.attorneyId) || id(job.caseId) !== id(source.job.caseId)) conflict();
    const caseDoc = job.caseId ? await one(Case, job.caseId, undefined, session) : null;
    if (job.caseId && (!caseDoc || !same(caseDoc.attorneyId || caseDoc.attorney, job.attorneyId)
      || caseDoc.attorney && caseDoc.attorneyId && !same(caseDoc.attorney, caseDoc.attorneyId)
      || [caseDoc.job, caseDoc.jobId].some(value => value && !same(value, job._id)))) conflict();
    for (const [Model, doc] of [[Job, job], ...(caseDoc ? [[Case, caseDoc]] : [])]) {
      if (doc.__v != null && (!Number.isSafeInteger(doc.__v) || doc.__v < 0)) conflict();
      if ((await Model.collection.updateOne({ _id: doc._id, __v: doc.__v === undefined ? { $exists: false } : doc.__v }, { $inc: { __v: 1 } }, { session })).matchedCount !== 1) conflict();
    }
    const withdrawnAt = new Date();
    const application = await Application.collection.findOneAndUpdate({ _id: current._id, paralegalId: current.paralegalId, status: current.status }, {
      $set: { status: 'withdrawn', withdrawnAt, syncStatus: 'pending', syncedAt: null, syncError: '' },
      $push: { statusHistory: { $each: [{ from: current.status || 'submitted', to: 'withdrawn', reason: 'revoked_by_paralegal', actorId: req.user._id, at: withdrawnAt }], $slice: -50 } },
    }, { session, returnDocument: 'after' });
    if (!application) conflict();
    let dispatch;
    try {
      dispatch = await require('../utils/notifyUser').notifyUser(job.attorneyId, 'case_update', {
        caseId: caseDoc?._id || null, caseTitle: caseDoc?.title || job.title || 'Matter application',
        summary: 'A paralegal withdrew their application.', outcome: 'application_withdrawn',
        applicantId: actorId, applicationId: application._id,
        link: require('./objectDeepLinks').buildObjectDeepLink({ type: 'retained_application', caseId: caseDoc?._id, applicantId: actorId }) || 'dashboard-attorney.html#applications',
      }, { session, deferDispatch: true, actorUserId: actorId, applicationWithdrawal: { applicationId: application._id } });
      if (typeof dispatch !== 'function') throw new Error('Application withdrawal recipient is unavailable.');
    } catch (error) {
      throw Object.assign(new Error('The application withdrawal could not be saved. Try again.'), { status: 503, publicCode: 'APPLICATION_WITHDRAWAL_UNAVAILABLE', cause: error });
    }
    return { application, caseDoc, dispatch, alreadyRevoked: false };
  }, { ownerId: actorId, authVersion: req.authVersion });
}
const same = (left, right) => Boolean(left && right && id(left) === id(right));
function withdrawalFilter(application) {
  return { _id: application._id, status: 'withdrawn', withdrawnAt: application.withdrawnAt,
    statusHistory: application.statusHistory === undefined ? { $exists: false } : { $eq: application.statusHistory } };
}
async function markSynced(application) {
  await Application.collection.updateOne(withdrawalFilter(application), { $set: { syncStatus: 'synced', syncedAt: new Date(), syncError: '' } });
}
async function markNeedsReconciliation(applicationId, error, application) {
  await Application.collection.updateOne(application ? withdrawalFilter(application) : { _id: applicationId }, { $set: { syncStatus: 'needs_reconciliation', syncedAt: null, syncError: String(error?.message || error || 'Application synchronization failed').slice(0, 1000) } });
}
async function syncCount(jobId) {
  return require('./applicationCandidateCounts').refreshCandidateCount(jobId);
}
module.exports = { removeMirror, read, record, markSynced, markNeedsReconciliation, syncCount };
