const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const {fixture,json,USER,INVITE,APP,invitation,application}=require('./alignment-fixture');
const {matterFixture,MATTER_ID}=require('./rebuild-matter-fixture');

test('rebuilt Matter workspace preserves authorized tabs, task authority and populated file layout',async({page},info)=>{
 await fixture(page);
 const matter=matterFixture();
 await page.route(url=>url.pathname===`/api/cases/${MATTER_ID}`,route=>json(route,matter));
 await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`,route=>json(route,{files:matter.files}));
 await page.route(url=>url.pathname===`/api/events/paralegal/matters/${MATTER_ID}/review`,route=>json(route,{ownerId:USER,caseId:MATTER_ID,revision:'c'.repeat(64),items:[],total:0,nextCursor:null,selection:'none',selectedEvent:null,operation:null}));
 await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`);
 await expect(page.locator('[data-v2-matter]')).toBeVisible();
 await expect(page.locator('.v2-matter-header-facts')).toContainText('Attorney: Jordan Lee');
 await expect(page.getByRole('heading',{level:1,name:matter.title})).toBeVisible();
 const nav=page.getByRole('navigation',{name:'Matter workspace sections'});
 await nav.getByRole('link',{name:'Work',exact:true}).click();
 await expect(page.getByText('Draft responses',{exact:true})).toBeVisible();
 await expect(page.getByText('Prepare exhibits',{exact:true})).toBeVisible();
 await expect(page.locator('[data-completion-state]')).toHaveAttribute('data-completion-state','attorney_task_review');
 await expect(page.getByRole('button',{name:/complete task|approve|release payment/i})).toHaveCount(0);
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`workspace-work-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});
 await nav.getByRole('link',{name:'Files',exact:true}).click();
 await expect(page.getByText('Interrogatory responses.pdf',{exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('workspace-files.png'),fullPage:true});
 expect((await new AxeBuilder({page}).include('[data-v2-matter]').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
 for(const [tab, expected] of [['Activity','File shared'],['Deadlines','Sep 12, 2026'],['Financials','Estimated payout']]) {
  await nav.getByRole('link',{name:tab,exact:true}).click();
  await expect(nav.getByRole('link',{name:tab,exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('[data-v2-matter]')).toContainText(expected);
  if(tab==='Financials')await expect(page.locator('[data-matter-payments]')).toHaveAttribute('data-state','estimate');
  await page.screenshot({path:info.outputPath(`workspace-${tab.toLowerCase()}.png`),fullPage:true});
 }

 expect(page.__homeErrors).toEqual([]);
});

test('rebuilt invitation exposes scope before acceptance and retains expansion through refresh',async({page})=>{
 const state=await fixture(page,{invites:{items:[invitation()]}});
 let accepted=0;
 await page.route(`**/api/cases/${INVITE}/invite/accept`,async route=>{accepted++;state.invites={items:[]};await json(route,{success:true});});
 await page.goto('/paralegal-v2.html#/work?section=invitations');
 const row=page.locator(`[data-work-invite-id="${INVITE}"]`);
 await expect(row.getByRole('button',{name:'Accept invitation',exact:true})).toBeHidden();
 await row.locator('summary').first().click();
 await expect(row.getByText('Review the complete asset inventory and identify missing source records.')).toBeVisible();
 expect(accepted).toBe(0);
 const reads=state.reads.invites;
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh',{detail:{sourceId:'rebuild-invitation',accessMayChange:true}})));
 await expect.poll(()=>state.reads.invites).toBeGreaterThan(reads);
 await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy','true');
 await expect(row).toHaveAttribute('open','');
 await row.getByRole('button',{name:'Accept invitation',exact:true}).click();
 await expect.poll(()=>accepted).toBe(1);
 await expect(row).toHaveCount(0);
 expect(page.__homeErrors).toEqual([]);
});

test('rebuilt application title opens retained record and withdrawal still requires confirmation',async({page})=>{
 const state=await fixture(page,{applications:[application({status:'submitted'})]});
 let revoked=0;
 await page.route(`**/api/applications/${APP}/revoke`,async route=>{revoked++;state.applications[0].status='withdrawn';await json(route,{success:true});});
 await page.goto('/paralegal-v2.html#/work?section=applications');
 const title=page.getByRole('button',{name:'Employment records review',exact:true});
 await title.click();
 const record=page.getByRole('dialog');
 await expect(record).toBeVisible();
 await record.getByRole('button',{name:'Withdraw application',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'Withdraw this application?'});
 await expect(confirm).toBeVisible();expect(revoked).toBe(0);
 await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(revoked).toBe(0);
 await expect(title).toBeFocused();
 await title.click();
 await record.getByRole('button',{name:'Withdraw application',exact:true}).click();
 await confirm.getByRole('button',{name:'Withdraw application',exact:true}).click();
 await expect.poll(()=>revoked).toBe(1);
 expect(page.__homeErrors).toEqual([]);
});
