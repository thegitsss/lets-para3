const path = require('node:path');
const base = require('../financial-lifecycle/playwright.config');
module.exports = { ...base, testDir: __dirname, testMatch: /menu\.spec\.js$/, reporter: [['list'], ['json', { outputFile: path.resolve(__dirname, '../../../../docs/audits/admin-menu-2026-09-28/results.json') }]], outputDir: path.resolve(__dirname, '../../../../docs/audits/admin-menu-2026-09-28/browser') };
