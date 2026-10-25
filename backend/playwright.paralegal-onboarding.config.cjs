const path = require('node:path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('./playwright.browser-matrix');

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests/playwright'),
  testMatch: [
    '**/financial-lifecycle/admission-journey.spec.js',
    '**/paralegal-support/profile-actual-native.spec.js',
    '**/paralegal-support/paralegal-documents-actual.spec.js',
    '**/paralegal-support/stripe-onboarding-actual.spec.js',
    '**/paralegal-support/profile-first-entries-actual.spec.js',
  ],
  grep: /actual paralegal admission|actual profile editor persistence|actual profile document and photo lifecycle|actual V2 Stripe setup|new profile can add/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 15000 },
  globalSetup: require.resolve('./tests/helpers/financialLifecycleGlobalSetup'),
  globalTeardown: require.resolve('./tests/helpers/globalMongoTeardown'),
  reporter: [['line'], ['json', { outputFile: path.join(__dirname, 'test-results/paralegal-onboarding/results.json') }]],
  outputDir: path.join(__dirname, 'test-results/paralegal-onboarding/artifacts'),
  projects: CURRENT_BROWSER_PROJECTS,
  use: { headless: true, actionTimeout: 15000, screenshot: 'only-on-failure', trace: 'off' },
});
