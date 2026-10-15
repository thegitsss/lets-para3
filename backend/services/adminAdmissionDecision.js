const { Types } = require('mongoose');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const { findActiveSession } = require('./authSessionService');
const { withActiveAccountWrite, lockActiveAccounts, accountChanged } = require('../utils/activeAccountWrite');

function intent(req) {
  const ownerId = String(req?.user?.id || req?.user?._id || '');
  const expected = req?.body?.expectedOwnerId ?? req?.query?.expectedOwnerId;
  if (!/^[a-f0-9]{24}$/i.test(ownerId) || expected !== ownerId ||
      req?.query?.expectedOwnerId !== undefined && req.query.expectedOwnerId !== ownerId ||
      req?.body?.expectedOwnerId !== undefined && req.body.expectedOwnerId !== ownerId ||
      req?.user?.role !== 'admin' || !req?.authSessionId) throw accountChanged();
  const authVersion = Number(req.auth?.payload?.av || 0);
  if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw accountChanged();
  return { ownerId, authVersion, sessionId: req.authSessionId };
}

async function verify(req) {
  const expected = intent(req);
  const actor = await User.collection.findOne({ _id: new Types.ObjectId(expected.ownerId) }, {
    projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 },
  });
  if (!actor || actor.role !== 'admin' || actor.status !== 'approved' || actor.disabled || actor.deleted ||
      Number(actor.authVersion || 0) !== expected.authVersion ||
      !await findActiveSession(expected.sessionId, expected.ownerId)) throw accountChanged();
  return expected;
}

async function write(req, work) {
  const expected = await verify(req);
  return withActiveAccountWrite([expected.ownerId], async session => {
    const actorId = new Types.ObjectId(expected.ownerId);
    if (!await User.collection.findOne({ _id: actorId, role: 'admin' }, { session, projection: { _id: 1 } })) throw accountChanged();
    // Touch the same managed-session row that revocation writes. A snapshot
    // read alone cannot arbitrate a revocation racing this decision.
    const active = await AuthSession.collection.updateOne({ sessionId: expected.sessionId, userId: actorId,
      revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
    if (active.matchedCount !== 1) throw accountChanged();
    const result = await work(session);
    await lockActiveAccounts([expected.ownerId], session, expected);
    if (!await User.collection.findOne({ _id: actorId, role: 'admin' }, { session, projection: { _id: 1 } }) ||
        !await AuthSession.collection.findOne({ sessionId: expected.sessionId, userId: actorId, revokedAt: null,
          expiresAt: { $gt: new Date() } }, { session, projection: { _id: 1 } })) throw accountChanged();
    return result;
  }, expected);
}

module.exports = { verify, write };
