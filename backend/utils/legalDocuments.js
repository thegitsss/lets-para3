const CURRENT_TERMS_VERSION = "2026-08-15";
const CURRENT_PRIVACY_VERSION = "2026-08-15";

function recordSignupPolicyAcknowledgement(user, { now = new Date() } = {}) {
  if (!user || typeof user !== "object") {
    throw new TypeError("A user document is required.");
  }
  const acceptedAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(acceptedAt.getTime())) {
    throw new TypeError("A valid policy acknowledgement time is required.");
  }

  user.termsAccepted = true;
  user.termsVersion = CURRENT_TERMS_VERSION;
  user.termsAcceptedAt = acceptedAt;
  user.privacyVersion = CURRENT_PRIVACY_VERSION;
  user.privacyAcknowledgedAt = acceptedAt;
  return user;
}

module.exports = {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  recordSignupPolicyAcknowledgement,
};
