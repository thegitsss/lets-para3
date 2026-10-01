const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const browsers = require('playwright');
(async () => {
  const app = express();
  app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = process.env.LPC_CAROUSEL_ORIGIN || `http://127.0.0.1:${server.address().port}`;
  try {
    for (const engine of (process.env.LPC_CAROUSEL_BROWSERS || 'chromium').split(',')) {
      const browser = await browsers[engine].launch();
      try {
        for (const width of [320, 390, 428, 640]) {
          for (const reducedMotion of ['reduce', 'no-preference']) {
            const page = await browser.newPage({ viewport: { width, height: 926 }, isMobile: true, hasTouch: true, reducedMotion });
            await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '{"user":null,"states":[],"total":0}' }));
            await page.goto(origin + '/index.html');
            await page.evaluate(() => document.fonts.ready);
            const rail = page.locator('.workflow-chapters');
            const state = () => page.locator('[data-workflow-mobile-count]').innerText();
            assert.equal(await rail.locator('.workflow-chapter').count(), 6);
            assert.ok(await rail.evaluate(e => e.scrollWidth > e.clientWidth), 'Native horizontal scrolling');
            assert.ok(await page.locator('.workflow__story').evaluate(e => e.offsetHeight < 1200), 'No long pinned mobile scene');
            for (let n = 1; n <= 6; n++) {
              assert.equal(await state(), `Step ${n} of 6`);
              if (n < 6) { await page.locator('[data-workflow-next]').click(); await page.waitForFunction(n => document.querySelector('[data-workflow-mobile-count]').textContent === `Step ${n} of 6`, n + 1); await page.waitForTimeout(400); }
            }
            assert.ok(await page.locator('[data-workflow-next]').isDisabled());
            await page.evaluate(() => scrollBy(0, 200));
            assert.equal(await state(), 'Step 6 of 6', 'Vertical scrolling must not reset the card');
            await rail.focus(); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(700);
            assert.equal(await state(), 'Step 5 of 6');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
            if (engine === 'chromium' && width === 428 && reducedMotion === 'reduce') {
              await rail.evaluate(e => scrollTo(0, e.getBoundingClientRect().top + scrollY - 100));
              const client = await page.context().newCDPSession(page);
              const horizontalBefore = await rail.evaluate(e => e.scrollLeft);
              await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y: 400 }] });
              for (let x = 100; x <= 360; x += 20) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 400 }] }); await page.waitForTimeout(16); }
              await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
              await page.waitForTimeout(700);
              assert.ok((await rail.evaluate(e => e.scrollLeft)) < horizontalBefore - 100, 'Native touch swipe advances cards');
              const before = await page.evaluate(() => scrollY);
              await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500 }] });
              for (let y = 480; y >= 200; y -= 20) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] }); await page.waitForTimeout(16); }
              await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
              await page.waitForTimeout(300);
              assert.ok((await page.evaluate(() => scrollY)) > before + 100, 'Touching a card must allow vertical page scrolling');
            }
            await page.close();
          }
        }
        for (const width of [768, 1440]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } }); await page.goto(origin + '/index.html');
          assert.equal(await page.locator('.workflow-carousel-controls').isVisible(), false);
          assert.equal(await page.locator('.workflow-chapters').evaluate(e => getComputedStyle(e).display), 'grid'); await page.close();
        }
        const fallback = await browser.newPage({ viewport: { width: 428, height: 926 }, javaScriptEnabled: false });
        await fallback.goto(origin + '/index.html');
        assert.equal(await fallback.locator('.workflow-chapter h3').count(), 6);
        assert.equal(await fallback.locator('.workflow-carousel-controls').isVisible(), false);
        await fallback.close();
        console.log(`[carousel] ${engine}: six cards, navigation, scrolling, reduced motion, fallback and desktop passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
