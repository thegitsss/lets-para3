const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:notifications");
const express = require("express");
const crypto = require("crypto");
const { Types } = require("mongoose");
const Notification = require("../models/Notification");
const Case = require("../models/Case");
const Incident = require("../models/Incident");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const { addSubscriber, publishNotificationEvent } = require("../utils/notificationEvents");
const { getBlocksForUser, normalizeId } = require("../utils/blocks");
const {
  notificationCaseId,
  notificationIncidentPublicId,
  presentNotification,
} = require("../services/notificationPresentation");
const {
  markWorkspacePresence,
  clearWorkspacePresence,
  parseWorkspacePresenceLease,
} = require("../utils/workspacePresence");
const { protectMutations } = require("../utils/csrf");

const router = express.Router();

router.use(verifyToken, requireApproved);
router.use(protectMutations);
router.use((req, res, next) => {
  // Optional for existing callers. New clients bind initial reads and broad
  // mutations to the identity that initiated them, even if cookies changed.
  const expectedOwnerId = req.method === "GET" ? req.query.expectedOwnerId : req.body?.expectedOwnerId;
  if (expectedOwnerId === undefined) return next();
  if (typeof expectedOwnerId !== "string" || !/^[a-f\d]{24}$/i.test(expectedOwnerId)) {
    return res.status(400).json({ code: "INVALID_EXPECTED_OWNER", message: "Invalid expected account" });
  }
  if (expectedOwnerId.toLowerCase() !== String(req.user.id).toLowerCase()) {
    return res.status(403).json({ code: "ACCOUNT_CHANGED", message: "Your account changed. Refresh before continuing." });
  }
  return next();
});

async function canTrackWorkspacePresence(user, caseId) {
  if (!caseId) return false;
  if (String(user?.role || "").toLowerCase() === "admin") {
    const exists = await Case.exists({ _id: caseId });
    return !!exists;
  }
  const exists = await Case.exists({
    _id: caseId,
    $or: [
      { attorney: user.id },
      { attorneyId: user.id },
      { paralegal: user.id },
      { paralegalId: user.id },
    ],
  });
  return !!exists;
}

router.post("/workspace-presence", async (req, res) => {
  try {
    const caseId = String(req.body?.caseId || "").trim();
    const requestedSurface = String(req.body?.surface || "workspace").trim().toLowerCase();
    const allowedSurfaces = new Set(["workspace", "overview", "tasks", "messages", "files", "deadlines", "history"]);
    const surface = allowedSurfaces.has(requestedSurface) ? requestedSurface : "";
    if (!caseId) return res.status(400).json({ message: "caseId is required" });
    if (!/^[a-f\d]{24}$/i.test(caseId)) return res.status(400).json({ message: "Invalid Matter" });
    if (!surface) return res.status(400).json({ message: "Invalid workspace surface" });
    const lease = parseWorkspacePresenceLease(req.body);
    const allowed = await canTrackWorkspacePresence(req.user, caseId);
    if (!allowed) return res.status(404).json({ message: "Matter not found" });
    await markWorkspacePresence(req.user.id, caseId, surface, lease);
    return res.json({ success: true, caseId, surface });
  } catch (err) {
    if (err.code === "INVALID_WORKSPACE_PRESENCE") return res.status(400).json({ message: err.message });
    runtimeLogger.error("Failed to set workspace presence:", err);
    return res.status(500).json({ message: "Unable to update workspace presence" });
  }
});

router.delete("/workspace-presence", async (req, res) => {
  try {
    const caseId = String(req.body?.caseId || "").trim();
    const requestedSurface = String(req.body?.surface || "").trim().toLowerCase();
    const allowedSurfaces = new Set(["workspace", "overview", "tasks", "messages", "files", "deadlines", "history"]);
    const surface = requestedSurface && allowedSurfaces.has(requestedSurface) ? requestedSurface : null;
    if (requestedSurface && !surface) return res.status(400).json({ message: "Invalid workspace surface" });
    if (caseId && !/^[a-f\d]{24}$/i.test(caseId)) return res.status(400).json({ message: "Invalid Matter" });
    const lease = parseWorkspacePresenceLease(req.body);
    if (!caseId) {
      await clearWorkspacePresence(req.user.id, null, null, lease);
      return res.json({ success: true });
    }
    await clearWorkspacePresence(req.user.id, caseId, surface, lease);
    return res.json({ success: true, caseId, ...(surface ? { surface } : {}) });
  } catch (err) {
    if (err.code === "INVALID_WORKSPACE_PRESENCE") return res.status(400).json({ message: err.message });
    runtimeLogger.error("Failed to clear workspace presence:", err);
    return res.status(500).json({ message: "Unable to update workspace presence" });
  }
});

