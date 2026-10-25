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
 await page.goto('/paralegal-v2.html#/profile/me');const d=page.getByRole('dialog');await expect(d).toContainText('Your résumé has a head start.');expect(extractions).toBe(0);
 await d.getByRole('button',{name:'Autofill from my résumé',exact:true}).click();await expect(d).toContainText('A head start. Your final say.');const before=structuredClone(state.user);
 await d.getByRole('button',{name:'Apply selected changes'}).click();await expect(d).toHaveCount(0);
 await expect(page.locator('[data-v2-profile-preview]')).toContainText('Example Legal');await expect(page.locator('[data-v2-profile-preview]')).toContainText('Example College');
 expect(state.user.resumeURL).toBe(before.resumeURL);expect(state.user.email).toBe(before.email);expect(state.user.yearsExperience).toBe(before.yearsExperience);expect(state.user.bio).toBe(before.bio);expect(extractions).toBe(1);
 await page.reload();await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();await expect(d).toHaveCount(0);await page.getByRole('button',{name:'Fill from résumé',exact:true}).click();await expect(d).toBeVisible();await page.keyboard.press('Escape');
});
