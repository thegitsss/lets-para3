const fs = require('node:fs/promises');
const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

module.exports = async function review(page, info) {
  const panel = page.locator('[data-v2-deadline-panel]'), results = [];
  await page.getByLabel('Date', { exact: true }).fill('2026-09-26');
  for (const variant of [
    { name: 'desktop-light', width: 1366, size: '17px', theme: 'light' },
    { name: 'phone-dark', width: 390, size: '17px', theme: 'dark' },
    { name: 'narrow-dark-enlarged', width: 320, size: '34px', theme: 'dark' },
  ]) {
    await page.setViewportSize({ width: variant.width, height: 1000 });
    await page.evaluate(value => {
      for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${value.theme}`); }
      document.documentElement.style.fontSize = value.size;
    }, variant);
    await panel.scrollIntoViewIfNeeded();
    const metrics = await panel.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const visible = node => node.getClientRects().length && !node.closest('[hidden]');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        controls: [...element.querySelectorAll('button,input')].filter(visible).map(node => {
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          return { name: node.textContent || node.name, width: box.width, height: box.height, font: parseFloat(style.fontSize), contained: box.left >= bounds.left - 1 && box.right <= bounds.right + 1, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
        }),
        text: [...element.querySelectorAll('h2,strong,label > span,p,time')].filter(node => visible(node) && node.textContent.trim()).map(node => ({ text: node.textContent, font: parseFloat(getComputedStyle(node).fontSize) })),
      };
    });
    const violations = (await new AxeBuilder({ page }).include('[data-v2-deadline-panel]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    const screenshots = [];
    let formKeyboard = null;
    for (const [name, selector] of [['overview', '.v2-matter-shared-deadline'], ['records', '.v2-matter-deadline-list li:last-child'], ['form', '[data-v2-deadline-form]']]) {
      const target = panel.locator(selector);
      await target.scrollIntoViewIfNeeded();
      if (name === 'form') {
        await page.getByLabel('Date', { exact: true }).focus();
        const add = page.getByRole('button', { name: 'Add reminder', exact: true });
        let steps = 0;
        while (steps < 5 && !await add.evaluate(element => element === document.activeElement)) {
          await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
          steps += 1;
        }
        await expect(add).toBeFocused();
        await expect(add).toBeInViewport({ ratio: 1 });
        const bounds = await add.boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(64);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(1001);
        const focusViolations = (await new AxeBuilder({ page }).include('[data-v2-deadline-form]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
        expect(focusViolations).toEqual([]);
        formKeyboard = { steps, fullyVisible: true, bounds, focusViolations };
      }
      const screenshot = info.outputPath(`reminders-${variant.name}-${name}.png`);
      await page.screenshot({ path: screenshot });
      screenshots.push(screenshot);
    }
    results.push({ ...variant, ...metrics, formKeyboard, violations, screenshots });
    await fs.writeFile(info.outputPath('reminder-layout.json'), JSON.stringify(results, null, 2));
    expect(metrics.overflow).toBe(false); expect(violations).toEqual([]);
    const minFont = variant.size === '34px' ? 28 : 14;
    for (const control of metrics.controls) {
      expect(control.width, control.name).toBeGreaterThanOrEqual(44); expect(control.height, control.name).toBeGreaterThanOrEqual(44);
      expect(control.font, control.name).toBeGreaterThanOrEqual(minFont); expect(control.contained, control.name).toBe(true); expect(control.scrollWidth, control.name).toBeLessThanOrEqual(control.clientWidth + 2);
    }
    for (const text of metrics.text) expect(text.font, text.text).toBeGreaterThanOrEqual(minFont);
  }
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.getByLabel('Date', { exact: true }).fill('');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-dark'); element.classList.add('theme-light'); } });
};
