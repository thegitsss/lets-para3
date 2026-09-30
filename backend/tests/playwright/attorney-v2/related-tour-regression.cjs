const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const {expect}=require('playwright/test');
const root=path.resolve(__dirname,'../../../..');
(async()=>{
for(const engine of [chromium,webkit]){
 const browser=await engine.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.route('http://lpc.test/**',async r=>{
  const url=new URL(r.request().url());
  if(url.pathname==='/')return r.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/assets/styles/fonts.css"><link rel="stylesheet" href="/assets/styles/paralegal-v2.css"><link rel="stylesheet" href="/assets/styles/paralegal-v2-matter.css"></head><body class="v2"><button id="replay">Replay tour</button><main id="host"></main></body></html>'});
  const file=path.resolve(root+'/frontend','.'+url.pathname);
  if(!file.startsWith(root+'/frontend/'))return r.abort();
  try{return r.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'font/woff2'});}catch{return r.fulfill({status:404,body:''});}
 });
 await page.goto('http://lpc.test/');
 await page.evaluate(async()=>{
  const {createOnboardingController}=await import('/assets/scripts/paralegal-v2/onboarding-controller.mjs');
  window.writes=[];window.fail=true;window.identity={id:'p1',onboarding:{}};
  window.route={name:'home',query:new URLSearchParams()};
  window.controller=createOnboardingController({
   api:{get:async()=>({onboarding:{}}),request:async(url,options)=>{writes.push(JSON.parse(options.body));if(fail)throw Error('fixture failure');return {onboarding:{...identity.onboarding,...JSON.parse(options.body)}};}},
   dialogHost:document.querySelector('#host'),getIdentity:()=>identity,updateIdentity:value=>identity=value,getRoute:()=>route,
  });
  document.querySelector('#replay').addEventListener('click',event=>controller.replay(event.currentTarget));
  await controller.start(identity);
 });
 const dialog=page.locator('.v2-onboarding-dialog');
 await expect(dialog).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(dialog).toHaveCount(0);
 await page.evaluate(()=>controller.routeChanged(route));
 await expect(dialog).toHaveCount(0);
 assert.equal(await page.evaluate(()=>writes.length),0);
 for(const theme of [false,true])for(const width of [1000,390,320]){
  await page.evaluate(d=>document.documentElement.classList.toggle('theme-dark',d),theme);
  await page.setViewportSize({width,height:800});
  await page.locator('#replay').click();
  const back=dialog.getByRole('button',{name:'Back',exact:true});
  const next=dialog.getByRole('button',{name:'Next',exact:true});
  await expect(back).toBeDisabled();
  await next.click();await back.click();await expect(next).toBeFocused();await expect(back).toBeDisabled();
  await next.click();await next.click();
  await expect(dialog.getByRole('button',{name:'Finish tour',exact:true})).toBeVisible();
  const controlHeights=await dialog.locator('footer button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().height));assert.ok(controlHeights.every(height=>height<=46),'tour controls stay compact without wrapping');
  const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'dialog fits viewport');
  await dialog.screenshot({path:root+`/outputs/attorney-home-design/paralegal-tour-${engine.name()}-${theme?'dark':'light'}-${width}.png`});
  await dialog.getByRole('button',{name:'Close tour',exact:true}).click();
  await expect(page.locator('#replay')).toBeFocused();
 }
 assert.equal(await page.evaluate(()=>writes.length),0);
 await page.locator('#replay').click();
 await dialog.getByRole('button',{name:'Next',exact:true}).click();await dialog.getByRole('button',{name:'Next',exact:true}).click();
 await dialog.getByRole('button',{name:'Finish tour',exact:true}).click();
 await expect(dialog.getByRole('alert')).toBeVisible();
 assert.notEqual(await page.evaluate(()=>identity.onboarding.paralegalTourCompleted),true);
 await page.evaluate(()=>fail=false);
 await dialog.getByRole('button',{name:'Finish tour',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 assert.equal(await page.evaluate(()=>identity.onboarding.paralegalTourCompleted),true);
 await page.evaluate(()=>{route={name:'settings',query:new URLSearchParams()};controller.routeChanged(route);});
 await expect(dialog).toHaveAttribute('data-v2-onboarding-dialog','profile');
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>writes.length),2);
 assert.notEqual(await page.evaluate(()=>identity.onboarding.paralegalProfileTourCompleted),true);
 console.log(engine.name()+': close/Escape, no reopen, replay, Back focus, completion retry, profile dismissal, desktop/mobile themes passed');
 } finally {await browser.close();}
}
})().catch(e=>{console.error(e);process.exitCode=1;});
