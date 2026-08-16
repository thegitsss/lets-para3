const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  REQUIRED_CANDIDATE_FILES,
  buildCandidateManifest,
  sha256File,
  writeCandidateManifest,
} = require("../scripts/check-release-candidate");

const COMMIT = "a".repeat(40);

describe("release candidate identity", () => {
  let fixtureRoot;

  beforeEach(() => {
    fixtureRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lpc-release-candidate-"))
    );
    for (const relativePath of REQUIRED_CANDIDATE_FILES) {
      const absolutePath = path.join(fixtureRoot, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const content =
        relativePath === ".node-version"
          ? "24.18.0\n"
          : relativePath === "backend/package.json"
            ? `${JSON.stringify({
                packageManager: "npm@11.16.0",
                engines: { node: ">=24.18 <25", npm: "11.16.0" },
              })}\n`
            : `${relativePath}\n`;
      fs.writeFileSync(
        absolutePath,
        content
      );
    }
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function gitRunner({ dirty = "", commit = COMMIT, branch = "main" } = {}) {
    return (repoRoot, args) => {
      expect(repoRoot).toBe(fixtureRoot);
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return fixtureRoot;
      if (command === "rev-parse HEAD") return commit;
      if (command === "status --porcelain=v1 --untracked-files=all") return dirty;
      if (args[0] === "ls-files") return REQUIRED_CANDIDATE_FILES.join("\n");
      if (command === "symbolic-ref --quiet --short HEAD") return branch;
      throw new Error(`Unexpected git command: ${command}`);
    };
  }

  test("records an exact clean commit and hashes every critical release file", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const manifest = buildCandidateManifest({
      repoRoot: fixtureRoot,
      gitRunner: gitRunner(),
      env: {
        GITHUB_SHA: COMMIT,
        GITHUB_REPOSITORY: "owner/repository",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Quality and security",
      },
      now: () => now,
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      commit: COMMIT,
      branch: "main",
      runtime: {
        pinnedNode: "24.18.0",
        observedNode: "24.18.0",
        pinnedNpm: "11.16.0",
        observedNpm: "11.16.0",
      },
      ci: {
        repository: "owner/repository",
        runId: "123",
        runAttempt: "2",
        workflow: "Quality and security",
      },
    });
    expect(Object.keys(manifest.files)).toEqual(REQUIRED_CANDIDATE_FILES);
    expect(manifest.files["backend/package-lock.json"]).toBe(
      sha256File(path.join(fixtureRoot, "backend/package-lock.json"))
    );
  });

  test("rejects unstaged, staged, or untracked candidate changes", () => {
    expect(() =>
      buildCandidateManifest({
        repoRoot: fixtureRoot,
        gitRunner: gitRunner({ dirty: " M backend/package.json\n?? new-file.js" }),
      })
    ).toThrow(/not clean/);
  });

  test("rejects a CI identity that does not match checked-out HEAD", () => {
    expect(() =>
      buildCandidateManifest({
        repoRoot: fixtureRoot,
        gitRunner: gitRunner(),
        env: { GITHUB_SHA: "b".repeat(40) },
      })
    ).toThrow(/does not match checked-out HEAD/);
  });

  test("rejects a candidate manifest produced with a different npm runtime", () => {
    expect(() =>
      buildCandidateManifest({
        repoRoot: fixtureRoot,
        gitRunner: gitRunner(),
        npmVersionReader: () => "11.15.0",
      })
    ).toThrow(/npm 11\.16\.0 is required/);
  });

  test("rejects a required candidate file that is not a regular file", () => {
    const termsPath = path.join(fixtureRoot, "frontend/terms.html");
    fs.unlinkSync(termsPath);
    fs.symlinkSync(path.join(fixtureRoot, ".node-version"), termsPath);

    expect(() =>
      buildCandidateManifest({ repoRoot: fixtureRoot, gitRunner: gitRunner() })
    ).toThrow(/regular file/);
  });

  test("uses real Git state to accept a clean commit and reject the next dirty change", () => {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: fixtureRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    git(["init", "--quiet"]);
    git(["add", "--", ...REQUIRED_CANDIDATE_FILES]);
    git([
      "-c",
      "user.name=LPC Release Test",
      "-c",
      "user.email=release-test@lets-paraconnect.local",
      "commit",
      "--quiet",
      "-m",
      "candidate fixture",
    ]);

    const manifest = buildCandidateManifest({ repoRoot: fixtureRoot, env: {} });
    expect(manifest.commit).toBe(git(["rev-parse", "HEAD"]));
    expect(Object.keys(manifest.files)).toHaveLength(REQUIRED_CANDIDATE_FILES.length);

    fs.appendFileSync(path.join(fixtureRoot, "backend/package.json"), "dirty\n");
    expect(() => buildCandidateManifest({ repoRoot: fixtureRoot, env: {} })).toThrow(/not clean/);
  });

  test("writes atomic owner-only evidence only under the release evidence directory", () => {
    const outputPath = path.resolve(
      __dirname,
      `../test-results/release/candidate-test-${process.pid}.json`
    );
    try {
      expect(writeCandidateManifest({ schemaVersion: 1 }, outputPath)).toBe(outputPath);
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({ schemaVersion: 1 });
    } finally {
      fs.rmSync(outputPath, { force: true });
    }

    expect(() =>
      writeCandidateManifest({ schemaVersion: 1 }, path.join(os.tmpdir(), "candidate.json"))
    ).toThrow(/must remain under/);
  });
});
