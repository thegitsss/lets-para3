'use strict';
const {test,expect,start,snapshot}=require('./financial-strict-observation.cjs');
const fs=require('node:fs/promises'),crypto=require('node:crypto'),mongoose=require('mongoose');
let server;
test.beforeAll(async()=>{test.setTimeout(240000);server=await start({port:0});});
test.beforeEach(async()=>server.reset());
test.afterAll(async()=>server?.close());
const fields={title:'Actual posting lock record agreement',practiceArea:'Contract Law',state:'New York',compAmount:'400.01',experience:'3+ years',deadline:'2027-03-14',description:'First retained paragraph.\n\nSecond retained paragraph.',tasks:[{title:'Preserve the agreed evidence index'}],requirements:[]};
async function actor(browser,role){const person=await server.createUser(role,{},true);await require('../../../models/User').updateOne({_id:person.id},{$set:{...(role==='attorney'?{profileImage:''}:{}),state:'NY',stateExperience:['NY'],practiceAreas:['Contract Law'],specialties:['Contract Law'],'onboarding.attorneyTourCompleted':true}});const context=await browser.newContext({baseURL:server.origin,viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(30000);await context.addCookies([person.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));return{...person,context};}
async function call(person,method,path,data,expected=200){const csrf=await(await person.context.request.get('/api/csrf')).json();const response=await person.context.request[method](path,{headers:{'X-CSRF-Token':csrf.csrfToken},...(data?{data:{...data,expectedOwnerId:person.id}}:{})});expect(response.status(),`${method} ${path}: ${await response.text()}`).toBe(expected);return response.json();}
const status=page=>page.getByRole('region',{name:'Posting save status',exact:true});
const moneyNames=['Payout','PaymentOperation','PlatformIncome','MatterWithdrawalNotification','MatterPaymentNotification'];
const money=value=>Object.fromEntries(moneyNames.map(name=>[name,value[name]||[]]));
const caseMoney=doc=>Object.fromEntries(['totalAmount','lockedTotalAmount','currency','feeAttorneyPct','feeParalegalPct','feeAttorneyAmount','feeParalegalAmount','remainingAmount','partialPayoutAmount','paymentIntentId','escrowIntentId','escrowStatus','paymentReleased','payoutTransferId','payoutFinalizedAt','payoutFinalizedType','disputeSettlement'].map(key=>[key,doc[key]]));
test('actual application amount lock and stored hiring claim agree with both native posting editors and cannot change saved scope or money',async({browser},info)=>{
 const evidence={stages:[],boundary:'Actual owned local application/publication routes and stored claim fixture; no actual hire/payment/provider operation. One source-bound local lock-record coherence callback.'};
 try{
  const attorney=await actor(browser,'attorney'),para=await actor(browser,'paralegal');
  const me=await call(attorney,'get','/api/auth/me');expect(me.user.id).toBe(attorney.id);
  const draft=(await call(attorney,'post','/api/case-drafts',fields,201)).draft;
  const publication=(await call(attorney,'post','/api/cases/posting/publications',{draftId:draft.id,revision:draft.revision,requestId:crypto.randomUUID(),practiceArea:'contract law'},201)).publication;
  const caseId=publication.caseId,Case=require('../../../models/Case'),Job=require('../../../models/Job'),Application=require('../../../models/Application'),Publication=require('../../../models/MatterPublication');
  const raw=()=>Case.collection.findOne({_id:new mongoose.Types.ObjectId(caseId)});
  const original=await raw(),job=await Job.collection.findOne({caseId:new mongoose.Types.ObjectId(caseId)});expect(original.totalAmount).toBe(40001);expect(original.lockedTotalAmount==null).toBe(true);expect(job).toBeTruthy();
  const beforeApplication=await snapshot();
  await call(para,'post',`/api/jobs/${job._id}/apply`,{coverLetter:'I can organize the agreed evidence index.'},201);
  const locked=await raw();expect(locked.totalAmount).toBe(40001);expect(locked.lockedTotalAmount).toBe(40001);expect(locked.amountLockedAt).toBeTruthy();expect(locked.tasks).toEqual(original.tasks);expect(locked.details).toBe(fields.description);expect(await Application.countDocuments({jobId:job._id,paralegalId:para.id})).toBe(1);const application=await Application.findOne({jobId:job._id,paralegalId:para.id}).lean();expect(application.scopeSnapshot.caseId).toBe(caseId);expect(application.scopeSnapshot.totalAmount).toBe(40001);
  const projected=(await call(attorney,'get',`/api/cases/posting/${caseId}`)).posting;expect(projected.permissions).toMatchObject({amountLocked:true,tasksLocked:false,canEdit:true});expect(projected.values.compAmount).toBe('400.01');
  const amountBaseline=await snapshot();const amountDenied=await call(attorney,'patch',`/api/cases/posting/${caseId}`,{revision:projected.revision,changes:{compAmount:'800.01'}},409);expect(amountDenied.code).toBe('POSTING_AMOUNT_LOCKED');const amountAfter=await snapshot();for(const name of ['Case','Job','MatterPublication',...moneyNames])expect(amountAfter[name]).toEqual(amountBaseline[name]);
  evidence.caseId=caseId;evidence.ownerId=attorney.id;evidence.paralegalId=para.id;evidence.jobId=String(job._id);evidence.draftId=draft.id;evidence.publication=publication;evidence.stages.push({kind:'actual-application-lock',case:locked,posting:projected,all100Models:await snapshot()});
  const pages=[];
  for(const [name,url]of[['V2',`/attorney-v2.html#/matters/new?caseId=${caseId}`],['current',`/create-case.html?caseId=${caseId}`]]){
   const page=await attorney.context.newPage();pages.push({name,page});await page.goto(url,{waitUntil:'domcontentloaded'});await expect(status(page)).toHaveAttribute('data-state','ready');
   await expect(page.locator('#av2-posting-compAmount')).toHaveValue('400.01');await expect(page.locator('#av2-posting-compAmount')).toBeDisabled();await expect(page.locator('#av2-posting-title')).toBeEnabled();await expect(page.locator('#av2-posting-tasks')).toBeEnabled();await expect(page.locator('[data-av2-posting-editor] .av2-notice')).toContainText('Compensation is locked after an application or invitation.');
   if(name==='V2'){await page.locator('#av2-posting-title').fill('Permitted title with amount locked');await page.getByRole('button',{name:'Review posting changes',exact:true}).click();await page.getByRole('button',{name:'Save reviewed changes',exact:true}).click();await expect(status(page)).toContainText('Posting changes saved.');const saved=await raw();expect(saved.title).toBe('Permitted title with amount locked');expect(saved.totalAmount).toBe(40001);expect(saved.lockedTotalAmount).toBe(40001);expect(saved.tasks).toEqual(original.tasks);expect((await Job.collection.findOne({_id:job._id})).title).toBe(saved.title);}
   await page.locator('#av2-posting-title').fill(`${name} unsent title survives actual claim`);
  }
  const beforeClaim=await raw();const receiptBefore=await Publication.collection.find({}).toArray();
  const claimToken=crypto.randomUUID();const claimed=await Case.collection.updateOne({_id:beforeClaim._id},{$set:{hiringClaimStatus:'claimed',hiringClaimToken:claimToken}});expect(claimed.modifiedCount).toBe(1);
  const claimSaved=await raw();expect(claimSaved).toEqual({...beforeClaim,hiringClaimStatus:'claimed',hiringClaimToken:claimToken});
  evidence.stages.push({kind:'stored-claim-fixture',case:claimSaved,all100Models:await snapshot()});
  for(const {name,page}of pages){
   await status(page).getByRole('button',{name:'Check saved posting',exact:true}).click();await expect(status(page)).toHaveAttribute('data-state','ready');
   await expect(page.locator('#av2-posting-title')).toHaveValue(`${name} unsent title survives actual claim`);await expect(page.locator('#av2-posting-title')).toBeDisabled();await expect(page.locator('#av2-posting-compAmount')).toHaveValue('400.01');await expect(page.locator('#av2-posting-compAmount')).toBeDisabled();await expect(page.locator('#av2-posting-tasks')).toHaveValue(fields.tasks[0].title);await expect(page.locator('#av2-posting-tasks')).toBeDisabled();
   await expect(page.getByRole('button',{name:'Review posting changes',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Delete posting',exact:true})).toBeDisabled();await expect(page.locator('[data-av2-posting-editor] .av2-notice')).toContainText('Hiring has started.');await expect(page.locator('[data-av2-posting-editor] .av2-notice')).toContainText('Task scope is locked.');
   await page.screenshot({path:info.outputPath(`${name.toLowerCase()}-actual-claim-locked.png`),fullPage:true});
  }
  const live=(await call(attorney,'get',`/api/cases/posting/${caseId}`)).posting;expect(live.permissions).toMatchObject({canEdit:false,canDelete:false,amountLocked:true,tasksLocked:true});
  const denialBaseline=await snapshot();
  const denied=await call(attorney,'patch',`/api/cases/posting/${caseId}`,{revision:live.revision,changes:{title:'Must not save',compAmount:'800.01',tasks:[{title:'Must not replace scope'}]}},409);expect(denied.code).toBeTruthy();
  await call(attorney,'delete',`/api/cases/posting/${caseId}`,{revision:live.revision},409);
  const final=await snapshot();for(const name of ['Case','Job','MatterPublication','Application',...moneyNames])expect(final[name]).toEqual(denialBaseline[name]);expect(money(final)).toEqual(money(beforeApplication));expect(await raw()).toEqual(claimSaved);expect(caseMoney(claimSaved)).toEqual(caseMoney(locked));expect(await Publication.collection.find({}).toArray()).toEqual(receiptBefore);
  expect(await Case.countDocuments()).toBe(1);expect(await Job.countDocuments()).toBe(1);expect(await Publication.countDocuments()).toBe(1);
  const writes=server.evidence().requests.filter(r=>r.method==='PATCH'&&r.path===`/api/cases/posting/${caseId}`);expect(writes.filter(r=>r.status===200)).toHaveLength(1);expect(writes.filter(r=>r.status===409)).toHaveLength(2);
  evidence.stages.push({kind:'native-locked-and-denied-writes-conserved',case:claimSaved,posting:live,all100Models:final,actualPostingWrites:writes});evidence.noDuplicatePublication=true;evidence.scopeAndAmountConserved=true;evidence.actualNativeBothEditors=true;
 }finally{evidence.server=server.evidence();evidence.final=await snapshot();await fs.writeFile(info.outputPath('posting-lock-actual-records.json'),JSON.stringify(evidence,null,2));await info.attach('posting-lock-actual-records.json',{path:info.outputPath('posting-lock-actual-records.json'),contentType:'application/json'});}
});
