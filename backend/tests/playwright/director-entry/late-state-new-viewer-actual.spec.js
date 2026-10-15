'use strict';
const {test,expect,start,snapshot}=require('../financial-lifecycle/financial-strict-observation.cjs');
const fs=require('node:fs/promises'),crypto=require('node:crypto');
let server;
test.beforeAll(async()=>{test.setTimeout(180000);server=await start({includeDirectors:true,port:0});});
test.beforeEach(async()=>server.reset());
test.afterAll(async()=>server?.close());

test('committed Director single and selected state receipts cannot replace a legitimate new viewer or continue old decisions',async({browser,financialStrictObservation},info)=>{
 test.setTimeout(90000);
 const User=require('../../../models/User'),Record=require('../../../models/DirectorOutreachRecord');
 const proof={boundary:'Actual mounted handlers, native state selections, sibling logout and password login, real managed sessions/local Mongo. Only delivery of an already completed successful state response is held. Existing document-pinned owner requires explicit reload for a different owner. No synthetic storage event, payload replacement, native API override or provider send.',phases:[]};
 const contexts=[];let releaseGate;
 const stateRequests=()=>server.evidence().requests.filter(r=>r.method==='PATCH'&&/^\/api\/director\/records\/[a-f0-9]{24}\/state$/.test(r.path));
 const financialNames=models=>Object.keys(models).filter(name=>/^(Case|CaseDraft|CaseFile|Job|Application|ApplicationDecision|FinancialAdjustment|PaymentOperation|Payout|PlatformIncome|WebhookEvent|DirectorOutreachEvent|MatterPublication)$/.test(name));
 async function capture(kind){const models=await snapshot();financialStrictObservation.stages.push({index:financialStrictObservation.stages.length,kind,at:new Date().toISOString(),models});return models;}
 try{
  for(const mode of ['single','selected']){
   const stage={mode,events:[]};proof.phases.push(stage);
   const a=await server.createUser('director'),b=await server.createUser('director');
   const aUser=await User.findById(a.id).lean(),bUser=await User.findById(b.id).lean();
   const oldRows=[];for(let i=0;i<(mode==='selected'?3:1);i++)oldRows.push(await Record.create({directorUserId:a.id,directorEmail:aUser.email,attorneyEmail:`${mode}-old-${i}@example.test`,attorneyName:`${mode} old ${i}`,state:'TX',stage:'outreach_sent',firstOutreachSentAt:new Date()}));
   const newRow=await Record.create({directorUserId:b.id,directorEmail:bUser.email,attorneyEmail:`${mode}-new@example.test`,attorneyName:`${mode} new viewer`,state:'CA',stage:'outreach_sent',firstOutreachSentAt:new Date()});
   stage.actors={old:a.id,current:b.id};stage.oldRecordIds=oldRows.map(r=>String(r._id));stage.newRecordId=String(newRow._id);
   const context=await browser.newContext({baseURL:server.origin,viewport:{width:1366,height:1000}});contexts.push(context);
   await context.addCookies([a.cookie]);
   await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
   const oldPage=await context.newPage();await oldPage.goto(server.origin+'/director-portal.html');
   await expect(oldPage.getByRole('combobox',{name:`State for ${mode} old 0`,exact:true})).toHaveValue('TX');
   await expect(oldPage.locator('#directorIdentity')).toContainText(aUser.email);
   const firstPath=`/api/director/records/${oldRows[0]._id}/state`;let held=false;
   const gate=new Promise(resolve=>{releaseGate=resolve;});
   await oldPage.route(server.origin+firstPath,async route=>{
    const response=await route.fetch();
    if(route.request().method()==='PATCH'&&response.status()===200&&!held){
     held=true;const body=await response.body();stage.heldResponse={status:response.status(),bodySha256:crypto.createHash('sha256').update(body).digest('hex'),body:JSON.parse(body.toString()),at:new Date().toISOString()};
     stage.committedBeforeReceipt=await Record.collection.findOne({_id:oldRows[0]._id});
     stage.events.push({kind:'actual200-and-persisted-state-held-before-browser-receipt',at:new Date().toISOString()});
     await gate;
    }
    await route.fulfill({response});
   });
   stage.beforeMutation=await capture(mode+'-before-native-state-mutation');
   if(mode==='selected'){
    for(let i=0;i<3;i++)await oldPage.getByRole('checkbox',{name:`Select ${mode} old ${i}`,exact:true}).check();
    await oldPage.locator('#selectedStateSelect').selectOption('NY');
   }else await oldPage.getByRole('combobox',{name:`State for ${mode} old 0`,exact:true}).selectOption('NY');
   await expect.poll(()=>held,{timeout:15000}).toBe(true);
   expect(stage.committedBeforeReceipt.state).toBe('NY');
   // Real native password sign-in establishes the other owner, writes the
   // canonical public identity and emits the browser's ordinary storage event.
   const currentPage=await context.newPage();await currentPage.goto(server.origin+'/director-portal.html');
   await expect(currentPage.locator('#directorIdentity')).toContainText(aUser.email);
   await currentPage.getByRole('button',{name:'Log out',exact:true}).click();
   await expect(currentPage).toHaveURL(server.origin+'/login.html');
   await currentPage.locator('#email').fill(bUser.email);
   await currentPage.locator('#password').fill('Private synthetic lifecycle password!');
   const loginReceipt=currentPage.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST');
   await currentPage.getByRole('button',{name:'Sign in',exact:true}).click();
   const login=await loginReceipt;expect(login.status()).toBe(200);
   await expect(currentPage).toHaveURL(server.origin+'/director-portal.html');
   await expect(currentPage.getByRole('combobox',{name:`State for ${mode} new viewer`,exact:true})).toHaveValue('CA');
   await expect(currentPage.locator('#directorIdentity')).toContainText(bUser.email);
   const currentResponse=await context.request.get(server.origin+'/api/auth/me');expect(currentResponse.status()).toBe(200);const loginBody=await currentResponse.json();expect(loginBody.user).toMatchObject({id:b.id,role:'director',status:'approved'});
   const currentCookie=(await context.cookies(server.origin)).find(cookie=>cookie.name==='token');const claims=require('jsonwebtoken').verify(currentCookie.value,process.env.JWT_SECRET);expect(claims.id).toBe(b.id);const savedSession=await require('../../../models/AuthSession').findOne({sessionId:claims.sid}).lean();expect(savedSession).toBeTruthy();expect(String(savedSession.userId)).toBe(b.id);expect(savedSession.revokedAt).toBeFalsy();
   stage.currentManagedSession={ownerId:String(savedSession.userId),sessionId:claims.sid,authMeStatus:currentResponse.status(),authMeOwner:loginBody.user.id};
   await expect(oldPage.locator('#directorStatus')).toContainText('signed-in account changed');
   await expect(oldPage.locator('[data-record-row-id]')).toHaveCount(0);
   await currentPage.getByRole('checkbox',{name:`Select ${mode} new viewer`,exact:true}).check();
   await expect(currentPage.locator('#selectedRowsCount')).toHaveText('1 attorney selected');
   const currentStatus=await currentPage.locator('#directorStatus').textContent();
   stage.currentViewer={loginStatus:login.status(),ownerId:loginBody.user.id,nativeLogoutThenLogin:true,nativeLogin:true,ordinaryStorageEvent:true,currentStatus,selectedIds:[String(newRow._id)],publicIdentity:await currentPage.evaluate(()=>JSON.parse(localStorage.getItem('lpc_user')))};
   expect(stage.currentViewer.publicIdentity.id).toBe(b.id);
   stage.beforeOldReceipt=await capture(mode+'-new-legitimate-viewer-ready-before-old200-release');
   stage.events.push({kind:'new-owner-native-login-and-selection-settled-before-release',at:new Date().toISOString()});
   const requested=oldPage.waitForResponse(r=>new URL(r.url()).pathname===firstPath&&r.request().method()==='PATCH'&&r.status()===200);
   releaseGate();await requested;
   await expect(oldPage.locator('#directorStatus')).toContainText('Director account changed');
   await expect(oldPage.locator('[data-record-row-id]')).toHaveCount(0);
   await expect(oldPage.locator('#directorIdentity')).toHaveText('');
   await expect(oldPage.locator('#bulkStateBar')).toBeHidden();
   await expect(currentPage.locator('#directorIdentity')).toContainText(bUser.email);
   await expect(currentPage.getByRole('checkbox',{name:`Select ${mode} new viewer`,exact:true})).toBeChecked();
   await expect(currentPage.getByRole('combobox',{name:`State for ${mode} new viewer`,exact:true})).toHaveValue('CA');
   await expect(currentPage.locator('#selectedRowsCount')).toHaveText('1 attorney selected');
   await expect(currentPage.locator('#directorStatus')).toHaveText(currentStatus||'');
   expect(await currentPage.locator('body').innerText()).not.toContain(`${mode}-old-0@example.test`);
   stage.afterOldReceipt=await capture(mode+'-old200-delivered-with-new-owner-models-conserved');
   expect(stage.afterOldReceipt,'A completed old response must not perform any new database work after the new viewer is ready').toEqual(stage.beforeOldReceipt);
   stage.savedOldRows=await Promise.all(oldRows.map(r=>Record.collection.findOne({_id:r._id})));
   expect(stage.savedOldRows.map(r=>r.state)).toEqual(mode==='selected'?['NY','TX','TX']:['NY']);
   expect((await Record.collection.findOne({_id:newRow._id})).state).toBe('CA');
   stage.stateRequests=stateRequests().filter(r=>stage.oldRecordIds.some(id=>r.path.includes(id))||r.path.includes(String(newRow._id)));
   expect(stage.stateRequests.filter(r=>r.status===200)).toHaveLength(1);
   expect(stage.stateRequests.every(r=>r.path===firstPath)).toBe(true);
   for(const name of financialNames(stage.beforeMutation))expect(stage.afterOldReceipt[name],mode+' conserved '+name).toEqual(stage.beforeMutation[name]);
   stage.currentViewer.afterReceiptIdentity=await currentPage.evaluate(()=>JSON.parse(localStorage.getItem('lpc_user')));
   expect(stage.currentViewer.afterReceiptIdentity.id).toBe(b.id);
   // The pinned old document cannot silently become the new owner. Its
   // approved explicit reload creates the new verified document instead.
   await oldPage.getByRole('button',{name:'Refresh records',exact:true}).click();
   await expect(oldPage.locator('#directorStatus')).toContainText('Director account changed');
   await expect(oldPage.locator('[data-record-row-id]')).toHaveCount(0);
   await oldPage.reload();
   await expect(oldPage.getByRole('combobox',{name:`State for ${mode} new viewer`,exact:true})).toHaveValue('CA');
   await expect(oldPage.locator('#directorIdentity')).toContainText(bUser.email);
   expect(await oldPage.locator('body').innerText()).not.toContain(`${mode}-old-0@example.test`);
   stage.explicitReloadVerifiedNewOwner=true;stage.afterReload=await capture(mode+'-explicit-native-reload-verifies-new-owner');
   for(const name of financialNames(stage.beforeMutation))expect(stage.afterReload[name],mode+' reload conserved '+name).toEqual(stage.beforeMutation[name]);
   expect(stateRequests().filter(r=>stage.oldRecordIds.some(id=>r.path.includes(id))&&r.status===200)).toHaveLength(1);
   await currentPage.screenshot({path:info.outputPath(mode+'-new-viewer-preserved.png'),fullPage:true});
   await context.close();
  }
  expect(server.provider.calls).toEqual([]);expect(server.evidence().external.mail).toEqual([]);expect(server.evidence().external.storage).toEqual([]);
 }finally{
  releaseGate?.();proof.final=await snapshot();proof.server=server.evidence();proof.providerCalls=server.provider.calls;
  await fs.writeFile(info.outputPath('director-late-state-checkpoint.json'),JSON.stringify(proof,null,2));
  for(const context of contexts)await context.close();
 }
});
