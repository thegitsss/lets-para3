const { test, expect } = require('playwright/test'), path = require('node:path'), fs = require('node:fs/promises'), startServer = require('./real-server.cjs');
let server, cleanup;
test.beforeEach(async ({ context }) => {
  server = await startServer({ frontendRoot: path.join(process.env.LPC_HELP_SOURCE_ROOT || path.resolve(__dirname, '../../../..'), 'frontend'), onStartupCleanup: close => { cleanup = close; } });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
});
test.afterEach(async ({ page }) => { await page.close(); await (server?.close || cleanup)?.(); server = null; cleanup = null; });
test('actual retained financial records agree across Home, Payments, dashboard and the original table; missing evidence and replacement accounts clear money', async ({ page, context }, testInfo) => {
  const owner = await server.createUser(); await server.seed(owner.id); await context.addCookies([owner.cookie]);
  const before = await server.evidence(owner.id), posts = [];
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) posts.push(request.url()); });
  await page.goto(`${server.origin}/attorney-v2.html#/home`);
  const home = page.locator('[data-av2-region="payments"]'); await expect(home).toHaveAttribute('data-state', 'ready'); await expect(home).toContainText('$300.00'); await expect(home).toContainText('€200.00');
  const dashboard = await page.request.get(`${server.origin}/api/attorney/dashboard?expectedOwnerId=${owner.id}`); expect(dashboard.status()).toBe(200); expect((await dashboard.json()).metrics.escrowTotal).toBe(30000);
  await home.getByRole('link', { name: 'Open Payments', exact: true }).click();
  const funds = page.locator('[data-av2-region="payment-summary"]'); await expect(funds).toHaveAttribute('data-state', 'ready'); await expect(funds).toContainText('$300.00'); await expect(funds).toContainText('€200.00');
  await page.reload(); await expect(funds).toContainText('$300.00');
  await page.goto(`${server.origin}/dashboard-attorney.html#funds`); const table = page.locator('#activeEscrowsBody'); await expect(table).toContainText('$300.00'); await expect(table).toContainText('€200.00');
  expect(await server.evidence(owner.id)).toEqual(before); expect(server.providerCalls).toEqual([]); expect(posts).toEqual([]);
  await server.removeFunding(owner.id); const uncertain = await server.evidence(owner.id);
  await page.getByRole('button', { name: 'Refresh Matter funds', exact: true }).click(); await expect(table).toContainText('Not confirmed'); await expect(table).not.toContainText('$300.00');
  await page.goto(`${server.origin}/attorney-v2.html#/payments`); await expect(funds).toContainText('2 Matters need payment review'); await expect(funds).not.toContainText('$0.00'); await expect(funds).not.toContainText('$300.00');
  const replacement = await server.createUser(); await context.addCookies([replacement.cookie]);
  const denied = await page.request.get(`${server.origin}/api/payments/summary?expectedOwnerId=${owner.id}`); expect(denied.status()).toBe(403); expect((await denied.json()).activeFunds).toBeUndefined();
  await funds.getByRole('button', { name: 'Refresh matter funds', exact: true }).click(); await expect(page).toHaveURL(/\/login.html/);
  expect(await server.evidence(owner.id)).toEqual(uncertain); expect(posts).toEqual([]); expect(server.providerCalls).toEqual([]);
  await fs.writeFile(testInfo.outputPath('actual-read-agreement.json'), JSON.stringify({ currencies: ['EUR', 'USD'], activeFunds: { USD: 30000, EUR: 20000 }, databaseUnchangedByReads: true, missingFundingClearsAmounts: true, ownerMismatchStatus: denied.status(), providerCalls: server.providerCalls, financialPosts: posts }, null, 2));
});
