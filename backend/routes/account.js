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
      state: user.location || user.state || "",
    });
  })
);

router.post(
  "/preferences",
  asyncHandler(async (req, res) => {
    const { email, theme, state, fontSize } = req.body || {};
    const user = await User.findById(req.user.id).select("notificationPrefs preferences location");
    if (!user) return res.status(404).json({ error: "User not found" });

    const current =
      typeof user.notificationPrefs?.toObject === "function"
        ? user.notificationPrefs.toObject()
        : user.notificationPrefs || {};

    user.notificationPrefs = {
      ...current,
      email: !!email,
    };

    const normalizedTheme =
      typeof theme === "string" && ["light", "dark", "mountain", "mountain-dark"].includes(theme.toLowerCase())
        ? theme.toLowerCase()
        : null;
    const normalizedFontSize =
      typeof fontSize === "string" && ["xs", "sm", "md", "lg", "xl"].includes(fontSize.toLowerCase())
        ? fontSize.toLowerCase()
        : null;
    if (normalizedTheme || normalizedFontSize) {
      user.preferences = {
        ...(typeof user.preferences?.toObject === "function"
          ? user.preferences.toObject()
          : user.preferences || {}),
        ...(normalizedTheme ? { theme: normalizedTheme } : {}),
        ...(normalizedFontSize ? { fontSize: normalizedFontSize } : {}),
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
        email: !!email,
        theme: normalizedTheme || user.preferences?.theme || "mountain",
        fontSize: normalizedFontSize || user.preferences?.fontSize || "md",
      },
      state: user.location || "",
    });
  })
);

router.get(
  "/2fa",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("twoFactorEnabled twoFactorBackupCodes");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      enabled: !!user.twoFactorEnabled,
      hasBackupCodes: Array.isArray(user.twoFactorBackupCodes) && user.twoFactorBackupCodes.length > 0,
    });
  })
);

router.post(
  "/2fa-toggle",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("twoFactorEnabled");
    if (!user) return res.status(404).json({ error: "User not found" });

    user.twoFactorEnabled = !!req.body?.enabled;
    await user.save();

    res.json({ enabled: user.twoFactorEnabled });
  })
);

router.post(
  "/2fa-backup-codes",
  csrfProtection,
  asyncHandler(async (req, res) => {
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
