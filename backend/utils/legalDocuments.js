const CURRENT_TERMS_VERSION = "2026-08-15";
const CURRENT_PRIVACY_VERSION = "2026-08-15";

const LEGAL_ACCEPTANCE_SOURCES = Object.freeze([
  "signup",
  "reacceptance",
]);

function normalizeVersion(value) {
  return String(value || "").trim();
}

function validDate(value) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime());
}

function hasCurrentLegalAcceptance(user) {
  if (!user) return false;
  return (
    user.termsAccepted === true &&
    normalizeVersion(user.termsVersion) === CURRENT_TERMS_VERSION &&
    validDate(user.termsAcceptedAt) &&
    normalizeVersion(user.privacyVersion) === CURRENT_PRIVACY_VERSION &&
    validDate(user.privacyAcknowledgedAt)
  );
}

function applyCurrentLegalAcceptance(user, { now = new Date(), source } = {}) {
  if (!user || typeof user !== "object") {
    throw new TypeError("A user document is required.");
  }
  if (!LEGAL_ACCEPTANCE_SOURCES.includes(source)) {
    throw new TypeError("A valid legal acceptance source is required.");
  }
  const acceptedAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(acceptedAt.getTime())) {
    throw new TypeError("A valid legal acceptance time is required.");
  }

  user.termsAccepted = true;
  user.termsVersion = CURRENT_TERMS_VERSION;
  user.termsAcceptedAt = acceptedAt;
  user.privacyVersion = CURRENT_PRIVACY_VERSION;
  user.privacyAcknowledgedAt = acceptedAt;
  user.legalAcceptanceSource = source;
  return user;
}

function serializeLegalAcceptance(user) {
  return {
    required: !hasCurrentLegalAcceptance(user),
    termsVersion: CURRENT_TERMS_VERSION,
    privacyVersion: CURRENT_PRIVACY_VERSION,
  };
}

module.exports = {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  LEGAL_ACCEPTANCE_SOURCES,
  applyCurrentLegalAcceptance,
  hasCurrentLegalAcceptance,
  serializeLegalAcceptance,
};
