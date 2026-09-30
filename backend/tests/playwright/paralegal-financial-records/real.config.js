const path = require('node:path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('../../../playwright.browser-matrix');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');

// This suite owns its single synthetic replica set and listener. Keep it out
// of the general support suite, which owns a different application server.
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'real.spec.js',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: buildPlaywrightReporters('paralegal-financial-records'),
  outputDir: path.resolve(__dirname, '../../../test-results/paralegal-financial-records'),
  projects: CURRENT_BROWSER_PROJECTS,
  use: {
    baseURL: 'http://127.0.0.1:5874',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
