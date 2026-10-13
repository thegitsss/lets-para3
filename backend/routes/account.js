const { normalizePrimaryState } = require("../utils/primaryState");
const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:account");
// backend/routes/account.js
const router = require("express").Router();
const crypto = require("crypto");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const User = require("../models/User");
const accountWriteGuard = require("../utils/accountWriteGuard");
const securityGuard = require("../utils/accountSecurityGuard");
const closureGuard = require("../utils/accountClosureGuard");
const AuditLog = require("../models/AuditLog");
const savedViewPersistence = require("../services/dashboardSavedViewPersistence");
const { deactivateUserAccount, getAccountDeactivationEligibility, getAccountDeactivationReview } = require("../services/userDeletion");
const { hasApprovedPhoto } = require("../utils/paralegalProfile");
const { normalizeAccountTheme, parseAccountTheme } = require("../utils/accountPreferences");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const AuthChallenge = require("../models/AuthChallenge");
const PasskeyCredential = require("../models/PasskeyCredential");
const { validateNewPassword } = require("../utils/passwordPolicy");
const {
  listActiveSessions,
  pageActiveSessions,
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
  DashboardSavedViewError,
  normalizeDashboardSavedView,
} = require("../services/dashboardSavedViews");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(error => { if (!accountWriteGuard.respond(error, res)) next(error); });
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

// A short-lived, owner-issued capability can check only current closure state
// after the initiating session has ended. It never authorizes a mutation.
router.get("/deactivate-result", closureGuard.privateResponse, asyncHandler(async (req, res) => {
  res.json(await closureGuard.result(req));
}));

router.use(verifyToken);
router.use(requireApproved);

router.get(
  "/preferences",
  asyncHandler(async (req, res) => {
    accountWriteGuard.checkOwner(req, req.query);
    const user = await User.findById(req.user.id).select("notificationPrefs preferences location state");
    if (!user) return res.status(404).json({ error: "User not found" });
    const prefs = user.notificationPrefs || {};
    res.json({
      email: !!prefs.email,
      theme: normalizeAccountTheme(user.preferences?.theme),
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
    accountWriteGuard.checkOwner(req);
    const { email, theme, state, fontSize, hideProfile } = req.body || {};
    const updates = {};
    let user = await User.findById(req.user.id)
      .select("notificationPrefs preferences location state role profilePhotoStatus profileImage avatarURL");
    if (!user) return res.status(404).json({ error: "User not found" });
    const fields = { email: ["notificationPrefs.email"], theme: ["preferences.theme"], fontSize: ["preferences.fontSize"], hideProfile: ["preferences.hideProfile", ...(hideProfile === false ? ["profilePhotoStatus", "profileImage", "avatarURL"] : [])], state: ["state", "location"] };
    const accountFilter = accountWriteGuard.prepareWrite(req, user, {
      fields: Object.fromEntries(Object.entries(fields).filter(([key]) => Object.hasOwn(req.body || {}, key))),
      current: { email: user.notificationPrefs?.email !== false, theme: normalizeAccountTheme(user.preferences?.theme), fontSize: user.preferences?.fontSize || "md", hideProfile: user.preferences?.hideProfile === true, state: user.location || user.state || "" },
    });

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "email")) {
      updates["notificationPrefs.email"] = !!email;
      user.set("notificationPrefs.email", !!email);
    }

    const normalizedTheme = parseAccountTheme(theme);
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
    if (normalizedTheme) { updates["preferences.theme"] = normalizedTheme; user.set("preferences.theme", normalizedTheme); }
    if (normalizedFontSize) { updates["preferences.fontSize"] = normalizedFontSize; user.set("preferences.fontSize", normalizedFontSize); }
    if (normalizedHideProfile !== null) { updates["preferences.hideProfile"] = normalizedHideProfile; user.set("preferences.hideProfile", normalizedHideProfile); }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "state")) {
      const normalizedState =
        normalizePrimaryState(state);
      if (!normalizedState) {
        return res.status(400).json({ error: "Invalid state selection" });
      }
      // Recommendation, profile, and legacy directory callers do not all read
      // the same field yet. Keep the canonical state and its compatibility
      // alias synchronized so a saved jurisdiction cannot appear to revert on
      // the next authenticated refresh.
      updates.state = normalizedState; updates.location = normalizedState;
      user.state = normalizedState;
      user.location = normalizedState;
    }

    // Persist only validated, explicitly requested leaves. Mongoose defaults on
    // older accounts must not replace views created after this preferences read.
    updates.updatedAt = new Date();
    const persisted = await User.collection.updateOne(accountFilter || { _id: user._id, role: req.user.role, status: "approved" }, { $set: updates });
    if (!persisted.matchedCount) {
      if (accountFilter) throw accountWriteGuard.conflict();
      return res.status(403).json({ error: "Account unavailable" });
    }
    user.updatedAt = updates.updatedAt;
    if (accountFilter) user = await User.findById(user._id).select("notificationPrefs preferences location state role updatedAt");

    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "account_preferences_refresh",
    });

    res.json({
      success: true,
      preferences: {
        email: user.notificationPrefs?.email !== false,
        theme:
          accountFilter ? normalizeAccountTheme(user.preferences?.theme) : normalizedTheme || normalizeAccountTheme(user.preferences?.theme),
        fontSize: accountFilter ? user.preferences?.fontSize || "md" : normalizedFontSize || user.preferences?.fontSize || "md",
        hideProfile:
          accountFilter ? user.preferences?.hideProfile === true : normalizedHideProfile !== null
            ? normalizedHideProfile
            : user.preferences?.hideProfile || false,
      },
      state: user.location || "",
      updatedAt: user.updatedAt || null,
    });
  })
);

