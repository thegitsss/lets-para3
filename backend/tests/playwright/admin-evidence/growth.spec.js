const {test,expect}=require('playwright/test');
const start=require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async()=>{test.setTimeout(360000);server=await start({port:5921,includeAdminSupport:true,includeAdminAutomation:true,includeAdminWorkspaces:true,includeDirectors:true});});
test.beforeEach(async()=>server.reset());test.afterAll(async()=>server?.close());
test('one weekly review preserves canonical approval navigation and handles director failures on desktop and phone',async({browser},info)=>{
 const admin=await server.createUser('admin'),Packet=require('../../../models/MarketingDraftPacket');
 const brief=await require('../../../models/MarketingBrief').create({title:'Synthetic weekly brief',workflowType:'linkedin_company_post'});
 const draft=await Packet.create({briefId:brief._id,packetVersion:1,workflowType:'linkedin_company_post',packetSummary:'Synthetic weekly brand draft',approvalState:'pending_review'});
 await require('../../../models/ApprovalTask').create({taskType:'marketing_review',targetType:'marketing_draft_packet',targetId:String(draft._id),parentType:'MarketingBrief',parentId:String(brief._id),title:'Review weekly brand draft',approvalState:'pending'});
 const orphan=await Packet.create({briefId:brief._id,packetVersion:2,workflowType:'linkedin_company_post',packetSummary:'Synthetic unregistered draft',approvalState:'pending_review'});
 const context=await browser.newContext();await context.addCookies([admin.cookie]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage();try{
  await page.goto(`${server.origin}/admin-dashboard.html#marketing-drafts`);
  await page.getByRole('combobox',{name:'Growth view',exact:true}).selectOption('weekly');
  const root=page.locator('#adminGrowthReview');await expect(root).toContainText('Synthetic weekly brand draft');await root.locator('summary').click();await expect(root).toContainText('0 directors');
  const unavailable=root.locator('article').filter({hasText:'Synthetic unregistered draft'});
  await expect(unavailable).toContainText('Approval record unavailable');await expect(unavailable.getByRole('button')).toHaveCount(0);
  await root.getByRole('button',{name:'Review draft',exact:true}).click();
  const approval=page.locator('#approvalItemDetail');
  await expect(approval).toHaveAttribute('data-approval-detail-state','loaded');
  await expect(approval).toHaveAttribute('data-approval-active-work-key',`marketing_draft_packet:${draft._id}`);
  await expect(approval.getByText('Linkedin company post',{exact:true})).toBeVisible();
  expect(await Packet.countDocuments({approvalState:'pending_review'})).toBe(2);
  // Navigate back through the supported entry; no approval or publication occurs.
  await page.goto(`${server.origin}/admin-dashboard.html#marketing-drafts`);
  await page.getByRole('combobox',{name:'Growth view',exact:true}).selectOption('weekly');
  await expect(root).toContainText('Synthetic weekly brand draft');await root.locator('summary').click();
  await context.route('**/api/admin/directors/overview?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic provider unavailable'})}));
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(root).toContainText('Director records are unavailable');await expect(root).toContainText('Synthetic weekly brand draft');
  for(const width of [1366,390]){await page.setViewportSize({width,height:900});await root.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await root.screenshot({path:info.outputPath(`growth-review-${width}.png`)});}
  expect(await Packet.countDocuments({approvalState:'pending_review'})).toBe(2);expect(server.evidence().external.mail).toHaveLength(0);
  await require('../../../models/User').updateOne({_id:admin.id},{$set:{disabled:true}});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page).toHaveURL(/\/login\.html(?:[?#]|$)/);await expect(page.locator('body')).not.toContainText('Synthetic weekly brand draft');
 }finally{await context.close();}
});
