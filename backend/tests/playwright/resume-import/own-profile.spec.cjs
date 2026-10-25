const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {installSettingsProjection,json}=require('../paralegal-support/settings-fixtures');
const fixture=require('../../fixtures/resume-import/synthetic.cjs');
const {extractFile,DISCLOSURE}=require('../../../services/resumeImport');
for(const width of [1280,390])test(`own Profile entry uses existing résumé and updates the approved profile view ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});const state=await installSettingsProjection(page,{showResumeIntro:true});let extractions=0;
 await page.route('**/api/users/me/resume-import',async route=>{
  if(route.request().method()==='GET')return json(route,{enabled:true,disclosure:DISCLOSURE});
  extractions++;expect(route.request().postData()).toContain('existing');expect(route.request().postData()).not.toContain('filename=');
  return json(route,await extractFile({buffer:fixture.pdf(),mimetype:'application/pdf',originalname:'synthetic.pdf'}));
 });
 await page.goto('/paralegal-v2.html#/profile/me');const d=page.getByRole('dialog');await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();await expect(d).toHaveCount(0);
 await page.getByRole('link',{name:'Edit profile',exact:true}).click();await page.getByRole('button',{name:'Fill from résumé',exact:true}).click();await expect(d).toContainText('Your résumé has a head start.');expect(extractions).toBe(0);
 await d.getByRole('button',{name:'Autofill from my résumé',exact:true}).click();await expect(d).toContainText('A head start. Your final say.');const before=structuredClone(state.user);
 await d.getByRole('button',{name:'Apply selected changes'}).click();await expect(d).toHaveCount(0);
 await page.goto('/paralegal-v2.html#/profile/me');await expect(page.locator('[data-v2-profile-preview]')).toContainText('Example Legal');await expect(page.locator('[data-v2-profile-preview]')).toContainText('Example College');
 expect(state.user.resumeURL).toBe(before.resumeURL);expect(state.user.email).toBe(before.email);expect(state.user.yearsExperience).toBe(before.yearsExperience);expect(state.user.bio).toBe(before.bio);expect(extractions).toBe(1);
 await page.reload();await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();await expect(d).toHaveCount(0);await page.getByRole('link',{name:'Edit profile',exact:true}).click();await page.getByRole('button',{name:'Fill from résumé',exact:true}).click();await expect(d).toBeVisible();await page.keyboard.press('Escape');
});

for(const width of [1280,390])for(const scenario of ['established','empty-disabled','empty-enabled'])test(`automatic résumé prompt respects saved profile and availability: ${scenario} ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const empty=scenario.startsWith('empty');
 const state=await installSettingsProjection(page,{showResumeIntro:true,...(empty?{user:{bio:'',about:'',experience:[],education:[],skills:[],practiceAreas:[],specialties:[],languages:[],linkedInURL:''}}:{})});
 const before=structuredClone(state.user);let policyReads=0,extractions=0;
 await page.route('**/api/users/me/resume-import',route=>{
  if(route.request().method()==='GET'){policyReads++;return json(route,{enabled:scenario!=='empty-disabled',disclosure:DISCLOSURE});}
  extractions++;return json(route,{error:'Unexpected extraction'},500);
 });
 await page.goto('/paralegal-v2.html#/settings?tab=profile');await page.evaluate(()=>window.LPC_PORTAL_BOOT?.finished);await expect(page.getByRole('button',{name:'Fill from résumé',exact:true})).toBeVisible();
 if(empty)await expect.poll(()=>policyReads).toBe(1);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const d=page.locator('dialog.ri-dialog[open]');
 if(scenario==='empty-enabled')await expect(d).toBeVisible();else await expect(d).toHaveCount(0);
 if(scenario==='established')expect(policyReads).toBe(0);
 expect(extractions).toBe(0);expect(state.profilePatches).toEqual([]);expect(state.user).toEqual(before);
 await page.screenshot({path:info.outputPath(`${scenario}-${width}.png`),fullPage:true});
});
