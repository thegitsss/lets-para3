const path = require("path");
const { defineConfig, devices } = require("playwright/test");
const { buildPlaywrightReporters } = require("./playwright.reporters");

module.exports = defineConfig({
  testDir: path.join(__dirname, "tests/playwright/performance"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: buildPlaywrightReporters("playwright-performance"),
  outputDir: path.join(__dirname, "test-results/playwright-performance"),
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5055",
    headless: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "npm run build:frontend && PORT=5055 node scripts/serve-frontend-accessibility.js --built",
    cwd: __dirname,
    reuseExistingServer: false,
    port: 5055,
    timeout: 30_000,
  },
});
