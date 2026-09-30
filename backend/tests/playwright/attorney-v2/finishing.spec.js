const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {install}=require('./home-summaries-fixture');
const {json,OWNER,MATTER}=require('../assistant-completion/fixture');
const fs=require('node:fs'),path=require('node:path');
const brief='Organize approximately 1,200 pages of medical records and prepare a chronology highlighting treatment dates, providers, diagnoses, and gaps in care.';
const draftId='bbbbbbbbbbbbbbbbbbbbbbbb';
async function setup(page){
  const home=await install(page,undefined,['attention','applications','messages','recent']),state={saved:null,aiFail:false,saveFail:false,publishFail:false,publication:null,delay:0,saves:0,publishes:0};
  await page.route('**/api/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname;
    if(p==='/api/case-drafts/defaults')return json(route,{ownerId:OWNER,practiceArea:'',state:'',...state.profileDefaults});
    if(p==='/api/cases/posting/options')return json(route,{practiceAreas:['personal injury law','contract law']});
    if(p==='/api/case-drafts/suggest'){
      state.suggestionCalls=(state.suggestionCalls||0)+1;state.lastSuggestion=req.postDataJSON();
      if(state.lastSuggestion.update){if(state.updateDelay)await new Promise(r=>setTimeout(r,state.updateDelay));if(state.aiFail)return json(route,{error:'Unavailable'},503);return json(route,{suggestions:{changes:state.changes||{compAmount:'750.00'}}});}
      if(state.delay)await new Promise(r=>setTimeout(r,state.delay));if(state.aiFail)return json(route,{error:'Unavailable'},503);
      return json(route,{suggestions:state.suggestions||{title:'Medical Record Chronology',practiceArea:'',description:'Prepare a chronology from approximately 1,200 pages of medical records, highlighting treatment dates, providers, diagnoses, and gaps in care.',tasks:['Medical chronology','Source-page references','Identify gaps in treatment']}});
    }
    if(p.startsWith('/api/case-drafts')){
      if(p.includes('/resolve/')&&state.saved?.clientRequestId!==p.split('/').pop())return json(route,{},404);
      if(req.method()==='GET')return state.saved?json(route,{draft:state.saved}):json(route,{},404);
      if(state.saveFail)return json(route,{error:'Unavailable'},503);
      const body=req.postDataJSON();state.saved={...body,id:draftId,rawTitle:body.title,revision:(++state.saves).toString(16).padStart(64,'0')};return json(route,{draft:state.saved});
    }
    if(p.startsWith('/api/cases/posting/drafts/'))return state.publication?json(route,{publication:state.publication}):json(route,{},404);
    if(p==='/api/cases/posting/publications'){
      state.publishes++;if(state.publishFail)return json(route,{error:'Unconfirmed'},503);
      const body=req.postDataJSON();state.publication={draftId,caseId:MATTER,requestId:body.requestId,status:'posted'};return json(route,{publication:state.publication});
    }
    if(p.includes('/api/cases/posting/publications/'))return json(route,{ok:true});
    return route.fallback();
  });return {...home,state};
}
const modal=page=>page.getByRole('dialog',{name:'New Matter',exact:true});
async function open(page){await page.getByRole('button',{name:'New Matter',exact:true}).click();await expect(page.locator('#av2-compose-brief')).toBeFocused();}
async function chooseCreationOption(page,name){if(name==='Enter details manually'){await page.getByRole('button',{name,exact:true}).click();return;}await page.getByRole('button',{name:'Start over',exact:true}).click();}
async function startNewConfirmed(page){await chooseCreationOption(page,'Start new Matter');await expect(page.getByRole('group',{name:'Start a new Matter?',exact:true})).toBeVisible();await page.getByRole('group',{name:'Start a new Matter?',exact:true}).getByRole('button',{name:'Start new Matter',exact:true}).click();}
async function build(page){await open(page);await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');}
async function openOptions(page){const toggle=page.getByRole('button',{name:'+ Additional options',exact:true});if(await toggle.isVisible())await toggle.click();}
async function setField(page,label,id,value,select=false){if(label==='experience')await openOptions(page);if(['compensation','deadline'].includes(label))await expect(page.locator(id)).toBeVisible();if(!await page.locator(id).isVisible())await page.getByRole('button',{name:`Edit ${label}`,exact:true}).click();if(select)await page.locator(id).selectOption(value);else await page.locator(id).fill(value);await page.locator(id).press('Tab');}
async function complete(page){await setField(page,'practice area','#av2-draft-practiceArea','Personal Injury Law',true);await setField(page,'state','#av2-draft-state','Virginia',true);await setField(page,'compensation','#av2-draft-compAmount','1200');}

const AxeBuilder=require('@axe-core/playwright').default;
const {fixtures,matter,objectId}=require('./home-summaries-fixture');
const {inventoryFixture}=require('./inventory-fixture');
async function capture(page,info,name){
 await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
 await page.screenshot({path:info.outputPath(name+'.png')});
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
}
for(const width of [1440,1024,390])test(`Home and Matters finishing acceptance ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});const data=fixtures();
 const titles=['Medical record chronology for a multi-party malpractice trial','Discovery responses — Henderson v. Westfield','Commercial lease document review','Trial binder preparation','Employment case research'];
 const records=titles.map((title,i)=>matter(i+1,{title,paralegal:{id:objectId(100+i),firstName:['Avery','Morgan','Taylor','Alex','Jordan'][i],lastName:'Bennett'},totalAmount:120000,deadlineDate:'2026-10-02',assignedParalegalName:'Avery Bennett',lastActivityAt:'2026-09-23T16:00:00Z',label:'In Progress',filesCount:2}));
 data.home.counts={active:5,applications:0,draft:0,archived:0};data.home.postedCount=5;data.home.recent={total:5,items:records};data.home.attention={total:3,page:1,pages:1,pageSize:5,items:records.slice(0,3).map((r,i)=>({...r,actions:[['files','moderation','withdrawal'][i]]}))};
 data.threads={total:3,threads:records.slice(0,3).map((r,i)=>({...r,unread:i===0?2:0,lastMessageSnippet:'The revised chronology is ready for your review.',lastSenderName:'Avery Bennett',updatedAt:'2026-09-23T16:00:00Z'}))};data.summary={items:records.slice(0,3).map((r,i)=>({caseId:r.id,unread:i===0?2:0}))};data.unread={count:2};

 await install(page,data,['attention','messages','recent']);await capture(page,info,'home');
 await page.route('**/api/cases/inventory?**',async r=>json(r,await inventoryFixture({active:records,archived:[],drafts:{items:[]}},OWNER,new URL(r.request().url()).searchParams)));
 await page.goto('/attorney-v2.html#/matters');await expect(page.locator('.av2-matter-row')).toHaveCount(5);await capture(page,info,'matters');
 await expect(page.getByRole('combobox',{name:'Sort Matters',exact:true})).toBeVisible();
 await page.locator('#av2-matter-search').fill('ZZZ');await expect(page.locator('.av2-matter-row')).toHaveCount(0);await capture(page,info,'filtered-empty');
 await page.goto('/attorney-v2.html#/matters?view=archived');await expect(page.locator('.av2-matters-index')).toBeVisible();
 await page.goto('/attorney-v2.html#/home');await page.locator('[data-av2-region="overview"] a[href="#/matters?view=active"]').click();
 await expect(page.locator('.av2-category[aria-current="page"]')).toContainText('Active');
 await expect(page.locator('#av2-matter-search')).toHaveValue('ZZZ');
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(page.locator('.av2-matter-row')).toHaveCount(5);
 await expect(page.locator('#av2-matter-subnav a').last()).toHaveText('Create new');
});
for(const width of [1440,390])test(`Creation dark theme and bounded confirmation ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await setup(page);await open(page);
 await page.evaluate(()=>{for(const el of [document.documentElement,document.body]){el.classList.remove('theme-light');el.classList.add('theme-dark');}});
 await capture(page,info,'opening-dark');await chooseCreationOption(page,'Enter details manually');await capture(page,info,'manual-dark');
 await page.locator('#av2-draft-title').fill('Trial binder');await page.locator('#av2-draft-description').fill('Prepare a tabbed trial binder.');await page.locator('.av2-draft-tasks input').fill('Prepare the trial binder');await complete(page);
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.getByRole('button',{name:'Confirm and publish Matter',exact:true})).toBeVisible();
 await capture(page,info,'confirmation-dark');await expect(page.getByRole('button',{name:'Confirm and publish Matter',exact:true})).toBeInViewport();
 expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
test('Enlarged text reflows the shell and manual form',async({page},info)=>{
 await page.setViewportSize({width:320,height:900});await setup(page);
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');await open(page);await capture(page,info,'opening-enlarged');
 await chooseCreationOption(page,'Enter details manually');await capture(page,info,'manual-enlarged');
 expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const boxes=await page.locator('.av2-header button').evaluateAll(els=>els.filter(e=>e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right};}));
 expect(boxes.every(r=>r.left>=0&&r.right<=321)).toBe(true);
});

