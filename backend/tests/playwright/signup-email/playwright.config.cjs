const path = require('node:path');
const evidenceRoot = process.env.LPC_EMAIL_REVIEW_OUTPUT || path.resolve(__dirname, '../../../../outputs/email-suite-ready-20261105/browser');
const {
  defineConfig
} = require('playwright/test');
const {
  CURRENT_BROWSER_PROJECTS
} = require('../../../playwright.browser-matrix');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'signup-email.spec.cjs',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: {
    timeout: 10000
  },
  projects: CURRENT_BROWSER_PROJECTS,
  globalSetup: require.resolve('../../helpers/financialLifecycleGlobalSetup'),
  globalTeardown: require.resolve('../../helpers/globalMongoTeardown'),
  reporter: [['line'], ['json', {
    outputFile: path.join(evidenceRoot, 'browser-results.json')
  }]],
  outputDir: path.join(evidenceRoot, 'browser-artifacts'),
  use: {
    headless: true,
    viewport: {
      width: 1440,
      height: 1000
    },
    screenshot: 'only-on-failure'
  }
});
