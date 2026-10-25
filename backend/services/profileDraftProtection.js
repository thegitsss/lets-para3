const { encryptString, decryptString, isEncryptionEnabled, isEncrypted } = require('../utils/dataEncryption');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 512000;
function invalid() { return Object.assign(new Error('Profile draft unavailable. Keep this page open to retain unsaved changes.'), { status: 400 }); }
function requireEncryption() {
  if (!isEncryptionEnabled()) throw Object.assign(new Error('Protected draft recovery is temporarily unavailable.'), { status: 503 });
}
function seal(ownerId, draft, now = Date.now()) {
  requireEncryption();
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !draft.profile || typeof draft.profile !== 'object' || Array.isArray(draft.profile) || !Array.isArray(draft.fields)) throw invalid();
  const serialized = JSON.stringify({ purpose: 'paralegal-profile-draft-v2', ownerId: String(ownerId), issuedAt: now, draft });
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw invalid();
  return encryptString(serialized, { plaintext: true });
}
function open(ownerId, capsule, now = Date.now()) {
  requireEncryption();
  if (typeof capsule !== 'string' || capsule.length > 700000 || !isEncrypted(capsule)) throw invalid();
  let envelope;
  try { envelope = JSON.parse(decryptString(capsule)); } catch { throw invalid(); }
  const age = now - envelope.issuedAt;
  if (envelope.purpose !== 'paralegal-profile-draft-v2' || envelope.ownerId !== String(ownerId) || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) throw invalid();
  return envelope.draft;
}
module.exports = { seal, open, MAX_AGE_MS, MAX_BYTES };
