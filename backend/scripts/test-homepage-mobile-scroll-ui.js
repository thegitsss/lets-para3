const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const browsers = require('playwright');

async function run() {
  const app = express();
  app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const name of (process.env.LPC_SCROLL_BROWSERS || 'chromium').split(',')) {
      const browser = await browsers[name].launch();
      try {
        for (const viewport of [{width:320,height:568},{width:390,height:844},{width:428,height:926}]) {
          const page = await browser.newPage({ viewport, isMobile:true, hasTouch:true });
          await page.route('**/api/**', route => route.fulfill({contentType:'application/json',body:JSON.stringify({user:null,states:[],total:0})}));
          await page.goto(`${origin}/index.html`);
          await page.evaluate(() => document.fonts.ready);
          await page.locator('#assistant').evaluate(element => window.scrollTo({top:element.getBoundingClientRect().top + scrollY - 300,behavior:'instant'}));
          const snapshot = () => page.evaluate(() => ({
            top:document.querySelector('#assistant').getBoundingClientRect().top,
            height:document.querySelector('.workflow').offsetHeight,
            unit:document.documentElement.style.getPropertyValue('--mobile-scroll-vh'),
          }));
          const initial = await snapshot();
          assert.ok(initial.unit, 'Touch layout must retain a stable scene height');
          for (const height of [viewport.height-100,viewport.height,viewport.height-80,viewport.height]) {
            await page.setViewportSize({width:viewport.width,height});
            await page.waitForTimeout(100);
            const current = await snapshot();
            assert.ok(Math.abs(current.top-initial.top)<1, `${name} ${viewport.width}px: Assistant moved during a height-only resize`);
            assert.equal(current.height, initial.height, 'Pinned workflow geometry must remain stable');
          }
          // Rotating changes the layout width, so a new scene size is appropriate.
          await page.setViewportSize({width:926,height:428});
          await page.waitForTimeout(100);
          assert.equal((await snapshot()).unit, '', 'Landscape desktop layout must use its ordinary responsive sizes');
          await page.setViewportSize({width:viewport.width,height:viewport.height-40});
          await page.waitForTimeout(100);
          assert.notEqual((await snapshot()).unit,initial.unit,'Returning to portrait must measure the new layout');
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow after rotation');
          await page.close();
        }
        const desktop = await browser.newPage({viewport:{width:1440,height:900}});
        await desktop.goto(`${origin}/index.html`);
        assert.equal(await desktop.evaluate(()=>document.documentElement.style.getPropertyValue('--mobile-scroll-vh')),'','Desktop geometry is unchanged');
        await desktop.close();
        console.log(`[mobile-scroll] ${name}: stable Assistant entrance at 320/390/428px; rotation and desktop checks passed.`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
