// backend/routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const mongoose = require("mongoose");

const User = require("../models/User");
const AuditLog = require("../models/AuditLog"); // audit trail hooks
const sendEmail = require("../utils/email");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TWO_HOURS = "2h";
const FIFTEEN_MIN = 15 * 60 * 1000;

function signAccess(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: TWO_HOURS }
  );
}

function signOneTime(payload, { minutes = 30, secretEnv = "JWT_SECRET" } = {}) {
  const expSeconds = Math.floor(Date.now() / 1000) + minutes * 60;
  return jwt.sign({ ...payload, exp: expSeconds }, process.env[secretEnv]);
}

function isEmail(v = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).toLowerCase());
}

function needRecaptcha() {
  // Skip only in local dev or if secret is not configured
  return process.env.NODE_ENV !== "development" && !!process.env.RECAPTCHA_SECRET;
}

async function verifyRecaptcha(token) {
  if (!needRecaptcha()) return true;
  if (!token) return false;
  const resp = await axios.post(
    `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${token}`
  );
  return !!resp.data?.success;
}

function isObjId(id) {
  return mongoose.isValidObjectId(id);
}

// naive in-memory limiter (per-process). Replace with Redis for multi-instance.
const loginLimiter = new Map(); // key: email/ip, value: { count, until }
function touchLimiter(key, max = 7, lockMinutes = 10) {
  const now = Date.now();
  const rec = loginLimiter.get(key) || { count: 0, until: 0 };
  if (rec.until && now < rec.until) return { locked: true, until: rec.until };
  rec.count += 1;
  if (rec.count >= max) {
    rec.count = 0;
    rec.until = now + lockMinutes * 60 * 1000;
  }
  loginLimiter.set(key, rec);
  return { locked: false, until: rec.until };
}
function clearLimiter(key) {
  loginLimiter.delete(key);
}

// ----------------------------------------
// REGISTER
// POST /api/auth/register
// ----------------------------------------
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const {
      name,
      email,
      password,
      role,
      barNumber,
      resumeURL,
      certificateURL,
      recaptchaToken,
    } = req.body || {};

    if (needRecaptcha()) {
      const ok = await verifyRecaptcha(recaptchaToken);
      if (!ok) return res.status(400).json({ msg: "reCAPTCHA validation failed" });
    }

    const roleLc = String(role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(roleLc)) {
      return res.status(400).json({ msg: "Invalid role" });
    }
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });
    if (!password || String(password).length < 8) {
      return res
        .status(400)
        .json({ msg: "Password must be at least 8 characters." });
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) return res.status(400).json({ msg: "User already exists" });

    // Let the model hash the password (pre-save hook)
    const user = new User({
      name: String(name || "").trim(),
      email: String(email || "").toLowerCase(),
      password: String(password),
      role: roleLc,
      status: "pending",
      barNumber: roleLc === "attorney" ? String(barNumber || "") : "",
      resumeURL: roleLc === "paralegal" ? String(resumeURL || "") : "",
      certificateURL: roleLc === "paralegal" ? String(certificateURL || "") : "",
    });

    await user.save();

    // Email: registration received + email verification link (optional but nice)
    try {
      const verifyToken = signOneTime(
        { purpose: "verify-email", uid: user._id.toString() },
        { minutes: 60, secretEnv: "JWT_SECRET" }
      );
      const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
      await sendEmail(
        user.email,
        "Registration received",
        `Thanks for registering with Let's ParaConnect. An admin will review your account shortly.${
          process.env.APP_BASE_URL ? `\n\nYou can verify your email here (optional): ${verifyUrl}` : ""
        }`
      );
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.register", {
      targetType: "user",
      targetId: user._id,
      meta: { role: user.role },
    });

    res.json({ msg: "Registered successfully. Await admin approval." });
  })
);

