const WORKSPACE_PRESENCE_TTL_MS = Math.max(
  15000,
  parseInt(process.env.WORKSPACE_PRESENCE_TTL_MS, 10) || 45000
);

const presenceByUser = new Map();

function buildUserKey(userId) {
  return String(userId || "").trim();
}

function buildCaseKey(caseId) {
  return String(caseId || "").trim();
}

function pruneExpiredEntries(userKey, now = Date.now()) {
  const entries = presenceByUser.get(userKey);
  if (!entries) return;
  for (const [caseKey, expiresAt] of entries.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      entries.delete(caseKey);
    }
  }
  if (!entries.size) {
    presenceByUser.delete(userKey);
  }
}

function markWorkspacePresence(userId, caseId) {
  const userKey = buildUserKey(userId);
  const caseKey = buildCaseKey(caseId);
  if (!userKey || !caseKey) return false;
  const now = Date.now();
  pruneExpiredEntries(userKey, now);
  const entries = presenceByUser.get(userKey) || new Map();
  entries.set(caseKey, now + WORKSPACE_PRESENCE_TTL_MS);
  presenceByUser.set(userKey, entries);
  return true;
}

function clearWorkspacePresence(userId, caseId = null) {
  const userKey = buildUserKey(userId);
  if (!userKey) return false;
  if (!caseId) {
    return presenceByUser.delete(userKey);
  }
  const caseKey = buildCaseKey(caseId);
  const entries = presenceByUser.get(userKey);
  if (!entries) return false;
  const deleted = entries.delete(caseKey);
  if (!entries.size) {
    presenceByUser.delete(userKey);
  }
  return deleted;
}

function isWorkspacePresenceActive(userId, caseId) {
  const userKey = buildUserKey(userId);
  const caseKey = buildCaseKey(caseId);
  if (!userKey || !caseKey) return false;
  const now = Date.now();
  pruneExpiredEntries(userKey, now);
  const entries = presenceByUser.get(userKey);
  if (!entries) return false;
  const expiresAt = entries.get(caseKey);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    entries.delete(caseKey);
    if (!entries.size) presenceByUser.delete(userKey);
    return false;
  }
  return true;
}

function resetWorkspacePresence() {
  presenceByUser.clear();
}

module.exports = {
  WORKSPACE_PRESENCE_TTL_MS,
  markWorkspacePresence,
  clearWorkspacePresence,
  isWorkspacePresenceActive,
  resetWorkspacePresence,
};
