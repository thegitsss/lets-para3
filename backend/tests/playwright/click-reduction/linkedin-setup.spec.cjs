const {test}=require('../assistant-completion/shell-fixture'),{expect}=require('playwright/test');
const {installSettingsProjection,json}=require('../paralegal-support/settings-fixtures');
const resume=require('../../fixtures/resume-import/synthetic.cjs'),{extractFile,DISCLOSURE}=require('../../../services/resumeImport');const path=require('node:path');
async function setup(page,enabled=true){
 const model=await installSettingsProjection(page,{user:{bio:'',about:'',experience:[],education:[],skills:[],practiceAreas:[],specialties:[],languages:[],profileImage:'',avatarURL:'',profilePhotoStatus:'unsubmitted'}});let extractions=0;
 const parsed=await extractFile({buffer:resume.pdf(),mimetype:'application/pdf',originalname:'resume.pdf'});
 await page.route('**/api/uploads/linkedin-photo/config',r=>json(r,{enabled}));
 await page.route('**/api/users/me/resume-import',r=>{if(r.request().method()==='GET')return json(r,{enabled:true,disclosure:DISCLOSURE});extractions++;return json(r,parsed);});
 await page.goto('/paralegal-v2.html#/settings?tab=profile');await expect(page.getByRole('button',{name:'Fill from résumé',exact:true})).toBeVisible();await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();
 await page.evaluate(async()=>{
  const {createSetupController}=await import('/assets/scripts/paralegal-v2/setup-controller.mjs');let user=await(await fetch('/api/users/me')).json();
  const request=async(p,o)=>{const r=await fetch(p,o);if(!r.ok)throw Error('Unavailable');return r.json();};
  window.shortSetup=createSetupController({api:{get:request,request},getIdentity:()=>user,updateIdentity:value=>{user=value;},navigate:p=>{location.hash=p;},showToast:()=>{}});window.shortSetup.showWelcome();
 });
 const dialog=page.locator('dialog.ri-setup-dialog[open]');await expect(dialog).toBeVisible();expect(extractions).toBe(0);await dialog.getByRole('button',{name:'Autofill from my résumé',exact:true}).click();await expect(dialog).toContainText('Review profile details');expect(extractions).toBe(1);
 return {model,dialog,extractions:()=>extractions};
}
test('LinkedIn photo import is directly available during résumé review and requires explicit photo submission',async({page,context})=>{
 const {model,dialog}=await setup(page);let starts=0,uploads=0,authorized=false;
 const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=600;const x=c.getContext('2d');x.fillStyle='#6683a0';x.fillRect(0,0,600,600);return c.toDataURL('image/jpeg').split(',')[1];});
 await context.route('https://www.linkedin.com/oauth/v2/authorization**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><h1>Simulated LinkedIn consent</h1><button>Authorize</button>'}));
 await page.route('**/api/uploads/linkedin-photo/start',r=>{starts++;return json(r,{authorizationUrl:'https://www.linkedin.com/oauth/v2/authorization?client_id=synthetic',requestId:'c'.repeat(64)});});
 await page.route('**/api/uploads/linkedin-photo/result?*',r=>json(r,authorized?{status:'ready',contentType:'image/jpeg',photo:jpeg}:{status:'pending'}));
 await page.route('**/api/uploads/profile-photo',r=>{uploads++;model.user={...model.user,profilePhotoRevision:'b'.repeat(64),profilePhotoStatus:'pending_review',pendingProfileImage:'/assets/avatar-placeholder.svg'};return json(r,{status:'pending_review',profilePhotoRevision:model.user.profilePhotoRevision});});
 const direct=dialog.getByRole('button',{name:'Use LinkedIn photo',exact:true});await expect(direct).toBeVisible();
 const out=path.resolve(process.env.LPC_ONBOARDING_REVIEW_DIR || path.join(__dirname,'../../../../outputs/onboarding-click-goal-20261102'));
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await direct.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`paralegal-linkedin-${width}.png`),fullPage:true});const bounds=await direct.boundingBox(),heading=await dialog.locator('.profile-photo-section h3').boundingBox();expect(bounds.height).toBeGreaterThanOrEqual(44);expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.y).toBeGreaterThanOrEqual(heading.y+heading.height);expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);}
 await page.evaluate(()=>{document.documentElement.classList.remove('theme-light');document.documentElement.classList.add('theme-dark');document.documentElement.style.fontSize='125%';});await direct.focus();await direct.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'paralegal-linkedin-dark-large-320.png'),fullPage:true});await expect(direct).toBeFocused();
 const waiting=context.waitForEvent('page');await page.keyboard.press('Enter');const popup=await waiting;await popup.getByRole('button',{name:'Authorize',exact:true}).click();authorized=true;
 const photo=page.getByRole('dialog',{name:'Edit profile photo',exact:true});await expect(photo).toBeVisible();expect(starts).toBe(1);expect(uploads).toBe(0);expect(model.profilePatches).toEqual([]);
 await photo.getByRole('button',{name:'Submit photo for approval',exact:true}).click();await expect(photo).toBeHidden();expect(uploads).toBe(1);await expect(dialog).toContainText('Review profile details');await expect(direct).toBeHidden();await expect(dialog.getByRole('button',{name:'Add or edit profile photo',exact:true})).toBeFocused();expect(model.profilePatches).toEqual([]);
});
test('an unavailable LinkedIn connection retains the existing upload path',async({page})=>{
 const {dialog,model}=await setup(page,false);await expect(dialog.getByRole('button',{name:'Use LinkedIn photo',exact:true})).toBeHidden();await expect(dialog.getByRole('button',{name:'Add or edit profile photo',exact:true})).toBeVisible();expect(model.profilePatches).toEqual([]);
});
test('LinkedIn import can be cancelled without losing résumé suggestions or saving a photo',async({page,context})=>{
 const {dialog,model,extractions}=await setup(page);let uploads=0;
 await context.route('https://www.linkedin.com/oauth/v2/authorization**',r=>r.fulfill({contentType:'text/html',body:'<h1>Simulated LinkedIn consent</h1>'}));
 await page.route('**/api/uploads/linkedin-photo/start',r=>json(r,{authorizationUrl:'https://www.linkedin.com/oauth/v2/authorization?client_id=synthetic',requestId:'d'.repeat(64)}));
 await page.route('**/api/uploads/linkedin-photo/result?*',r=>json(r,{status:'pending'}));await page.route('**/api/uploads/profile-photo',r=>{uploads++;return json(r,{});});
 await dialog.getByRole('button',{name:'Use LinkedIn photo',exact:true}).click();await dialog.getByRole('button',{name:'Cancel LinkedIn import',exact:true}).click();await expect(dialog.getByRole('button',{name:'Use LinkedIn photo',exact:true})).toBeVisible();expect(uploads).toBe(0);expect(extractions()).toBe(1);expect(model.profilePatches).toEqual([]);await expect(dialog).toContainText('Review profile details');
});
