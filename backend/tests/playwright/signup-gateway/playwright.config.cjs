const path = require('node:path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('../../../playwright.browser-matrix');
module.exports = defineConfig({
  testDir: __dirname, testMatch: ['signup.spec.cjs', 'signup-regressions.spec.cjs'], workers: 1, retries: 0,
  timeout: 90000, expect: { timeout: 10000 },
  globalSetup: require.resolve('../../helpers/financialLifecycleGlobalSetup'),
  globalTeardown: require.resolve('../../helpers/globalMongoTeardown'),
  projects: CURRENT_BROWSER_PROJECTS,
  reporter: [['line'], ['json', { outputFile: path.resolve(__dirname, '../../../../outputs/signup-gateway-20261022/browser-results.json') }]],
  outputDir: path.resolve(__dirname, '../../../../outputs/signup-gateway-20261022/browser-artifacts'),
  use: { headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', actionTimeout: 10000 },
});
