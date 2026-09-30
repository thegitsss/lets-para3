const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');

// Exercise complete, writer-produced records rather than independent response
// stubs whose funding, completion and receipt amounts might disagree.
module.exports = async function inspectFinancialLayout(page, info, label) {
  const panel = page.locator('.av2-matter-financials');
  for (const selector of ['[data-workspace-funding]', '[data-workspace-completion]', '[data-workspace-disputes]', '[data-matter-receipt]']) await expect(panel.locator(selector)).toHaveAttribute('data-state', 'ready');
  const viewport = page.viewportSize();
  const previous = await page.evaluate(() => ({
    size: document.documentElement.style.fontSize,
    themes: [document.documentElement, document.body].map(element => ['theme-light', 'theme-dark'].filter(name => element.classList.contains(name))),
  }));
  const evidence = [];
  try {
    for (const variant of [{ width: 1366, theme: 'light', size: '17px' }, { width: 320, theme: 'dark', size: '20px' }, { width: 320, theme: 'dark', size: '34px', textScale: '200percent' }]) {
      await page.setViewportSize({ width: variant.width, height: 900 });
      await page.evaluate(({ theme, size }) => {
        for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); }
        document.documentElement.style.fontSize = size;
      }, variant);
      const controls = await page.locator('[data-matter-workspace] .av2-matter-title-row button, .av2-matter-financials .av2-financial-section-heading button').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => {
        const box = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
        return { name: element.textContent, width: box.width, height: box.height, contained: box.left >= parent.left - 1 && box.right <= parent.right + 1 && box.top >= parent.top - 1 && box.bottom <= parent.bottom + 1 };
      }));
      const fields = await panel.locator('input:not([type="hidden"]), textarea').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => {
        const box = element.getBoundingClientRect(), parent = element.closest('section').getBoundingClientRect();
        return { id: element.id, width: box.width, height: box.height, contained: box.left >= parent.left - 1 && box.right <= parent.right + 1, usesPageFont: getComputedStyle(element).fontFamily === getComputedStyle(document.body).fontFamily };
      }));
      evidence.push({ ...variant, controls, fields });
      const captureName = `${label}-${variant.width}-${variant.theme}${variant.textScale ? `-${variant.textScale}` : ''}`;
      await page.locator('[data-matter-workspace] h1').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`financials-${captureName}-top.png`), animations: 'disabled' });
      await panel.locator('[data-matter-receipt]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`financials-${captureName}-receipt.png`), animations: 'disabled' });
      for (const control of controls) { expect(control.contained).toBe(true); expect(control.width).toBeGreaterThanOrEqual(43.999); expect(control.height).toBeGreaterThanOrEqual(43.999); }
      for (const field of fields) { expect(field.contained).toBe(true); expect(field.height).toBeGreaterThanOrEqual(43.999); expect(field.usesPageFont).toBe(true); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('.av2-matter-financials').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    }
  } finally {
    await fs.writeFile(info.outputPath(`financials-${label}-layout.json`), JSON.stringify(evidence, null, 2));
    await page.setViewportSize(viewport);
    await page.evaluate(({ size, themes }) => {
      [document.documentElement, document.body].forEach((element, index) => { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(...themes[index]); });
      document.documentElement.style.fontSize = size;
    }, previous);
  }
};
