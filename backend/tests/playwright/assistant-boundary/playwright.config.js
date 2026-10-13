const path = require('node:path');
const { defineConfig } = require('playwright/test');
const artifacts = process.env.LPC_ASSISTANT_BOUNDARY_ARTIFACTS;
module.exports = defineConfig({ testDir: __dirname, testMatch: 'boundary.spec.js', workers: 1, fullyParallel: false, retries: 0, timeout: 25000,
  expect: { timeout: 1800 }, projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['json', { outputFile: path.join(artifacts, 'results.json') }]], outputDir: path.join(artifacts, 'test-output') });
