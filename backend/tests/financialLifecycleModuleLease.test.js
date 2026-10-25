"use strict";
const path = require("node:path"), { execFileSync } = require("node:child_process");
test("actual Node application imports retain per-server synthetic dependency isolation", () => {
  // Jest owns a virtual module registry; exercise the browser helper's actual
  // CommonJS registry in a native child process, as Playwright does.
  const output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", path.join(__dirname, "helpers/financialLifecycleModuleLease.contract.cjs")], {
    env: { ...process.env, NODE_ENV: "test", JWT_SECRET: "fixture-module-isolation-contract", DATA_ENCRYPTION_KEY: "0123456789abcdef".repeat(4) }, encoding: "utf8", timeout: 15000,
  });
  expect(output).toMatch(/# tests 3/); expect(output).toMatch(/# pass 3/); expect(output).toMatch(/# fail 0/);
});
