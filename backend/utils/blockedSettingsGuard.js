const { reportOperationalFailure } = require("./operationalFailure");
const crypto = require('crypto');
const mongoose = require('mongoose');
const Block = require('../models/Block');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const accountGuard = require('./accountWriteGuard');
const PAGE_SIZE = 50;
const error = (status, code, message) => new accountGuard.AccountWriteError(status, code, message);
const conflict = () => error(409, 'ACCOUNT_CONFLICT', 'This block changed. Refresh blocked users before continuing.');
const ownerChanged = () => error(403, 'ACCOUNT_CHANGED', 'Your signed-in account changed. Sign in again before continuing.');
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
function owner(req, input = req.body || {}) {
  if (Object.keys(input).some(key => /^(?:expectedOwnerId|expectedBlockRevision)(?:\.|\[)/.test(key))) {
    throw accountGuard.invalid();
  }
  return accountGuard.checkOwner(req, input);
}
function sign(value) {
  const key = String(process.env.DATA_ENCRYPTION_KEY || '');
  if (!/^[a-f0-9]{64}$/i.test(key)) throw error(503, 'BLOCKS_UNAVAILABLE', 'Blocked users are temporarily unavailable.');
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(value).digest('hex');
}
const fields = [
  'blockerId', 'blockedId', 'active', 'createdAt', 'updatedAt',
  'deactivatedAt', '__v', 'reason', 'sourceType', 'sourceCaseId',
  'sourceDisputeId', 'blockerRole', 'blockedRole',
];
function revision(record) {
  return sign(JSON.stringify([
    'blocked-settings-v1',
    ...fields.map(key => [key, Object.hasOwn(record, key) ? record[key] : null]),
  ]));
}
function filter(record) {
  return {
    _id: record._id,
    $and: fields.map(key => Object.hasOwn(record, key)
      ? { [key]: { $eq: record[key], $exists: true } }
      : { [key]: { $exists: false } }),
  };
}
function cursorFor(record, ownerId) {
  const value = Buffer.from(JSON.stringify({
    v: 1,
    ownerId: String(ownerId),
    at: record.createdAt ? new Date(record.createdAt).toISOString() : null,
    id: String(record._id),
  })).toString('base64url');
  return `${value}.${sign(`block-page-v1:${value}`)}`;
}
function cursorFilter(value, ownerId) {
  if (typeof value !== 'string' || !value || value.length > 1000) throw accountGuard.invalid();
  const parts = value.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) {
    throw accountGuard.invalid();
  }
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(sign(`block-page-v1:${parts[0]}`)))) {
    throw accountGuard.invalid();
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  } catch {
    throw accountGuard.invalid();
  }
  if (payload?.v !== 1 || payload.ownerId !== String(ownerId) || !validId(payload.id)
      || payload.at !== null && (typeof payload.at !== 'string' || !Number.isFinite(new Date(payload.at).getTime()))) {
    throw accountGuard.invalid();
  }
  const id = new mongoose.Types.ObjectId(payload.id);
  return payload.at === null
    ? { createdAt: null, _id: { $lt: id } }
    : { $or: [
      { createdAt: { $lt: new Date(payload.at) } },
      { createdAt: null },
      { createdAt: new Date(payload.at), _id: { $lt: id } },
    ] };
}
async function page(ownerId, cursor) {
  const base = { blockerId: ownerId, active: { $ne: false } };
  const boundary = cursor ? cursorFilter(cursor, ownerId) : {};
  const [records, total] = await Promise.all([
    Block.find({ ...base, ...boundary }).sort({ createdAt: -1, _id: -1 }).limit(PAGE_SIZE + 1).lean(),
    Block.countDocuments(base),
  ]);
  const visible = records.slice(0, PAGE_SIZE);
  const users = await User.find({ _id: { $in: visible.map(record => record.blockedId) } })
    .select('firstName lastName role').lean();
  const names = new Map(users.map(user => [String(user._id), user]));
  const items = visible.map(record => {
    const user = names.get(String(record.blockedId));
    return {
      blockedId: String(record.blockedId),
      name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'LPC member' : 'Account unavailable',
      role: user?.role || record.blockedRole || '',
      reason: record.reason || '',
      sourceType: record.sourceType || '',
      sourceCaseId: record.sourceCaseId ? String(record.sourceCaseId) : '',
      sourceDisputeId: record.sourceDisputeId || '',
      createdAt: record.createdAt || null,
      revision: revision(record),
    };
  });
  return { items, total, nextCursor: records.length > PAGE_SIZE ? cursorFor(visible.at(-1), ownerId) : null };
}
async function status(ownerId, blockedId) {
  const record = await Block.findOne({ blockerId: ownerId, blockedId, active: { $ne: false } }).lean();
  return { blockedId: String(blockedId), blocked: Boolean(record), revision: record ? revision(record) : null };
}
async function remove(req, blockedId) {
  if (typeof req.body?.expectedBlockRevision !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.expectedBlockRevision)) {
    throw accountGuard.invalid();
  }
  const record = await Block.findOne({ blockerId: req.user.id, blockedId, active: { $ne: false } }).lean();
  if (!record || revision(record) !== req.body.expectedBlockRevision) throw conflict();
  const user = await User.findById(req.user.id).select('role status disabled deleted +authVersion');
  if (!user || user.role !== req.user.role || user.status !== 'approved' || user.disabled || user.deleted
      || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0)) {
    throw ownerChanged();
  }
  const session = await User.db.startSession();
  try {
    session.startTransaction();
    if (req.authSessionId) {
      const active = await AuthSession.updateOne({
        userId: user._id, sessionId: req.authSessionId, revokedAt: null, expiresAt: { $gt: new Date() },
      }, { $set: { lastSeenAt: new Date() } }, { session });
      if (!active.matchedCount) throw ownerChanged();
    }
    const account = await User.collection.updateOne(
      accountGuard.captureFilter(user, ['authVersion']), { $inc: { __v: 1 } }, { session },
    );
    if (!account.matchedCount) throw ownerChanged();
    const result = await Block.collection.updateOne(filter(record), {
      $set: { active: false, deactivatedAt: new Date(), updatedAt: new Date() }, $inc: { __v: 1 },
    }, { session });
    if (!result.matchedCount) throw conflict();
    await session.commitTransaction();
    return record;
  } catch (failure) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("utils.blockedSettingsGuard.transaction_abort"));
    if (failure?.hasErrorLabel?.('UnknownTransactionCommitResult')) {
      throw error(503, 'BLOCK_CHANGE_UNCONFIRMED', 'The unblock result could not be confirmed. Check blocked users before trying again.');
    }
    if (failure?.code === 112 || failure?.hasErrorLabel?.('TransientTransactionError')) throw conflict();
    throw failure;
  } finally {
    await session.endSession();
  }
}
module.exports = { owner, validId, page, status, remove, revision, conflict };
