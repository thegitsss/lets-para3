const { randomUUID } = require('crypto');
const Notice = require('../models/MatterPostingNotification');
const Case = require('../models/Case'), User = require('../models/User'), Job = require('../models/Job'), Application = require('../models/Application');
const { one, id, refs, uniqueRecords } = require('./applicationIdentity');
const { fingerprint } = require('./matterDraftRevision');
const { postingFingerprint } = require('./matterModeration');
const { caseParticipantIdentity } = require('../utils/caseParticipantIdentity');
const { isBlockedBetween } = require('../utils/blocks');
const approved = user => user?.status === 'approved' && !user.disabled && !user.deleted && !user.suspended;
const kinds = ['created', 'updated', 'deleted', 'edits_requested', 'review_requested'];
function stateKey(matter, kind, ownerId) {
  const identity = caseParticipantIdentity(matter || {}, ownerId);
  if (!kinds.includes(kind) || !identity.isAttorney || identity.identityConflict) return null;
  const context = kind === 'created' ? matter.createdAt || null
    : kind === 'updated' ? postingFingerprint(matter)
    : kind === 'edits_requested' ? [matter.moderationStatus, matter.moderationFlaggedAt, matter.moderationFlaggedBy, matter.moderationEditRequest]
    : kind === 'review_requested' ? [matter.moderationStatus, matter.moderationResolutionRequestedAt, matter.moderationResolutionRequestedBy, matter.moderationReviewReceipt]
    : [matter.title, matter.createdAt, matter.updatedAt];
  if (kind === 'edits_requested' && matter.moderationStatus !== 'flagged' || kind === 'review_requested' && matter.moderationStatus !== 'resolution_requested') return null;
  return fingerprint([kind, id(matter._id), id(ownerId), context]);
}
async function ready() {
  const indexes = await Notice.collection.indexes();
  const has = (key, unique = false) => indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && (!unique || index.unique));
  if (!has({ caseId: 1, eventKey: 1, kind: 1, userId: 1 }, true) || !has({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 })) throw new Error('Posting delivery indexes are unavailable.');
}
async function stage(record, session) {
  if (!session?.inTransaction()) throw new Error('Posting email requires the posting transaction.');
  await ready();
  const current = await one(Case, record.caseId, undefined, session);
  if (record.kind === 'deleted' ? !!current : !current || stateKey(current, record.kind, record.ownerId) !== record.stateKey) throw new Error('Posting notice generation could not be verified.');
  await Notice.create([record], { session });
}
async function retain(req, kind, input, session, options = {}) {
  if (!session?.inTransaction()) throw new Error('Posting notices require the saved-change transaction.');
  try {
    const matter = kind === 'deleted' ? input : await one(Case, input._id, undefined, session);
    const ownerId = id(matter?.attorney || matter?.attorneyId), actorUserId = id(req.user.id || req.user._id), key = stateKey(matter, kind, ownerId);
    if (!key) throw new Error('Posting notice ownership could not be verified.');
    const eventKey = fingerprint([key, actorUserId, randomUUID()]);
    const record = { kind, caseId: matter._id, ownerId, actorUserId, stateKey: key, eventKey,
      ...(kind === 'deleted' ? { removedTitle: matter.title || 'Untitled Matter', removalReason: options.reason || 'Policy review', removalMessage: options.message || '' } : {}) };
    let recipients = [];
    if (kind === 'created' && req.user.role === 'attorney') recipients = (await User.find({ role: 'admin', status: 'approved', email: { $exists: true, $ne: '' } }).select('_id').session(session).lean()).map(user => id(user._id));
    if (kind === 'updated') recipients = options.recipients || [];
    if (kind === 'edits_requested' || kind === 'deleted' && options.notifyOwner) recipients = [ownerId];
    if (kind === 'review_requested') recipients = (await User.find({ role: 'admin', status: 'approved' }).select('_id').session(session).lean()).map(user => id(user._id));
    const dispatches = [];
    for (const userId of [...new Set(recipients.map(id).filter(Boolean))]) {
      if (kind === 'created') { await stage({ ...record, userId }, session); continue; }
      const type = kind === 'deleted' ? 'case_deleted' : 'case_update';
      const payload = kind === 'deleted'
        ? { caseTitle: record.removedTitle, reason: record.removalReason, customNote: record.removalMessage, message: `Your Matter posting "${record.removedTitle}" was removed by an administrator.` }
        : { caseId: id(matter._id), caseTitle: matter.title || 'Untitled Matter', outcome: `posting_${kind}`, jobId: id(matter.jobId || matter.job || matter._id),
          summary: kind === 'updated' ? 'A Matter you applied to was updated.' : kind === 'edits_requested' ? `Admin requested edits: ${matter.moderationEditRequest}` : 'The attorney requested admin review of the revised posting.' };
      const dispatch = await require('../utils/notifyUser').notifyUser(userId, type, payload, { session, deferDispatch: true, actorUserId, postingNotice: record });
      if (typeof dispatch !== 'function') throw new Error('Posting notice recipient is unavailable.');
      dispatches.push(dispatch);
    }
    const action = { created: 'create', updated: 'update', deleted: 'delete', edits_requested: 'flag.request_edits', review_requested: 'flag.mark_resolved' }[kind];
    await require('../models/AuditLog').logFromReq(req, `case.${action}`, {
      targetType: 'case', targetId: matter._id, ...(kind.includes('requested') ? { caseId: matter._id } : {}),
      ...(kind === 'edits_requested' ? { meta: { message: matter.moderationEditRequest } } : kind === 'deleted' && req.acl?.isAdmin ? { meta: { reason: options.reason || '', message: options.message || '' } } : options.auditMeta ? { meta: options.auditMeta } : {}), session,
    });
    return async () => { for (const dispatch of dispatches) await dispatch(); };
  } catch (cause) {
    throw Object.assign(new Error('The posting change could not be saved with its notices. Review the saved posting before trying again.'), { status: 503, statusCode: 503, publicCode: 'POSTING_NOTICE_UNAVAILABLE', cause });
  }
}
async function candidateLink(matter, userId) {
  const linked = matter.jobId || matter.job;
  const jobs = await uniqueRecords(Job, { $or: [{ caseId: { $in: refs(matter._id) } }, ...(linked ? [{ _id: { $in: refs(linked) } }] : [])] });
  if (jobs.length > 1 || linked && (!jobs.length || id(jobs[0]._id) !== id(linked))) return null;
  if (jobs.length && (id(jobs[0].caseId) !== id(matter._id) || id(jobs[0].attorneyId) !== id(matter.attorney || matter.attorneyId))) return null;
  const applications = jobs.length ? await uniqueRecords(Application, { jobId: { $in: refs(jobs[0]._id) }, paralegalId: { $in: refs(userId) } }) : [];
  if (applications.length > 1) return null;
  if (applications.length) {
    if (!['submitted', 'viewed', 'shortlisted', 'accepted'].includes(applications[0].status)) return null;
    if (['pending', 'needs_reconciliation'].includes(applications[0].syncStatus)) throw new Error('Application reconciliation has not finished.');
  }
  if (!(matter.applicants || []).some(entry => id(entry.paralegalId) === id(userId) && String(entry.status || 'pending').toLowerCase() === 'pending')) return null;
  return require('./objectDeepLinks').buildObjectDeepLink({ type: 'paralegal_application', applicationId: applications[0]?._id, jobId: jobs[0]?._id || linked || matter._id });
}
async function prepare(notice) {
  const [matter, owner, recipient, actor] = await Promise.all([one(Case, notice.caseId), one(User, notice.ownerId), one(User, notice.userId), one(User, notice.actorUserId)]);
  if (!approved(owner) || !['attorney', 'admin'].includes(owner.role) || !approved(recipient) || !approved(actor)) return null;
  if (['created', 'updated'].includes(notice.kind) && (owner.role !== 'attorney' || id(actor._id) !== id(owner._id))) return null;
  if (notice.kind === 'review_requested' && !(actor.role === 'admin' || id(actor._id) === id(owner._id))) return null;
  const adminRecipient = ['created', 'review_requested'].includes(notice.kind);
  if (adminRecipient ? recipient.role !== 'admin' : notice.kind === 'updated' ? recipient.role !== 'paralegal' : id(recipient._id) !== id(owner._id)) return null;
  if (notice.kind !== 'created' && !require('../utils/notifyUser').shouldSendEmailForType(recipient, notice.kind === 'deleted' ? 'case_deleted' : 'case_update')) return null;
  const templates = require('../email/templates'); let email, destination;
  if (notice.kind === 'deleted') {
    if (matter || actor.role !== 'admin') return null;
    email = templates.caseDeleted({ recipientName: recipient.firstName || '', caseTitle: notice.removedTitle, reason: notice.removalReason, message: notice.removalMessage });
  } else {
    if (!matter || stateKey(matter, notice.kind, notice.ownerId) !== notice.stateKey || matter.archived || matter.purgedAt || matter.readOnly) return null;
    if (notice.kind === 'created' || notice.kind === 'updated') {
      if (matter.status !== 'open' || matter.paralegal || matter.paralegalId || matter.hiredAt || matter.hiringClaimToken || matter.hiringClaimStatus || matter.paymentReleased) return null;
    }
    if (notice.kind === 'updated') {
      if (await isBlockedBetween(notice.ownerId, notice.userId)) return null;
      destination = await candidateLink(matter, notice.userId); if (!destination) return null;
    } else if (notice.kind === 'edits_requested') {
      if (actor.role !== 'admin') return null;
      destination = '/dashboard-attorney.html?previewCaseId=' + id(matter._id) + '#cases';
    } else destination = '/admin-dashboard.html#posts';
    if (notice.kind === 'created') email = templates.adminJobPosted({ caseTitle: matter.title, attorneyName: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email, attorneyEmail: owner.email, practiceArea: matter.practiceArea, budget: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(matter.totalAmount || 0) / 100) });
    else email = templates.postingNotice({ kind: notice.kind, caseTitle: matter.title, destination });
  }
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient.email || '')) throw new Error('Recipient email unavailable.');
  return { to: recipient.email, ...email };
}
const { processNotices, noticeStatus } = require('./emailNoticeDelivery').createEmailNoticeDelivery({ Notice, prepare, prefix: 'posting' });
module.exports = { ready, stage, retain, stateKey, processNotices, noticeStatus };
