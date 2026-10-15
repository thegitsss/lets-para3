const fs = require("fs");
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const {
  MAX_SCAN_WINDOW_BYTES,
  listCandidateFiles,
  findSecretViolations,
} = require("../scripts/check-candidate-secrets");

describe("candidate secret checker", () => {
  let fixtureRoot;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-secret-check-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  test("fully scans a large binary candidate without excluding its bytes", () => {
    const relative = "new/oversized.bin";
    const absolute = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.alloc(MAX_SCAN_WINDOW_BYTES * 2 + 1, 0));
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([]);
    fs.appendFileSync(absolute, ["sk", "live", "x".repeat(24)].join("_"));
    expect(findSecretViolations([relative], fixtureRoot)).toHaveLength(1);
  });

  test.each([63, 65535, MAX_SCAN_WINDOW_BYTES - 1])("detects a secret crossing a boundary at byte %s", offset => {
    const secret = ["sk", "test", "x".repeat(24)].join("_");
    const relative = writeFixture("new/boundary.bin", Buffer.concat([Buffer.alloc(offset, 0), Buffer.from(secret)]));
    expect(findSecretViolations([relative], fixtureRoot)).toHaveLength(1);
  });

  test("detects a credentialed Mongo URI spanning several reads", () => {
    const relative = writeFixture("new/mongo.txt", "mongodb://candidate:" + "x".repeat(150000) + "@cluster.example/test");
    expect(findSecretViolations([relative], fixtureRoot)).toHaveLength(1);
  });

  test("fails closed instead of truncating an unfinished credential segment", () => {
    const relative = writeFixture("new/unfinished.txt", "mongodb://candidate:" + "x".repeat(MAX_SCAN_WINDOW_BYTES + 1));
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([
      `${relative}: exceeds the ${MAX_SCAN_WINDOW_BYTES}-byte secret-scan window`,
    ]);
  });

  test("fails closed when a listed candidate is no longer readable", () => {
    expect(findSecretViolations(["new/missing.txt"], fixtureRoot)).toEqual([
      "new/missing.txt: candidate could not be read completely",
    ]);
  });

  test("rejects an opaque directory entry instead of silently skipping it", () => {
    writeFixture("nested/source.txt", "safe\n");
    expect(findSecretViolations(["nested/"], fixtureRoot)).toEqual([
      "nested/: candidate is not a regular file",
    ]);
  });

  test("rejects a candidate replaced while its original descriptor is being scanned", () => {
    const relative = writeFixture("new/replaced.txt", "safe\n");
    const absolute = path.join(fixtureRoot, relative);
    const read = fs.readSync;
    let replaced = false;
    jest.spyOn(fs, "readSync").mockImplementation((...args) => {
      const bytes = read(...args);
      if (!replaced) {
        replaced = true;
        fs.renameSync(absolute, absolute + ".previous");
        fs.writeFileSync(absolute, "safe\n");
      }
      return bytes;
    });
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([
      `${relative}: candidate changed while it was being scanned`,
    ]);
  });

  test("rejects a candidate extended while it is being scanned", () => {
    const relative = writeFixture("new/extended.txt", "safe\n");
    const absolute = path.join(fixtureRoot, relative);
    const read = fs.readSync;
    let extended = false;
    jest.spyOn(fs, "readSync").mockImplementation((...args) => {
      const bytes = read(...args);
      if (!extended) {
        extended = true;
        fs.appendFileSync(absolute, "more safe bytes\n");
      }
      return bytes;
    });
    expect(findSecretViolations([relative], fixtureRoot)).toEqual([
      `${relative}: candidate changed while it was being scanned`,
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
