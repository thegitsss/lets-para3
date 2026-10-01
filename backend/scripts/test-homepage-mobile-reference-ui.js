const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const browsers = require('playwright');
(async () => {
  const app = express(); app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const name of (process.env.LPC_BROWSERS || 'chromium,webkit').split(',')) {
      const browser = await browsers[name].launch();
      try {
        for (const width of [320, 390, 428, 640, 768, 1440]) {
          const page = await browser.newPage({ viewport: {width,height:926}, isMobile:width<=640,hasTouch:width<=640 });
          await page.route('**/api/**', r => r.fulfill({contentType:'application/json',body:'{"user":null,"states":[],"total":0}'}));
          await page.goto(origin, {waitUntil:'domcontentloaded'});
          await page.waitForSelector('.hero-entrance-ready');
          const motion = await page.locator('.hero-motion-line').evaluateAll(es => es.map(e => e.getAnimations()[0]?.effect.getTiming()));
          assert.ok(motion.length >= 2);
          motion.forEach((m,i) => { assert.equal(m.duration,1000); assert.equal(m.delay,400+i*(width<=640?33:100)); assert.ok(['ease','cubic-bezier(0.25, 0.1, 0.25, 1)'].includes(m.easing)); });
          await page.waitForTimeout(2200);
          assert.equal(await page.locator('.editorial-hero__inner').evaluate(e=>getComputedStyle(e).opacity),'1');
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No document overflow');
          if (width<=640) {
            const rail = page.locator('.workflow-chapters');
            const geometry = await rail.evaluate(e=>({h:e.offsetHeight,gap:getComputedStyle(e).gap,snap:getComputedStyle(e).scrollSnapType,children:[...e.children].map(c=>{const heading=c.querySelector('h3');const h=heading.getBoundingClientRect();const preview=c.lastElementChild.getBoundingClientRect();const caption=c.children[1].querySelector('p').getBoundingClientRect();return {w:c.offsetWidth,h:c.offsetHeight,center:getComputedStyle(heading).textAlign,headingGap:preview.top-h.bottom,captionTop:caption.top-c.getBoundingClientRect().top,captionGap:caption.top-preview.bottom,bottomSpace:c.getBoundingClientRect().bottom-caption.bottom,overflow:c.scrollHeight-c.clientHeight};})}));
            assert.equal(geometry.h,382);assert.equal(geometry.gap,'8px');assert.equal(geometry.snap,'x mandatory');
            geometry.children.forEach(c=>{assert.equal(c.w,328);assert.equal(c.h,376);assert.equal(c.center,'center');assert.equal(c.headingGap,12);assert.ok(c.captionGap>=12);assert.equal(c.captionTop,305);assert.ok(c.bottomSpace>=10,'Caption fits inside the card');assert.equal(c.overflow,0);});
            for (let step=0;step<6;step++) { await rail.evaluate((e,s)=>e.scrollTo({left:s*336,behavior:'instant'}),step); await page.waitForTimeout(70); }
            const position = await rail.evaluate(e=>e.scrollLeft);
            await page.locator('#assistant').evaluate(e=>scrollTo(0,e.getBoundingClientRect().top+scrollY-300));
            await page.waitForTimeout(100);
            const initial = await page.locator('#assistant').evaluate(e=>e.getBoundingClientRect().top);
            const landmarks = () => page.locator('main > section, footer').evaluateAll(es=>es.map(e=>({top:e.offsetTop,height:e.offsetHeight})));
            const originalLandmarks = await landmarks();
            for (const height of [826,926,846,926]) { await page.setViewportSize({width,height});await page.waitForTimeout(80);assert.ok(Math.abs(await page.locator('#assistant').evaluate(e=>e.getBoundingClientRect().top)-initial)<1,'No jump at Assistant when toolbar height changes'); assert.deepEqual(await landmarks(),originalLandmarks,'All sections through the footer remain stable'); }
            assert.equal(await rail.evaluate(e=>e.scrollLeft),position,'Vertical scrolling preserves card position');
            if (name==='chromium'&&width===428) {
              const client=await page.context().newCDPSession(page);
              const swipe=async(x1,y1,x2,y2)=>{await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x1,y:y1}]});for(let i=1;i<=12;i++){await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x1+(x2-x1)*i/12,y:y1+(y2-y1)*i/12}]});await page.waitForTimeout(16)}await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(500)};
              await rail.evaluate(e=>{scrollTo(0,e.getBoundingClientRect().top+scrollY-180);e.scrollLeft=0});await page.waitForTimeout(100);
              const y=await page.evaluate(()=>scrollY);await swipe(350,380,70,380);
              assert.ok(await rail.evaluate(e=>e.scrollLeft)>250,'Native horizontal swipe');assert.ok(Math.abs(await page.evaluate(()=>scrollY)-y)<3,'Horizontal swipe does not move page');
              await swipe(210,520,210,230);assert.ok(await page.evaluate(()=>scrollY)>y+150,'Vertical swipe over cards continues into Assistant');
            }
            await page.setViewportSize({width:926,height:428});
            await page.waitForFunction(() => document.querySelectorAll('.hero-motion-line').length === 0);
            assert.equal(await page.locator('h1').innerText(),'Your caseload grew.\nYour payroll doesn’t have to.','Rotation preserves whole words');
          } else assert.equal(await page.locator('.workflow-chapters').evaluate(e=>getComputedStyle(e).display),'grid');
          await page.close();
        }
        for (const mode of ['reduced','no-script','failed-entrance','slow-fonts']) {
          const page=await browser.newPage({viewport:{width:428,height:926},javaScriptEnabled:mode!=='no-script',reducedMotion:mode==='reduced'?'reduce':'no-preference'});
          if(mode==='failed-entrance')await page.route('**/homepage-entrance.js*',r=>r.abort());
          if(mode==='slow-fonts')await page.route('**/*.woff2',async r=>{await new Promise(resolve=>setTimeout(resolve,2800));await r.continue().catch(()=>{})});
          await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForTimeout(2600);
          assert.equal(await page.locator('.editorial-hero__inner').evaluate(e=>getComputedStyle(e).opacity),'1',`${mode}: hero remains readable`);
          if(mode==='reduced')assert.equal(await page.locator('.hero-motion-line').evaluateAll(es=>es.flatMap(e=>e.getAnimations()).length),0);
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
        }
        console.log(`[mobile-reference] ${name}: equal-height heading-first cards, hero timing, phone/tablet/desktop, touch scroll, toolbar resize, rotation and failure fallbacks passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
})().catch(e=>{console.error(e);process.exitCode=1});
