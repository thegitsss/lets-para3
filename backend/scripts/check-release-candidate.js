const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  parseExactPackageManager,
  validateRuntimeVersions,
} = require("./verify-runtime");

const repositoryRoot = path.resolve(__dirname, "../..");
const DEFAULT_OUTPUT_PATH = path.join(
  repositoryRoot,
  "backend/test-results/release/candidate.json"
);
const REQUIRED_CANDIDATE_FILES = Object.freeze([
  ".github/workflows/quality.yml",
  ".node-version",
  "LAUNCH_CHECKLIST.md",
  "backend/package.json",
  "backend/package-lock.json",
  "docs/BROWSER_SUPPORT.md",
  "docs/LAUNCH_CERTIFICATION_CURRENT.md",
  "docs/RELEASE_GATES.md",
  "frontend/404.html",
  "frontend/index.html",
  "frontend/privacy.html",
  "frontend/terms.html",
  "public/robots.txt",
  "public/sitemap.xml",
  "render.yaml",
]);

function fail(message) {
  const error = new Error(`[release-candidate] ${message}`);
  error.code = "RELEASE_CANDIDATE_INVALID";
  throw error;
}

function runGit(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "git command failed").trim();
    fail(`${args.join(" ")} failed: ${detail}`);
  }
}

function assertRegularCandidateFile(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!absolutePath.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) {
    fail(`Candidate file escapes the repository: ${relativePath}`);
  }

  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    fail(`Required candidate file is missing: ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`Required candidate path must be a regular file: ${relativePath}`);
  }
  return absolutePath;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function optionalGitBranch(repoRoot, gitRunner) {
  try {
    return gitRunner(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
  } catch {
    return null;
  }
}

function buildCandidateManifest({
  repoRoot = repositoryRoot,
  env = process.env,
  gitRunner = runGit,
  npmVersionReader = () => {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    return execFileSync(npmCommand, ["--version"], { encoding: "utf8" }).trim();
  },
  now = () => new Date(),
} = {}) {
  const resolvedRoot = fs.realpathSync(path.resolve(repoRoot));
  const reportedRoot = fs.realpathSync(
    path.resolve(gitRunner(resolvedRoot, ["rev-parse", "--show-toplevel"]))
  );
  if (reportedRoot !== resolvedRoot) {
    fail(`Expected repository root ${resolvedRoot}, but git reported ${reportedRoot}.`);
  }

  const commit = gitRunner(resolvedRoot, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/i.test(commit)) fail("HEAD is not a full Git commit SHA.");

  const dirty = gitRunner(resolvedRoot, [
    "status",
    "--porcelain=v1",
    // Directory summaries still reject every untracked tree without expanding
    // thousands of generated evidence files into the synchronous output buffer.
    "--untracked-files=normal",
  ]);
  if (dirty) {
    const sample = dirty.split(/\r?\n/).slice(0, 8).join("; ");
    fail(`Working tree or index is not clean (${sample}). Commit the complete reviewed tree before certification.`);
  }

  const githubSha = String(env.GITHUB_SHA || "").trim();
  if (githubSha && githubSha.toLowerCase() !== commit.toLowerCase()) {
    fail(`GITHUB_SHA ${githubSha} does not match checked-out HEAD ${commit}.`);
  }

  gitRunner(resolvedRoot, ["ls-files", "--error-unmatch", ...REQUIRED_CANDIDATE_FILES]);

  const files = {};
  for (const relativePath of REQUIRED_CANDIDATE_FILES) {
    files[relativePath] = sha256File(assertRegularCandidateFile(resolvedRoot, relativePath));
  }

  const pinnedNode = fs
    .readFileSync(assertRegularCandidateFile(resolvedRoot, ".node-version"), "utf8")
    .trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinnedNode)) {
    fail(".node-version must contain one exact semantic version.");
  }
  let packageManifest;
  try {
    packageManifest = JSON.parse(
      fs.readFileSync(assertRegularCandidateFile(resolvedRoot, "backend/package.json"), "utf8")
    );
  } catch (error) {
    fail(`backend/package.json is not valid JSON: ${error.message}`);
  }
  let pinnedNpm;
  try {
    pinnedNpm = parseExactPackageManager(packageManifest.packageManager);
  } catch (error) {
    fail(error.message);
  }
  if (packageManifest.engines?.npm !== pinnedNpm) {
    fail("backend/package.json engines.npm must exactly match packageManager.");
  }
  const observedNpm = String(npmVersionReader() || "").trim();
  try {
    validateRuntimeVersions({
      expectedNode: pinnedNode,
      actualNode: process.versions.node,
      expectedNpm: pinnedNpm,
      actualNpm: observedNpm,
    });
  } catch (error) {
    fail(error.message);
  }

  const generatedAt = now();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    fail("Candidate evidence timestamp is invalid.");
  }

  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    commit,
    branch: optionalGitBranch(resolvedRoot, gitRunner),
    runtime: {
      pinnedNode,
      observedNode: process.versions.node,
      pinnedNpm,
      observedNpm,
    },
    ci: {
      repository: String(env.GITHUB_REPOSITORY || "") || null,
      runId: String(env.GITHUB_RUN_ID || "") || null,
      runAttempt: String(env.GITHUB_RUN_ATTEMPT || "") || null,
      workflow: String(env.GITHUB_WORKFLOW || "") || null,
    },
    files,
  };
}

function assertSafeDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`Evidence directory must be a real directory: ${directoryPath}`);
  }
  if (fs.realpathSync(directoryPath) !== path.resolve(directoryPath)) {
    fail(`Evidence directory cannot traverse a symbolic link: ${directoryPath}`);
  }
}

function writeCandidateManifest(manifest, outputPath = DEFAULT_OUTPUT_PATH) {
  const resolvedOutput = path.resolve(outputPath);
  const allowedRoot = path.resolve(repositoryRoot, "backend/test-results/release");
  if (resolvedOutput !== allowedRoot && !resolvedOutput.startsWith(`${allowedRoot}${path.sep}`)) {
    fail(`Candidate evidence must remain under ${allowedRoot}.`);
  }

  assertSafeDirectory(path.dirname(resolvedOutput));
  const temporaryPath = `${resolvedOutput}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, resolvedOutput);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
  return resolvedOutput;
}

function main() {
  const manifest = buildCandidateManifest();
  const outputPath = writeCandidateManifest(manifest);
  console.log(
    `[release-candidate] Clean commit ${manifest.commit} recorded at ${outputPath} (${Object.keys(manifest.files).length} critical file hashes).`
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
  DEFAULT_OUTPUT_PATH,
  REQUIRED_CANDIDATE_FILES,
  buildCandidateManifest,
  sha256File,
  writeCandidateManifest,
};
