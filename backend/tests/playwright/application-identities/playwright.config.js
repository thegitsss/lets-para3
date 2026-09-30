const path = require('node:path');
const base = require('../attorney-v2/playwright.config');
process.env.PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5888';
module.exports = {
  ...base, testDir: __dirname, testMatch: '**/*.spec.js',
  outputDir: path.resolve(__dirname, '../../../test-results/application-identities'),
  use: { ...base.use, baseURL: process.env.PLAYWRIGHT_BASE_URL },
  webServer: { ...base.webServer, port: 5888, env: { ...base.webServer.env, PORT: '5888', PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL, PLAYWRIGHT_MONGO_PORT: '5889' } },
};
