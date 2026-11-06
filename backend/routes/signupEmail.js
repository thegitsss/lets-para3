const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { csrfProtection } = require('../utils/csrf');
const { normalizeEmail, sendVerificationEmail } = require('../utils/emailVerification');
const { createLogger } = require('../utils/logger');
const logger = createLogger('signup-email');
const COOKIE = 'lpc_signup_email';
const COOKIE_PATH = '/api/auth/signup-email';
const COOLDOWN_MS = 60000;
const eligible = user => user && ['attorney', 'paralegal'].includes(user.role)
  && user.status === 'pending' && !user.emailVerified && !user.disabled && !user.deleted && !user.suspended;
const validEmail = value => typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production' || process.env.PROD === 'true', sameSite: 'strict', path: COOKIE_PATH, maxAge: 20 * 60000 });
const fail = (status, message, code) => Object.assign(new Error(message), { signupEmailStatus: status, publicCode: code });

// A just-completed provider signup has no user-chosen password. Bind this
// short-lived, narrowly scoped proof to that browser; never use an inbox link.
function rememberSignup(req, res, user) {
  if (!eligible(user) || !user.authProviders?.length) return;
  const token = jwt.sign({ purpose: 'signup-email-correction', uid: String(user._id),
    ev: Number(user.emailVerificationVersion || 0), av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '20m' });
  res.cookie(COOKIE, token, cookieOptions());
}
function readContext(req) {
  try {
    const proof = jwt.verify(req.cookies?.[COOKIE] || '', process.env.JWT_SECRET);
    return proof.purpose === 'signup-email-correction' && mongoose.isObjectIdOrHexString(proof.uid) ? proof : null;
  } catch { return null; }
}
const matchesContext = (user, proof) => eligible(user) && user.authProviders?.length
  && Number(user.emailVerificationVersion || 0) === proof.ev && Number(user.authVersion || 0) === proof.av;

function signupEmailRoutes({ recordPasswordFailure, dummyPasswordHash }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', async (req, res, next) => {
    try {
      const proof = readContext(req);
      const user = proof && await User.findById(proof.uid).select('+authVersion +authProviders');
      res.json(matchesContext(user, proof || {}) ? { recentSignup: true, email: user.email } : { recentSignup: false });
    } catch (error) { next(error); }
  });
  router.post('/', rateLimit({ windowMs: 15 * 60000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { msg: 'Too many attempts. Please wait 15 minutes before trying again.' } }), csrfProtection, async (req, res, next) => {
    let session;
    try {
      const { email, password, newEmail } = req.body || {};
      const target = normalizeEmail(newEmail);
      if (!validEmail(target)) return res.status(400).json({ msg: 'Enter a valid new email address.' });
      const proof = readContext(req);
      let authenticated = proof && await User.findById(proof.uid).select('+password +authVersion +authProviders');
      const providerContext = matchesContext(authenticated, proof || {});
      if (!providerContext) {
        if (!validEmail(email) || typeof password !== 'string' || !password || password.length > 128) {
          return res.status(401).json({ msg: 'Check your signup email and password, then try again.' });
        }
        authenticated = await User.findOne({ email: normalizeEmail(email) }).select('+password +authVersion +authProviders');
        if (!authenticated) await argon2.verify(await dummyPasswordHash, password).catch(() => false);
        const correct = authenticated && !authenticated.isLocked && await authenticated.comparePassword(password);
        if (!correct || authenticated.disabled || authenticated.deleted || authenticated.suspended) {
          if (authenticated && !authenticated.isLocked) await recordPasswordFailure(authenticated);
          return res.status(401).json({ msg: 'Check your signup email and password, then try again.' });
        }
      }
      if (!eligible(authenticated)) return res.status(409).json({ msg: 'This signup can no longer be changed here. Use account Settings after signing in, or contact support.', code: 'SIGNUP_CLOSED' });
      if (target === normalizeEmail(authenticated.email)) return res.status(400).json({ msg: 'Enter a different email address.' });
      session = await mongoose.startSession();
      let updated;
      await session.withTransaction(async () => {
        const current = await User.findById(authenticated._id).select('+password +authVersion +authProviders').session(session);
        // A concurrent verification, admission, credential change or correction
        // must win over a request authenticated against an older account state.
        if (!eligible(current) || current.isLocked || current.password !== authenticated.password
          || Number(current.authVersion || 0) !== Number(authenticated.authVersion || 0)
          || Number(current.emailVerificationVersion || 0) !== Number(authenticated.emailVerificationVersion || 0)) {
          throw fail(409, 'Your signup changed. Reload this page before trying again.', 'SIGNUP_CHANGED');
        }
        if (current.pendingEmailRequestedAt && Date.now() - current.pendingEmailRequestedAt.getTime() < COOLDOWN_MS) {
          throw fail(429, 'Please wait one minute before requesting another change.', 'SIGNUP_COOLDOWN');
        }
        if (await User.exists({ _id: { $ne: current._id }, $or: [{ email: target }, { pendingEmail: target }] }).session(session)) {
          throw fail(409, 'That address is unavailable. Use a different email or contact support.', 'EMAIL_UNAVAILABLE');
        }
        current.pendingEmail = target;
        current.pendingEmailRequestedAt = new Date();
        current.emailVerificationVersion = Number(current.emailVerificationVersion || 0) + 1;
        await current.save({ session, pathsToSave: ['pendingEmail', 'pendingEmailRequestedAt', 'emailVerificationVersion', 'updatedAt'] });
        await AuditLog.logFromReq(req, 'auth.signup.email_change_requested', { targetType: 'user', targetId: current._id, session });
        updated = current;
      });
      updated.$session(null);
      if (providerContext) rememberSignup(req, res, updated);
      // Delivery is outside the transaction. If it fails, the saved address and
      // old-link invalidation remain authoritative; resending targets the new inbox.
      try {
        const result = await sendVerificationEmail({ user: updated, email: target });
        if (result?.disabled || !(result?.accepted?.length || result?.ok === true)) throw Error('Delivery not confirmed');
      } catch (error) {
        logger.warn('Signup correction email delivery was not confirmed', { code: error.code || error.name });
        return res.status(503).json({ saved: true, email: target, msg: 'Your new address is saved, but we couldn’t confirm email delivery. Check that inbox before requesting another link.' });
      }
      res.json({ ok: true, email: target });
    } catch (error) {
      if (error.signupEmailStatus) {
        if (error.signupEmailStatus === 429) res.set('Retry-After', '60');
        return res.status(error.signupEmailStatus).json({ msg: error.message, code: error.publicCode });
      }
      logger.warn('Signup email correction could not be confirmed', { code: error.code || error.name });
      res.status(503).json({ msg: 'We couldn’t confirm the change. Please reload this page and try again.' });
    } finally { if (session) await session.endSession(); }
  });
  return router;
}
signupEmailRoutes.rememberSignup = rememberSignup;
module.exports = signupEmailRoutes;
