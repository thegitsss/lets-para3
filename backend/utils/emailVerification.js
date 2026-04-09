const jwt = require("jsonwebtoken");

const sendEmail = require("./email");

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildEmailVerificationToken({ userId, email, expiresIn = "60m" }) {
  return jwt.sign(
    {
      purpose: "verify-email",
      uid: String(userId),
      email: normalizeEmail(email),
    },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

async function sendVerificationEmail({ user, email }) {
  const targetEmail = normalizeEmail(email || user?.pendingEmail || user?.email);
  if (!user?._id || !targetEmail) return;

  const verifyToken = buildEmailVerificationToken({
    userId: user._id.toString(),
    email: targetEmail,
  });
  const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
  await sendEmail(targetEmail, "Verify your email", `Click to verify: ${verifyUrl}`);
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
  applyVerifiedEmail,
};
