const {test,expect}=require('playwright/test');
const start=require('../../helpers/financialLifecycleBrowserServer');
const Preference=require('../../../models/AutonomyPreference'),Audit=require('../../../models/AuditLog');
const Ticket=require('../../../models/SupportTicket');
let server;
test.beforeAll(async()=>{test.setTimeout(360000);server=await start({port:5919,includeAdminSupport:true,includeSyntheticMail:true});});
test.beforeEach(async()=>server.reset());test.afterAll(async()=>server?.close());
test('owner reviews inactive correspondence rules, can cancel activation, and pauses without sending mail',async({browser},info)=>{
 const actor=await server.createUser('admin'),para=await server.createUser('paralegal');
 const context=await browser.newContext();await context.addCookies([actor.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(`${server.origin}/admin-dashboard.html#ai-control-room`);
  await page.locator('#adminSystemAutomationSettings>summary').click();
  const root=page.locator('#adminCorrespondenceSettings');await expect(root.getByText('Routine support replies',{exact:true})).toBeVisible();
  await root.locator('details').filter({hasText:'Routine support replies'}).locator('summary').click();
  const form=root.locator('[data-correspondence-form="routine_reply"]');await expect(form.locator('[name="mode"]')).toHaveValue('manual');
  await form.locator('[name="dailyAttemptLimit"]').fill('3');await form.locator('[name="mode"]').selectOption('auto');await form.getByRole('button',{name:'Save message settings'}).click();
  const dialog=page.getByRole('dialog',{name:'Enable automatic messages'});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();expect(await Preference.countDocuments({actionType:'support_routine_reply'})).toBe(0);
  await form.getByRole('button',{name:'Save message settings'}).click();await dialog.getByRole('button',{name:'Enable messages',exact:true}).click();
  await expect(root).toContainText('Automatic message settings saved.');await expect(form.locator('[name="mode"]')).toBeVisible();await expect(form.locator('[name="dailyAttemptLimit"]')).toHaveValue('3');
  const stored=await Preference.findOne({actionType:'support_routine_reply'}).lean();expect(stored).toMatchObject({mode:'auto',dailyAttemptLimit:3});expect(await Audit.countDocuments({action:'support.correspondence.policy_changed'})).toBe(1);expect(server.evidence().external.mail).toHaveLength(0);
  for(const width of [1366,390]){await page.setViewportSize({width,height:900});await form.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`correspondence-settings-${width}.png`),fullPage:true});}
  await form.locator('[name="mode"]').selectOption('manual');await form.getByRole('button',{name:'Save message settings'}).click();await expect(root).toContainText('Automatic messages are off for this policy.');expect((await Preference.findById(stored._id)).mode).toBe('manual');
  const other=await browser.newContext();try{await other.addCookies([para.cookie]);expect((await other.request.get(`${server.origin}/api/admin/workspace/correspondence/policies`)).status()).toBe(403);}finally{await other.close();}
  expect(server.evidence().external.mail).toHaveLength(0);expect(errors).toEqual([]);
 }finally{await context.close();}
});


test('server policy values remain literal text and cannot create HTML controls',async({browser})=>{
 const actor=await server.createUser('admin'),context=await browser.newContext();await context.addCookies([actor.cookie]);
 const payload='\"><img data-correspondence-injected src=x>';
 await context.route('**/api/admin/workspace/correspondence/policies',async route=>{
  const response=await route.fetch(),body=await response.json();
  const policy=body.policies.find(row=>row.kind==='routine_reply');policy.dailyAttemptLimit=payload;policy.rules.timeZone=payload;
  await route.fulfill({response,json:body});
 });
 const page=await context.newPage();
 try{
  await page.goto(`${server.origin}/admin-dashboard.html#ai-control-room`);await page.locator('#adminSystemAutomationSettings>summary').click();
  const root=page.locator('#adminCorrespondenceSettings');await expect(root.getByText('Routine support replies',{exact:true})).toBeVisible();
  await root.locator('details').filter({hasText:'Routine support replies'}).locator('summary').click();
  const form=root.locator('[data-correspondence-form="routine_reply"]');await expect(form.locator('[name="dailyAttemptLimit"]')).toHaveAttribute('value',payload);
  await expect(form.locator('[name="timeZone"]')).toHaveValue(payload);await expect(page.locator('[data-correspondence-injected]')).toHaveCount(0);
  expect(server.evidence().external.mail).toHaveLength(0);
 }finally{await context.close();}
});

test('current message states stay visible together with the worker recovery threshold',async({browser},info)=>{
 const actor=await server.createUser('admin'),context=await browser.newContext();await context.addCookies([actor.cookie]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 async function openSettings(){
  const destination=`${server.origin}/admin-dashboard.html#ai-control-room`;
  if(page.url()===destination)await page.reload();else await page.goto(destination);
  const settings=page.locator('#adminSystemAutomationSettings');await expect(settings).toBeAttached();
  if(!await settings.evaluate(element=>element.open))await settings.locator(':scope>summary').click();
  await expect(page.locator('#adminCorrespondenceSettings').getByText('Routine support replies',{exact:true})).toBeVisible();
 }
 async function record(status){return Ticket.create({subject:`Synthetic ${status} correspondence`,message:'Local projection fixture',status:'resolved',automaticCorrespondence:{requestId:`state-${status}`,kind:'routine_reply',policyAction:'support_routine_reply',status,encryptedText:'synthetic unused content',sourceFingerprint:'synthetic',recipient:'synthetic@example.test',...(status==='sending'?{claimedAt:new Date(Date.now()-11*60000)}:{})}});}
 try{
  await openSettings();const status=page.locator('[data-correspondence-status]');await expect(status).toHaveText('No automatic message attempts recorded.');
  const pending=await record('pending');await openSettings();await expect(status).toContainText('1 automatic message attempt is waiting for a worker check.');await expect(status).not.toContainText('No automatic message attempts recorded.');
  const sending=await record('sending');await pending.deleteOne();await openSettings();await expect(status).toContainText('1 automatic message attempt is underway.');await expect(status).toContainText('after 10 minutes, the next worker check');
  await record('pending');for(const state of ['accepted','unknown','failed','skipped'])await record(state);
  const before=await Ticket.find().select('+automaticCorrespondence').sort({_id:1}).lean();
  for(const width of [1366,390]){
   await page.setViewportSize({width,height:900});await openSettings();
   await expect(status).toContainText('2 message attempts need delivery review.');await expect(status).toContainText('waiting for a worker check');await expect(status).toContainText('attempt is underway');await expect(status).toContainText('accepted by the mail provider. Inbox receipt is not confirmed here.');await expect(status).toContainText('currently skipped. Check the message history for earlier attempts.');
   await expect(status).not.toContainText('No automatic message attempts recorded.');await status.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`correspondence-states-${width}.png`),fullPage:true});
  }
  expect(await Ticket.find().select('+automaticCorrespondence').sort({_id:1}).lean()).toEqual(before);
  expect((await Ticket.findById(sending._id).select('+automaticCorrespondence').lean()).automaticCorrespondence.status).toBe('sending');
  expect(server.evidence().external.mail).toHaveLength(0);expect(errors).toEqual([]);
 }finally{await context.close();}
});
