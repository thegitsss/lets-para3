const CURRENT_TERMS_VERSION = "2026-10-01";
const CURRENT_PRIVACY_VERSION = "2026-10-01";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
let currentDocuments;

// Loaded from the same validated frontend tree that Express serves. Fingerprints
// distinguish corrections made on the same effective date.
function getCurrentPolicyDocuments() {
  if (!currentDocuments) {
    const directory = path.resolve(__dirname, "../../frontend");
    currentDocuments = Object.freeze(Object.fromEntries([
      ["terms", CURRENT_TERMS_VERSION], ["privacy", CURRENT_PRIVACY_VERSION],
    ].map(([kind, version]) => {
      const html = fs.readFileSync(path.join(directory, `${kind}.html`), "utf8");
      const hash = crypto.createHash("sha256").update(html).digest("hex");
      return [kind, Object.freeze({ kind, version, hash, html, url: `/api/auth/legal/documents/${kind}/${hash}` })];
    })));
  }
  return currentDocuments;
}

function currentPolicyMetadata() {
  return Object.fromEntries(Object.entries(getCurrentPolicyDocuments()).map(([kind, { html: _html, ...metadata }]) => [kind, metadata]));
}

function hasCurrentPolicyAcknowledgement(user) {
  const documents = getCurrentPolicyDocuments();
  return user?.termsAccepted === true && Boolean(user.termsAcceptedAt) && Boolean(user.privacyAcknowledgedAt)
    && user.termsVersion === documents.terms.version && user.privacyVersion === documents.privacy.version
    && user.termsDocumentHash === documents.terms.hash && user.privacyDocumentHash === documents.privacy.hash;
}

function policySubmissionMatches(body) {
  const documents = getCurrentPolicyDocuments();
  return body?.termsHash === documents.terms.hash && body?.privacyHash === documents.privacy.hash;
}

function recordSignupPolicyAcknowledgement(user, { now = new Date(), source = "signup", sessionId = "" } = {}) {
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
  const documents = getCurrentPolicyDocuments();
  user.termsDocumentHash = documents.terms.hash;
  user.privacyDocumentHash = documents.privacy.hash;
  user.policyAcknowledgements = [...(user.policyAcknowledgements || []), {
    termsVersion: CURRENT_TERMS_VERSION, privacyVersion: CURRENT_PRIVACY_VERSION,
    termsHash: documents.terms.hash, privacyHash: documents.privacy.hash,
    acceptedAt, source, sessionId,
  }];
  return user;
}

module.exports = {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  recordSignupPolicyAcknowledgement,
  getCurrentPolicyDocuments,
  currentPolicyMetadata,
  hasCurrentPolicyAcknowledgement,
  policySubmissionMatches,
};
