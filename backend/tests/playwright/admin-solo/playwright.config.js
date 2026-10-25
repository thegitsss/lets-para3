const path = require('node:path');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');
const base = require('../financial-lifecycle/playwright.config');
module.exports = {
  ...base, use: { ...base.use, actionTimeout: 15000 }, testDir: __dirname, testMatch: /attention\.spec\.js$/,
  reporter: [...buildPlaywrightReporters('admin-solo'), ['json', { outputFile: path.resolve(__dirname, '../../../test-results/admin-solo/results.json') }]],
  outputDir: path.resolve(__dirname, '../../../test-results/admin-solo/browser'),
};
