const path = require("node:path");
const { defineConfig } = require("playwright/test");
module.exports = defineConfig({
  testDir: "./tests/playwright/connected-workspace",
  testMatch: "native-*.spec.js",
  workers: 1, retries: 0, timeout: 40000, expect: { timeout: 12000 },
  use: { browserName: "chromium", headless: true, baseURL: "http://127.0.0.1:19077", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", ...(process.env.LPC_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.LPC_CHROMIUM_EXECUTABLE } } : {}) },
  webServer: { command: "node tests/playwright/connected-workspace/static-server.cjs", env: { LPC_CONNECTED_TEST_PORT: "19077" }, url: "http://127.0.0.1:19077/attorney-v2.html", reuseExistingServer: false, timeout: 15000 },
  outputDir: process.env.LPC_CONNECTED_NATIVE_OUTPUT || path.resolve(__dirname, "test-results/connected-native"),
  reporter: [["line"]],
});
