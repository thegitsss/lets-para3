const { eventPage } = require("./event-page-fixture");
const { browsePageFixture } = require("./browse-page-fixture");
const financial = require("./financial-fixtures");
const { test } = require("../assistant-completion/shell-fixture");
const { expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { writeFile } = require("node:fs/promises");

const {USER,MATTER,INVITE,APP,REC,NOW,json,active,invitation,application,fixture,home,settled}=require("./alignment-fixture");

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  const diagnostic = await page.evaluate(() => ({
    focused: document.activeElement?.outerHTML?.slice(0, 500),
    hovering: [...document.querySelectorAll("[data-v2-home] :hover")].map(element => element.className),
    dialogs: [...document.querySelectorAll("dialog[open], .support-drawer:not([hidden]), [data-v2-search-panel]:not([hidden]), [data-v2-notifications-panel]:not([hidden])")].map(element => ({ class: element.className, hidden: element.hidden })),
    sourceStates: [...document.querySelectorAll("[data-home-source-state]")].map(element => ({ state: element.dataset.homeSourceState, text: element.textContent })),
    loading: document.querySelector("[data-v2-home]")?.dataset.homeLoading,
  })).catch(() => ({}));
  await testInfo.attach("synthetic-home-diagnostics", { body: JSON.stringify({ ...diagnostic, reads: page.__homeFixture?.reads, errors: page.__homeErrors, failedResponses: page.__homeFailedResponses }, null, 2), contentType: "application/json" });
  console.log("Synthetic Home failure diagnostics:", JSON.stringify({ ...diagnostic, reads: page.__homeFixture?.reads, errors: page.__homeErrors, failedResponses: page.__homeFailedResponses }));
});

