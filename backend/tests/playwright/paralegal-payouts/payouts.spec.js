const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installCurrentHome, USER, json } = require('../paralegal-support/current-home-fixtures');
const financial = require('../paralegal-support/financial-fixtures');
const root = page => page.locator('[data-v2-payouts]');
async function fixture(page, overrides = {}) {
  await page.route('**/api/**', route => json(route, {}));
  const state = await installCurrentHome(page, { dashboard: { activeCases: [], metrics: { earnings: 840, earningsLast30Days: 1120, earningsTotal: 4820 } }, ...overrides });
  await page.route('**/api/auth/workspace-release', route => json(route, { workspace: { schemaVersion: 1, ownerId: USER, role: 'paralegal', revision: 1, version: 'v2', defaultDestination: '/paralegal-v2.html#/home' } }));
  return state;
}
async function open(page, hash = '/payouts') {
  await page.goto(`/paralegal-v2.html#${hash}`);
  await expect(root(page)).toBeVisible();
}

test('independent payouts preserve legacy entry, totals, selected navigation and destinations', async ({ page }) => {
  const state = await fixture(page);
  await open(page, '/home?view=history');
  await expect(root(page)).toHaveAttribute('data-state', 'ready');
  await expect(root(page)).toContainText('$4,820.00');
  await expect(page.locator('.v2-nav-link[data-v2-route="payouts"]')).toHaveAttribute('aria-current', 'page');
  expect(state.reads.dashboard).toBe(1);
  expect(state.reads.recommendations || 0).toBe(0);
  expect(state.reads.invites || 0).toBe(0);
  await expect(root(page).getByRole('link', { name: 'Payment settings' })).toHaveAttribute('href', 'paralegal-v2.html#/settings?tab=security&section=payments');
  await root(page).getByRole('link', { name: 'Completed & withdrawn matters' }).click();
  await expect(page).toHaveURL(/#\/work\?section=history$/);
  await page.goBack();
  await expect(root(page)).toContainText('$4,820.00');
  expect(state.mutations).toEqual([]);
});

test('a failed source is unavailable, never zero, and retries without unrelated Home reads', async ({ page }) => {
  const state = await fixture(page, { failures: { dashboard: 503 } });
  await open(page);
  await expect(root(page)).toHaveAttribute('data-state', 'unavailable');
  await expect(root(page)).not.toContainText('No payouts recorded');
  await expect(root(page)).not.toContainText('$0.00');
  state.failures.dashboard = 0;
  await root(page).getByRole('button', { name: 'Refresh payouts' }).click();
  await expect(root(page)).toContainText('$4,820.00');
  expect(state.reads.recommendations || 0).toBe(0);
});

test('wrong-owner totals are rejected and a broken estimate preserves verified payouts', async ({ page }) => {
  const state = await fixture(page);
  state.dashboard.metrics.earningsReport.ownerId = '64b000000000000000000999';
  await open(page);
  await expect(root(page)).toHaveAttribute('data-state', 'unavailable');
  state.dashboard.metrics.earningsReport = financial.earnings(USER, { earningsTotal: 4820 });
  state.dashboard.metrics.expectedCompensation = null;
  await root(page).getByRole('button', { name: 'Refresh payouts' }).click();
  await expect(root(page)).toContainText('$4,820.00');
  await expect(root(page)).toContainText('Active-work estimate unavailable.');
  state.dashboard.metrics.expectedCompensation = financial.expected(USER);
  await root(page).getByRole('button', { name: 'Refresh payouts' }).click();
  await expect(root(page)).not.toContainText('Active-work estimate unavailable.');
});

test('account replacement during a delayed read never renders the previous account totals', async ({ page }) => {
  const state = await fixture(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route(url => url.pathname === '/api/paralegal/dashboard', async route => { requested = true; await gate; await json(route, state.dashboard).catch(() => {}); });
  await open(page);
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => { window.__leakedPayout = false; new MutationObserver(() => { if (document.body.textContent.includes('$4,820.00')) window.__leakedPayout = true; }).observe(document.body, { subtree: true, childList: true }); });
  state.profile = { ...state.profile, id: '64b000000000000000000999', _id: '64b000000000000000000999' };
  release();
  await expect(page).toHaveURL(/login.html/);
  await expect(page.locator('body')).not.toContainText('$4,820.00');
});

test('leaving a delayed payout read cannot overwrite the next route', async ({ page }) => {
  const state = await fixture(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route(url => url.pathname === '/api/paralegal/dashboard', async route => { requested = true; await gate; await json(route, state.dashboard).catch(() => {}); });
  await open(page);
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => { location.hash = '/help'; });
  await expect(page.locator('[data-v2-rendered-route="help"]')).toBeVisible();
  release();
  await expect(root(page)).toHaveCount(0);
  await expect(page.locator('[data-v2-rendered-route="help"]')).toBeVisible();
});

test('authorization changes clear already-rendered financial data before rechecking the session', async ({ page }) => {
  await fixture(page); await open(page);
  await expect(root(page)).toContainText('$4,820.00');
  await page.route('**/api/auth/me', route => route.abort('failed'));
  const erased = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'synthetic-account-change', accessMayChange: true } }));
    return !document.body.textContent.includes('$4,820.00');
  });
  expect(erased).toBe(true);
  await expect(page.locator('body')).not.toContainText('$4,820.00');
});

