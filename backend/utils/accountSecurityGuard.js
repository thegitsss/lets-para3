const { reportOperationalFailure } = require("./operationalFailure");
const crypto = require("crypto");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const PasskeyCredential = require("../models/PasskeyCredential");
const accountWriteGuard = require("./accountWriteGuard");

// Profile edits and normal passkey use do not change this security snapshot.
// Passwords, recovery material and credential membership do. No secret or
// password-derived unkeyed digest is sent to the browser.
const SECURITY_FIELDS = Object.freeze([
  "password", "authVersion", "emailVerified", "twoFactorEnabled",
  "twoFactorMethod", "twoFactorBackupCodes", "totpSecretEncrypted",
]);
const USER_SELECTION = "email firstName lastName role status disabled deleted emailVerified twoFactorEnabled twoFactorMethod +password +authVersion +twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep";
const error = (status, code, message) => new accountWriteGuard.AccountWriteError(status, code, message);
const conflict = () => error(409, "ACCOUNT_CONFLICT", "Security settings changed. Check the current settings before continuing.");
const sessionRequired = () => error(409, "SECURITY_SESSION_REQUIRED", "Sign in again before changing security settings so this session can be kept active.");
function signingKey() {
  const configured = String(process.env.DATA_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(configured)) throw error(503, "SECURITY_UNAVAILABLE", "Security settings are temporarily unavailable.");
  return Buffer.from(configured, "hex");
}
function sign(value) { return crypto.createHmac("sha256", signingKey()).update(value).digest("hex"); }
async function credentials(userId, session = null) {
  const query = PasskeyCredential.find({ userId }).select("_id credentialId").sort({ _id: 1 });
  if (session) query.session(session);
  return (await query.lean()).map(item => [String(item._id), String(item.credentialId)]);
}
async function snapshot(userId) {
  const user = await User.findById(userId).select(USER_SELECTION);
  if (!user) throw error(404, "SECURITY_ACCOUNT_UNAVAILABLE", "Account not found.");
  const passkeys = await credentials(user._id);
  const revision = sign(JSON.stringify(["account-security-v1", String(user._id), ...SECURITY_FIELDS.map(field => [field, user.get(field) ?? null]), ["passkeys", passkeys]]));
  return { user, passkeys, revision };
}
function owner(req, input = req.body || {}) {
  if (input && Object.keys(input).some(key => key !== "expectedOwnerId" && key.startsWith("expectedOwnerId["))) throw accountWriteGuard.invalid();
  return accountWriteGuard.checkOwner(req, input);
}
function prepare(req, state, { requireManaged = false, revision = true } = {}) {
  const guarded = owner(req);
  if (!guarded && req.body?.expectedSecurityRevision !== undefined) throw accountWriteGuard.invalid();
  if (guarded && revision) {
    if (!/^[a-f0-9]{64}$/.test(req.body?.expectedSecurityRevision || "")) throw accountWriteGuard.invalid();
    if (req.body.expectedSecurityRevision !== state.revision) throw conflict();
  }
  if (guarded && requireManaged && !req.authSessionId) throw sessionRequired();
  const user = state.user;
  if (user.disabled || user.deleted || user.status !== "approved" || Number(req.auth?.payload?.av || 0) !== Number(user.authVersion || 0)) {
    throw error(403, "ACCOUNT_CHANGED", "Your signed-in account changed. Sign in again before continuing.");
  }
  return { ...state, guarded, filter: accountWriteGuard.captureFilter(user, SECURITY_FIELDS) };
}
function context(req, state) {
  return { sessionId: String(req.authSessionId || ""), securityRevision: state.revision };
}
function assertChallenge(req, state, challenge) {
  const expected = challenge?.metadata?.securityContext;
  if (!expected) { if (state.guarded) throw conflict(); return; }
  const current = context(req, state);
  if (expected.sessionId !== current.sessionId || expected.securityRevision !== current.securityRevision) throw conflict();
}
async function atomic(req, state, work) {
  const session = await User.db.startSession();
  try {
    session.startTransaction();
    // Touch the initiating session in the same transaction as the security
    // write. Concurrent revocation cannot pass a separate preflight check and
    // still allow the credential/recovery change to commit.
    if (req.authSessionId) {
      const active = await AuthSession.updateOne({ userId: state.user._id, sessionId: req.authSessionId, revokedAt: null, expiresAt: { $gt: new Date() } }, { $set: { lastSeenAt: new Date() } }, { session });
      if (!active.matchedCount) throw error(403, "ACCOUNT_CHANGED", "This session expired. Sign in again before continuing.");
    }
    // Serialize security operations against the account even when the final
    // record is a separate passkey/challenge/session. Do not replace profile
    // fields or use the broad document version as the visible revision.
    const locked = await User.collection.updateOne(state.filter, { $inc: { __v: 1 } }, { session });
    if (!locked.matchedCount) throw conflict();
    const lockedVersion = await User.collection.findOne({ _id: state.user._id }, { projection: { __v: 1 }, session });
    state.user.set("__v", lockedVersion.__v);
    if (JSON.stringify(await credentials(state.user._id, session)) !== JSON.stringify(state.passkeys)) throw conflict();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (failure) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("utils.accountSecurityGuard.transaction_abort"));
    if (failure?.hasErrorLabel?.("UnknownTransactionCommitResult")) throw error(503, "SECURITY_CHANGE_UNCONFIRMED", "The security change could not be confirmed. Check the current settings before trying again.");
    if (failure?.name === "DocumentNotFoundError" || failure?.code === 112 || failure?.hasErrorLabel?.("TransientTransactionError")) throw conflict();
    throw failure;
  } finally { await session.endSession(); }
}
async function save(user, state, session) {
  user.$where = state.filter;
  // Keep normal password hashing/validation hooks, but an unrelated schema
  // hook must not save defaults for unselected profile/preferences fields.
  try { await user.save({ session, pathsToSave: [...SECURITY_FIELDS, "totpLastUsedTimeStep", "__v", "updatedAt"] }); }
  catch (failure) { if (failure?.name === "DocumentNotFoundError") throw conflict(); throw failure; }
}

module.exports = { SECURITY_FIELDS, USER_SELECTION, owner, snapshot, prepare, context, assertChallenge, atomic, save, sign, conflict, sessionRequired, error };
