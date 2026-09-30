const path = require('node:path');
const { defineConfig } = require('playwright/test');
const output = process.env.LPC_FINANCIAL_ARTIFACTS || path.resolve(__dirname, '../../../test-results/payment-summary');
module.exports = defineConfig({ testDir: __dirname, testMatch: ['summary.spec.js', 'legacy.spec.js'], workers: 1, retries: 0, timeout: 45000, expect: { timeout: 10000 },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['json', { outputFile: path.join(output, 'results.json') }]], outputDir: path.join(output, 'test-output'),
});
