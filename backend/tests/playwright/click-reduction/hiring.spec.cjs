const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {install}=require('../attorney-v2/home-summaries-fixture');
async function mount(page,{reason='ready',lost=false}={}){
 await install(page,undefined,['attention','applications','messages','recent']);
 await page.evaluate(async()=>{await window.LPC_PORTAL_BOOT?.finished;await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 await page.evaluate(async({reason,lost})=>{
  const {createHiring}=await import('/assets/scripts/attorney-v2/hiring.mjs');
  const {createPrivateState}=await import('/assets/scripts/attorney-v2/private-state.mjs');
  const ownerId='1'.repeat(24),caseId='3'.repeat(24),applicantId='2'.repeat(24);
  window.hireWrites=0;window.hireSaved=false;let assigned=false;
  const review=()=>({ownerId,caseId,applicantId,revision:'a'.repeat(64),caseTitle:'Medical chronology',name:'Morgan Paralegal',reason:assigned?'assigned':reason,canHire:!assigned&&reason==='ready',canResume:false,relisted:false,fundingVerified:assigned,assigned,budgetCents:40000,feeCents:8800,chargeCents:48800,remainingCents:null,currency:'usd',card:{id:'pm_synthetic',type:'card',brand:'visa',last4:'4242',exp_month:12,exp_year:2029}});
  const api={readHiringReview:async()=>review(),hireReviewedApplicant:async(_case,_app,revision)=>{
   window.hireWrites++;assigned=true;if(lost)throw Error('Response lost');
   return {hiringConfirmation:{caseId,applicantId,reviewedRevision:revision,mode:'hire_and_fund',chargeCents:48800,budgetCents:40000,remainingCents:null}};
  }};
  const hiring=createHiring(caseId,{applicantId},{api,signal:new AbortController().signal,ownerId,privateState:createPrivateState(),compact:true,autoReview:true,onSaved:()=>{window.hireSaved=true;}});
  document.querySelector('[data-av2-outlet]').replaceChildren(hiring);await hiring.readiness;
 },{reason,lost});
}
test('one explicit hire button follows applicant, card and charge disclosures',async({page},info)=>{
 await mount(page);expect(await page.evaluate(()=>window.hireWrites)).toBe(0);
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});await page.evaluate(width=>{document.documentElement.classList.toggle('theme-dark',width===390);document.documentElement.style.fontSize=width===320?'125%':'100%';},width);const commit=page.getByRole('button',{name:'Hire and charge $488.00',exact:true});await commit.scrollIntoViewIfNeeded();await commit.focus();await expect(commit).toBeFocused();
  await expect(page.locator('[data-hiring]')).toContainText('Morgan Paralegal');await expect(page.locator('[data-hiring]')).toContainText('Total card charge');
  if(width<768)expect((await commit.boundingBox()).height).toBeGreaterThanOrEqual(44);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`hire-${width}.png`),fullPage:true});
 }
 await page.getByRole('button',{name:'Hire and charge $488.00',exact:true}).click();expect(await page.evaluate(()=>window.hireWrites)).toBe(1);expect(await page.evaluate(()=>window.hireSaved)).toBe(true);
});
test('uncertain hire reconciles the assignment and never repeats the charge',async({page})=>{
 await mount(page,{lost:true});await page.getByRole('button',{name:'Hire and charge $488.00',exact:true}).click();
 await expect(page.locator('[data-hiring]')).toContainText('funding is verified');await expect(page.getByRole('button',{name:'Hire and charge $488.00',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>window.hireWrites)).toBe(1);
});
test('prerequisite blockers do not expose a hire commitment',async({page})=>{
 await mount(page,{reason:'pre_engagement_required'});await expect(page.getByRole('button',{name:/Hire and charge/})).toHaveCount(0);expect(await page.evaluate(()=>window.hireWrites)).toBe(0);
});
