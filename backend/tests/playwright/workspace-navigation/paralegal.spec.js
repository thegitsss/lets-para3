const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { installCurrentHome, home, expectSameDocument, USER } = require('../paralegal-support/current-home-fixtures');
const rail = page => page.locator('[data-v2-persistent="sidebar"]');
const opener = page => page.locator('[data-v2-mobile-menu]');
const drawer = page => page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
const tab = info => info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
});
async function start(page, viewport = { width: 390, height: 844 }, query = '') {
  await page.setViewportSize(viewport);
  const state = await installCurrentHome(page);
  await page.route(url => url.pathname === '/api/cases/my-completed', route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('expectedOwnerId')).toBe(USER);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(require('../paralegal-support/financial-fixtures').history(USER, [], query)) });
  });
  await home(page, query);
  return state;
}
test('Payouts has a visible current destination and collapse stays reachable in the workspace toolbar', async ({ page }, info) => {
  const state = await start(page, { width: 1366, height: 900 }, '?view=history');
  const payout = rail(page).getByRole('link', { name: 'Payouts', exact: true });
  await expect(payout).toBeVisible(); await expect(payout).toHaveAttribute('aria-current', 'page');
  await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(1);
  expect(await payout.locator('span').evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1)).toBe(true);
  const collapse = page.locator('[data-v2-sidebar-grip]');
  expect(await collapse.evaluate(el => !!el.closest('[data-v2-persistent="header"]'))).toBe(true);
  const box = await collapse.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('payout-desktop.png') });
  await collapse.focus(); await page.keyboard.press('Enter'); await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await expect(payout).toBeVisible(); await expect.poll(async () => (await rail(page).boundingBox()).width).toBe(76);
  const hint = await collapse.evaluate(el => {
    const style = getComputedStyle(el, '::after'), box = el.getBoundingClientRect();
    // Firefox preserves attr()/intrinsic sizing in computed pseudo styles.
    // Its explicit max-width still provides a conservative visible bound.
    const content = style.content.startsWith('attr(') ? el.dataset.collapseLabel : style.content.replace(/^['"]|['"]$/g, '');
    const measure = document.createElement('canvas').getContext('2d'); measure.font = style.font;
    const extras = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const resolved = parseFloat(style.width);
    const width = Number.isFinite(resolved) ? resolved + (style.boxSizing === 'border-box' ? 0 : extras) : measure.measureText(content).width + extras;
    const left = (style.left === 'auto' ? box.right - parseFloat(style.right) - width : box.left + parseFloat(style.left)) + (style.transform === 'none' ? 0 : new DOMMatrix(style.transform).m41);
    return { left, right: left + width, content };
  });
  expect(hint.content).toBe('Expand'); expect(hint.left).toBeGreaterThanOrEqual(0); expect(hint.right).toBeLessThanOrEqual(1366);
  await page.screenshot({ path: info.outputPath('payout-collapsed.png') });
  for (const label of ['Find Work', 'Matters']) {
    const link = rail(page).getByRole('link', { name: label, exact: true });
    await expect(link).toBeVisible(); await expect(link.locator('svg')).toBeVisible();
  }
  await collapse.click(); await expectSameDocument(page, state);
});
test('mobile menu is inside the toolbar and closed navigation cannot receive focus', async ({ page }, info) => {
  await start(page);
  expect(await opener(page).evaluate(el => !!el.closest('[data-v2-persistent="header"]'))).toBe(true);
  await opener(page).focus();
  await rail(page).locator('a').first().evaluate(el => el.focus());
  await expect(opener(page)).toBeFocused();
  for (const layout of [{ width: 390, height: 844, theme: 'light', size: '100%' }, { width: 320, height: 900, theme: 'dark', size: '200%' }, { width: 740, height: 420, theme: 'dark', size: '125%' }]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.evaluate(({ theme, size }) => { document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = size; }, layout);
    const toolbar = page.locator('[data-v2-persistent="header"]');
    const bounds = await toolbar.boundingBox();
    for (const selector of ['[data-v2-mobile-menu]', '[data-v2-search-input]', '[data-v2-notifications-trigger]', '[data-v2-assistant-trigger]']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(bounds.x); expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(bounds.y); expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const review = page.locator('.pv2-overview-row').first();
    expect(await review.locator('.pv2-overview-row-title').evaluate(title => {
      const text = title.firstChild, range = document.createRange();
      const firstWordEnd = text.textContent.indexOf(' ');
      range.setStart(text, 0); range.setEnd(text, firstWordEnd < 0 ? text.textContent.length : firstWordEnd);
      return [...range.getClientRects()].filter(rect => rect.width > 0).length;
    })).toBe(1);
    if (layout.width <= 480) expect(await review.evaluate(row => {
      const title = row.querySelector('.pv2-overview-row-title').getBoundingClientRect();
      const detail = row.querySelector('.pv2-overview-row-detail').getBoundingClientRect();
      const action = row.querySelector('.pv2-overview-row-action').getBoundingClientRect();
      return title.bottom <= detail.top && detail.bottom <= action.top;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath(`toolbar-${layout.width}-${layout.theme}.png`) });
    expect((await new AxeBuilder({ page }).include('[data-v2-persistent="header"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await opener(page).click(); await expect(drawer(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`drawer-${layout.width}-${layout.theme}.png`) });
    expect((await new AxeBuilder({ page }).include('dialog[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape'); await expect(opener(page)).toBeFocused();
  }
});
test('drawer contains focus, preserves page scroll and blocks tools until dismissed', async ({ page }, info) => {
  await start(page);
  await page.evaluate(() => { const main = document.querySelector('main'); const probe = document.createElement('div'); probe.style.height = '2200px'; main.append(probe); main.style.overflow = 'auto'; main.scrollTop = 260; });
  await opener(page).click(); await expect(drawer(page)).toBeVisible();
  const first = drawer(page).getByRole('button', { name: 'Open profile menu', exact: true }), last = drawer(page).getByRole('link', { name: 'Help', exact: true });
  await expect(first).toBeVisible(); await expect(last).toBeVisible();
  await first.focus(); await page.keyboard.press('Shift+' + tab(info)); await expect(last).toBeFocused();
  await page.keyboard.press(tab(info)); await expect(first).toBeFocused();
  await page.locator('[data-v2-search-input]').evaluate(el => el.focus()); await expect(first).toBeFocused();
  await page.keyboard.press('ControlOrMeta+KeyK'); await expect(page.locator('[data-v2-search-panel]')).toBeHidden();
  await page.mouse.move(380, 500); await page.mouse.wheel(0, 300);
  expect(await page.locator('main').evaluate(el => el.scrollTop)).toBe(260);
  await page.keyboard.press('Escape'); await expect(opener(page)).toBeFocused();
  expect(await page.locator('main').evaluate(el => el.scrollTop)).toBe(260);
  await opener(page).click(); await page.mouse.click(385, 500); await expect(drawer(page)).toBeHidden(); await expect(opener(page)).toBeFocused();
});
test('responsive transitions and route selection retain the shell and usable focus', async ({ page }) => {
  const state = await start(page, { width: 390, height: 844 }, '?view=history');
  for (let i = 0; i < 2; i++) {
    await opener(page).click(); await expect(drawer(page)).toBeVisible();
    await page.setViewportSize({ width: 1366, height: 900 });
    await expect(drawer(page)).toBeHidden(); await expect(rail(page).getByRole('link', { name: 'Payouts', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(opener(page)).toBeFocused();
  }
  await opener(page).click(); await rail(page).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(drawer(page)).toBeHidden(); await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false');
  await expectSameDocument(page, state);
  await opener(page).click(); await rail(page).getByRole('link', { name: 'Help', exact: true }).click();
  await expect(drawer(page)).toBeHidden(); await expect(page.locator('.v2-help')).toBeVisible();
  await expectSameDocument(page, state);
});

test('an unsent Help report survives drawer close and current History is unambiguous', async ({ page }, info) => {
  const state = await start(page);
  await opener(page).click(); await rail(page).getByRole('link', { name: 'Help', exact: true }).click();
  const description = page.getByRole('textbox', { name: 'What happened?', exact: true });
  await description.fill('Synthetic unsent report — retain this text through menu interaction.');
  await opener(page).click(); await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(description).toHaveValue('Synthetic unsent report — retain this text through menu interaction.');
  await expect(opener(page)).toBeFocused();
  await page.screenshot({ path: info.outputPath('retained-help-draft.png') });
  expect(state.mutations.filter(path => path.startsWith('/api/support'))).toEqual([]);
  await description.fill('');
  await opener(page).click();
  await rail(page).locator('[data-v2-matters-toggle]').click();
  await rail(page).getByRole('link', { name: 'History', exact: true }).click();
  await expect(drawer(page)).toBeHidden();
  await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(rail(page).locator('[data-work-section="history"]')).toHaveAttribute('aria-current', 'page');
  await expectSameDocument(page, state);
});

 test('current page is unique across Matters sections and Home tools', async ({ page }) => {
  await start(page, { width: 1366, height: 900 });
  for (const section of ['active', 'applications', 'invitations', 'history']) {
    await page.goto(`/paralegal-v2.html#/work?section=${section}`);
    await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(rail(page).locator(`[data-work-section="${section}"]`)).toHaveAttribute('aria-current', 'page');
  }
  for (const view of ['reviews', 'deadlines', 'board', 'insights', 'work', 'matters', 'document', 'pulse', 'inbox']) {
    await page.goto(`/paralegal-v2.html#/home?view=${view}`);
    await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(rail(page).locator(`[data-desktop-home-view="${view}"]`)).toHaveAttribute('aria-current', 'page');
  }
 });
