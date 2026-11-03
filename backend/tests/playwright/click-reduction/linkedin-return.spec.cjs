const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const fs=require('node:fs/promises'),path=require('node:path');
for(const status of ['ready','failed'])test(`LinkedIn photo ${status} return loads its real assets and closes the popup`,async({page,context},info)=>{
 const root=path.resolve(process.env.LPC_HELP_SOURCE_ROOT||path.join(__dirname,'../../../..'));
 const responses=[];
 context.on('response',r=>{if(/linkedin-photo-(?:import\.css|return\.js)/.test(r.url()))responses.push({url:r.url(),status:r.status()});});
 await context.route('**/linkedin-photo-import.html?*',async r=>r.fulfill({contentType:'text/html',body:await fs.readFile(path.join(root,'frontend/linkedin-photo-import.html'),'utf8')}));
 await page.route('**/photo-return-fixture.html',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><button onclick="window.open('/linkedin-photo-import.html?status=${status}','lpc-photo-return','popup,width=600,height=1000')">Open photo return</button>`}));
 await page.goto('/photo-return-fixture.html');const waiting=page.waitForEvent('popup');await page.getByRole('button',{name:'Open photo return'}).click();const popup=await waiting;
 if(status==='ready')await expect.poll(()=>popup.isClosed()).toBe(true);
 else{
  await expect(popup.getByRole('heading',{name:'Photo not imported',exact:true})).toBeVisible();await expect(popup.locator('#result-copy')).toHaveText('Return to LPC to try again or upload a photo.');
  for(const width of [1440,390,320]){await popup.setViewportSize({width,height:1000});await popup.screenshot({path:info.outputPath(`photo-return-${width}.png`),fullPage:true});expect(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect((await popup.getByRole('button',{name:'Close window'}).boundingBox()).height).toBeGreaterThanOrEqual(44);}
  await Promise.all([
   popup.waitForEvent('close'),
   popup.getByRole('button',{name:'Close window'}).click().catch(error=>{
    if(!popup.isClosed()||page.isClosed()||!error.message.includes('Target page, context or browser has been closed'))throw error;
   }),
  ]);
  expect(popup.isClosed()).toBe(true);expect(page.isClosed()).toBe(false);
 }
 expect(responses).toHaveLength(2);expect(responses.every(r=>r.status===200)).toBe(true);
});