test('Home uses shared hierarchy and direct section destinations',async({page},info)=>{
 await fixture(page,{dashboard:{activeCases:[active()],metrics:{}}});await home(page);
 await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Your Matters',exact:true})).toBeVisible();
 await expect(page.locator('.pv2-overview')).toBeVisible();
 await expect(page.locator('.ld-desktop')).toHaveCount(0);
 await expect(page.getByRole('navigation',{name:'Work summary'}).getByRole('link',{name:'1 Active Matter'})).toHaveAttribute('href',/work\?section=active/);
 await page.screenshot({path:info.outputPath('home.png'),fullPage:true});
 expect(page.__homeErrors).toEqual([]);
 for(const width of [390,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
});
test('Assistant docks without covering the page and does not stall initial Home data',async({page},info)=>{
 await fixture(page,{applications:[application(),application({_id:'64b000000000000000099999',status:'rejected'})]});
 await page.goto('/paralegal-v2.html#/work');
 await expect(page.getByRole('heading',{name:'Matters',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Open LPC Assistant',exact:true}).click();
 await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Home',exact:true}).click();
 await expect(page.getByRole('link',{name:'1 Pending application',exact:true})).toBeVisible();
 await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading','false');
 await expect(page.getByRole('button',{name:'Refresh Home',exact:true})).toBeHidden();
 await expect.poll(async()=>{
  const frame=await page.locator('.v2-app-frame').boundingBox(),drawer=await page.locator('.support-drawer').boundingBox();
  return frame.x+frame.width<=drawer.x+1;
 }).toBe(true);
 await page.screenshot({path:info.outputPath('assistant-home.png')});
});
test('History uses compact titles and keeps payout and account actions accessible',async({page},info)=>{
 await fixture(page);
 await page.route(url=>url.pathname==='/api/cases/my-completed',route=>json(route,financial.history(USER,[{caseId:MATTER,title:'Completed discovery response',attorneyName:'Jordan Lee',workState:'completed',completedAt:'2026-09-01',blockStatus:{canBlock:true},receiptAvailable:false}],new URL(route.request().url()).searchParams)));
 await page.goto('/paralegal-v2.html#/work?section=history');
 const row=page.locator('.v2-work-history-row');await expect(row).toBeVisible();
 expect(await row.locator('h3').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)/parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(.875,3);
 expect((await row.boundingBox()).height).toBeLessThan(100);
 await row.locator('summary').click();
 await expect(row.getByRole('button',{name:'Block attorney',exact:true})).toBeVisible();
 await expect(row.getByRole('button',{name:'Safety and privacy',exact:true})).toHaveCount(0);
 await page.screenshot({path:info.outputPath('history.png')});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await expect(row.getByRole('button',{name:'Block attorney',exact:true})).toBeVisible();
});

test('History blocking requires explicit cross-platform confirmation before any write',async({page})=>{
 await fixture(page);
 await page.route(url=>url.pathname==='/api/cases/my-completed',route=>json(route,financial.history(USER,[{caseId:MATTER,title:'Completed discovery response',attorneyName:'Jordan Lee',workState:'completed',completedAt:'2026-09-01',blockStatus:{canBlock:true},receiptAvailable:false}],new URL(route.request().url()).searchParams)));
 let blocks=0;
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/blocks'&&request.method()==='POST')blocks++;});
 await page.goto('/paralegal-v2.html#/work?section=history');
 const row=page.locator('.v2-work-history-row');await expect(row).toBeVisible();
 const openConfirmation=async()=>{await row.locator('summary').click();expect(blocks).toBe(0);await row.getByRole('button',{name:'Block attorney',exact:true}).click();};
 await openConfirmation();
 const confirmation=page.getByRole('dialog',{name:'Block this attorney?',exact:true});
 await expect(confirmation).toContainText('Jordan Lee');
 await expect(confirmation).toContainText('future applications, invitations, hiring, and direct messaging');
 await expect(confirmation).toContainText('Existing Matter and payment history remain available');
 expect(blocks).toBe(0);
 await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(blocks).toBe(0);await expect(row.locator('summary')).toBeFocused();
 await page.route('**/api/blocks',route=>{
  expect(route.request().method()).toBe('POST');
  expect(route.request().postDataJSON()).toEqual({caseId:MATTER});
  return json(route,{ok:true,blocked:true},201);
 });
 await openConfirmation();
 await confirmation.getByRole('button',{name:'Block attorney',exact:true}).click();
 await expect.poll(()=>blocks).toBe(1);
});
test('Matters stays compact and keeps all four tabs in History',async({page},info)=>{
 await fixture(page,{dashboard:{activeCases:[active()],metrics:{}}});await page.goto('/paralegal-v2.html#/work');
 const row=page.locator('.v2-work-matter-row');await expect(row).toBeVisible();
 expect(await page.locator('.v2-view').evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))).toBe(32);
 expect((await row.boundingBox()).height).toBeLessThan(100);
 await expect(row.getByRole('link',{name:'Discovery response support',exact:true})).toHaveAttribute('href',/matter\//);
 await page.screenshot({path:info.outputPath('matters.png'),fullPage:true});
 await page.locator('.v2-work-index').getByRole('link',{name:/History/}).click();
 await expect(page.locator('.v2-work-index a')).toHaveCount(4);
 await expect(page.getByRole('heading',{name:'Matters',exact:true})).toBeVisible();
 expect(page.__homeErrors).toEqual([]);
});
test('application filters are collapsed, automatic and remembered after reload',async({page})=>{
 await fixture(page,{applications:[application()]});await page.goto('/paralegal-v2.html#/work?section=applications');
 const search=page.getByRole('searchbox',{name:'Search applications'});await expect(search).toBeVisible();
 const filter=page.getByLabel('Application status',{exact:true});await expect(filter).toBeHidden();
 await page.getByLabel('Filter applications',{exact:true}).click();await expect(filter).toBeVisible();
 await page.getByLabel('Application date range',{exact:true}).selectOption('7');
 await expect(page).toHaveURL(/appRange=7/);
 await page.goto('/paralegal-v2.html#/work?section=applications');await page.getByLabel('Filter applications',{exact:true}).click();
 await expect(page.getByLabel('Application date range',{exact:true})).toHaveValue('7');
 await page.getByLabel('Application date range',{exact:true}).press('Escape');await expect(filter).toBeHidden();
 await expect(page.getByRole('button',{name:'Save view',exact:true})).toHaveCount(0);
 expect(page.__homeErrors).toEqual([]);
});

test('partial Home keeps recovery and does not claim the work is complete',async({page})=>{
 await fixture(page,{failures:{dashboard:503}});await home(page);
 await expect(page.locator('[data-home-source-state="partial"]').first()).toBeVisible();
 await expect(page.getByText('No active Matters.',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('navigation',{name:'Work summary'}).getByRole('link',{name:/Active Matters/})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'No matches in your areas today'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Try again',exact:true}).first()).toBeVisible();
});
test('shared shell and populated lists fit mobile and dark theme without losing destinations',async({page},info)=>{
 await fixture(page,{dashboard:{activeCases:[active(),active({caseId:'64b000000000000000010005',jobTitle:'Medical record chronology'})],metrics:{}},invites:{items:[invitation()]},applications:[application()]});
 await home(page);
 await expect(page.getByRole('link',{name:/Probate inventory support/}).first()).toHaveAttribute('href',/work/);
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`home-${width}.png`),fullPage:true});
 }
 await page.goto('/paralegal-v2.html#/work');await expect(page.locator('.v2-work-matter-row')).toHaveCount(2);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.evaluate(()=>document.documentElement.classList.add('theme-dark'));
 await page.screenshot({path:info.outputPath('matters-mobile-dark.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await expect(page.getByRole('combobox',{name:'Search your workspace'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Open LPC Assistant'})).toBeVisible();
 expect(page.__homeErrors).toEqual([]);
});
test('application search and filter choices retain exact record access',async({page},info)=>{
 await fixture(page,{applications:[application(),application({_id:'64b000000000000000010005',status:'pending',jobId:{_id:'64b000000000000000020005',title:'Probate asset inventory',status:'open',practiceArea:'Probate'}})]});
 await page.goto('/paralegal-v2.html#/work?section=applications');
 await expect(page.locator('.v2-work-application-row')).toHaveCount(2);
 await page.getByRole('searchbox',{name:'Search applications'}).fill('Probate');
 await expect(page.locator('.v2-work-application-row')).toHaveCount(1);
 await expect(page.locator('.v2-work-application-row')).toContainText('Probate asset inventory');
 await page.getByLabel('Filter applications',{exact:true}).click();
 expect(await page.locator('.pv2-work-filter-options').evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
 await page.screenshot({path:info.outputPath('application-filters.png'),fullPage:true});
 await page.getByLabel('Application status',{exact:true}).selectOption('shortlisted');
 await expect(page.locator('.v2-work-application-row')).toHaveCount(0);
 await page.getByLabel('Application status',{exact:true}).selectOption('all');
 await expect(page.locator('.v2-work-application-row')).toHaveCount(1);
});

test('dedicated Payouts verifies totals, recovers failed reads and keeps history reachable', async ({ page }, info) => {
  const state = await fixture(page, { dashboard: { activeCases: [], metrics: { earnings: 400, earningsLast30Days: 800, earningsTotal: 1200 } } });
  await page.goto('/paralegal-v2.html#/payouts');
  const payouts = page.locator('[data-v2-payouts]');
  await expect(payouts).toHaveAttribute('data-state', 'ready');
  await expect(payouts.getByRole('cell', { name: '$1,200.00', exact: true })).toBeVisible();
  await expect(payouts.getByRole('link', { name: 'Completed & withdrawn matters' })).toHaveAttribute('href', /work\?section=history/);
  await expect(payouts.getByRole('link', { name: 'Payment settings' })).toHaveAttribute('href', /settings\?tab=security&section=payments/);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`payouts-${width}.png`), fullPage: true });
  }
  state.failures.dashboard = 503;
  await page.reload();
  await expect(payouts).toHaveAttribute('data-state', 'unavailable');
  await expect(payouts).not.toContainText('$1,200.00');
  delete state.failures.dashboard;
  await payouts.getByRole('button', { name: 'Refresh payouts', exact: true }).click();
  await expect(payouts).toHaveAttribute('data-state', 'ready');
  await expect(payouts).toContainText('$1,200.00');
  expect(page.__homeErrors).toEqual([]);
});

