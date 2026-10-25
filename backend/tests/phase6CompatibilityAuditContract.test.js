const fs = require("fs");
const path = require("path");

const script = fs.readFileSync(path.join(__dirname, "../scripts/audit-phase6-compatibility.js"), "utf8");
const redirect = fs.readFileSync(path.join(__dirname, "../../frontend/assets/scripts/canonical-redirect.js"), "utf8");
const applicationModel = fs.readFileSync(path.join(__dirname, "../models/Application.js"), "utf8");
const caseModel = fs.readFileSync(path.join(__dirname, "../models/Case.js"), "utf8");

describe("Phase 6 production compatibility audit safety contract", () => {
  test("requires explicit read-only authorization and rejects mutation arguments", () => {
    expect(script).toContain("--confirm-read-only-production-audit");
    expect(script).toContain("FORBIDDEN_ARGUMENT");
    expect(script).toContain("apply|write|update|delete|insert|migrate|backfill|stripe");
  });

  test("uses the raw Mongo client without application models or Stripe", () => {
    expect(script).toContain('require("mongodb")');
    expect(script).not.toMatch(/require\(["']\.\.\/models\//);
    expect(script).not.toMatch(/require\(["']stripe["']\)/);
    expect(script).toContain("retryWrites: false");
    expect(script).toContain('readConcern: { level: "majority" }');
  });

  test("reports aggregate compatibility evidence without record identifiers", () => {
    expect(script).toContain("read_only_aggregate");
    expect(script).toContain("databaseFingerprint");
    expect(script).toContain("applicationMirrors");
    expect(script).toContain("storedThemes");
    expect(script).not.toContain("findOne(");
  });

  test("classifies provenance only from explicit repository evidence", () => {
    expect(script).toContain("KNOWN_TEST_EMAILS");
    expect(script).toContain("EXPLICIT_TEST_DOMAIN");
    expect(script).toContain("shapeBasedInferenceUsed: false");
    expect(script).toContain("No machine-readable real-customer marker exists");
    expect(script).toContain("applicationIssues");
    expect(script).toContain("jobCountIssues");
  });

  test("retains canonical application history and the Case applicant projection", () => {
    expect(applicationModel).toContain("statusHistory");
    expect(applicationModel).toContain("syncStatus");
    expect(caseModel).toContain("applicants: [applicantSchema]");
  });

  test("legacy redirects preserve query parameters and their canonical target hash", () => {
    expect(redirect).toContain("source.searchParams.forEach");
    expect(redirect).toContain("target.searchParams.set");
    expect(redirect).toContain("window.location.replace(target.toString())");
    expect(redirect).not.toContain("target.hash = source.hash");
  });
});
