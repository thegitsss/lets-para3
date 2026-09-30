const path = require("path");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../utils/legalDocuments");
const {
  assertLegalDocumentApproval,
  computeLegalDocumentHashes,
} = require("../utils/legalDocumentApproval");

const frontendDir = path.resolve(__dirname, "../../frontend");

function approvedEnvironment(overrides = {}) {
  const hashes = computeLegalDocumentHashes(frontendDir);
  return {
    NODE_ENV: "production",
    LEGAL_COUNSEL_APPROVAL_ID: "counsel-approval-test-record",
    LEGAL_APPROVED_TERMS_VERSION: CURRENT_TERMS_VERSION,
    LEGAL_APPROVED_PRIVACY_VERSION: CURRENT_PRIVACY_VERSION,
    LEGAL_APPROVED_TERMS_SHA256: hashes.terms,
    LEGAL_APPROVED_PRIVACY_SHA256: hashes.privacy,
    ...overrides,
  };
}

describe("legal document launch approval", () => {
  test("permits non-production tooling without an approval record", () => {
    expect(assertLegalDocumentApproval({ NODE_ENV: "test" }, { frontendDir })).toBe(true);
  });

  test("requires a recorded approval and exact deployed document digests", () => {
    expect(assertLegalDocumentApproval(approvedEnvironment(), { frontendDir })).toBe(true);
    expect(() => assertLegalDocumentApproval(
      approvedEnvironment({ LEGAL_COUNSEL_APPROVAL_ID: "" }),
      { frontendDir }
    )).toThrow(/counsel approval/i);
    expect(() => assertLegalDocumentApproval(
      approvedEnvironment({ LEGAL_APPROVED_PRIVACY_SHA256: "0".repeat(64) }),
      { frontendDir }
    )).toThrow(/Privacy Policy.*approved/i);
  });
});
