const {test}=require('../assistant-completion/shell-fixture'),{expect}=require('playwright/test');
const {install}=require('../attorney-v2/home-summaries-fixture');const {json,OWNER}=require('../assistant-completion/fixture');
const path=require('node:path');
async function attorney(page){
 const state=await install(page,undefined,['recent']);
 await page.route('**/hero-mountain-restored.jpg',r=>r.fulfill({path:path.resolve(__dirname,'../../../../frontend/hero-mountain-restored.jpg')}));
 await page.route('**/api/auth/me',r=>json(r,{user:{id:OWNER,firstName:'Jordan',lastName:'Lee',role:'attorney',status:'approved',isFirstLogin:true,preferences:{theme:'light',fontSize:'md'}}}));
 await page.route('**/api/users/me/onboarding*',r=>json(r,{onboarding:{attorneyTourCompleted:false}}));
 await page.route('**/api/case-drafts/defaults',r=>json(r,{ownerId:OWNER,practiceArea:'',state:''}));await page.route('**/api/cases/posting/options',r=>json(r,{practiceAreas:['contract law']}));await page.route('**/api/case-drafts/resolve/**',r=>json(r,{},404));
 await page.reload();await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();await expect(page.locator('[data-attorney-tour]')).toBeVisible();return state;
}
test('existing attorney welcome offers one chosen action into the existing Matter builder',async({page})=>{
 const state=await attorney(page),tour=page.locator('[data-attorney-tour]');
 await expect(page.getByRole('dialog',{name:'New Matter',exact:true})).toBeHidden();
 await expect(tour.getByRole('button',{name:'Show me around',exact:true})).toBeVisible();
 const out=path.resolve(process.env.LPC_ONBOARDING_REVIEW_DIR || path.join(__dirname,'../../../../outputs/onboarding-click-goal-20261102'));
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(out,`attorney-welcome-${width}.png`),fullPage:true});const fits=await tour.locator('.lpc-tour-card').evaluate(e=>e.scrollWidth<=e.clientWidth+1);expect(fits).toBe(true);expect(await tour.getByRole('button',{name:'Post a Matter',exact:true}).evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');}
 await page.evaluate(()=>{document.documentElement.classList.remove('theme-light');document.documentElement.classList.add('theme-dark');document.documentElement.style.fontSize='125%';});await page.screenshot({path:path.join(out,'attorney-welcome-dark-large-320.png'),fullPage:true});await expect(tour.getByRole('button',{name:'Post a Matter',exact:true})).toBeFocused();
 await page.keyboard.press('Enter');await expect(tour).toHaveCount(0);await expect(page.getByRole('dialog',{name:'New Matter',exact:true})).toBeVisible();await expect(page.locator('#av2-compose-brief')).toBeFocused();
 expect(state.writes).toEqual([]);const progress=await page.evaluate(owner=>JSON.parse(sessionStorage.getItem('lpc_attorney_v2_onboarding:'+owner)),OWNER);expect(progress.dismissed).toBe(true);expect(progress.tourCompleted).not.toBe(true);
});
test('the attorney tour remains optional and dismissal is respected on reload',async({page})=>{
 await attorney(page);const tour=page.locator('[data-attorney-tour]');await tour.getByRole('button',{name:'Show me around',exact:true}).click();await expect(tour.getByRole('heading',{name:'Build your profile.',exact:true})).toBeVisible();
 await tour.getByRole('button',{name:'Skip tour',exact:true}).click();await expect(tour).toHaveCount(0);await page.reload();await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();await expect(page.locator('[data-av2-region=recent]')).toHaveAttribute('data-state','ready');await expect(tour).toHaveCount(0);await expect(page.getByRole('dialog',{name:'New Matter',exact:true})).toBeHidden();
});
test('a delayed first-welcome check does not pull an attorney back from another page',async({page})=>{
 const state=await install(page,undefined,['recent']);let release,reached;const pending=new Promise(r=>release=r),arrived=new Promise(r=>reached=r);
 await page.route('**/api/auth/me',r=>json(r,{user:{id:OWNER,firstName:'Jordan',lastName:'Lee',role:'attorney',status:'approved',isFirstLogin:true,preferences:{theme:'light',fontSize:'md'}}}));
 await page.route('**/api/users/me/onboarding*',async r=>{reached();await pending;return json(r,{onboarding:{attorneyTourCompleted:false}});});
 await page.reload();await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();await arrived;
 await page.getByRole('link',{name:'Payments',exact:true}).click();release();await expect(page).toHaveURL(/#\/payments$/);await expect(page.locator('[data-attorney-tour]')).toHaveCount(0);
});
