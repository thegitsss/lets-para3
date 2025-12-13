// backend/middleware/requireApprovedUser.js
const User = require("../models/User");

module.exports = async function requireApprovedUser(req, res, next) {
  try {
    const requester = req.user;
    if (!requester || !requester.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (String(requester.role || "").toLowerCase() === "admin") {
      return next();
    }

    const user = await User.findById(requester.id).select("status role");
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (String(user.role || "").toLowerCase() === "admin" || String(user.status || "").toLowerCase() === "approved") {
      return next();
    }

    return res.status(403).json({ error: "Account pending approval" });
  } catch (err) {
    console.error("[requireApprovedUser] failed", err);
    return res.status(500).json({ error: "Server error" });
  }
};
