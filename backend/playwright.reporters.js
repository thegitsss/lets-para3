const path = require("path");
const { applyPrivateArtifactUmask } = require("./scripts/private-evidence");

function normalizePlaywrightColorEnvironment(env = process.env) {
  // Playwright forces color for its workers and web servers. Inheriting
  // NO_COLOR at the same time makes Node emit a warning in every child.
  delete env.NO_COLOR;
  return env;
}

normalizePlaywrightColorEnvironment();
applyPrivateArtifactUmask();

function isCi(env = process.env) {
  return String(env.CI || "").trim().toLowerCase() === "true";
}

function buildPlaywrightReporters(suiteName, env = process.env) {
  const normalizedName = String(suiteName || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedName)) {
    throw new Error("Playwright evidence suite names must be lowercase kebab-case.");
  }

  const reporters = [["list"]];
  if (isCi(env)) {
    reporters.push([
      "junit",
      {
        outputFile: path.join(__dirname, "test-results", "junit", `${normalizedName}.xml`),
        includeProjectInTestName: true,
        stripANSIControlSequences: true,
      },
    ]);
  }
  reporters.push([path.join(__dirname, "playwright.private-evidence-reporter.js")]);
  return reporters;
}

module.exports = {
  buildPlaywrightReporters,
  isCi,
  normalizePlaywrightColorEnvironment,
};
