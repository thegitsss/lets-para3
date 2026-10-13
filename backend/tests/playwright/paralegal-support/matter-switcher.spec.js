const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {fixture:shell,json,OWNER,MATTER}=require('../assistant-completion/fixture');
const AxeBuilder=require('@axe-core/playwright').default;
const id=n=>n.toString(16).padStart(24,'0');
const choice=(n,extra={})=>({id:id(n),title:`Assigned Matter ${String(n).padStart(3,'0')}`,status:'in progress',archived:false,practiceArea:'Litigation',...extra});
const current={...choice(1),id:MATTER,title:'Current discovery review'};
const matter=record=>({...record,_id:record.id,readOnly:false,paymentReleased:false,matterExperience:{version:1,header:{title:record.title,relationship:'Assigned paralegal',status:{code:'in_progress',label:'In progress'},practiceArea:'Litigation'},sections:[{id:'overview',label:'Overview'},{id:'work',label:'Work'}],overview:{summary:'Prepare the requested discovery responses.',attorney:'Jordan Lee',taskProgress:{completed:0,total:1}},work:{tasks:[{title:'Prepare responses',completed:false}],completed:0,total:1}}});
async function install(page,options={}){
 const data={items:[current,...Array.from({length:22},(_,n)=>choice(n+2))],queries:[],fail:false,delay:null,...options};
 const f=await shell(page,'paralegal',{hash:`/matter/${MATTER}?tab=overview`,setup:async()=>{
  await page.addInitScript(()=>{
   window.__matterStreams=[];window.__matterReadAborts=[];window.__matterReadRequests=[];
   window.EventSource=class extends EventTarget{constructor(url){super();this.url=String(url);this.closed=false;window.__matterStreams.push(this);}close(){this.closed=true;}};
   const fetch=window.fetch.bind(window);window.fetch=(input,options)=>{const path=new URL(String(input),location.href).pathname;if(/^\/api\/cases\/[a-f0-9]{24}$/.test(path)){window.__matterReadRequests.push({path,hasSignal:Boolean(options?.signal)});options?.signal?.addEventListener('abort',()=>window.__matterReadAborts.push(path),{once:true});}return fetch(input,options);};
  });
  await page.route(url=>/^\/api\/cases\/[a-f0-9]{24}$/.test(url.pathname),route=>{const record=data.items.find(x=>x.id===new URL(route.request().url()).pathname.split('/').pop());return json(route,record?matter(record):{},record?200:403);});
  await page.route('**/api/cases/assigned-choices?**',async route=>{
   const q=new URL(route.request().url()).searchParams,search=q.get('q')||'',number=Number(q.get('page')||1),selectedId=q.get('selectedId')||'';data.queries.push({search,page:number,selectedId,owner:q.get('expectedOwnerId')});
   if(data.delay&&search==='old'){await data.delay;}
   if(data.fail)return json(route,{},503);
   const items=data.items.filter(x=>x.title.toLowerCase().includes(search.toLowerCase()));
   return json(route,{ownerId:data.badOwner?'a'.repeat(24):OWNER,revision:'a'.repeat(64),filters:{search,page:number,selectedId},total:items.length,page:number,pages:Math.max(1,Math.ceil(items.length/10)),pageSize:10,items:items.slice((number-1)*10,number*10),selected:null});
  });
 }});
 const opener=()=>page.getByRole('button',{name:'Switch Matter',exact:true}),dialog=()=>page.getByRole('dialog',{name:'Switch Matter',exact:true});
 await expect(page.locator('[data-v2-matter]')).toBeVisible();return{data,f,opener,dialog};
}

