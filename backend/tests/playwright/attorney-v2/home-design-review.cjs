const fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'../../../..');
const assert=require('node:assert/strict');
const {expect}=require('playwright/test');
const {chromium,webkit}=require(root+'/backend/node_modules/playwright');
// Standalone visual capture uses the data fixture, not its test-runner hooks.
require.cache[require.resolve(root+'/backend/tests/playwright/assistant-completion/shell-fixture')]={exports:{test:null}};
const {install,fixtures,emptyHome,objectId}=require(root+'/backend/tests/playwright/attorney-v2/home-summaries-fixture');
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
 data.home.postedCount=18;
 data.home.counts={active:6,applications:0,draft:17,archived:12};
 data.overdue={total:1,items:[]};
 data.home.recent={total:6,items:[20,21,22,23,24].map((n,i)=>item(n,['Test','New end-to-end test','Test failed card payment','testing contract review','Test pre-engagement flow'][i]))};
 data.home.completed={total:4,items:[30,31,32].map((n,i)=>item(n,['Skyler Test Job','Testing new dispute flow','Binder creation'][i],'Completed'))};
 data.home.week={start:'2026-09-14',end:'2026-09-20',total:0,page:1,pages:1,pageSize:3,items:[]};
 data.unread={count:0};data.summary={items:[22,24,21].map(n=>({caseId:objectId(n),unread:0}))};
 data.threads={total:4,threads:[22,24,21].map((n,i)=>({id:objectId(n),title:['Test failed card payment','Test pre-engagement flow','New end-to-end test'][i],unread:0,lastMessageSnippet:['hii','hello','hi'][i]}))};
 await install(page,data);
 await page.route('**/api/payments/payment-method/default',r=>r.fulfill({json:{paymentMethod:null}}));
 await page.route('**/api/payments/summary?**',r=>r.fulfill({json:{ownerId:'111111111111111111111111',revision:'a'.repeat(64),currencies:[{currency:'USD',originalFunding:0,activeFunds:0,pendingCharges:0,refunds:0,fundingNeeded:0,requiresReview:18,activeMatters:0,pendingMatters:0,unfundedMatters:0,fundingUnknown:false,balanceUnknown:false,pendingUnknown:false}],requiresReview:18,unsupportedCurrency:false,totalSpent:0,activeFunds:0,activeEscrow:0,pendingCharges:0,fundingNeeded:0}}));
 await page.route('**/api/auth/workspace-release',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({workspace:{schemaVersion:1,ownerId:'111111111111111111111111',role:'attorney',revision:1,version:'v2',defaultDestination:'/attorney-v2.html#/home'}})}));
 await page.reload();
 await page.locator('[data-av2-region="overview"][data-state="ready"]').waitFor();
 await page.waitForFunction(()=>{const regions=[...document.querySelectorAll('[data-av2-region]')];return regions.length===9&&regions.every(e=>['ready','error'].includes(e.dataset.state));});


 await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:root+'/outputs/attorney-home-design/home-density-light.png'});

 await page.setViewportSize({width:390,height:844});
 await page.locator('#main').evaluate(e=>e.scrollTop=0);
 await page.screenshot({path:root+'/outputs/attorney-home-design/home-density-mobile.png'});
 await page.setViewportSize({width:1440,height:960});
 await page.evaluate(()=>{document.documentElement.classList.add('theme-dark');document.documentElement.classList.remove('theme-light');document.querySelector('#main').scrollTop=0;});
 await page.screenshot({path:root+'/outputs/attorney-home-design/home-density-dark.png'});
 const ready=async()=>{
  await page.locator('[data-av2-region="overview"]').waitFor({state:'attached'});
  await page.waitForFunction(()=>{const r=[...document.querySelectorAll('[data-av2-region]')];return r.length===9&&r.every(e=>['ready','error'].includes(e.dataset.state));});
 };
 for(const width of [1440,1100,390,320]){
  await page.setViewportSize({width,height:960});
  for(const dark of [false,true]){
   await page.evaluate(d=>document.documentElement.classList.toggle('theme-dark',d),dark);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
   await page.locator('[data-av2-open="search"]').click();
   await expect(page.locator('#av2-query')).toBeFocused();
   await page.keyboard.press('Escape');
   await expect(page.locator('[data-av2-open="search"]')).toBeFocused();
   if(width>900){await page.locator('.av2-brand-menu > summary').click();await page.keyboard.press('Escape');}
   const completed=page.locator('.av2-home-history');
   await completed.locator('summary').click();await expect(completed.locator('[data-av2-region="completed"]')).toBeVisible();await completed.locator('summary').click();
   const guide=page.locator('.av2-workspace-guide');
   await guide.locator('summary').click();await guide.locator('.av2-guide-start').click();await guide.locator('.av2-guide-close').click();
  }
 }
 // Long names and enlarged text must wrap or truncate within their row.
 data.home.attention.items[0].title='A very long Matter title concerning discovery and document production across multiple proceedings';
 data.threads.threads[0].title=data.home.attention.items[0].title;
 data.threads.threads[0].lastMessageSnippet='A longer message preview that must remain inside its row without moving the unread count or adjoining sections.';
 await page.reload();await ready();
 for(const width of [1100,390,320]){
  await page.setViewportSize({width,height:960});
  await page.evaluate(()=>document.documentElement.style.fontSize='20px');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'large text stays within viewport');
  await page.locator('#main').evaluate(e=>e.scrollTop=0);
  await page.screenshot({path:root+`/outputs/attorney-home-design/home-large-text-${width}.png`});
 }
 await page.evaluate(()=>document.documentElement.style.fontSize='');
 data.home=emptyHome();data.applications=[];data.overdue={total:0,items:[]};data.threads={total:0,threads:[]};data.unread={count:0};data.summary={items:[]};
 await page.route('**/api/payments/summary?**',r=>r.fulfill({json:{ownerId:'111111111111111111111111',revision:'a'.repeat(64),currencies:[],requiresReview:0,unsupportedCurrency:false,totalSpent:0,activeFunds:0,activeEscrow:0,pendingCharges:0,fundingNeeded:0}}));
 await page.setViewportSize({width:1440,height:960});await page.reload();await ready();
 await expect(page.locator('.av2-review-clear')).toBeVisible();
 await page.screenshot({path:root+'/outputs/attorney-home-design/home-empty.png'});
 data.home={httpError:503};await page.reload();await ready();
 await expect(page.locator('[data-av2-region="attention"]')).toHaveAttribute('data-state','error');
 await expect(page.locator('.av2-review-clear')).toBeHidden();
 await page.screenshot({path:root+'/outputs/attorney-home-design/home-unavailable.png'});
 console.log('PASS: dense Home, themes, 1440/1100/390/320 widths, menus, search focus, completed/guide disclosures, long titles, enlarged text, empty and failed inventory');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});