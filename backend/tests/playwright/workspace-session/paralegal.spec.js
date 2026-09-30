const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { USER_ID, json, installSettingsProjection } = require('../paralegal-support/settings-fixtures');
const OLD = '64b000000000000000000099';
const NEXT = '64b000000000000000000002';
const draftKey = id => `lpc_v2_profile_draft_v1:${id}`;
const settings = page => page.locator('[data-v2-settings]');
const recovery = page => page.locator('[data-v2-settings-recovery]');
const first = page => page.getByLabel('First name', { exact: true });
const sessionSignal = page => page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue: 'previous identity', newValue: 'check current identity' })));
async function setup(page, { cache, drafts = {}, ...options } = {}) {
  const state = await installSettingsProjection(page, { preserveCachedIdentity: true, ...options });
  state.reads = []; state.errors = [];
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) state.reads.push({ path: url.pathname, owner: url.searchParams.get('expectedOwnerId'), method: request.method() });
  });
  await page.addInitScript(({ cache, drafts }) => {
    window.EventSource = class extends EventTarget { close() {} };
    if (sessionStorage.getItem('session-fixture-initialized')) return;
    sessionStorage.setItem('session-fixture-initialized', '1');
    if (cache !== undefined) localStorage.setItem('lpc_user', typeof cache === 'string' ? cache : JSON.stringify(cache));
    for (const [id, profile] of Object.entries(drafts)) sessionStorage.setItem(`lpc_v2_profile_draft_v1:${id}`, JSON.stringify({ savedAt: Date.now(), profile, fields: ['firstName'], baselines: { firstName: { firstName: 'Dana' } } }));
  }, { cache, drafts });
  // Strict current-account profile reads also support the deliberate reload.
  await page.route(url => url.pathname === '/api/users/me', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(state.user._id);
    return json(route, state.user);
  });
  await page.route(url => url.pathname === '/api/account/preferences', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(state.user._id);
    return json(route, state.preferences);
  });
  return state;
}
async function open(page, route = '#/settings?tab=profile') {
  await page.goto('/paralegal-v2.html' + route);
  await expect(settings(page)).toBeVisible();
  await expect(first(page)).toHaveValue('Dana');
}
const privateReads = state => state.reads.filter(r => r.path === '/api/users/me' || r.path.startsWith('/api/account/'));

test('a stale cached identity opens only the newly verified account and cannot restore the old draft', async ({ page }, info) => {
  const state = await setup(page, { cache: { id: OLD, role: 'paralegal', firstName: 'Old cached name', avatarURL: '/api/uploads/old-cached-avatar', preferences: { theme: 'dark', fontSize: 'xl' } }, drafts: { [OLD]: { firstName: 'Private old draft' } } });
  let release; const held = new Promise(resolve => { release = resolve; }); let received = false;
  await page.route('**/api/auth/me', async route => { received = true; await held; return json(route, { user: state.user }); });
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await expect.poll(() => received).toBe(true);
  expect(privateReads(state)).toEqual([]); await expect(settings(page)).toHaveCount(0);
  await expect(page.locator('[data-v2-profile-name]')).toHaveText('Member');
  await expect(page.locator('[data-v2-profile-avatar]')).toHaveAttribute('src', '/assets/avatar-placeholder.svg');
  expect(state.reads.some(read => read.path === '/api/uploads/old-cached-avatar')).toBe(false);
  expect(state.reads.filter(read => read.path === '/api/auth/me')).toHaveLength(1);
  release(); await expect(first(page)).toHaveValue('Dana');
  expect(privateReads(state).every(read => read.owner === USER_ID)).toBe(true);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-v2-profile-name]')).toHaveText('Dana Young');
  await expect(page.locator('html')).toHaveClass(/theme-light/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')).id)).toBe(USER_ID);
  for (const width of [1366, 320]) { await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: info.outputPath(`fresh-owner-${width}.png`) }); }
  expect(state.profilePatches).toEqual([]); expect(state.errors).toEqual([]);
});

