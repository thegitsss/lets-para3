const { Types } = require('mongoose');
const User = require('../../models/User');
const AuthSession = require('../../models/AuthSession');
const account = require('../financialAccountBoundary');
const { withActiveAccountWrite, lockActiveAccounts, accountChanged } = require('../../utils/activeAccountWrite');

async function verify(req) {
  if (!req?.authSessionId) throw accountChanged();
  return account.read(req, 'director', req.query?.expectedOwnerId);
}

function savedReview(error) {
  const statusCode = error?.status === 403 || error?.statusCode === 403 ? 403 : 503;
  return Object.assign(new Error('The import was saved. Sign in and review your records before syncing again.'), {
    status: statusCode, statusCode, publicCode: 'DIRECTOR_IMPORT_SAVED_REVIEW',
  });
}

async function write(req, work) {
  const ownerId = String(req.user?.id || req.user?._id || '');
  await verify(req);
  return withActiveAccountWrite([ownerId], async session => {
    const actor = await User.collection.findOne({ _id: new Types.ObjectId(ownerId), role: 'director' }, { session, projection: { _id: 1, email: 1, role: 1 } });
    if (!actor || !req.authSessionId) throw accountChanged();
    const active = await AuthSession.collection.updateOne({ sessionId: req.authSessionId, userId: actor._id, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
    if (active.matchedCount !== 1) throw accountChanged();
    const result = await work(session, actor);
    // Preserve the same authority through the final commit, including natural
    // session expiry while an otherwise valid batch was being written.
    await lockActiveAccounts([ownerId], session, { ownerId, authVersion: req.auth?.payload?.av || 0 });
    if (!await User.collection.findOne({ _id: actor._id, role: 'director' }, { session, projection: { _id: 1 } }) ||
        !await AuthSession.collection.findOne({ sessionId: req.authSessionId, userId: actor._id, revokedAt: null, expiresAt: { $gt: new Date() } }, { session, projection: { _id: 1 } })) throw accountChanged();
    return result;
  }, { ownerId, authVersion: req.auth?.payload?.av || 0 });
}

module.exports = { verify, write, savedReview };
