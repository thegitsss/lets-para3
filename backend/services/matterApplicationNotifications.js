const Notice = require('../models/MatterApplicationNotification');
const Application = require('../models/Application'), Job = require('../models/Job');
const Case = require('../models/Case'), User = require('../models/User');
const { one, id, refs, uniqueRecords } = require('./applicationIdentity');
const { fingerprint } = require('./matterDraftRevision');
const { caseParticipantIdentity } = require('../utils/caseParticipantIdentity');
const { isBlockedBetween } = require('../utils/blocks');
const same = (left, right) => Boolean(left && right && id(left) === id(right));
const approved = (user, role) => user?.role === role && user.status === 'approved' && !user.deleted && !user.disabled && !user.suspended;
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

function submissionKey(application) {
  const scope = application?.scopeSnapshot;
  const history = application?.statusHistory || [];
  let submitted = -1;
  for (let index = 0; index < history.length; index++) {
    if (history[index].to === 'submitted' && ['applied', 'reapplied'].includes(history[index].reason)) submitted = index;
  }
  if (!date(scope?.capturedAt) || submitted < 0) return null;
  return fingerprint([
    id(application._id), id(application.jobId), id(application.paralegalId),
    scope.title, scope.description, scope.practiceArea, scope.state, scope.caseId,
    scope.totalAmount, scope.currency, scope.deadlineDate, scope.tasks, date(scope.capturedAt),
    application.coverLetter, application.resumeURL, application.linkedInURL,
    history.slice(0, submitted + 1).map(entry => [entry.from || '', entry.to, entry.reason, id(entry.actorId), date(entry.at)]),
  ]);
}

async function ready() {
  const indexes = await Notice.collection.indexes();
  const has = (key, unique = false) => indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && (!unique || index.unique));
  if (!has({ applicationId: 1, submissionKey: 1, userId: 1 }, true) || !has({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 })) throw new Error('Application notification delivery indexes are unavailable.');
}

async function stage({ applicationId, userId, caseId }, session) {
  if (!session?.inTransaction()) throw new Error('Application email requires the submission transaction.');
  await ready();
  const application = await one(Application, applicationId, undefined, session);
  const job = application && await one(Job, application.jobId, undefined, session);
  const key = submissionKey(application);
  if (!key || application.status !== 'submitted' || !job || !same(job.attorneyId, userId) || id(job.caseId) !== id(caseId)) throw new Error('Application notification submission could not be verified.');
  await Notice.create([{ applicationId: application._id, submissionKey: key, jobId: job._id, caseId: caseId || null, userId, paralegalId: application.paralegalId }], { session });
}

