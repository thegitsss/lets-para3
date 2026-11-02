const path = require("node:path");
const { defineConfig } = require("playwright/test");
module.exports = defineConfig({
  testDir: "./tests/playwright/connected-workspace",
  testMatch: "new-features.spec.js",
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: { browserName: "chromium", headless: true, baseURL: "http://127.0.0.1:19076", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", ...(process.env.LPC_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.LPC_CHROMIUM_EXECUTABLE } } : {}) },
  webServer: { command: "node tests/playwright/connected-workspace/static-server.cjs", url: "http://127.0.0.1:19076/matter-tools.html", reuseExistingServer: false, timeout: 15000 },
  outputDir: process.env.LPC_CONNECTED_BROWSER_OUTPUT || path.resolve(__dirname, "test-results/connected-workspace"),
  reporter: [["line"]],
});
