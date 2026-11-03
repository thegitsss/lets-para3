const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {installSettingsProjection}=require('../paralegal-support/settings-fixtures');
const {fixture,json}=require('../paralegal-support/alignment-fixture');
const CASE='64b000000000000000055001',JOB='64b000000000000000055002';
const listing=()=>({_id:CASE,caseId:CASE,jobId:JOB,title:'Trial chronology',practiceArea:'Litigation',state:'New York',totalAmount:80000,deadlineDate:'2027-01-01',createdAt:'2026-09-07',description:'Prepare a chronology with source-page references.',tasks:[{title:'Prepare chronology',completed:false}],attorney:{firstName:'Jordan',lastName:'Lee'},applicationEligibility:{ready:true,allowed:true,blockers:[]}});
test('read and apply on one matter page; errors and navigation preserve the letter',async({page},info)=>{
 const state=await fixture(page,{recommendations:{hasMatchingProfile:true,items:[listing()]}});let fail=true,writes=[];
 await page.route(`**/api/jobs/${JOB}/apply`,async route=>{writes.push(route.request().postDataJSON());if(fail)return json(route,{error:'Application unavailable'},503);state.recommendations.items[0].appliedAt='2026-09-08';return json(route,{success:true});});
 await page.goto('/paralegal-v2.html#/browse?matterId='+CASE);
 await page.evaluate(async()=>{await window.LPC_PORTAL_BOOT?.finished;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 const form=page.getByRole('region',{name:'Apply',exact:true});await expect(form).toBeVisible();await expect(page.getByRole('button',{name:'Apply',exact:true})).toHaveCount(0);
 const letter=form.getByRole('textbox',{name:'Cover letter',exact:true});await letter.fill('I can prepare the chronology and source references.');expect(writes).toEqual([]);
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(width=>{document.documentElement.classList.toggle('theme-dark',width===390);document.documentElement.style.fontSize=width===320?'125%':'100%';},width);await form.getByRole('button',{name:'Submit application',exact:true}).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`application-${width}.png`),fullPage:true});}
 await form.getByRole('button',{name:'Submit application',exact:true}).click();await expect(form).toContainText('Application unavailable');await expect(letter).toHaveValue('I can prepare the chronology and source references.');
 await page.getByRole('link',{name:'Back to Browse Matters',exact:true}).click();await page.getByRole('link',{name:'Trial chronology',exact:true}).click();await expect(form.getByRole('textbox',{name:'Cover letter',exact:true})).toHaveValue('I can prepare the chronology and source references.');
 fail=false;await form.getByRole('button',{name:'Submit application',exact:true}).click();await expect.poll(()=>writes.length).toBe(2);expect(writes[1].coverLetter).toBe('I can prepare the chronology and source references.');expect(page.__homeErrors).toEqual([]);
});
for(const ready of [true,false])test(`Stripe return continues to matters only after verified payout readiness ${ready}`,async({page})=>{
 await fixture(page,{stripe:{readiness:{ready,evidenceState:'verified'}}});await installSettingsProjection(page);await page.route('**/api/payments/connect/status',r=>json(r,{readiness:{ready,evidenceState:'verified'}}));
 await page.addInitScript(()=>sessionStorage.setItem('lpc:setup-next:64b000000000000000000001','stripe-return'));
 await page.goto('/paralegal-v2.html#/settings?tab=security&section=payments&onboarding=success');
 if(ready){await expect(page).toHaveURL(/#\/browse/);await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('lpc:setup-next:64b000000000000000000001'))).toBe(null);}
 else {await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();await expect(page).toHaveURL(/#\/settings/);}
});
