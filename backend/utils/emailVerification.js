const accountEmails = require("../email/accountTemplates");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const EmailVerificationToken = require("../models/EmailVerificationToken");

const sendEmail = require("./email");

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildEmailVerificationToken({ userId, email, expiresIn }) {
  return jwt.sign(
    {
      purpose: "verify-email",
      uid: String(userId),
      email: normalizeEmail(email),
      jti: crypto.randomBytes(32).toString("hex"),
    },
    process.env.JWT_SECRET,
    expiresIn === undefined ? {} : { expiresIn }
  );
}

function verificationTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createEmailVerificationLink({ user, email }) {
  const targetEmail = normalizeEmail(email || user?.pendingEmail || user?.email);
  if (!user?._id || !targetEmail) return;

  const verifyToken = buildEmailVerificationToken({
    userId: user._id.toString(),
    email: targetEmail,
  });
  const payload = jwt.decode(verifyToken);
  await EmailVerificationToken.create({
    tokenHash: verificationTokenHash(verifyToken), userId: user._id,
    expiresAt: Number.isFinite(payload.exp) ? new Date(payload.exp * 1000) : null,
  });
  return `${process.env.APP_BASE_URL || ""}/verify-email.html?token=${verifyToken}`;
}

async function sendVerificationEmail({ user, email }) {
  const targetEmail = normalizeEmail(email || user?.pendingEmail || user?.email);
  const verifyUrl = await createEmailVerificationLink({ user, email: targetEmail });
  if (!verifyUrl) return;
  const message = accountEmails.emailVerification(user, verifyUrl);
  const result = await sendEmail(targetEmail, message.subject, message.html, { text: message.text, throwOnError: true });
  if (result?.error) throw new Error(result.message || "Verification email delivery failed");
  return result;
}

function applyVerifiedEmail(user, verifiedEmail) {
  const normalized = normalizeEmail(verifiedEmail);
  if (!user || !normalized) return false;

  if (normalizeEmail(user.pendingEmail) === normalized) {
    user.email = normalized;
    user.pendingEmail = null;
    user.pendingEmailRequestedAt = null;
    user.markEmailVerified?.();
    return true;
  }

  if (normalizeEmail(user.email) === normalized) {
    user.markEmailVerified?.();
    return true;
  }

  return false;
}

module.exports = {
  normalizeEmail,
  buildEmailVerificationToken,
  sendVerificationEmail,
  createEmailVerificationLink,
  applyVerifiedEmail,
  verificationTokenHash,
};
