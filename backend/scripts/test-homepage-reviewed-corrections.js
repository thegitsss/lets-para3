// Exercise the phone navigation and public demo action that layout-only checks missed.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const browsers = require('playwright');

(async () => {
  const frontend = path.resolve(__dirname, '../../frontend');
  const states = JSON.parse(fs.readFileSync(path.join(frontend, 'assets/data/us-states.json'), 'utf8'));
  const counts = Object.fromEntries(states.map(state => [state.code, state.code === 'VA' ? 1 : 0]));
  const app = express();
  app.get('/api/public/paralegals/state-counts', (req, res) => res.json({ states: counts, approvedTotal: 1 }));
  app.use(express.static(frontend));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const name of (process.env.LPC_BROWSERS || 'chromium,webkit').split(',')) {
      const browser = await browsers[name].launch();
      try {
        for (const [width, height] of [[375, 667], [390, 844], [1440, 900]]) {
          const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 768, hasTouch: width < 768 });
          const errors = [];
          page.on('pageerror', error => {
            if (new URL(page.url()).pathname === '/') errors.push(error.message);
          });
          await page.goto(origin, { waitUntil: 'domcontentloaded' });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(1500);
          assert.equal(await page.locator('.builder-skip').count(), 0, 'Demo Skip is removed');
          await page.locator('.matter-scroll-journey').evaluate(node => scrollTo({ top: scrollY + node.getBoundingClientRect().top, behavior: 'instant' }));
          await page.waitForTimeout(350);
          await page.locator('.stage-arrow-next').click();
          await page.waitForFunction(() => document.querySelector('#matter-film').dataset.stage === '1', null, { timeout: 4000 });
          await page.waitForFunction(() => !document.querySelector('.builder-preview').disabled, null, { timeout: 8000 });
          const preview = await page.locator('.builder-preview').boundingBox();
          assert(preview.y >= 0 && preview.y + preview.height <= height, 'Preview stays visible');
          await page.locator('.builder-preview').click();
          await page.waitForFunction(() => document.querySelector('#matter-film').dataset.stage === '2');
          await page.waitForTimeout(650);
          await page.locator('[data-advance]').click();
          await page.waitForURL('**/signup.html?role=attorney');
          await page.goto(origin, { waitUntil: 'domcontentloaded' });
          await page.evaluate(() => document.fonts.ready);
          await page.locator('.paralegal-map').evaluate(node => scrollTo({ top: scrollY + node.getBoundingClientRect().top, behavior: 'instant' }));
          await page.waitForFunction(() => document.querySelector('[data-map-total]').textContent === '1');
          await page.waitForTimeout(250);
          const canvas = await page.locator('.paralegal-map__canvas').boundingBox();
          assert(Math.abs(canvas.width / canvas.height - 975 / 610) < .01, 'Map retains its aspect ratio');
          const color = await page.locator('.home-brand').evaluate(node => getComputedStyle(node).color);
          assert.equal(color, 'rgb(255, 255, 255)', 'Map navigation has light text');
          if (width < 768) {
            const geometry = await page.evaluate(() => {
              const logo = document.querySelector('.hero-capacity').getBoundingClientRect();
              const matter = document.querySelector('.matter-scroll-journey').getBoundingClientRect();
              return matter.top - logo.bottom;
            });
            assert(geometry >= -.5, 'Incoming Matter scene does not cut across the logo');
            await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
            const background = await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor);
            assert.equal(background, 'rgb(7, 19, 31)', 'Footer overscroll shares the footer backing');
          }
          assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'No horizontal overflow');
          assert.deepEqual(errors, []);
          console.log('PASS reviewed corrections', name, width, height);
          await page.close();
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
