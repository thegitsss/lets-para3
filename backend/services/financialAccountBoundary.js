const { Types } = require('mongoose');
const User = require('../models/User');
const { findActiveSession } = require('./authSessionService');
const valid = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
function denied() { throw Object.assign(new Error('This financial view is no longer available to the signed-in account.'), { status: 403, statusCode: 403, code: 'FINANCIAL_ACCOUNT_CHANGED', publicCode: 'FINANCIAL_ACCOUNT_CHANGED' }); }
async function read(req, role, expectedOwnerId) {
  const ownerId = String(req.user?.id || req.user?._id || '');
  if (!['paralegal', 'admin', 'director'].includes(role) || !valid(ownerId) || expectedOwnerId !== undefined && expectedOwnerId !== ownerId || req.user?.role !== role) denied();
  const user = await User.collection.findOne({ _id: new Types.ObjectId(ownerId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.role !== role || user.status !== 'approved' || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, ownerId)) denied();
  return user;
}
module.exports = { read };
