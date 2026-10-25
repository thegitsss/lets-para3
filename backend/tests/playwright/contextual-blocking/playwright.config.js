const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('../../../playwright.browser-matrix');
module.exports = defineConfig({ testDir: __dirname, testMatch: /real\.spec\.js$/, workers: 1, fullyParallel: false, retries: 0, timeout: 90000, expect: { timeout: 15000 }, projects: CURRENT_BROWSER_PROJECTS, use: { headless: true, screenshot: 'only-on-failure', trace: 'off', viewport: { width: 1366, height: 900 } } });
