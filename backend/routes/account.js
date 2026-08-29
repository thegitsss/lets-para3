const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:account");
// backend/routes/account.js
const router = require("express").Router();
const crypto = require("crypto");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { deactivateUserAccount, getAccountDeactivationEligibility } = require("../services/userDeletion");
const { hasApprovedPhoto } = require("../utils/paralegalProfile");
const AuthSession = require("../models/AuthSession");
const AuthChallenge = require("../models/AuthChallenge");
const PasskeyCredential = require("../models/PasskeyCredential");
const { validateNewPassword } = require("../utils/passwordPolicy");
const {
  listActiveSessions,
  revokeAllUserSessions,
  revokeSession,
} = require("../services/authSessionService");
const sendEmail = require("../utils/email");
const QRCode = require("qrcode");
const { createTotpEnrollment, newChallengeId, verifyTotp } = require("../services/mfaService");
const {
  registrationOptions: createPasskeyRegistrationOptions,
  verifyRegistration: verifyPasskeyRegistration,
} = require("../services/passkeyService");
const {
  DASHBOARD_VIEW_SCOPES,
  MAX_VIEWS_PER_SCOPE,
  DashboardSavedViewError,
  normalizeDashboardSavedView,
  serializeDashboardSavedView,
} = require("../services/dashboardSavedViews");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const BACKUP_CODE_COUNT = Number(process.env.TWO_FA_BACKUP_COUNT || 8);
const BACKUP_CODE_LENGTH = Number(process.env.TWO_FA_BACKUP_LENGTH || 10);
const TWO_FACTOR_ENABLED = String(process.env.ENABLE_TWO_FACTOR || "true").toLowerCase() !== "false";
const DASHBOARD_VIEW_SCOPE_ROLES = Object.freeze({
  attorney_matters: "attorney",
  paralegal_applications: "paralegal",
});

function canUseDashboardViewScope(user, scope) {
  return DASHBOARD_VIEW_SCOPE_ROLES[scope] === String(user?.role || "").toLowerCase();
}

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
    const storedTheme = String(user.preferences?.theme || "").toLowerCase();
    res.json({
      email: !!prefs.email,
      theme: storedTheme === "dark" ? "dark" : "light",
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
      typeof theme === "string" && ["light", "dark"].includes(theme.toLowerCase())
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
        theme:
          normalizedTheme ||
          (String(user.preferences?.theme || "").toLowerCase() === "dark" ? "dark" : "light"),
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

router.get(
  "/dashboard-views",
  asyncHandler(async (req, res) => {
    const scope = String(req.query.scope || "").trim().toLowerCase();
    if (!DASHBOARD_VIEW_SCOPES.includes(scope)) {
      return res.status(400).json({ error: "Invalid dashboard view scope" });
    }
    if (!canUseDashboardViewScope(req.user, scope)) {
      return res.status(403).json({ error: "Dashboard view scope unavailable" });
    }
    const user = await User.findById(req.user.id).select("preferences.dashboardViews").lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    const views = Array.isArray(user.preferences?.dashboardViews)
      ? user.preferences.dashboardViews
          .filter((view) => String(view?.scope || "") === scope)
          .map(serializeDashboardSavedView)
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    res.json({ scope, views });
  })
);

router.post(
  "/dashboard-views",
  csrfProtection,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = normalizeDashboardSavedView(req.body || {});
    } catch (error) {
      if (error instanceof DashboardSavedViewError) {
        return res.status(400).json({ error: "Invalid saved view", code: error.code });
      }
      throw error;
    }
    if (!canUseDashboardViewScope(req.user, input.scope)) {
      return res.status(403).json({ error: "Dashboard view scope unavailable" });
    }
    const user = await User.findById(req.user.id).select("preferences");
    if (!user) return res.status(404).json({ error: "User not found" });
    const preferences = typeof user.preferences?.toObject === "function"
      ? user.preferences.toObject()
      : user.preferences || {};
    const views = Array.isArray(preferences.dashboardViews) ? [...preferences.dashboardViews] : [];
    const now = new Date();
    const requestedId = String(input.id || "");
    const existingIndex = requestedId
      ? views.findIndex((view) => String(view?.id || "") === requestedId && String(view?.scope || "") === input.scope)
      : -1;
    const duplicateName = views.find((view, index) =>
      index !== existingIndex &&
      String(view?.scope || "") === input.scope &&
      String(view?.name || "").trim().toLowerCase() === input.name.toLowerCase()
    );
    if (duplicateName) return res.status(409).json({ error: "A saved view with that name already exists" });
    if (existingIndex < 0 && views.filter((view) => String(view?.scope || "") === input.scope).length >= MAX_VIEWS_PER_SCOPE) {
      return res.status(409).json({ error: `You can save up to ${MAX_VIEWS_PER_SCOPE} views here` });
    }
    const savedView = {
      id: existingIndex >= 0 ? String(views[existingIndex].id) : crypto.randomUUID(),
      scope: input.scope,
      name: input.name,
      filters: input.filters,
      createdAt: existingIndex >= 0 ? views[existingIndex].createdAt || now : now,
      updatedAt: now,
    };
    if (existingIndex >= 0) views.splice(existingIndex, 1, savedView);
    else views.push(savedView);
    user.preferences = { ...preferences, dashboardViews: views };
    user.markModified("preferences.dashboardViews");
    await user.save();
    res.status(existingIndex >= 0 ? 200 : 201).json({ view: serializeDashboardSavedView(savedView) });
  })
);

