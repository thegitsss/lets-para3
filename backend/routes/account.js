// backend/routes/account.js
const router = require("express").Router();
const crypto = require("crypto");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { deactivateUserAccount, getAccountDeactivationEligibility } = require("../services/userDeletion");
const { hasApprovedPhoto } = require("../utils/paralegalProfile");
const sendEmail = require("../utils/email");

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
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { email, theme, state, fontSize, hideProfile } = req.body || {};
    const user = await User.findById(req.user.id)
      .select("notificationPrefs preferences location role profilePhotoStatus profileImage avatarURL");
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
    if (
      normalizedHideProfile === false &&
      String(user.role || "").toLowerCase() === "paralegal" &&
      !hasApprovedPhoto(user)
    ) {
      return res.status(400).json({ error: "Preference update failed" });
    }
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

router.use(require('./accountAuthentication'));

router.get('/2fa', asyncHandler(async (req,res)=>{
  const user=await User.findById(req.user.id).select('twoFactorEnabled twoFactorMethod +twoFactorBackupCodes');
  if(!user)return res.status(404).json({error:'User not found'});
  const enabled=String(process.env.ENABLE_TWO_FACTOR||'true').toLowerCase()!=='false';
  res.json({enabled:enabled&&!!user.twoFactorEnabled,method:user.twoFactorMethod||'email',hasBackupCodes:enabled&&!!user.twoFactorBackupCodes?.length,...(!enabled?{disabled:true}:{})});
}));

async function handleDeactivateAccount(req, res) {
  const generalBlockerCopy =
    "Accounts cannot be deactivated while you are involved in an active matter or while escrow, payout, dispute, or other financial obligations remain unresolved.";
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const eligibility = await getAccountDeactivationEligibility(user);
  if (!eligibility.canDeactivate) {
    const specificMessage = eligibility.blockers[0]?.message || "This account cannot be deactivated yet.";
    return res.status(409).json({
      error: `${generalBlockerCopy} ${specificMessage}`.trim(),
      blockers: eligibility.blockers,
    });
  }

  await deactivateUserAccount(user, { now: new Date() });

  try {
    await AuditLog.logFromReq(req, "account.deactivate", {
      targetType: "user",
      targetId: user._id,
      meta: { email: user.email || "", role: user.role || "" },
    });
  } catch {}

  try {
    await sendEmail.sendAccountDeactivatedEmail?.(user);
  } catch (err) {
    console.warn("[account] deactivation email failed", err?.message || err);
  }

  res.clearCookie("token");
  const cookieName = process.env.JWT_COOKIE_NAME || "access";
  if (cookieName && cookieName !== "token") {
    res.clearCookie(cookieName);
  }

  return res.json({ ok: true, deactivated: true });
}

router.get(
  "/deactivate-status",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("_id role disabled deleted");
    if (!user) return res.status(404).json({ error: "User not found" });
    const eligibility = await getAccountDeactivationEligibility(user);
    return res.json(eligibility);
  })
);

router.delete(
  "/deactivate",
  csrfProtection,
  asyncHandler(handleDeactivateAccount)
);

router.delete(
  "/delete",
  csrfProtection,
  asyncHandler(handleDeactivateAccount)
);

router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
