const crypto = require("crypto");
const AuthSession = require("../models/AuthSession");

const ACCESS_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function requestIp(req = {}) {
  return String(req.ip || req.socket?.remoteAddress || "").slice(0, 128);
}

async function createAuthSession(user, req, { ttlMs = ACCESS_SESSION_TTL_MS } = {}) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  await AuthSession.create({
    userId: user._id || user.id,
    sessionId,
    userAgent: String(req?.get?.("user-agent") || req?.headers?.["user-agent"] || "").slice(0, 1000),
    ip: requestIp(req),
    expiresAt,
  });
  return { sessionId, expiresAt };
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

async function revokeSession(sessionId, userId, reason = "logout") {
  if (!sessionId || !userId) return false;
  const result = await AuthSession.updateOne(
    { sessionId: String(sessionId), userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: String(reason).slice(0, 100) } }
  );
  return result.modifiedCount > 0;
}

async function revokeAllUserSessions(userId, reason = "security_change", { exceptSessionId = "" } = {}) {
  if (!userId) return 0;
  const filter = { userId, revokedAt: null };
  if (exceptSessionId) filter.sessionId = { $ne: String(exceptSessionId) };
  const result = await AuthSession.updateMany(filter, {
    $set: { revokedAt: new Date(), revokedReason: String(reason).slice(0, 100) },
  });
  return result.modifiedCount;
}

async function listActiveSessions(userId) {
  if (!userId) return [];
  return AuthSession.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1, createdAt: -1 })
    .limit(50)
    .lean();
}

module.exports = {
  ACCESS_SESSION_TTL_MS,
  createAuthSession,
  findActiveSession,
  listActiveSessions,
  revokeAllUserSessions,
  revokeSession,
};
