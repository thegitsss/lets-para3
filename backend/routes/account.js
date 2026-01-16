// backend/routes/account.js
const router = require("express").Router();
const crypto = require("crypto");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { purgeAttorneyAccount } = require("../services/userDeletion");

// ----------------------------------------
// CSRF (enabled in production or when ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const BACKUP_CODE_COUNT = Number(process.env.TWO_FA_BACKUP_COUNT || 8);
const BACKUP_CODE_LENGTH = Number(process.env.TWO_FA_BACKUP_LENGTH || 10);
const TWO_FACTOR_ENABLED = String(process.env.ENABLE_TWO_FACTOR || "").toLowerCase() === "true";

function randomCode(length = BACKUP_CODE_LENGTH) {
  const bytes = crypto.randomBytes(Math.ceil(length / 2));
  return bytes.toString("hex").slice(0, length).toUpperCase();
}

function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => randomCode(BACKUP_CODE_LENGTH));
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

router.use(verifyToken);
router.use(requireApproved);

router.get(
  "/preferences",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("notificationPrefs preferences location state");
    if (!user) return res.status(404).json({ error: "User not found" });
    const prefs = user.notificationPrefs || {};
    res.json({
      email: !!prefs.email,
      theme:
        (user.preferences && typeof user.preferences === "object" && user.preferences.theme) ||
        "mountain",
      fontSize:
        (user.preferences && typeof user.preferences === "object" && user.preferences.fontSize) ||
        "md",
      hideProfile:
        (user.preferences && typeof user.preferences === "object" && user.preferences.hideProfile) ||
        false,
      state: user.location || user.state || "",
    });
  })
);

router.post(
  "/preferences",
  asyncHandler(async (req, res) => {
    const { email, theme, state, fontSize, hideProfile } = req.body || {};
    const user = await User.findById(req.user.id).select("notificationPrefs preferences location");
    if (!user) return res.status(404).json({ error: "User not found" });

    const current =
      typeof user.notificationPrefs?.toObject === "function"
        ? user.notificationPrefs.toObject()
        : user.notificationPrefs || {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "email")) {
      user.notificationPrefs = {
        ...current,
        email: !!email,
      };
    }

    const normalizedTheme =
      typeof theme === "string" && ["light", "dark", "mountain", "mountain-dark"].includes(theme.toLowerCase())
        ? theme.toLowerCase()
        : null;
    const normalizedFontSize =
      typeof fontSize === "string" && ["xs", "sm", "md", "lg", "xl"].includes(fontSize.toLowerCase())
        ? fontSize.toLowerCase()
        : null;
    const normalizedHideProfile = typeof hideProfile === "boolean" ? hideProfile : null;
    if (normalizedTheme || normalizedFontSize || normalizedHideProfile !== null) {
      user.preferences = {
        ...(typeof user.preferences?.toObject === "function"
          ? user.preferences.toObject()
          : user.preferences || {}),
        ...(normalizedTheme ? { theme: normalizedTheme } : {}),
        ...(normalizedFontSize ? { fontSize: normalizedFontSize } : {}),
        ...(normalizedHideProfile !== null ? { hideProfile: normalizedHideProfile } : {}),
      };
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "state")) {
      const normalizedState =
        typeof state === "string" ? state.trim().toUpperCase() : "";
      if (normalizedState && !/^[A-Z]{2}$/.test(normalizedState)) {
        return res.status(400).json({ error: "Invalid state selection" });
      }
      user.location = normalizedState;
    }

    await user.save();

    res.json({
      success: true,
      preferences: {
        email: user.notificationPrefs?.email !== false,
        theme: normalizedTheme || user.preferences?.theme || "mountain",
        fontSize: normalizedFontSize || user.preferences?.fontSize || "md",
        hideProfile:
          normalizedHideProfile !== null
            ? normalizedHideProfile
            : user.preferences?.hideProfile || false,
      },
      state: user.location || "",
    });
  })
);

router.post(
  "/update-password",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required." });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const user = await User.findById(req.user.id).select("+password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await user.comparePassword(String(currentPassword));
    if (!ok) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    user.password = String(newPassword);
    await user.save();

    try {
      await AuditLog.logFromReq(req, "account.password.update", {
        targetType: "user",
        targetId: user._id,
      });
    } catch {}

    res.json({ ok: true });
  })
);

router.get(
  "/2fa",
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.json({ enabled: false, method: "email", hasBackupCodes: false, disabled: true });
    }
    const user = await User.findById(req.user.id).select("twoFactorEnabled twoFactorBackupCodes twoFactorMethod");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      enabled: !!user.twoFactorEnabled,
      method: user.twoFactorMethod || "email",
      hasBackupCodes: Array.isArray(user.twoFactorBackupCodes) && user.twoFactorBackupCodes.length > 0,
    });
  })
);

router.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const actor = req.user?.id || req.user?._id;
    if (!actor) return res.json({ sessions: [] });
    const sessions = await AuditLog.find({
      actor,
      action: "auth.login.success",
    })
      .sort({ createdAt: -1 })
      .limit(12)
      .select("createdAt ua ip");

    res.json({
      sessions: sessions.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        ua: item.ua || "",
        ip: item.ip || "",
      })),
    });
  })
);

router.post(
  "/2fa-toggle",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const user = await User.findById(req.user.id).select("twoFactorEnabled twoFactorMethod");
    if (!user) return res.status(404).json({ error: "User not found" });

    const enabled = !!req.body?.enabled;
    const method = String(req.body?.method || user.twoFactorMethod || "email").toLowerCase();
    const allowed = new Set(["authenticator", "sms", "email"]);

    user.twoFactorEnabled = enabled;
    if (allowed.has(method)) {
      user.twoFactorMethod = method;
    }
    await user.save();

    res.json({ enabled: user.twoFactorEnabled, method: user.twoFactorMethod || "email" });
  })
);

router.post(
  "/2fa-backup-codes",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const user = await User.findById(req.user.id).select("twoFactorEnabled twoFactorBackupCodes");
    if (!user) return res.status(404).json({ error: "User not found" });

    const codes = generateBackupCodes();
    user.twoFactorBackupCodes = codes.map((code) => hashCode(code));
    await user.save();

    res.json({ codes });
  })
);

router.delete(
  "/delete",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (String(user.role || "").toLowerCase() === "attorney") {
      await purgeAttorneyAccount(user._id);
    } else {
      user.deleted = true;
      user.deletedAt = new Date();
      user.disabled = true;
      user.status = "denied";
      await user.save();
    }

    try {
      await AuditLog.logFromReq(req, "account.delete", {
        targetType: "user",
        targetId: user._id,
        meta: { email: user.email || "", role: user.role || "" },
      });
    } catch {}

    res.json({ ok: true });
  })
);

router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
