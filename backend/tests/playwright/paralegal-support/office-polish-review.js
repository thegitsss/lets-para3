const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');

// Screenshots contain only the synthetic fixtures installed by each owning test.
async function reviewOffice(page, testInfo, name, { widths = [1440, 390, 320], themes = ['light', 'dark'] } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const originalSize = await page.evaluate(() => document.documentElement.style.fontSize);
  const scenarios = themes.flatMap(theme => widths.map(width => ({ theme, width })));
  scenarios.push({ theme: 'light', width: 390, largeText: true });
  for (const { theme, width, largeText } of scenarios) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(({ theme, largeText, originalSize }) => {
        document.documentElement.style.fontSize = largeText ? "20px" : originalSize;
        document.documentElement.classList.toggle('theme-dark', theme === 'dark');
        document.querySelector('[data-v2-route-outlet]').scrollTop = 0;
      }, { theme, largeText, originalSize });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await page.evaluate(async () => {
        // Resizing invalidates nested container queries after the viewport pass.
        // Wait only for their layout to settle; persistent overflow still fails.
        const until = performance.now() + 1000;
        let value;
        do {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const outlet = document.querySelector('[data-v2-route-outlet]');
          const matter = outlet.querySelector('.v2-matter'), style = getComputedStyle(outlet);
          value = { viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, viewWidth: outlet.clientWidth, viewScroll: outlet.scrollWidth,
            matterWidth: matter?.getBoundingClientRect().width ?? null,
            availableWidth: matter ? Math.min(outlet.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), parseFloat(getComputedStyle(matter).maxWidth)) : null };
          if (value.documentWidth <= value.viewport + 1 && value.viewScroll <= value.viewWidth + 1 && (value.matterWidth === null || Math.abs(value.matterWidth - value.availableWidth) <= 1)) break;
        } while (performance.now() < until);
        return value;
      });
      if (bounds.viewScroll > bounds.viewWidth + 1 || bounds.documentWidth > bounds.viewport + 1) {
        const overflow = await page.evaluate(() => {
          const outlet = document.querySelector('[data-v2-route-outlet]'), edge = outlet.getBoundingClientRect(), inset = getComputedStyle(outlet); const right = edge.right - parseFloat(inset.paddingRight), left = edge.left + parseFloat(inset.paddingLeft);
          return [...outlet.querySelectorAll('*')].map(el => {
            const box = el.getBoundingClientRect(), style = getComputedStyle(el);
            return { tag: el.tagName, id: el.id, className: String(el.className), left: box.left, right: box.right, width: box.width, client: el.clientWidth, scroll: el.scrollWidth, position: style.position, overflowX: style.overflowX, minWidth: style.minWidth, transform: style.transform };
          }).filter(el => el.width && (el.right > right + 1 || el.left < left - 1 || el.scroll > el.client + 1)).slice(0, 30);
        });
        const sizing = await page.evaluate(() => {
          const outlet=document.querySelector('[data-v2-route-outlet]'), matter=outlet.querySelector('.v2-matter');
          const read=el=>{if(!el)return null;const s=getComputedStyle(el),b=el.getBoundingClientRect();return {className:el.className,width:b.width,client:el.clientWidth,scroll:el.scrollWidth,cssWidth:s.width,maxWidth:s.maxWidth,minWidth:s.minWidth,display:s.display,boxSizing:s.boxSizing,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,marginLeft:s.marginLeft,marginRight:s.marginRight,container:s.container,gridTemplateColumns:s.gridTemplateColumns,gap:s.gap};};
          return {ancestors:[read(matter),read(outlet),read(outlet.parentElement)]};
        });
        await testInfo.attach(`${name}-${theme}-${width}-overflow`, { body: JSON.stringify({ bounds, overflow, sizing }, null, 2), contentType: 'application/json' });
      }
      expect(bounds.documentWidth, `${name} ${theme} ${width}: document overflow`).toBeLessThanOrEqual(bounds.viewport + 1);
      expect(bounds.viewScroll, `${name} ${theme} ${width}: workspace overflow`).toBeLessThanOrEqual(bounds.viewWidth + 1);
      if (bounds.matterWidth !== null) expect(Math.abs(bounds.matterWidth - bounds.availableWidth), `${name} ${theme} ${width}: Matter fills the available content width`).toBeLessThanOrEqual(1);
      const controls = await page.locator('.v2-work-filter-panel :is(input,select,button):visible').evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('aria-label') || element.textContent, height: Math.round(element.getBoundingClientRect().height * 1000) / 1000 })));
      for (const control of controls) expect(control.height, `${name} ${theme} ${width}: ${control.label} target height`).toBeGreaterThanOrEqual(44);
      const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(report.violations, `${name} ${theme} ${width}: accessibility`).toEqual([]);
      const filename = `${testInfo.project.name}-${name}-${theme}-${width}${largeText ? "-large-text" : ""}.png`;
      await page.screenshot({ path: process.env.LPC_DESIGN_REVIEW_DIR ? path.join(process.env.LPC_DESIGN_REVIEW_DIR, filename) : testInfo.outputPath(filename) });
  }
  await page.evaluate(size => { document.documentElement.style.fontSize = size; }, originalSize);
}
module.exports = { reviewOffice };
