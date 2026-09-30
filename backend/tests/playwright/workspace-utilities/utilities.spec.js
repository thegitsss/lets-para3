const { test } = require('../assistant-completion/shell-fixture');
const { fixture, json } = require('../assistant-completion/fixture');
const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const setup = (page, role) => fixture(page, role, { setup: state => page.route('**/api/auth/workspace-release', route => json(route, { workspace: { schemaVersion:1, ownerId:state.user.id, role, revision:1, version:'v2', defaultDestination:`/${role}-v2.html#/home` } })) });

for (const role of ['attorney', 'paralegal']) for (const width of [320, 1440]) {
  test(`${role} account, Help and common tools retain their destinations at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page, role);
    if (width === 320) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const sidebar = page.locator(role === 'attorney' ? '#av2-sidebar' : '#v2-sidebar');
    const account = sidebar.locator(role === 'attorney' ? '.av2-account-menu > summary' : '[data-v2-profile-trigger]');
    await expect(sidebar).toBeVisible();
    await expect(account).toBeVisible();
    if (role === 'paralegal') {
      const name = sidebar.locator('[data-v2-profile-name]');
      await expect(name).toContainText('Dana');
      expect((await name.boundingBox()).width).toBeGreaterThan(70);
    }
    await expect(sidebar.getByRole('link', { name: 'Help', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('navigation.png') });
    await account.click();
    const menu = sidebar.locator(role === 'attorney' ? '.av2-sidebar-bottom' : '[data-v2-profile-menu]');
    await expect(menu).toBeVisible();
    const settings = menu.getByRole(role === 'attorney' ? 'link' : 'menuitem', { name: 'Profile Settings', exact: false });
    await expect(settings).toBeVisible();
    await expect(menu.getByRole(role === 'attorney' ? 'button' : 'menuitem', { name: 'Sign out' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await menu.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect((await new AxeBuilder({ page }).include(role === 'attorney' ? '#av2-sidebar' : '#v2-sidebar').analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath('account-and-help.png') });
    if (role === 'paralegal') {
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden(); await expect(account).toBeFocused();
      if (width === 320) await expect(page.getByRole('dialog', { name: 'Workspace navigation', exact: true })).toBeVisible();
      await account.click();
    }
    await settings.click();
    await expect(page).toHaveURL(/#\/settings/);
    if (width === 320) await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
    const tools = await page.evaluate(role => {
      const selectors = role === 'attorney' ? ['[data-av2-open="search"]','[data-av2-open="notifications"]','[data-av2-assistant]'] : ['[data-v2-search-form]','[data-v2-notifications-trigger]','[data-v2-assistant-trigger]'];
      return selectors.map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x:rect.x, right:rect.right, width:rect.width }; });
    }, role);
    expect(tools[0].x).toBeLessThan(tools[1].x); expect(tools[1].x).toBeLessThan(tools[2].x);
    expect(tools[0].x).toBeGreaterThanOrEqual(0); expect(tools[2].right).toBeLessThanOrEqual(width + 1);
    expect(errors).toEqual([]);
  });
}

test('collapsed Paralegal navigation retains accessible account controls', async ({ page }, info) => {
  await page.setViewportSize({ width:1440, height:900 }); await setup(page, 'paralegal');
  await page.getByRole('button', { name:'Collapse sidebar', exact:true }).click();
  const account = page.getByRole('button', { name:'Open profile menu', exact:true });
  await expect(account).toBeVisible(); await account.click();
  await expect(page.getByRole('menuitem', { name:'View profile' })).toBeVisible();
  const box = await account.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(76);
  await page.screenshot({ path:info.outputPath('collapsed-account.png') });
  await page.keyboard.press('Escape'); await expect(account).toBeFocused();
});
