'use strict';
const { createHash, randomUUID } = require('node:crypto');
const Work = require('../models/AdminWorkPreparation');
const State = require('../models/AutomationCycleState');
const User = require('../models/User');
const Ticket = require('../models/SupportTicket');
const Case = require('../models/Case');
const { encryptString, decryptString, isEncryptionEnabled } = require('../utils/dataEncryption');
const { evaluateAttorneyAccountReadiness, evaluateParalegalAdmissionReadiness } = require('./readinessPolicy');
const { prepareApplication, prepareInquiry } = require('./adminPreparationService');
const { readMaintenanceMode } = require('../utils/appSettings');
const MAX_ATTEMPTS = 3, LEASE_MS = 120000, STATE_ID = 'admin-preparation';
const MODELS = { application: User, inquiry: Ticket, matter: Case };
const SELECT = {
  application: 'firstName lastName email emailVerified role status disabled deleted state location termsAccepted barNumber barState attorneyGoodStanding attorneyPricingAccepted paralegalQualification yearsExperience resumeURL certificateURL bio about skills specialties practiceAreas jurisdictions education experience updatedAt',
  inquiry: 'subject message latestUserMessage requesterRole requestKind status assignedTo escalationReason riskFlags linkedIncidentIds lastInboundMailAt lastAdminReplyAt emailReplies updatedAt',
  matter: 'title status archived deadlineDate fundingIntegrityStatus postingSyncStatus hiringClaimStatus completionClaimStatus moderationStatus disputes.status updatedAt',
};
const ACTIVE_MATTERS = ['open', 'in progress', 'in_progress', 'paused', 'disputed'];
const SOURCE_QUERIES = {
  application: { role: { $in: ['attorney', 'paralegal'] }, status: 'pending', disabled: { $ne: true }, deleted: { $ne: true } },
  inquiry: { status: { $in: ['open', 'in_review', 'waiting_on_user', 'waiting_on_info'] } },
  matter: { $or: [
    { archived: { $ne: true }, status: { $in: ACTIVE_MATTERS } },
    { fundingIntegrityStatus: 'failed' },
    ...['postingSyncStatus', 'hiringClaimStatus', 'completionClaimStatus'].map(key => ({ [key]: 'needs_reconciliation' })),
    { disputes: { $elemMatch: { status: { $nin: ['resolved', 'rejected'] } } } },
    { moderationStatus: 'resolution_requested' },
  ] },
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateKey = now => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const isoDate = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
function validKind(kind) { if (!Object.hasOwn(MODELS, kind)) throw Object.assign(new Error('Choose an application, inquiry or matter.'), { statusCode: 400 }); }
async function knowledgeEpoch(now, session = null) {
  const Item = require('../models/KnowledgeItem'), Revision = require('../models/KnowledgeRevision'), Collection = require('../models/KnowledgeCollection');
  const items = await Item.find({ audienceScopes: 'support_safe' }).select('key approvalState isActive tags currentApprovedRevisionId nextReviewAt collectionId').sort({ _id: 1 }).limit(1001).session(session).lean();
  if (items.length > 1000) throw new Error('Support knowledge preparation needs a narrower source.');
  const readRevisions = () => Revision.find({ _id: { $in: items.map(row => row.currentApprovedRevisionId).filter(Boolean) } }).select('fingerprint approvalState').sort({ _id: 1 }).session(session).lean();
  const readCollections = () => Collection.find({ _id: { $in: items.map(row => row.collectionId).filter(Boolean) } }).select('isActive').sort({ _id: 1 }).session(session).lean();
  const [revisions, collections] = session ? [await readRevisions(), await readCollections()] : await Promise.all([readRevisions(), readCollections()]);
  return hash([items.map(row => ({ ...row, expired: !row.nextReviewAt || new Date(row.nextReviewAt) <= now })), revisions, collections, require('./knowledge/sourceRegistry').listRegistrySources().map(({ absolutePath: _absolutePath, ...source }) => source)]);
}
function revision(kind, doc, now, epoch = '') {
  // Explicit property order, including the source timestamp, binds the cached
  // advice to the reviewed record. Deadline checks also turn over each day.
  return hash([2, kind, SELECT[kind].split(' ').map(key => key.includes('.') ? doc.disputes : doc[key]), kind === 'matter' ? dateKey(now) : '', kind === 'inquiry' ? epoch : '']);
}
function eligible(kind, doc) {
  return kind === 'application' ? doc.status === 'pending' && !doc.disabled && !doc.deleted && ['attorney', 'paralegal'].includes(doc.role)
    : kind === 'inquiry' ? ['open', 'in_review', 'waiting_on_user', 'waiting_on_info'].includes(doc.status) : (!doc.archived && ACTIVE_MATTERS.includes(doc.status)) || doc.fundingIntegrityStatus === 'failed' || ['postingSyncStatus', 'hiringClaimStatus', 'completionClaimStatus'].some(key => doc[key] === 'needs_reconciliation') || doc.disputes?.some(row => !['resolved', 'rejected'].includes(row.status)) || doc.moderationStatus === 'resolution_requested';
}
async function source(kind, id, now, epoch, session = null) {
  validKind(kind);
  const doc = await MODELS[kind].findById(id).select(SELECT[kind]).session(session).lean();
  return doc ? { doc, revision: revision(kind, doc, now, epoch ?? (kind === 'inquiry' ? await knowledgeEpoch(now, session) : '')), eligible: eligible(kind, doc) } : null;
}
async function prepare(kind, doc, now) {
  if (kind === 'application') {
    const readiness = doc.role === 'attorney' ? evaluateAttorneyAccountReadiness(doc) : evaluateParalegalAdmissionReadiness(doc);
    const prepared = prepareApplication(doc, readiness);
    const summary = prepared.missing.length ? `${prepared.missing.length} application ${prepared.missing.length === 1 ? 'detail needs' : 'details need'} attention.` : 'No information request is needed.';
    return { requiresOwner: true, title: prepared.missing.length ? 'Application details needed' : 'Admission review ready', summary, missing: prepared.missing, requestText: prepared.requestText, readiness: { ready: readiness.ready, reasons: readiness.reasons }, recommendedAction: prepared.missing.length ? 'Review the prepared information request.' : 'Review the qualification and decide admission.' };
  }
  if (kind === 'inquiry') {
    const prepared = await prepareInquiry(doc._id);
    return { requiresOwner: true, title: doc.requestKind === 'human' ? 'Human reply requested' : prepared.text ? 'Reply prepared' : 'Inquiry needs review', summary: prepared.reason, text: prepared.text, sources: prepared.sources, recommendedAction: prepared.text ? 'Review and send the prepared reply.' : 'Review the conversation before replying.' };
  }
  const reasons = [];
  if (doc.fundingIntegrityStatus === 'failed') reasons.push('Funding needs review.');
  if (['postingSyncStatus', 'hiringClaimStatus', 'completionClaimStatus'].some(key => doc[key] === 'needs_reconciliation')) reasons.push('A saved marketplace change needs reconciliation.');
  if (doc.disputes?.some(row => !['resolved', 'rejected'].includes(row.status))) reasons.push('An unresolved dispute needs a decision.');
  if (doc.moderationStatus === 'resolution_requested') reasons.push('The author submitted posting corrections.');
  if (['open', 'in progress', 'in_progress', 'paused'].includes(doc.status) && doc.deadlineDate && doc.deadlineDate < dateKey(now)) reasons.push('The matter deadline has passed.');
  return { requiresOwner: reasons.length > 0, title: reasons.length ? 'Matter review prepared' : 'Matter progressing', summary: reasons.join(' ') || 'No owner exception was found in the checked marketplace state.', reasons, recommendedAction: reasons.length ? 'Review the linked matter and its current evidence.' : '', scope: 'Stored workflow state only; this preparation does not verify provider balances, move money or contact participants.' };
}
async function stage(kind, doc, now, epoch) {
  const key = `${kind}:${doc._id}`, sourceRevision = revision(kind, doc, now, epoch);
  const existing = await Work.findById(key).select('sourceRevision status leaseUntil').lean();
  if (existing?.sourceRevision === sourceRevision) return false;
  if (existing?.status === 'running' && new Date(existing.leaseUntil) > now) return false;
  const update = { kind, sourceId: doc._id, sourceRevision, status: eligible(kind, doc) ? 'pending' : 'obsolete', attempts: 0, nextAttemptAt: now, claimId: '', leaseUntil: null, preparedAt: null, encryptedResult: '', failure: '' };
  if (existing) return (await Work.updateOne({ _id: key, sourceRevision: existing.sourceRevision, status: existing.status }, { $set: update })).modifiedCount === 1;
  try { await Work.create({ _id: key, ...update }); return true; } catch (error) { if (error.code === 11000) return false; throw error; }
}
async function execute(id, { now = new Date(), epoch, prepareOperation = prepare } = {}) {
  const claimId = randomUUID();
  const job = await Work.findOneAndUpdate({ _id: id, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now }, $or: [{ status: { $in: ['pending', 'failed'] } }, { status: 'running', leaseUntil: { $lte: now } }] }, { $set: { status: 'running', claimId, leaseUntil: new Date(now.getTime() + LEASE_MS), failure: '' }, $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
  if (!job) return 'skipped';
  const fence = { _id: id, status: 'running', claimId, sourceRevision: job.sourceRevision };
  try {
    const current = await source(job.kind, job.sourceId, now, epoch);
    if (!current || !current.eligible || current.revision !== job.sourceRevision) {
      await Work.updateOne(fence, { $set: { status: 'obsolete', claimId: '', leaseUntil: null, encryptedResult: '' } });
      if (current) await stage(job.kind, current.doc, now, epoch);
      return 'obsolete';
    }
    const result = await prepareOperation(job.kind, current.doc, now);
    const fresh = await source(job.kind, job.sourceId, now, epoch);
    if (!fresh || !fresh.eligible || fresh.revision !== current.revision) {
      await Work.updateOne(fence, { $set: { status: 'obsolete', claimId: '', leaseUntil: null, encryptedResult: '' } });
      if (fresh) await stage(job.kind, fresh.doc, now, epoch);
      return 'obsolete';
    }
    if (!isEncryptionEnabled()) throw new Error('Protected preparation storage requires its encryption key.');
    const written = await Work.updateOne(fence, { $set: { status: 'prepared', requiresOwner: result.requiresOwner, encryptedResult: encryptString(JSON.stringify(result), { plaintext: true }), preparedAt: now, claimId: '', leaseUntil: null } });
    return written.modifiedCount === 1 ? 'prepared' : 'skipped';
  } catch (_) {
    await Work.updateOne(fence, { $set: { status: 'failed', claimId: '', leaseUntil: null, encryptedResult: '', failure: 'Preparation could not finish. The original record remains available for review.', nextAttemptAt: new Date(now.getTime() + Math.min(60, 2 ** job.attempts) * 60000) } });
    return 'failed';
  }
}
async function runAdminPreparationCycle({ limit = 50, now = new Date(), shouldStop = () => false, onProgress = async () => {}, dependencies = {} } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Preparation limit must be between 1 and 200.');
  const maintenance = await (dependencies.readMaintenanceMode || readMaintenanceMode)();
  if (maintenance !== false) return { ok: maintenance === true, paused: true, reason: maintenance === true ? 'maintenance_mode' : 'settings_unavailable' };
  const startedClock = performance.now();
  const currentTime = () => new Date(now.getTime() + Math.max(0, performance.now() - startedClock));
  const leaseTime = () => new Date(currentTime().getTime() + LEASE_MS);
  const runId = randomUUID(), leaseUntil = leaseTime();
  let state;
  try { state = await State.findOneAndUpdate({ _id: STATE_ID, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $set: { runId, status: 'running', startedAt: now, finishedAt: null, failedTasks: [], leaseUntil } }, { upsert: true, returnDocument: 'after' }).lean(); }
  catch (error) { if (error.code === 11000) return { ok: true, skipped: 'already_running', prepared: 0 }; throw error; }
  const summary = { ok: true, paused: false, scanned: 0, staged: 0, prepared: 0, obsolete: 0, failed: 0 };
  try {
    let epoch, knowledgeAvailable = true;
    try { epoch = await knowledgeEpoch(now); } catch (_) { knowledgeAvailable = false; summary.failed++; }
    for (const [kind, Model] of Object.entries(MODELS)) {
      if (shouldStop()) break;
      if (kind === 'inquiry' && !knowledgeAvailable) continue;
      const cursor = state.preparationCursors?.[kind];
      const rows = await Model.find({ ...SOURCE_QUERIES[kind], ...(cursor ? { _id: { $gt: cursor } } : {}) }).select(SELECT[kind]).sort({ _id: 1 }).limit(limit).lean();
      if (!rows.length) await State.updateOne({ _id: STATE_ID, runId }, { $set: { [`preparationCursors.${kind}`]: null } });
      for (const doc of rows) {
        if (shouldStop()) break;
        summary.scanned++; if (await stage(kind, doc, now, epoch)) summary.staged++;
        await State.updateOne({ _id: STATE_ID, runId }, { $set: { [`preparationCursors.${kind}`]: doc._id, leaseUntil: leaseTime() } });
        await onProgress();
      }
    }
    // Retire departed work and refresh changed cached sources without scanning
    // registered members or resolved history on every operating pass.
    const retireCursor = state.preparationCursors?.retire;
    const cached = await Work.find({ status: { $in: ['pending', 'prepared', 'failed'] }, ...(retireCursor ? { _id: { $gt: retireCursor } } : {}) }).select('kind sourceId sourceRevision status').sort({ _id: 1 }).limit(limit).lean();
    if (!cached.length) await State.updateOne({ _id: STATE_ID, runId }, { $set: { 'preparationCursors.retire': null } });
    for (const job of cached) {
      if (shouldStop()) break;
      if (job.kind === 'inquiry' && !knowledgeAvailable) continue;
      const current = await source(job.kind, job.sourceId, now, epoch);
      if (!current?.eligible) await Work.updateOne({ _id: job._id, status: job.status, sourceRevision: job.sourceRevision }, { $set: { status: 'obsolete', encryptedResult: '', claimId: '', leaseUntil: null } });
      else if (current.revision !== job.sourceRevision) await stage(job.kind, current.doc, now, epoch);
      await State.updateOne({ _id: STATE_ID, runId }, { $set: { 'preparationCursors.retire': job._id, leaseUntil: leaseTime() } });
    }
    const jobs = await Work.find({ attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now }, $or: [{ status: { $in: ['pending', 'failed'] } }, { status: 'running', leaseUntil: { $lte: now } }] }).sort({ nextAttemptAt: 1, _id: 1 }).limit(limit * 3).select('_id').lean();
    for (const job of jobs) {
      if (shouldStop()) break;
      const status = await execute(job._id, { now, epoch, prepareOperation: dependencies.prepare || prepare });
      if (Object.hasOwn(summary, status)) summary[status]++;
      await State.updateOne({ _id: STATE_ID, runId }, { $set: { leaseUntil: leaseTime() } }); await onProgress();
    }
    summary.paused = shouldStop(); summary.ok = !summary.failed;
    await State.updateOne({ _id: STATE_ID, runId }, { $set: { status: summary.failed ? 'failed' : summary.paused ? 'paused' : 'completed', finishedAt: currentTime(), failedTasks: summary.failed ? ['adminPreparation'] : [], leaseUntil: null } });
    return summary;
  } catch (error) {
    await State.updateOne({ _id: STATE_ID, runId }, { $set: { status: 'failed', finishedAt: currentTime(), failedTasks: ['adminPreparation'], leaseUntil: null } }); throw error;
  }
}
async function readCurrentPreparation(kind, id, { now = new Date() } = {}) {
  validKind(kind);
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw Object.assign(new Error('Invalid record.'), { statusCode: 400 });
  const row = await Work.findById(`${kind}:${id}`).select('+encryptedResult').lean();
  if (!row) return { status: 'pending', current: false };
  const current = await source(kind, id, now);
  if (!current?.eligible || current.revision !== row.sourceRevision) return { status: 'stale', current: false };
  if (row.status !== 'prepared') return { status: row.status, current: false, sourceRevision: current.revision, recordUpdatedAt: isoDate(current.doc.updatedAt), message: row.failure || 'Preparation has not finished.' };
  return { status: 'prepared', current: true, key: row._id, sourceRevision: row.sourceRevision, recordUpdatedAt: isoDate(current.doc.updatedAt), preparedAt: row.preparedAt, result: JSON.parse(decryptString(row.encryptedResult)) };
}
async function retryPreparation(kind, id, { reviewedRevision, now = new Date(), session = null } = {}) {
  validKind(kind);
  if (!/^[a-f0-9]{24}$/i.test(String(id)) || !/^[a-f0-9]{64}$/.test(String(reviewedRevision || ''))) throw Object.assign(new Error('Refresh this preparation before retrying.'), { statusCode: 400 });
  const current = await source(kind, id, now, undefined, session);
  if (!current?.eligible || current.revision !== reviewedRevision) throw Object.assign(new Error('This record changed. Refresh before retrying preparation.'), { statusCode: 409 });
  const changed = await Work.updateOne({ _id: `${kind}:${id}`, sourceRevision: reviewedRevision, status: 'failed' }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, failure: '', claimId: '', leaseUntil: null } }, { session });
  if (!changed.modifiedCount) throw Object.assign(new Error('This preparation is no longer waiting for recovery.'), { statusCode: 409 });
  return { recorded: true, status: 'pending', key: `${kind}:${id}` };
}
async function readAdminOperatingStatus({ now = new Date() } = {}) {
  const [state, counts, blocked, failedRows] = await Promise.all([
    State.findById(STATE_ID).lean(), Work.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Work.countDocuments({ status: 'failed', attempts: { $gte: MAX_ATTEMPTS } }),
    Work.find({ status: 'failed' }).select('kind sourceId sourceRevision failure').sort({ updatedAt: 1, _id: 1 }).limit(10).lean(),
  ]);
  const failedItems = [];
  for (const row of failedRows) {
    const current = await source(row.kind, row.sourceId, now);
    if (current?.eligible && current.revision === row.sourceRevision) failedItems.push({ kind: row.kind, id: String(row.sourceId), sourceRevision: row.sourceRevision, recordUpdatedAt: isoDate(current.doc.updatedAt), status: 'failed', message: row.failure || 'Preparation could not finish.' });
  }
  const at = state?.finishedAt || state?.startedAt, age = at ? now - new Date(at) : NaN;
  const status = !state ? 'unknown' : !Number.isFinite(age) || age < -60000 || age > 15 * 60000 ? 'stale' : state.status;
  const totals = Object.fromEntries(counts.map(row => [row._id, row.count]));
  const healthy = status === 'completed' && !blocked && !totals.failed;
  const message = { unknown: 'Review preparation has not checked in.', stale: 'Review preparation has no recent check-in.', running: 'Review preparation is running.', completed: healthy ? 'Review preparation completed its latest pass.' : 'Some review preparation needs another pass.', failed: 'Review preparation needs checking. Original records remain available.', paused: 'Review preparation is paused.' }[status];
  return { status, healthy, message, checkedAt: now, startedAt: state?.startedAt || null, finishedAt: state?.finishedAt || null, counts: totals, blocked, failedItems, scope: 'Read-only application, inquiry and marketplace review preparation. Correspondence runs only under its separately enabled policies.' };
}
module.exports = { runAdminPreparationCycle, readCurrentPreparation, readAdminOperatingStatus, retryPreparation, execute, prepare, stage, revision, knowledgeEpoch, MAX_ATTEMPTS };
