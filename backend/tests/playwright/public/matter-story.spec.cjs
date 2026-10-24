const {test:base,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const frontend=process.env.LPC_STORY_SOURCE_ROOT ? path.join(process.env.LPC_STORY_SOURCE_ROOT,'frontend') : path.resolve(__dirname,'../../../../frontend');
const test=base.extend({
  baseURL: async({},use)=>{
    const server=http.createServer(async(req,res)=>{
      const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const file=path.resolve(frontend,'.'+(name==='/'?'/index.html':name));
      if(!file.startsWith(frontend+path.sep)){res.writeHead(403).end();return;}
      try{const content=await fs.readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream'}).end(content);}catch{res.writeHead(404).end();}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    await use(`http://127.0.0.1:${server.address().port}`);
    server.closeAllConnections();await new Promise(r=>server.close(r));
  }
});
async function progress(page,p){await page.locator('.ms-track').evaluate((el,p)=>{const pin=el.querySelector('.ms-pin');window.scrollTo({top:scrollY+el.getBoundingClientRect().top-parseFloat(getComputedStyle(pin).top)+(el.offsetHeight-pin.offsetHeight)*p,behavior:'instant'});},p);await page.waitForTimeout(80);}
for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
 test(`three stages scroll both ways at ${viewport.width}`,async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize(viewport);await page.goto('/matter-story.html');await page.evaluate(()=>document.fonts.ready);
  const root=page.locator('[data-matter-story]');await expect(root).toHaveClass(/is-pinned/);
  const sizes=[];
  for(const [p,step] of [[0,1],[.49,2],[.95,3]]){
   await progress(page,p);await expect(root).toHaveAttribute('data-step',String(step));
   const slide=page.locator(`.ms-slide[data-ms-step="${step-1}"]`);await expect(slide).toHaveAttribute('aria-hidden','false');
   const box=await slide.locator('.ms-surface').boundingBox();sizes.push(box);expect(box.y).toBeGreaterThanOrEqual(58);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath(`step-${step}.png`)});
  }
  expect(Math.max(...sizes.map(b=>b.height))-Math.min(...sizes.map(b=>b.height))).toBeLessThan(1);
  expect(Math.max(...sizes.map(b=>b.y))-Math.min(...sizes.map(b=>b.y))).toBeLessThan(1);
  expect(await page.locator('.ms-track').evaluate(el=>el.offsetHeight/innerHeight)).toBeLessThanOrEqual(2.21);
  await progress(page,.29);expect(await page.locator('[data-ms-step="0"]').evaluate(el=>parseFloat(getComputedStyle(el).opacity))).toBeCloseTo(.5,1);
  await page.screenshot({path:info.outputPath('transition.png')});
  await progress(page,.49);await expect(root).toHaveAttribute('data-step','2');
  await page.getByRole('button',{name:'01 You jot.'}).click();await expect(root).toHaveAttribute('data-step','1');
  await page.getByRole('button',{name:'03 You post.'}).focus();await page.keyboard.press('Enter');await expect(root).toHaveAttribute('data-step','3');
  await page.getByRole('button',{name:'01 You jot.'}).click();await expect(root).toHaveAttribute('data-step','1');
  await page.getByRole('button',{name:'Make it a draft: preview step 2'}).click();await expect(root).toHaveAttribute('data-step','2');
  await page.getByRole('button',{name:'Looks good. Post it: preview step 3'}).click();await expect(root).toHaveAttribute('data-step','3');
  expect(errors).toEqual([]);
 });
}
test('reduced motion and short screens retain all content',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:320,height:650});await page.goto('/matter-story.html');
 await expect(page.locator('[data-matter-story]')).not.toHaveClass(/is-pinned/);
 for(const slide of await page.locator('.ms-slide').all()){await expect(slide).toHaveAttribute('aria-hidden','false');}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:700,height:400});
 await expect(page.locator('[data-matter-story]')).not.toHaveClass(/is-pinned/);
});
test('homepage integration and no-JavaScript fallback',async({page,browser},info)=>{
 await page.route('**/api/**',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Local preview"}'}));
 await page.setViewportSize({width:1440,height:1000});await page.goto('/index.html');await page.evaluate(()=>document.fonts.ready);
 await expect(page.locator('[data-matter-story]')).toHaveClass(/is-pinned/);await progress(page,.49);await expect(page.locator('[data-matter-story]')).toHaveAttribute('data-step','2');
 await expect(page.locator('#how')).toHaveCount(1);
 await expect(page.locator('[data-ms-step="1"] h4')).toHaveCSS('font-family', /Sarabun/);
 await expect(page.locator('[data-ms-step="1"] h4')).toHaveCSS('font-weight', '500');
 await page.screenshot({path:info.outputPath('homepage-integration.png')});
 const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const p=await nojs.newPage();await p.goto(page.url().replace('/index.html','/matter-story.html'));
 for(const slide of await p.locator('.ms-slide').all()) await expect(slide).toBeVisible();
 await nojs.close();
});
