const User = require('../models/User');
const account = require('./accountWriteGuard');
const { extractPersonalFileKey } = require('./personalFileReference');
const TYPES = Object.freeze({ resumeURL: 'resume', certificateURL: 'certificate', writingSampleURL: 'writingSample' });
function keyOf(user, field) {
  if (!Object.hasOwn(TYPES, field)) throw account.invalid();
  return extractPersonalFileKey(user?.[field], { ownerId: user?._id || user?.id, type: TYPES[field], bucket: process.env.S3_BUCKET, region: process.env.S3_REGION, cdnBase: process.env.S3_CDN_BASE_URL });
}
function prepare(req, user, field) {
  const body = req.body || {};
  if (!account.checkOwner(req, body)) {
    if (body.expectedDocumentKey !== undefined) throw account.invalid();
    return null;
  }
  if (typeof body.expectedDocumentKey !== 'string' || body.expectedDocumentKey.length > 500) throw account.invalid();
  if (body.expectedDocumentKey !== keyOf(user, field)) throw account.conflict();
  return account.captureFilter(user, [field]);
}
async function checkCurrentRead(req, key) {
  const query = req.query || {};
  account.checkOwner(req, query);
  if (query.documentField === undefined && query.expectedDocumentKey === undefined) return;
  if (!query.expectedOwnerId || !Object.hasOwn(TYPES, query.documentField) || typeof query.expectedDocumentKey !== 'string' || query.expectedDocumentKey !== key) throw account.invalid();
  const user = await User.findById(req.user.id || req.user._id).select('_id resumeURL certificateURL writingSampleURL');
  if (!user || keyOf(user, query.documentField) !== key) throw account.conflict();
}
module.exports = { TYPES, keyOf, prepare, checkCurrentRead };
