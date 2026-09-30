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
const modal=page=>page.getByRole('dialog',{name:'New Matter',exact:true});
async function open(page){await page.getByRole('button',{name:'New Matter',exact:true}).click();await expect(page.locator('#av2-compose-brief')).toBeFocused();}
async function chooseCreationOption(page,name){if(name==='Enter details manually'){await page.getByRole('button',{name,exact:true}).click();return;}await page.getByRole('button',{name:'Start over',exact:true}).click();}
async function startNewConfirmed(page){await chooseCreationOption(page,'Start new Matter');await expect(page.getByRole('group',{name:'Start a new Matter?',exact:true})).toBeVisible();await page.getByRole('group',{name:'Start a new Matter?',exact:true}).getByRole('button',{name:'Start new Matter',exact:true}).click();}
async function build(page){await open(page);await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');}
async function openOptions(page){const toggle=page.getByRole('button',{name:'+ Additional options',exact:true});if(await toggle.isVisible())await toggle.click();}
async function setField(page,label,id,value,select=false){if(label==='experience')await openOptions(page);if(['compensation','deadline'].includes(label))await expect(page.locator(id)).toBeVisible();if(!await page.locator(id).isVisible())await page.getByRole('button',{name:`Edit ${label}`,exact:true}).click();if(select)await page.locator(id).selectOption(value);else await page.locator(id).fill(value);await page.locator(id).press('Tab');}
async function complete(page){await setField(page,'practice area','#av2-draft-practiceArea','Personal Injury Law',true);await setField(page,'state','#av2-draft-state','Virginia',true);await setField(page,'compensation','#av2-draft-compAmount','1200');}
test('A opens without navigation, traps keyboard, and restores workspace state',async({page})=>{
  const {errors}=await setup(page),before=page.url();
  await page.locator('[data-av2-outlet]').evaluate(el=>{el.dataset.retained='yes';el.append(Object.assign(document.createElement('input'),{id:'underlying-filter',value:'medical'}));el.style.height='300px';el.scrollTop=90;});
  const scroll=await page.locator('[data-av2-outlet]').evaluate(el=>el.scrollTop);
  await open(page);await expect(page.locator('.av2-draft-steps')).toBeHidden();expect(page.url()).toBe(before);await page.locator('#av2-compose-brief').fill(brief);
  for(let i=0;i<12;i++){await page.keyboard.press('Tab');expect(await modal(page).evaluate(el=>el.contains(document.activeElement))).toBe(true);}
  await page.keyboard.press('Escape');await expect(modal(page)).toBeHidden();await expect(page.getByRole('button',{name:'New Matter',exact:true})).toBeFocused();
  expect(page.url()).toBe(before);await expect(page.locator('#underlying-filter')).toHaveValue('medical');expect(await page.locator('[data-av2-outlet]').evaluate(el=>el.scrollTop)).toBe(scroll);
  await open(page);await expect(page.locator('#av2-compose-brief')).toHaveValue(brief);await page.locator('.av2-creation-veil').click({position:{x:5,y:5}});await expect(modal(page)).toBeHidden();expect(errors).toEqual([]);
});
test('A expands in place into E, retains source, edits inline, autosaves and resumes after refresh',async({page})=>{
  const {state,errors}=await setup(page);state.delay=350;await open(page);const original=await page.locator('#av2-compose-brief').elementHandle();await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
  await expect(page.getByRole('button',{name:'Building your Matter…',exact:true})).toBeVisible();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');
  expect(await original.evaluate(el=>el===document.querySelector('#av2-compose-brief'))).toBe(true);await expect(page.locator('#av2-compose-brief')).toHaveValue(brief);await expect(page.locator('#av2-draft-title')).toBeHidden();await expect(page.getByRole('button',{name:'Edit task 1',exact:true})).toHaveText('Medical chronology');await expect(page.getByRole('button',{name:'Edit matter',exact:true})).toHaveText('Medical Record Chronology');await expect(page.locator('#av2-draft-compAmount')).toHaveValue('');
  await complete(page);await openOptions(page);await expect(page.getByRole('textbox',{name:'New requirement'})).toBeVisible();await page.getByRole('textbox',{name:'New requirement'}).fill('Clio proficiency');await page.getByRole('textbox',{name:'New requirement'}).press('Enter');
  await expect.poll(()=>state.saved?.requirements).toEqual(['Clio proficiency']);expect(state.saved.sourceDescription).toBe(brief);await page.reload();await expect(modal(page)).toBeVisible();await expect(page.locator('#av2-compose-brief')).toHaveValue(brief);
  await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.locator('.av2-draft-review')).toContainText('Clio proficiency');await page.getByRole('button',{name:'Edit scope',exact:true}).click();await expect(page.locator('#av2-draft-description')).toBeFocused();expect(errors).toEqual([]);
});
test('manual and AI-error paths use the canvas and failed autosave stays recoverable',async({page})=>{
  const {state}=await setup(page);state.aiFail=true;await open(page);await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.getByText('We couldn’t build your Matter. Your notes are still here. Try again, or enter details manually.')).toBeVisible();await chooseCreationOption(page,'Enter details manually');await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');
  await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');await expect(page.locator('#av2-draft-title')).toBeFocused();state.saveFail=true;await page.locator('#av2-draft-title').fill('Medical chronology');await expect(page.getByRole('region',{name:'Draft save status'})).toBeVisible();await expect(page.locator('.av2-compose-save-status')).toBeHidden();
});
test('review keeps explicit confirmation; successful publication closes and opens the Matter',async({page})=>{
  const {state}=await setup(page);await build(page);await complete(page);await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(modal(page)).not.toContainText('18%');await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeHidden();
  await expect(page.getByRole('button',{name:'Confirm and publish Matter',exact:true})).toBeVisible();await expect(page.getByLabel('Attorney payment breakdown')).toContainText('Total when you hire $1,464.00');expect(state.publishes).toBe(0);await page.getByRole('button',{name:'Confirm and publish Matter',exact:true}).click();await expect(modal(page)).toBeHidden();await expect(page).toHaveURL(new RegExp(`/matters/${MATTER}`));expect(state.publishes).toBe(1);
});
for(const width of [1024,1600,390])test(`approved geometry and reduced motion at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});await setup(page);await open(page);const directory=path.resolve(__dirname,'../../../../outputs/matter-canvas');fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,`a-${width}.png`)});expect(await page.locator('.av2-creation-surface').evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');await expect(page.getByRole('button',{name:'Review Matter →',exact:true})).toBeInViewport();await page.screenshot({path:path.join(directory,`e-${width}.png`)});expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await complete(page);await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await page.screenshot({path:path.join(directory,`review-${width}.png`)});
});
test('an uncertain publication stays in the same surface and checks before retrying',async({page})=>{
  const {state}=await setup(page);await build(page);await complete(page);await page.getByRole('button',{name:'Review Matter →',exact:true}).click();
  state.publishFail=true;await page.getByRole('button',{name:'Confirm and publish Matter',exact:true}).click();
  await expect(page.getByRole('button',{name:'Check publication result',exact:true})).toBeVisible();await expect(modal(page)).toBeVisible();expect(state.publishes).toBe(1);
  await page.getByRole('button',{name:'Check publication result',exact:true}).click();await expect(page.getByText('No publication was found. Review the draft before an explicit retry.')).toBeVisible();expect(state.publishes).toBe(1);
});
test('session loss closes and clears confidential creation content',async({page})=>{
  await setup(page);await build(page);
  await page.route('**/api/auth/me',route=>json(route,{},401));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/login\.html/);await expect(page.locator('#av2-compose-brief')).toHaveCount(0);
});
test('creation links and programmatic routes open the overlay without replacing the underlying view',async({page})=>{
  await setup(page);const before=page.url();await page.locator('[data-av2-outlet]').evaluate(el=>el.dataset.preserved='true');
  await page.evaluate(()=>{location.hash='#/matters/new';});await expect(modal(page)).toBeVisible();expect(page.url()).toBe(before);await expect(page.locator('[data-av2-outlet]')).toHaveAttribute('data-preserved','true');
});
test('composer and canvas retain accessible names and contrast',async({page})=>{
  const AxeBuilder=require('@axe-core/playwright').default;await setup(page);await open(page);
  await page.locator('.av2-creation-surface').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  expect((await new AxeBuilder({page}).include('.av2-creation-layer').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');
  await page.locator('.av2-canvas-right').evaluate(async el=>{getComputedStyle(el).opacity;await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  expect((await new AxeBuilder({page}).include('.av2-creation-layer').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
});

test('fees appear only at publishing confirmation and recalculate after editing',async({page})=>{
 const {state}=await setup(page);await build(page);await complete(page);await setField(page,'compensation','#av2-draft-compAmount','400');
 await expect(modal(page)).not.toContainText('22%');await expect(modal(page)).not.toContainText('Total when you hire');
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.locator('.av2-draft-review')).toContainText('$400 flat fee');
 const breakdown=page.getByLabel('Attorney payment breakdown');await expect(breakdown).toContainText('Matter compensation $400.00');await expect(breakdown).toContainText('LPC platform fee (22%) $88.00');await expect(breakdown).toContainText('Total when you hire $488.00');expect(state.publishes).toBe(0);
 await page.getByRole('button',{name:'← Back',exact:true}).click();await expect(breakdown).toHaveCount(0);await expect(modal(page)).not.toContainText('22%');await setField(page,'compensation','#av2-draft-compAmount','800');await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(breakdown).toContainText('Total when you hire $976.00');
 const directory=path.resolve(__dirname,'../../../../outputs/fee-confirmation');fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,'confirmation.png')});await page.setViewportSize({width:390,height:900});await breakdown.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'confirmation-mobile.png')});expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(state.publishes).toBe(0);
});

for(const width of [1600,390])test(`manual entry hides the source column and preserves scope across refresh at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});const {state}=await setup(page);await open(page);await page.locator('#av2-compose-brief').fill('Prepare a tabbed trial binder.');await chooseCreationOption(page,'Enter details manually');
 await expect(page.locator('.av2-compose-intro')).toBeHidden();await expect(page.locator('#av2-draft-description')).toHaveValue('Prepare a tabbed trial binder.');await expect(page.locator('#av2-draft-title')).toBeVisible();
 for(const key of ['title','description','practiceArea','state','deadline','compAmount'])await expect(page.locator('#av2-draft-'+key)).toBeVisible();
 await expect(page.locator('.av2-draft-tasks input')).toHaveCount(1);await page.locator('.av2-draft-tasks input').fill('Tabbed trial binder');await page.locator('.av2-draft-tasks input').press('Tab');await expect(page.locator('.av2-draft-tasks input')).toBeVisible();
 await setField(page,'matter','#av2-draft-title','Trial binder');await expect.poll(()=>state.saved?.title).toBe('Trial binder');expect(state.saved.sourceDescription).toBe('');await page.reload();await expect(modal(page)).toBeVisible();await expect(page.locator('.av2-compose-intro')).toBeHidden();await expect(page.locator('#av2-draft-description')).toHaveValue('Prepare a tabbed trial binder.');await expect(page.locator('.av2-compose-save-status')).toBeVisible();
 const columns=await page.locator('.av2-canvas-columns').evaluate(el=>getComputedStyle(el).gridTemplateColumns);expect(columns.trim().split(/\s+/)).toHaveLength(1);expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const directory=path.resolve(__dirname,'../../../../outputs/manual-entry');fs.mkdirSync(directory,{recursive:true});await modal(page).evaluate(async el=>{getComputedStyle(el).opacity;await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:path.join(directory,`manual-${width}.png`)});
 await expect(page.locator('.av2-compose-requirements-note')).toBeHidden();await openOptions(page);await expect(page.getByRole('textbox',{name:'New requirement'})).toBeVisible();
 const requirement=page.getByRole('textbox',{name:'New requirement'});await expect(requirement).toBeVisible();expect(await requirement.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
 await expect(page.getByRole('button',{name:'+ Add requirement',exact:true})).toBeHidden();await requirement.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,`requirement-${width}.png`)});await requirement.press('Escape');await expect(modal(page)).toBeVisible();await expect(requirement).toBeVisible();await expect(requirement).toHaveValue('');
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await page.getByRole('button',{name:'← Back',exact:true}).click();await expect(page.locator('.av2-compose-intro')).toBeHidden();await expect(page.locator('#av2-draft-description')).toHaveValue('Prepare a tabbed trial binder.');
});

