const path = require('path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('../../../playwright.browser-matrix');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: process.env.PAYOUTS_REPORT || path.resolve(__dirname, '../../../../outputs/completion-2026-09-29/payouts-browser.json') }]],
  outputDir: path.resolve(__dirname, '../../../test-results/paralegal-payouts'),
  projects: CURRENT_BROWSER_PROJECTS,
  use: { baseURL: 'http://127.0.0.1:5287', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/playwright/attorney-v2/security-static-server.js', cwd: path.resolve(__dirname, '../../..'), port: 5287, reuseExistingServer: false },
});