test('a stalled read times out and a deliberate retry can recover', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  let stall = true, requested = false;
  await page.route(url => url.pathname === '/api/paralegal/dashboard', route => {
    requested = true;
    if (!stall) return json(route, state.dashboard);
    // Leave the synthetic response pending until the view aborts its own read.
  });
  await open(page);
  await expect.poll(() => requested).toBe(true);
  await page.clock.fastForward(10001);
  await expect(root(page)).toHaveAttribute('data-state', 'unavailable');
  stall = false;
  await root(page).getByRole('button', { name: 'Refresh payouts' }).click();
  await expect(root(page)).toContainText('$4,820.00');
});

test('login return and route parsing retain the independent payouts destination', async ({ page }) => {
  await fixture(page); await open(page);
  const result = await page.evaluate(async () => {
    const { parseRouteHash } = await import('/assets/scripts/paralegal-v2/router.mjs');
    const { paralegalV2LoginDestination } = await import('/assets/scripts/paralegal-v2/session-boundary.mjs');
    return { direct: parseRouteHash('#/payouts').name, legacy: parseRouteHash('#/home?view=history&from=notice').key, login: paralegalV2LoginDestination('#/payouts') };
  });
  expect(result).toEqual({ direct: 'payouts', legacy: '/payouts?from=notice', login: `login.html?next=${encodeURIComponent('/paralegal-v2.html#/payouts')}` });
});

test('an authoritative empty report is distinct from failure', async ({ page }) => {
  await fixture(page, { dashboard: { activeCases: [], metrics: {} } });
  await open(page);
  await expect(root(page)).toHaveAttribute('data-state', 'ready');
  await expect(root(page)).toContainText('No payouts recorded.');
  await expect(root(page)).not.toContainText('unavailable');
  await expect(root(page).getByRole('table')).toHaveCount(0);
});

test('payouts stay readable on desktop and mobile with keyboard access and no accessibility violations', async ({ page }, info) => {
  await fixture(page); await open(page);
  await expect(root(page)).toHaveAttribute('data-state', 'ready');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(root(page)).toContainText('$4,820.00');
    expect(await root(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`payouts-${width}.png`) });
  }
  const results = await new AxeBuilder({ page }).include('[data-v2-payouts]').analyze();
  expect(results.violations).toEqual([]);
  await root(page).getByRole('link', { name: 'Payment settings' }).focus();
  await expect(root(page).getByRole('link', { name: 'Payment settings' })).toBeFocused();
});
