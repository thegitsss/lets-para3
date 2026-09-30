const crypto = require('crypto');
const PHOTO_FIELDS = Object.freeze(['avatarURL', 'profileImage', 'profileImageKey', 'profileImageOriginal', 'profileImageOriginalKey', 'pendingProfileImage', 'pendingProfileImageKey', 'pendingProfileImageOriginal', 'pendingProfileImageOriginalKey', 'profilePhotoStatus']);
class AccountWriteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = () => new AccountWriteError(400, 'ACCOUNT_GUARD_INVALID', 'Refresh this account before saving these changes.');
const conflict = () => new AccountWriteError(409, 'ACCOUNT_CONFLICT', 'This information changed in another session. Review the latest values before saving.');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (value && typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function valueAt(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function photoRevision(user) {
  const source = user?.toObject ? user.toObject({ getters: false, virtuals: false }) : user || {};
  return crypto.createHash('sha256').update(JSON.stringify(PHOTO_FIELDS.map(path => String(valueAt(source, path) || '')))).digest('hex');
}
function checkOwner(req, input = req.body || {}) {
  if (!Object.hasOwn(input, 'expectedOwnerId')) return false;
  const owner = typeof input.expectedOwnerId === 'string' ? input.expectedOwnerId.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{24}$/.test(owner)) throw invalid();
  if (owner !== String(req.user?.id || req.user?._id || '').toLowerCase()) throw new AccountWriteError(403, 'ACCOUNT_CHANGED', 'Your signed-in account changed. Verify the account before continuing.');
  return true;
}
function photoGuard(req, user, input = req.body || {}) {
  const guarded = checkOwner(req, input);
  if (!guarded) { if (input.expectedPhotoRevision !== undefined) throw invalid(); return false; }
  if (!/^[a-f0-9]{64}$/.test(input.expectedPhotoRevision || '')) throw invalid();
  if (input.expectedPhotoRevision !== photoRevision(user)) throw conflict();
  return true;
}
function captureFilter(user, paths) {
  const source = user.toObject({ getters: false, virtuals: false, minimize: false });
  const clauses = [];
  for (const path of [...new Set(paths)]) {
    const segments = path.split('.');
    let current = user;
    let defaulted = segments.some((_, index) => user.$isDefault(segments.slice(0, index + 1).join('.')));
    for (const segment of segments) {
      if (current?.$isDefault?.(segment)) defaulted = true;
      current = current?.get ? current.get(segment) : current?.[segment];
    }
    const value = defaulted ? undefined : valueAt(source, path);
    clauses.push(value === undefined ? { [path]: { $exists: false } } : { [path]: { $eq: value, $exists: true } });
  }
  return { _id: user._id, role: user.role, status: 'approved', disabled: { $ne: true }, deleted: { $ne: true }, ...(clauses.length ? { $and: clauses } : {}) };
}
function prepareWrite(req, user, { fields, current, photo = false, dependencies = {} }) {
  const body = req.body || {};
  const guarded = checkOwner(req, body);
  if (!guarded) {
    if (body.expectedValues !== undefined || body.expectedPhotoRevision !== undefined) throw invalid();
    return null;
  }
  if (!plain(body.expectedValues)) throw invalid();
  const comparisons = { ...fields, ...dependencies };
  if (Object.keys(body.expectedValues).some(key => !Object.hasOwn(comparisons, key))) throw invalid();
  for (const key of Object.keys(comparisons)) {
    if (!Object.hasOwn(body.expectedValues, key)) throw invalid();
    if (!same(body.expectedValues[key], current[key])) throw conflict();
  }
  if (photo) photoGuard(req, user);
  return captureFilter(user, [...Object.values(comparisons).flat(), ...(photo ? PHOTO_FIELDS : [])]);
}
async function saveFields(User, user, paths, filter) {
  try { await user.validate(); } catch (error) {
    if (error?.name === 'ValidationError') throw new AccountWriteError(400, 'ACCOUNT_VALIDATION', 'Check the profile fields before saving.');
    throw error;
  }
  const updates = {};
  for (const path of [...new Set(paths)]) {
    const value = user.get(path);
    if (value !== undefined) updates[path] = value?.toObject ? value.toObject() : value;
  }
  updates.updatedAt = new Date();
  const result = await User.collection.updateOne(filter, { $set: updates });
  if (!result.matchedCount) throw conflict();
  return User.findById(user._id).select('+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey');
}
function respond(error, res) {
  if (!(error instanceof AccountWriteError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code }); return true;
}
module.exports = { AccountWriteError, PHOTO_FIELDS, checkOwner, photoGuard, photoRevision, prepareWrite, captureFilter, saveFields, respond, invalid, conflict };
