const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => {
  test.setTimeout(360000);
  server = await start({ port: Number(process.env.LPC_ADMIN_LEGACY_PORT || 5168), includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true });
});
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('LinkedIn Connect reconciles authenticated status with noopener, stale reads and closed authorization windows', async ({ browser }, info) => {
  const admin = await server.createUser('admin');
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addCookies([admin.cookie]);
  let current = { status: 'not_connected', organizationId: '', organizationUrn: '', organizationName: '', authorizationGranted: false };
  const mutations = [], opens = [];
  let starts = 0, reads = 0, heldRoute, heldSnapshot, holdNextRead = false, failNextRead = false, entered;
  const connectionPath = '/api/admin/marketing/publishing/channel-connections/linkedin_company';
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== server.origin) return route.abort('blockedbyclient');
    if (url.pathname === '/__fake-linkedin-authorization') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic authorization</title><p>Local synthetic authorization window. No provider exchange.</p>' });
    if (!url.pathname.startsWith('/api/admin/marketing/')) return route.continue();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push({ method: request.method(), path: url.pathname });
    if (url.pathname === connectionPath && request.method() === 'GET') {
      reads += 1;
      // WebKit may omit Cookie from intercepted request metadata. Exercise
      // the actual guarded endpoint before substituting synthetic status.
      const authenticated = await route.fetch();
      expect(authenticated.status()).toBe(200);
      expect((await authenticated.json()).ok).toBe(true);
      await authenticated.dispose();
      if (failNextRead) { failNextRead = false; return route.fulfill({ status: 503, json: { error: 'Synthetic connection status is temporarily unavailable.' } }); }
      if (holdNextRead) { holdNextRead = false; heldRoute = route; heldSnapshot = structuredClone(current); entered.resolve(); return; }
      return route.fulfill({ json: { ok: true, connection: current } });
    }
    if (url.pathname === connectionPath + '/oauth/start') {
      starts += 1;
      return route.fulfill({ json: { ok: true, connectUrl: 'https://www.linkedin.com/oauth/v2/authorization?state=synthetic-' + starts, expiresAt: new Date(Date.now() + 600000).toISOString() } });
    }
    if (url.pathname === connectionPath && request.method() === 'POST') {
      current = { ...current, ...request.postDataJSON(), status: 'blocked', authorizationGranted: false, lastValidationNote: 'Current owner details require validation.' };
      return route.fulfill({ json: { ok: true, connection: current } });
    }
    if (url.pathname === '/api/admin/marketing/publishing/overview') return route.fulfill({ json: { settings: {}, channelReadiness: [], latestCycles: [], openCycleCount: 0 } });
    return route.fulfill({ json: { ok: true, items: [], packets: [], counts: {}, review: { items: [] }, log: {}, library: {} } });
  });
  await context.addInitScript(() => {
    window.__oauthOpens = [];
    window.__connectionBodiesRead = 0;
    window.__organizationAssignments = [];
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      ...value,
      set(next) {
        if (this.id === 'marketingLinkedInOrgId') window.__organizationAssignments.push(String(next));
        value.set.call(this, next);
      },
    });
    const originalOpen = window.open.bind(window);
    window.open = (url, name, features) => {
      window.__oauthOpens.push({ url, name, features });
      // Exercise a real isolated local window while returning the legitimate
      // ambiguous null of noopener. Never navigate to a real provider.
      originalOpen(location.origin + '/__fake-linkedin-authorization', name, features);
      return null;
    };
    const json = Response.prototype.json;
    Response.prototype.json = async function(...args) {
      const payload = await json.apply(this, args);
      if (new URL(this.url).pathname.endsWith('/channel-connections/linkedin_company')) {
        setTimeout(() => { window.__connectionBodiesRead += 1; }, 0);
      }
      return payload;
    };
  });
  const page = await context.newPage();
  try {
    await page.goto(server.origin + '/admin-dashboard.html#marketing-drafts');
    await expect(page.locator('#adminGrowthView')).toBeVisible();
    await page.locator('#adminGrowthView').selectOption('posting');
    await page.locator('[data-growth-view="posting"] summary').filter({ hasText: /^LinkedIn connection$/ }).click();
    const connect = page.locator('#marketingLinkedInConnectBtn'), refresh = page.locator('#marketingLinkedInRefreshBtn'), status = page.locator('#marketingLinkedInConnectionStatus');
    await expect(connect).toBeVisible();
    const popupPromise = context.waitForEvent('page');
    await connect.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await expect(connect).toBeEnabled();
    await expect(status).toContainText(/refresh/i);
    await expect(status).not.toContainText('Popup was blocked');
    expect(starts).toBe(1);
    await popup.close();
    await expect(connect).toBeEnabled();

    current = { status: 'connected_validated', organizationId: '12345', organizationUrn: 'urn:li:organization:12345', organizationName: 'Verified synthetic organization', authorizationGranted: true, lastValidationNote: 'Synthetic authorization completed.', scopeSnapshot: ['w_organization_social', 'rw_organization_admin'] };
    await refresh.click();
    await expect(status).toContainText('Synthetic authorization completed.');
    await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('12345');
    expect(starts).toBe(1);

    current = { ...current, status: 'auth_failed', authorizationGranted: false, lastValidationNote: 'Synthetic consent declined.' };
    await refresh.click();
    await expect(status).toContainText('Synthetic consent declined.');
    await expect(connect).toBeEnabled();
    failNextRead = true;
    await refresh.click();
    await expect(status).toContainText('Synthetic connection status is temporarily unavailable.');
    await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('12345');

    // Hold an authenticated old read, then save a newer owner intent. The old
    // response must not restore the previous organization or error state.
    holdNextRead = true; entered = deferred();
    const bodiesBefore = await page.evaluate(() => window.__connectionBodiesRead);
    await refresh.click(); await entered.promise;
    await page.locator('#marketingLinkedInOrgId').fill('67890');
    await page.locator('#marketingLinkedInOrgUrn').fill('urn:li:organization:67890');
    await page.locator('#marketingLinkedInOrgName').fill('Current owner selection');
    await page.locator('#marketingLinkedInSaveBtn').click();
    await expect(status).toContainText('LinkedIn connection saved.');
    await heldRoute.fulfill({ json: { ok: true, connection: heldSnapshot } }); heldRoute = null;
    await expect.poll(() => page.evaluate(() => window.__connectionBodiesRead)).toBeGreaterThan(bodiesBefore + 1);
    await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('67890');

    // A legacy same-origin callback is a read hint, never authority to render
    // its supplied (possibly stale) connection payload.
    const readsBeforeMessage = reads;
    await page.evaluate(() => { window.__organizationAssignments.length = 0; });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { type: 'marketing-linkedin-oauth', payload: { ok: true, message: 'Stale callback', connection: { status: 'connected_validated', organizationId: 'stale-org', organizationName: 'Stale callback organization' } } } })));
    await expect.poll(() => reads).toBeGreaterThan(readsBeforeMessage);
    await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('67890');
    await expect(status).not.toContainText('Stale callback');
    expect(await page.evaluate(() => window.__organizationAssignments)).not.toContain('stale-org');
    await expect(connect).toBeEnabled();

    opens.push(...await page.evaluate(() => window.__oauthOpens));
    expect(opens).toHaveLength(1);
    expect(opens[0].features.split(',')).toContain('noopener');
    expect(mutations.filter(row => row.path.startsWith(connectionPath))).toEqual([
      { method: 'POST', path: connectionPath + '/oauth/start' },
      { method: 'POST', path: connectionPath },
    ]);
    // The existing Growth refresh also prepares its internal daily log. Keep
    // every observed mutation accounted for; no publish or other action is
    // permitted in this controlled Connect journey.
    for (const mutation of mutations.filter(row => !row.path.startsWith(connectionPath))) {
      expect(mutation).toEqual({ method: 'POST', path: '/api/admin/marketing/founder-daily-log/refresh' });
    }
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(connect).toBeVisible();
      await page.locator('#marketingLinkedInConnectionForm').scrollIntoViewIfNeeded();
      await connect.scrollIntoViewIfNeeded();
      await expect(connect).toBeInViewport();
      await expect(status).toBeInViewport();
      failNextRead = true;
      await refresh.click();
      await expect(status).toHaveText('Synthetic connection status is temporarily unavailable.');
      await expect(refresh).toBeEnabled();
      const recoveryGeometry = await page.evaluate(() => {
        const status = document.getElementById('marketingLinkedInConnectionStatus'), refresh = document.getElementById('marketingLinkedInRefreshBtn'), toast = document.getElementById('toastBanner');
        const range = document.createRange(); range.selectNodeContents(status);
        const lines = Array.from(range.getClientRects(), r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        const t = toast.getBoundingClientRect(), r = refresh.getBoundingClientRect();
        const shown = toast.classList.contains('show') && Number(getComputedStyle(toast).opacity) > 0;
        const overlaps = p => shown && p.left < t.right && p.right > t.left && p.top < t.bottom && p.bottom > t.top;
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return { lines, textInViewport: lines.length > 0 && lines.every(p => p.top >= 0 && p.bottom <= innerHeight && p.left >= 0 && p.right <= innerWidth), statusCovered: lines.some(overlaps), refreshCovered: overlaps(r), refreshHitIsControl: hit === refresh || refresh.contains(hit), toastShown: shown };
      });
      await info.attach('connect-status-recovery-' + width, { body: JSON.stringify(recoveryGeometry, null, 2), contentType: 'application/json' });
      expect(recoveryGeometry.textInViewport).toBe(true); expect(recoveryGeometry.statusCovered).toBe(false);
      expect(recoveryGeometry.refreshCovered).toBe(false); expect(recoveryGeometry.refreshHitIsControl).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('linkedin-recovery-' + width + '.png'), fullPage: true, animations: 'disabled' });
      await expect(page.locator('#marketingLinkedInOrgId')).toHaveValue('67890');
      await refresh.click(); await expect(status).toContainText('Current owner details require validation.');
    }
    expect(server.evidence().external.mail).toHaveLength(0);
    expect(server.evidence().external.storage).toHaveLength(0);
    const anonymous = await browser.newContext();
    try { expect((await anonymous.request.get(server.origin + connectionPath)).status()).toBe(401); }
    finally { await anonymous.close(); }
  } finally { await context.close(); }
});
