const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(360000); server = await start({ port: Number(process.env.LPC_ADMIN_LEGACY_PORT || 5168), includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true }); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());

test('an unavailable LinkedIn status retains owner details and leaves the inline recovery message and Refresh control unobscured', async ({ browser }, info) => {
  const admin = await server.createUser('admin');
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } }); await context.addCookies([admin.cookie]);
  const connectionPath = '/api/admin/marketing/publishing/channel-connections/linkedin_company';
  let fail = false;
  const message = 'Connection status is unavailable. Your saved details are retained. Use Refresh LinkedIn Status to check again.';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.origin !== server.origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/admin/marketing/')) return route.continue();
    if (url.pathname === connectionPath && route.request().method() === 'GET') {
      const guarded = await route.fetch(); expect(guarded.status()).toBe(200); expect((await guarded.json()).ok).toBe(true); await guarded.dispose();
      return route.fulfill(fail ? { status: 503, json: { error: message } } : { json: { ok: true, connection: { status: 'blocked', organizationId: '67890', organizationUrn: 'urn:li:organization:67890', organizationName: 'Current owner selection', authorizationGranted: false, lastValidationNote: 'Current owner details require validation.' } } });
    }
    if (url.pathname.endsWith('/publishing/overview')) return route.fulfill({ json: { settings: {}, channelReadiness: [], latestCycles: [], openCycleCount: 0 } });
    return route.fulfill({ json: { ok: true, items: [], packets: [], counts: {}, review: { items: [] }, log: {}, library: {} } });
  });
  const page = await context.newPage();
  try {
    await page.goto(server.origin + '/admin-dashboard.html#marketing-drafts');
    await page.getByRole('combobox', { name: 'Growth view', exact: true }).selectOption('posting');
    await page.locator('[data-growth-view="posting"] summary').filter({ hasText: /^LinkedIn connection$/ }).click();
    const refresh = page.locator('#marketingLinkedInRefreshBtn'), status = page.locator('#marketingLinkedInConnectionStatus');
    await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('67890');
    await page.locator('#marketingLinkedInConnectionForm').scrollIntoViewIfNeeded(); await page.locator('#marketingLinkedInConnectBtn').scrollIntoViewIfNeeded();
    fail = true; await refresh.click(); await expect(status).toHaveText(message); await expect(refresh).toBeEnabled();
    // Inspect after the existing200ms toast transition, inside its2600ms life.
    // Do not remove, hide or restyle the banner to obtain this measurement.
    await expect.poll(() => page.evaluate(() => { const toast = document.getElementById('toastBanner'); return !toast.classList.contains('show') || Number(getComputedStyle(toast).opacity) >= 0.99; })).toBe(true);
    const measured = await page.evaluate(() => {
      const toast = document.getElementById('toastBanner'), status = document.getElementById('marketingLinkedInConnectionStatus'), refresh = document.getElementById('marketingLinkedInRefreshBtn');
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const t = rect(toast), r = rect(refresh), range = document.createRange(); range.selectNodeContents(status);
      const lines = Array.from(range.getClientRects(), p => ({ left: p.left, right: p.right, top: p.top, bottom: p.bottom }));
      const shown = toast.classList.contains('show') && Number(getComputedStyle(toast).opacity) >= 0.99;
      const overlaps = p => shown && p.left < t.right && p.right > t.left && p.top < t.bottom && p.bottom > t.top;
      const point = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return { toastShown: shown, toast: t, statusLines: lines, statusCovered: lines.some(overlaps), refreshCovered: overlaps(r), refreshHitIsControl: point === refresh || refresh.contains(point) };
    });
    await info.attach('status-recovery-geometry', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('linkedin-status-recovery-390.png'), animations: 'disabled' });
    expect(measured.refreshCovered).toBe(false); expect(measured.refreshHitIsControl).toBe(true); expect(measured.statusCovered).toBe(false);
    await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('67890');
    fail = false; await refresh.click(); await expect(status).toContainText('Current owner details require validation.');
    expect(server.evidence().requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method))).toHaveLength(0);
    expect(server.evidence().external.mail).toHaveLength(0); expect(server.evidence().external.storage).toHaveLength(0);
  } finally { await context.close(); }
});
