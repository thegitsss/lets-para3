const { Types } = require('mongoose');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const { lockActiveAccounts } = require('../utils/activeAccountWrite');

function changed() {
  return Object.assign(new Error('The calendar account could not be verified.'), {
    status: 403, publicCode: 'WORKSPACE_DATE_ACCOUNT_CHANGED',
  });
}

async function lock(req, session, role) {
  if (!session?.inTransaction()) throw new Error('A calendar actor write requires its transaction.');
  const ownerId = String(req?.user?.id || '');
  const expectedOwnerId = req?.body?.expectedOwnerId;
  const authVersion = Number(req?.authVersion ?? req?.auth?.payload?.av ?? 0);
  if (!['attorney', 'paralegal'].includes(role) || req?.user?.role !== role ||
      !/^[a-f0-9]{24}$/i.test(ownerId) || expectedOwnerId !== ownerId ||
      !Number.isSafeInteger(authVersion) || authVersion < 0) throw changed();
  const authority = { ownerId, role, authVersion, sessionId: req.authSessionId || null };
  try {
    await lockActiveAccounts([ownerId], session, { ownerId, authVersion });
  } catch (error) {
    if (error.publicCode === 'ACCOUNT_CHANGED') throw changed();
    throw error;
  }
  // Account closure/version and the exact current role arbitrate on this same
  // User row. The existing approved-role policy remains in force for both sides.
  if (!await User.collection.findOne({ _id: new Types.ObjectId(ownerId), role }, { session, projection: { _id: 1 } })) throw changed();
  if (authority.sessionId) {
    // Only legacy requests which the existing authentication boundary permits
    // may omit a managed SID. A present SID must belong to this actual actor.
    const result = await AuthSession.collection.updateOne(activeSid(authority), { $inc: { __v: 1 } }, { session });
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) throw changed();
  }
  return authority;
}

function activeSid(authority) {
  return { sessionId: authority.sessionId, userId: new Types.ObjectId(authority.ownerId), revokedAt: null, expiresAt: { $gt: new Date() } };
}

async function check(authority, session) {
  // Actor and managed SID stay locked until commit; time can still advance
  // beyond a stored expiry while Event/Case/audit work is in flight.
  if (authority.sessionId && !await AuthSession.collection.findOne(activeSid(authority), { session, projection: { _id: 1 } })) throw changed();
}

module.exports = { lock, check };
