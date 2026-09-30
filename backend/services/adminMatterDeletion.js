const { Types } = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const AuditLog = require('../models/AuditLog');
const { findActiveSession } = require('./authSessionService');
const { fingerprint } = require('./matterDraftRevision');
const { assertPostingDeletionAllowed, deletePostingRecords } = require('./matterDeletion');
const { withActiveAccountWrite, accountChanged } = require('../utils/activeAccountWrite');

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, publicCode: `ADMIN_MATTER_DELETE_${code}` });
}
function actorId(req, expectedOwnerId) {
  const id = String(req.user?.id || req.user?._id || '');
  if (!/^[a-f0-9]{24}$/i.test(id) || req.user?.role !== 'admin' || expectedOwnerId !== undefined && expectedOwnerId !== id) throw accountChanged();
  return id;
}
async function readActor(req, expectedOwnerId) {
  const ownerId = actorId(req, expectedOwnerId);
  const user = await User.findById(ownerId).select('role status disabled deleted authVersion').lean();
  if (!user || user.role !== 'admin' || user.status !== 'approved' || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, ownerId)) throw accountChanged();
  return ownerId;
}
async function load(id, session) {
  if (!/^[a-f0-9]{24}$/i.test(id || '')) fail(400, 'INVALID', 'Invalid Matter ID.');
  const doc = await Case.collection.findOne({ _id: new Types.ObjectId(id) }, { session });
  if (!doc) fail(404, 'NOT_FOUND', 'Matter not found.');
  return doc;
}
async function review(req, id) {
  const ownerId = await readActor(req, req.query?.expectedOwnerId), doc = await load(id);
  let canDelete = true, reason = '';
  try { assertPostingDeletionAllowed(doc); } catch (error) {
    if (error.publicCode !== 'MATTER_DELETE_RETAINED') throw error;
    canDelete = false; reason = error.message;
  }
  await readActor(req, ownerId);
  return { ownerId, caseId: String(doc._id), title: doc.title || 'Untitled Matter', revision: fingerprint(doc), canDelete, reason };
}
async function remove(req, id, { reason, message }) {
  const ownerId = actorId(req, req.body?.expectedOwnerId), revision = req.body?.revision;
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) fail(400, 'INVALID', 'Reload the posting before deleting it.');
  return withActiveAccountWrite([ownerId], async session => {
    const actor = await User.collection.findOne({ _id: new Types.ObjectId(ownerId), role: 'admin' }, { session, projection: { _id: 1 } });
    if (!actor) throw accountChanged();
    if (req.authSessionId) {
      const active = await AuthSession.collection.updateOne({ sessionId: req.authSessionId, userId: actor._id, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
      if (active.matchedCount !== 1) throw accountChanged();
    }
    const doc = await load(id, session);
    if (revision !== undefined && revision !== fingerprint(doc)) fail(409, 'CHANGED', 'This posting changed. Refresh and review it before deleting.');
    const result = await deletePostingRecords(doc, session);
    await AuditLog.create([{ actor: actor._id, actorRole: 'admin', action: 'admin.case.delete', targetType: 'case', targetId: String(doc._id), case: doc._id, ip: req.ip, ua: req.headers?.['user-agent'], method: req.method, path: req.originalUrl, meta: { reason, message } }], { session });
    return result;
  }, { ownerId, authVersion: req.auth?.payload?.av || 0 });
}
module.exports = { review, remove };
