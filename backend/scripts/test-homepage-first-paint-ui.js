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
  try {
    for (const name of (process.env.LPC_HERO_BROWSERS || 'chromium').split(',')) {
      const browser = await browsers[name].launch();
      try {
        for (const width of [320,428,1440]) {
          for (const reducedMotion of ['no-preference','reduce']) {
            const page = await browser.newPage({viewport:{width,height:926},isMobile:width<640,hasTouch:width<640,reducedMotion});
            let release;
            const delayed = new Promise(resolve => { release=resolve; });
            await page.route('**/assets/scripts/homepage.js?*',async route=>{await delayed;await route.continue();});
            await page.route('**/assets/fonts/**',async route=>{await delayed;await route.continue();});
            await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:'{"user":null,"states":[],"total":0}'}));
            await page.addInitScript(()=>{
              const selectors=['.editorial-hero__qualifier-words','.editorial-hero__line--one','.editorial-hero__line--two','.editorial-hero__support','.editorial-hero__actions','.editorial-hero__publishing'];
              const record=()=>{
                if(selectors.every(s=>document.querySelector(s))){
                  window.__heroFirstPaint=selectors.map(selector=>{
                    let element=document.querySelector(selector),opacity=1,visible=true;
                    for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);opacity*=Number(style.opacity);visible=visible&&style.visibility==='visible'&&style.display!=='none';}
                    return {selector,opacity,visible,height:element.getBoundingClientRect().height};
                  });
                } else requestAnimationFrame(record);
              };
              requestAnimationFrame(record);
            });
            try {
              await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'commit'});
              await page.waitForFunction(()=>window.__heroFirstPaint);
              const first=await page.evaluate(()=>window.__heroFirstPaint);
              assert.ok(first.every(item=>item.visible&&item.opacity>=.8&&item.height>0),`${name} ${width}px ${reducedMotion}: hero content waited or disappeared on first paint: ${JSON.stringify(first)}`);
              if(reducedMotion==='reduce')assert.equal(await page.locator('.editorial-hero__inner').evaluate(e=>getComputedStyle(e).animationName),'none');
            } finally { release(); }
            await page.waitForLoadState('load');
            await page.waitForTimeout(400);
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Hero must fit the viewport');
            await page.close();
          }
        }
        console.log(`[hero-first-paint] ${name}: complete hero visible immediately at 320/428/1440px with delayed fonts/scripts; reduced motion and overflow checks passed.`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
