const path = require('node:path');
const { test, expect } = require('../support-session-fixture');
const start = require(path.resolve(__dirname,'../../../../docs/audits/completion-2026-09-09/closure/paralegal/backend-browser-server.cjs'));
test.use({ baseURL: 'http://localhost:5301', storageState: { cookies: [], origins: [] } });
let server, reporter, employer, other;
const financial = {totalAmount:40000,lockedTotalAmount:42000,partialPayoutAmount:5000,remainingAmount:35000,feeAttorneyPct:8,feeParalegalPct:18,feeAttorneyAmount:3200,feeParalegalAmount:7200,currency:'usd',paymentIntentId:'pi_synthetic_retained',fundingRequestFingerprint:'synthetic-old-pricing',disputeSettlement:{action:'release_partial',grossAmount:5000,feeAttorneyAmount:400,feeParalegalAmount:900,payoutAmount:4100,refundAmount:100}};
const financialFields = Object.keys(financial);
const money = record => Object.fromEntries(financialFields.map(key=>[key,record[key]]));
test.beforeAll(async()=>{test.setTimeout(240000);server=await start({port:5301,frontendRoot:process.env.LPC_PARA_CLOSURE_FRONTEND_ROOT});});
test.afterAll(async()=>{await server?.close();});
test.beforeEach(async({context})=>{
 reporter=await server.createUser({resumeURL:'paralegal/resumes/synthetic-retained.pdf'});
 employer=await server.createUser({role:'attorney'});other=await server.createUser();
 await context.addCookies([reporter.cookie]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));
});
async function open(page,role='paralegal'){
 await page.goto(`/${role}-v2.html#/settings?${role==='paralegal'?'section':'tab'}=closure`);
 await expect(page.locator(role==='paralegal'?'body':'html')).toHaveAttribute(role==='paralegal'?'data-v2-session':'data-attorney-state','ready');
 await expect(page.locator('[data-closure-review]')).toHaveAttribute('aria-busy','false');
}
async function confirm(page){await page.getByRole('button',{name:'Deactivate account',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Deactivate account',exact:true}).click();}
const receipts = id => server.receipts().filter(item=>item.ownerId===id);
const seed = options => server.seedParticipation({employerId:employer.id,reporterId:reporter.id,otherId:other.id,financial,...options});
function capture(page){const writes=[];page.on('request',request=>{if(request.method()==='DELETE'&&new URL(request.url()).pathname==='/api/account/deactivate')writes.push(request.postDataJSON());});return writes;}
async function deactivated(page,id,writes){
 await expect(page).toHaveURL(/\/account-closure.html$/);await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();
 expect(await server.inspectUser(id)).toMatchObject({disabled:true,deleted:true,status:'denied',authVersion:1});
 expect((await server.sessions(id)).every(row=>row.revokedAt)).toBe(true);expect(await server.audits(id)).toHaveLength(1);expect(receipts(id)).toHaveLength(1);
 expect(writes.at(-1)).toMatchObject({expectedOwnerId:id});expect(writes.at(-1).expectedClosureRevision).toMatch(/^[a-f0-9]{64}$/);expect(typeof writes.at(-1).resultProof).toBe('string');
 expect(await page.evaluate(()=>sessionStorage.getItem('lpc_account_closure_result'))).toBeNull();
}

test('Paralegal closure ends submitted accepted selected and orphan-posting participation without changing employer money or other applicants',async({page},info)=>{
 const fixtures=[];for(const options of [{status:'submitted'},{status:'accepted',selected:true},{status:'accepted',missingJob:true}]){const f=await seed(options);fixtures.push({...f,missingJob:Boolean(options.missingJob),before:await server.inspectCase(f.caseId)});}
 const writes=capture(page);await open(page);await expect(page.locator('#v2-settings-closure')).toContainText('Your open applications and invitations end');await confirm(page);await deactivated(page,reporter.id,writes);expect(writes).toHaveLength(1);
 for(const f of fixtures){const record=await server.inspectCase(f.caseId);expect(money(record)).toEqual(money(f.before));expect(record).toMatchObject({status:'open',archived:false,attorneyId:expect.anything()});expect(String(record.attorneyId)).toBe(employer.id);expect(record.paralegalId).toBeFalsy();expect(record.pendingParalegalId).toBeFalsy();expect(record.applicants[0].status).toBe('rejected');expect(record.applicants[1].status).toBe('pending');expect(record.invites[0].status).toBe('expired');expect(await server.inspectApplication(f.applicationId)).toMatchObject({status:'rejected',coverLetter:'Retain the submitted explanation.',resumeURL:'paralegal/resumes/synthetic-retained.pdf'});expect((await server.inspectApplication(f.otherApplicationId)).status).toBe('submitted');if(f.missingJob)expect(await server.inspectJob(f.jobId)).toBeNull();else expect(await server.inspectJob(f.jobId)).toMatchObject({status:'open',applicantsCount:1});}
 expect((await server.inspectUser(employer.id)).disabled).toBe(false);expect((await server.inspectUser(other.id)).disabled).toBe(false);
 await info.attach('retained-participation.json',{body:JSON.stringify(await Promise.all(fixtures.map(async f=>({caseId:f.caseId,money:money(await server.inspectCase(f.caseId)),missingJob:f.missingJob}))),null,2),contentType:'application/json'});
});
test('Paralegal current Matter and payout blockers refresh to an eligible settled record while retained references and money survive',async({page})=>{
 const record=await server.createCase(employer.id,{...financial,paralegal:reporter.id,paralegalId:reporter.id,status:'in progress',escrowStatus:'funded'});const writes=capture(page);await open(page);
 await expect(page.locator('[data-closure-blocker="active_matters"]')).toBeVisible();await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toHaveCount(0);expect(writes).toHaveLength(0);
 await server.updateCase(record._id,{status:'completed',completedAt:new Date(),paymentReleased:true,paidOutAt:null,fundingRequestKey:'retained-settled-funding'});await page.getByRole('button',{name:'Refresh closure review',exact:true}).click();await expect(page.locator('[data-closure-blocker="pending_payouts"]')).toBeVisible();expect(writes).toHaveLength(0);
 await server.updateCase(record._id,{paidOutAt:new Date()});const before=await server.inspectCase(record._id);await page.getByRole('button',{name:'Refresh closure review',exact:true}).click();await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeEnabled();await confirm(page);await deactivated(page,reporter.id,writes);
 const after=await server.inspectCase(record._id);expect(money(after)).toEqual(money(before));expect(after).toMatchObject({status:'completed',paymentReleased:true,fundingRequestKey:'retained-settled-funding'});expect(after.paidOutAt).toEqual(before.paidOutAt);
});
test('Paralegal stale review rejects without deactivation and requires a fresh explicit confirmation',async({page})=>{
 const writes=capture(page);await open(page);await page.getByRole('button',{name:'Deactivate account',exact:true}).click();const f=await seed({status:'submitted'});await page.getByRole('dialog').getByRole('button',{name:'Deactivate account',exact:true}).click();
 await expect(page.getByText('Account closure changed. Review the current information before continuing.',{exact:true})).toBeVisible();expect(writes).toHaveLength(1);expect(receipts(reporter.id)).toHaveLength(0);expect((await server.inspectUser(reporter.id)).disabled).toBe(false);expect((await server.inspectApplication(f.applicationId)).status).toBe('submitted');
 await confirm(page);await deactivated(page,reporter.id,writes);expect(writes).toHaveLength(2);expect(writes[0].expectedClosureRevision).not.toBe(writes[1].expectedClosureRevision);expect((await server.inspectApplication(f.applicationId)).status).toBe('rejected');
});
test('an unrelated Paralegal dispute neither blocks closure nor changes that Matter',async({page})=>{
 const record=await server.createCase(employer.id,{...financial,paralegal:other.id,paralegalId:other.id,status:'disputed',escrowStatus:'funded'});const before=await server.inspectCase(record._id),writes=capture(page);await open(page);await confirm(page);await deactivated(page,reporter.id,writes);expect(await server.inspectCase(record._id)).toEqual(before);expect((await server.inspectUser(other.id)).disabled).toBe(false);
});
test('Attorney shared closure adapter retains all money while closing its unfunded posting and handing off the bounded result',async({page,context})=>{
 const f=await seed({status:'accepted',selected:true}),before=await server.inspectCase(f.caseId),writes=capture(page);await context.addCookies([employer.cookie]);await open(page,'attorney');await confirm(page);await deactivated(page,employer.id,writes);expect(writes).toHaveLength(1);
 const after=await server.inspectCase(f.caseId);expect(money(after)).toEqual(money(before));expect(after).toMatchObject({status:'closed',archived:true,paymentStatus:'cancelled'});expect(after.applicants[0].status).toBe('rejected');expect(after.invites[0].status).toBe('expired');expect((await server.inspectJob(f.jobId)).status).toBe('closed');expect((await server.inspectApplication(f.applicationId)).status).toBe('accepted');expect((await server.inspectUser(reporter.id)).disabled).toBe(false);
});

if(process.env.LPC_PARA_CLOSURE_CHARACTERIZE==='1')test('legacy baseline sends an unguarded closure and cannot produce the bounded result handoff',async({page},info)=>{
 const writes=capture(page);await page.goto('/paralegal-v2.html#/settings?section=closure');await expect(page.locator('body')).toHaveAttribute('data-v2-session','ready');
 await confirm(page);await expect.poll(()=>writes.length).toBe(1);await expect.poll(async()=>(await server.inspectUser(reporter.id)).disabled).toBe(true);
 await info.attach('legacy-closure-request.json',{body:JSON.stringify({write:writes[0],disabled:(await server.inspectUser(reporter.id)).disabled,url:page.url()},null,2),contentType:'application/json'});
 expect(writes[0]).toMatchObject({expectedOwnerId:reporter.id});
});