router.get(
  "/dashboard-views",
  asyncHandler(async (req, res) => {
    const scope = String(req.query.scope || "").trim().toLowerCase();
    if (!DASHBOARD_VIEW_SCOPES.includes(scope)) return res.status(400).json({ error: "Invalid dashboard view scope" });
    if (!canUseDashboardViewScope(req.user, scope)) return res.status(403).json({ error: "Dashboard view scope unavailable" });
    if (req.query.expectedOwnerId && req.query.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ error: "Verify your account.", code: "SAVED_VIEW_ACCOUNT_CHANGED" });
    const user = await User.collection.findOne({ _id: new User.base.Types.ObjectId(req.user.id), role: req.user.role, status: "approved" });
    if (!user) return res.status(403).json({ error: "Account unavailable", code: "SAVED_VIEW_ACCOUNT_CHANGED" });
    const stored = savedViewPersistence.rawViews(user);
    if (!stored) return res.status(409).json({ error: "Saved views require review.", code: "SAVED_VIEW_STORAGE_INVALID" });
    const views = stored.filter((view) => view?.scope === scope).map(savedViewPersistence.dto).sort((a, b) => a.name.localeCompare(b.name));
    res.set("Cache-Control", "no-store");
    res.json({ ownerId: String(user._id), scope, views });
  })
);

router.post(
  "/dashboard-views",
  csrfProtection,
  asyncHandler(async (req, res) => {
    let input;
    try { input = normalizeDashboardSavedView(req.body || {}); }
    catch (error) {
      if (error instanceof DashboardSavedViewError) return res.status(400).json({ error: "Invalid saved view", code: error.code });
      throw error;
    }
    if (!canUseDashboardViewScope(req.user, input.scope)) return res.status(403).json({ error: "Dashboard view scope unavailable" });
    {
      if (req.body.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ error: "Verify your account.", code: "SAVED_VIEW_ACCOUNT_CHANGED" });
      if (!input.id || !(req.body.revision === null || /^[a-f0-9]{64}$/.test(req.body.revision || ""))) return res.status(428).json({ error: "Review the saved view before saving.", code: "SAVED_VIEW_REVIEW_REQUIRED" });
    }
    const result = await savedViewPersistence.mutateSavedView(User, { userId: req.user.id, role: req.user.role, scope: input.scope, input, revision: req.body.revision });
    res.set("Cache-Control", "no-store");
    if (result.error) return res.status(result.status).json({ error: "Saved view could not be saved. Check your saved views.", code: result.error });
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString(), type: "dashboard_views_refresh" });
    res.status(result.status).json({ view: result.view });
  })
);

