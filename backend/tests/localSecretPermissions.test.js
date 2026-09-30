const fs = require("fs");
const os = require("os");
const path = require("path");

const { inspectLocalSecretArtifacts } = require("../scripts/check-local-secret-permissions");

describe("local secret artifact permissions", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-local-secret-policy-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("requires private environment-file permissions without reading secret contents", () => {
    const envPath = path.join(root, ".env");
    fs.writeFileSync(envPath, "SECRET=value\n", { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);

    expect(inspectLocalSecretArtifacts({ root, platform: "darwin" })).toEqual({
      envFiles: [".env"],
      violations: [
        ".env: local environment secret must be owner-only (0600 or stricter)",
      ],
    });

    fs.chmodSync(envPath, 0o600);
    expect(inspectLocalSecretArtifacts({ root, platform: "darwin" })).toEqual({
      envFiles: [".env"],
      violations: [],
    });
  });

  test("rejects retained or publicly traversable browser authentication state", () => {
    const authDirectory = path.join(root, "tests", "playwright", ".auth");
    fs.mkdirSync(authDirectory, { recursive: true, mode: 0o755 });
    fs.chmodSync(authDirectory, 0o755);
    fs.writeFileSync(path.join(authDirectory, "session.json"), "{}", { mode: 0o600 });

    expect(inspectLocalSecretArtifacts({ root, platform: "linux" }).violations).toEqual([
      "tests/playwright/.auth: directory must be owner-only (0700 or stricter)",
      "tests/playwright/.auth: 1 retained authentication-state artifact(s) must be removed by teardown",
    ]);
  });

  test("allows public templates and an empty owner-only auth directory", () => {
    fs.writeFileSync(path.join(root, ".env.example"), "PLACEHOLDER=\n", { mode: 0o644 });
    const authDirectory = path.join(root, "tests", "playwright", ".auth");
    fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });

    expect(inspectLocalSecretArtifacts({ root, platform: "linux" })).toEqual({
      envFiles: [],
      violations: [],
    });
  });

  test("rejects ignored Playwright scratch captures outside governed evidence", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-local-repository-policy-"));
    try {
      fs.mkdirSync(path.join(repositoryRoot, ".playwright-mcp"));
      expect(inspectLocalSecretArtifacts({ root, repositoryRoot, platform: "linux" }).violations).toEqual([
        ".playwright-mcp: ignored browser scratch captures must be removed or moved into governed owner-only evidence",
      ]);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
