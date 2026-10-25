const Notice = require('../models/MatterPreEngagementNotification');
const Case = require('../models/Case'), User = require('../models/User'), Job = require('../models/Job'), Application = require('../models/Application');
const { one, id, refs, uniqueRecords } = require('./applicationIdentity');
const { fingerprint } = require('./matterDraftRevision');
const { caseParticipantIdentity } = require('../utils/caseParticipantIdentity');
const { withActiveAccountWrite } = require('../utils/activeAccountWrite');
const { isBlockedBetween } = require('../utils/blocks');
const approved = (user, role) => user?.role === role && user.status === 'approved' && !user.disabled && !user.deleted && !user.suspended;
const kinds = ['requested', 'submitted', 'changes_requested'];

function revisionKey(matter, ownerId, paralegalId, kind, actorUserId) {
  const identity = caseParticipantIdentity(matter || {}, ownerId), current = matter?.preEngagement;
  if (!kinds.includes(kind) || !identity.isAttorney || identity.identityConflict || !current || current.status !== kind
    || id(current.requestedParalegalId) !== id(paralegalId) || !Number.isSafeInteger(current.revision) || current.revision < 1) return null;
  const timestamp = current[kind === 'requested' ? 'requestedAt' : kind === 'submitted' ? 'submittedAt' : 'reviewedAt'];
  const actor = current[kind === 'requested' ? 'requestedBy' : kind === 'submitted' ? 'submittedBy' : 'reviewedBy'];
  if (!timestamp || !Number.isFinite(new Date(timestamp).getTime()) || id(actor) !== id(actorUserId)
    || id(actor) !== id(kind === 'submitted' ? paralegalId : ownerId)) return null;
  return fingerprint([kind, id(matter._id), id(ownerId), id(paralegalId), current]);
}

async function ready() {
  const indexes = await Notice.collection.indexes();
  const has = (key, unique = false) => indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && (!unique || index.unique));
  if (!has({ caseId: 1, revisionKey: 1, kind: 1, userId: 1 }, true) || !has({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 })) throw new Error('Pre-engagement delivery indexes are unavailable.');
}

async function stage({ caseId, ownerId, paralegalId, userId, actorUserId, kind }, session) {
  if (!session?.inTransaction()) throw new Error('Pre-engagement email requires its saved-change transaction.');
  await ready();
  const matter = await one(Case, caseId, undefined, session), key = revisionKey(matter, ownerId, paralegalId, kind, actorUserId);
  if (!key || id(userId) !== id(kind === 'submitted' ? ownerId : paralegalId)) throw new Error('Pre-engagement notice recipient could not be verified.');
  await Notice.create([{ kind, caseId, revisionKey: key, ownerId, paralegalId, userId, actorUserId }], { session });
}

async function save(write, { actorUserId, kind, applicationId }) {
  return withActiveAccountWrite([], async session => {
    const matter = await write(session);
    if (!matter || !kind) return { matter };
    try {
      const ownerId = id(matter.attorney || matter.attorneyId), paralegalId = id(matter.preEngagement?.requestedParalegalId);
      const userId = kind === 'submitted' ? ownerId : paralegalId;
      // Read the raw saved BSON when binding the generation, including earlier
      // optional fields that hydration could otherwise fill with defaults.
      const current = await one(Case, matter._id, undefined, session);
      if (!revisionKey(current, ownerId, paralegalId, kind, actorUserId)) throw new Error('Pre-engagement change could not be verified.');
      const dispatch = await require('../utils/notifyUser').notifyUser(userId, `pre_engagement_${kind}`, {
        caseId: id(matter._id), caseTitle: matter.title || 'Untitled Matter', paralegalId, applicantId: paralegalId,
        applicationId: applicationId || undefined, status: kind,
      }, { actorUserId, session, deferDispatch: true, preEngagement: { kind, ownerId } });
      if (typeof dispatch !== 'function') throw new Error('Pre-engagement recipient is unavailable.');
      return { matter, dispatch };
    } catch (cause) {
      throw Object.assign(new Error('The pre-engagement change could not be saved with its notice. Review the saved requirements before trying again.'), {
        status: 503, statusCode: 503, publicCode: 'PRE_ENGAGEMENT_NOTICE_UNAVAILABLE', cause,
      });
    }
  });
}

