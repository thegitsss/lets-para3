const { Types } = require('mongoose');
const Case = require('../models/Case');
const id = value => String(value?._id || value?.id || value?.userId || value || '');
const invalid = () => { throw Object.assign(new Error('This invitation has inconsistent records. Contact support for help reviewing it.'), { status: 409, publicCode: 'INVITATION_SOURCE_INVALID' }); };
const fields = ['__v', 'attorney', 'attorneyId', 'status', 'archived', 'readOnly', 'paymentReleased', 'paralegal', 'paralegalId', 'pendingParalegalId', 'pendingParalegalInvitedAt', 'invites', 'title', 'details', 'briefSummary', 'practiceArea', 'state', 'locationState', 'deadline', 'deadlineDate', 'minimumYearsExperience', 'experiencePreference', 'tasks', 'taskRevision', 'totalAmount', 'lockedTotalAmount', 'amountLockedAt', 'currency', 'job', 'jobId', 'escrowStatus', 'hiringClaimToken', 'hiringClaimStatus', 'hiringClaimParalegalId'];

// Capture the stored BSON values before hydration/population can add defaults
// or cast an earlier string reference. Viewing never migrates an invitation.
async function load(caseId, paralegalId) {
  const source = await Case.findById(caseId).lean();
  if (!source) return { caseDoc: null, legacyInvitation: null };
  if (source.invites != null && !Array.isArray(source.invites)) invalid();
  const entries = source.invites || [], own = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => id(entry?.paralegalId) === id(paralegalId));
  if (own.length > 1 || own.some(({ entry }) => !['pending', 'accepted', 'declined', 'expired'].includes(entry.status))) invalid();
  const earlier = !own.length && id(source.pendingParalegalId) === id(paralegalId);
  const stringReference = own.length === 1 && own[0].entry.status === 'pending' && typeof own[0].entry.paralegalId === 'string';
  const caseDoc = Case.hydrate(source);
  if (!earlier && !stringReference) return { caseDoc, legacyInvitation: null };
  if (!Types.ObjectId.isValid(id(source.attorney || source.attorneyId)) || source.attorney && source.attorneyId && id(source.attorney) !== id(source.attorneyId)) invalid();
  const value = earlier ? source.pendingParalegalInvitedAt : own[0].entry.invitedAt;
  const invitedAt = value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
  const legacyInvitation = {
    filter: { _id: source._id, $and: fields.map(field => Object.hasOwn(source, field) ? { [field]: { $eq: source[field], $exists: true } } : { [field]: { $exists: false } }) },
    index: earlier ? null : own[0].index,
    initializeArray: source.invites === null,
    invitedAt,
    unavailable: source.archived === true || source.readOnly === true || source.paymentReleased === true || ['completed', 'complete', 'closed', 'disputed', 'cancelled', 'canceled'].includes(String(source.status).toLowerCase()),
  };
  if (earlier) {
    if (!Array.isArray(caseDoc.invites)) caseDoc.invites = [];
    caseDoc.invites.push({ paralegalId, status: 'pending', invitedAt, respondedAt: null });
  }
  return { caseDoc, legacyInvitation };
}

async function commit(legacy, { paralegalId, status, respondedAt, lockedTotalAmount, amountLockedAt, session }) {
  if (!legacy || legacy.unavailable) return { modifiedCount: 0 };
  const entry = { paralegalId: new Types.ObjectId(id(paralegalId)), status, respondedAt, syncStatus: 'pending', syncedAt: null, syncError: '' };
  const set = { updatedAt: respondedAt };
  if (status === 'accepted' && Number.isFinite(Number(lockedTotalAmount))) {
    set.lockedTotalAmount = Math.max(0, Math.round(Number(lockedTotalAmount)));
    set.amountLockedAt = amountLockedAt || respondedAt;
  }
  const conditions = [...legacy.filter.$and];
  if (status === 'accepted') for (const field of ['paralegal', 'paralegalId', 'hiringClaimToken', 'hiringClaimStatus']) conditions.push({ $or: [{ [field]: null }, { [field]: '' }] });
  const update = { $set: set, $inc: { __v: 1 } };
  if (legacy.index === null && legacy.initializeArray) set.invites = [{ ...entry, invitedAt: legacy.invitedAt }];
  else if (legacy.index === null) update.$push = { invites: { ...entry, invitedAt: legacy.invitedAt } };
  else for (const [key, value] of Object.entries(entry)) set[`invites.${legacy.index}.${key}`] = value;
  // Exact preimage comparison also catches writers that did not increment __v.
  return Case.collection.updateOne({ ...legacy.filter, $and: conditions }, update, { session });
}
module.exports = { load, commit };
