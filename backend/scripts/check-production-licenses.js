const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const defaultSbomPath = path.join(backendRoot, "test-results/supply-chain/lpc-production.cdx.json");
const APPROVED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT-0",
]);

function fail(message) {
  const error = new Error(`[licenses] ${message}`);
  error.code = "PRODUCTION_LICENSE_POLICY_FAILED";
  throw error;
}

function componentLabel(component = {}) {
  return `${String(component.name || "unknown")}@${String(component.version || "unknown")}`;
}

function licenseLabels(component = {}) {
  if (!Array.isArray(component.licenses)) return [];
  return component.licenses
    .map((entry) => entry?.license?.id || entry?.license?.name || entry?.expression)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function validateProductionLicenses(sbom) {
  if (sbom?.bomFormat !== "CycloneDX" || String(sbom?.specVersion || "") !== "1.5") {
    fail("License review requires the generated CycloneDX 1.5 production SBOM.");
  }
  if (!Array.isArray(sbom.components) || !sbom.components.length) {
    fail("The production SBOM has no dependency components to review.");
  }

  const missing = [];
  const unapproved = [];
  const counts = new Map();
  for (const component of sbom.components) {
    const labels = licenseLabels(component);
    if (!labels.length) {
      missing.push(componentLabel(component));
      continue;
    }
    for (const license of labels) {
      counts.set(license, (counts.get(license) || 0) + 1);
      if (!APPROVED_LICENSES.has(license)) {
        unapproved.push(`${componentLabel(component)} (${license})`);
      }
    }
  }
  if (missing.length) {
    fail(`Production components are missing license metadata: ${missing.sort().join(", ")}.`);
  }
  if (unapproved.length) {
    fail(`Production components require explicit legal review before use: ${unapproved.sort().join(", ")}.`);
  }

  return {
    components: sbom.components.length,
    licenses: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function checkProductionLicenses(sbomPath = defaultSbomPath) {
  const resolvedPath = path.resolve(sbomPath);
  const expectedRoot = `${path.join(backendRoot, "test-results", "supply-chain")}${path.sep}`;
  if (!resolvedPath.startsWith(expectedRoot)) fail("The license gate only accepts SBOM evidence under backend/test-results/supply-chain.");
  if (!fs.existsSync(resolvedPath)) fail("Generate the production SBOM before running the license gate.");
  const mode = fs.statSync(resolvedPath).mode & 0o777;
  if ((mode & 0o077) !== 0) fail("The local production SBOM must remain owner-readable only.");

  let sbom;
  try {
    sbom = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    fail("The production SBOM is not valid JSON.");
  }
  return validateProductionLicenses(sbom);
}

function main() {
  const result = checkProductionLicenses();
  const licenseSummary = Object.entries(result.licenses)
    .map(([license, count]) => `${license}=${count}`)
    .join(", ");
  process.stdout.write(`[licenses] ${result.components} production components passed (${licenseSummary}).\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVED_LICENSES,
  checkProductionLicenses,
  licenseLabels,
  validateProductionLicenses,
};
