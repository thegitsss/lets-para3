const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { test, expect } = require('playwright/test');
const startServer = require(path.resolve(__dirname, '../../../../docs/audits/completion-2026-09-09/closure/paralegal/backend-browser-server.cjs'));

let server, cacheProxy, cacheEligible = false;
const authResponses = [];
let authHold = null;
let authUnavailable = false;
function holdAuth() {
  let release;
  const hold = { entered: false, promise: new Promise(resolve => { release = resolve; }) };
  authHold = hold;
  return { hold, release() { authHold = null; release(); } };
}
test.beforeAll(async () => {
  test.setTimeout(120000);
  server = await startServer({ port: 5317, frontendRoot: process.env.LPC_PARA_CLOSURE_FRONTEND_ROOT });
  cacheProxy = http.createServer(async (request, response) => {
    const destination = new URL(request.url, server.origin);
    if (destination.pathname === '/api/auth/me' && authUnavailable) {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'Synthetic verification unavailable' }));
      return;
    }
    if (destination.pathname === '/api/auth/me' && authHold) {
      const hold = authHold;
      hold.entered = true;
      await hold.promise;
    }
    const upstream = http.request(destination, { method: request.method, headers: { ...request.headers, host: destination.host } }, incoming => {
      const headers = { ...incoming.headers };
      // Test only: permit document caching while retaining exact API headers and bytes.
      // The separate actual-header cases preserve the application's no-store policy.
      if (cacheEligible && destination.pathname.endsWith('.html') && String(headers['content-type']).includes('text/html')) headers['cache-control'] = 'private, max-age=0';
      if (destination.pathname === '/api/auth/me') {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
          authResponses.push({ status: incoming.statusCode, hasUser: Boolean(JSON.parse(Buffer.concat(chunks).toString()).user) });
        });
      }
      response.writeHead(incoming.statusCode, headers);
      incoming.pipe(response);
    });
    upstream.on('error', error => { response.writeHead(502); response.end(error.code || 'Local test proxy unavailable'); });
    request.pipe(upstream);
  });
  await new Promise(resolve => cacheProxy.listen(5318, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  if (cacheProxy) { cacheProxy.closeAllConnections(); await new Promise(resolve => cacheProxy.close(resolve)); }
  await server?.close();
});

for (const role of ['attorney', 'paralegal']) test(`${role}: a cached workspace rechecks the server rollback before revealing its saved form`, async ({ page, context, browserName }, info) => {
  cacheEligible = true;
  const WorkspaceRelease = require('../../../models/WorkspaceRelease');
  const marker = 'PrivateRollbackForm';
  const owner = await server.createUser({ role, firstName: marker });
  const admin = await server.createUser({ role: 'admin' });
  await WorkspaceRelease.deleteMany({});
  await WorkspaceRelease.create({ revision: 1, enabled: true, killSwitch: false, attorney: { basisPoints: 10000, overrides: {} }, paralegal: { basisPoints: 10000, overrides: {} }, updatedBy: admin.id });
  const events = [];
  await page.exposeBinding('__recordRollbackHistory', (_source, value) => events.push(value));
  await page.addInitScript(() => addEventListener('pageshow', event => { void window.__recordRollbackHistory({ path: location.pathname, persisted: event.persisted }); }));
  await context.addCookies([owner.cookie]);
  try {
    const origin = 'http://localhost:5318';
    await page.goto(origin + `/${role}-v2.html#/settings?tab=profile`);
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue(marker);
    await page.goto(origin + '/terms.html');
    // Fixture setup only: the Admin transaction/CSRF/audit is verified separately.
    // Here the cached document must consume a changed real endpoint response.
    await WorkspaceRelease.updateOne({ _id: 'workspaces', revision: 1 }, { $set: { revision: 2, killSwitch: true } });
    const hold = holdAuth();
    await page.goBack({ waitUntil: 'commit' });
    try {
      await expect.poll(() => hold.hold.entered).toBe(true);
      await expect(page.getByLabel('First name', { exact: true })).not.toBeVisible();
    } finally { hold.release(); }
    await expect(page).toHaveURL(origin + `/profile-settings.html?role=${role}&tab=profile`);
    const cached = events.some(event => event.path === `/${role}-v2.html` && event.persisted);
    if (browserName === 'chromium') expect(cached).toBe(true);
    const response = await page.request.get(origin + '/api/auth/me');
    const user = (await response.json()).user;
    expect(String(user.id || user._id)).toBe(owner.id);
    await fs.writeFile(info.outputPath('rollback-history-evidence.json'), JSON.stringify({ role, browserName, cached, events, sessionRetained: true }, null, 2));
  } finally { await WorkspaceRelease.deleteMany({}); }
});

