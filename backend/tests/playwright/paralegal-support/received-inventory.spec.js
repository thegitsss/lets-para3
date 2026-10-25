const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const { USER, installCurrentHome, home, tab, json } = require('./current-home-fixtures');
const { receivedInvitations } = require('./received-invitation-fixture');
const financial = require('./financial-fixtures');
const AxeBuilder = require('@axe-core/playwright').default;
const id = n => n.toString(16).padStart(24,'0');
async function install(page) {
 const state=await installCurrentHome(page);state.invites.items=Array.from({length:107},(_,i)=>({_id:id(i+1000),id:id(i+1000),caseId:id(i+1000),title:`Invitation ${String(i+1).padStart(3,'0')}`,inviteStatus:'pending',inviteInvitedAt:'2026-09-01T14:00:00Z',practiceArea:'Probate',state:'New York',details:`Complete invitation scope ${i+1}`,tasks:[{title:'Verify exhibits'}],totalAmount:80000,currency:'usd',lockedTotalAmount:null,attorney:{id:id(9000),firstName:'Jordan',lastName:'Lee'}}));
 state.queueCalls=[];state.queueFail=false;state.queueChange=false;state.errors=[];page.on('pageerror',error=>state.errors.push(error.message));
 await page.route(url=>url.pathname==='/api/cases/invited-to',route=>{
  const query=new URL(route.request().url()).searchParams;state.queueCalls.push(Object.fromEntries(query));
  if(state.queueFail&&query.has('cursor'))return json(route,{},503);
  const value=receivedInvitations(USER,state.invites,query);if(state.queueChange&&query.has('cursor'))value.revision='a'.repeat(64);
  return json(route,value);
 });
 await page.route(url=>url.pathname==='/api/cases/my-completed',route=>json(route,financial.history(USER,[],new URL(route.request().url()).searchParams)));
 await page.route('**/api/account/dashboard-views?scope=paralegal_applications',route=>json(route,{scope:'paralegal_applications',views:[]}));
 return state;
}
const work=async page=>{await page.goto('/paralegal-v2.html#/work?section=invitations');await expect(page.locator('body')).toHaveAttribute('data-v2-session','ready');await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy','true');};
test('Home and Work load every page before showing invitation counts and older scope remains reachable',async({page})=>{
 const state=await install(page);await home(page,'?view=invitations');await expect(tab(page,'Invitations')).toContainText('107');expect(state.queueCalls).toHaveLength(3);
 await expect(page.locator('[data-home-invitation-id]')).toHaveCount(107);await page.locator(`[data-home-invitation-id="${id(1106)}"]`).click();await expect(page.locator('.lc-context')).toContainText('Complete invitation scope 107');await expect(page.locator(`[data-home-invitation-id="${id(1106)}"]`)).toBeInViewport();
 await work(page);await expect(page.locator('.v2-work-index').getByRole('link',{name:/Invitations/})).toContainText('107');await expect(page.getByRole('heading',{name:'Invitation 107',exact:true})).toBeVisible();
 expect(state.queueCalls.length).toBeGreaterThanOrEqual(6);expect(state.errors).toEqual([]);
});
test('an unavailable or changed later page never becomes a partial count or a successful empty queue',async({page})=>{
 const state=await install(page);state.queueFail=true;await home(page,'?view=invitations');await expect(page.locator('[data-home-invitation-id]')).toHaveCount(0);await expect(page.locator('.lc-workspace')).toContainText(/couldn’t|unavailable|try again/i);await expect(tab(page,'Invitations')).not.toContainText('50');
 state.queueFail=false;state.queueChange=true;await work(page);await expect(page.getByRole('heading',{name:'Invitation 001',exact:true})).toHaveCount(0);await expect(page.locator('[data-v2-work]')).toContainText(/couldn’t|unavailable|try again/i);
 state.queueChange=false;await page.reload();await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy','true');await expect(page.locator('.v2-work-index').getByRole('link',{name:/Invitations/})).toContainText('107');
});
test('complete invitation context stays readable and accessible at narrow and wide widths in both themes',async({page},testInfo)=>{
 const state=await install(page);await home(page,'?view=invitations');await page.locator(`[data-home-invitation-id="${id(1106)}"]`).click();const scans=[];
 for(const theme of ['light','dark'])for(const width of [320,390,1366]){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.classList.toggle('theme-dark',theme==='dark'),theme);
  await page.locator('.lc-context').scrollIntoViewIfNeeded();if(width>1100)await expect(page.locator(`[data-home-invitation-id="${id(1106)}"]`)).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const result=await new AxeBuilder({page}).include('.lc-workspace').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);scans.push({theme,width,violations:result.violations});await page.screenshot({path:testInfo.outputPath(`received-${theme}-${width}.png`)});
 }
 require('node:fs').writeFileSync(testInfo.outputPath('accessibility.json'),JSON.stringify(scans,null,2));expect(state.errors).toEqual([]);
});
