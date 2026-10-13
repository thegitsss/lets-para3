const path = require("node:path");
const { defineConfig } = require("playwright/test");
const artifacts = process.env.LPC_HELP_ARTIFACTS || path.resolve(__dirname, "../../../test-results/attorney-help");
module.exports = defineConfig({
  testDir: __dirname, testMatch: "help.spec.js", workers: 1, fullyParallel: false, retries: 0, timeout: 45000,
  expect: { timeout: 8000 },
  projects: ["chromium", "firefox", "webkit"].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: "block", storageState: { cookies: [], origins: [] }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  reporter: [["list"], ["json", { outputFile: path.join(artifacts, "results.json") }]], outputDir: path.join(artifacts, "test-output"),
});
