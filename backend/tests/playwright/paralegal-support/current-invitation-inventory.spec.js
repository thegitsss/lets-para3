const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { receivedInvitations } = require('./received-invitation-fixture');
const id = n => (70000+n).toString(16).padStart(24,'0');
const items = Array.from({length:107},(_,n)=>({_id:id(n),id:id(n),title:`Inventory invitation ${n+1}`,briefSummary:'Short overview only',details:`Complete scope for invitation ${n+1}`,tasks:[{title:'Verify all exhibits'}],totalAmount:80000,currency:'usd',state:'New York',minimumYearsExperience:5,deadlineDate:'2027-03-14',inviteInvitedAt:'2026-09-01T14:00:00Z',attorney:{id:'64b000000000000000000099',firstName:'Jordan',lastName:'Lee'}}));
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function install(page){
 const user=(await(await page.request.get('/api/auth/me')).json()).user,ownerId=String(user.id||user._id),state={fail:false};
 await page.route(url=>url.pathname==='/api/cases/invited-to',route=>{const query=new URL(route.request().url()).searchParams;return state.fail&&query.has('cursor')?json(route,{},503):json(route,receivedInvitations(ownerId,items,query));});
 return state;
}
test('current dashboard reaches invitation107 and shows its full scope before a response',async({page},testInfo)=>{
 await install(page);
 await page.goto(`/dashboard-paralegal.html?inviteCase=${id(106)}#home`);
 const dialog=page.locator('#inviteOverlay [role=dialog]');
 await expect(dialog).toBeVisible();await expect(dialog.getByRole('heading',{name:'Invitation',exact:true})).toBeVisible();await expect(dialog).toContainText('Inventory invitation 107');await expect(dialog).toContainText('Complete scope for invitation 107');await expect(dialog).not.toContainText('Short overview only');await expect(dialog).toContainText('Verify all exhibits');await expect(dialog).toContainText('5+ years required');await expect(dialog).toContainText('Mar 14, 2027');
 await expect(page.locator('[data-paralegal-priority-count]')).toHaveText('107 items');
 await expect(page.locator('[data-paralegal-priority-list]')).toHaveAttribute('data-state','ready');
 await expect(page.getByRole('navigation',{name:'Inbox pages'})).toContainText('Page 1 of 27');
 const scans=[];
 const scenarios=['light','dark'].flatMap(theme=>[1366,390,320].map(width=>({theme,width})));scenarios.push({theme:'light',width:390,largeText:true});
 for(const {theme,width,largeText} of scenarios){
  await page.evaluate(theme=>{document.documentElement.classList.toggle('theme-dark',theme==='dark');document.body.classList.toggle('theme-dark',theme==='dark');},theme);
  await page.evaluate(large=>{document.documentElement.style.fontSize=large?'20px':'';},!!largeText);
  await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(theme==='dark'?'rgb(17, 28, 42)':'rgb(255, 255, 255)');
  const scan=await new AxeBuilder({page}).include('#inviteOverlay').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();scans.push({theme,width,largeText:!!largeText,violations:scan.violations});expect(scan.violations).toEqual([]);
  for(const button of await dialog.getByRole('button').all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(43.999);
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`current-invitation-${theme}-${width}${largeText?'-large-text':''}.png`),animations:'disabled'});
 }
 require('node:fs').writeFileSync(testInfo.outputPath('accessibility.json'),JSON.stringify(scans,null,2));
});
test('current dashboard never exposes a partial invitation count and retries a failed later page',async({page})=>{
 const state=await install(page);state.fail=true;
 await page.goto('/dashboard-paralegal.html#home');
 const notice=page.locator('[data-invitation-load-state]');await expect(notice).toBeVisible();
 const list=page.locator('[data-paralegal-priority-list]'),count=page.locator('[data-paralegal-priority-count]');
 await expect(list).toHaveAttribute('data-state','unavailable');
 await expect(list.getByRole('link',{name:'Review invitation',exact:true})).toHaveCount(0);
 await expect(count).not.toHaveText(/^(50|107) items$/);
 // Keep background reads unavailable until the actual Retry click is dispatched.
 // Otherwise a background recovery can remove the button during actionability checks.
 let retryClicks=0;
 await page.exposeFunction('__lpcTestRecoverInvitations',()=>{retryClicks++;state.fail=false;});
 const retry=notice.getByRole('button',{name:'Retry invitations'});
 await retry.evaluate(button=>button.addEventListener('click',()=>{void window.__lpcTestRecoverInvitations();},{capture:true,once:true}));
 await retry.click();
 await expect(notice).toBeHidden();await expect(list).toHaveAttribute('data-state','ready');await expect(count).toHaveText('107 items');
 await expect(list.getByRole('link',{name:'Review invitation',exact:true})).toHaveCount(4);
 await expect(page.getByRole('navigation',{name:'Inbox pages'})).toContainText('Page 1 of 27');
 expect(retryClicks).toBe(1);
});
