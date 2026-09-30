const path = require('node:path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('../../../playwright.browser-matrix');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');
module.exports = defineConfig({
  testDir: __dirname, testMatch: /(?:journey|exception)\.spec\.js$/, workers: 1,
  fullyParallel: false, retries: 0, timeout: 150000,
  expect: { timeout: 15000 },
  reporter: [...buildPlaywrightReporters('playwright-financial-lifecycle'), ['json', { outputFile: process.env.LPC_LIFECYCLE_REPORT || path.resolve(__dirname, '../../../test-results/financial-lifecycle/results.json') }]],
  outputDir: process.env.LPC_LIFECYCLE_OUTPUT || path.resolve(__dirname, '../../../test-results/financial-lifecycle'),
  projects: CURRENT_BROWSER_PROJECTS,
  use: { headless: true, screenshot: 'only-on-failure', trace: 'off', viewport: { width: 1366, height: 900 } },
});