test('switcher pages and searches assigned work then opens the exact Matter inside the persistent shell',async({page})=>{
 const x=await install(page,{items:[current,...Array.from({length:21},(_,n)=>choice(n+2)),choice(300,{title:'Older estate (NY) [A]'})]});
 expect(x.data.queries).toEqual([]);await expect(page.getByText(current.title,{exact:true})).toHaveCount(1);
 await page.evaluate(()=>window.__LPC_PARALEGAL_V2__.shell.header.dataset.switcherIdentity='retained');
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog().getByLabel('Search assigned Matters',{exact:true})).toBeFocused();
 await expect(x.dialog().locator('[aria-current="true"]')).toBeDisabled();await expect(x.dialog().getByRole('button',{name:'No Matter',exact:true})).toHaveCount(0);
 await x.dialog().getByRole('button',{name:'Next Matters',exact:true}).click();await expect(x.dialog()).toContainText('Page 2 of 3');await expect(x.dialog().getByRole('status')).toBeFocused();
 await x.dialog().getByRole('button',{name:'Next Matters',exact:true}).click();await expect(x.dialog()).toContainText('Page 3 of 3');
 await x.dialog().getByLabel('Search assigned Matters',{exact:true}).fill('(NY) [A]');await expect(x.dialog().locator('.v2-choice-matter-choice')).toHaveCount(1);await x.dialog().locator('.v2-choice-matter-choice').click();
 await expect(page).toHaveURL(new RegExp(`/matter/${id(300)}\\?tab=overview`));await expect(page.getByRole('heading',{name:'Older estate (NY) [A]',exact:true})).toBeVisible();await expect(page.locator('.v2-choice-matter-choice-dialog')).toHaveCount(0);
 expect(await page.evaluate(()=>window.__LPC_PARALEGAL_V2__.shell.header.dataset.switcherIdentity)).toBe('retained');await page.goBack();await expect(page.getByRole('heading',{name:current.title,exact:true})).toBeVisible();
 expect(x.data.queries.every(q=>q.owner===OWNER)).toBe(true);expect(x.f.state.calls.filter(x=>x.path==='/api/cases/my')).toEqual([]);
});

test('unavailable and wrong-account choices never become empty work or remove the current Matter',async({page})=>{
 const x=await install(page);x.data.fail=true;await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','error');await expect(x.dialog()).not.toContainText('No assigned Matters');await expect(x.dialog().locator('.v2-choice-matter-choice')).toHaveCount(0);
 x.data.fail=false;x.data.badOwner=true;await x.dialog().getByRole('button',{name:'Retry search'}).click();await expect(x.dialog()).toHaveAttribute('data-state','error');
 x.data.badOwner=false;await x.dialog().getByRole('button',{name:'Retry search'}).click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog().getByRole('status')).toBeFocused();
 await x.dialog().getByLabel('Search assigned Matters',{exact:true}).fill('no matching assigned title');await expect(x.dialog()).toContainText('No Matters match this search.');await page.keyboard.press('Escape');await expect(x.opener()).toBeFocused();await expect(page.getByRole('heading',{name:current.title,exact:true})).toBeVisible();
 x.data.items=[];await x.opener().click();await expect(x.dialog()).toContainText('No assigned Matters are available.');await x.dialog().getByRole('button',{name:'Close',exact:true}).click();await expect(x.opener()).toBeFocused();
});

test('keyboard wrap, stale requests and route departure preserve modal cleanup',async({page})=>{
 let release;const delayed=new Promise(resolve=>release=resolve);const x=await install(page,{delay:delayed});await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');
 await x.dialog().getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Shift+Tab');await expect(x.dialog().getByRole('button',{name:'Next Matters',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(x.dialog().getByRole('button',{name:'Close',exact:true})).toBeFocused();
 await x.dialog().getByLabel('Search assigned Matters',{exact:true}).fill('old');await expect.poll(()=>x.data.queries.some(q=>q.search==='old')).toBe(true);await x.dialog().getByLabel('Search assigned Matters',{exact:true}).fill('Assigned Matter 002');await page.keyboard.press('Enter');await expect(x.dialog().locator('.v2-choice-matter-choice')).toHaveCount(1);release();await expect(x.dialog()).toContainText('Assigned Matter 002');
 await page.keyboard.press('Escape');await expect(x.opener()).toBeFocused();await x.opener().click();await page.mouse.click(2,2);await expect(x.dialog()).toBeHidden();await expect(x.opener()).toBeFocused();
 await x.opener().click();await page.evaluate(()=>location.hash='#/help');await expect(page.locator('.v2-choice-matter-choice-dialog')).toHaveCount(0);
});

