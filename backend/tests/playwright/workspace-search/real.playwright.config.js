const path = require("node:path");
const { defineConfig } = require("playwright/test");
const artifacts = process.env.LPC_SEARCH_REAL_ARTIFACTS || path.resolve(__dirname, "../../../test-results/workspace-search-real");
module.exports = defineConfig({
  testDir: __dirname, testMatch: "real.spec.js", workers: 1, fullyParallel: false, retries: 0,
  timeout: 60000, expect: { timeout: 10000 },
  projects: ["chromium", "firefox", "webkit"].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
  reporter: [["list"], ["json", { outputFile: path.join(artifacts, "results.json") }]], outputDir: path.join(artifacts, "test-output"),
});
