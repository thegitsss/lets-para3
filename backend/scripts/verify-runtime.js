const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "../..");
const packagePath = path.join(repositoryRoot, "backend/package.json");

function parseExactPackageManager(value) {
  const match = /^npm@(\d+\.\d+\.\d+)$/.exec(String(value || "").trim());
  if (!match) throw new Error("package.json packageManager must pin one exact npm version (npm@x.y.z).");
  return match[1];
}

function validateRuntimeVersions({ expectedNode, actualNode, expectedNpm, actualNpm, allowOlderRuntime = false }) {
  const [expectedMajor, expectedMinor] = expectedNode.split(".").map(Number);
  const [actualMajor, actualMinor] = actualNode.split(".").map(Number);

  if (actualMajor !== expectedMajor || actualMinor < expectedMinor) {
    const message = `[runtime] Node ${expectedNode} or a newer ${expectedMajor}.x security release is required; running ${actualNode}.`;
    if (allowOlderRuntime) return { warning: message };
    throw new Error(message);
  }

  if (actualNpm !== expectedNpm) {
    throw new Error(`[runtime] npm ${expectedNpm} is required for reproducible installs; running ${actualNpm}.`);
  }

  return { warning: null };
}

function main() {
  const expectedNode = fs.readFileSync(path.join(repositoryRoot, ".node-version"), "utf8").trim();
  const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const expectedNpm = parseExactPackageManager(packageManifest.packageManager);
  if (packageManifest.engines?.npm !== expectedNpm) {
    throw new Error("package.json engines.npm must exactly match packageManager.");
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const actualNpm = execFileSync(npmCommand, ["--version"], { encoding: "utf8" }).trim();
  const allowOlderRuntime =
    String(process.env.ALLOW_UNSUPPORTED_NODE_FOR_LOCAL_TESTS || "").toLowerCase() === "true" &&
    process.env.CI !== "true" &&
    process.env.NODE_ENV !== "production";
  const result = validateRuntimeVersions({
    expectedNode,
    actualNode: process.versions.node,
    expectedNpm,
    actualNpm,
    allowOlderRuntime,
  });

  if (result.warning) {
    console.warn(`${result.warning} Local test override accepted; CI and production will reject this runtime.`);
    return;
  }

  console.log(
    `[runtime] Node ${process.versions.node} and npm ${actualNpm} satisfy the launch runtime policy.`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { parseExactPackageManager, validateRuntimeVersions };
