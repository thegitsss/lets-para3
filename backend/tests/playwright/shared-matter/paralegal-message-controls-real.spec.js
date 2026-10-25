'use strict';
const {test,expect,snapshot}=require('../shared-strict-observation.cjs');
const start=require('../../helpers/financialLifecycleBrowserServer');
const fs=require('node:fs/promises');
let server;
test.beforeAll(async()=>{test.setTimeout(240000);server=await start({port:0});});
test.beforeEach(async()=>server.reset());
test.afterAll(async()=>server?.close());
async function api(person,method,url,data){const csrf=await(await person.context.request.get(server.origin+'/api/csrf')).json();const response=await person.context.request[method](server.origin+url,{headers:{'X-CSRF-Token':csrf.csrfToken},...(data?{data}:{})});expect(response.ok(),`${method} ${url}: ${response.status()} ${await response.text()}`).toBe(true);return response.json();}
async function actor(browser,role){const person=await server.createUser(role,{},true),context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(30000);await context.addCookies([person.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));return {...person,role,context,page:await context.newPage()};}
const row=(person,id)=>person.page.locator(`[data-message-id="${id}"]`);
async function action(person,id,label){const selected=row(person,id);await selected.hover();await selected.locator('summary').click();await selected.getByRole('button',{name:label,exact:true}).click();}
const moneyNames=['Case','Payout','PaymentOperation','PlatformIncome','MatterWithdrawalNotification','MatterPaymentNotification'];
const finance=snap=>Object.fromEntries(moneyNames.map(name=>[name,snap[name]||[]]));
test('Paralegal native pin retry and unpin plus add and remove reaction converge on the same saved message without changing other work or money',async({browser},info)=>{
 const record={checkpoints:[],providerBoundary:'Actual local application and database; synthetic funding only; no provider/storage/email writes.'};let people,id,messageId;
 try{
  people={attorney:await actor(browser,'attorney'),paralegal:await actor(browser,'paralegal')};
  const posted=await api(people.attorney,'post','/api/cases',{title:'Finite Paralegal message control review',practiceArea:'immigration',state:'CA',totalAmount:400,experience:'5+ years',deadline:'2027-03-14',description:'Synthetic shared conversation action verification.',tasks:[{title:'Keep the exact evidence index'}]});
  id=String(posted.case?._id||posted._id||posted.id);
  await api(people.paralegal,'post',`/api/jobs/${posted.jobId}/apply`,{coverLetter:'I can maintain the evidence index.'});
  await api(people.attorney,'post','/api/payments/payment-method/default',{paymentMethodId:'pm_browser_card'});
  const review=await api(people.attorney,'get',`/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
  await api(people.attorney,'post',`/api/cases/${id}/hire/${people.paralegal.id}`,{expectedOwnerId:people.attorney.id,reviewedRevision:review.revision});
  // A second actual saved message is the nonselected-record conservation control.
  const other=await api(people.attorney,'post',`/api/messages/${id}`,{text:'Other record remains unchanged.',clientMessageId:'other-message-control-20261014',expectedOwnerId:people.attorney.id});
  record.otherMessageId=String(other.message._id);
  for(const person of Object.values(people)){await person.page.goto(`${server.origin}/${person.role}-v2.html#/conversations?matter=${id}`);await expect(person.page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state','ready');await person.page.evaluate(()=>window.messageControlDocumentIdentity=crypto.randomUUID());}
  record.documentIdentities=await Promise.all(Object.values(people).map(async person=>({role:person.role,value:await person.page.evaluate(()=>window.messageControlDocumentIdentity)})));
  const para=people.paralegal,attorney=people.attorney,Message=require('../../../models/Message');
  const sent=para.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/messages/${id}`);
  await para.page.getByRole('textbox',{name:'Write a message',exact:true}).fill('Selected Paralegal-owned evidence message.');
  await para.page.getByRole('button',{name:'Send message',exact:true}).click();
  const sentResponse=await sent;expect(sentResponse.status()).toBe(201);messageId=String((await sentResponse.json()).message._id);record.messageId=messageId;
  for(const person of Object.values(people))await expect(row(person,messageId).locator('.av2-preserve-lines')).toHaveText('Selected Paralegal-owned evidence message.',{timeout:5000});
  // The Attorney's preexisting reaction is an actual API setup action, not a DTO projection.
  await api(attorney,'post',`/api/messages/${id}/${messageId}/react`,{emoji:'👍'});
  for(const person of Object.values(people))await expect(row(person,messageId).locator('.av2-message-reactions button')).toHaveText('👍 1',{timeout:5000});
  await expect(row(para,messageId).getByRole('button',{name:'Add 👍 reaction',exact:true})).toHaveAttribute('aria-pressed','false');
  const before=await snapshot();record.beforeActions=before;
  const selectedBefore=await Message.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(messageId)}),otherBefore=await Message.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(record.otherMessageId)});
  const failedPath=`/api/messages/${id}/${messageId}`;let withheld=0;
  const failPin=async route=>{const request=route.request();if(request.method()==='PATCH'&&request.postDataJSON()?.pin===true){withheld++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary message action unavailable. Try again.'})});}else await route.continue();};
  await para.page.route(server.origin+failedPath,failPin);
  await action(para,messageId,'Pin message');
  await expect(para.page.locator('[data-v2-message-status]')).toContainText('Temporary message action unavailable. Try again.');
  expect(withheld).toBe(1);expect(await Message.collection.findOne({_id:selectedBefore._id})).toEqual(selectedBefore);
  await expect(row(para,messageId).getByText('Pinned',{exact:true})).toHaveCount(0);
  await para.page.unroute(server.origin+failedPath,failPin);
  record.checkpoints.push({branch:'failed native Pin is visible and does not commit',withheldRequests:withheld});
  // Retry uses the same visible Pin action; this interface has no separate Retry button.
  await action(para,messageId,'Pin message');
  await expect.poll(async()=>(await Message.collection.findOne({_id:selectedBefore._id})).pinned).toBe(true);
  for(const person of Object.values(people))await expect(row(person,messageId).getByText(person.role==='attorney'?'Pinned message':'Pinned',{exact:true})).toBeVisible({timeout:5000});
  record.checkpoints.push({branch:'explicit native Pin retry',saved:await Message.collection.findOne({_id:selectedBefore._id})});
  await action(para,messageId,'Unpin message');
  await expect.poll(async()=>(await Message.collection.findOne({_id:selectedBefore._id})).pinned).toBe(false);
  for(const person of Object.values(people))await expect(row(person,messageId).getByText(person.role==='attorney'?'Pinned message':'Pinned',{exact:true})).toHaveCount(0,{timeout:5000});
  record.checkpoints.push({branch:'native Unpin',saved:await Message.collection.findOne({_id:selectedBefore._id})});
  await action(para,messageId,'React 👍');
  await expect.poll(async()=>((await Message.collection.findOne({_id:selectedBefore._id})).reactions['👍']||[]).map(String).sort()).toEqual([attorney.id,para.id].sort());
  for(const person of Object.values(people))await expect(row(person,messageId).locator('.av2-message-reactions button')).toHaveText('👍 2',{timeout:5000});
  await expect(row(para,messageId).getByRole('button',{name:'Remove 👍 reaction',exact:true})).toHaveAttribute('aria-pressed','true');
  record.checkpoints.push({branch:'native add own reaction retains Attorney reaction',saved:await Message.collection.findOne({_id:selectedBefore._id})});
  await row(para,messageId).getByRole('button',{name:'Remove 👍 reaction',exact:true}).click();
  await expect.poll(async()=>((await Message.collection.findOne({_id:selectedBefore._id})).reactions['👍']||[]).map(String)).toEqual([attorney.id]);
  for(const person of Object.values(people))await expect(row(person,messageId).locator('.av2-message-reactions button')).toHaveText('👍 1',{timeout:5000});
  await expect(row(para,messageId).getByRole('button',{name:'Add 👍 reaction',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(row(attorney,messageId).locator('.av2-message-reactions button')).toHaveAttribute('aria-pressed','true');
  record.checkpoints.push({branch:'native remove own reaction retains Attorney reaction',saved:await Message.collection.findOne({_id:selectedBefore._id})});
  expect(await Message.collection.findOne({_id:otherBefore._id})).toEqual(otherBefore);
  expect(await Message.countDocuments({caseId:id})).toBe(2);
  const final=await snapshot();record.afterActions=final;expect(finance(final)).toEqual(finance(before));
  for(const person of Object.values(people)){expect(await person.page.evaluate(()=>window.messageControlDocumentIdentity)).toBe(record.documentIdentities.find(x=>x.role===person.role).value);await expect(row(person,record.otherMessageId).locator('.av2-preserve-lines')).toHaveText('Other record remains unchanged.');await person.page.screenshot({path:info.outputPath(`${person.role}-message-controls.png`),fullPage:true});}
  const targetRequests=server.evidence().requests.filter(r=>r.path===failedPath||r.path===failedPath+'/react');record.targetRequests=targetRequests;
  expect(targetRequests.filter(r=>r.method==='PATCH'&&r.status===200)).toHaveLength(2);
  expect(targetRequests.filter(r=>r.method==='POST'&&r.status===201)).toHaveLength(2);
  expect(targetRequests.filter(r=>r.method==='DELETE'&&r.status===200)).toHaveLength(1);
  record.exactMessageCount=2;record.noReload=true;record.moneyConserved=true;
 }finally{record.caseId=id;record.messageId=messageId;record.server=server.evidence();record.final=await snapshot();await fs.writeFile(info.outputPath('paralegal-message-controls-actual.json'),JSON.stringify(record,null,2));await info.attach('paralegal-message-controls-actual.json',{path:info.outputPath('paralegal-message-controls-actual.json'),contentType:'application/json'});}
});
