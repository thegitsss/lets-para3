const path = require('path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('../../../playwright.browser-matrix');
module.exports = defineConfig({
  testDir: path.resolve(__dirname, '..'),
  testMatch: ['**/conversations-approved.spec.js', '**/conversations-inbox.spec.js'],
  workers: 1, retries: 0, timeout: 45000, expect: { timeout: 10000 },
  projects: CURRENT_BROWSER_PROJECTS,
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['json', { outputFile: path.resolve(__dirname, '../../../../outputs/completion-2026-09-29/navigation-messages-browser.json') }]],
  outputDir: path.resolve(__dirname, '../../../test-results/navigation-messages'),
});
