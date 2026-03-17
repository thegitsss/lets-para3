const express = require("express");
const Notification = require("../models/Notification");
const User = require("../models/User");
const Case = require("../models/Case");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const { addSubscriber, publishNotificationEvent } = require("../utils/notificationEvents");
const {
  markWorkspacePresence,
  clearWorkspacePresence,
} = require("../utils/workspacePresence");

const router = express.Router();

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const noop = (_req, _res, next) => next();
const csrf = require("csurf");
const csrfMiddleware = csrf({
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  },
});
const protectMutations = (req, res, next) => {
  const requireCsrf = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
  if (!requireCsrf) return noop(req, res, next);
  const method = String(req.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  return csrfMiddleware(req, res, next);
};

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
    if (!allowed) return res.status(404).json({ message: "Case not found" });
    markWorkspacePresence(req.user.id, caseId);
    return res.json({ success: true, caseId });
  } catch (err) {
    console.error("Failed to set workspace presence:", err);
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
    console.error("Failed to clear workspace presence:", err);
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
      .lean();
    const normalized = items
      .filter((item) => {
        if (item.type !== "message") return true;
        if (!item.actorUserId) return true;
        return String(item.actorUserId) !== String(req.user.id);
      })
      .map((item) => ({
      id: String(item._id),
      _id: item._id,
      userId: item.userId,
      userRole: item.userRole || "",
      type: item.type,
      message: item.message || item.payload?.message || "You have a new notification.",
      link: item.link || item.payload?.link || "",
      payload: item.payload || {},
      isRead: item.isRead ?? item.read ?? false,
      read: item.isRead ?? item.read ?? false,
      actorUserId: item.actorUserId || null,
      actorFirstName: item.actorFirstName || "",
      actorProfileImage: item.actorProfileImage || "",
      createdAt: item.createdAt,
    }));
    res.json(normalized);
  } catch (err) {
    console.error("Failed to fetch notifications:", err);
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
    console.error("Failed to mark notification read:", err);
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
    console.error("Failed to mark notifications read:", err);
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
    console.error("Failed to clear notifications:", err);
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
    console.error("Failed to delete notification:", err);
    res.status(500).json({ message: "Unable to delete notification" });
  }
});

// Public VAPID key for push subscriptions
router.get("/vapid-key", (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || "" });
});

// Save browser push subscription
router.post("/subscribe", async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select("notificationPrefs pushSubscription");
    if (!me) return res.status(404).json({ message: "User not found" });
    me.pushSubscription = req.body || null;
    me.notificationPrefs = Object.assign(
      {},
      typeof me.notificationPrefs?.toObject === "function" ? me.notificationPrefs.toObject() : me.notificationPrefs || {},
      { browser: true }
    );
    await me.save();
    res.json({ success: true });
  } catch (err) {
    console.error("Push subscription failed:", err);
    res.status(500).json({ message: "Unable to save subscription" });
  }
});

module.exports = router;