// SSE stream for live notifications
router.get("/stream", (req, res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
  }

  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  const unsubscribe = addSubscriber(req.user.id, res);
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      /* ignore */
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("error", cleanup);
});

// List and badge use the same current-access policy. Stale records remain in
// storage, but neither produce placeholder rows nor inflate the unread badge.
// Scan in bounded batches so stale records cannot crowd valid alerts out of
// the 100-item list, and the unread total remains exact beyond that window.
async function visibleNotifications(user, { unreadOnly = false, countOnly = false, limit = 100, after = null } = {}) {
  let position = {};
  if (after) {
    const olderId = { $lt: new Types.ObjectId(after.i) };
    position = after.t === null
      ? { createdAt: null, _id: olderId }
      : { $or: [
        { createdAt: { $lt: new Date(after.t) } },
        { createdAt: new Date(after.t), _id: olderId },
        // Mongo comparisons are type-bracketed. Date $lt alone would strand
        // retained null/missing dates, which sort after dated records.
        { createdAt: null },
      ] };
  }
  const query = {
    userId: user.id,
    $nor: [{ type: "message", actorUserId: user.id }],
    ...(unreadOnly ? { read: { $ne: true }, isRead: { $ne: true } } : {}),
    ...position,
  };
  const cursor = Notification.find(query).sort({ createdAt: -1, _id: -1 }).lean().cursor({ batchSize: 100 });
  const result = { items: [], count: 0 };
  let blockedIds = null;
  async function presentBatch(batch) {
    const caseIds = [...new Set(batch.map(notificationCaseId).filter(Boolean))];
    const incidentIds = [...new Set(batch.map(notificationIncidentPublicId).filter(Boolean))];
    const [caseDocs, blocks, incidentDocs] = await Promise.all([
      caseIds.length ?
        Case.find({ _id: { $in: caseIds } })
          // The legacy pending field names only one invitee. The access policy
          // needs each invite's current status and both stored applicant aliases.
          .select("_id jobId job title status paymentReleased archived lockedTotalAmount amountLockedAt attorney attorneyId paralegal paralegalId paralegalAccessRevokedAt withdrawnParalegalId pausedAt payoutFinalizedAt pendingParalegalId applicants.paralegalId applicants.paralegal applicants.status invites.paralegalId invites.status")
          .lean() : [],
      caseIds.length && blockedIds === null ? getBlocksForUser(user.id) : [],
      incidentIds.length ? Incident.find({ publicId: { $in: incidentIds } }).select("_id publicId reporter.userId").lean() : [],
    ]);
    if (caseIds.length && blockedIds === null) {
      const viewerId = normalizeId(user.id || user._id);
      blockedIds = new Set();
      for (const block of blocks) {
        const blockerId = normalizeId(block.blockerId);
        const blockedId = normalizeId(block.blockedId);
        if (blockerId === viewerId && blockedId) blockedIds.add(blockedId);
        if (blockedId === viewerId && blockerId) blockedIds.add(blockerId);
      }
    }
    const casesById = new Map(caseDocs.map(doc => [String(doc._id), doc]));
    const incidentsByPublicId = new Map(incidentDocs.map(doc => [doc.publicId, doc]));
    for (const item of batch) {
      const caseId = notificationCaseId(item);
      const presented = presentNotification(item, {
        viewer: user,
        caseDoc: caseId ? casesById.get(caseId) || null : null,
        incidentDoc: incidentsByPublicId.get(notificationIncidentPublicId(item)) || null,
        blockedIds: blockedIds || new Set(),
      });
      if (presented.available === false) continue;
      result.count += 1;
      if (!countOnly) result.items.push(presented);
      if (result.count >= limit) return;
    }
  }
  try {
    let batch = [];
    for await (const item of cursor) {
      batch.push(item);
      if (batch.length < 100) continue;
      await presentBatch(batch);
      batch = [];
      if (result.count >= limit) break;
    }
    if (batch.length && result.count < limit) await presentBatch(batch);
    return result;
  } finally {
    await cursor.close();
  }
}

