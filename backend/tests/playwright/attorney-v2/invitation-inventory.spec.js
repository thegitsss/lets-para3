const { test } = require('../assistant-completion/shell-fixture');
const { fixture: shell, json, OWNER, MATTER } = require('../assistant-completion/fixture');
const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const panel = page => page.locator('[data-matter-invitations]');
const ready = page => expect(panel(page)).toHaveAttribute('data-state','ready');
const rows = page => panel(page).locator('.matter-invitation');
const dataSet = () => Array.from({length:107},(_,i)=>({paralegal:{id:(i+1).toString(16).padStart(24,'0'),name:`Paralegal ${String(i+1).padStart(3,'0')}`,available:true,profileImage:null},status:i%5?'pending':'accepted',invitedAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),respondedAt:null}));
async function install(page,hash=`/matters/${MATTER}/invitations`) {
 const state={items:dataSet(),status:200,complete:true,errors:[],transform:value=>value};
 page.on('pageerror',error=>state.errors.push(error.message));
 await shell(page,'attorney',{hash,setup:async account=>{account.user.onboarding.attorneyTourCompleted=true;await page.route(`**/api/cases/${MATTER}/invites?**`,route=>json(route,state.transform({ownerId:OWNER,caseId:MATTER,caseTitle:'Contract review invitations',complete:state.complete,invites:state.items}),state.status));}});
 await ready(page);return state;
}
test('all invitation pages and status counts remain reachable and profile return retains page and filters',async({page})=>{
 const state=await install(page,`/matters/${MATTER}/invitations?invPage=5`);
 await expect(rows(page)).toHaveCount(7);await expect(panel(page)).toContainText('101–107 of 107 invitations');await expect(rows(page).last()).toContainText('Paralegal 001');
 await panel(page).getByRole('button',{name:'Refresh invited paralegals'}).click();await ready(page);await page.reload();await ready(page);await expect(rows(page)).toHaveCount(7);
 const href=await rows(page).last().getByRole('link').getAttribute('href');expect(new URLSearchParams(href.split('?')[1]).get('returnTo')).toContain('invPage=5');
 await panel(page).getByRole('combobox',{name:'Status',exact:true}).selectOption('accepted');await panel(page).getByRole('combobox',{name:'Sort',exact:true}).selectOption('oldest');await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);await expect(rows(page)).toHaveCount(22);await expect(rows(page).first()).toContainText('Paralegal 001');
 await page.reload();await ready(page);await expect(panel(page).getByRole('combobox',{name:'Status',exact:true})).toHaveValue('accepted');await expect(panel(page)).toContainText('does not confirm a hire');
 expect(state.errors).toEqual([]);
});
test('failed changed empty and filtered invitation reads remove old records and recover without stale counts',async({page})=>{
 const state=await install(page);state.status=503;await panel(page).getByRole('button',{name:'Refresh invited paralegals'}).click();await expect(panel(page)).toHaveAttribute('data-state','error');await expect(rows(page)).toHaveCount(0);await expect(panel(page)).not.toContainText('of 107');
 state.status=200;await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);await expect(rows(page)).toHaveCount(25);
 await panel(page).getByRole('searchbox').fill('No matching name');await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);await expect(panel(page).getByText('No invitations match these filters.',{exact:true})).toHaveCount(1);
 await panel(page).getByRole('button',{name:'Clear filters'}).click();await ready(page);state.items=[];state.complete=false;await panel(page).getByRole('button',{name:'Refresh invited paralegals'}).click();await ready(page);await expect(panel(page)).toContainText('No readable invitations');await expect(panel(page)).not.toContainText('No invited paralegals yet');
 state.complete=true;await panel(page).getByRole('button',{name:'Refresh invited paralegals'}).click();await ready(page);await expect(panel(page).getByText('No invited paralegals yet.',{exact:true})).toHaveCount(1);
});
test('removed invitation pages return to the first available page and pending rows avoid redundant response text',async({page})=>{
 const state=await install(page,`/matters/${MATTER}/invitations?invPage=5`);state.items=state.items.filter(item=>item.status==='pending').slice(0,3);
 await panel(page).getByRole('button',{name:'Refresh invited paralegals'}).click();await ready(page);await expect(rows(page)).toHaveCount(0);await expect(panel(page)).toContainText('This page no longer has invitations');
 await panel(page).getByRole('button',{name:'Return to first page'}).click();await ready(page);await expect(rows(page)).toHaveCount(3);await expect(panel(page)).not.toContainText('No response date');await expect(panel(page)).not.toContainText('does not confirm a hire');
});
test('invitation controls and long identities remain contained accessible and usable across themes and large text',async({page},testInfo)=>{
 const state=await install(page);state.items[106].paralegal.name='A long invited paralegal name with multiple professional credentials';state.items[106].paralegal.available=false;
 await panel(page).getByRole('button',{name:'Refresh invited paralegals'}).click();await ready(page);const scans=[];
 for(const theme of ['light','dark'])for(const width of [320,390,1366]){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.classList.toggle('theme-dark',theme==='dark'),theme);await page.locator('main').evaluate(node=>{node.scrollTop=0;});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  for(const control of await panel(page).locator('form input,form select,form button:visible').all())expect(Math.round((await control.boundingBox()).height * 1000) / 1000).toBeGreaterThanOrEqual(44);
  const result=await new AxeBuilder({page}).include('[data-matter-invitations]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);scans.push({theme,width,violations:result.violations});await page.screenshot({path:testInfo.outputPath(`invitations-${theme}-${width}.png`)});
 }
 await page.setViewportSize({width:390,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='200%');await panel(page).getByRole('button',{name:'Apply filters'}).focus();await page.keyboard.press('Enter');await ready(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await rows(page).first().scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('invitations-large-text.png')});
 fs.writeFileSync(testInfo.outputPath('accessibility.json'),JSON.stringify(scans,null,2));fs.writeFileSync(testInfo.outputPath('browser-errors.json'),JSON.stringify(state.errors));expect(state.errors).toEqual([]);
});
