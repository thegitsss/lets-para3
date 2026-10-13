const path = require('node:path');
const { defineConfig } = require('playwright/test');
const output = process.env.LPC_SHARED_MATTER_OUTPUT ? path.resolve(process.env.LPC_SHARED_MATTER_OUTPUT) : path.resolve(__dirname, '../../../../outputs/shared-matter-20261012/verification');
module.exports = defineConfig({
  testDir: '..',
  testMatch: ['shared-matter/*.spec.js', 'messaging-integration/conversations-real.spec.js', 'financial-lifecycle/submission-journey.spec.js', 'financial-lifecycle/journey.spec.js', 'financial-lifecycle/exception.spec.js'],
  globalSetup: require.resolve('../../helpers/financialLifecycleGlobalSetup'),
  globalTeardown: require.resolve('../../helpers/globalMongoTeardown'),
  workers: 1, fullyParallel: false, retries: 0, timeout: 150000,
  expect: { timeout: 15000 },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  reporter: [['line'], ['json', { outputFile: path.join(output, 'results.json') }]],
  outputDir: path.join(output, 'browser-artifacts'),
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