router.delete(
  "/dashboard-views/:scope/:viewId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const scope = String(req.params.scope || "").trim().toLowerCase(), viewId = String(req.params.viewId || "").trim();
    if (!DASHBOARD_VIEW_SCOPES.includes(scope) || !viewId || viewId.length > 80) return res.status(400).json({ error: "Invalid saved view" });
    if (!canUseDashboardViewScope(req.user, scope)) return res.status(403).json({ error: "Dashboard view scope unavailable" });
    {
      if (req.body?.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ error: "Verify your account.", code: "SAVED_VIEW_ACCOUNT_CHANGED" });
      if (!/^[a-f0-9]{64}$/.test(req.body?.revision || "")) return res.status(428).json({ error: "Review the saved view before deleting.", code: "SAVED_VIEW_REVIEW_REQUIRED" });
    }
    const result = await savedViewPersistence.mutateSavedView(User, { userId: req.user.id, role: req.user.role, scope, viewId, revision: req.body?.revision, remove: true });
    res.set("Cache-Control", "no-store");
    if (result.error) return res.status(result.status).json({ error: "Saved view could not be deleted. Check your saved views.", code: result.error });
    publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString(), type: "dashboard_views_refresh" });
    res.json({ ok: true });
  })
);

router.use(["/update-password", "/2fa", "/2fa-toggle", "/2fa-backup-codes", "/passkeys", "/sessions"], (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  try { securityGuard.owner(req, req.method === "GET" ? req.query : req.body); next(); }
  catch (error) { if (!accountWriteGuard.respond(error, res)) next(error); }
});

router.post(
  "/update-password",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required." });
    }
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id));
    const user = state.user;

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
    await securityGuard.atomic(req, state, async (session) => {
      await securityGuard.save(user, state, session);
      await revokeAllUserSessions(user._id, "password_change", { session });
    });
    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "session_revoked_refresh",
    });

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
    const state = await securityGuard.snapshot(req.user.id);
    const user = state.user;
    const boundary = { securityRevision: state.revision, sessionManaged: Boolean(req.authSessionId) };
    if (!TWO_FACTOR_ENABLED) return res.json({ enabled: false, method: "email", hasBackupCodes: false, disabled: true, ...boundary });
    res.json({
      enabled: !!user.twoFactorEnabled,
      method: user.twoFactorMethod || "email",
      hasBackupCodes: Array.isArray(user.twoFactorBackupCodes) && user.twoFactorBackupCodes.length > 0,
      ...boundary,
    });
  })
);

router.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const actor = req.user?.id || req.user?._id;
    if (!actor) return res.json({ sessions: [] });
    const dto = (item) => ({
      id: item.sessionId, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt,
      expiresAt: item.expiresAt, ua: item.userAgent || "", ip: item.ip || "",
      current: String(item.sessionId) === String(req.authSessionId || ""),
    });
    if (securityGuard.owner(req, req.query)) {
      const result = await pageActiveSessions(actor, { cursor: req.query.cursor, currentSessionId: req.authSessionId });
      return res.json({ sessions: result.sessions.map(dto), currentSession: result.currentSession ? dto(result.currentSession) : null, nextCursor: result.nextCursor, total: result.total });
    }
    const sessions = await listActiveSessions(actor);
    res.json({ sessions: sessions.map(dto) });
  })
);

router.delete(
  "/sessions/:sessionId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const actor = req.user?.id || req.user?._id;
    const sessionId = String(req.params.sessionId || "");
    const state = securityGuard.prepare(req, await securityGuard.snapshot(actor), { revision: false });
    await securityGuard.atomic(req, state, async (session) => {
      const revoked = await revokeSession(sessionId, actor, "user_revoked", { session });
      if (!revoked) throw securityGuard.error(404, "SECURITY_SESSION_NOT_FOUND", "Session not found.");
    });
    publishNotificationEvent(actor, "notifications", {
      at: new Date().toISOString(),
      type: "session_revoked_refresh",
    });
    res.json({ ok: true, currentSessionRevoked: sessionId === String(req.authSessionId || "") });
  })
);