async function prepare(notice) {
  if (notice.kind === 'withdrawn') return prepareWithdrawal(notice);
  if (notice.kind && notice.kind !== 'submitted') return null;
  const [application, job, matter, owner, applicant] = await Promise.all([
    one(Application, notice.applicationId), one(Job, notice.jobId),
    notice.caseId ? one(Case, notice.caseId) : null,
    one(User, notice.userId), one(User, notice.paralegalId),
  ]);
  const { shouldSendEmailForType } = require('../utils/notifyUser');
  if (!approved(owner, 'attorney') || !approved(applicant, 'paralegal')
    || !application || !same(application.jobId, notice.jobId) || !same(application.paralegalId, notice.paralegalId)
    || submissionKey(application) !== notice.submissionKey || !['submitted', 'viewed', 'shortlisted'].includes(application.status)
    || !job || job.status !== 'open' || !same(job.attorneyId, notice.userId) || id(job.caseId) !== id(notice.caseId)
    || !shouldSendEmailForType(owner, 'application_submitted') || await isBlockedBetween(notice.userId, notice.paralegalId)) return null;
  if (notice.caseId) {
    const identity = caseParticipantIdentity(matter || {}, notice.userId);
    const relisted = matter?.status === 'paused' && matter.relistRequestedAt && matter.payoutFinalizedAt;
    if (!matter || !identity.isAttorney || identity.identityConflict || matter.archived || matter.purgedAt
      || matter.paralegal || matter.paralegalId || matter.status !== 'open' && !relisted) return null;
  }
  if (application.syncStatus !== 'synced') throw new Error('Application list reconciliation has not finished.');
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(owner.email || '')) throw new Error('Recipient email unavailable.');
  return { to: owner.email, ...require('../email/templates').applicationSubmitted({
    caseId: notice.caseId, applicantId: notice.paralegalId,
    caseTitle: matter?.title || job.title || 'Untitled Matter',
    paralegalName: `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim() || 'A paralegal',
  }) };
}

function withdrawalKey(record, source, caseId) {
  if (record?.status !== 'withdrawn' || !date(record.withdrawnAt)) return null;
  const history = Array.isArray(record.statusHistory) ? record.statusHistory : [];
  let position = -1;
  for (let index = 0; index < history.length; index++) {
    if (history[index].to === 'withdrawn' && history[index].reason === 'revoked_by_paralegal') position = index;
  }
  if (position < 0 || date(history[position].at) !== date(record.withdrawnAt)) return null;
  if (source === 'earlier' && !/^[a-f0-9]{64}$/.test(record.withdrawalRevision || '')) return null;
  return fingerprint(['withdrawn', source, source === 'earlier' ? id(caseId) : id(record._id),
    id(record.paralegalId), date(record.withdrawnAt), record.withdrawalRevision || '',
    history.slice(0, position + 1).map(entry => [entry.from || '', entry.to, entry.reason, id(entry.actorId), date(entry.at)]),
  ]);
}

async function withdrawalContext({ applicationId, userId, caseId, paralegalId }, session) {
  const application = applicationId ? await one(Application, applicationId, undefined, session) : null;
  const matter = caseId ? await one(Case, caseId, undefined, session) : null;
  const source = applicationId ? 'canonical' : 'earlier';
  if (caseId && (!matter || matter.purgedAt || !caseParticipantIdentity(matter, userId).isAttorney
    || caseParticipantIdentity(matter, userId).identityConflict)) return null;
  const linkedId = application?.jobId || matter?.jobId || matter?.job;
  const jobs = caseId ? await uniqueRecords(Job, { $or: [{ caseId: { $in: refs(caseId) } }, ...(linkedId ? [{ _id: { $in: refs(linkedId) } }] : [])] }, undefined, session)
    : linkedId ? [await one(Job, linkedId, undefined, session)].filter(Boolean) : [];
  if (jobs.length > 1) return null;
  const job = jobs[0] || null;
  if (linkedId && !same(linkedId, job?._id)) return null;
  if (linkedId && !job || job && (!same(job.attorneyId, userId) || id(job.caseId) !== id(caseId))) return null;
  if (matter && [matter.job, matter.jobId].some(value => value && !same(value, job?._id))) return null;
  let record = application;
  if (source === 'canonical') {
    if (!application || !job || !same(application.paralegalId, paralegalId)) return null;
    const entries = await uniqueRecords(Application, { jobId: { $in: refs(job._id) }, paralegalId: { $in: refs(paralegalId) } }, undefined, session);
    if (entries.length !== 1 || !same(entries[0]._id, application._id)) return null;
  } else {
    if (!matter || !Array.isArray(matter.applicants)) return null;
    const entries = matter.applicants.filter(entry => same(entry.paralegalId, paralegalId));
    if (entries.length !== 1) return null;
    if (job && (await uniqueRecords(Application, { jobId: { $in: refs(job._id) }, paralegalId: { $in: refs(paralegalId) } }, { _id: 1 }, session)).length) return null;
    record = entries[0];
  }
  const key = withdrawalKey(record, source, caseId);
  return key ? { application, matter, job, source, key } : null;
}

async function stageWithdrawal(context, session) {
  if (!session?.inTransaction()) throw new Error('Application email requires the withdrawal transaction.');
  await ready();
  const current = await withdrawalContext(context, session);
  if (!current) throw new Error('Application notification withdrawal could not be verified.');
  await Notice.create([{ kind: 'withdrawn', source: current.source, applicationId: current.application?._id || null,
    submissionKey: current.key, jobId: current.job?._id || null, caseId: context.caseId || null,
    userId: context.userId, paralegalId: context.paralegalId }], { session });
}

async function prepareWithdrawal(notice) {
  if (notice.source !== 'canonical' && notice.source !== 'earlier') return null;
  if ((notice.source === 'canonical') !== Boolean(notice.applicationId)) return null;
  const current = await withdrawalContext(notice);
  if (!current || current.source !== notice.source || current.key !== notice.submissionKey
    || id(current.job?._id) !== id(notice.jobId)) return null;
  const [owner, applicant] = await Promise.all([one(User, notice.userId), one(User, notice.paralegalId)]);
  if (!approved(owner, 'attorney') || !approved(applicant, 'paralegal')
    || !require('../utils/notifyUser').shouldSendEmailForType(owner, 'case_update', { outcome: 'application_withdrawn' })
    || await isBlockedBetween(notice.userId, notice.paralegalId)) return null;
  if (current.application && current.application.syncStatus !== 'synced') throw new Error('Application list reconciliation has not finished.');
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(owner.email || '')) throw new Error('Recipient email unavailable.');
  return { to: owner.email, ...require('../email/templates').applicationWithdrawn({ caseId: notice.caseId, applicantId: notice.paralegalId,
    caseTitle: current.matter?.title || current.job?.title || 'Untitled Matter',
    paralegalName: `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim() || 'A paralegal',
  }) };
}

const { processNotices, noticeStatus } = require('./emailNoticeDelivery').createEmailNoticeDelivery({ Notice, prepare, prefix: 'application' });
module.exports = { ready, stage, submissionKey, withdrawalKey, stageWithdrawal, processNotices, noticeStatus };