test('empty Invitations gives a direct Find work action', async ({ page }, info) => {
 await fixture(page,{invites:{items:[]}});
 await page.goto('/paralegal-v2.html#/work?section=invitations');
 const section=page.locator('#v2-work-invitations');
 await expect(section).toContainText('No invitations awaiting your response.');
 const cta=section.getByRole('link',{name:'Find work',exact:true});
 await expect(cta).toBeVisible();
 await expect(cta).toHaveAttribute('href','paralegal-v2.html#/browse');
 await page.screenshot({path:info.outputPath('empty-invitations.png')});
 await page.setViewportSize({width:390,height:844});
 await expect(cta).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('empty-invitations-mobile.png')});
 await cta.click();
 await expect(page).toHaveURL(/#\/browse(?:\?|$)/);
 await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route','browse');
});

test('populated Invitations uses the same restrained sections and readable actions', async ({ page }, info) => {
 await fixture(page,{invites:{items:[invitation()]}});
 await page.goto('/paralegal-v2.html#/work?section=invitations');
 const section=page.locator('#v2-work-invitations');
 await expect(section.locator('summary').first()).toContainText('Probate inventory support');
 await section.locator('summary').first().click();
 for(const theme of ['light','dark']) for(const width of [1440,320]) {
  await page.setViewportSize({width,height:1000});
  await page.evaluate(dark=>document.documentElement.classList.toggle('theme-dark',dark),theme==='dark');
  expect(await section.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const title=page.locator('#v2-work-title');
  expect(await title.evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)+1)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await expect(section.getByRole('button',{name:'Accept invitation',exact:true})).toBeVisible();
  expect((await new AxeBuilder({page}).include('#v2-work-invitations').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:info.outputPath(`invitations-${theme}-${width}.png`),fullPage:true});
 }
});

