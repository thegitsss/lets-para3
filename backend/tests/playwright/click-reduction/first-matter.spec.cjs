const {test}=require('../assistant-completion/shell-fixture');const {expect}=require('playwright/test');
const {install}=require('../attorney-v2/home-summaries-fixture');const {json,OWNER}=require('../assistant-completion/fixture');
test('first attorney login stays on Home and preserves deliberate Matter creation',async({page})=>{
 const {data}=await install(page,undefined,['attention','applications','messages','recent']);
 await page.route('**/api/auth/me',r=>json(r,{user:{id:OWNER,_id:OWNER,firstName:'Dana',lastName:'Young',role:'attorney',status:'approved',isFirstLogin:true,preferences:{theme:'light',fontSize:'md'}}}));
 await page.route('**/api/case-drafts/defaults',r=>json(r,{ownerId:OWNER,practiceArea:'',state:''}));await page.route('**/api/cases/posting/options',r=>json(r,{practiceAreas:['contract law']}));
 await page.route('**/api/case-drafts/resolve/**',r=>json(r,{},404));
 await page.reload();const creation=page.getByRole('dialog',{name:'New Matter',exact:true});await expect(page.locator('[data-av2-region=recent]')).toHaveAttribute('data-state','ready');await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();await expect(creation).toBeHidden();
 await page.getByRole('button',{name:'New Matter',exact:true}).click();await expect(creation).toBeVisible();await expect(page.locator('#av2-compose-brief')).toBeFocused();
 await page.getByRole('button',{name:'Close Matter creation',exact:true}).click();await page.reload();await expect(page.locator('[data-av2-region=recent]')).toHaveAttribute('data-state','ready');await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();await expect(creation).toBeHidden();
 data.home.counts.draft=1;await page.reload();await expect(page.locator('[data-av2-region=recent]')).toHaveAttribute('data-state','ready');await expect(page.locator('[data-lpc-boot-screen]')).toBeHidden();await expect(creation).toBeHidden();
});