test('Notification menus preserve direct destinations and caught-up state',async({page},info)=>{
 await setup(page);let rows=[{id:'111111111111111111111111',message:'Avery applied to Trial binder',headline:'Avery applied',contextLabel:'Trial binder',actorFirstName:'Avery',read:false,isRead:false,createdAt:'2026-09-23T12:00:00Z',action:{href:'/attorney-v2.html#/matters',label:'View Matters'}}];
 await page.route('**/api/notifications**',route=>{
  const p=new URL(route.request().url()).pathname;
  if(p.endsWith('/stream'))return route.fulfill({status:204});
  if(route.request().method()!=='GET'){
   if(p.endsWith('/read-all')||p.endsWith('/read'))rows.forEach(r=>{r.read=r.isRead=true;});
   else if(route.request().method()==='DELETE')rows=[];
   return json(route,{success:true});
  }
  if(p.endsWith('/unread-count'))return json(route,{count:rows.filter(r=>!r.read).length});
  if(p.endsWith('/page'))return json(route,{items:rows,hasMore:false,nextCursor:null});
  return json(route,rows);
 });
 await page.reload();await page.locator('[data-av2-open="notifications"]').click();const panel=page.locator('[data-av2-panel="notifications"]');
 await expect(panel.getByText('Avery applied',{exact:true})).toBeVisible();
 await expect(panel.locator('.v2-notification-body')).toHaveAttribute('href',/attorney-v2\.html#\/matters$/);
 await panel.getByLabel('Options: Avery applied',{exact:true}).click();await expect(panel.getByRole('button',{name:'Dismiss notification',exact:true})).toBeVisible();
 await panel.getByLabel('Options: Avery applied',{exact:true}).click();
 await panel.getByLabel('Notification options',{exact:true}).click();await panel.getByRole('button',{name:'Mark all as read',exact:true}).click();
 await expect(panel.getByText('Caught up',{exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:/Unread/})).toHaveCount(0);
 await capture(page,info,'notifications-caught-up');
});

test('Long review keeps the final action visible without horizontal overflow',async({page},info)=>{
 await page.setViewportSize({width:390,height:740});await setup(page);await build(page);await complete(page);
 await setField(page,'scope','#av2-draft-description','Review the supporting documents and prepare a clear trial binder. '.repeat(45));
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();const confirm=page.getByRole('button',{name:'Confirm and publish Matter',exact:true});
 await expect(confirm).toBeInViewport();await expect(page.getByLabel('Attorney payment breakdown')).toBeInViewport();await capture(page,info,'long-confirmation');
 expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
