const {fixture:shell,json,OWNER}=require("../assistant-completion/fixture");
const {expect}=require('playwright/test');
const {test}=require('../assistant-completion/shell-fixture');
const AxeBuilder=require('@axe-core/playwright').default;
const {emptyHome}=require('./home-summaries-fixture');
async function attorney(page,options={}){
 const model={profile:true,payment:true,matter:true,tour:true,first:false,fail:null,writes:[],...options};
 const account=await shell(page,'attorney',{hash:'/home',setup:async state=>{
  state.user.isFirstLogin=model.first;
  const profile=()=>({...state.user,lawFirm:model.profile?'Ellis Legal':'',onboarding:{attorneyTourCompleted:model.tour}});
  await page.route('**/api/**',route=>{
   const url=new URL(route.request().url()),path=url.pathname,method=route.request().method();
   if(path==='/api/auth/workspace-release')return json(route,{workspace:{schemaVersion:1,ownerId:OWNER,role:'attorney',revision:1,version:'v2',defaultDestination:'/attorney-v2.html#/home'}});
   if(model.fail===path)return json(route,{},503);
   if(path==='/api/users/me')return json(route,profile());
   if(path==='/api/users/me/onboarding'&&method==='PATCH'){model.writes.push(route.request().postDataJSON());if(model.tourFail)return json(route,{},503);model.tour=true;return json(route,{onboarding:{attorneyTourCompleted:true}});}
   if(path==='/api/cases/inventory/home'){const home=emptyHome();home.counts.active=model.matter?1:0;home.postedCount=model.matter?1:0;return json(route,home);}
   if(path==='/api/applications/my-postings')return json(route,[]);
   if(path==='/api/checklist')return json(route,{total:0,items:[]});
   if(path==='/api/messages/summary')return json(route,{items:[],totalThreads:0});
   if(path==='/api/messages/threads')return json(route,{threads:[],total:0});
   if(path==='/api/payments/payment-method/default')return json(route,{paymentMethod:model.payment?{id:'pm_synthetic'}:null});
   if(path==='/api/payments/summary')return json(route,{ownerId:OWNER,revision:'a'.repeat(64),currencies:[],requiresReview:0,unsupportedCurrency:false,activeFunds:0,activeEscrow:0,pendingCharges:0,fundingNeeded:0,totalSpent:0});
   return route.fallback();
  });
 }});
 const panel=page.locator('[data-av2-region="onboarding"]');await expect(panel).toHaveAttribute('data-state',model.fail?'error':'ready');return {model,panel,account};
}

async function accountMenu(page) {
 const menu=page.locator('.av2-brand-menu');
 await menu.locator('summary').click();
 await expect(menu).toHaveAttribute('open','');
 return menu;
}
for (let mask=0;mask<8;mask++) test(`account menu exposes only the next unfinished setup destination: ${mask}`,async({page})=>{
 const ready={profile:Boolean(mask&1),payment:Boolean(mask&2),matter:Boolean(mask&4)};
 const {panel,model}=await attorney(page,ready);
 await expect(panel).toBeHidden();
 const menu=await accountMenu(page), target=menu.getByRole('link',{name:'Finish setup',exact:true});
 if(ready.profile&&ready.payment) await expect(target).toBeHidden();
 else await expect(target).toHaveAttribute('href',ready.profile?'attorney-v2.html#/payments/setup':'attorney-v2.html#/settings');
 await expect(page.locator('.av2-setup-step')).toHaveCount(0);
 expect(model.writes).toEqual([]);
});

test('workspace guide saves only after confirmed completion and remains available from Help',async({page})=>{
 const {panel,model}=await attorney(page,{first:true,tour:false,tourFail:true});
 const targets=[['Open profile','#/settings'],['Open payment settings','#/payments/setup'],['View Matters','#/matters'],['Browse paralegals','#/paralegals']];
 for(let index=0;index<4;index++){
  await expect(panel.getByRole('link',{name:targets[index][0],exact:true})).toHaveAttribute('href',targets[index][1]);
  await expect(panel).toContainText(`Tour · ${index+1} of 4`);
  if(index<3){await panel.getByRole('button',{name:'Next',exact:true}).click();await expect(panel.locator('[data-guide-title]')).toBeFocused();await page.reload();await expect(panel).toHaveAttribute('data-state','ready');}
 }
 expect(model.writes).toEqual([]);
 await panel.getByRole('button',{name:'Finish tour',exact:true}).click();
 await expect(panel.getByRole('alert')).toContainText('Couldn’t save guide completion. Try again.');
 await expect(panel.getByRole('button',{name:'Finish tour',exact:true})).toBeFocused();
 expect(model.writes).toEqual([{attorneyTourCompleted:true}]);expect(model.tour).toBe(false);
 model.tourFail=false;await panel.getByRole('button',{name:'Finish tour',exact:true}).click();
 await expect(panel.locator('.av2-workspace-guide')).toHaveCount(0);expect(model.writes).toHaveLength(2);
 await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeFocused();
 await page.reload();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel).toBeHidden();
 await page.evaluate(()=>{location.hash='/help';});
 await page.getByRole('link',{name:'Replay workspace guide',exact:true}).click();
 await expect(panel.getByRole('link',{name:'Open profile',exact:true})).toBeVisible();
 expect(model.writes).toHaveLength(2);
});

for(const path of ['/api/users/me','/api/payments/payment-method/default','/api/cases/inventory/home'])test(`unavailable setup source recovers without an invented requirement: ${path}`,async({page})=>{
 const {panel,model}=await attorney(page,{fail:path});
 await expect(panel.locator('[data-av2-onboarding]')).toHaveCount(0);await expect(panel).toContainText('couldn’t be loaded');
 if(path!=='/api/cases/inventory/home'){const menu=await accountMenu(page);await expect(menu.getByRole('link',{name:'Finish setup',exact:true})).toBeHidden();await menu.locator('summary').click();}
 model.fail=null;await panel.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(panel).toHaveAttribute('data-state','ready');await expect(panel).toBeHidden();expect(model.writes).toEqual([]);
});

test('workspace guide stays readable across themes and enlarged layouts and closes without completing',async({page},info)=>{
 const {panel,model}=await attorney(page,{first:true,tour:false,payment:false});
 for(const theme of ['light','dark'])for(const width of [1440,320]){
  await page.setViewportSize({width,height:960});await page.evaluate(({theme,width})=>{document.documentElement.style.fontSize=width===320?'200%':'';for(const element of [document.documentElement,document.body]){element.classList.remove('theme-light','theme-dark');element.classList.add('theme-'+theme);}}, {theme,width});
  await panel.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect((await new AxeBuilder({page}).include('[data-av2-region="onboarding"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await panel.screenshot({path:info.outputPath(`guide-${theme}-${width}.png`)});
 }
 await panel.getByRole('button',{name:'Close',exact:true}).click();await expect(panel.locator('.av2-workspace-guide')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeFocused();
 await page.reload();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel).toBeHidden();
 expect(model.writes).toEqual([]);expect(model.tour).toBe(false);
});
