const express = require("express");
const Notification = require("../models/Notification");
const User = require("../models/User");
const verifyToken = require("../utils/verifyToken");

const router = express.Router();

// Get all notifications for logged-in user
router.get("/", verifyToken, async (req, res) => {
  try {
    const items = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error("Failed to fetch notifications:", err);
    res.status(500).json({ message: "Unable to load notifications" });
  }
});

// Mark notification as read
router.post("/:id/read", verifyToken, async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { read: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to mark notification read:", err);
    res.status(500).json({ message: "Unable to update notification" });
  }
});

// Mark ALL as read
router.post("/read-all", verifyToken, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.user.id }, { read: true });
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to mark notifications read:", err);
    res.status(500).json({ message: "Unable to update notifications" });
  }
});

// Public VAPID key for push subscriptions
router.get("/vapid-key", (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || "" });
});

// Save browser push subscription
router.post("/subscribe", verifyToken, async (req, res) => {
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