test('Start new Matter saves the current draft and opens a fresh composer while close still resumes',async({page})=>{
 const {state}=await setup(page);await build(page);await setField(page,'matter','#av2-draft-title','Keep this draft');
 await startNewConfirmed(page);await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','describe');await expect(page.locator('#av2-compose-brief')).toHaveValue('');await expect(page.locator('#av2-compose-brief')).toBeFocused();expect(state.saved.title).toBe('Keep this draft');expect(state.saved.sourceDescription).toBe(brief);
 await page.getByRole('button',{name:'Close Matter creation',exact:true}).click();await open(page);await expect(page.locator('#av2-compose-brief')).toHaveValue('');expect(state.saved.title).toBe('Keep this draft');
 const directory=path.resolve(__dirname,'../../../../outputs/start-new');fs.mkdirSync(directory,{recursive:true});await page.setViewportSize({width:390,height:900});await modal(page).evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:path.join(directory,'composer-mobile.png')});expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await page.getByRole('button',{name:'Close Matter creation',exact:true}).click();await page.evaluate(id=>{location.hash='#/matters/new?draftId='+id;},draftId);await expect(modal(page)).toBeVisible();await expect(page.locator('#av2-draft-title')).toHaveValue('Keep this draft');
});
test('Start new Matter keeps unsaved work when saving fails and is disabled during publish confirmation',async({page})=>{
 const {state}=await setup(page);await build(page);await complete(page);await expect.poll(()=>state.saved?.compAmount).toBe('1200');await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.getByRole('button',{name:'Start over',exact:true})).toBeDisabled();await page.getByRole('button',{name:'← Back',exact:true}).click();state.saveFail=true;await setField(page,'matter','#av2-draft-title','Do not lose this');await startNewConfirmed(page);await expect(page.getByRole('region',{name:'Draft save status'})).toBeVisible();await expect(page.locator('#av2-draft-title')).toHaveValue('Do not lose this');await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');
});

