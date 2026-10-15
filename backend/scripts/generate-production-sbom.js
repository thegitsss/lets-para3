const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const backendRoot = path.resolve(__dirname, "..");
const defaultOutputPath = path.join(backendRoot, "test-results/supply-chain/lpc-production.cdx.json");

function fail(message) {
  const error = new Error(`[sbom] ${message}`);
  error.code = "SBOM_GENERATION_FAILED";
  throw error;
}

function validateSbom(sbom) {
  if (sbom?.bomFormat !== "CycloneDX" || String(sbom?.specVersion || "") !== "1.5") {
    fail("npm must emit a CycloneDX 1.5 document.");
  }
  if (sbom?.metadata?.component?.name !== "backend") {
    fail("The SBOM root component must be the LPC backend package.");
  }
  if (!Array.isArray(sbom.components) || sbom.components.length < 1) {
    fail("The production SBOM must contain dependency components.");
  }
  if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length < 1) {
    fail("The production SBOM must contain dependency relationships.");
  }
  return {
    components: sbom.components.length,
    dependencies: sbom.dependencies.length,
  };
}

function manifestLicenseEntries(manifest = {}) {
  const declared = manifest.license ?? manifest.licenses;
  const values = Array.isArray(declared) ? declared : [declared];
  const labels = values
    .map((value) => (typeof value === "string" ? value : value?.type))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(labels)].map((label) => ({ license: { id: label } }));
}

function enrichMissingLicenses(sbom, root = backendRoot) {
  const nodeModulesRoot = path.join(root, "node_modules");
  let enriched = 0;
  for (const component of sbom.components || []) {
    if (Array.isArray(component.licenses) && component.licenses.length) continue;
    const packagePath = component.properties?.find(
      (property) => property?.name === "cdx:npm:package:path"
    )?.value;
    if (!packagePath) continue;

    const manifestPath = path.resolve(root, String(packagePath), "package.json");
    if (!manifestPath.startsWith(`${nodeModulesRoot}${path.sep}`) || !fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (
      String(manifest.name || "") !== String(component.name || "") ||
      String(manifest.version || "") !== String(component.version || "")
    ) {
      continue;
    }
    const licenses = manifestLicenseEntries(manifest);
    if (!licenses.length) continue;
    component.licenses = licenses;
    component.properties = [
      ...(component.properties || []),
      {
        name: "lpc:license:evidence",
        value: `${String(packagePath).replace(/\\/g, "/")}/package.json`,
      },
    ];
    enriched += 1;
  }
  return { enriched };
}

function npmInvocation(env = process.env) {
  const npmCli = String(env.npm_execpath || "").trim();
  if (!npmCli || !path.isAbsolute(npmCli)) {
    fail("Run this command through npm so the exact npm CLI is known.");
  }
  return {
    command: process.execPath,
    args: [npmCli, "sbom", "--omit=dev", "--sbom-format=cyclonedx"],
  };
}

function npmTreeInvocation(env = process.env) {
  const npmCli = String(env.npm_execpath || "").trim();
  if (!npmCli || !path.isAbsolute(npmCli)) {
    fail("Run this command through npm so the exact npm CLI is known.");
  }
  return {
    command: process.execPath,
    args: [npmCli, "ls", "--omit=dev", "--all", "--json"],
  };
}

function validateProductionTree(tree, exitStatus = 0) {
  const problems = Array.isArray(tree?.problems)
    ? tree.problems.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (exitStatus !== 0 || problems.length) {
    const summary = problems.slice(0, 8).join("; ") || `npm ls exited with status ${exitStatus}`;
    fail(`Installed production dependency tree is not clean (${summary}). Run npm ci before generating release evidence.`);
  }
  return { problems: 0 };
}

function inspectProductionTree(env = process.env) {
  const invocation = npmTreeInvocation(env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: backendRoot,
    encoding: "utf8",
    env,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) fail(`npm ls could not start: ${result.error.message}`);
  let tree;
  try {
    tree = JSON.parse(result.stdout);
  } catch {
    fail(`npm ls did not return valid JSON (status ${result.status}).`);
  }
  return validateProductionTree(tree, result.status);
}

function generateProductionSbom({ outputPath = defaultOutputPath, env = process.env } = {}) {
  inspectProductionTree(env);
  const invocation = npmInvocation(env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: backendRoot,
    encoding: "utf8",
    env,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) fail(`npm sbom could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`npm sbom exited with status ${result.status}: ${String(result.stderr || "").trim().slice(0, 1000)}`);
  }

  let sbom;
  try {
    sbom = JSON.parse(result.stdout);
  } catch {
    fail("npm sbom did not return valid JSON.");
  }
  const licenseEvidence = enrichMissingLicenses(sbom);
  const summary = validateSbom(sbom);

  const resolvedOutput = path.resolve(outputPath);
  const expectedRoot = `${path.join(backendRoot, "test-results")}${path.sep}`;
  if (!resolvedOutput.startsWith(expectedRoot)) fail("SBOM output must remain under backend/test-results.");
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const temporaryPath = `${resolvedOutput}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, resolvedOutput);

  return { outputPath: resolvedOutput, ...summary, ...licenseEvidence };
}

function main() {
  const result = generateProductionSbom();
  process.stdout.write(
    `[sbom] Wrote ${result.outputPath} (${result.components} components, ${result.dependencies} dependency relationships, ${result.enriched} license record(s) sourced from installed manifests).\n`
  );
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
  generateProductionSbom,
  enrichMissingLicenses,
  inspectProductionTree,
  manifestLicenseEntries,
  npmInvocation,
  npmTreeInvocation,
  validateSbom,
  validateProductionTree,
};
