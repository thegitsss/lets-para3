const path = require('node:path');
const { defineConfig } = require('playwright/test');
module.exports = defineConfig({
  testDir: './tests/playwright/journey-intelligence', workers: 1, retries: 0,
  timeout: 120000, expect: { timeout: 15000 },
  globalSetup: require.resolve('./tests/helpers/financialLifecycleGlobalSetup'),
  globalTeardown: require.resolve('./tests/helpers/globalMongoTeardown'),
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({ name: browserName, use: { browserName } })),
  use: { headless: true },
  outputDir: path.resolve(__dirname, 'test-results/journey-intelligence/artifacts'),
  reporter: [['line'], ['json', { outputFile: path.resolve(__dirname, 'test-results/journey-intelligence/results.json') }]],
});
