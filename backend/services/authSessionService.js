const crypto = require("crypto");
const AuthSession = require("../models/AuthSession");
const { withActiveAccountWrite } = require("../utils/activeAccountWrite");

const ACCESS_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function requestIp(req = {}) {
  return String(req.ip || req.socket?.remoteAddress || "").slice(0, 128);
}

async function createAuthSession(user, req, { ttlMs = ACCESS_SESSION_TTL_MS } = {}) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  const ownerId = user._id || user.id;
  return withActiveAccountWrite([ownerId], async session => {
  await AuthSession.create([{
    userId: user._id || user.id,
    sessionId,
    userAgent: String(req?.get?.("user-agent") || req?.headers?.["user-agent"] || "").slice(0, 1000),
    ip: requestIp(req),
    expiresAt,
  }], { session });
  return { sessionId, expiresAt };
  }, { ownerId, authVersion: user.authVersion, requireApproved: false });
}

async function findActiveSession(sessionId, userId) {
  if (!sessionId || !userId) return null;
  const session = await AuthSession.findOne({
    sessionId: String(sessionId),
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (session && Date.now() - new Date(session.lastSeenAt || session.createdAt).getTime() >= 5 * 60 * 1000) {
    await AuthSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { lastSeenAt: new Date() } });
  }
  return session;
}

async function revokeSession(sessionId, userId, reason = "logout", { session = null } = {}) {
  if (!sessionId || !userId) return false;
  const result = await AuthSession.updateOne(
    { sessionId: String(sessionId), userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: String(reason).slice(0, 100) } },
    ...(session ? [{ session }] : [])
  );
  return result.modifiedCount > 0;
}

async function revokeAllUserSessions(userId, reason = "security_change", { exceptSessionId = "", session = null } = {}) {
  if (!userId) return 0;
  const filter = { userId, revokedAt: null };
  if (exceptSessionId) filter.sessionId = { $ne: String(exceptSessionId) };
  const result = await AuthSession.updateMany(filter, {
    $set: { revokedAt: new Date(), revokedReason: String(reason).slice(0, 100) },
  }, ...(session ? [{ session }] : []));
  return result.modifiedCount;
}

async function listActiveSessions(userId) {
  if (!userId) return [];
  return AuthSession.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1, createdAt: -1 })
    .limit(50)
    .lean();
}

async function pageActiveSessions(userId, { cursor, currentSessionId = "" } = {}) {
  const guard = require("../utils/accountSecurityGuard");
  const account = String(userId);
  const invalid = () => guard.error(400, "SECURITY_CURSOR_INVALID", "Refresh the session list before loading more sessions.");
  let after = null;
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(cursor)) throw invalid();
    const [encoded, signature] = cursor.split(".");
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(guard.sign(`security-sessions:${encoded}`), "hex"))) throw invalid();
    try { after = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw invalid(); }
    if (after?.v !== 1 || after.owner !== account || !/^[a-f0-9]{24}$/.test(after.id || "") || !(after.at === null || Number.isSafeInteger(after.at) && Math.abs(after.at) <= 8640000000000000)) throw invalid();
  }
  const now = new Date();
  const active = { userId, revokedAt: null, expiresAt: { $gt: now } };
  const boundary = !after ? {} : after.at === null
    ? { createdAt: null, _id: { $lt: after.id } }
    : { $or: [{ createdAt: { $lt: new Date(after.at) } }, { createdAt: new Date(after.at), _id: { $lt: after.id } }, { createdAt: null }] };
  const [rows, currentSession, total] = await Promise.all([
    AuthSession.find({ ...active, ...boundary }).sort({ createdAt: -1, _id: -1 }).limit(51).lean(),
    currentSessionId ? AuthSession.findOne({ ...active, sessionId: currentSessionId }).lean() : null,
    AuthSession.countDocuments(active),
  ]);
  const sessions = rows.slice(0, 50);
  let nextCursor = null;
  if (rows.length > 50) {
    const last = sessions.at(-1);
    const encoded = Buffer.from(JSON.stringify({ v: 1, owner: account, id: String(last._id), at: last.createdAt == null ? null : new Date(last.createdAt).getTime() })).toString("base64url");
    nextCursor = `${encoded}.${guard.sign(`security-sessions:${encoded}`)}`;
  }
  return { sessions, currentSession, total, nextCursor };
}

module.exports = {
  ACCESS_SESSION_TTL_MS,
  createAuthSession,
  findActiveSession,
  listActiveSessions,
  pageActiveSessions,
  revokeAllUserSessions,
  revokeSession,
};
