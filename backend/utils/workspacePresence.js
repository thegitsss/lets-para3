const { Types, isValidObjectId } = require("mongoose");
const WorkspacePresence = require("../models/WorkspacePresence");
const { createLogger } = require("./logger");
const logger = createLogger("workspace-presence");
const WORKSPACE_PRESENCE_TTL_MS = Math.max(15000, parseInt(process.env.WORKSPACE_PRESENCE_TTL_MS, 10) || 45000);
// Retain closed revisions beyond the application's request timeout so delayed
// heartbeats cannot resurrect a tab that already left. These hints also expire.
const CLOSED_PRESENCE_TTL_MS = Math.max(600000, WORKSPACE_PRESENCE_TTL_MS * 2);
const surfaceKey = value => String(value || "workspace").trim().toLowerCase() || "workspace";
const objectId = value => isValidObjectId(value) ? new Types.ObjectId(String(value)) : null;

function parseWorkspacePresenceLease(value = {}) {
  const { presenceId, revision } = value || {};
  if (presenceId === undefined && revision === undefined) return null;
  if (typeof presenceId !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(presenceId) || !Number.isSafeInteger(revision) || revision < 1) {
    throw Object.assign(new Error("Invalid workspace presence lease"), { code: "INVALID_WORKSPACE_PRESENCE" });
  }
  return { presenceId: presenceId.toLowerCase(), revision };
}

async function writePresence(userId, caseId, surface, active, lease) {
  const user = objectId(userId), matter = objectId(caseId);
  if (!user || (active && !matter)) return false;
  const client = parseWorkspacePresenceLease(lease);
  const normalizedSurface = surfaceKey(surface), now = new Date();
  const leaseKey = client ? "client:" + client.presenceId : "legacy:" + matter + ":" + normalizedSurface;
  const key = user + ":" + leaseKey, revision = client?.revision || now.getTime();
  const values = {
    userId: user, caseId: matter, surface: normalizedSurface, legacy: !client,
    revision, active, updatedAt: now,
    expiresAt: new Date(now.getTime() + (active ? WORKSPACE_PRESENCE_TTL_MS : CLOSED_PRESENCE_TTL_MS)),
  };
  const newer = { $gt: [revision, { $ifNull: ["$revision", 0] }] };
  const update = [{ $set: Object.fromEntries(Object.entries(values).map(([field, value]) => [
    field, { $cond: [newer, { $literal: value }, "$" + field] },
  ])) }];
  const write = () => WorkspacePresence.updateOne({ _id: key }, update, { upsert: true, updatePipeline: true });
  let result;
  try { result = await write(); }
  catch (error) {
    if (error.code !== 11000) throw error;
    // Concurrent first writes may race the unique _id upsert. Re-evaluate the
    // same monotonic update against the winner, without overwriting newer state.
    result = await write();
  }
  if (!result.acknowledged) throw new Error("Unconfirmed workspace presence write");
  return true;
}

async function markWorkspacePresence(userId, caseId, surface = "workspace", lease = null) {
  return writePresence(userId, caseId, surface, true, lease);
}

async function clearWorkspacePresence(userId, caseId = null, surface = null, lease = null) {
  const user = objectId(userId);
  if (!user) return false;
  const client = parseWorkspacePresenceLease(lease);
  if (client) return writePresence(userId, caseId, surface, false, client);
  // Older cached clients can clear only their own legacy hints, never the leases
  // owned by newer tabs. Current clients always supply a browser-context lease.
  const result = await WorkspacePresence.deleteMany({ userId: user, legacy: true,
    ...(caseId ? { caseId: objectId(caseId) } : {}), ...(surface ? { surface: surfaceKey(surface) } : {}),
  });
  if (!result.acknowledged) throw new Error("Unconfirmed workspace presence clear");
  return true;
}

async function isWorkspacePresenceActive(userId, caseId, surface = null) {
  const user = objectId(userId), matter = objectId(caseId);
  if (!user || !matter) return false;
  try {
    return Boolean(await WorkspacePresence.exists({ userId: user, caseId: matter, active: true,
      expiresAt: { $gt: new Date() },
      ...(surface ? { surface: { $in: ["workspace", surfaceKey(surface)] } } : {}),
    }));
  } catch (error) {
    // Unknown presence must not suppress a notification. The write endpoints
    // still fail explicitly so clients can retry their unconfirmed heartbeat.
    logger.warn("Presence unavailable; notification delivery remains enabled.", { error: error.name });
    return false;
  }
}

async function resetWorkspacePresence() {
  await WorkspacePresence.deleteMany({});
}

module.exports = { WORKSPACE_PRESENCE_TTL_MS, CLOSED_PRESENCE_TTL_MS, parseWorkspacePresenceLease,
  markWorkspacePresence, clearWorkspacePresence, isWorkspacePresenceActive, resetWorkspacePresence };
