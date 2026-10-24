const {test,expect}=require('playwright/test');
const start=require('../../helpers/financialLifecycleBrowserServer');
const mongoose=require('mongoose');
let server;
test.beforeAll(async()=>{test.setTimeout(360000);server=await start({port:5917,includeAdminSupport:true});});
test.beforeEach(async()=>server.reset());test.afterAll(async()=>server?.close());
test('justified dispute evidence opens through protected reads and stays usable on desktop and phone',async({browser},info)=>{
 const actor=await server.createUser('admin'),owner=await server.createUser('attorney'),para=await server.createUser('paralegal');
 const Case=require('../../../models/Case'),File=require('../../../models/CaseFile'),Message=require('../../../models/Message'),Audit=require('../../../models/AuditLog');
 const disputeId=new mongoose.Types.ObjectId().toString();
 const matter=await Case.create({title:'Synthetic evidence review',details:'Synthetic only',attorney:owner.id,paralegal:para.id,status:'disputed',pausedReason:'dispute',escrowStatus:'funded',escrowIntentId:'pi_synthetic_evidence',totalAmount:40000,hiredAt:new Date(Date.now()-60000),disputes:[{disputeId,message:'Work-quality review requested',raisedBy:owner.id,status:'open'}]});
 await File.create({caseId:matter._id,userId:para.id,originalName:'Synthetic confidential submission.pdf',storageKey:`cases/${matter._id}/documents/scan-required-synthetic.pdf`,mimeType:'application/pdf'});
 await Message.create({caseId:matter._id,senderId:owner.id,senderRole:'attorney',text:'SYNTHETIC_REVIEW_MESSAGE_BODY'});
 const context=await browser.newContext();await context.addCookies([actor.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(`${server.origin}/admin-dashboard.html?review=${disputeId}&reviewMatter=${matter._id}#finance`);
  const detail=page.locator('.admin-dispute-detail:not([hidden])');await expect(detail).toHaveAttribute('data-case-id',String(matter._id));
  const evidence=detail.locator('.admin-dispute-record');await evidence.locator('summary').click();
  await expect(evidence.getByRole('link',{name:'Download evidence',exact:true})).toHaveCount(0);
  await evidence.getByRole('button',{name:'Review documents',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Review dispute evidence'});await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();expect(await Audit.countDocuments({action:'dispute.evidence.read'})).toBe(0);
  await evidence.getByRole('button',{name:'Review documents',exact:true}).click();await dialog.getByLabel('Reason for access').fill('Review the submitted work to resolve the current quality dispute.');await dialog.getByRole('button',{name:'Review evidence',exact:true}).click();
  await expect(evidence).toContainText('Synthetic confidential submission.pdf');expect(await Audit.countDocuments({action:'dispute.evidence.read'})).toBe(1);
  for(const width of [1366,390]){await page.setViewportSize({width,height:900});await evidence.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`evidence-files-${width}.png`),fullPage:true});}
  await evidence.getByRole('button',{name:'Review messages',exact:true}).click();await dialog.getByLabel('Reason for access').fill('Review correspondence relevant to the current work-quality dispute.');await dialog.getByRole('button',{name:'Review evidence',exact:true}).click();await expect(evidence).toContainText('SYNTHETIC_REVIEW_MESSAGE_BODY');
  expect(await Audit.countDocuments({action:'dispute.evidence.read'})).toBe(2);await page.screenshot({path:info.outputPath('evidence-messages-390.png'),fullPage:true});
  await evidence.locator('summary').click();await expect(evidence.locator('[data-evidence-result]')).toBeEmpty();expect(errors).toEqual([]);
  const csrf=await(await context.request.get(server.origin+'/api/csrf')).json();await Case.updateOne({_id:matter._id},{$set:{'disputes.0.status':'resolved'}});
  const response=await context.request.post(`${server.origin}/api/disputes/${matter._id}/${disputeId}/evidence`,{headers:{'X-CSRF-Token':csrf.csrfToken},data:{action:'messages',reason:'Attempt a read after the current dispute has been resolved.'}});expect(response.status()).toBe(409);
 }finally{await context.close();}
});
