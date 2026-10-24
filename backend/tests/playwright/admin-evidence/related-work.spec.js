const {test,expect}=require('playwright/test');
const mongoose=require('mongoose');
const start=require('../../helpers/financialLifecycleBrowserServer');
const Incident=require('../../../models/Incident'),Approval=require('../../../models/IncidentApproval'),Ticket=require('../../../models/SupportTicket');
let server;
test.beforeAll(async()=>{test.setTimeout(360000);server=await start({port:0,includeAdminSupport:true,includeAdminWorkspaces:true});});
test.beforeEach(async()=>server.reset());test.afterAll(async()=>server?.close());

test('one technical review retains exact report navigation on desktop and mobile without making any decision',async({browser},info)=>{
 const actor=await server.createUser('admin'),problem=await Incident.create({publicId:`synthetic-browser-${new mongoose.Types.ObjectId()}`,source:'admin_created',summary:'Synthetic linked issue',originalReportText:'Local technical fixture',state:'awaiting_founder_approval'});
 const reports=await Ticket.create(['First related report','Second related report'].map(subject=>({subject,message:'Local fixture',requestKind:'support',routingSuggestion:{ownerKey:'incident_watch'},linkedIncidentIds:[problem._id],riskFlags:['active_incident'],createdAt:new Date('2020-01-01'),updatedAt:new Date('2020-01-01')})));
 const approval=await Approval.create({incidentId:problem._id,attemptNumber:1,approvalType:'production_deploy',requiredByPolicy:true,requestedAt:new Date()});
 const context=await browser.newContext();await context.addCookies([actor.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const before=await Ticket.find().sort({_id:1}).lean();
 try{
  for(const width of [1366,390]){
   await page.setViewportSize({width,height:900});await page.goto(`${server.origin}/admin-dashboard.html?view=queue#overview`);
   await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy','false');await expect(page.locator('[data-flow-select]')).toHaveCount(1);
   if(width<=760){await page.locator('[data-flow-select][aria-pressed="true"]').click();await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy','false');}
   const body=page.locator('#adminFlowBody');await expect(body).toContainText('2 related support reports are included in this technical review.');
   await expect(body.getByRole('button',{name:'First related report',exact:true})).toBeVisible();await expect(body.getByRole('button',{name:'Second related report',exact:true})).toBeVisible();
   await body.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`related-review-${width}.png`),fullPage:true});
   await body.getByRole('button',{name:'Second related report',exact:true}).click();
   await expect(page.locator('#adminInboxDetail')).toContainText('Second related report');await expect(page.locator('#adminInboxDetail')).toBeVisible();
   expect(new URL(page.url()).hash).toBe('#support-ops');expect(new URL(page.url()).searchParams.get('ticket')).toBe(String(reports[1]._id));
   await page.screenshot({path:info.outputPath(`related-report-${width}.png`),fullPage:true});
   const response=await context.request.get(`${server.origin}/api/admin/workspace/flow?current=inquiry:${reports[1]._id}`),queue=await response.json();
   expect(response.status()).toBe(200);expect(queue.remaining).toBe(1);expect(queue.currentPending).toBe(true);expect(queue.task.key).toBe(`incident:${approval._id}`);
  }
  expect(await Ticket.find().sort({_id:1}).lean()).toEqual(before);expect((await Approval.findById(approval._id)).status).toBe('pending');expect((await Incident.findById(problem._id)).state).toBe('awaiting_founder_approval');
  expect(server.evidence().requests.filter(row=>['POST','PUT','PATCH','DELETE'].includes(row.method)&&/^\/api\/admin\/(engineering|support)/.test(row.path))).toEqual([]);expect(server.evidence().external.mail).toHaveLength(0);expect(errors).toEqual([]);
 }finally{await context.close();}
});
