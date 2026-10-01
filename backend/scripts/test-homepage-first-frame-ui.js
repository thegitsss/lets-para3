const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const browsers = require('playwright');
const geometry = require('../../frontend/assets/data/us-states.json');
const counts = Object.fromEntries(geometry.map(state => [state.code, state.code === 'TX' ? 26 : 1]));
const mappedTotal = Object.values(counts).reduce((sum,count)=>sum+count,0);
(async () => {
  const app = express();
  app.get('/api/public/paralegals/state-counts', (req,res)=>res.json({states:counts,total:mappedTotal,approvedTotal:mappedTotal+2}));
  app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  try {
    for (const name of (process.env.LPC_BROWSERS || 'chromium,webkit').split(',')) {
      const browser = await browsers[name].launch();
      try {
        for (const mode of ['late-script','failed-script','slow-fonts','no-script','reduced']) {
          console.log('[first-frame]',name,mode);
          const page = await browser.newPage({viewport:{width:428,height:926},javaScriptEnabled:mode!=='no-script',reducedMotion:mode==='reduced'?'reduce':'no-preference'});
          let mapRequests = 0;
          page.on('request', r=>{if(r.url().includes('/api/public/paralegals/state-counts'))mapRequests++;});
          if (mode==='late-script') await page.route('**/homepage-entrance.js*',async r=>{await new Promise(resolve=>setTimeout(resolve,2600));await r.continue().catch(()=>{});});
          if (mode==='failed-script') await page.route('**/homepage-entrance.js*',r=>r.abort());
          if (mode==='slow-fonts') await page.route('**/*.woff2',async r=>{await new Promise(resolve=>setTimeout(resolve,2600));await r.continue().catch(()=>{});});
          await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'commit'});
          const inner=page.locator('.editorial-hero__inner');await inner.waitFor({state:'attached'});
          if (mode==='reduced') {
            await page.waitForTimeout(100);
            assert.equal(await inner.evaluate(e=>getComputedStyle(e).opacity),'1');
            assert.equal(await page.locator('.editorial-hero__line').first().evaluate(e=>getComputedStyle(e).opacity),'1');
          } else {
            let entering = false;
            const deadline = Date.now() + 1600;
            while (Date.now() < deadline) {
              entering = await page.evaluate(()=>{
                const first=document.querySelector('.hero-motion-line') || document.querySelector('.editorial-hero__line');
                const opacity=Number(getComputedStyle(first).opacity);
                return opacity>.02 && opacity<.9;
              });
              if (entering) break;
              await page.waitForTimeout(25);
            }
            assert.ok(entering,`${mode}: heading begins gradually before the old blank fallback`);
            const state=await page.evaluate(()=>{
              const first=document.querySelector('.hero-motion-line') || document.querySelector('.editorial-hero__line');
              return {inner:getComputedStyle(document.querySelector('.editorial-hero__inner')).opacity,
                opacity:Number(getComputedStyle(first).opacity),
                actions:Number(getComputedStyle(document.querySelector('.editorial-hero__actions')).opacity)};
            });
            assert.equal(state.inner,'1','No whole-hero visibility gate');
            assert.ok(state.opacity>0 && state.opacity<1,'Heading enters gradually');
            assert.equal(state.actions,0,'Actions stay staggered behind heading');
          }
          await page.waitForTimeout(2800);
          assert.equal(await inner.evaluate(e=>getComputedStyle(e).opacity),'1');
          assert.equal(await page.locator('.editorial-hero__actions').evaluate(e=>getComputedStyle(e).opacity),'1');
          // Late scripts must not hide or replay an already revealed hero.
          for(let i=0;i<3;i++) {assert.equal(await page.locator('.editorial-hero__line').first().evaluate(e=>getComputedStyle(e).opacity),'1');await page.waitForTimeout(50);}
          assert.ok(mapRequests <= 1,'Background map preparation makes at most one request');
          if(mode==='late-script') {
            await page.locator('.paralegal-map').scrollIntoViewIfNeeded();
            await page.waitForSelector('.paralegal-map__canvas.is-live',{timeout:30000});
            assert.equal(await page.locator('.paralegal-map__pin').count(),mappedTotal);
            assert.equal(await page.locator('[data-map-total]').innerText(),String(mappedTotal+2));
            assert.equal(mapRequests,1);
          }
          await page.close();
        }
        for (const width of [390, 1440]) {
          console.log('[map-first-frame]', name, width);
          const page = await browser.newPage({ viewport: { width, height: 844 } });
          await page.route('**/api/public/paralegals/state-counts', async route => {
            await new Promise(resolve => setTimeout(resolve, 4000));
            await route.continue().catch(() => {});
          });
          await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
          await page.locator('.paralegal-map').scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const outline = document.querySelector('.paralegal-map__outline');
            return outline?.complete && outline.naturalWidth > 0;
          });
          assert.equal(await page.locator('.paralegal-map__canvas.is-live').count(), 0,
            'Map outline must be visible before network counts resolve');
          assert.equal(await page.locator('.paralegal-map__outline').isVisible(), true);
          assert.equal(await page.getByText('Loading the map…').count(), 0);
          await page.waitForSelector('.paralegal-map__canvas.is-live', { timeout: 30000 });
          assert.equal(await page.locator('.paralegal-map__outline').count(), 1,
            'Static map outline must remain while pins reveal');
          assert.equal(await page.locator('.paralegal-map__pin').count(), mappedTotal);
          await page.close();
        }
        console.log(`[first-frame] ${name}: gradual stagger with delayed/failed JS, slow fonts, no JS, and reduced motion passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
