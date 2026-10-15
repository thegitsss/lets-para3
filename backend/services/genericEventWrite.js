const mongoose = require('mongoose');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const Case = require('../models/Case');
const Event = require('../models/Event');
const AuditLog = require('../models/AuditLog');
const { lockActiveAccounts } = require('../utils/activeAccountWrite');
const { caseParticipantIdentity } = require('../utils/caseParticipantIdentity');
const { reportOperationalFailure } = require('../utils/operationalFailure');
const changed = (status = 403, code = 'EVENT_ACCOUNT_CHANGED') => Object.assign(new Error('The calendar account or record changed. Review its current state before continuing.'), { status, publicCode: code });
const ref = value => String(value || '');
function actorFilter(req) {
  const version = Number(req.authVersion || 0);
  if (!mongoose.isObjectIdOrHexString(req.user?.id) || !['attorney', 'paralegal', 'admin'].includes(req.user?.role) || !Number.isSafeInteger(version) || version < 0) throw changed();
  return { _id: new mongoose.Types.ObjectId(req.user.id), role: req.user.role, status: 'approved', disabled: { $ne: true }, deleted: { $ne: true }, ...(version === 0 ? { $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }] } : { authVersion: version }) };
}
const sidFilter = req => ({ sessionId: req.authSessionId, userId: new mongoose.Types.ObjectId(req.user.id), revokedAt: null, expiresAt: { $gt: new Date() } });
async function checkActor(req, session) {
  if (!await User.collection.findOne(actorFilter(req), { session, projection: { _id: 1 } })) throw changed();
  if (req.authSessionId && !await AuthSession.collection.findOne(sidFilter(req), { session, projection: { _id: 1 } })) throw changed();
  if (!req.authSessionId && (process.env.NODE_ENV === 'production' || process.env.REQUIRE_AUTH_SESSION === 'true')) throw changed();
}
async function lockCase(req, caseId, session) {
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId) }, { session });
  if (!raw) throw changed(404, 'EVENT_MATTER_CHANGED');
  if (req.user.role !== 'admin') {
    const identity = caseParticipantIdentity(raw, req.user.id);
    if (identity.identityConflict) throw changed(409, 'CASE_IDENTITY_CONFLICT');
    if (!identity.isAttorney && !identity.isParalegal || identity.isParalegal && raw.paralegalAccessRevokedAt) throw changed(403, 'EVENT_MATTER_CHANGED');
  }
  // An actual write arbitrates concurrent participant/ACL changes. Financial,
  // deadline and work fields stay byte-for-byte intact; only __v advances.
  const filter = { _id: raw._id, __v: Object.hasOwn(raw, '__v') ? raw.__v : { $exists: false } };
  const locked = await Case.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
  if (locked.matchedCount !== 1 || locked.modifiedCount !== 1) throw changed(409, 'EVENT_MATTER_CHANGED');
}
async function write(req, { initialEvent = null, caseIds = [], action, create = null, remove = false, modify = null }) {
  await Promise.all([Event.init(), AuditLog.init()]);
  const session = await mongoose.startSession();
  let result;
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
    await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: Number(req.authVersion || 0) });
    await checkActor(req, session);
    if (req.authSessionId) {
      const locked = await AuthSession.collection.updateOne(sidFilter(req), { $inc: { __v: 1 } }, { session });
      if (locked.matchedCount !== 1 || locked.modifiedCount !== 1) throw changed();
    }
    for (const caseId of [...new Set(caseIds.filter(Boolean).map(ref))].sort()) await lockCase(req, caseId, session);
    let raw, prepared;
    if (initialEvent) {
      raw = await Event.collection.findOne({ _id: initialEvent._id, owner: new mongoose.Types.ObjectId(req.user.id) }, { session });
      if (!raw || ref(raw.caseId) !== ref(initialEvent.caseId) || raw.updatedAt?.getTime() !== initialEvent.updatedAt?.getTime()) throw changed(409, 'EVENT_CHANGED');
      if (remove) {
        const removed = await Event.collection.deleteOne({ _id: raw._id, owner: raw.owner }, { session });
        if (removed.deletedCount !== 1) throw changed(409, 'EVENT_CHANGED');
      } else {
        prepared = Event.hydrate(raw); await modify(prepared); await prepared.validate();
        const clean = prepared.toObject(), changes = {};
        for (const key of prepared.modifiedPaths({ includeChildren: false }).filter(key => !key.includes('.') && !['_id', 'owner', 'createdAt', 'updatedAt'].includes(key))) changes[key] = clean[key];
        // Preserve unknown retained metadata on existing subdocuments.
        for (const key of ['attendees', 'reminders']) if (Object.hasOwn(changes, key)) changes[key] = changes[key].map((entry, index) => ({ ...(raw[key]?.[index] || {}), ...entry }));
        changes.updatedAt = new Date();
        const saved = await Event.collection.updateOne({ _id: raw._id, owner: raw.owner }, { $set: changes }, { session });
        if (saved.matchedCount !== 1) throw changed(409, 'EVENT_CHANGED');
      }
      result = { id: String(raw._id) };
    } else {
      prepared = new Event({ ...create, owner: req.user.id }); await prepared.validate();
      const now = new Date(), next = { ...prepared.toObject(), createdAt: now, updatedAt: now };
      await Event.collection.insertOne(next, { session }); result = { id: String(next._id) };
    }
    await AuditLog.logFromReq(req, action, { targetType: 'event', targetId: result.id, ...(create ? { meta: { type: prepared.type, caseId: prepared.caseId || null } } : {}), session });
    await checkActor(req, session); await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure('services.genericEventWrite.transaction_abort'));
    if (error.publicCode) throw error;
    if (error.code === 112 || error.hasErrorLabel?.('TransientTransactionError')) throw changed(409, 'EVENT_CHANGED');
    if (error.name === 'ValidationError') throw Object.assign(error, { status: 400 });
    throw Object.assign(new Error('The calendar change could not be confirmed. Check its saved state before trying again.'), { status: 503, publicCode: 'EVENT_WRITE_UNCONFIRMED' });
  } finally { await session.endSession(); }
}
module.exports = { write, checkActor };
