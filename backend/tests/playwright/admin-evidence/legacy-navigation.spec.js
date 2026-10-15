const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => {
  test.setTimeout(360000);
  server = await start({ port: Number(process.env.LPC_ADMIN_LEGACY_PORT || 5168), includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true });
});
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

const destinations = [
  ['photo-reviews', '#photoReviewsPanel', '#adminPeopleView', 'photos'],
  ['revenue', '#section-revenue', '[data-finance-view="reporting"]', 'true'],
  ['escrow', '.escrow-chart-row', '[data-finance-view="reconcile"]', 'true'],
  ['disputes', '#section-disputes', '[data-finance-view="exceptions"]', 'true'],
];
async function checkDestination(page, destination) {
  const [alias, panel, control, value] = destination;
  await expect(page.locator(panel), alias).toBeVisible();
  if (alias === 'photo-reviews') await expect(page.locator(control)).toHaveValue(value);
  else await expect(page.locator(control)).toHaveAttribute('aria-pressed', value);
}

test('legacy Admin destinations retain their selected views through direct entry, reload and browser history', async ({ browser }, info) => {
  const admin = await server.createUser('admin');
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const mutations = [];
  await context.addCookies([admin.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  context.on('request', request => {
    if (new URL(request.url()).origin === server.origin && request.url().includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  const page = await context.newPage();
  try {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const destination of destinations) {
        await page.goto(`${server.origin}/admin-dashboard.html#${destination[0]}`);
        await checkDestination(page, destination);
        await page.reload();
        await checkDestination(page, destination);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`legacy-${destination[0]}-${width}.png`), fullPage: true, animations: 'disabled' });
      }
      // A restored alias must win even when another subview was selected later.
      await page.goto(`${server.origin}/admin-dashboard.html#revenue`);
      await checkDestination(page, destinations[1]);
      await page.evaluate(() => { location.hash = 'escrow'; });
      await checkDestination(page, destinations[2]);
      await page.goBack();
      await checkDestination(page, destinations[1]);
      await page.goForward();
      await checkDestination(page, destinations[2]);
      await page.evaluate(() => { location.hash = 'photo-reviews'; });
      await checkDestination(page, destinations[0]);
      await page.evaluate(() => { window.showAdminUsers('directory'); });
      await expect(page.locator('#approvedUsersPanel')).toBeVisible();
      await page.goBack();
      await checkDestination(page, destinations[0]);
    }
    expect(mutations).toEqual([]);
    expect(server.evidence().external.mail).toHaveLength(0);
    expect(server.evidence().external.storage).toHaveLength(0);
  } finally { await context.close(); }
});
