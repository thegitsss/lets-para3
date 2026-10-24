const path = require("path");
const { defineConfig } = require("playwright/test");
const { buildPlaywrightReporters } = require("./playwright.reporters");
const { CURRENT_BROWSER_PROJECTS } = require("./playwright.browser-matrix");

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5054";
const storageStatePath = path.join(__dirname, "tests/playwright/.auth/director.json");
const shouldSkipWebServer = ["1", "true", "yes", "on"].includes(
  String(process.env.PLAYWRIGHT_SKIP_WEBSERVER || "").trim().toLowerCase()
);
const parsedBaseUrl = new URL(baseURL);
const configuredPort = parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? "443" : "80");

module.exports = defineConfig({
  testDir: path.join(__dirname, "tests/playwright/director"),
  globalSetup: path.join(__dirname, "tests/playwright/director/global.setup.js"),
  globalTeardown: path.join(__dirname, "tests/playwright/global.teardown.js"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: buildPlaywrightReporters("playwright-director"),
  outputDir: path.join(__dirname, "test-results/playwright-director"),
  projects: CURRENT_BROWSER_PROJECTS,
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: storageStatePath,
  },
  webServer: shouldSkipWebServer
    ? undefined
    : {
        command: "node tests/playwright/control-room/webServer.js",
        cwd: __dirname,
        reuseExistingServer: false,
        port: Number(configuredPort),
        // Includes disposable collection/index provisioning before HTTP opens.
        timeout: 240_000,
        env: {
          ...process.env,
          PORT: String(configuredPort),
          NODE_ENV: process.env.NODE_ENV || "test",
        },
      },
});
