#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { applyPrivateArtifactUmask, secureEvidenceTree } = require("./private-evidence");

applyPrivateArtifactUmask();

const backendRoot = path.resolve(__dirname, "..");
const evidencePath = path.join(backendRoot, "test-results", "junit", "e2e-results.xml");
const E2E_SUITES = Object.freeze([
  "e2e-auth.js",
  "e2e-profile.js",
  "e2e-validation.js",
  "e2e-job-escrow.js",
  "e2e-matching.js",
  "e2e-messaging.js",
  "e2e-admin.js",
  "e2e-error-handling.js",
  "e2e-payouts.js",
  "e2e-attorney-onboarding.js",
  "e2e-paralegal-tour.js",
  "e2e-case-realtime.js",
  "e2e-withdrawal-flow.js",
]);

function xml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildJUnit(results) {
  const failures = results.filter((result) => !result.passed).length;
  const totalSeconds = results.reduce((sum, result) => sum + result.seconds, 0);
  const cases = results.map((result) => {
    const failure = result.passed
      ? ""
      : `<failure message="${xml(result.message)}">${xml(result.output)}</failure>`;
    return `  <testcase classname="lpc.e2e" name="${xml(result.name)}" time="${result.seconds.toFixed(3)}">${failure}<system-out>${xml(result.output)}</system-out></testcase>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="LPC full E2E" tests="${results.length}" failures="${failures}" errors="0" skipped="0" time="${totalSeconds.toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function runSuite() {
  const results = [];
  for (const name of E2E_SUITES) {
    const startedAt = Date.now();
    console.log(`[e2e] ${name}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--unhandled-rejections=strict"]
          .filter(Boolean)
          .join(" "),
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180_000,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
    if (output) process.stdout.write(`${output}\n`);
    const passed = result.status === 0 && !result.error;
    results.push({
      name,
      passed,
      seconds: (Date.now() - startedAt) / 1000,
      message: result.error?.message || `Exited with code ${result.status ?? "unknown"}`,
      output,
    });
  }

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(evidencePath, buildJUnit(results), { mode: 0o600 });
  secureEvidenceTree();
  const failed = results.filter((result) => !result.passed);
  console.log(`[e2e] ${results.length - failed.length}/${results.length} suites passed; evidence: ${evidencePath}`);
  if (failed.length) {
    console.error(`[e2e] Failed suites: ${failed.map((result) => result.name).join(", ")}`);
    process.exitCode = 1;
  }
  return results;
}

if (require.main === module) runSuite();

module.exports = {
  E2E_SUITES,
  buildJUnit,
  runSuite,
};