router.post(
  "/sessions/revoke-others",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const actor = req.user?.id || req.user?._id;
    const state = securityGuard.prepare(req, await securityGuard.snapshot(actor), { revision: false, requireManaged: true });
    const revokedCount = await securityGuard.atomic(req, state, (session) => revokeAllUserSessions(actor, "user_revoked_others", {
      exceptSessionId: req.authSessionId, session,
    }));
    publishNotificationEvent(actor, "notifications", {
      at: new Date().toISOString(),
      type: "session_revoked_refresh",
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
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id), { requireManaged: true });
    const user = state.user;
    if (state.guarded && typeof req.body?.enabled !== "boolean") throw accountWriteGuard.invalid();

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
    await securityGuard.atomic(req, state, async (session) => {
      await securityGuard.save(user, state, session);
      await revokeAllUserSessions(user._id, "two_factor_change", { exceptSessionId: req.authSessionId, session });
    });
    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "account_security_refresh",
    });

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
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id), { requireManaged: true });
    const user = state.user;
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to set up an authenticator app." });
    }

    const enrollment = await createTotpEnrollment(user.email);
    const challengeId = newChallengeId();
    await securityGuard.atomic(req, state, async (session) => {
      await AuthChallenge.updateMany(
        { userId: user._id, purpose: "totp_enrollment", consumedAt: null },
        { $set: { consumedAt: new Date() } }, { session }
      );
      await AuthChallenge.create([{
        challengeId, userId: user._id, purpose: "totp_enrollment", challenge: newChallengeId(),
        metadata: { encryptedSecret: enrollment.encryptedSecret, failedAttempts: 0, ...(state.guarded ? { securityContext: securityGuard.context(req, state) } : {}) },
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }], { session });
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
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id), { requireManaged: true });
    const user = state.user;
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
    securityGuard.assertChallenge(req, state, challenge);
    const result = await verifyTotp({ encryptedSecret: challenge.metadata.encryptedSecret, token: code });
    const backupCodes = result.valid ? generateBackupCodes() : null;
    const failedAttempts = Number(challenge.metadata.failedAttempts || 0) + 1;
    await securityGuard.atomic(req, state, async (session) => {
      const filter = { _id: challenge._id, consumedAt: null, expiresAt: { $gt: new Date() }, "metadata.failedAttempts": challenge.metadata.failedAttempts ?? { $exists: false } };
      const update = result.valid ? { $set: { consumedAt: new Date() } } : { $set: { "metadata.failedAttempts": failedAttempts, ...(failedAttempts >= 5 ? { consumedAt: new Date() } : {}) } };
      const claimed = await AuthChallenge.updateOne(filter, update, { session });
      if (claimed.modifiedCount !== 1) throw securityGuard.conflict();
      if (!result.valid) return;
      user.twoFactorEnabled = true;
      user.twoFactorMethod = "authenticator";
      user.totpSecretEncrypted = challenge.metadata.encryptedSecret;
      user.totpLastUsedTimeStep = null;
      user.twoFactorBackupCodes = backupCodes.map((item) => hashCode(item));
      await securityGuard.save(user, state, session);
      await revokeAllUserSessions(user._id, "two_factor_change", { exceptSessionId: req.authSessionId, session });
    });
    if (!result.valid) return res.status(failedAttempts >= 5 ? 429 : 400).json({
      error: failedAttempts >= 5 ? "Too many attempts. Start setup again." : "That code is not valid. Try the current code from your app.",
    });
    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "account_security_refresh",
    });
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
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id), { requireManaged: true });
    const user = state.user;
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to add a passkey." });
    }
    const result = await securityGuard.atomic(req, state, (session) => createPasskeyRegistrationOptions(req, user, { session, ...(state.guarded ? { securityContext: securityGuard.context(req, state) } : {}) }));
    res.json(result);
  })
);

