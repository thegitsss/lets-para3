const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

async function anonymous(page) {
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '{"user":null}' }));
}

test('footer labels and links fit between tablet and desktop breakpoints', async ({ page }) => {
  test.setTimeout(90_000);
  await anonymous(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [735, 900, 901, 960, 1024, 1100, 1200, 1201]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/index.html');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator('.home-footer details').evaluateAll(elements => elements.every(element => element.open === (innerWidth > 900)))).toBe(true);
    if (width <= 900) {
      for (const summary of await page.locator('.home-footer summary').all()) await summary.click();
      expect(await page.locator('.home-footer details').evaluateAll(elements => elements.every(element => element.open))).toBe(true);
      expect(await page.locator('.home-footer summary').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    }
    const overflow = await page.locator('.home-footer summary, .home-footer__links a').evaluateAll(elements => elements.flatMap(element => {
      if (!element.getClientRects().length) return [];
      const box = element.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      return text.right > box.right + 1 || text.left < box.left - 1 || box.right > innerWidth + 1
        ? [{ text: element.textContent, right: text.right, container: box.right }] : [];
    }));
    expect(overflow, `Footer text at ${width}px`).toEqual([]);
  }
});

test('short landscape navigation can scroll to account actions and close with Escape', async ({ page }) => {
  await anonymous(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('/contact.html');
  const toggle = page.locator('[data-mobile-nav-toggle]');
  await toggle.click();
  const signup = page.locator('[data-mobile-nav] a[href="/signup.html"]');
  await signup.scrollIntoViewIfNeeded();
  await expect(signup).toBeInViewport({ ratio: 1 });
  await signup.focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('public account-status fallback reflows and exposes working recovery links', async ({ page }) => {
  test.setTimeout(60_000);
  await anonymous(page);
  for (const width of [320, 390, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/account-closure.html');
    await expect(page.getByRole('heading', { name: 'Account check unavailable' })).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login.html');
    await expect(page.getByRole('link', { name: 'Contact LPC', exact: true })).toHaveAttribute('href', '/contact.html');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(scan.violations).toEqual([]);
  }
});
