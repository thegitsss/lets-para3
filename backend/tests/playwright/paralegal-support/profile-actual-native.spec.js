'use strict';
const {test,expect}=require('../workspace-paired-observation.cjs');
const fs=require('node:fs/promises'),crypto=require('node:crypto');
const start=require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async()=>{test.setTimeout(240000);server=await start({port:0});});
test.beforeEach(async()=>server.reset());
test.afterAll(async()=>server?.close());
const profileKeys=['firstName','lastName','email','pendingEmail','pendingEmailRequestedAt','state','location','bio','about','yearsExperience','practiceAreas','specialties','skills','stateExperience','jurisdictions','linkedInURL','education','languages','preferences','profileImage','profilePhotoStatus','createdAt','updatedAt'];
async function profile(id){const User=require('../../../models/User'),u=await User.findById(id).lean();return Object.fromEntries(['_id',...profileKeys].map(k=>[k,u[k]]));}
const businessNames=['Case','Job','Application','CaseFile','Message','Payout','PaymentOperation','PlatformIncome','Event','Task'];
async function business(){const mongoose=require('mongoose');return Object.fromEntries(await Promise.all(businessNames.map(async n=>[n,await mongoose.models[n].collection.find({}).sort({_id:1}).toArray()])));}
for(const width of [1440,390])test(`actual profile editor persistence, cancellation, retry and own preview ${width}`,async({browser},info)=>{
 test.setTimeout(180000);
 const actor=await server.createUser('paralegal'),User=require('../../../models/User'),legacy=width===390;
 await User.updateOne({_id:actor.id},{$set:{firstName:'Dana',lastName:'Young',profileImage:'',bio:legacy?'':'Current litigation profile.',about:legacy?'Earlier litigation profile.':'',state:legacy?'NY':'CA',location:legacy?'NY':'CA',practiceAreas:legacy?[]:['Litigation'],specialties:legacy?['Litigation']:[],stateExperience:legacy?[]:['CA'],jurisdictions:legacy?['NY']:[],skills:['Legal research'],education:[{school:'City College',degree:'B.A.',fieldOfStudy:'Legal Studies'}],languages:[{name:'English',proficiency:'Native'}]}});
 const context=await browser.newContext({viewport:{width,height:1000}});await context.addCookies([actor.cookie]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
 const page=await context.newPage(),before=await profile(actor.id),beforeBusiness=await business(),steps=[],nativePatches=[];
 let failBio=false,failedBioRequests=0;
 page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname==='/api/users/me')nativePatches.push({at:Date.now(),body:request.postDataJSON()});});
 await page.route(url=>url.pathname==='/api/users/me',async route=>{
  const req=route.request();if(req.method()==='PATCH'&&failBio&&Object.hasOwn(req.postDataJSON(),'bio')){failedBioRequests++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Profile save temporarily unavailable.'})});}return route.fallback();
 });
 try{
  await page.goto(server.origin+'/paralegal-v2.html#/home');
  if(width<800)await page.locator('[data-v2-mobile-menu]').click();await page.getByRole('button',{name:'Open profile menu',exact:true}).click();
  await page.getByRole('menuitem',{name:'Profile Settings',exact:true}).click();
  const panel=page.locator('#v2-settings-profile');await expect(panel).toBeVisible();
  const pendingEmail=`profile-${crypto.randomUUID()}@example.test`;
  const fields=[
   {section:'name',label:'First name',value:'Dani',key:'firstName'},
   {section:'name',label:'Last name',value:'Reed',key:'lastName'},
   {section:'residence',label:'Residence',value:legacy?'California':'New York',key:'state',stored:legacy?'CA':'NY',select:true},
   {section:'years of experience',label:'Years of experience',value:'9',key:'yearsExperience',stored:9},
   {section:'about',label:'Bio',value:'Updated litigation and trial support.',key:'bio',failure:true},
   {section:'practice areas',label:'Select a practice area',value:'Family Law',key:'practiceAreas',contains:true,select:true},
   {section:'skills',label:'Add skill',value:'Trial preparation',key:'skills',contains:true,enter:true},
   {section:'states of experience',label:'Select a state',value:legacy?'CA — California':'NY — New York',key:'stateExperience',stored:legacy?'CA':'NY',contains:true,select:true},
   {section:'linkedin',label:'Profile URL',value:'https://linkedin.com/in/dani-young',key:'linkedInURL'},
   {section:'email',label:'Email',value:pendingEmail,key:'pendingEmail'}
  ];
  for(const field of fields){
   const trigger=panel.getByRole('button',{name:`Edit ${field.section}`,exact:true}),control=panel.getByLabel(field.label,{exact:true});
   const fill=async()=>{if(field.select)await control.selectOption({label:field.value});else await control.fill(field.value);if(field.enter)await control.press('Enter');};
   const snapshot=await profile(actor.id),patches=nativePatches.length;
   await trigger.press('Enter');await expect(control).toBeVisible();await fill();
   await panel.locator('.is-row-editing').getByRole('button',{name:'Cancel',exact:true}).click();
   expect(await profile(actor.id)).toEqual(snapshot);expect(nativePatches.length).toBe(patches);await expect(trigger).toBeFocused();
   await trigger.click();await fill();
   if(field.failure){
    failBio=true;await panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}).click();
    await expect(panel.locator('.is-row-editing')).toContainText('Profile save temporarily unavailable');
    expect(await profile(actor.id)).toEqual(snapshot);await expect(control).toHaveValue(field.value);expect(failedBioRequests).toBe(1);failBio=false;
   }
   const saved=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/users/me');
   await panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}).click();expect((await saved).status()).toBe(200);
   await expect(panel.locator('.is-row-editing')).toHaveCount(0);
   const after=await profile(actor.id),value=field.stored??field.value;
   if(field.contains)expect(after[field.key]).toContain(value);else expect(after[field.key]).toBe(value);
   if(field.key==='email'||field.key==='pendingEmail'){expect(after.email).toBe(before.email);await expect(panel.locator('.v2-profile-email-notice')).toBeVisible();await expect(panel.locator('.v2-profile-email-notice')).toHaveText(`Verify ${pendingEmail}. Until then, sign in with ${before.email}.`);}
   if(field.key==='bio')expect(after.about).toBe(field.value);
   if(field.key==='practiceAreas')expect(after.specialties).toEqual(after.practiceAreas);
   if(field.key==='stateExperience')expect(after.jurisdictions).toEqual(after.stateExperience);
   steps.push({field:field.key,cancelConserved:true,failedSaveConserved:!!field.failure,savedValue:after[field.key]});await fs.writeFile(info.outputPath('profile-actual-progress.json'),JSON.stringify({engine:info.project.name,width,steps},null,2));
   await page.reload();await expect(trigger).toBeVisible();if(field.key==='pendingEmail'){await expect(panel.locator('.v2-profile-email-notice')).toBeVisible();await expect(panel.locator('.v2-profile-email-notice')).toHaveText(`Verify ${pendingEmail}. Until then, sign in with ${before.email}.`);}
  }
  for(const [section,label,value,key] of [['education','School','New College','school'],['education','Degree','LL.B.','degree'],['education','Field of study','Law','fieldOfStudy'],['languages','Language','Spanish','name'],['languages','Proficiency','Professional','proficiency']]){
   const card=panel.locator(`[data-profile-section="${section}"]`),trigger=card.getByRole('button',{name:`Edit ${label.toLowerCase()}, ${section} entry 1`,exact:true}),control=card.getByLabel(label,{exact:true}),snapshot=await profile(actor.id),patches=nativePatches.length;
   const fill=()=>label==='Proficiency'?control.selectOption({label:value}):control.fill(value);
   await trigger.press('Enter');await fill();await card.getByRole('button',{name:'Cancel',exact:true}).click();expect(await profile(actor.id)).toEqual(snapshot);expect(nativePatches.length).toBe(patches);await expect(trigger).toBeFocused();
   await trigger.click();await fill();const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname==='/api/users/me');await card.getByRole('button',{name:'Save',exact:true}).click();expect((await saved).status()).toBe(200);await expect(card.locator('.is-entry-editing')).toHaveCount(0);
   expect((await profile(actor.id))[section][0][key]).toBe(value);await page.reload();await expect(card).toContainText(value);steps.push({field:`${section}.${key}`,cancelConserved:true,savedValue:value});await fs.writeFile(info.outputPath('profile-actual-progress.json'),JSON.stringify({engine:info.project.name,width,steps},null,2));
  }
  const patchesBeforeInvalid=nativePatches.length,snapshotBeforeInvalid=await profile(actor.id);
  await panel.getByRole('button',{name:'Edit linkedin',exact:true}).click();await panel.getByLabel('Profile URL',{exact:true}).fill('not-a-link');await panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}).click();await expect(panel.getByLabel('Profile URL',{exact:true})).toHaveAttribute('aria-invalid','true');expect(nativePatches.length).toBe(patchesBeforeInvalid);expect(await profile(actor.id)).toEqual(snapshotBeforeInvalid);await panel.getByLabel('Profile URL',{exact:true}).press('Escape');await expect(panel.locator('.is-row-editing')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('actual-profile-settings.png')});
  if(width<800)await page.locator('[data-v2-mobile-menu]').click();await page.getByRole('button',{name:'Open profile menu',exact:true}).click();await page.getByRole('menuitem',{name:'View profile',exact:true}).click();
  await expect(page).toHaveURL(/#\/profile\/me$/);const preview=page.locator('[data-v2-profile-preview]');await expect(preview).toBeVisible();await expect(preview.getByRole('heading',{name:'Dani Reed',exact:true})).toBeVisible();
  for(const text of ['Updated litigation and trial support.','Family Law','Trial preparation','New College','LL.B.','Law','Spanish'])await expect(preview).toContainText(text);
  await expect(preview).not.toContainText(before.email);await expect(preview).not.toContainText(pendingEmail);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('actual-profile-own-preview.png')});
  expect(await business()).toEqual(beforeBusiness);expect(failedBioRequests).toBe(1);expect(nativePatches.filter(p=>Object.hasOwn(p.body,'bio'))).toHaveLength(2);
 }finally{
  await fs.writeFile(info.outputPath('profile-actual-records.json'),JSON.stringify({title:info.title,engine:info.project.name,width,legacy,actorId:actor.id,before,after:await profile(actor.id),beforeBusiness,afterBusiness:await business(),steps,nativePatches,failedBioRequests,requests:server.evidence().requests,external:server.evidence().external,providers:'synthetic or disabled'},null,2));await context.close();
 }
});
