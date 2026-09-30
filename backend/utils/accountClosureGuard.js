const crypto = require('crypto');
const User = require('../models/User');
const accountWriteGuard = require('./accountWriteGuard');

const PURPOSE = 'lpc:account-closure:result:v1';
const AUDIENCE = '/api/account/deactivate-result';
const PROOF_LIFETIME_MS = 10 * 60 * 1000;
const error = (status, code, message) => new accountWriteGuard.AccountWriteError(status, code, message);
const invalidProof = () => error(400, 'ACCOUNT_CLOSURE_PROOF_INVALID', 'This account check is unavailable. Review account closure again.');
const changed = () => error(403, 'ACCOUNT_CHANGED', 'Your signed-in account changed. Check the current account before continuing.');
const conflict = () => error(409, 'ACCOUNT_CONFLICT', 'Account closure changed. Review the current information before continuing.');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function privateResponse(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.vary('Cookie');
  res.vary('X-LPC-Closure-Proof');
  next();
}

function owner(req, input = req.body || {}) {
  for (const key of Object.keys(input)) {
    if (['expectedOwnerId', 'expectedClosureRevision', 'resultProof'].some(name => key.startsWith(`${name}.`) || key.startsWith(`${name}[`))) {
      throw accountWriteGuard.invalid();
    }
  }
  const guarded = accountWriteGuard.checkOwner(req, input);
  if (!guarded && (input.expectedClosureRevision !== undefined || input.resultProof !== undefined)) throw accountWriteGuard.invalid();
  return guarded;
}

function credential(req) {
  if (typeof req.auth?.token === 'string') return req.auth.token;
  const cookie = req.cookies?.token || req.cookies?.[process.env.JWT_COOKIE_NAME || 'access'];
  if (typeof cookie === 'string' && cookie) return cookie;
  const authorization = req.headers?.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function credentialHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function key() {
  const configured = String(process.env.DATA_ENCRYPTION_KEY || '');
  if (!/^[a-f0-9]{64}$/i.test(configured)) throw error(503, 'ACCOUNT_CLOSURE_UNAVAILABLE', 'Account closure is temporarily unavailable. Try again.');
  return Buffer.from(configured, 'hex');
}

function sign(value) {
  return crypto.createHmac('sha256', key()).update(`${PURPOSE}\0${value}`).digest('hex');
}

function issue(req, revision, now = Date.now()) {
  const token = credential(req);
  if (!token || !hash(revision) || !/^[a-f0-9]{24}$/.test(String(req.user?.id || '')) || !['attorney', 'paralegal'].includes(req.user?.role)) throw accountWriteGuard.invalid();
  const payload = {
    purpose: PURPOSE,
    audience: AUDIENCE,
    ownerId: String(req.user.id),
    role: req.user.role,
    credentialHash: credentialHash(token),
    revision,
    issuedAt: now,
    expiresAt: now + PROOF_LIFETIME_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {resultProof: `${encoded}.${sign(encoded)}`, proofExpiresAt: new Date(payload.expiresAt).toISOString()};
}

function proof(req, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)) throw invalidProof();
  const [encoded, signature] = value.split('.');
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(encoded), 'hex'))) throw invalidProof();
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw invalidProof(); }
  const fields = ['purpose', 'audience', 'ownerId', 'role', 'credentialHash', 'revision', 'issuedAt', 'expiresAt'];
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' || Object.keys(payload).length !== fields.length || Object.keys(payload).some(name => !fields.includes(name)) ||
      payload.purpose !== PURPOSE || payload.audience !== AUDIENCE || typeof payload.ownerId !== 'string' || !/^[a-f0-9]{24}$/.test(payload.ownerId) ||
      !['attorney', 'paralegal'].includes(payload.role) || !hash(payload.credentialHash) || !hash(payload.revision) ||
      !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt - payload.issuedAt !== PROOF_LIFETIME_MS || payload.issuedAt > now) throw invalidProof();
  if (now >= payload.expiresAt) throw error(410, 'ACCOUNT_CLOSURE_PROOF_EXPIRED', 'This account check expired. Sign in to review the current account.');
  const current = credential(req);
  // An absent credential is permitted by this purpose-limited capability.
  // A different present credential must not disclose the previous account.
  if (current && credentialHash(current) !== payload.credentialHash) throw changed();
  return payload;
}

function prepare(req) {
  if (!owner(req)) return null;
  if (!hash(req.body.expectedClosureRevision) || typeof req.body.resultProof !== 'string') throw accountWriteGuard.invalid();
  const payload = proof(req, req.body.resultProof);
  if (payload.ownerId !== String(req.user.id) || payload.role !== req.user.role) throw changed();
  if (payload.revision !== req.body.expectedClosureRevision) throw conflict();
  return {expectedOwnerId:payload.ownerId,expectedClosureRevision:payload.revision,authSessionId:String(req.authSessionId || ''),authVersion:Number(req.auth?.payload?.av || 0)};
}

async function result(req) {
  if (Object.keys(req.query || {}).length) throw invalidProof();
  const payload = proof(req, req.headers['x-lpc-closure-proof']);
  const user = await User.findById(payload.ownerId).select('_id role status disabled deleted').lean();
  if (!user || user.role !== payload.role) return {state:'unavailable'};
  if (user.deleted === true && user.disabled === true) return {state:'deactivated'};
  if (!user.deleted && !user.disabled && user.status === 'approved') return {state:'active'};
  return {state:'unavailable'};
}

module.exports = {PROOF_LIFETIME_MS, privateResponse, owner, issue, proof, prepare, result};