router.delete(
  "/dashboard-views/:scope/:viewId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const scope = String(req.params.scope || "").trim().toLowerCase();
    const viewId = String(req.params.viewId || "").trim();
    if (!DASHBOARD_VIEW_SCOPES.includes(scope) || !viewId || viewId.length > 80) {
      return res.status(400).json({ error: "Invalid saved view" });
    }
    if (!canUseDashboardViewScope(req.user, scope)) {
      return res.status(403).json({ error: "Dashboard view scope unavailable" });
    }
    const user = await User.findById(req.user.id).select("preferences");
    if (!user) return res.status(404).json({ error: "User not found" });
    const preferences = typeof user.preferences?.toObject === "function"
      ? user.preferences.toObject()
      : user.preferences || {};
    const views = Array.isArray(preferences.dashboardViews) ? preferences.dashboardViews : [];
    const next = views.filter((view) => !(String(view?.scope || "") === scope && String(view?.id || "") === viewId));
    if (next.length === views.length) return res.status(404).json({ error: "Saved view not found" });
    user.preferences = { ...preferences, dashboardViews: next };
    user.markModified("preferences.dashboardViews");
    await user.save();
    res.json({ ok: true });
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
    const user = await User.findById(req.user.id).select("+password +authVersion");
    if (!user) return res.status(404).json({ error: "User not found" });

    const passwordPolicy = validateNewPassword(newPassword, { user });
    if (!passwordPolicy.ok) {
      return res.status(400).json({ error: passwordPolicy.error, code: passwordPolicy.code });
    }

    const ok = await user.comparePassword(String(currentPassword));
    if (!ok) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    if (await user.comparePassword(passwordPolicy.password)) {
      return res.status(400).json({ error: "Choose a password you have not already used for this account." });
    }

    user.password = passwordPolicy.password;
    user.authVersion = Number(user.authVersion || 0) + 1;
    await user.save();
    await revokeAllUserSessions(user._id, "password_change");

    try {
      await AuditLog.logFromReq(req, "account.password.update", {
        targetType: "user",
        targetId: user._id,
      });
    } catch (auditError) {
      runtimeLogger.error("[account] password-change audit persistence failed", auditError);
    }

    res.json({ ok: true, reauthenticationRequired: true });
  })
);

router.get(
  "/2fa",
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.json({ enabled: false, method: "email", hasBackupCodes: false, disabled: true });
    }
    const user = await User.findById(req.user.id).select("twoFactorEnabled +twoFactorBackupCodes twoFactorMethod");
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
    const sessions = await listActiveSessions(actor);

    res.json({
      sessions: sessions.map((item) => ({
        id: item.sessionId,
        createdAt: item.createdAt,
        lastSeenAt: item.lastSeenAt,
        expiresAt: item.expiresAt,
        ua: item.userAgent || "",
        ip: item.ip || "",
        current: String(item.sessionId) === String(req.authSessionId || ""),
      })),
    });
  })
);

router.delete(
  "/sessions/:sessionId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const actor = req.user?.id || req.user?._id;
    const sessionId = String(req.params.sessionId || "");
    const exists = await AuthSession.exists({ userId: actor, sessionId, revokedAt: null });
    if (!exists) return res.status(404).json({ error: "Session not found" });
    await revokeSession(sessionId, actor, "user_revoked");
    res.json({ ok: true, currentSessionRevoked: sessionId === String(req.authSessionId || "") });
  })
);

router.post(
  "/sessions/revoke-others",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const actor = req.user?.id || req.user?._id;
    const revokedCount = await revokeAllUserSessions(actor, "user_revoked_others", {
      exceptSessionId: req.authSessionId,
    });
    res.json({ ok: true, revokedCount });
  })
);

