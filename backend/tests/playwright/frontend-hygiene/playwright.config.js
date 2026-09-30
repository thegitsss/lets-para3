const path = require('node:path');
const base = require('../financial-lifecycle/playwright.config');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');
const output = process.env.LPC_HYGIENE_OUTPUT || path.resolve(__dirname, '../../../test-results/frontend-hygiene');
module.exports = { ...base, timeout: 60000, testDir: __dirname, testMatch: /(?:flows|admin-review)\.spec\.js$/, reporter: [...buildPlaywrightReporters('playwright-frontend-hygiene'), ['json', { outputFile: path.join(output, 'results.json') }]], outputDir: path.join(output, 'test-output') };
