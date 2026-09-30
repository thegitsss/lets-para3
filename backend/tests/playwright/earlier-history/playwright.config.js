const path = require('node:path');
const base = require('../application-identities/playwright.config');
process.env.LPC_EARLIER_HISTORY_MONGO_URI = 'mongodb://127.0.0.1:5889/control-room-playwright?directConnection=true';
module.exports = {
  ...base, testDir: __dirname, testMatch: 'lifecycle.spec.js',
  globalSetup: require.resolve('../paralegal-support/global.setup.js'),
  outputDir: path.resolve(__dirname, '../../../test-results/earlier-history'),
  use: { ...base.use, storageState: path.resolve(__dirname, '../.auth/support-paralegal.json') },
};