test('the same verified owner retains saved appearance and can deliberately restore their own draft', async ({ page }) => {
  const state = await setup(page, { cache: { id: USER_ID, role: 'paralegal', preferences: { theme: 'dark', fontSize: 'lg' } }, user: { preferences: { theme: 'dark', fontSize: 'lg' } }, preferences: { theme: 'dark', fontSize: 'lg' }, drafts: { [USER_ID]: { firstName: 'Dana draft' } } });
  await open(page); await expect(page.locator('html')).toHaveClass(/theme-dark/);
  expect(await page.locator('html').evaluate(el => getComputedStyle(el).fontSize)).toBe('20px');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(first(page)).toHaveValue('Dana draft'); expect(state.profilePatches).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const cache of ['{invalid', null]) test(`unusable cache ${cache === null ? 'null' : 'malformed'} does not prevent verified Settings`, async ({ page }) => {
  const state = await setup(page, { cache }); await open(page); expect(state.errors).toEqual([]);
});

test('an unavailable initial verification keeps tools protected and retries in place', async ({ page }, info) => {
  const state = await setup(page, { cache: { id: OLD, role: 'paralegal' } }); let unavailable = true;
  await page.route('**/api/auth/me', route => json(route, unavailable ? { error: 'Synthetic verification unavailable' } : { user: state.user }, unavailable ? 503 : 200));
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await expect(page.getByRole('heading', { name: 'LPC is temporarily unavailable', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'unavailable');
  for (const name of ['header', 'sidebar']) await expect(page.locator(`[data-v2-persistent="${name}"]`)).toHaveAttribute('inert', '');
  await page.keyboard.press('ControlOrMeta+KeyK'); await expect(page.locator('[data-v2-search-panel]')).toBeHidden();
  expect(privateReads(state)).toEqual([]); await expect(settings(page)).toHaveCount(0);
  for (const width of [1366, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const view = page.locator('[data-v2-session-recovery]');
    await expect.poll(() => view.evaluate(el => { const box = el.getBoundingClientRect(); return el.scrollWidth <= el.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth + 1; })).toBe(true);
    expect((await new AxeBuilder({ page }).include('[data-v2-session-recovery]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`verification-unavailable-${width}.png`) });
  }
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  await retry.click(); await expect(retry).toBeEnabled();
  expect(privateReads(state)).toEqual([]);
  unavailable = false; await retry.click(); await expect(first(page)).toHaveValue('Dana');
  for (const name of ['header', 'sidebar']) await expect(page.locator(`[data-v2-persistent="${name}"]`)).not.toHaveAttribute('inert', '');
  await expect(page).toHaveURL(/paralegal-v2.html#\/settings\?tab=profile$/);
  expect(state.errors).toEqual([]);
});

for (const condition of ['unauthenticated', 'unapproved', 'wrong_role', 'disabled']) test(`${condition} verification cannot use a cached approved account to open Settings`, async ({ page }) => {
  const state = await setup(page, { cache: { id: OLD, role: 'paralegal', status: 'approved' } });
  const user = condition === 'unauthenticated' ? null : { ...state.user, ...(condition === 'unapproved' ? { status: 'pending' } : condition === 'wrong_role' ? { role: 'attorney' } : { disabled: true }) };
  await page.route('**/api/auth/me', route => json(route, { user }));
  await page.route(url => ['/login.html', '/paralegal-admission.html', '/dashboard-attorney.html'].includes(url.pathname), route => route.fulfill({ contentType: 'text/html', body: '<h1>Expected session destination</h1>' }));
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await expect(page).toHaveURL(condition === 'wrong_role' ? /dashboard-attorney.html$/ : condition === 'unapproved' ? /paralegal-admission.html$/ : /login.html(?:\?|$)/);
  expect(privateReads(state)).toEqual([]); await expect(settings(page)).toHaveCount(0); expect(state.errors).toEqual([]);
});

test('a real verified account change revokes the old draft and provides explicit Settings reentry', async ({ page }, info) => {
  const state = await setup(page); await open(page);
  await first(page).fill('Private unsent first name');
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), draftKey(USER_ID))).not.toBeNull();
  state.user = { ...state.user, _id: NEXT, id: NEXT, firstName: 'Blair', resumeURL: '', certificateURL: '', writingSampleURL: '' };
  await sessionSignal(page);
  await expect(recovery(page)).toBeVisible(); await expect(page.locator('main')).not.toContainText('Private unsent first name');
  await expect(first(page)).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), draftKey(USER_ID))).toBeNull();
  for (const layout of [{ width: 1366, theme: 'light', size: '100%' }, { width: 320, theme: 'dark', size: '200%' }]) {
    await page.setViewportSize({ width: layout.width, height: 900 });
    await page.evaluate(({ theme, size }) => { document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = size; }, layout);
    await expect.poll(() => recovery(page).evaluate(el => { const box = el.getBoundingClientRect(); return el.scrollWidth <= el.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth + 1; })).toBe(true);
    expect((await new AxeBuilder({ page }).include('[data-v2-settings-recovery]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`account-changed-${layout.width}-${layout.theme}.png`) });
  }
  await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
  await expect(first(page)).toHaveValue('Blair'); await expect(recovery(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
  expect(state.profilePatches).toEqual([]); expect(privateReads(state).some(read => read.owner === NEXT)).toBe(true); expect(state.errors).toEqual([]);
});

test('an old account read resolving after replacement cannot repopulate Settings', async ({ page }) => {
  const state = await setup(page);
  await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = async (...args) => { const response = await fetch(...args); if (window.__holdNextAccountRead && String(args[0]).startsWith('/api/users/me?') && !window.__heldAccountRead) { window.__heldAccountRead = true; const body = await response.clone().text(); await new Promise(resolve => { window.__releaseAccountRead = resolve; }); window.__accountReadReleased = true; return new Response(body, { status: response.status, headers: response.headers }); } return response; }; });
  await open(page);
  await page.evaluate(() => { window.__holdNextAccountRead = true; });
  await sessionSignal(page);
  await expect.poll(() => page.evaluate(() => typeof window.__releaseAccountRead)).toBe('function');
  state.user = { ...state.user, _id: NEXT, id: NEXT, firstName: 'Blair', resumeURL: '', certificateURL: '', writingSampleURL: '' };
  await sessionSignal(page); await expect(recovery(page)).toBeVisible();
  await page.evaluate(() => window.__releaseAccountRead());
  await expect.poll(() => page.evaluate(() => window.__accountReadReleased)).toBe(true);
  await expect(recovery(page)).toBeVisible(); await expect(first(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
  await expect(first(page)).toHaveValue('Blair'); expect(state.profilePatches).toEqual([]); expect(state.errors).toEqual([]);
});

test('a stale identity also recovers the current owner profile preview', async ({ page }) => {
  const state = await setup(page, { cache: { id: OLD, role: 'paralegal' } });
  await page.goto('/paralegal-v2.html#/profile/me');
  await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();
  await expect(page.locator('[data-v2-profile-preview] h1')).toHaveText('Dana Young');
  expect(privateReads(state).every(read => read.owner === USER_ID)).toBe(true);
  state.user = { ...state.user, _id: NEXT, id: NEXT, firstName: 'Blair', resumeURL: '', certificateURL: '', writingSampleURL: '' };
  await sessionSignal(page); await expect(recovery(page)).toBeVisible();
  await expect(page.locator('[data-v2-profile-preview]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
  await expect(page.locator('[data-v2-profile-preview] h1')).toHaveText('Blair Young');
  expect(state.errors).toEqual([]);
});
