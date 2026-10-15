const path = require("path");
const { defineConfig } = require("playwright/test");
const { buildPlaywrightReporters } = require("../../../playwright.reporters");
const { CURRENT_BROWSER_PROJECTS } = require("../../../playwright.browser-matrix");
process.env.PLAYWRIGHT_BASE_URL = "http://127.0.0.1:5051";

// Reuse the existing synthetic attorney login and ephemeral Mongo harness.
// This config intentionally cannot point at a remote/production base URL.
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "**/*.spec.js",
  globalSetup: require.resolve("../support/global.setup.js"),
  globalTeardown: require.resolve("../global.teardown.js"),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: buildPlaywrightReporters("playwright-attorney-v2"),
  outputDir: path.resolve(__dirname, "../../../test-results/attorney-v2-matter-drafts"),
  projects: CURRENT_BROWSER_PROJECTS,
  use: {
    baseURL: "http://127.0.0.1:5051",
    storageState: path.resolve(__dirname, "../.auth/support-attorney.json"),
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node "${path.resolve(__dirname, "../control-room/webServer.js")}"`,
    cwd: require("os").tmpdir(),
    port: 5051,
    reuseExistingServer: false,
    // The disposable replica builds every application index before HTTP opens.
    // This setup allowance does not change browser or API request deadlines.
    // Earlier-draft scenarios inspect only this disposable database on 5889.
    timeout: 240000,
    env: { ...process.env, EMAIL_DISABLE: "true", OPENAI_API_KEY: "", DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", PLAYWRIGHT_MONGO_REPLICA_SET: "true", PLAYWRIGHT_INITIALIZE_ATTORNEY_MODELS: "true", PLAYWRIGHT_MONGO_PORT: "5889", PORT: "5051", NODE_ENV: "test", PLAYWRIGHT_BASE_URL: "http://127.0.0.1:5051" },
  },
});
