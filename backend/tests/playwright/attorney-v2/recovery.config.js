const path = require('node:path');
const { defineConfig } = require('playwright/test');
// These tests serve only local frontend files and use synthetic API responses.
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: ['recovery-controls.spec.js', 'home-summaries.spec.js', 'home-clarity.spec.js'],
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  outputDir: path.resolve(__dirname, '../../../test-results/attorney-recovery-controls'),
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
