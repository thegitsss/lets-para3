const path = require('node:path');
const { defineConfig } = require('playwright/test');
const output = process.env.LPC_HOME_DESIGN_OUTPUT || path.resolve(__dirname, '../../../test-results/attorney-home-design');

// Read-only synthetic Home and shared navigation fixtures; no database or providers.
module.exports = defineConfig({
  testDir: path.resolve(__dirname, '..'),
  testMatch: ['attorney-v2/home-clarity.spec.js', 'attorney-v2/home-summaries.spec.js', 'workspace-navigation/attorney.spec.js'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 45000,
  expect: { timeout: 10000 },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['json', { outputFile: path.join(output, 'results.json') }]],
  outputDir: path.join(output, 'test-output'),
});
