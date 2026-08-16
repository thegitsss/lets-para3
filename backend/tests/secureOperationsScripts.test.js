const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  secureOutputPath,
  writeRefreshToken,
} = require("../scripts/exchange-zoho-grant");
const { createMongoToolConfig } = require("../utils/mongoToolConfig");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");
const { adminSeedConfiguration } = require("../scripts/seedAdmin");
const { directorSeedConfiguration } = require("../scripts/seedDirector");

describe("secure operations scripts", () => {
  let temporaryDirectory;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-zoho-token-"));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  test("writes a Zoho refresh token once to a mode-0600 file outside the repository", () => {
    const target = path.join(temporaryDirectory, "zoho.env");
    expect(writeRefreshToken("refresh-secret", target)).toBe(target);
    expect(fs.readFileSync(target, "utf8")).toBe("ZOHO_MAIL_REFRESH_TOKEN=refresh-secret\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(() => writeRefreshToken("replacement", target)).toThrow(/exist/i);
  });

  test("rejects relative and repository-owned secret output paths", () => {
    expect(() => secureOutputPath("zoho.env")).toThrow(/absolute path/i);
    expect(() => secureOutputPath(path.resolve(__dirname, "..", "zoho.env"))).toThrow(/outside/i);
  });

  test("does not contain a provider-payload or refresh-token console sink", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../scripts/exchange-zoho-grant.js"), "utf8");
    expect(source).not.toMatch(/console\.(?:log|warn|error)\([^\n]*result\.payload/i);
    expect(source).not.toMatch(/console\.(?:log|warn|error)\([^\n]*JSON\.stringify\([^\n]*payload/i);
    expect(source).not.toMatch(/console\.(?:log|warn|error)\([^\n]*result\.payload\.refresh_token/i);
  });

  test("keeps MongoDB credentials out of backup and restore process arguments", () => {
    for (const script of ["backup-db.js", "restore-db.js"]) {
      const source = fs.readFileSync(path.resolve(__dirname, `../scripts/${script}`), "utf8");
      expect(source).toMatch(/createMongoToolConfig/);
      expect(source).toMatch(/"--config"/);
      expect(source).not.toMatch(/\["--uri",\s*MONGO_URI/);
    }
  });

  test("creates and removes a private MongoDB Tools credential file", () => {
    const credentialedMongoUri = ["mongodb+srv://operator", "secret@example.test/lpc"].join(":");
    const config = createMongoToolConfig(credentialedMongoUri);
    const directory = path.dirname(config.filePath);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(config.filePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(config.filePath, "utf8")).toContain(credentialedMongoUri);
    config.cleanup();
    expect(fs.existsSync(directory)).toBe(false);
    expect(() => config.cleanup()).not.toThrow();
    expect(() => createMongoToolConfig("https://example.test/not-mongodb")).toThrow(/MongoDB connection URI/i);
  });

  test("privileged account bootstrap requires an exact target, confirmation, and strong password", () => {
    const shared = {
      MONGO_URI: "mongodb://127.0.0.1:27017/lpc-bootstrap-test",
      ADMIN_EMAIL: "owner@example.test",
      ADMIN_PASSWORD: "unique admin bootstrap passphrase 2026!",
      SEED_ADMIN_CONFIRM_EMAIL: "owner@example.test",
    };
    expect(adminSeedConfiguration(shared)).toMatchObject({
      mongoUri: shared.MONGO_URI,
      email: shared.ADMIN_EMAIL,
      password: shared.ADMIN_PASSWORD,
    });
    expect(() => adminSeedConfiguration({ ...shared, SEED_ADMIN_CONFIRM_EMAIL: "wrong@example.test" }))
      .toThrow(/must exactly match/i);
    expect(() => adminSeedConfiguration({ ...shared, ADMIN_PASSWORD: "Admin123!" }))
      .toThrow(/at least 15 characters/i);
    expect(() => adminSeedConfiguration({ ...shared, MONGO_URI: "" }))
      .toThrow(/exact MongoDB database/i);

    const director = {
      MONGO_URI: shared.MONGO_URI,
      DIRECTOR_EMAIL: "director@example.test",
      DIRECTOR_PASSWORD: "unique director bootstrap passphrase 2026!",
      SEED_DIRECTOR_CONFIRM_EMAIL: "director@example.test",
      DIRECTOR_ACTIVE_STATE: "NY",
    };
    expect(directorSeedConfiguration(director)).toMatchObject({
      email: director.DIRECTOR_EMAIL,
      activeState: "NY",
      password: director.DIRECTOR_PASSWORD,
    });
    expect(() => directorSeedConfiguration({ ...director, DIRECTOR_ACTIVE_STATE: "New York" }))
      .toThrow(/two-letter US state/i);
  });

  test("bounds operational Mongo connections and removes the legacy verification bypass", () => {
    expect(requireMongoUri("mongodb+srv://cluster.example.test/lpc")).toBe("mongodb+srv://cluster.example.test/lpc");
    expect(() => requireMongoUri("mongodb+srv://<cluster>/lpc")).toThrow(/exact MongoDB database/i);
    expect(MONGO_OPERATION_OPTIONS).toEqual({
      serverSelectionTimeoutMS: 15_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 60_000,
      maxPoolSize: 5,
      autoIndex: false,
    });
    expect(fs.existsSync(path.resolve(__dirname, "../scripts/backfill-approved-email-verified.js"))).toBe(false);

    const stripeBackfill = fs.readFileSync(
      path.resolve(__dirname, "../scripts/backfill-stripe-mode.js"),
      "utf8"
    );
    expect(stripeBackfill).toMatch(/process\.argv\.includes\("--apply"\)/);
    expect(stripeBackfill).toMatch(/session\.withTransaction/);
    expect(stripeBackfill).toMatch(/MONGO_OPERATION_OPTIONS/);

    for (const script of [
      "backfill-attorney-fees.js",
      "backfill-matter-deadlines.js",
      "migrate-payment-ledgers.js",
      "migrate-case-files.js",
      "run-automation-cycle.js",
    ]) {
      const source = fs.readFileSync(path.resolve(__dirname, `../scripts/${script}`), "utf8");
      expect(source).toMatch(/MONGO_OPERATION_OPTIONS/);
      expect(source).toMatch(/requireMongoUri/);
    }

    const feeBackfill = fs.readFileSync(
      path.resolve(__dirname, "../scripts/backfill-attorney-fees.js"),
      "utf8"
    );
    expect(feeBackfill).toMatch(/process\.argv\.includes\("--apply"\)/);
    expect(feeBackfill).toMatch(/Math\.min\(1000/);
  });
});