router.post(
  "/passkeys/register",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id), { requireManaged: true });
    const user = state.user;
    try {
      const passkey = await securityGuard.atomic(req, state, (session) => verifyPasskeyRegistration(req, user, {
        challengeId: req.body?.challengeId,
        response: req.body?.response,
        name: req.body?.name,
        session,
        ...(state.guarded ? { securityContext: securityGuard.context(req, state) } : {}),
      }));
      await AuditLog.logFromReq(req, "account.passkey.add", {
        targetType: "user",
        targetId: user._id,
        meta: { passkeyId: String(passkey._id) },
      }).catch(logPromiseFailure(runtimeLogger, "[account] passkey add audit persistence failed"));
      publishNotificationEvent(user._id, "notifications", {
        at: new Date().toISOString(),
        type: "account_security_refresh",
      });
      res.status(201).json({ id: passkey._id, name: passkey.name });
    } catch (_error) {
      if (accountWriteGuard.respond(_error, res)) return;
      if (String(_error?.name || "").startsWith("Mongo") || typeof _error?.code === "number") {
        throw securityGuard.error(503, "SECURITY_CHANGE_UNCONFIRMED", "The passkey change could not be confirmed. Check your passkeys before trying again.");
      }
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
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id));
    const user = state.user;
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to remove a passkey." });
    }
    const passkey = await securityGuard.atomic(req, state, async (session) => {
      const removed = await PasskeyCredential.findOneAndDelete({ _id: req.params.passkeyId, userId: user._id }, { session });
      if (!removed) throw securityGuard.error(404, "SECURITY_PASSKEY_NOT_FOUND", "Passkey not found.");
      return removed;
    });
    await AuditLog.logFromReq(req, "account.passkey.remove", {
      targetType: "user",
      targetId: user._id,
      meta: { passkeyId: String(passkey._id) },
    }).catch(logPromiseFailure(runtimeLogger, "[account] passkey removal audit persistence failed"));
    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "account_security_refresh",
    });
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
    const state = securityGuard.prepare(req, await securityGuard.snapshot(req.user.id));
    const user = state.user;
    if (!user.twoFactorEnabled) {
      return res.status(409).json({ error: "Enable two-step verification before generating backup codes." });
    }
    const currentPassword = String(req.body?.currentPassword || "");
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: "Enter your current password to generate backup codes." });
    }

    const codes = generateBackupCodes();
    user.twoFactorBackupCodes = codes.map((code) => hashCode(code));
    await securityGuard.atomic(req, state, (session) => securityGuard.save(user, state, session));
    publishNotificationEvent(user._id, "notifications", {
      at: new Date().toISOString(),
      type: "account_security_refresh",
    });

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
  const guard = closureGuard.prepare(req);
  const generalBlockerCopy =
    "Accounts cannot be deactivated while you are involved in an active Matter or while funding, payout, dispute, or other financial obligations remain unresolved.";
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const eligibility = guard ? null : await getAccountDeactivationEligibility(user);
  if (eligibility && !eligibility.canDeactivate) {
    const specificMessage = eligibility.blockers[0]?.message || "This account cannot be deactivated yet.";
    return res.status(409).json({
      error: `${generalBlockerCopy} ${specificMessage}`.trim(),
      blockers: eligibility.blockers,
    });
  }

  let result;
  try {
    result = await deactivateUserAccount(user, { now: new Date(), ...(guard || {}), ...(guard ? {req} : {}) });
  } catch (error) {
    if (error instanceof accountWriteGuard.AccountWriteError && error.code === 'ACCOUNT_CLOSURE_BLOCKED' && Array.isArray(error.blockers)) {
      return res.status(409).json({error:error.message,code:error.code,blockers:error.blockers});
    }
    throw error;
  }
  publishNotificationEvent(user._id, "notifications", {
    at: new Date().toISOString(),
    type: "account_deactivated_refresh",
  });

  if (!result?.auditRecorded) {
    try {
      await AuditLog.logFromReq(req, "account.deactivate", {
        targetType: "user",
        targetId: user._id,
        meta: { email: user.email || "", role: user.role || "" },
      });
    } catch (auditError) {
      runtimeLogger.error("[account] deactivation audit persistence failed", auditError);
    }
  }

  try {
    await sendEmail.sendAccountDeactivatedEmail?.(user);
  } catch (err) {
    runtimeLogger.warn("[account] deactivation email failed", err?.message || err);
  }

  // Guarded clients clear their local session after verified handoff. A late
  // response must not erase a different account's newly installed cookie.
  if (!guard) {
    res.clearCookie("token");
    const cookieName = process.env.JWT_COOKIE_NAME || "access";
    if (cookieName && cookieName !== "token") res.clearCookie(cookieName);
  }

  return res.json({ ok: true, deactivated: true });
}

router.get(
  "/deactivate-status",
  closureGuard.privateResponse,
  asyncHandler(async (req, res) => {
    const guarded = closureGuard.owner(req, req.query);
    const user = await User.findById(req.user.id).select("_id role disabled deleted");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (guarded) {
      const review = await getAccountDeactivationReview(user);
      return res.json({ownerId:String(user._id),canDeactivate:review.canDeactivate,blockers:review.blockers,closureRevision:review.revision,...closureGuard.issue(req,review.revision)});
    }
    const eligibility = await getAccountDeactivationEligibility(user);
    return res.json(eligibility);
  })
);

router.delete(
  "/deactivate",
  closureGuard.privateResponse,
  csrfProtection,
  asyncHandler(handleDeactivateAccount)
);

router.delete(
  "/delete",
  closureGuard.privateResponse,
  csrfProtection,
  asyncHandler(handleDeactivateAccount)
);

router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  runtimeLogger.error(err);
  res.status(500).json({ error: "Server error" });
});

module.exports = router;