router.post(
  "/2fa-toggle",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const user = await User.findById(req.user.id).select("twoFactorEnabled twoFactorMethod emailVerified +twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep +password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const enabled = !!req.body?.enabled;
    const requestedMethod = String(req.body?.method || user.twoFactorMethod || "email").toLowerCase();
    const currentPassword = String(req.body?.currentPassword || "");

    if (enabled && requestedMethod !== "email") {
      return res.status(400).json({ error: "Use the authenticator setup flow for authenticator-app verification." });
    }
    if (enabled && user.emailVerified !== true) {
      return res.status(409).json({ error: "Verify your email before enabling two-step verification." });
    }
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to change two-step verification." });
    }

    user.twoFactorEnabled = enabled;
    user.twoFactorMethod = enabled ? "email" : (user.twoFactorMethod || "email");
    if (!enabled || user.twoFactorMethod === "email") {
      user.totpSecretEncrypted = null;
      user.totpLastUsedTimeStep = null;
    }
    if (!enabled) {
      user.twoFactorBackupCodes = [];
    }
    await user.save();
    await revokeAllUserSessions(user._id, "two_factor_change", { exceptSessionId: req.authSessionId });

    try {
      await AuditLog.logFromReq(req, enabled ? "account.2fa.enable" : "account.2fa.disable", {
        targetType: "user",
        targetId: user._id,
        meta: { method: user.twoFactorMethod },
      });
    } catch (auditError) {
      runtimeLogger.error("[account] 2FA disable audit persistence failed", auditError);
    }

    res.json({ enabled: user.twoFactorEnabled, method: user.twoFactorMethod || "email" });
  })
);

router.post(
  "/2fa/authenticator/setup",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const user = await User.findById(req.user.id).select("email +password");
    if (!user) return res.status(404).json({ error: "User not found" });
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to set up an authenticator app." });
    }

    const enrollment = await createTotpEnrollment(user.email);
    await AuthChallenge.updateMany(
      { userId: user._id, purpose: "totp_enrollment", consumedAt: null },
      { $set: { consumedAt: new Date() } }
    );
    const challengeId = newChallengeId();
    await AuthChallenge.create({
      challengeId,
      userId: user._id,
      purpose: "totp_enrollment",
      challenge: newChallengeId(),
      metadata: { encryptedSecret: enrollment.encryptedSecret, failedAttempts: 0 },
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const qrDataUrl = await QRCode.toDataURL(enrollment.uri, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
    });
    res.json({ challengeId, qrDataUrl, manualSecret: enrollment.secret, expiresInSeconds: 600 });
  })
);

router.post(
  "/2fa/authenticator/confirm",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const challengeId = String(req.body?.challengeId || "");
    const code = String(req.body?.code || "").trim();
    if (!challengeId || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Enter the six-digit code from your authenticator app." });
    }
    const challenge = await AuthChallenge.findOne({
      challengeId,
      userId: req.user.id,
      purpose: "totp_enrollment",
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).select("+metadata");
    if (!challenge?.metadata?.encryptedSecret) {
      return res.status(400).json({ error: "Authenticator setup expired. Start again." });
    }
    const result = await verifyTotp({ encryptedSecret: challenge.metadata.encryptedSecret, token: code });
    if (!result.valid) {
      const failedAttempts = Number(challenge.metadata.failedAttempts || 0) + 1;
      challenge.metadata = { ...challenge.metadata, failedAttempts };
      challenge.markModified("metadata");
      if (failedAttempts >= 5) challenge.consumedAt = new Date();
      await challenge.save();
      return res.status(failedAttempts >= 5 ? 429 : 400).json({
        error: failedAttempts >= 5 ? "Too many attempts. Start setup again." : "That code is not valid. Try the current code from your app.",
      });
    }
    const claimed = await AuthChallenge.updateOne(
      { _id: challenge._id, consumedAt: null },
      { $set: { consumedAt: new Date() } }
    );
    if (claimed.modifiedCount !== 1) {
      return res.status(409).json({ error: "Authenticator setup was already completed. Refresh this page." });
    }

    const user = await User.findById(req.user.id).select("+twoFactorBackupCodes +totpSecretEncrypted +totpLastUsedTimeStep");
    if (!user) return res.status(404).json({ error: "User not found" });
    const backupCodes = generateBackupCodes();
    user.twoFactorEnabled = true;
    user.twoFactorMethod = "authenticator";
    user.totpSecretEncrypted = challenge.metadata.encryptedSecret;
    user.totpLastUsedTimeStep = null;
    user.twoFactorBackupCodes = backupCodes.map((item) => hashCode(item));
    await user.save();
    await revokeAllUserSessions(user._id, "two_factor_change", { exceptSessionId: req.authSessionId });
    await AuditLog.logFromReq(req, "account.2fa.enable", {
      targetType: "user",
      targetId: user._id,
      meta: { method: "authenticator" },
    }).catch(logPromiseFailure(runtimeLogger, "[account] 2FA enable audit persistence failed"));
    res.json({ enabled: true, method: "authenticator", backupCodes });
  })
);

