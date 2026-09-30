const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("./legalDocuments");

const LEGAL_DOCUMENT_FILENAMES = Object.freeze({
  terms: "terms.html",
  privacy: "privacy.html",
});

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function computeLegalDocumentHashes(frontendDir) {
  const root = path.resolve(frontendDir);
  return {
    terms: sha256File(path.join(root, LEGAL_DOCUMENT_FILENAMES.terms)),
    privacy: sha256File(path.join(root, LEGAL_DOCUMENT_FILENAMES.privacy)),
  };
}

function assertLegalDocumentApproval(
  env = process.env,
  { frontendDir = path.resolve(__dirname, "../../frontend") } = {}
) {
  if (env.NODE_ENV !== "production") return true;

  const approvalId = String(env.LEGAL_COUNSEL_APPROVAL_ID || "").trim();
  const approvedTermsVersion = String(env.LEGAL_APPROVED_TERMS_VERSION || "").trim();
  const approvedPrivacyVersion = String(env.LEGAL_APPROVED_PRIVACY_VERSION || "").trim();
  const approvedTermsHash = String(env.LEGAL_APPROVED_TERMS_SHA256 || "").trim().toLowerCase();
  const approvedPrivacyHash = String(env.LEGAL_APPROVED_PRIVACY_SHA256 || "").trim().toLowerCase();

  if (approvalId.length < 8 || approvalId.length > 200) {
    throw new Error("LEGAL_COUNSEL_APPROVAL_ID must reference the recorded counsel approval.");
  }
  if (approvedTermsVersion !== CURRENT_TERMS_VERSION) {
    throw new Error(`LEGAL_APPROVED_TERMS_VERSION must equal ${CURRENT_TERMS_VERSION}.`);
  }
  if (approvedPrivacyVersion !== CURRENT_PRIVACY_VERSION) {
    throw new Error(`LEGAL_APPROVED_PRIVACY_VERSION must equal ${CURRENT_PRIVACY_VERSION}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(approvedTermsHash)) {
    throw new Error("LEGAL_APPROVED_TERMS_SHA256 must be a SHA-256 digest.");
  }
  if (!/^[a-f0-9]{64}$/.test(approvedPrivacyHash)) {
    throw new Error("LEGAL_APPROVED_PRIVACY_SHA256 must be a SHA-256 digest.");
  }

  const actual = computeLegalDocumentHashes(frontendDir);
  if (approvedTermsHash !== actual.terms) {
    throw new Error("The deployed Terms of Service do not match the counsel-approved SHA-256 digest.");
  }
  if (approvedPrivacyHash !== actual.privacy) {
    throw new Error("The deployed Privacy Policy does not match the counsel-approved SHA-256 digest.");
  }
  return true;
}

module.exports = {
  LEGAL_DOCUMENT_FILENAMES,
  assertLegalDocumentApproval,
  computeLegalDocumentHashes,
};
