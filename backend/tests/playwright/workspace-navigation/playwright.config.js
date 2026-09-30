const path = require('node:path');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');
const output = process.env.LPC_NAVIGATION_OUTPUT || path.resolve(__dirname, '../../../test-results/workspace-navigation');
module.exports = {
  testDir: __dirname, testMatch: '*.spec.js', workers: 1, fullyParallel: false, retries: 0,
  timeout: 45000, expect: { timeout: 8000 },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [...buildPlaywrightReporters('playwright-workspace-navigation'), ['json', { outputFile: path.join(output, 'results.json') }]],
  outputDir: path.join(output, 'test-output'),
};
