const { defineConfig } = require('playwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'parity.spec.js',
  workers: 1,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] } },
});