router.get(
  "/passkeys",
  asyncHandler(async (req, res) => {
    const passkeys = await PasskeyCredential.find({ userId: req.user.id })
      .select("name deviceType backedUp createdAt lastUsedAt")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ passkeys: passkeys.map((item) => ({
      id: item._id,
      name: item.name || "Passkey",
      deviceType: item.deviceType || "",
      backedUp: Boolean(item.backedUp),
      createdAt: item.createdAt,
      lastUsedAt: item.lastUsedAt,
    })) });
  })
);

router.post(
  "/passkeys/registration-options",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("email firstName lastName +password");
    if (!user) return res.status(404).json({ error: "User not found" });
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to add a passkey." });
    }
    res.json(await createPasskeyRegistrationOptions(req, user));
  })
);

router.post(
  "/passkeys/register",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("email firstName lastName");
    if (!user) return res.status(404).json({ error: "User not found" });
    try {
      const passkey = await verifyPasskeyRegistration(req, user, {
        challengeId: req.body?.challengeId,
        response: req.body?.response,
        name: req.body?.name,
      });
      await AuditLog.logFromReq(req, "account.passkey.add", {
        targetType: "user",
        targetId: user._id,
        meta: { passkeyId: String(passkey._id) },
      }).catch(logPromiseFailure(runtimeLogger, "[account] passkey add audit persistence failed"));
      res.status(201).json({ id: passkey._id, name: passkey.name });
    } catch (_error) {
      res.status(400).json({ error: "Passkey setup failed or expired. Start again." });
    }
  })
);

router.delete(
  "/passkeys/:passkeyId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(String(req.params.passkeyId || ""))) {
      return res.status(400).json({ error: "Invalid passkey id" });
    }
    const user = await User.findById(req.user.id).select("+password");
    if (!user) return res.status(404).json({ error: "User not found" });
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to remove a passkey." });
    }
    const passkey = await PasskeyCredential.findOneAndDelete({ _id: req.params.passkeyId, userId: user._id });
    if (!passkey) return res.status(404).json({ error: "Passkey not found" });
    await AuditLog.logFromReq(req, "account.passkey.remove", {
      targetType: "user",
      targetId: user._id,
      meta: { passkeyId: String(passkey._id) },
    }).catch(logPromiseFailure(runtimeLogger, "[account] passkey removal audit persistence failed"));
    res.json({ ok: true });
  })
);

router.post(
  "/2fa-backup-codes",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!TWO_FACTOR_ENABLED) {
      return res.status(400).json({ error: "Two-step verification is currently disabled." });
    }
    const user = await User.findById(req.user.id).select("twoFactorEnabled +twoFactorBackupCodes +password");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.twoFactorEnabled) {
      return res.status(409).json({ error: "Enable two-step verification before generating backup codes." });
    }
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to generate backup codes." });
    }

    const codes = generateBackupCodes();
    user.twoFactorBackupCodes = codes.map((code) => hashCode(code));
    await user.save();

    try {
      await AuditLog.logFromReq(req, "account.2fa.backup_codes.rotate", {
        targetType: "user",
        targetId: user._id,
      });
    } catch (auditError) {
      runtimeLogger.error("[account] backup-code regeneration audit persistence failed", auditError);
    }

    res.json({ codes });
  })
);

async function handleDeactivateAccount(req, res) {
  const generalBlockerCopy =
    "Accounts cannot be deactivated while you are involved in an active Matter or while funding, payout, dispute, or other financial obligations remain unresolved.";
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
  } catch (auditError) {
    runtimeLogger.error("[account] deactivation audit persistence failed", auditError);
  }

  try {
    await sendEmail.sendAccountDeactivatedEmail?.(user);
  } catch (err) {
    runtimeLogger.warn("[account] deactivation email failed", err?.message || err);
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
  if (respondToCsrfError(err, res)) return;
  runtimeLogger.error(err);
  res.status(500).json({ error: "Server error" });
});

module.exports = router;