test('rewind offers a Start over tooltip and cancellable confirmation',async({page})=>{
 const {state}=await setup(page);await open(page);const rewind=page.getByRole('button',{name:'Start over',exact:true});
 await rewind.hover();expect(await rewind.evaluate(el=>getComputedStyle(el,'::after').content)).toBe('"Start over"');
 await expect.poll(()=>rewind.evaluate(el=>getComputedStyle(el,'::after').opacity)).toBe('1');
 const directory=path.resolve(__dirname,'../../../../outputs/creation-icons');fs.mkdirSync(directory,{recursive:true});await page.mouse.move(0,0);await page.locator('.av2-creation-header-actions').screenshot({path:path.join(directory,'aligned.png')});
 const closeControl=page.getByRole('button',{name:'Close Matter creation',exact:true});await closeControl.hover();await expect.poll(()=>closeControl.evaluate(el=>getComputedStyle(el,'::after').opacity)).toBe('1');expect(await closeControl.evaluate(el=>getComputedStyle(el,'::after').content)).toBe('"Close"');
 await expect(modal(page).getByRole('menu')).toHaveCount(0);
 await page.locator('#av2-compose-brief').fill('Keep these messy notes.');await expect.poll(()=>state.saved?.description).toBe('Keep these messy notes.');
 await rewind.click();const confirmation=page.getByRole('group',{name:'Start a new Matter?',exact:true});await expect(confirmation).toContainText('Your current work will be saved in Drafts.');
 await page.keyboard.press('Escape');await expect(confirmation).toBeHidden();await expect(rewind).toBeFocused();await expect(modal(page)).toBeVisible();
 await rewind.click();await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('#av2-compose-brief')).toHaveValue('Keep these messy notes.');
 await page.setViewportSize({width:390,height:900});await rewind.hover();expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});

