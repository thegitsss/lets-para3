'use strict';
const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const list = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message));
  await page.route('**/login.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="under-test"></main></body></html>' }));
  await page.goto('/login.html');
});
test.afterEach(async ({ page, context }) => { await context.close(); expect(errors.get(page)).toEqual([]); });
async function savedViews(page, uncertain = false) {
  await page.evaluate(async uncertain => {
    const { applicationSavedViews } = await import('/assets/scripts/paralegal-v2/application-saved-views.mjs');
    const ownerId = 'a'.repeat(24), scope = 'paralegal_applications';
    let filters = { search: 'Synthetic', status: '', practice: '', dateRange: 'all', sort: 'recent' }, views = [];
    window.calls = [];
    const api = {
      get: async url => { window.calls.push({ method: 'GET', url }); return url === '/api/auth/me' ? { user: { id: ownerId, role: 'paralegal' } } : { ownerId, scope, views: structuredClone(views) }; },
      post: async (url, body) => { window.calls.push({ method: 'POST', url, body }); const view = { ...body, revision: 'b'.repeat(64) }; views = [view]; if (uncertain) throw Error('Synthetic response lost after saved write'); return { view }; },
      request: async (url, options) => { window.calls.push({ method: options.method, url, body: JSON.parse(options.body) }); views = []; return {}; },
    };
    const host = applicationSavedViews({ api, ownerId, isCurrent: () => true, getFilters: () => filters, applyFilters: value => { filters = value; }, state: {} });
    document.querySelector('#under-test').append(host);
    window.savedViewHarness = { host, clearFilters: () => { filters = { search: '', status: '', practice: '', dateRange: 'all', sort: 'recent' }; host.sync(); }, filters: () => filters };
  }, uncertain);
  await expect(page.getByRole('button', { name: 'Save view', exact: true })).toBeEnabled();
}
test('application saved views retain cancel, save, select, delete and request authority', async ({ page }) => {
  await savedViews(page);
  const save = page.locator('#under-test').getByRole('button', { name: 'Save view', exact: true });
  await save.click();
  let dialog = page.getByRole('dialog', { name: 'Save application view' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(save).toBeFocused();
  expect(await page.evaluate(() => window.calls.filter(call => call.method === 'POST'))).toEqual([]);
  await save.click(); dialog = page.getByRole('dialog', { name: 'Save application view' });
  await dialog.getByLabel('View name').fill('Synthetic research');
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('View saved.');
  const id = await page.getByLabel('Saved application views').inputValue();
  await page.evaluate(() => window.savedViewHarness.clearFilters());
  await page.getByLabel('Saved application views').selectOption(id);
  expect(await page.evaluate(() => window.savedViewHarness.filters().search)).toBe('Synthetic');
  await page.getByRole('button', { name: 'Delete view', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('View deleted. Applied filters are unchanged.');
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(calls.find(call => call.method === 'POST').body).toMatchObject({ scope: 'paralegal_applications', expectedOwnerId: 'a'.repeat(24) });
  expect(calls.find(call => call.method === 'DELETE').body).toEqual({ revision: 'b'.repeat(64), expectedOwnerId: 'a'.repeat(24) });
});
test('application saved views reconcile an uncertain saved write without repeating it', async ({ page }) => {
  await savedViews(page, true);
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save application view' });
  await dialog.getByLabel('View name').fill('Synthetic uncertain research');
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saving was not confirmed');
  await expect(page.locator('#under-test').getByRole('button', { name: 'Save view', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check saved views', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('View saved.');
  expect(await page.evaluate(() => window.calls.filter(call => call.method === 'POST').length)).toBe(1);
});
test('appearance transition cancellation cleans up and unexpected failure is reported', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { applyAppearance } = await import('/assets/scripts/utils/appearance.mjs');
    const warnings = [], previous = console.warn; console.warn = (...args) => warnings.push(String(args[0]));
    let failure = new DOMException('Synthetic intentional reversal', 'AbortError');
    document.startViewTransition = commit => { commit(); return { skipTransition() {}, finished: Promise.reject(failure) }; };
    try {
      applyAppearance('light'); applyAppearance('dark');
      await new Promise(resolve => setTimeout(resolve, 0));
      const canceled = { warnings: [...warnings], theme: document.documentElement.classList.contains('theme-dark'), pending: document.documentElement.hasAttribute('data-lpc-appearance-transition') };
      failure = Error('Synthetic unexpected transition failure'); applyAppearance('light');
      await new Promise(resolve => setTimeout(resolve, 0));
      return { canceled, warnings, pending: document.documentElement.hasAttribute('data-lpc-appearance-transition'), light: document.documentElement.classList.contains('theme-light') };
    } finally { console.warn = previous; }
  });
  expect(result.canceled).toEqual({ warnings: [], theme: true, pending: false });
  expect(result.warnings).toEqual(['Theme transition did not finish.']);
  expect(result.pending).toBe(false); expect(result.light).toBe(true);
});
test('rapid shortcut menu reversal cleans up canceled animations and retains focus', async ({ page }) => {
  await page.evaluate(async () => {
    const { createFrequentShortcuts } = await import('/assets/scripts/utils/frequent-shortcuts.mjs');
    const ownerId = 'a'.repeat(24);
    localStorage.setItem(`lpc-shortcuts:v1:paralegal:${ownerId}:pinned`, JSON.stringify(['/settings']));
    createFrequentShortcuts({ role: 'paralegal', host: document.querySelector('#under-test') }).scopeToIdentity({ id: ownerId, role: 'paralegal' });
  });
  const manage = page.getByRole('link', { name: 'Profile settings', exact: true });
  await manage.click({ button: 'right' }); await expect(page.getByRole('menu', { name: 'Shortcut actions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await manage.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Shortcut actions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Shortcut actions' })).toHaveCount(0);
  await expect(manage).toBeFocused();
});
