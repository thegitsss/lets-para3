const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {installSettingsProjection,json}=require('../paralegal-support/settings-fixtures');
test('first setup opens the existing importer without a welcome click or automatic extraction',async({page},info)=>{
 const state=await installSettingsProjection(page,{user:{bio:'',about:'',experience:[],education:[],skills:[],practiceAreas:[],specialties:[],languages:[]}});
 let extractions=0;await page.route('**/api/users/me/resume-import',route=>{if(route.request().method()==='GET')return json(route,{enabled:true,disclosure:'Read the résumé locally and review suggestions before saving.'});extractions++;return json(route,{error:'Synthetic extraction unavailable'},503);});
 await page.goto('/paralegal-v2.html#/settings?tab=profile');await expect(page.getByRole('button',{name:'Fill from résumé',exact:true})).toBeVisible();
 await page.evaluate(async()=>{
  await window.LPC_PORTAL_BOOT?.finished;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const {createSetupController}=await import('/assets/scripts/paralegal-v2/setup-controller.mjs');
  const user=await(await fetch('/api/users/me')).json();
  const request=async(path,options)=>{const r=await fetch(path,options);if(!r.ok)throw Error('Unavailable');return r.json();};
  window.setupProgress=[];window.setupController=createSetupController({api:{get:request,request},getIdentity:()=>user,updateIdentity:()=>{},navigate:()=>{},showToast:()=>{}});
  window.setupController.showWelcome(null,value=>window.setupProgress.push(value));
 });
 const dialog=page.locator('dialog.ri-setup-dialog[open]');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Autofill from my résumé',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Set up my account',exact:true})).toHaveCount(0);
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(width=>{document.documentElement.classList.toggle('theme-dark',width===390);document.documentElement.style.fontSize=width===320?'125%':'100%';},width);await page.screenshot({path:info.outputPath(`setup-${width}.png`),fullPage:true});}
 expect(extractions).toBe(0);expect(state.profilePatches).toEqual([]);await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);expect(extractions).toBe(0);
});