for (const cacheMode of ['actual-headers', 'cache-eligible-test']) for (const role of ['attorney', 'paralegal']) test(`${role}: actual cross-document Back rechecks the workspace and conceals a revoked account (${cacheMode})`, async ({ page, context, browserName }, info) => {
  const marker = role === 'attorney' ? 'PrivateAttorneyHistory' : 'PrivateParalegalHistory';
  const owner = await server.createUser({ role, firstName: marker });
  cacheEligible = cacheMode === 'cache-eligible-test';
  authResponses.length = 0;
  await context.addCookies([owner.cookie]);
  const events = [], cacheDiagnostics = [];
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', event => cacheDiagnostics.push(event.notRestoredExplanations));
  }
  await page.exposeBinding('__recordHistoryEvidence', (_source, value) => { events.push(value); });
  await page.addInitScript(({ marker }) => {
    const documentId = crypto.randomUUID();
    window.addEventListener('pageshow', event => {
      const metadata = { type: 'pageshow', documentId, path: location.pathname, persisted: event.persisted, phase: sessionStorage.getItem('lpc-history-test-phase') || 'initial' };
      void window.__recordHistoryEvidence(metadata);
      requestAnimationFrame(() => {
        void window.__recordHistoryEvidence({ ...metadata, type: 'first-frame', priorIdentityVisible: (document.body.innerText.includes(marker) || [...document.querySelectorAll('input, textarea')].some(field => field.value.includes(marker) && field.checkVisibility())) });
      });
    });
  }, { marker });
  // Observe real response bytes at the proxy: Chromium may discard the CDP
  // response body when a restored page immediately redirects after revocation.
  const origin = 'http://localhost:5318';
  const entry = `/${role}-v2.html#/settings?${role === 'attorney' ? 'tab' : 'section'}=profile`;
  await page.goto(origin + entry);
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue(marker);
  await expect.poll(() => page.evaluate(value => (document.body.innerText.includes(value) || [...document.querySelectorAll('input, textarea')].some(field => field.value.includes(value) && field.checkVisibility())), marker)).toBe(true);
  await page.goto(origin + '/terms.html');
  await page.evaluate(() => sessionStorage.setItem('lpc-history-test-phase', 'control-return'));
  const controlHold = holdAuth();
  // A restored document does not fire DOMContentLoaded again.
  await page.goBack({ waitUntil: 'commit' });
  try {
    await expect.poll(() => controlHold.hold.entered).toBe(true);
    expect(await page.evaluate(value => (document.body.innerText.includes(value) || [...document.querySelectorAll('input, textarea')].some(field => field.value.includes(value) && field.checkVisibility())), marker)).toBe(false);
    await expect(page.getByLabel('First name', { exact: true })).not.toBeVisible();
  } finally { controlHold.release(); }
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue(marker);
  const control = await page.evaluate(() => ({ navigationType: performance.getEntriesByType('navigation')[0]?.type, notRestoredReasons: performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON?.() || null }));
  await expect.poll(() => events.filter(e => e.type === 'pageshow' && e.phase === 'control-return' && e.path === `/${role}-v2.html`).length).toBeGreaterThan(0);
  const controlRestored = events.some(e => e.type === 'pageshow' && e.phase === 'control-return' && e.persisted && e.path === `/${role}-v2.html`);
  await info.attach('control-history', { body: JSON.stringify({ browserName, role, cacheMode, controlRestored, control, events, cacheDiagnostics }, null, 2), contentType: 'application/json' });
  // Chromium is deliberately launched without Playwright's cache-disabling flag.
  // Other engines report their actual policy rather than pretending a reload is cached.
  if (browserName === 'chromium' && cacheMode === 'cache-eligible-test') expect(controlRestored).toBe(true);
  await page.goto(origin + '/terms.html');
  await page.evaluate(() => sessionStorage.setItem('lpc-history-test-phase', 'revoked-return'));
  const User = require(path.resolve(__dirname, '../../../models/User'));
  await User.updateOne({ _id: owner.id }, { $set: { disabled: true } });
  const revokedHold = holdAuth();
  await page.goBack({ waitUntil: 'commit' });
  try {
    await expect.poll(() => revokedHold.hold.entered).toBe(true);
    expect(await page.evaluate(value => (document.body.innerText.includes(value) || [...document.querySelectorAll('input, textarea')].some(field => field.value.includes(value) && field.checkVisibility())), marker)).toBe(false);
    await expect(page.getByLabel('First name', { exact: true })).not.toBeVisible();
  } finally { revokedHold.release(); }
  await expect(page).toHaveURL(/\/login.html/);
  await info.attach('revoked-history', { body: JSON.stringify({ browserName, role, cacheMode, events, authResponses }, null, 2), contentType: 'application/json' });
  // The real optional identity endpoint returns 200 { user: null } after revocation.
  await expect.poll(() => authResponses.some(response => response.status === 200 && response.hasUser === false)).toBe(true);
  expect(await page.evaluate(value => (document.body.innerText.includes(value) || [...document.querySelectorAll('input, textarea')].some(field => field.value.includes(value) && field.checkVisibility())), marker)).toBe(false);
  const revokedEvents = events.filter(e => e.phase === 'revoked-return' && e.path === `/${role}-v2.html`);
  expect(revokedEvents.filter(e => e.type === 'first-frame' && e.priorIdentityVisible)).toEqual([]);
  const revokedRestored = revokedEvents.some(e => e.type === 'pageshow' && e.persisted);
  if (browserName === 'chromium' && cacheMode === 'cache-eligible-test') expect(revokedRestored).toBe(true);
  const evidence = { browserName, role, cacheMode, controlRestored, revokedRestored, control, events, authResponses, revokedAccountConcealed: true };
  await fs.writeFile(info.outputPath('actual-history-evidence.json'), JSON.stringify(evidence, null, 2));
});