async function activeCandidate(matter, paralegalId) {
  const invitations = (matter.invites || []).filter(entry => id(entry.paralegalId) === id(paralegalId));
  if (invitations.length > 1) return null;
  if (invitations[0]?.status === 'accepted' && ['pending', 'needs_reconciliation'].includes(invitations[0].syncStatus)) throw new Error('Invitation reconciliation has not finished.');
  const linked = matter.jobId || matter.job;
  const jobs = await uniqueRecords(Job, { $or: [{ caseId: { $in: refs(matter._id) } }, ...(linked ? [{ _id: { $in: refs(linked) } }] : [])] });
  if (jobs.length > 1 || linked && (!jobs.length || id(jobs[0]._id) !== id(linked))) return false;
  if (jobs.length && (id(jobs[0].caseId) !== id(matter._id) || id(jobs[0].attorneyId) !== id(matter.attorney || matter.attorneyId))) return false;
  const applications = jobs.length ? await uniqueRecords(Application, { jobId: { $in: refs(jobs[0]._id) }, paralegalId: { $in: refs(paralegalId) } }) : [];
  if (applications.length > 1) return false;
  if (applications.length) {
    if (!['submitted', 'viewed', 'shortlisted', 'accepted'].includes(applications[0].status)) return false;
    if (['pending', 'needs_reconciliation'].includes(applications[0].syncStatus)) throw new Error('Application reconciliation has not finished.');
    const active = !(matter.withdrawnApplicantIds || []).some(value => id(value) === id(paralegalId))
      || (matter.applicants || []).some(entry => id(entry.paralegalId) === id(paralegalId) && ['pending', 'submitted', 'viewed', 'shortlisted', 'accepted'].includes(entry.status));
    return active ? { applicationId: id(applications[0]._id), jobId: id(jobs[0]._id) } : null;
  }
  const active = (matter.applicants || []).some(entry => id(entry.paralegalId) === id(paralegalId) && ['pending', 'submitted', 'viewed', 'shortlisted', 'accepted'].includes(entry.status))
    || (matter.invites || []).some(entry => id(entry.paralegalId) === id(paralegalId) && entry.status === 'accepted');
  return active ? { jobId: id(jobs[0]?._id || linked || matter._id) } : null;
}

async function prepare(notice) {
  const [matter, owner, paralegal] = await Promise.all([one(Case, notice.caseId), one(User, notice.ownerId), one(User, notice.paralegalId)]);
  const recipient = notice.kind === 'submitted' ? owner : paralegal;
  if (!matter || revisionKey(matter, notice.ownerId, notice.paralegalId, notice.kind, notice.actorUserId) !== notice.revisionKey
    || id(notice.userId) !== id(recipient?._id) || !approved(owner, 'attorney') || !approved(paralegal, 'paralegal')
    || matter.archived || matter.readOnly || matter.purgedAt || matter.paymentReleased || matter.paralegal || matter.paralegalId || matter.hiringClaimToken || matter.hiringClaimStatus
    || ['completed', 'complete', 'closed', 'disputed', 'cancelled', 'canceled'].includes(matter.status)
    || !require('../utils/notifyUser').shouldSendEmailForType(recipient, `pre_engagement_${notice.kind}`)
    || await isBlockedBetween(notice.ownerId, notice.paralegalId)) return null;
  const candidate = await activeCandidate(matter, notice.paralegalId);
  if (!candidate) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient.email || '')) throw new Error('Recipient email unavailable.');
  return { to: recipient.email, ...require('../email/templates').preEngagementNotice({ ...candidate, kind: notice.kind, caseId: notice.caseId, paralegalId: notice.paralegalId, caseTitle: matter.title || 'Untitled Matter' }) };
}
const { processNotices, noticeStatus } = require('./emailNoticeDelivery').createEmailNoticeDelivery({ Notice, prepare, prefix: 'pre-engagement' });
module.exports = { ready, stage, save, revisionKey, processNotices, noticeStatus };
