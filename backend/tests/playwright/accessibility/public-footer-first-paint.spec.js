const { test, expect } = require('playwright/test');
for (const width of [428, 1440]) {
  test(`public footer keeps its initial geometry while shared JavaScript is delayed at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 926 });
    for (const file of ['privacy.html', 'contact.html', 'terms.html', 'security.html', 'attorney-faq.html', 'paralegal-faq.html']) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/assets/scripts/public-site-chrome.js*', async route => { await gate; await route.continue(); });
      try {
        await page.goto(`/${file}`, { waitUntil: 'commit' });
        await expect(page.locator('[data-footer-initial-state]')).toBeAttached();
        // Firefox's fonts.ready can wait for the parser, which this test
        // intentionally holds at the shared script. Load the rendered faces
        // explicitly so font readiness and delayed initialization are separate.
        await page.evaluate(async () => {
          const footer = document.querySelector('.home-footer');
          const fonts = new Set([footer, ...footer.querySelectorAll('*')].map(element => getComputedStyle(element).font).filter(Boolean));
          await Promise.all([...fonts].map(font => document.fonts.load(font, 'Legal work. Clearly connected. Accessibility Let’s-ParaConnect')));
        });
        const read = () => {
          const footer = document.querySelector('.home-footer');
          const rect = footer.getBoundingClientRect();
          const brand = footer.querySelector('.home-footer__brand').getBoundingClientRect();
          return { height: rect.height, brandY: brand.y - rect.y, open: [...footer.querySelectorAll('details')].map(item => item.open) };
        };
        const initial = await page.evaluate(read);
        release();
        await page.waitForLoadState('load');
        expect(await page.evaluate(read), file).toEqual(initial);
        expect(initial.open.every(value => value === (width > 900)), file).toBe(true);
      } finally { release(); await page.unroute('**/assets/scripts/public-site-chrome.js*'); }
    }
  });
}
