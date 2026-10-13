const fs = require('node:fs/promises');
const AxeBuilder = require('@axe-core/playwright').default;
const { expect } = require('playwright/test');

// Observe the complete History page, including the frame surrounding the records.
module.exports = async function inspectHistory(page, info) {
  const viewport = page.viewportSize();
  const previous = await page.evaluate(() => ({ size: document.documentElement.style.fontSize, themes: [document.documentElement, document.body].map(element => ['theme-light', 'theme-dark'].filter(name => element.classList.contains(name))) }));
  const observations = [];
  try {
    for (const variant of [{ name: 'desktop-light', width: 1366, size: '17px', dark: false }, { name: 'phone-dark', width: 390, size: '17px', dark: true }, { name: 'narrow-dark-enlarged', width: 320, size: '34px', dark: true }]) {
      await page.setViewportSize({ width: variant.width, height: 900 });
      await page.evaluate(({ size, dark }) => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(dark ? 'theme-dark' : 'theme-light'); } document.documentElement.style.fontSize = size; }, variant);
      const root = page.locator('[data-v2-work]');
      await expect(root.getByRole('heading', { level: 1, name: 'History', exact: true })).toHaveCount(1);
      await expect(root.locator('.v2-work-index')).toHaveCount(0);
      await expect(root.getByRole('heading', { name: 'Past Matters', exact: true })).toHaveCount(0);
      const metrics = await root.evaluate(async root => {
        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden]') && ![...root.querySelectorAll('details:not([open])')].some(details => details.contains(element) && !details.querySelector(':scope > summary')?.contains(element));
        const controls = [];
        for (const element of [...root.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,summary')].filter(visible)) {
          element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          await new Promise(resolve => requestAnimationFrame(resolve));
          const box = element.getBoundingClientRect(), style = getComputedStyle(element), x = box.left + box.width / 2, y = box.top + Math.min(box.height / 2, 24), hit = document.elementFromPoint(x, y);
          controls.push({ name: (element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 100), width: box.width, height: box.height, fontSize: Number.parseFloat(style.fontSize), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, contained: box.left >= -1 && box.right <= innerWidth + 1, reachable: y >= 0 && y <= innerHeight && (element.disabled || hit === element || element.contains(hit)) });
        }
        const text = [...root.querySelectorAll('h1,h2,h3,p,label,strong,span,small')].filter(element => visible(element) && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())).map(element => ({ text: element.textContent.trim().slice(0, 100), fontSize: Number.parseFloat(getComputedStyle(element).fontSize) }));
        return { controls, text, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      const axe = await new AxeBuilder({ page }).include('[data-v2-work]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      observations.push({ ...variant, ...metrics, violations: axe.violations.map(rule => ({ id: rule.id, nodes: rule.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })) });
      await root.locator('h1').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`history-${variant.name}-top.png`) });
      const controls = root.locator('button:visible,a:visible,summary:visible');
      if (await controls.count()) await controls.last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`history-${variant.name}-bottom.png`) });
    }
  } finally {
    await fs.writeFile(info.outputPath('history-layout.json'), JSON.stringify(observations, null, 2));
    await page.setViewportSize(viewport);
    await page.evaluate(({ size, themes }) => { [document.documentElement, document.body].forEach((element, index) => { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(...themes[index]); }); document.documentElement.style.fontSize = size; }, previous);
  }
  for (const variant of observations) {
    expect(variant.documentOverflow, variant.name).toBe(false);
    expect(variant.violations, variant.name).toEqual([]);
    const minimum = variant.size === '34px' ? 28 : 14;
    for (const control of variant.controls) {
      expect(control.width, `${variant.name}: ${control.name}`).toBeGreaterThanOrEqual(44);
      expect(control.height, `${variant.name}: ${control.name}`).toBeGreaterThanOrEqual(44);
      expect(control.fontSize, `${variant.name}: ${control.name}`).toBeGreaterThanOrEqual(minimum);
      expect(control.contained && control.reachable, `${variant.name}: ${control.name}`).toBe(true);
      expect(control.scrollWidth <= control.clientWidth + 2, `${variant.name}: ${control.name}`).toBe(true);
    }
    expect(variant.text.filter(item => item.fontSize < minimum), variant.name).toEqual([]);
  }
  return observations;
};
