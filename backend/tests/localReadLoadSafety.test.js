const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function rejectedRun(overrides) {
  const namespace = `read-load-safety-${crypto.randomUUID()}`;
  const key = crypto.createHash("sha256").update(`${root}\0${namespace}`).digest("hex").slice(0, 16);
  const state = path.join(os.tmpdir(), `lpc-jest-mongo-${key}.json`);
  const env = Object.fromEntries(["HOME", "TMPDIR", "PATH"].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, { NODE_ENV: "test", LPC_TEST_MONGO_NAMESPACE: namespace,
    MONGO_URI: "mongodb://not-a-local-test.invalid/do-not-connect", ...overrides });
  expect(fs.existsSync(state)).toBe(false);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/load-case-activity.js")], { env, encoding: "utf8", timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(fs.existsSync(state)).toBe(false);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("not-a-local-test.invalid");
  return result.stderr;
}

test("the standalone read-load command rejects production before opening a database", () => {
  expect(rejectedRun({ NODE_ENV: "production" })).toContain("requires NODE_ENV=test");
});

test.each([
  ["LOAD_CASE_COUNT", "1000"], ["LOAD_ROUNDS", "NaN"],
  ["LOAD_CONCURRENCY", "0"], ["LOAD_MESSAGES_PER_CASE", "-1"],
  ["LOAD_DOCS_PER_CASE", "1.5"],
])("invalid %s fails before database setup instead of hanging or reporting empty success", (name, value) => {
  expect(rejectedRun({ [name]: value })).toContain(`${name} must be a positive integer`);
});
