const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createMongoToolConfig } = require("../utils/mongoToolConfig");
let directory, archive;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-restore-guards-"));
  archive = path.join(directory, "synthetic.archive.gz");
  fs.writeFileSync(archive, "synthetic, not a database archive", { mode: 0o600 });
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function blocked(extra = {}) {
  // No inherited environment, executable search path, provider credentials or network.
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/restore-db.js")], {
    cwd: directory, env: { BACKUP_FILE: archive, ...extra }, encoding: "utf8",
  });
  expect(result.status).toBe(1);
  return result.stderr;
}
test("application database environment cannot become a restore target", () => {
  expect(blocked({ MONGO_URI: "mongodb://127.0.0.1:1/application", CONFIRM_RESTORE: "ISOLATED_NON_PRODUCTION" })).toMatch(/Missing RESTORE_MONGO_URI/);
});
test("a dedicated target still requires explicit isolated-target confirmation", () => {
  expect(blocked({ RESTORE_MONGO_URI: "mongodb://127.0.0.1:1/" })).toMatch(/Restore blocked/);
});
test.each([
  [{ RESTORE_DROP: "true" }, /CONFIRM_RESTORE_DROP/],
  [{ RESTORE_NS_FROM: "source.*" }, /provided together/],
  [{ RESTORE_NS_TO: "target.*" }, /provided together/],
  [{ RESTORE_MONGO_URI: "mongodb://127.0.0.1:1/target", RESTORE_NS_FROM: "source.*", RESTORE_NS_TO: "target.*" }, /without a database path/],
  [{ BACKUP_FILE: "relative.archive.gz" }, /BACKUP_FILE/],
])("rejects unsafe or ambiguous options %p", (extra, message) => {
  expect(blocked({ RESTORE_MONGO_URI: "mongodb://127.0.0.1:1/", CONFIRM_RESTORE: "ISOLATED_NON_PRODUCTION", ...extra })).toMatch(message);
});
test("a symbolic-link archive is rejected", () => {
  const link = path.join(directory, "link.archive.gz");
  fs.symlinkSync(archive, link);
  expect(blocked({ RESTORE_MONGO_URI: "mongodb://127.0.0.1:1/", CONFIRM_RESTORE: "ISOLATED_NON_PRODUCTION", BACKUP_FILE: link })).toMatch(/non-symlink/);
});
test("tool credentials live only in an owner-only temporary file and cleanup is repeatable", () => {
  const config = createMongoToolConfig(["mongodb://fixture", "synthetic@127.0.0.1:1/?authSource=admin"].join(":"));
  try {
    expect(fs.statSync(config.filePath).mode & 0o077).toBe(0);
    expect(fs.statSync(path.dirname(config.filePath)).mode & 0o077).toBe(0);
    expect(fs.readFileSync(config.filePath, "utf8")).toContain("authSource=admin");
  } finally { config.cleanup(); config.cleanup(); }
  expect(fs.existsSync(config.filePath)).toBe(false);
});
