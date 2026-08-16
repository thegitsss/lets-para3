const fs = require("fs");
const path = require("path");
const { parseDocument } = require("yaml");

const repositoryRoot = path.resolve(__dirname, "../..");
const defaultCodeownersPath = path.join(repositoryRoot, ".github/CODEOWNERS");
const defaultDependabotPath = path.join(repositoryRoot, ".github/dependabot.yml");
const defaultNpmrcPath = path.join(repositoryRoot, "backend/.npmrc");
const defaultPackagePath = path.join(repositoryRoot, "backend/package.json");

function fail(message) {
  const error = new Error(`[repository-policy] ${message}`);
  error.code = "REPOSITORY_POLICY_FAILED";
  throw error;
}

function activeCodeownerLines(source) {
  return String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function validateCodeowners(source) {
  const lines = activeCodeownerLines(source);
  const catchAll = lines.find((line) => /^\*\s+/.test(line));
  if (!catchAll) fail("CODEOWNERS must have a root catch-all rule so new files cannot bypass review.");

  const owners = catchAll.split(/\s+/).slice(1);
  if (
    !owners.length ||
    owners.some((owner) => !/^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]+)?$/.test(owner))
  ) {
    fail("The CODEOWNERS catch-all must name at least one valid GitHub user or team.");
  }
  return { owners: owners.length };
}

function parseDependabot(source, filePath = defaultDependabotPath) {
  const document = parseDocument(source, {
    maxAliasCount: 10,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    fail(`${filePath} is not valid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return document.toJS({ maxAliasCount: 10 });
}

function validateDependabot(config) {
  if (config?.version !== 2 || !Array.isArray(config.updates)) {
    fail("Dependabot must use version 2 with an updates list.");
  }

  const npm = config.updates.find(
    (entry) => entry?.["package-ecosystem"] === "npm" && entry.directory === "/backend"
  );
  const actions = config.updates.find(
    (entry) => entry?.["package-ecosystem"] === "github-actions" && entry.directory === "/"
  );
  if (!npm) fail("Dependabot must monitor the backend npm dependency graph.");
  if (!actions) fail("Dependabot must monitor GitHub Actions dependencies.");

  for (const [label, entry] of [
    ["npm", npm],
    ["GitHub Actions", actions],
  ]) {
    if (entry.schedule?.interval !== "weekly") fail(`${label} updates must run at least weekly.`);
    if (!Array.isArray(entry.labels) || !entry.labels.includes("dependencies") || !entry.labels.includes("security")) {
      fail(`${label} updates must carry dependencies and security labels.`);
    }
  }
  if (!Number.isInteger(npm["open-pull-requests-limit"]) || npm["open-pull-requests-limit"] < 1) {
    fail("npm updates must have a positive pull-request limit.");
  }

  return { ecosystems: 2 };
}

function validateRepositoryPolicy({ codeownersSource, dependabotSource }) {
  return {
    ...validateCodeowners(codeownersSource),
    ...validateDependabot(parseDependabot(dependabotSource)),
  };
}

function validateNpmConfiguration(source) {
  const settings = new Map(
    String(source)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      })
  );
  if (settings.get("engine-strict") !== "true") fail("backend/.npmrc must fail installs on runtime drift.");
  if (settings.get("audit") !== "false") {
    fail("backend/.npmrc must disable implicit install-time audit submission; the explicit release audit remains required.");
  }
  if (settings.get("fund") !== "false") fail("backend/.npmrc must keep install output release-focused.");
  return { npmSettings: 3 };
}

function validatePackageScripts(packageJson) {
  const scripts = packageJson?.scripts || {};
  if (/console\.log\(\s*["']ok["']\s*\)/i.test(String(scripts.health || ""))) {
    fail("Package scripts must not expose a health command that only prints success.");
  }
  if (scripts["check:backend-reachability"] !== "node scripts/check-backend-reachability.js") {
    fail("Package scripts must expose the backend reachability check.");
  }
  if (!String(scripts["test:ci"] || "").includes("npm run check:backend-reachability")) {
    fail("The CI test command must enforce backend runtime reachability.");
  }
  if (!String(scripts["migrate:production:apply"] || "").includes("npm run migrate:profile-urls:apply")) {
    fail("The production migration chain must include profile URL canonicalization.");
  }
  if (scripts["check:candidate"] !== "node scripts/check-release-candidate.js") {
    fail("Package scripts must expose the exact release-candidate identity gate.");
  }
  if (scripts["verify:production"] !== "node scripts/verify-production-surface.js") {
    fail("Package scripts must expose the exact post-deploy production-surface gate.");
  }
  if (!String(scripts["release:verify"] || "").startsWith("npm run check:candidate &&")) {
    fail("Release verification must reject a dirty or mismatched candidate before all other work.");
  }
  return { packageScriptPolicies: 5 };
}

function main() {
  const result = validateRepositoryPolicy({
    codeownersSource: fs.readFileSync(defaultCodeownersPath, "utf8"),
    dependabotSource: fs.readFileSync(defaultDependabotPath, "utf8"),
  });
  validateNpmConfiguration(fs.readFileSync(defaultNpmrcPath, "utf8"));
  validatePackageScripts(JSON.parse(fs.readFileSync(defaultPackagePath, "utf8")));
  console.log(
    `[repository-policy] CODEOWNERS and Dependabot passed (${result.owners} owner rule, ${result.ecosystems} ecosystems).`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseDependabot,
  validateCodeowners,
  validateDependabot,
  validateNpmConfiguration,
  validatePackageScripts,
  validateRepositoryPolicy,
};
