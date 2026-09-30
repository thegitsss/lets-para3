const fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'../../../..');
const assert=require('node:assert/strict');
const {expect}=require('playwright/test');
const {chromium,webkit}=require(root+'/backend/node_modules/playwright');
// Standalone visual capture uses the data fixture, not its test-runner hooks.
require.cache[require.resolve(root+'/backend/tests/playwright/assistant-completion/shell-fixture')]={exports:{test:null}};
const {install,fixtures,objectId}=require(root+'/backend/tests/playwright/attorney-v2/home-summaries-fixture');
(async()=>{
 const browser=await (process.argv.includes('--webkit')?webkit:chromium).launch({headless:true});
 const context=await browser.newContext({baseURL:'http://127.0.0.1:59621',viewport:{width:1440,height:960}});
 const mime={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url()),file=path.resolve(root+'/frontend','.'+decodeURIComponent(u.pathname));
  if(u.origin!=='http://127.0.0.1:59621'||!file.startsWith(root+'/frontend/')||route.request().method()!=='GET')return route.abort();
  try {await route.fulfill({body:await fs.readFile(file),contentType:mime[path.extname(file)]||'application/octet-stream'});}catch{await route.fulfill({status:404,body:''});}
 });
 const page=await context.newPage();
 const data=fixtures();
 data.home.counts={active:3,applications:1,draft:2,archived:1};data.home.postedCount=5;
 const item=(n,title,label='In Progress')=>({id:objectId(n),title,label,practiceArea:'Litigation'});
 data.home.recent={total:3,items:[item(11,'Hartwell — Document review'),item(12,'Morrison — Discovery preparation'),item(13,'Ellis — Filing assistance','Posted')]};
 data.home.attention={total:1,page:1,pages:1,pageSize:5,items:[{...item(11,'Hartwell — Document review'),actions:['files']}]};
 data.home.completed={total:1,items:[item(14,'Jensen — Records review','Completed')]};
 data.home.week={start:'2026-09-14',end:'2026-09-20',total:1,page:1,pages:1,pageSize:3,items:[{...item(12,'Morrison — Discovery preparation'),dueDate:'2026-09-20'}]};
 data.applications=[{id:objectId(70),caseId:objectId(13),jobTitle:'Ellis — Filing assistance',paralegal:{_id:objectId(71),firstName:'Avery',lastName:'Brooks'}}];
 data.unread={count:1};data.summary={items:[{caseId:objectId(11),unread:1}]};data.threads={total:1,threads:[{id:objectId(11),title:'Hartwell — Document review',unread:1,lastMessageSnippet:'The revised index is ready for your review.'}]};
 data.home.attention={total:4,page:1,pages:1,pageSize:5,items:[11,12,13,14].map((n,i)=>({...item(n,['Test notifications','testing case','test multi withdrawal','new test'][i]),actions:['withdrawal']}))};
 data.applications=[];
 await install(page,data);
 await page.route('**/api/auth/workspace-release',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({workspace:{schemaVersion:1,ownerId:'111111111111111111111111',role:'attorney',revision:1,version:'v2',defaultDestination:'/attorney-v2.html#/home'}})}));
 await page.route('**/api/payments/payment-method/default',r=>r.fulfill({json:{paymentMethod:null}}));
 let saves=0, failSave=true;
 await page.route('**/api/users/me/onboarding',r=>{saves++;return r.fulfill({status:failSave?500:200,json:failSave?{error:'synthetic failure'}:{onboarding:{attorneyTourCompleted:true}}});});
 await page.reload();
 await page.locator('[data-av2-region="onboarding"][data-state="ready"]').waitFor({state:'attached'});
 await page.locator('[data-av2-region="completed"][data-state="ready"]').waitFor({state:'attached'});
 await page.evaluate(()=>document.fonts.ready);
 const setup=page.locator('.av2-account-checklist');
 await expect(setup).toContainText('1 remaining');
 await expect(setup.locator('a')).toHaveCount(1);
 await expect(setup).toContainText('Add a payment method');
 for(const dark of [false,true]) {
  await page.evaluate(value=>document.documentElement.classList.toggle('theme-dark',value),dark);
  for(const width of [1440,1100,390]) {
   await page.setViewportSize({width,height:960});
   const guide=page.locator('.av2-workspace-guide');
   if(!await guide.getAttribute('open').then(v=>v!==null)) await guide.locator('summary').click();
   await guide.locator('.av2-guide-start').click();
   let previousY=null;
   for(let step=0;step<4;step++) {
    await expect(guide.locator('.av2-guide-progress')).toHaveText(`Tour · ${step+1} of 4`);
    await expect(setup).toContainText('1 remaining');
    const bounds=await guide.locator('.av2-guide-controls').evaluate(el=>({y:el.offsetTop,width:el.scrollWidth,client:el.clientWidth,buttons:[...el.children].map(b=>b.offsetTop)}));
    assert.equal(bounds.width,bounds.client,'controls do not overflow');
    assert.equal(new Set(bounds.buttons).size,1,'controls stay on one row');
    if(previousY!==null)assert.equal(bounds.y,previousY,'navigation stays in place between tour topics');
    previousY=bounds.y;
    await page.locator('[data-av2-onboarding]').screenshot({path:root+`/outputs/attorney-home-design/setup-${dark?'dark':'light'}-${width}-${step+1}.png`});
    if(step<3)await guide.locator('.av2-guide-next').click();
   }
   await guide.locator('.av2-guide-close').click();
   assert.equal(saves,0,'closing or navigating never completes setup or tour');
  }
 }
 await page.setViewportSize({width:1440,height:960});
 const guide=page.locator('.av2-workspace-guide');
 await guide.locator('summary').click();await guide.locator('.av2-guide-start').click();
 for(let i=0;i<3;i++)await guide.locator('.av2-guide-next').click();
 await guide.locator('.av2-guide-next').click();
 await expect(guide.locator('[role="alert"]')).toBeVisible();
 await expect(guide.locator('.av2-guide-next')).toBeEnabled();
 failSave=false;
 await guide.locator('.av2-guide-next').click();
 await expect(guide.locator('[role="status"]')).toHaveText('Workspace guide finished.');
 await expect(setup).toContainText('1 remaining');
 assert.equal(saves,2);
 console.log('PASS: all four topics, stable controls, light/dark, 1440/1100/390 widths, setup stays incomplete, closing is read-only, completion failure/retry');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
