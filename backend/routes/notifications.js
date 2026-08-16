const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:notifications");
const express = require("express");
const Notification = require("../models/Notification");
const Case = require("../models/Case");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const { addSubscriber, publishNotificationEvent } = require("../utils/notificationEvents");
const { getBlocksForUser, normalizeId } = require("../utils/blocks");
const {
  notificationCaseId,
  presentNotification,
} = require("../services/notificationPresentation");
const {
  markWorkspacePresence,
  clearWorkspacePresence,
} = require("../utils/workspacePresence");
const { protectMutations } = require("../utils/csrf");

const router = express.Router();

router.use(verifyToken, requireApproved);
router.use(protectMutations);

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
    if (!caseId) return res.status(400).json({ message: "caseId is required" });
    const allowed = await canTrackWorkspacePresence(req.user, caseId);
    if (!allowed) return res.status(404).json({ message: "Matter not found" });
    markWorkspacePresence(req.user.id, caseId);
    return res.json({ success: true, caseId });
  } catch (err) {
    runtimeLogger.error("Failed to set workspace presence:", err);
    return res.status(500).json({ message: "Unable to update workspace presence" });
  }
});

router.delete("/workspace-presence", async (req, res) => {
  try {
    const caseId = String(req.body?.caseId || "").trim();
    if (!caseId) {
      clearWorkspacePresence(req.user.id);
      return res.json({ success: true });
    }
    clearWorkspacePresence(req.user.id, caseId);
    return res.json({ success: true, caseId });
  } catch (err) {
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

// Get all notifications for logged-in user
router.get("/", async (req, res) => {
  try {
    const items = await Notification.find({ userId: req.user.id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .lean();
    const visibleItems = items.filter((item) => {
      if (item.type !== "message") return true;
      if (!item.actorUserId) return true;
      return String(item.actorUserId) !== String(req.user.id);
    });
    const caseIds = [...new Set(visibleItems.map(notificationCaseId).filter(Boolean))];
    const [caseDocs, blocks] = await Promise.all([
      caseIds.length
        ? Case.find({ _id: { $in: caseIds } })
            .select(
              "_id title status paymentReleased archived attorney attorneyId paralegal paralegalId paralegalAccessRevokedAt withdrawnParalegalId pendingParalegalId applicants.paralegalId applicants.status invites.paralegalId invites.status"
            )
            .lean()
        : Promise.resolve([]),
      caseIds.length ? getBlocksForUser(req.user.id) : Promise.resolve([]),
    ]);
    const casesById = new Map(caseDocs.map((doc) => [String(doc._id), doc]));
    const viewerId = normalizeId(req.user.id || req.user._id);
    const blockedIds = new Set();
    blocks.forEach((block) => {
      const blockerId = normalizeId(block.blockerId);
      const blockedId = normalizeId(block.blockedId);
      if (blockerId === viewerId && blockedId) blockedIds.add(blockedId);
      if (blockedId === viewerId && blockerId) blockedIds.add(blockerId);
    });
    const normalized = visibleItems.map((item) => {
      const caseId = notificationCaseId(item);
      return presentNotification(item, {
        viewer: req.user,
        caseDoc: caseId ? casesById.get(caseId) || null : null,
        blockedIds,
      });
    });
    res.json(normalized);
  } catch (err) {
    runtimeLogger.error("Failed to fetch notifications:", err);
    res.status(500).json({ message: "Unable to load notifications" });
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
