const path = require('node:path');
const base = require('../financial-lifecycle/playwright.config');
module.exports = {
  ...base, use: { ...base.use, actionTimeout: 15000 }, testDir: __dirname, testMatch: /attention\.spec\.js$/,
  reporter: [['list'], ['json', { outputFile: path.resolve(__dirname, '../../../test-results/admin-solo/results.json') }]],
  outputDir: path.resolve(__dirname, '../../../test-results/admin-solo/browser'),
};
