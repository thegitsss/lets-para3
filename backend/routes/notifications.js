const express = require("express");
const Notification = require("../models/Notification");
const User = require("../models/User");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");

const router = express.Router();

router.use(verifyToken, requireApproved);

// Get all notifications for logged-in user
router.get("/", async (req, res) => {
  try {
    const items = await Notification.find({ userId: req.user.id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    const normalized = items.map((item) => ({
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
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to mark notifications read:", err);
    res.status(500).json({ message: "Unable to update notifications" });
  }
});

// Dismiss a notification
router.delete("/:id", async (req, res) => {
  try {
    const result = await Notification.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!result) return res.status(404).json({ message: "Notification not found" });
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
