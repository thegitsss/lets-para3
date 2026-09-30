const path = require("path");
const { defineConfig } = require("playwright/test");
const { CURRENT_BROWSER_PROJECTS } = require("../../../playwright.browser-matrix");
module.exports = defineConfig({
  testDir: __dirname, testMatch:"accounts.spec.js", workers:1, fullyParallel:false, retries:0,
  timeout:45000, expect:{timeout:10000}, reporter:[["list"]],
  outputDir:path.resolve(__dirname,"../../../test-results/attorney-accounts"), projects:CURRENT_BROWSER_PROJECTS,
  use:{baseURL:"http://127.0.0.1:5279",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
  webServer:{command:`node "${path.join(__dirname,"accounts-static-server.js")}"`,port:5279,reuseExistingServer:false,timeout:30000},
});
