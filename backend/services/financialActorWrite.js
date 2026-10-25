const { Types } = require('mongoose');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const { lockActiveAccounts } = require('../utils/activeAccountWrite');

function changed() {
  return Object.assign(new Error('The Matter funding details could not be verified. Review the current payment before continuing.'), {
    status: 403, publicCode: 'WORKSPACE_FUNDING_ACCOUNT_CHANGED',
  });
}

async function lock(req, session, { allowAdmin = false } = {}) {
  if (!session?.inTransaction()) throw new Error('A financial actor write requires its transaction.');
  const ownerId = String(req?.user?.id || ''), role = req?.user?.role;
  const expectedOwnerId = req?.method === 'GET' ? req.query?.expectedOwnerId : req?.body?.expectedOwnerId;
  const authVersion = Number(req?.authVersion ?? req?.auth?.payload?.av ?? 0);
  if (!/^[a-f0-9]{24}$/i.test(ownerId) || expectedOwnerId !== ownerId ||
      role !== 'attorney' && !(allowAdmin && role === 'admin') ||
      !Number.isSafeInteger(authVersion) || authVersion < 0) throw changed();
  const authority = { ownerId, role, authVersion, sessionId: req.authSessionId || null };
  try {
    await lockActiveAccounts([ownerId], session, { ownerId, authVersion });
  } catch (error) {
    if (error.publicCode === 'ACCOUNT_CHANGED') throw changed();
    throw error;
  }
  if (!await User.collection.findOne({ _id: new Types.ObjectId(ownerId), role }, { session, projection: { _id: 1 } })) throw changed();
  if (authority.sessionId) {
    // Revocation writes this same row. Reading the SID before the financial
    // transaction alone cannot arbitrate a later revocation or ownership change.
    const result = await AuthSession.collection.updateOne(activeSid(authority), { $inc: { __v: 1 } }, { session });
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) throw changed();
  }
  return authority;
}

function activeSid(authority) {
  return { sessionId: authority.sessionId, userId: new Types.ObjectId(authority.ownerId), revokedAt: null, expiresAt: { $gt: new Date() } };
}

async function check(authority, session) {
  // User and managed SID stay locked through commit. A stored expiry can still
  // cross the actual clock while the business/audit work is in flight.
  if (authority.sessionId && !await AuthSession.collection.findOne(activeSid(authority), { session, projection: { _id: 1 } })) throw changed();
}

module.exports = { lock, check };
