const path = require("path");
const { defineConfig } = require("playwright/test");
const { buildPlaywrightReporters } = require("./playwright.reporters");
const { CURRENT_BROWSER_PROJECTS } = require("./playwright.browser-matrix");

module.exports = defineConfig({
  testDir: path.join(__dirname, "tests/playwright/accessibility"),
  fullyParallel: true,
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: buildPlaywrightReporters("playwright-accessibility"),
  outputDir: path.join(__dirname, "test-results/playwright-accessibility"),
  projects: CURRENT_BROWSER_PROJECTS,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5054",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve-frontend-accessibility.js",
    cwd: __dirname,
    reuseExistingServer: false,
    port: 5054,
    timeout: 30_000,
  },
});