test('Paralegal notifications uses approved compact menus and caught-up state',async({page},info)=>{
 const notice={id:'64b000000000000000070001',message:'Jordan sent a message about Discovery response support.',headline:'Jordan sent a message',contextLabel:'Discovery response support',actorFirstName:'Jordan',read:true,createdAt:NOW,action:{href:`/case-detail.html?caseId=${MATTER}&tab=messages`,label:'View message'},context:{caseId:MATTER}};
 await fixture(page,{notifications:[notice]});await home(page);
 await page.getByRole('button',{name:'View notifications',exact:true}).click();
 const panel=page.locator('[data-v2-notifications-panel]');
 await expect(panel.getByText('Caught up',{exact:true})).toBeVisible();
 await expect(panel.getByRole('button',{name:'Close notifications'})).toHaveCount(0);
 await expect(panel.locator('.v2-notification-copy strong')).toHaveText('Jordan sent a message');
 await expect(panel.locator('.lpc-notification-meta')).toContainText('Discovery response support');
 const gear=panel.getByLabel('Notification options',{exact:true});await gear.hover();
 expect(await gear.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
 await gear.click();await expect(panel.getByRole('button',{name:'Dismiss all',exact:true})).toBeVisible();
 await gear.click();await panel.getByLabel('Options: Jordan sent a message',{exact:true}).click();
 await expect(panel.getByRole('button',{name:'Dismiss notification',exact:true})).toBeVisible();
 expect(await panel.locator('.v2-notification').evaluate(el=>getComputedStyle(el).borderBottomWidth)).toBe('0px');
 await page.screenshot({path:info.outputPath('notifications.png')});
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');await expect(panel).toBeHidden();
 expect(page.__homeErrors).toEqual([]);
});

test('Search expands as one outlined surface and keeps authorized keyboard navigation',async({page},info)=>{
 await fixture(page);await page.route('**/api/cases/search?*',route=>{const q=new URL(route.request().url()).searchParams;return json(route,{ownerId:USER,query:q.get('q'),types:['matter'],results:{profiles:[],matters:[]}});});
 await home(page);const form=page.locator('[data-v2-search-form]'),input=page.locator('[data-v2-search-input]');
 await form.hover();await expect.poll(async()=>(await form.boundingBox()).width).toBe(280);
 expect(await form.evaluate(el=>getComputedStyle(el).borderTopWidth)).toBe('1px');
 await input.fill('messages');const panel=page.locator('[data-v2-search-panel]');await expect(panel).toBeVisible();
 await expect(form.locator('[data-v2-search-panel]')).toHaveCount(1);
  await expect(panel.getByRole('option',{name:'Messages',exact:true})).toBeVisible();
  await expect.poll(()=>panel.getByRole('option',{name:'Messages',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
 await expect(panel.getByText('Commands',{exact:true})).toHaveCount(0);
 const fieldBox=await form.boundingBox(),resultsBox=await panel.boundingBox();expect(Math.abs(resultsBox.y-(fieldBox.y+fieldBox.height))).toBeLessThanOrEqual(2);
 await expect(panel.getByText('Searching…',{exact:true})).toBeHidden();
 await page.screenshot({path:info.outputPath('search.png')});
 await input.press('ArrowDown');await input.press('Enter');await expect(page).toHaveURL(/#\/conversations/);
 await input.fill('help');await expect(panel).toBeVisible();await input.fill('');await expect(panel).toBeHidden();
 expect(page.__homeErrors).toEqual([]);
});

test('Sidebar uses the Attorney header toggle and full-edge Collapse and Expand preview',async({page},info)=>{
 await fixture(page);await home(page);const toggle=page.locator('[data-v2-sidebar-grip]');
 const markerBox=await toggle.locator('.v2-sidebar-marker').boundingBox(),sideBox=await page.locator('#v2-sidebar').boundingBox();expect(Math.abs(markerBox.x+markerBox.width/2-(sideBox.x+sideBox.width+8))).toBeLessThanOrEqual(2);
 await toggle.hover();await expect(toggle).toHaveAttribute('data-collapse-label','Collapse');
 await expect.poll(()=>page.locator('#v2-sidebar').evaluate(el=>getComputedStyle(el,'::after').transform)).toBe('matrix(1, 0, 0, 1, -4, 0)');
 await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','false');
 await toggle.hover();await expect(toggle).toHaveAttribute('data-collapse-label','Expand');
 await expect.poll(()=>page.locator('#v2-sidebar').evaluate(el=>getComputedStyle(el,'::after').transform)).toBe('matrix(1, 0, 0, 1, 4, 0)');
 await page.screenshot({path:info.outputPath('sidebar-expand.png')});await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','true');
});

test('The same Attorney-style toggle opens the mobile navigation and restores focus',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);await home(page);
 const toggle=page.locator('[data-v2-sidebar-grip]');
 await expect(toggle).toHaveAttribute('aria-label','Open navigation');
 await expect(toggle).toHaveAttribute('aria-expanded','false');
 await toggle.click();
 const drawer=page.getByRole('dialog',{name:'Workspace navigation',exact:true});
 await expect(drawer).toBeVisible();
 await expect(toggle).toHaveAttribute('aria-expanded','true');
 await expect(page.locator('#v2-sidebar')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(drawer).toBeHidden();
 await expect(toggle).toHaveAttribute('aria-expanded','false');
 await expect(toggle).toBeFocused();
});

test('Applications only remembers filters and does not depend on saved-view records',async({page})=>{
 await fixture(page,{applications:[application()]});let savedReads=0;
 await page.route('**/api/account/dashboard-views?*',route=>{savedReads++;return json(route,{error:'Unavailable'},503);});
 await page.goto('/paralegal-v2.html#/work?section=applications');await page.getByLabel('Filter applications',{exact:true}).click();
 await expect(page.getByText('Previously saved views',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Application saved view',{exact:true})).toHaveCount(0);
 await page.getByLabel('Application status',{exact:true}).selectOption('shortlisted');await page.reload();
 await page.getByLabel('Filter applications',{exact:true}).click();await expect(page.getByLabel('Application status',{exact:true})).toHaveValue('shortlisted');
 expect(savedReads).toBe(0);expect(page.__homeErrors).toEqual([]);
});

test('Home previews read and unread conversations with sender and shared Messages destinations',async({page},info)=>{
 const readId='64b000000000000000010005';
 await fixture(page,{dashboard:{activeCases:[active(),active({caseId:readId,jobTitle:'Read conversation'})],metrics:{}},threads:{threads:[{caseId:MATTER,title:'Discovery response support',lastMessageSnippet:'Ready for review',lastSenderName:'Jordan',unread:2,lastMessageAt:NOW},{caseId:readId,title:'Read conversation',lastMessageSnippet:'Thank you',lastSenderName:'You',unread:0,lastMessageAt:'2026-09-07T15:00:00Z'}]},unread:{count:2}});await home(page);
 const section=page.getByRole('region',{name:'Messages',exact:true});
 await expect(section.locator('.pv2-overview-row')).toHaveCount(2);
 await expect(section.locator('.pv2-overview-row.is-unread')).toContainText('Jordan: Ready for review');
 await expect(section.locator('.pv2-overview-row.is-unread')).toContainText('2 unread');
 const read=section.locator('.pv2-overview-row').filter({hasText:'Read conversation'});await expect(read).toContainText('You: Thank you');await expect(read.locator('.pv2-overview-row-action')).toHaveText('Sep 7');
 await expect(read).toHaveAttribute('href',new RegExp(`conversations\\?matter=${readId}$`));
 await expect(section.getByRole('link',{name:'View all',exact:true})).toHaveAttribute('href',/conversations$/);
 await page.screenshot({path:info.outputPath('home-conversations.png')});expect(page.__homeErrors).toEqual([]);
});

test('rebuilt shell nests Matter destinations and preserves secondary tools in the account and subnavigation',async({page},info)=>{
 await fixture(page);await home(page);
 await expect(page.getByText('Home tools',{exact:true})).toHaveCount(0);
 await expect(page.getByText('Help and access',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Open profile menu',exact:true}).click();
 await expect(page.getByRole('menuitem',{name:'Previous workspace',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Expand Matters navigation',exact:true}).click();
 await expect(page.locator('#v2-matter-subnav').getByRole('link',{name:'Applications',exact:true})).toBeVisible();
 await page.locator('.v2-more-tools > summary').click();
 await expect(page.locator('#v2-matter-subnav').getByRole('link',{name:'Deadlines',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('navigation.png')});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await expect(page.locator('#v2-navigation-dialog')).toBeVisible();
 await page.getByRole('button',{name:'Close navigation',exact:true}).click();
 await expect(page.locator('#v2-navigation-dialog')).not.toBeVisible();
});

test('rebuilt Applications shows a full inventory and opens records through their title',async({page},info)=>{
 const apps=Array.from({length:21},(_,i)=>application({_id:String(i+1).padStart(24,'0'),jobId:{_id:String(i+101).padStart(24,'0'),title:`Application ${i+1}`,status:'open'},createdAt:new Date(Date.UTC(2026,8,8,0,i)).toISOString()}));
 await fixture(page,{applications:apps});await page.goto('/paralegal-v2.html#/work?section=applications');
 await expect(page.locator('.v2-work-application-row')).toHaveCount(20);
 await expect(page.getByRole('button',{name:'Details',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Application 21',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await expect(page.locator('.v2-work-application-row')).toHaveCount(1);
 await page.getByRole('button',{name:'Previous page',exact:true}).click();
 await page.screenshot({path:info.outputPath('applications.png')});
});

test('Find Work empty catalog has a useful next step and no inactive controls',async({page},info)=>{
 await fixture(page);
 await page.goto('/paralegal-v2.html#/browse');
 const empty=page.locator('.v2-browse-results.is-catalog-empty .v2-browse-empty');
 await expect(empty.getByRole('heading',{name:'No open matters right now.'})).toBeVisible();
 await expect(empty).toContainText('New Matters will appear here when attorneys post them.');
 await expect(page.getByRole('button',{name:/^Filters/})).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'Sort matters'})).toHaveCount(0);
 const link=empty.getByRole('link',{name:'View applications',exact:false});
 await expect(link).toBeVisible();
 expect(await empty.evaluate(el=>getComputedStyle(el).textAlign)).toBe('left');
 expect(await empty.evaluate(el=>getComputedStyle(el).flexDirection)).toBe('column');
 expect(await empty.evaluate(el=>getComputedStyle(el).borderBottomWidth)).toBe('0px');
 expect(await page.locator('.v2-browse-list').evaluate(el=>getComputedStyle(el).borderTopWidth)).toBe('0px');
 const icon=page.getByRole('navigation',{name:'Primary'}).getByRole('link',{name:'Find Work'}).locator('svg');
 await expect(icon.locator('rect')).toHaveCount(1);
 await page.screenshot({path:info.outputPath('find-work-empty.png')});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('find-work-empty-mobile.png')});
 await link.click();
 await expect(page).toHaveURL(/#\/work\?section=applications/);
});

test('Find Work filters apply on selection without an apply step',async({page},info)=>{
 await fixture(page,{recommendations:{hasMatchingProfile:true,items:[{_id:MATTER,caseId:MATTER,title:'Discovery response support',practiceArea:'Civil Litigation',state:'New York',totalAmount:90000,createdAt:NOW,attorney:{firstName:'Jordan',lastName:'Lee'}}]}});await page.goto('/paralegal-v2.html#/browse');
 await page.getByRole('button',{name:/^Filters/}).click();
 await expect(page.getByRole('button',{name:'Apply filters',exact:true})).toHaveCount(0);
 await page.getByRole('combobox',{name:'Deadline',exact:true}).selectOption('7_days');
 await expect(page).toHaveURL(/deadline=7_days/);
 await page.getByRole('button',{name:/^Filters/}).click();
 await expect(page.getByRole('combobox',{name:'Deadline',exact:true})).toHaveValue('7_days');
 await page.screenshot({path:info.outputPath('browse-filters.png')});
});
