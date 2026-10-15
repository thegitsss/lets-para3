const { test } = require('./shell-fixture');
const { expect } = require('playwright/test');
const { prepare } = require('./visual-fixture');

const keys = {
  '#supportDrawer': ['width', 'backgroundColor'],
  '.support-drawer-header': ['height', 'paddingLeft', 'paddingRight'],
  '.support-drawer-title': ['fontSize', 'fontWeight', 'lineHeight'],
  '.support-drawer-menu-trigger': ['width', 'height', 'backgroundColor'],
  '.support-drawer-close': ['width', 'height', 'backgroundColor'],
  '.support-thread': ['paddingTop', 'paddingLeft', 'rowGap'],
  '.support-message--user .support-message-bubble': ['backgroundColor', 'borderRadius', 'fontSize'],
  '.support-message-meta': ['fontSize'],
  '.support-composer': ['paddingTop', 'paddingLeft'],
  '.support-composer-shell': ['minHeight', 'borderRadius'],
  '.support-composer textarea': ['minHeight', 'paddingLeft', 'fontSize'],
  '.support-send': ['width', 'height', 'borderRadius'],
  '.support-composer-hint': ['fontSize', 'marginTop'],
  '.support-composer-hint-icon': ['display'],
};

async function sample(page, role, options = {}) {
  const { open } = await prepare(page, role, options);
  await open();
  await expect(page.locator('#supportDrawer')).toHaveAttribute('aria-busy', 'false');
  const styles = await page.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([selector, properties]) => {
    const computed = getComputedStyle(document.querySelector(selector));
    return [selector, Object.fromEntries(properties.map(property => [property, computed[property]]))];
  })), keys);
  await page.getByRole('button', { name: 'Open assistant options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Start new conversation' })).toBeVisible();
  styles.menu = await page.locator('.support-drawer-menu-panel').evaluate(element => {
    const computed = getComputedStyle(element);
    return { borderRadius: computed.borderRadius, padding: computed.padding, boxShadow: computed.boxShadow };
  });
  return styles;
}

test('Paralegal assistant matches the Attorney drawer presentation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const attorney = await sample(page, 'attorney');
  await page.screenshot({ path: testInfo.outputPath('attorney-assistant.png') });
  const paralegal = await sample(page, 'paralegal');
  await page.screenshot({ path: testInfo.outputPath('paralegal-assistant.png') });
  expect(paralegal).toEqual(attorney);
});

test('Paralegal empty conversation uses the same quiet prompt treatment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const prompts = async role => {
    const { open } = await prepare(page, role, { history: [] });
    await open();
    const button = page.locator('.support-quick-prompt').first();
    await expect(button).toBeVisible();
    return button.evaluate(element => {
      const style = getComputedStyle(element);
      return { width: style.width, minHeight: style.minHeight, padding: style.padding, border: style.border, background: style.backgroundColor, color: style.color, fontSize: style.fontSize, textAlign: style.textAlign };
    });
  };
  expect(await prompts('paralegal')).toEqual(await prompts('attorney'));
});

test('Paralegal Home uses the Attorney text scale and selected-navigation weight', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const styles = async role => {
    await prepare(page, role, { hash: '/home' });
    const title = page.locator('main h1').first();
    await expect(title).toBeVisible();
    const nav = page.locator(role === 'attorney' ? '.av2-nav a[aria-current="page"]' : '.v2-nav-link[aria-current="page"]').first();
    await expect(nav).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${role}-home-typography.png`) });
    return page.evaluate(([titleSelector, navSelector]) => {
      const title = getComputedStyle(document.querySelector(titleSelector));
      const nav = getComputedStyle(document.querySelector(navSelector));
      return {
        rootSize: getComputedStyle(document.documentElement).fontSize,
        title: { size: title.fontSize, weight: title.fontWeight },
        nav: { size: nav.fontSize, weight: nav.fontWeight },
      };
    }, [role === 'attorney' ? '.av2-main h1' : '.v2-view h1', role === 'attorney' ? '.av2-nav a[aria-current="page"]' : '.v2-nav-link[aria-current="page"]']);
  };
  expect(await styles('paralegal')).toEqual(await styles('attorney'));
});

for (const [fontSize, expected] of Object.entries({ xs: '14px', sm: '15px', md: '16px', lg: '18px', xl: '20px' })) {
  test(`Paralegal ${fontSize} reading size uses the Attorney scale`, async ({ page }) => {
    await prepare(page, 'paralegal', { preferences: { fontSize } });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(expected);
  });
}
