const path = require('node:path');
const { buildPlaywrightReporters } = require('../../../playwright.reporters');
const output = process.env.LPC_SESSION_OUTPUT || path.resolve(__dirname, '../../../test-results/workspace-session');
module.exports = {
  testDir: __dirname, testMatch: '*.spec.js', workers: 1, fullyParallel: false, retries: 0,
  timeout: 45000, expect: { timeout: 8000 },
  // Actual cached-history tests require the full Chromium browser with its
  // back/forward cache enabled; a dispatched pageshow is not equivalent proof.
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: {
    browserName: name,
    ...(name === 'chromium' ? { channel: 'chromium', launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } } : {}),
  } })),
  use: { headless: true, serviceWorkers: 'block', storageState: { cookies: [], origins: [] }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [...buildPlaywrightReporters('playwright-workspace-session'), ['json', { outputFile: path.join(output, 'results.json') }]],
  outputDir: path.join(output, 'test-output'),
};
