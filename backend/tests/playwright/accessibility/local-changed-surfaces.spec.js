const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

test('existing Security page retains accessible public content, reflow and keyboard navigation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.goto('/security.html');
  expect(response.status()).toBe(200);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('h1')).toHaveCount(1);
  const scan = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(scan.violations).toEqual([]);
  for (const width of [320,390,720,1366]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.setViewportSize({width:390,height:844});
  const toggle = page.locator('.mobile-nav-toggle');
  await toggle.focus(); await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded','false'); await expect(toggle).toBeFocused();
});

test('Matter demo keeps focus out of hidden stages while existing editing and preview controls remain usable', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/index.html');
  await page.waitForFunction(() => document.body.classList.contains('home-motion-ready'));
  const film = page.locator('#matter-film');
  await film.scrollIntoViewIfNeeded();
  const hiddenFocus = async () => film.evaluate(root => [...root.querySelectorAll('[aria-hidden="true"]')].flatMap(container => [...container.querySelectorAll('button,input,select,textarea,a[href]')].filter(node => !node.closest('[inert]') && !node.disabled && node.tabIndex >= 0 && node.getClientRects().length).map(node => node.outerHTML)));
  await expect.poll(hiddenFocus).toEqual([]);
  const next = film.getByRole('button',{name:'Next step',exact:true});
  await next.click();
  await expect(film).toHaveAttribute('data-stage','1');
  await expect(film.locator('.builder-preview')).toBeVisible();
  await film.locator('.builder-skip').click();
  await expect(film.locator('.builder-preview')).toBeEnabled();
  await film.locator('.builder-preview').click();
  await expect(film).toHaveAttribute('data-stage','2');
  await expect.poll(hiddenFocus).toEqual([]);
  const scan = await new AxeBuilder({page}).include('#matter-film').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
});
