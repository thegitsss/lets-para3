const router = require("express").Router();
const verifyToken = require("../utils/verifyToken");
const User = require("../models/User");
const sendEmail = require("../utils/email");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken);

router.post(
  "/email/request",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    try {
      if (typeof sendEmail.sendVerificationEmail === "function") {
        await sendEmail.sendVerificationEmail(user, code);
      }
    } catch (err) {
      console.warn("[verification] email request failed", err?.message || err);
    }
    res.json({ success: true });
  })
);

router.post(
  "/email/confirm",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.emailVerified = true;
    await user.save();
    res.json({ success: true, emailVerified: true });
  })
);

router.post(
  "/phone/request",
  asyncHandler(async (req, res) => {
    const { phoneNumber } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (phoneNumber) {
      user.phoneNumber = String(phoneNumber).trim();
      await user.save();
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    try {
      if (typeof sendEmail.sendVerificationSMS === "function") {
        await sendEmail.sendVerificationSMS(user.phoneNumber || phoneNumber, code);
      }
    } catch (err) {
      console.warn("[verification] phone request failed", err?.message || err);
    }
    res.json({ success: true });
  })
);

router.post(
  "/phone/confirm",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.phoneVerified = true;
    await user.save();
    res.json({ success: true, phoneVerified: true });
  })
);

module.exports = router;