test('Back returns through creation steps without losing edits and revised drafts require acceptance',async({page})=>{
 await setup(page);await build(page);await setField(page,'matter','#av2-draft-title','My edited title');await page.getByRole('button',{name:'← Back',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','describe');await expect(page.locator('#av2-compose-brief')).toHaveValue(brief);
 await chooseCreationOption(page,'Enter details manually');await expect(page.locator('#av2-draft-title')).toHaveValue('My edited title');await expect(page.locator('.av2-compose-intro')).toBeHidden();await page.getByRole('button',{name:'← Back',exact:true}).click();await page.locator('#av2-compose-brief').fill('Please prepare a medical chronology with source references.');await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.getByRole('button',{name:'Use revised draft',exact:true})).toBeVisible();await expect(page.locator('#av2-draft-title')).toHaveValue('My edited title');await page.getByRole('button',{name:'Use revised draft',exact:true}).click();await expect(page.locator('#av2-draft-title')).toHaveValue('Medical Record Chronology');
 await complete(page);await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await page.getByRole('button',{name:'← Back',exact:true}).click();await expect(page.getByRole('button',{name:'Review Matter →',exact:true})).toBeVisible();await expect(page.locator('#av2-draft-compAmount')).toHaveValue('1200');
});

test('failed generation retries in place and focuses the Matter without losing notes',async({page})=>{
 const {state}=await setup(page);state.aiFail=true;await open(page);
 await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeVisible();
 await expect(page.locator('#av2-compose-brief')).toHaveValue(brief);
 state.aiFail=false;await page.getByRole('button',{name:'Try again',exact:true}).click();
 await expect(page.getByRole('button',{name:'Edit matter',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'Edit matter',exact:true}).hover();
 await expect.poll(()=>page.getByRole('button',{name:'Edit matter',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(240, 243, 247)');
 await page.getByRole('button',{name:'← Back',exact:true}).click();
 await expect(page.locator('#av2-compose-brief')).toBeFocused();await expect(page.locator('#av2-compose-brief')).toHaveValue(brief);
});

test('one retry checks an uncertain save before saving retained edits',async({page})=>{
 const {state}=await setup(page);await build(page);
 await expect.poll(()=>state.saved?.title).toBe('Medical Record Chronology');
 state.saveFail=true;await setField(page,'matter','#av2-draft-title','My edited chronology');
 await expect(page.getByRole('button',{name:'Retry save',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Edit matter',exact:true})).toHaveText('My edited chronology');
 state.saveFail=false;await page.getByRole('button',{name:'Retry save',exact:true}).click();
 await expect.poll(()=>state.saved?.title).toBe('My edited chronology');
 await expect(page.getByRole('region',{name:'Draft save status'})).toBeHidden();
 await expect(page.locator('.av2-compose-save-status')).toHaveText('Saved');
});

test('compact LPC composer grows with notes and retains them across reopening and resizing',async({page})=>{
 await setup(page);await open(page);const field=page.locator('#av2-compose-brief');
 await expect(field).toHaveAttribute('placeholder','Organize medical records for this Wednesday…');
 await expect(page.getByText('Try an example:',{exact:true})).toBeHidden();
 const initial=await field.evaluate(el=>el.getBoundingClientRect().height);
 expect(initial).toBeLessThan(130);
 const notes='Organize records by provider and treatment date.\n'.repeat(12);
 await field.fill(notes);await expect.poll(()=>field.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(initial);
 await page.getByRole('button',{name:'Close Matter creation',exact:true}).click();await open(page);await expect(field).toHaveValue(notes);
 await page.setViewportSize({width:390,height:900});
 await expect.poll(()=>field.evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
 expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});

const trialBrief='prep supporting docs for trial in ca. need by april 1. compensation is 500.';
const trialSuggestion={title:'Prepare Trial Supporting Documents',practiceArea:'',description:'Prepare supporting documents for trial in California. Needed by April 1, with compensation of $500.',tasks:['Prepare supporting documents for trial'],compAmount:'500.00',deadline:'2027-04-01',state:'California'};
test('Build fills explicit practical fields, shows the full date and autosaves them',async({page})=>{
 const {state,errors}=await setup(page);state.suggestions=trialSuggestion;state.profileDefaults={state:'New York'};
 await open(page);await page.locator('#av2-compose-brief').fill(trialBrief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 await expect(page.locator('#av2-draft-compAmount')).toHaveValue('500.00');
 await expect(page.locator('#av2-draft-deadline')).toHaveValue('2027-04-01');
 await expect(page.getByRole('button',{name:'Edit state',exact:true})).toHaveText('California');
 await expect.poll(()=>state.saved?.compAmount).toBe('500.00');expect(state.saved.deadline).toBe('2027-04-01');expect(state.saved.state).toBe('California');
 await page.reload();await expect(page.locator('#av2-draft-compAmount')).toHaveValue('500.00');await expect(page.locator('#av2-draft-deadline')).toHaveValue('2027-04-01');
 await expect(modal(page)).not.toContainText('22%');
 const directory=path.resolve(__dirname,'../../../../outputs/matter-field-extraction');fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,'trial-draft.png')});expect(errors).toEqual([]);
});
test('rebuilding preserves practical fields edited by the attorney, including deliberately cleared fields',async({page})=>{
 const {state}=await setup(page);state.suggestions=trialSuggestion;await open(page);await page.locator('#av2-compose-brief').fill(trialBrief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 await setField(page,'compensation','#av2-draft-compAmount','750');await setField(page,'state','#av2-draft-state','Virginia',true);await setField(page,'deadline','#av2-draft-deadline','');
 await page.getByRole('button',{name:'← Back',exact:true}).click();await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await page.getByRole('button',{name:'Use revised draft',exact:true}).click();
 await expect(page.locator('#av2-draft-compAmount')).toHaveValue('750');await expect(page.getByRole('button',{name:'Edit state',exact:true})).toHaveText('Virginia');await expect(page.locator('#av2-draft-deadline')).toHaveValue('');
});
test('invalid extracted practical fields fail without losing the original notes',async({page})=>{
 const {state}=await setup(page);state.suggestions={...trialSuggestion,deadline:'2027-02-30'};await open(page);await page.locator('#av2-compose-brief').fill(trialBrief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeVisible();await expect(page.locator('#av2-compose-brief')).toHaveValue(trialBrief);
});

test('deadline and compensation stay directly editable and calendar opens from its icon',async({page})=>{
 const {state,errors}=await setup(page);await build(page);
 const date=page.locator('#av2-draft-deadline'),amount=page.locator('#av2-draft-compAmount');
 await expect(date).toBeVisible();await expect(amount).toBeVisible();
 await complete(page);
 await date.focus();await date.press('Tab');await expect(date).toBeVisible();
 await date.evaluate(el=>{el.showPicker=()=>{el.dataset.pickerOpened='yes';};});
 await page.getByRole('button',{name:'Choose deadline',exact:true}).click();
 await expect(date).toHaveAttribute('data-picker-opened','yes');await expect(date).toBeFocused();
 await date.fill('2027-04-01');await amount.fill('500');await amount.press('Tab');
 await expect.poll(()=>state.saved?.deadline).toBe('2027-04-01');await expect.poll(()=>state.saved?.compAmount).toBe('500');
 await date.fill('');await date.press('Tab');await expect(date).toBeVisible();
 await amount.fill('');await amount.press('Tab');await expect(amount).toBeVisible();
 await expect.poll(()=>state.saved?.deadline).toBe('');await expect.poll(()=>state.saved?.compAmount).toBe('');
 await page.reload();await expect(date).toBeVisible();await expect(amount).toBeVisible();
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();
 await page.getByRole('button',{name:'Add compensation',exact:true}).click();await expect(amount).toBeFocused();
 expect(errors).toEqual([]);
});

test('Build maps explicit experience and requirements, autosaves and protects subsequent edits',async({page})=>{
 const {state,errors}=await setup(page);
 state.suggestions={...trialSuggestion,experience:'5+ years',requirements:['Clio proficiency']};
 await open(page);await page.locator('#av2-compose-brief').fill(trialBrief+' At least 5 years experience required. Clio proficiency required.');
 await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 await expect(page.getByRole('button',{name:'Edit experience',exact:true})).toHaveText('At least 5 years');
 await expect(page.locator('.av2-compose-requirement-list')).toContainText('Clio proficiency');
 await expect.poll(()=>state.saved?.experience).toBe('5+ years');expect(state.saved.requirements).toEqual(['Clio proficiency']);
 await page.reload();await expect(page.getByRole('button',{name:'Edit experience',exact:true})).toHaveText('At least 5 years');
 await setField(page,'experience','#av2-draft-experience','',true);
 await page.getByRole('button',{name:'Remove requirement: Clio proficiency',exact:true}).click();
 await page.getByRole('button',{name:'← Back',exact:true}).click();await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 await page.getByRole('button',{name:'Use revised draft',exact:true}).click();
 await expect(page.getByRole('button',{name:'Edit experience',exact:true})).toHaveText('No minimum');
 await expect(page.locator('.av2-compose-requirement')).toHaveCount(0);
 await expect.poll(()=>state.saved?.experience).toBe('');await expect.poll(()=>state.saved?.requirements).toEqual([]);
 expect(errors).toEqual([]);
});

test('Update Matter changes only the requested field after a deliberate click',async({page})=>{
 const {state,errors}=await setup(page);await build(page);
 const source=page.locator('#av2-compose-brief');await expect(source).toBeEditable();
 await expect(page.getByRole('button',{name:'Update Matter',exact:true})).toBeHidden();
 const title=await page.getByRole('button',{name:'Edit matter',exact:true}).textContent(),scope=await page.locator('#av2-draft-description').inputValue();
 await source.fill(brief+' Budget is $750.');expect(state.suggestionCalls).toBe(1);
 await expect(page.getByRole('button',{name:'Update Matter',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Update Matter',exact:true}).click();
 await expect(page.locator('#av2-draft-compAmount')).toHaveValue('750.00');
 await expect(page.locator('.av2-draft-field-compAmount')).toHaveClass(/av2-field-updated/);
 await expect(page.getByRole('button',{name:'Edit matter',exact:true})).toHaveText(title);await expect(page.locator('#av2-draft-description')).toHaveValue(scope);
 expect(state.lastSuggestion.update.previousSource).toBe(brief);
 await expect.poll(()=>state.saved?.appliedSourceDescription).toBe(brief+' Budget is $750.');
 await expect(page.getByRole('button',{name:'Update Matter',exact:true})).toBeHidden();await expect(page.locator('.av2-matter-update > [role=status]')).toBeFocused();
 const directory=path.resolve(__dirname,'../../../../outputs/matter-updates');fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,'updated.png')});expect(errors).toEqual([]);
});
test('Update Matter asks which conflicting edited value to keep',async({page})=>{
 const {state}=await setup(page);await build(page);await setField(page,'compensation','#av2-draft-compAmount','600');await setField(page,'matter','#av2-draft-title','My title');
 state.changes={compAmount:'750.00',title:'New requested title'};
 await page.locator('#av2-compose-brief').fill(brief+' Budget is $750. Title: New requested title.');
 await page.getByRole('button',{name:'Update Matter',exact:true}).click();
 await expect(page.locator('#av2-draft-compAmount')).toHaveValue('600');
 await expect(page.getByRole('region',{name:'Matter conflict'})).toBeVisible();
 const directory=path.resolve(__dirname,'../../../../outputs/matter-updates');fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,'conflicts.png')});
 await page.getByRole('region',{name:'Matter conflict'}).getByRole('button',{name:'Keep current'}).click();
 await page.getByRole('region',{name:'Compensation conflict'}).getByRole('button',{name:'Use notes'}).click();
 await expect(page.locator('#av2-draft-compAmount')).toHaveValue('750.00');await expect(page.getByRole('button',{name:'Edit matter',exact:true})).toHaveText('My title');
});
test('pending note updates survive reload and failed or stale responses preserve edits',async({page})=>{
 const {state}=await setup(page);await build(page);const notes=brief+' Budget is $750.';
 await page.locator('#av2-compose-brief').fill(notes);await expect.poll(()=>state.saved?.sourceDescription).toBe(notes);expect(state.saved.appliedSourceDescription).toBe(brief);
 await page.reload();await expect(page.locator('#av2-compose-brief')).toHaveValue(notes);await expect(page.getByRole('button',{name:'Update Matter',exact:true})).toBeVisible();
 state.aiFail=true;await page.getByRole('button',{name:'Update Matter',exact:true}).click();await expect(page.locator('.av2-matter-update')).toContainText('We couldn’t update');await expect(page.locator('#av2-draft-compAmount')).toHaveValue('');
 state.aiFail=false;state.updateDelay=500;await page.getByRole('button',{name:'Update Matter',exact:true}).click();await page.locator('#av2-draft-compAmount').fill('900');
 await expect(page.locator('.av2-matter-update')).toContainText('Your notes or Matter changed');await expect(page.locator('#av2-draft-compAmount')).toHaveValue('900');
 await page.getByRole('button',{name:'Update Matter',exact:true}).click();await page.getByRole('region',{name:'Compensation conflict'}).getByRole('button',{name:'Keep current'}).click();await expect(page.locator('#av2-draft-compAmount')).toHaveValue('900');
});

test('manual blank task is ready to type without saving an empty task',async({page})=>{
 const {state}=await setup(page);await open(page);await chooseCreationOption(page,'Enter details manually');
 await expect(page.locator('.av2-draft-tasks input')).toBeVisible();await expect(page.locator('#av2-draft-title')).toBeFocused();
 await page.locator('#av2-draft-title').fill('Trial binder');await page.locator('#av2-draft-title').press('Tab');
 await expect(page.locator('#av2-draft-title')).toBeVisible();await expect.poll(()=>state.saved?.tasks).toEqual([]);
 await page.locator('.av2-draft-tasks input').fill('Prepare trial binder');await page.locator('.av2-draft-tasks input').press('Tab');await expect.poll(()=>state.saved?.tasks).toEqual([{title:'Prepare trial binder'}]);
 await page.getByRole('button',{name:'Remove task 1',exact:true}).click();await expect(page.locator('.av2-draft-tasks input')).toHaveCount(1);await expect(page.locator('.av2-draft-tasks input')).toHaveValue('');await expect.poll(()=>state.saved?.tasks).toEqual([]);
 await page.getByRole('button',{name:'← Back',exact:true}).click();await page.locator('#av2-compose-brief').fill(brief);await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();await page.getByRole('button',{name:'Use revised draft',exact:true}).click();
 await expect(page.locator('.av2-living-canvas')).toHaveAttribute('data-manual','false');await page.locator('#av2-compose-brief').focus();await expect(page.locator('#av2-draft-title')).toBeHidden();await expect(page.getByRole('button',{name:'Edit matter',exact:true})).toBeVisible();
});

test('compensation below $400 is rejected before review in manual and assisted entry',async({page})=>{
 const {state}=await setup(page);await open(page);await chooseCreationOption(page,'Enter details manually');
 const amount=page.locator('#av2-draft-compAmount'),error=page.locator('#av2-draft-compAmount-error');
 await expect(amount).toHaveAttribute('placeholder','400 minimum');
 for(const value of ['399','399.99','0']){
  await amount.fill(value);await amount.press('Tab');await expect(error).toHaveText('Minimum $400');expect(await amount.evaluate(el=>el.checkValidity())).toBe(false);
  await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');await expect(amount).toBeFocused();
 }
 await amount.fill('400');await amount.press('Tab');await expect(error).toBeEmpty();expect(await amount.evaluate(el=>el.checkValidity())).toBe(true);
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','review');
 await page.getByRole('button',{name:'← Back',exact:true}).click();await page.getByRole('button',{name:'← Back',exact:true}).click();
 state.suggestions={...trialSuggestion,compAmount:'300.00'};await page.locator('#av2-compose-brief').fill(trialBrief.replace('500','300'));await page.getByRole('button',{name:'Build my Matter →',exact:true}).click();
 await amount.fill('300');await amount.press('Tab');await expect(error).toHaveText('Minimum $400');await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');
});

test('Additional options keeps deadline visible and preserves optional values when collapsed',async({page})=>{
 const {state}=await setup(page);await open(page);await chooseCreationOption(page,'Enter details manually');
 await expect(page.locator('#av2-draft-deadline')).toBeVisible();await expect(page.locator('#av2-draft-experience')).toBeHidden();await expect(page.locator('.av2-compose-requirements')).toBeHidden();
 await openOptions(page);await page.locator('#av2-draft-experience').selectOption('3+ years');
 await expect(page.getByRole('textbox',{name:'New requirement'})).toBeVisible();await page.getByRole('textbox',{name:'New requirement'}).fill('Clio proficiency');await page.getByRole('textbox',{name:'New requirement'}).press('Enter');
 await page.getByRole('button',{name:'− Additional options',exact:true}).click();await expect(page.locator('#av2-draft-experience')).toBeHidden();
 await expect.poll(()=>state.saved?.experience).toBe('3+ years');expect(state.saved.requirements).toEqual(['Clio proficiency']);await expect(page.locator('.av2-compose-requirements')).toBeHidden();
 await page.reload();await expect(page.getByRole('button',{name:'− Additional options',exact:true})).toHaveAttribute('aria-expanded','true');await expect(page.locator('#av2-draft-experience')).toHaveValue('3+ years');await expect(page.locator('.av2-compose-requirement-list')).toContainText('Clio proficiency');
});
test('manual task examples stop after the first row and compensation stays quiet while typing',async({page})=>{
 await setup(page);await open(page);await chooseCreationOption(page,'Enter details manually');
 const first=page.getByRole('textbox',{name:'Task 1',exact:true});await expect(first).toHaveAttribute('placeholder','For example, a tabbed trial binder');await first.fill('Prepare binder');
 await page.getByRole('button',{name:'+ Add task',exact:true}).click();const second=page.getByRole('textbox',{name:'Task 2',exact:true});await expect(second).toBeFocused();await expect(second).toHaveAttribute('placeholder','');
 const amount=page.locator('#av2-draft-compAmount'),error=page.locator('#av2-draft-compAmount-error');await amount.fill('4');await expect(error).toBeEmpty();await amount.fill('40');await expect(error).toBeEmpty();await amount.fill('400');await amount.press('Tab');await expect(error).toBeEmpty();
});

for(const width of [1600,390])test(`Additional options reveals its fields above the footer at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await setup(page);await open(page);await chooseCreationOption(page,'Enter details manually');await openOptions(page);
 await expect.poll(()=>page.locator('.av2-additional-options').evaluate(el=>{
  const field=el.querySelector('input').getBoundingClientRect();
  const toggle=el.querySelector('button').getBoundingClientRect();
  const viewport=el.closest('.av2-creation-content').getBoundingClientRect();
  const footer=el.parentElement.querySelector('.av2-draft-step-actions').getBoundingClientRect();
  return toggle.top>=viewport.top&&field.bottom<=Math.min(viewport.bottom,footer.top);
 })).toBe(true);
});

for(const width of [1600,390])test(`requirements suggest skills and never add on blur at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});const {state}=await setup(page);await build(page);await complete(page);await openOptions(page);
 const input=page.getByRole('textbox',{name:'New requirement'}), chips=page.locator('.av2-compose-requirement-list');
 await input.fill('clio');await expect(page.getByRole('button',{name:'Clio proficiency',exact:true})).toBeVisible();
 await input.press('Tab');await expect(chips).not.toContainText('Clio');await expect(input).toHaveValue('Clio');
 await input.focus();await page.getByRole('button',{name:'Clio proficiency',exact:true}).click();await expect(chips).toContainText('Clio proficiency');
 await input.fill('misdf');await input.press('Enter');await expect(chips).not.toContainText('Misdf');await expect(page.locator('#av2-requirement-feedback')).toContainText('What should the paralegal');
 await page.getByRole('button',{name:'Review Matter →',exact:true}).click();await expect(input).toBeFocused();await expect(input).toHaveValue('Misdf');
 await input.fill('imanage proficiency');await input.press('Enter');await expect(chips).toContainText('iManage proficiency');
 await input.fill('PDF editing experience');await input.press('Enter');await page.getByRole('button',{name:'Use as written',exact:true}).click();await expect(chips).toContainText('PDF editing experience');
 await input.fill('virginia litigation experience');await input.press('Enter');await page.getByRole('button',{name:'Use as written',exact:true}).click();await page.getByRole('button',{name:'Review Matter →',exact:true}).click();
 await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','review');await expect.poll(()=>state.saved?.requirements).toEqual(['Clio proficiency','iManage proficiency','PDF editing experience','Virginia litigation experience']);
 await page.getByRole('button',{name:'← Back',exact:true}).click();await openOptions(page);await input.fill('Relativity');await input.press('Enter');await page.getByRole('button',{name:'Use as written',exact:true}).click();await expect(chips).toContainText('Relativity');
 await input.fill('clio proficiency');await input.press('Enter');await expect(page.locator('#av2-requirement-feedback')).toHaveText('That requirement is already listed.');
 await input.fill('');await expect(page.locator('#av2-requirement-feedback')).toBeEmpty();
 await page.screenshot({path:path.resolve(__dirname,`../../../../outputs/manual-entry/requirements-smart-${width}.png`)});
});

 test('unfinished custom requirement survives refresh without being accepted',async({page})=>{
 const {state}=await setup(page);await build(page);await complete(page);await openOptions(page);
 const input=page.getByRole('textbox',{name:'New requirement'});
 await input.fill('misdf skills');await input.press('Tab');
 await expect.poll(()=>state.saved?.pendingRequirement).toBe('Misdf skills');
 expect(state.saved.requirements).toEqual([]);await page.reload();
 await expect(input).toHaveValue('Misdf skills');await input.press('Enter');
 await expect(page.locator('.av2-compose-requirement-list')).not.toContainText('Misdf');
 await expect(page.locator('#av2-requirement-feedback')).toContainText('Review this custom requirement');
 await input.fill('Virginia litigation experience');await input.press('Enter');
 await page.getByRole('button',{name:'Use as written',exact:true}).click();
 await expect.poll(()=>state.saved?.pendingRequirement).toBe('');
 await expect.poll(()=>state.saved?.requirements).toEqual(['Virginia litigation experience']);
 });

test('Start over stays on Describe while fresh publishing options load',async({page})=>{
 const {state}=await setup(page);await build(page);
 let release;state.optionsGate=new Promise(resolve=>release=resolve);
 try {
  await startNewConfirmed(page);
  await expect.poll(()=>state.optionsPending).toBe(true);
  await expect(page.locator('#av2-compose-brief')).toHaveValue('');
  await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','describe');
  await expect(page.getByRole('region',{name:'Publication status',exact:true})).toBeHidden();
  await expect(modal(page)).not.toContainText('Checking publication…');
  expect(state.publishes).toBe(0);
 } finally {release();}
 await expect(page.locator('#av2-compose-brief')).toBeFocused();
 await expect(page.getByRole('button',{name:'Start over',exact:true})).toBeEnabled();
 await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','describe');
});

test('Start over still exposes failed publishing-option recovery',async({page})=>{
 const {state}=await setup(page);await build(page);state.optionsFail=true;
 await startNewConfirmed(page);
 await expect(page.getByRole('region',{name:'Publication status',exact:true})).toContainText('Publishing options couldn’t be loaded.');
 await expect(page.getByRole('button',{name:'Check publication result',exact:true})).toBeVisible();
 state.optionsFail=false;await page.getByRole('button',{name:'Check publication result',exact:true}).click();
 await expect(page.getByRole('region',{name:'Publication status',exact:true})).toBeHidden();
 await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','describe');
 expect(state.publishes).toBe(0);
});

test('one task cannot be removed and empty manual entry cannot advance to review',async({page})=>{
  const {state}=await setup(page);await open(page);await chooseCreationOption(page,'Enter details manually');
  await expect(page.getByRole('button',{name:/Remove task/})).toHaveCount(0);
  await page.getByRole('button',{name:'Review Matter →',exact:true}).click();
  await expect(page.locator('.av2-creation-surface')).toHaveAttribute('data-step','description');
  await expect(page.locator('#av2-draft-title')).toBeFocused();
  await expect(page.locator('#av2-draft-title')).toHaveAttribute('aria-invalid','true');
  expect(state.publishes).toBe(0);
  await page.getByRole('textbox',{name:'Task 1',exact:true}).fill('Prepare trial documents');
  await page.getByRole('button',{name:'+ Add task',exact:true}).click();
  await expect(page.getByRole('button',{name:/Remove task/})).toHaveCount(2);
  await page.getByRole('button',{name:'Remove task 2',exact:true}).click();
  await expect(page.getByRole('button',{name:/Remove task/})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Task 1',exact:true})).toHaveValue('Prepare trial documents');
});
