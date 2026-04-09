const path = require("path");
const { defineConfig } = require("playwright/test");

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5050";
const storageStatePath = path.join(__dirname, "tests/playwright/.auth/control-room-admin.json");
const shouldSkipWebServer = ["1", "true", "yes", "on"].includes(
  String(process.env.PLAYWRIGHT_SKIP_WEBSERVER || "").trim().toLowerCase()
);

const parsedBaseUrl = new URL(baseURL);
const configuredPort = parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? "443" : "80");

module.exports = defineConfig({
  testDir: path.join(__dirname, "tests/playwright/control-room"),
  globalSetup: path.join(__dirname, "tests/playwright/control-room/global.setup.js"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [["list"]],
  outputDir: path.join(__dirname, "test-results/playwright-control-room"),
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
        reuseExistingServer: !process.env.CI,
        port: Number(configuredPort),
        timeout: 120_000,
        env: {
          ...process.env,
          PORT: String(configuredPort),
          NODE_ENV: process.env.NODE_ENV || "test",
        },
      },
});
