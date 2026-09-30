const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');
const { fixture } = require('../assistant-boundary/fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const sidebar = page => page.locator('[data-av2-persistent="sidebar"]');
const opener = page => page.locator('[data-av2-nav-toggle]');
const drawer = page => page.getByRole('dialog', { name: 'Attorney navigation', exact: true });
const tab = info => info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
async function start(page, viewport = { width: 390, height: 844 }) {
  await page.setViewportSize(viewport);
  const run = await fixture(page, 'attorney', { setup: async () => {
    await page.route('**/api/auth/workspace-release', route => route.fulfill({ json: { workspace: { schemaVersion: 1, ownerId: '111111111111111111111111', role: 'attorney', revision: 1, version: 'v2', defaultDestination: '/attorney-v2.html#/home' } } }));
  } });
  await expect(page.locator('.v2-help')).toBeVisible();
  await page.evaluate(() => { window.__navigationDocument = document; window.__navigationSidebar = document.querySelector('[data-av2-persistent="sidebar"]'); });
  return run;
}
async function sameDocument(page) {
  expect(await page.evaluate(() => window.__navigationDocument === document && window.__navigationSidebar === document.querySelector('[data-av2-persistent="sidebar"]'))).toBe(true);
}
test.describe('attorney navigation', () => {
  for (const entry of [{ path: '/profile', route: 'profile', label: 'Profile Settings', title: 'Your profile' }, { path: '/payments/setup', route: 'payment-setup', label: 'Payments', title: 'Payment card' }]) test(`${entry.title} retains its parent destination`, async ({ page }, info) => {
    const run = await start(page, { width: 1366, height: 900 });
    const reply = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/users/attorneys/*', route => reply(route, { id: run.state.user.id, name: 'Dana Young', firstName: 'Dana', lastName: 'Young', practiceDescription: 'Synthetic attorney profile for navigation verification.' }));
    await page.route(url => url.pathname === '/api/payments/payment-method/default', route => reply(route, { hasDefault: false, paymentMethod: null }));
    await page.route(url => url.pathname === '/api/users/me/pending-hire', route => reply(route, { ownerId: run.state.user.id, revision: 'a'.repeat(64), pending: null }));
    await page.evaluate(path => { location.hash = '#' + path; }, entry.path);
    await expect(page.locator('html')).toHaveAttribute('data-attorney-route', entry.route);
    await expect(page.getByRole('heading', { name: entry.title, exact: true })).toBeVisible();
    if (entry.route === 'profile') await expect(page.locator('[data-account-preview]')).toContainText('Synthetic attorney profile');
    else await expect(page.getByText('No default payment card is saved.', { exact: true })).toBeVisible();
    if (entry.route === 'profile') await sidebar(page).locator('.av2-brand-menu > summary').click();
    await expect(sidebar(page).getByRole('link', { name: entry.label, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`${entry.route}-parent-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 }); await opener(page).click();
    if (entry.route === 'profile') {
      await expect(drawer(page).locator('.av2-brand-menu > summary')).toBeFocused();
      await drawer(page).locator('.av2-brand-menu > summary').click();
      await expect(drawer(page).getByRole('link', { name: entry.label, exact: true })).toHaveAttribute('aria-current', 'page');
    } else await expect(drawer(page).getByRole('link', { name: entry.label, exact: true })).toBeFocused();
    await sameDocument(page);
  });

  test('desktop collapse retains the selected destination and labels its visible icons', async ({ page }, info) => {
    await start(page, { width: 1366, height: 900 });
    await expect(opener(page)).toHaveAttribute('aria-label', 'Collapse navigation');
    expect((await sidebar(page).boundingBox()).width).toBe(216);
    await opener(page).click(); await expect(opener(page)).toHaveAttribute('aria-label', 'Expand navigation');
    expect((await sidebar(page).boundingBox()).width).toBe(76);
    for (const name of ['Home', 'Matters', 'Messages', 'Find a Paralegal', 'Payments', 'Help']) {
      const link = sidebar(page).getByRole('link', { name, exact: true });
      await expect(link).toBeVisible(); await expect(link).toHaveAttribute('data-av2-tooltip', name); await expect(link.locator('svg')).toBeVisible();
      await link.focus(); await expect(page.getByRole('tooltip')).toHaveText(name);
    }
    await expect(sidebar(page).getByRole('link', { name: 'Help', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.screenshot({ path: info.outputPath('desktop-collapsed.png') });
    await opener(page).click(); await expect(sidebar(page).locator('a[title]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('desktop-expanded.png') }); await sameDocument(page);
  });
  test('the menu stays in the toolbar with a separate close control inside the drawer', async ({ page }, info) => {
    await start(page);
    const header = page.locator('[data-av2-persistent="header"]');
    await page.screenshot({ path: info.outputPath('toolbar-before-open.png') });
    await opener(page).click(); await page.screenshot({ path: info.outputPath('menu-open.png') });
    expect(await opener(page).evaluate(el => getComputedStyle(el).position)).not.toBe('fixed');
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByRole('button', { name: 'Close navigation', exact: true })).toBeVisible();
    const a = await opener(page).boundingBox(), b = await header.boundingBox();
    expect(a.x).toBeGreaterThanOrEqual(b.x); expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width);
    expect(a.width).toBeGreaterThanOrEqual(44); expect(a.height).toBeGreaterThanOrEqual(44);
  });
  test('drawer contains focus, blocks other tools and preserves page scroll', async ({ page }, info) => {
    await start(page);
    const main = page.locator('[data-av2-outlet]'); await main.evaluate(el => { el.scrollTop = 200; });
    const scroll = await main.evaluate(el => el.scrollTop);
    await opener(page).click(); await expect(drawer(page)).toBeVisible();
    const first = drawer(page).locator('.av2-brand-menu > summary'), last = drawer(page).getByRole('link', { name: 'Help', exact: true });
    await first.focus(); await page.keyboard.press('Shift+' + tab(info)); await expect(last).toBeFocused();
    await page.keyboard.press(tab(info)); await expect(first).toBeFocused();
    await page.keyboard.press('ControlOrMeta+KeyK'); await expect(page.locator('#av2-search')).toBeHidden();
    await page.locator('[data-av2-open="notifications"]').evaluate(el => el.focus()); await expect(first).toBeFocused();
    await page.mouse.move(385, 600); await page.mouse.wheel(0, 400); expect(await main.evaluate(el => el.scrollTop)).toBe(scroll);
    await page.keyboard.press('Escape'); await expect(opener(page)).toBeFocused(); await expect(drawer(page)).toBeHidden();
    await opener(page).click(); await page.mouse.click(385, 600); await expect(drawer(page)).toBeHidden(); await expect(opener(page)).toBeFocused();
    await sameDocument(page);
  });
  test('responsive changes preserve usable focus and the selected destination', async ({ page }) => {
    await start(page);
    for (let i = 0; i < 2; i++) {
      await opener(page).click();
      await page.setViewportSize({ width: 1366, height: 900 });
      await expect(sidebar(page).getByRole('link', { name: 'Help', exact: true })).toBeFocused();
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
      await page.setViewportSize({ width: 390, height: 844 }); await expect(opener(page)).toBeFocused();
    }
    await sameDocument(page);
  });
  test('mobile layouts retain an unsent Help draft and accessible bounded navigation', async ({ page }, info) => {
    const run = await start(page);
    const description = page.getByRole('textbox', { name: 'What happened?', exact: true });
    await description.fill('Unsent synthetic report retained through navigation controls.');
    for (const layout of [{ width: 390, height: 844, theme: 'light', size: '100%' }, { width: 320, height: 900, theme: 'dark', size: '200%' }, { width: 740, height: 420, theme: 'dark', size: '125%' }]) {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.evaluate(({ theme, size }) => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('theme-light', theme === 'light'); document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = size; }, layout);
      await opener(page).click(); await expect(drawer(page)).toBeVisible();
      expect(await drawer(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const link of await drawer(page).locator('.av2-nav a:visible').all()) expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect((await new AxeBuilder({ page }).include('dialog[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`drawer-${layout.width}-${layout.theme}.png`) });
      await drawer(page).getByRole('button', { name: 'Close navigation', exact: true }).click();
      await expect(description).toHaveValue('Unsent synthetic report retained through navigation controls.');
      await expect(opener(page)).toBeFocused();
    }
    expect(run.state.calls.filter(call => call.path === '/api/incidents' && call.method === 'POST')).toEqual([]);
    await sameDocument(page);
  });
  test('verification immediately closes open navigation and keeps its sidebar inaccessible', async ({ page }) => {
    const run = await start(page); await opener(page).click();
    let release; const held = new Promise(resolve => { release = resolve; });
    run.state.authRespond = async route => { await held; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: run.state.user }) }); };
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue: 'cached identity', newValue: 'verify current account' })));
    await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'checking');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('[data-av2-shell]')).toHaveAttribute('inert', '');
    await sidebar(page).locator('a').first().evaluate(el => el.focus()); await expect(sidebar(page).locator('a').first()).not.toBeFocused();
    release(); await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'ready');
  });
});
