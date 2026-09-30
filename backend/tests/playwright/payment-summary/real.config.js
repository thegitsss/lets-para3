const path = require('node:path'), { defineConfig } = require('playwright/test');
const output = process.env.LPC_FINANCIAL_ARTIFACTS || path.resolve(__dirname, '../../../test-results/payment-summary-real');
module.exports = defineConfig({ testDir: __dirname, testMatch: 'real.spec.js', workers: 1, retries: 0, timeout: 150000, expect: { timeout: 15000 },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['json', { outputFile: path.join(output, 'results.json') }]], outputDir: path.join(output, 'test-output'),
});
