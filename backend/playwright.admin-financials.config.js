const path = require('node:path');
const { defineConfig } = require('playwright/test');
const { CURRENT_BROWSER_PROJECTS } = require('./playwright.browser-matrix');
const { buildPlaywrightReporters } = require('./playwright.reporters');
const baseURL = 'http://127.0.0.1:5874';
process.env.PLAYWRIGHT_BASE_URL = baseURL;
module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests/playwright/admin-financials'),
  testMatch: '**/*.spec.js',
  globalSetup: path.join(__dirname, 'tests/playwright/control-room/global.setup.js'),
  globalTeardown: path.join(__dirname, 'tests/playwright/global.teardown.js'),
  workers: 1, fullyParallel: false, retries: 0, timeout: 60000, expect: { timeout: 12000 },
  reporter: buildPlaywrightReporters('playwright-admin-financials'), outputDir: path.join(__dirname, 'test-results/admin-financials'), projects: CURRENT_BROWSER_PROJECTS,
  use: { baseURL, storageState: path.join(__dirname, 'tests/playwright/.auth/control-room-admin.json'), headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 15000 },
  webServer: { command: `node "${path.join(__dirname, 'tests/playwright/control-room/webServer.js')}"`, cwd: require('node:os').tmpdir(), port: 5874, reuseExistingServer: false, timeout: 240000,
    env: { ...process.env, NODE_ENV: 'test', APP_ENV: 'test', PORT: '5874', PLAYWRIGHT_BASE_URL: baseURL, APP_BASE_URL: baseURL, CLIENT_BASE_URL: baseURL, FRONTEND_BASE_URL: baseURL, PLAYWRIGHT_MONGO_PORT: '5875', PLAYWRIGHT_MONGO_REPLICA_SET: 'true', PLAYWRIGHT_INITIALIZE_ATTORNEY_MODELS: 'true', EMAIL_DISABLE: 'true', OPENAI_API_KEY: '', STRIPE_SECRET_KEY: 'sk_test_admin_financial_browser', STRIPE_PUBLISHABLE_KEY: 'pk_test_admin_financial_browser', STRIPE_WEBHOOK_SECRET: 'whsec_admin_financial_browser', S3_BUCKET: '', AWS_EC2_METADATA_DISABLED: 'true', DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123' } },
});
