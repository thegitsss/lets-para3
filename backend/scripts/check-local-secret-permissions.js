"use strict";

const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const PUBLIC_ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

function isPrivateMode(stats, platform) {
  return platform === "win32" || (stats.mode & 0o077) === 0;
}

function inspectLocalSecretArtifacts({
  root = backendRoot,
  repositoryRoot = path.resolve(root, ".."),
  platform = process.platform,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const violations = [];
  const envFiles = [];

  for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (
      !(entry.name === ".env" || entry.name.startsWith(".env.")) ||
      PUBLIC_ENV_TEMPLATES.has(entry.name)
    ) {
      continue;
    }
    const filePath = path.join(resolvedRoot, entry.name);
    const stats = fs.lstatSync(filePath);
    envFiles.push(entry.name);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      violations.push(`${entry.name}: local environment secret must be a regular file`);
    } else if (!isPrivateMode(stats, platform)) {
      violations.push(`${entry.name}: local environment secret must be owner-only (0600 or stricter)`);
    }
  }

  const authDirectory = path.join(resolvedRoot, "tests", "playwright", ".auth");
  try {
    const stats = fs.lstatSync(authDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      violations.push("tests/playwright/.auth: must be a real directory");
    } else {
      if (!isPrivateMode(stats, platform)) {
        violations.push("tests/playwright/.auth: directory must be owner-only (0700 or stricter)");
      }
      const retained = fs.readdirSync(authDirectory);
      if (retained.length) {
        violations.push(
          `tests/playwright/.auth: ${retained.length} retained authentication-state artifact(s) must be removed by teardown`
        );
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const playwrightScratch = path.join(path.resolve(repositoryRoot), ".playwright-mcp");
  try {
    fs.lstatSync(playwrightScratch);
    violations.push(
      ".playwright-mcp: ignored browser scratch captures must be removed or moved into governed owner-only evidence"
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return { envFiles, violations };
}

function main() {
  const result = inspectLocalSecretArtifacts();
  if (result.violations.length) {
    console.error(`[local-secrets] ${result.violations.join("\n[local-secrets] ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[local-secrets] ${result.envFiles.length} local environment secret file(s) are owner-only; no browser authentication state is retained.`
  );
}

if (require.main === module) main();

module.exports = {
  PUBLIC_ENV_TEMPLATES,
  inspectLocalSecretArtifacts,
  isPrivateMode,
};
