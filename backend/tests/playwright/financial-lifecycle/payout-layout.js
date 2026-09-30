const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

// Inspect the actual writer-produced empty, expected and paid reports in their
// persistent shell. The financial data and destinations are never intercepted.
module.exports = async function inspectPayoutLayout(page, info, label) {
  const report = page.locator('[data-payout-totals]');
  await expect(report).toHaveAttribute('data-state', 'ready');
  for (const variant of [{ width: 1366, theme: 'light', size: '17px' }, { width: 320, theme: 'dark', size: '20px' }]) {
    await page.setViewportSize({ width: variant.width, height: 900 });
    await page.evaluate(({ theme, size }) => {
      for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); }
      document.documentElement.style.fontSize = size;
    }, variant);
    const heading = page.locator('.ld-heading'); await heading.scrollIntoViewIfNeeded();
    const links = page.getByRole('navigation', { name: 'Payout navigation' }).getByRole('link');
    await expect(links).toHaveCount(2);
    const boxes = await links.evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }));
    for (const box of boxes) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x).toBeGreaterThanOrEqual(16); expect(box.right).toBeLessThanOrEqual(variant.width); }
    expect(boxes[1].x >= boxes[0].right + 8 || boxes[1].y >= boxes[0].bottom + 8).toBe(true);
    if (variant.width > 900) {
      const alignment = await page.evaluate(() => ({ title: document.querySelector('.ld-heading h1').getBoundingClientRect().x, report: document.querySelector('[data-payout-totals]').getBoundingClientRect().x }));
      expect(Math.abs(alignment.title - alignment.report)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('.ph-history').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`payout-${label}-${variant.width}-${variant.theme}.png`), animations: 'disabled' });
    await links.first().focus(); await expect(links.first()).toBeFocused(); await expect(links.first()).toBeInViewport();
    await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(links.last()).toBeFocused(); await expect(links.last()).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`payout-${label}-${variant.width}-${variant.theme}-actions.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
};
