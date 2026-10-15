const {test}=require('./shell-fixture');
const {expect}=require('playwright/test');
const {prepare,ui,oldAnswer,activeMatter}=require('./helpers');
const {OWNER,OTHER,MATTER,json}=require('./fixture');
const JOB='999999999999999999999999',APPLICATION='aaaaaaaaaaaaaaaaaaaaaaaa';
const matterHash=role=>role==='attorney'?`/matters/${MATTER}/overview`:`/matter/${MATTER}?tab=overview`;
const sent=calls=>calls.filter(call=>call.method==='POST'&&call.path.endsWith('/messages'));
async function sendContext(page,opened){
 const before=sent(opened.calls).length;await ui(page).composer.fill(`What is open now? ${before}`);await ui(page).composer.press('Enter');await expect.poll(()=>sent(opened.calls).length).toBe(before+1);return sent(opened.calls).at(-1).body.pageContext;
}
for(const role of ['attorney','paralegal']){
 test(`${role} current authorized Matter publishes object hints and supported command codes`,async({page},info)=>{
  const opened=await prepare(page,role,{hash:matterHash(role)});await expect(page.getByRole('heading',{name:role==='attorney'?'Litigation review':'Assigned Matter',exact:true})).toBeVisible();await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  const value=await sendContext(page,opened);await info.attach('context',{body:JSON.stringify(value,null,2),contentType:'application/json'});
  expect.soft(value).toMatchObject({caseId:MATTER,currentTab:'overview',objectType:'matter',objectId:MATTER});expect.soft(value.permittedCommandCodes).toContain('matter.files');expect(value.availableMatterTabs).toContain('files');
 });
 test(`${role} current Matter command uses authorized hint rather than absent legacy globals`,async({page})=>{
  const opened=await prepare(page,role,{hash:matterHash(role),history:[{...oldAnswer,metadata:{actions:[{label:'Open files',commandCode:'matter.files',href:`/case-detail.html?caseId=${MATTER}&tab=files`}]}}]});
  await expect(page.getByRole('heading',{name:role==='attorney'?'Litigation review':'Assigned Matter',exact:true})).toBeVisible();await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await expect(ui(page).thread.getByRole('button',{name:'Open files',exact:true})).toBeVisible();
 });
 test(`${role} stale legacy globals and URL object IDs cannot supply context after route departure`,async({page},info)=>{
  const opened=await prepare(page,role,{hash:matterHash(role)});await expect(page.getByRole('heading',{name:role==='attorney'?'Litigation review':'Assigned Matter',exact:true})).toBeVisible();
  await page.evaluate(({other,job,application})=>{window.LPCProductivityContext={caseId:other,objectType:'application',objectId:application,availableMatterTabs:['files']};window.LPCContextPanel={current:()=>({kind:'application',id:application})};location.hash=`/help?jobId=${job}&applicationId=${application}`;},{other:OTHER,job:JOB,application:APPLICATION});
  await expect(page.getByRole('heading',{name:role==='attorney'?'Help for Attorneys':'Help for Paralegals',exact:true})).toBeVisible();await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  const value=await sendContext(page,opened);await info.attach('context',{body:JSON.stringify(value,null,2),contentType:'application/json'});expect(value).toMatchObject({caseId:'',objectType:'',objectId:'',jobId:'',applicationId:'',availableMatterTabs:[]});
 });
 test(`${role} unknown invoke action is not offered as an inert control`,async({page})=>{
  const opened=await prepare(page,role,{history:[{...oldAnswer,metadata:{actions:[{label:'Unsupported operation',type:'invoke',action:'publish_matter'}]}}]});await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');await expect(ui(page).thread.getByRole('button',{name:'Unsupported operation'})).toHaveCount(0);
 });
}
test('Paralegal stale legacy Matter cannot validate a command for another Matter',async({page})=>{
 const opened=await prepare(page,'paralegal',{hash:matterHash('paralegal'),history:[{...oldAnswer,metadata:{actions:[{label:'Open stale files',commandCode:'matter.files',href:`/case-detail.html?caseId=${OTHER}&tab=files`}]}}]});
 await expect(page.getByRole('heading',{name:'Assigned Matter',exact:true})).toBeVisible();await page.evaluate(other=>{window.LPCProductivityContext={caseId:other,availableMatterTabs:['files']};},OTHER);await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');await expect(ui(page).thread.getByRole('button',{name:'Open stale files'})).toHaveCount(0);
});

