const fs = require("fs");
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const {
  MAX_SCANNED_FILE_BYTES,
  listCandidateFiles,
  findSecretViolations,
} = require("../scripts/check-candidate-secrets");

describe("candidate secret checker", () => {
  let fixtureRoot;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-secret-check-"));
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function writeFixture(relative, content) {
    const absolute = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return relative;
  }

  test("lists and scans every candidate when Git output exceeds the default subprocess buffer", () => {
    execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot, stdio: "pipe" });
    const parent = `${"a".repeat(180)}/${"b".repeat(180)}`;
    for (let index = 0; index < 2400; index++) writeFixture(`${parent}/record-${String(index).padStart(4, "0")}-${"c".repeat(100)}.txt`, "");
    const last = writeFixture(`${parent}/zz-final-secret.txt`, ["sk", "test", "x".repeat(24)].join("_"));
    const files = listCandidateFiles(fixtureRoot);
    expect(files).toHaveLength(2401);
    expect(Buffer.byteLength(files.join("\0"))).toBeGreaterThan(1024 * 1024);
    expect(files).toContain(last);
    const violations = findSecretViolations(files, fixtureRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(new RegExp(`^${last}:`));
  });

  test("rejects secret-bearing filenames even when their content looks harmless", () => {
    const relative = writeFixture("config/.env.production", "EXAMPLE=true\n");
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([
      "config/.env.production: secret-bearing filename",
    ]);
  });

  test.each([
    ["Stripe secret", ["sk", "live", "1234567890abcdefghijkl"].join("_")],
    ["Stripe webhook secret", ["whsec", "1234567890abcdefghijkl"].join("_")],
    ["OpenAI project key", ["sk-proj", "1234567890abcdefghijklmnop"].join("-")],
    ["credentialed Mongo URI", ["mongodb+srv://candidate", "password@cluster.example/test"].join(":")],
    ["private key", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
  ])("rejects a %s in an untracked candidate file", (_label, secret) => {
    const relative = writeFixture("new/candidate.txt", `${secret}\n`);
    expect(findSecretViolations([relative], fixtureRoot)).toHaveLength(1);
  });

  test("allows documented placeholder values that cannot authenticate", () => {
    const relative = writeFixture(
      "docs/example.txt",
      "STRIPE_SECRET_KEY=sk_test_mock\nMONGO_URI=mongodb://localhost:27017/test\n"
    );
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([]);
  });

  test("fails closed instead of silently skipping an oversized candidate", () => {
    const relative = "new/oversized.bin";
    const absolute = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.alloc(MAX_SCANNED_FILE_BYTES + 1, 0));
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([
      `${relative}: exceeds the ${MAX_SCANNED_FILE_BYTES}-byte secret-scan limit`,
    ]);
  });

  test("fails closed on a candidate symlink", () => {
    const target = writeFixture("outside/target.txt", "safe\n");
    const relative = "new/candidate-link";
    const absolute = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.symlinkSync(path.join(fixtureRoot, target), absolute);
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([
      `${relative}: symbolic-link candidate cannot be secret-scanned`,
    ]);
  });
});