test('Matter switcher and long assigned titles stay usable across themes, narrow screens and large text',async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const x=await install(page,{items:[{...current,title:'Older estate (NY) — Amélie’s multijurisdictional document review and inherited estate administration'},choice(300,{title:'Amélie’s multijurisdictional estate administration, discovery chronology and responsive document review — '.repeat(3)})]});
 for(const [width,theme,size]of [[1440,'light','100%'],[390,'light','100%'],[320,'light','200%'],[1440,'dark','100%'],[390,'dark','100%'],[320,'dark','200%']]){
  await page.setViewportSize({width,height:960});await page.evaluate(({theme,size})=>{document.documentElement.classList.toggle('theme-dark',theme==='dark');document.documentElement.style.fontSize=size;},{theme,size});
  await page.evaluate(()=>document.fonts.ready);
  if(width<=390)await expect.poll(()=>page.locator('.v2-app-frame').evaluate(el=>Math.abs(el.getBoundingClientRect().left))).toBeLessThanOrEqual(1);
  if(width===390&&size==='100%'){const boxes=await page.locator('.v2-matter-navigation').evaluate(el=>{const a=el.querySelector('.v2-matter-back').getBoundingClientRect(),b=el.querySelector('button').getBoundingClientRect();return{centers:Math.abs((a.y+a.height/2)-(b.y+b.height/2)),gap:b.x-a.right};});expect(boxes.centers).toBeLessThanOrEqual(2);expect(boxes.gap).toBeGreaterThan(0);}
  await page.screenshot({path:info.outputPath(`${width}-${theme}-${size}-workspace.png`),animations:'disabled'});await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await page.evaluate(()=>document.fonts.ready);
  const scan=await new AxeBuilder({page}).include('.v2-choice-matter-choice-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(scan.violations).toEqual([]);
  expect(await x.dialog().evaluate(d=>d.scrollWidth>d.clientWidth+1||document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
  await page.screenshot({path:info.outputPath(`${width}-${theme}-${size}-dialog.png`),animations:'disabled'});await page.keyboard.press('Escape');await expect(x.opener()).toBeFocused();
 }
 expect(errors).toEqual([]);
});


test('leaving a Matter aborts its pending reconciliation and late access errors cannot discard the next workspace',async({page})=>{
 const x=await install(page);let release,started=false;const gate=new Promise(resolve=>release=resolve);
 await page.route(url=>url.pathname===`/api/cases/${MATTER}`,async route=>{started=true;await gate;await json(route,{},403);});
 await page.evaluate(matterId=>window.__matterStreams.find(s=>s.url===`/api/cases/${matterId}/stream`&&!s.closed).dispatchEvent(new Event('open')),MATTER);await expect.poll(()=>started).toBe(true);
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByRole('button',{name:'Assigned Matter 002 In Progress · Litigation',exact:true}).click();await expect(page.getByRole('heading',{name:'Assigned Matter 002',exact:true})).toBeVisible();
 expect(await page.evaluate(matterId=>window.__matterReadAborts.filter(path=>path===`/api/cases/${matterId}`).length,MATTER)).toBeGreaterThanOrEqual(2);expect(await page.evaluate(()=>window.__matterReadRequests.every(r=>r.hasSignal))).toBe(true);release();await expect(page.getByRole('heading',{name:'Assigned Matter 002',exact:true})).toBeVisible();
 let releaseNext,nextStarted=false;const nextGate=new Promise(resolve=>releaseNext=resolve);
 const nextMatcher=url=>url.pathname===`/api/cases/${id(2)}`;await page.route(nextMatcher,async route=>{nextStarted=true;await nextGate;await json(route,{},403);});
 await page.evaluate(matterId=>window.__matterStreams.find(s=>s.url===`/api/cases/${matterId}/stream`&&!s.closed).dispatchEvent(new Event('open')),id(2));await expect.poll(()=>nextStarted).toBe(true);
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
 expect(await page.evaluate(matterId=>window.__matterReadAborts.includes(`/api/cases/${matterId}`),id(2))).toBe(true);expect(await page.evaluate(()=>window.__matterStreams.filter(s=>!s.closed&&/\/api\/cases\//.test(s.url)).length)).toBe(0);releaseNext();await page.unroute(nextMatcher);
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await expect(page.getByRole('heading',{name:'Assigned Matter 002',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.__matterStreams.filter(s=>!s.closed&&/\/api\/cases\//.test(s.url)).length)).toBe(1);
});
