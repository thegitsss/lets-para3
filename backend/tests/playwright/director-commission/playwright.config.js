const path = require('node:path');
const base = require('../financial-lifecycle/playwright.config');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');
const output = process.env.LPC_DIRECTOR_COMMISSION_OUTPUT || path.resolve(__dirname, '../../../test-results/director-commission');
module.exports = { ...base, testDir: __dirname, testMatch: 'cap.spec.js', timeout: 90000, reporter: [...buildPlaywrightReporters('playwright-director-commission'), ['json', { outputFile: path.join(output, 'results.json') }]], outputDir: path.join(output, 'test-output') };