test('paralegal: an unavailable history verification conceals the saved page and permits deliberate retry', async ({ page, context, browserName }, info) => {
  cacheEligible = true;
  const marker = 'PrivateUnavailableHistory';
  const owner = await server.createUser({ role: 'paralegal', firstName: marker });
  await context.addCookies([owner.cookie]);
  await page.addInitScript(() => window.addEventListener('pageshow', event => { window.__historyPersisted = event.persisted; }));
  const origin = 'http://localhost:5318';
  await page.goto(origin + '/paralegal-v2.html#/settings?section=profile');
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue(marker);
  await page.goto(origin + '/terms.html');
  authUnavailable = true;
  try {
    await page.goBack({ waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: /Your account could not be verified|LPC is temporarily unavailable/ })).toBeVisible();
    const restored = await page.evaluate(() => window.__historyPersisted === true);
    if (browserName === 'chromium') expect(restored).toBe(true);
    expect(await page.evaluate(value => (document.body.innerText.includes(value) || [...document.querySelectorAll('input, textarea')].some(field => field.value.includes(value) && field.checkVisibility())), marker)).toBe(false);
    await expect(page.getByLabel('First name', { exact: true })).not.toBeVisible();
    const retry = page.getByRole('button', { name: 'Try again', exact: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    // A fresh-load recovery can retain the skip link before Retry; macOS
    // WebKit includes buttons in native sequential navigation with Option+Tab.
    const nextKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    for (let step = 0; step < 4 && !await retry.evaluate(button => button === document.activeElement); step += 1) {
      await page.keyboard.press(nextKey);
    }
    await expect(retry).toBeFocused();
    await page.screenshot({ path: info.outputPath('history-verification-unavailable-light.png') });
    await page.setViewportSize({ width: 320, height: 780 });
    await page.evaluate(() => { document.documentElement.classList.replace('theme-light', 'theme-dark'); document.documentElement.style.fontSize = '22px'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('history-verification-unavailable-dark-xl.png') });
    authUnavailable = false;
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue(marker);
    await expect(page.getByLabel('First name', { exact: true })).toBeVisible();
    await expect(page.locator('[data-v2-history-gate]')).toHaveCount(0);
    await fs.writeFile(info.outputPath('history-retry-evidence.json'), JSON.stringify({ browserName, restored, concealedWhileUnavailable: true, keyboardRetryRecovered: true }, null, 2));
  } finally { authUnavailable = false; }
});