function invalidPageQuery(message = "Invalid notification page query") {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function cursorSignature(payload) {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (typeof key !== "string" || key.length < 32) {
    throw new Error("Notification cursor signing is unavailable");
  }
  return crypto.createHmac("sha256", key)
    .update("lpc-notification-page-v1\0")
    .update(payload)
    .digest("base64url");
}

function decodePageCursor(token, userId, unreadOnly) {
  if (typeof token !== "string" || token.length > 768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) {
    throw invalidPageQuery("Invalid notification cursor");
  }
  const [encoded, signature] = token.split(".");
  const supplied = Buffer.from(signature, "base64url");
  const expected = Buffer.from(cursorSignature(encoded), "base64url");
  if (supplied.toString("base64url") !== signature || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw invalidPageQuery("Invalid notification cursor");
  }
  let position;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("Noncanonical cursor");
    position = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidPageQuery("Invalid notification cursor");
  }
  if (!position || Array.isArray(position) || Object.keys(position).sort().join(",") !== "i,r,t,u,v"
    || position.v !== 1 || position.u !== userId || position.r !== unreadOnly
    || typeof position.i !== "string" || !/^[a-f\d]{24}$/.test(position.i)
    || (position.t !== null && (typeof position.t !== "string" || !Number.isFinite(Date.parse(position.t)) || new Date(position.t).toISOString() !== position.t))) {
    throw invalidPageQuery("Invalid notification cursor");
  }
  return position;
}

function encodePageCursor(item, userId, unreadOnly) {
  const position = { v: 1, u: userId, r: unreadOnly, t: item.createdAt == null ? null : new Date(item.createdAt).toISOString(), i: item.id };
  const encoded = Buffer.from(JSON.stringify(position)).toString("base64url");
  return `${encoded}.${cursorSignature(encoded)}`;
}

router.get("/page", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const query = req.query;
    if (Object.keys(query).some(key => !["limit", "cursor", "unread", "expectedOwnerId"].includes(key))
      || (query.limit !== undefined && (typeof query.limit !== "string" || !/^[1-9]\d{0,2}$/.test(query.limit) || Number(query.limit) > 100))
      || (query.unread !== undefined && query.unread !== "1")) {
      throw invalidPageQuery();
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const unreadOnly = query.unread === "1";
    const userId = String(req.user.id);
    const after = query.cursor === undefined ? null : decodePageCursor(query.cursor, userId, unreadOnly);
    // One additional *visible* row proves continuation. The cursor binds the
    // last returned row, not the lookahead or the last raw record scanned.
    const result = await visibleNotifications(req.user, { unreadOnly, limit: limit + 1, after });
    const items = result.items.slice(0, limit);
    const hasMore = result.items.length > limit;
    return res.json({ items, nextCursor: hasMore ? encodePageCursor(items[items.length - 1], userId, unreadOnly) : null, hasMore });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ code: "INVALID_NOTIFICATION_PAGE", message: err.message });
    runtimeLogger.error("Failed to page notifications:", err);
    return res.status(500).json({ message: "Unable to load notifications" });
  }
});

// Get up to 100 visible notifications for the logged-in user.
router.get("/", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const { items } = await visibleNotifications(req.user);
    res.json(items);
  } catch (err) {
    runtimeLogger.error("Failed to fetch notifications:", err);
    res.status(500).json({ message: "Unable to load notifications" });
  }
});

router.get("/unread-count", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const { count } = await visibleNotifications(req.user, { unreadOnly: true, countOnly: true, limit: Infinity });
    return res.json({ count });
  } catch (err) {
    runtimeLogger.error("Failed to count unread notifications:", err);
    return res.status(500).json({ message: "Unable to count notifications" });
  }
});

// Mark notification as read
router.post("/:id/read", async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { read: true, isRead: true }
    );
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    runtimeLogger.error("Failed to mark notification read:", err);
    res.status(500).json({ message: "Unable to update notification" });
  }
});

// Restore a notification's unread state for its recipient only.
router.post("/:id/unread", async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: "Invalid notification" });
  try {
    const result = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { read: false, isRead: false }
    );
    if (!result) return res.status(404).json({ message: "Notification not found" });
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString() });
    return res.json({ success: true });
  } catch (err) {
    runtimeLogger.error("Failed to mark notification unread:", err);
    return res.status(500).json({ message: "Unable to update notification" });
  }
});

// Mark ALL as read
router.post("/read-all", async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.user.id }, { read: true, isRead: true });
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    runtimeLogger.error("Failed to mark notifications read:", err);
    res.status(500).json({ message: "Unable to update notifications" });
  }
});

// Clear ALL notifications
router.delete("/", async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.user.id });
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    runtimeLogger.error("Failed to clear notifications:", err);
    res.status(500).json({ message: "Unable to clear notifications" });
  }
});

// Dismiss a notification
router.delete("/:id", async (req, res) => {
  try {
    const result = await Notification.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!result) return res.status(404).json({ message: "Notification not found" });
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    runtimeLogger.error("Failed to delete notification:", err);
    res.status(500).json({ message: "Unable to delete notification" });
  }
});

module.exports = router;
