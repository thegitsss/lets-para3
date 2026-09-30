const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { getAppSettings } = require("../utils/appSettings");
const { isApprovedUser, ensureApprovedUserAuthReady } = require("../utils/authReady");
const { normalizeEmail } = require("../utils/emailVerification");
const { resolve: resolveReturnTarget } = require("../../frontend/assets/scripts/utils/login-return-target");
const {
  CONTEXT_COOKIE, SIGNUP_COOKIE, LINK_COOKIE,
  configuration, cookieOptions, signContext, verifyContext, equal, verifiedProfile,
} = require("../utils/googleOAuth");

const router = express.Router();
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const dashboard = role => role === "paralegal" ? "/dashboard-paralegal.html" : "/dashboard-attorney.html";
const target = (value, role) => resolveReturnTarget(value, role) || dashboard(role);
const errorPage = (code, intent) => `${intent === "signup" ? "/signup.html" : "/login.html"}?google_error=${encodeURIComponent(code)}`;

const googleStartLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

router.get("/google", googleStartLimiter, (req, res) => {
  const config = configuration();
  if (!config) return res.status(503).json({ msg: "Google sign-in is temporarily unavailable." });
  const intent = req.query.intent === "signup" ? "signup" : "login";
  const role = req.query.role === "paralegal" ? "paralegal" : "attorney";
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const next = typeof req.query.next === "string" ? resolveReturnTarget(req.query.next, role) : "";
  res.cookie(CONTEXT_COOKIE, signContext({ purpose: "google_oauth", intent, role, state, nonce, next }, 10),
    cookieOptions(req, 10 * 60 * 1000, "/api/auth/google"));
  const query = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: "code", scope: "openid email profile", state, nonce, prompt: "select_account",
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
});

function installGoogleCallback({ signAccess, authCookieOptions, accessTtlMs }) {
  router.get("/google/callback", asyncHandler(async (req, res) => {
    const config = configuration();
    const context = verifyContext(req.cookies?.[CONTEXT_COOKIE], "google_oauth");
    const intent = context?.intent === "signup" ? "signup" : "login";
    res.clearCookie(CONTEXT_COOKIE, cookieOptions(req, undefined, "/api/auth/google"));
    if (!config) return res.redirect(errorPage("unavailable", intent));
    if (!context || typeof req.query.state !== "string" || !equal(req.query.state, context.state)) {
      return res.redirect(errorPage("invalid_state", intent));
    }
    if (req.query.error || typeof req.query.code !== "string" || !req.query.code) {
      return res.redirect(errorPage("cancelled", intent));
    }

    let profile;
    try { profile = await verifiedProfile(config, req.query.code); }
    catch { return res.redirect(errorPage("oauth_failed", intent)); }
    const sub = String(profile?.sub || "").trim();
    const email = normalizeEmail(profile?.email || "");
    if (!sub || sub.length > 255 || !validEmail(email) || profile?.email_verified !== true ||
        typeof profile?.nonce !== "string" || !equal(profile.nonce, context.nonce)) {
      return res.redirect(errorPage("identity_invalid", intent));
    }

    const user = await User.findOne({ authProviders: { $elemMatch: { provider: "google", providerAccountId: sub } } });
    if (user) {
      if (user.deleted || user.disabled) return res.redirect(errorPage("disabled", "login"));
      if (!isApprovedUser(user)) return res.redirect(errorPage(user.status === "pending" ? "pending" : "not_approved", "login"));
      if (user.emailVerified !== true) return res.redirect(errorPage("email_unverified", "login"));
      if (user.twoFactorEnabled) return res.redirect(errorPage("two_factor_password", "login"));
      const settings = await getAppSettings();
      if (settings?.maintenanceMode && user.role !== "admin") return res.redirect(errorPage("maintenance", "login"));
      if (ensureApprovedUserAuthReady(user)) await user.save();
      user.recordLoginSuccess();
      await user.save();
      res.cookie("token", signAccess(user), authCookieOptions(req, { maxAge: accessTtlMs }));
      await AuditLog.logFromReq(req, "auth.google.login.success", { targetType: "user", targetId: user._id });
      return res.redirect(target(context.next, user.role));
    }

    const emailOwner = await User.findOne({ email, deleted: { $ne: true } }).select("_id");
    if (emailOwner) {
      res.cookie(LINK_COOKIE, signContext({ purpose: "google_link", userId: String(emailOwner._id), sub }, 20),
        cookieOptions(req, 20 * 60 * 1000));
      return res.redirect(errorPage("matching_email_unlinked", "login"));
    }

    const names = String(profile?.name || "").trim().split(/\s+/).filter(Boolean);
    res.cookie(SIGNUP_COOKIE, signContext({
      purpose: "google_signup", sub, email,
      firstName: String(profile?.given_name || names[0] || "").trim().slice(0, 150),
      lastName: String(profile?.family_name || names.slice(1).join(" ")).trim().slice(0, 150),
    }, 20), cookieOptions(req, 20 * 60 * 1000));
    return res.redirect(`/signup.html?google=1&role=${context.role}`);
  }));
}

router.get("/google/signup-profile", (req, res) => {
  const handoff = verifyContext(req.cookies?.[SIGNUP_COOKIE], "google_signup");
  if (!handoff) return res.status(401).json({ msg: "Google signup session expired. Please try again." });
  return res.json({ profile: {
    firstName: handoff.firstName || "", lastName: handoff.lastName || "",
    email: handoff.email, emailVerified: true,
  } });
});

async function linkPendingIdentity(req, res, user) {
  const candidate = verifyContext(req.cookies?.[LINK_COOKIE], "google_link");
  if (!candidate) return false;
  res.clearCookie(LINK_COOKIE, cookieOptions(req));
  if (!equal(candidate.userId, user?._id) || !candidate.sub) return false;
  const owner = await User.findOne({ authProviders: { $elemMatch: { provider: "google", providerAccountId: candidate.sub } } }).select("_id");
  if (owner && String(owner._id) !== String(user._id)) return false;
  const targetUser = await User.findById(user._id).select("+authProviders");
  if (!targetUser) return false;
  if (!(targetUser.authProviders || []).some(entry => entry.provider === "google" && equal(entry.providerAccountId, candidate.sub))) {
    targetUser.authProviders.push({ provider: "google", providerAccountId: candidate.sub, linkedAt: new Date() });
    try { await targetUser.save(); }
    catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }
  await AuditLog.logFromReq(req, "auth.google.link.success", { targetType: "user", targetId: user._id });
  return true;
}

module.exports = { router, installGoogleCallback, linkPendingIdentity };