test('Paralegal authorized Deadlines tab publishes its actual view context',async({page},info)=>{
 const opened=await prepare(page,'paralegal');const record=activeMatter();record.matterExperience.sections.push({id:'deadlines',label:'Deadlines'});opened.sessionState.matterRespond=route=>json(route,record);
 await page.evaluate(hash=>location.hash=hash,`/matter/${MATTER}?tab=deadlines`);await expect(page.getByRole('heading',{name:'Deadlines',exact:true})).toBeVisible();
 await expect(page.locator('[data-matter-tab="deadlines"]')).toHaveAttribute('aria-current','page');await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
 const value=await sendContext(page,opened);await info.attach('context',{body:JSON.stringify(value,null,2),contentType:'application/json'});expect(value.currentTab).toBe('deadlines');expect(value.availableMatterTabs).toContain('deadlines');
});
for(const role of ['attorney','paralegal'])test(`${role} legacy reset remains explicit and account bound`,async({page},info)=>{
 const opened=await prepare(page,role,{history:[{...oldAnswer,metadata:{actions:[{label:'Email me a reset link',type:'invoke',action:'request_password_reset'}]}}]});await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
 expect(opened.sessionState.calls.filter(call=>call.method==='POST'&&call.path==='/api/auth/request-password-reset')).toHaveLength(0);
 const requests=[];await page.route('**/api/auth/request-password-reset',route=>{requests.push(route.request().postDataJSON());return json(route,{ok:true});});
 await ui(page).thread.getByRole('button',{name:'Email me a reset link'}).click();await expect.poll(()=>requests.length).toBe(1);expect(requests[0]).toMatchObject({expectedOwnerId:OWNER,expectedRole:role});
  await expect(ui(page).thread).toContainText('Reset requested. Check your email for a link.');await info.attach('explicit-reset-request',{body:JSON.stringify(requests,null,2),contentType:'application/json'});
  await info.attach('reset-request-feedback',{body:await ui(page).drawer.screenshot(),contentType:'image/png'});
});
test('Paralegal explicit Stripe restart refuses silent account replacement before provider work',async({page},info)=>{
 const opened=await prepare(page,'paralegal',{history:[{...oldAnswer,metadata:{actions:[{label:'Restart Stripe onboarding',type:'invoke',action:'start_stripe_onboarding'}]}}]});await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
 const requests=[];await page.route('**/api/payments/connect',route=>{requests.push({body:route.request().postDataJSON(),method:route.request().method()});return json(route,{error:'Synthetic Connect unavailable'},503);});
 expect(requests).toHaveLength(0);opened.sessionState.user={...opened.sessionState.user,id:OTHER,_id:OTHER};
 await ui(page).thread.getByRole('button',{name:'Restart Stripe onboarding'}).click();
 await expect(page).toHaveURL(/\/login\.html(?:[?#]|$)/);
 await info.attach('connect-after-owner-replacement',{body:JSON.stringify(requests,null,2),contentType:'application/json'});expect(requests).toHaveLength(0);
});

for (const action of ['request_password_reset','start_stripe_onboarding']) {
 test(`Paralegal ${action} blocks overlapping actions and ignores a response after account replacement`,async({page})=>{
  const opened=await prepare(page,'paralegal',{history:[{...oldAnswer,metadata:{actions:[{label:'Run requested action',type:'invoke',action}]}}]});await opened.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  const endpoint=action==='request_password_reset'?'/api/auth/request-password-reset':'/api/payments/connect';
  let release,body;const held=new Promise(resolve=>release=resolve);
  await page.route(`**${endpoint}`,async route=>{body=route.request().postDataJSON();await held;return json(route,action==='request_password_reset'?{ok:true}:{url:'https://connect.stripe.com/setup/synthetic-only'});});
  try {
   const button=ui(page).thread.getByRole('button',{name:'Run requested action',exact:true});await button.focus();await button.press('Enter');
   await expect.poll(()=>Boolean(body)).toBe(true);expect(body).toMatchObject({expectedOwnerId:OWNER,expectedRole:'paralegal'});
   await expect(button).toBeDisabled();await ui(page).composer.fill('Keep my next question');await ui(page).composer.press('Enter');expect(sent(opened.calls)).toHaveLength(0);
   opened.sessionState.user={...opened.sessionState.user,id:OTHER,_id:OTHER};
  } finally {release();}
  await expect(page).toHaveURL(/\/login\.html(?:[?#]|$)/);
 });
}