// ----------------------------------------
// LOGIN
// POST /api/auth/login  -> returns { token, user }
// ----------------------------------------
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password, recaptchaToken } = req.body || {};

    // per-email+IP limiter
    const ipKey = `ip:${req.ip}`;
    const emKey = `em:${String(email || "").toLowerCase()}`;
    const lim1 = touchLimiter(ipKey);
    const lim2 = touchLimiter(emKey);
    if (lim1.locked || lim2.locked) {
      return res.status(429).json({ msg: "Too many attempts. Try again later." });
    }

    if (needRecaptcha()) {
      const ok = await verifyRecaptcha(recaptchaToken);
      if (!ok) return res.status(400).json({ msg: "reCAPTCHA validation failed" });
    }

    if (!isEmail(email) || !password) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    // IMPORTANT: password is select:false in schema, so we MUST include it
    const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!user) {
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", meta: { email } });
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    if (user.isLocked) {
      return res.status(423).json({ msg: "Account locked. Try again later." });
    }

    if (user.status !== "approved") {
      return res.status(403).json({ msg: "Account pending approval" });
    }

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) {
      // track failure & potential lockout using model helper
      user.recordLoginFailure?.();
      await user.save();
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", targetId: user._id });
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    // success
    user.recordLoginSuccess?.();
    await user.save();

    clearLimiter(ipKey);
    clearLimiter(emKey);

    const token = signAccess(user);
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });

    res.json({
      token,
      user: {
        id: user._id,
        role: user.role,
        email: user.email,
        name: user.name,
        status: user.status,
      },
    });
  })
);

// ----------------------------------------
// ME
// GET /api/auth/me  (reads Bearer token)
// ----------------------------------------
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    if (!token) return res.json({ user: null });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      // freshen user info (role/status might have changed)
      const u = await User.findById(payload.id).lean();
      if (!u) return res.json({ user: null });
      res.json({
        user: {
          id: u._id,
          role: u.role,
          email: u.email,
          name: u.name,
          status: u.status,
        },
      });
    } catch {
      res.json({ user: null });
    }
  })
);

// ----------------------------------------
// LOGOUT (stateless JWT – client deletes token)
// POST /api/auth/logout
// ----------------------------------------
router.post("/logout", (_req, res) => res.json({ ok: true }));

// ----------------------------------------
// EMAIL VERIFICATION (optional but handy)
// POST /api/auth/resend-verification
// POST /api/auth/verify-email  { token }
// ----------------------------------------
router.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const { email, recaptchaToken } = req.body || {};
    if (needRecaptcha()) {
      const ok = await verifyRecaptcha(recaptchaToken);
      if (!ok) return res.status(400).json({ msg: "reCAPTCHA validation failed" });
    }
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // don't reveal existence
    if (user.emailVerified) return res.json({ ok: true });

    try {
      const verifyToken = signOneTime(
        { purpose: "verify-email", uid: user._id.toString() },
        { minutes: 60, secretEnv: "JWT_SECRET" }
      );
      const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
      await sendEmail(user.email, "Verify your email", `Click to verify: ${verifyUrl}`);
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.verify.resend", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ msg: "Missing token" });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "verify-email" || !isObjId(payload.uid)) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid);
      if (!user) return res.status(404).json({ msg: "User not found" });
      user.markEmailVerified?.();
      await user.save();

      await AuditLog.logFromReq(req, "auth.verify.success", {
        targetType: "user",
        targetId: user._id,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ msg: "Invalid or expired token" });
    }
  })
);

// ----------------------------------------
// PASSWORD RESET (stateless token via email)
// POST /api/auth/request-password-reset { email }
// POST /api/auth/reset-password { token, newPassword }
// ----------------------------------------
router.post(
  "/request-password-reset",
  asyncHandler(async (req, res) => {
    const { email, recaptchaToken } = req.body || {};
    if (needRecaptcha()) {
      const ok = await verifyRecaptcha(recaptchaToken);
      if (!ok) return res.status(400).json({ msg: "reCAPTCHA validation failed" });
    }
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // do not reveal

    const resetToken = signOneTime(
      { purpose: "reset-password", uid: user._id.toString() },
      { minutes: 30, secretEnv: "JWT_SECRET" }
    );
    const resetUrl = `${process.env.APP_BASE_URL || ""}/reset-password?token=${resetToken}`;
    try {
      await sendEmail(user.email, "Reset your password", `Use this link to reset your password: ${resetUrl}\nThis link expires in 30 minutes.`);
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.password.reset.request", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ msg: "Missing token or newPassword" });
    if (String(newPassword).length < 8) return res.status(400).json({ msg: "Password must be at least 8 characters." });

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "reset-password" || !isObjId(payload.uid)) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid).select("+password");
      if (!user) return res.status(404).json({ msg: "User not found" });

      // Assign; hashing handled by model pre-save
      user.password = String(newPassword);
      await user.save();

      await AuditLog.logFromReq(req, "auth.password.reset.success", {
        targetType: "user",
        targetId: user._id,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ msg: "Invalid or expired token" });
    }
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
});

module.exports = router;
