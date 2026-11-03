const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {install}=require('../attorney-v2/home-summaries-fixture');
const {json,OWNER,MATTER}=require('../assistant-completion/fixture');
const draftId='bbbbbbbbbbbbbbbbbbbbbbbb';
async function setup(page){
  const home=await install(page,undefined,['attention','applications','messages','recent']),state={saved:null,aiFail:false,saveFail:false,publishFail:false,publication:null,delay:0,saves:0,publishes:0};
  await page.route('**/api/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname;
    if(p==='/api/case-drafts/defaults')return json(route,{ownerId:OWNER,practiceArea:'',state:'',...state.profileDefaults});
    if(p==='/api/cases/posting/options'){if(state.optionsGate){state.optionsPending=true;await state.optionsGate;}return state.optionsFail?json(route,{error:'Unavailable'},503):json(route,{practiceAreas:['personal injury law','contract law']});}
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

async function shaped(page){
 const result=await setup(page);
 await page.getByRole('button',{name:'New Matter',exact:true}).click();
 await page.locator('#av2-compose-brief').fill('Prepare a medical chronology for $1200 in Virginia.');
 await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 for(const [label,id,value] of [['practice area','practiceArea','Personal Injury Law'],['state','state','Virginia']]){
  await page.getByRole('button',{name:`Edit ${label}`,exact:true}).click();await page.locator('#av2-draft-'+id).selectOption(value);await page.locator('#av2-draft-'+id).press('Tab');
 }
 await page.locator('#av2-draft-compAmount').fill('1200');await page.locator('#av2-draft-compAmount').press('Tab');
 return result;
}
test('one explicit publish action saves the displayed draft and publishes exactly its revision',async({page},info)=>{
 const {state}=await shaped(page);
 expect(state.publishes).toBe(0);
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});await page.evaluate(width=>{document.documentElement.classList.toggle('theme-dark',width===390);document.documentElement.style.fontSize=width===320?'125%':'100%';},width);
  const commit=page.getByRole('button',{name:'Confirm and publish Matter',exact:true});await commit.scrollIntoViewIfNeeded();await page.locator('.av2-creation-content').evaluate(e=>e.scrollTop=e.scrollHeight);await commit.focus();await expect(commit).toBeFocused();
  await expect(page.getByLabel('Attorney payment breakdown')).toContainText('Total when you hire $1,464.00');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`publish-${width}.png`),fullPage:true});
 }
 await page.getByRole('button',{name:'Confirm and publish Matter',exact:true}).click();
 await expect.poll(()=>state.publishes).toBe(1);await expect(page.locator('.av2-creation-layer')).not.toBeVisible();expect(state.publication).toBeTruthy();expect(state.saved.compAmount).toBe('1200');
});
test('unconfirmed draft save keeps edits and prevents publication',async({page})=>{
 const {state}=await shaped(page);state.saveFail=true;
 await page.locator('#av2-draft-compAmount').fill('1300');
 await page.getByRole('button',{name:'Confirm and publish Matter',exact:true}).click();
 await expect(page.getByRole('region',{name:'Draft save status'})).toBeVisible();expect(state.publishes).toBe(0);await expect(page.locator('#av2-draft-compAmount')).toHaveValue('1300');
});
test('uncertain publication offers a result check without resending',async({page})=>{
 const {state}=await shaped(page);state.publishFail=true;
 await page.getByRole('button',{name:'Confirm and publish Matter',exact:true}).click();
 await expect(page.getByRole('button',{name:'Check publication result',exact:true})).toBeVisible();expect(state.publishes).toBe(1);
 await page.getByRole('button',{name:'Check publication result',exact:true}).click();expect(state.publishes).toBe(1);
});
