const { test, expect } = require('../support-session-fixture');
const { inventoryFixture } = require('./inventory-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const inspectBrowserDiagnostics = require('../financial-lifecycle/browser-diagnostics');
const reloadObservations = new Map();
const id = n => n.toString(16).padStart(24, '0');
const body = (page, view) => page.locator(`[data-table-body="${view}"]`);
const rows = (page, view) => body(page, view).locator('.matter-queue-row');
const ready = (page, view) => expect(body(page, view)).toHaveAttribute('aria-busy', 'false');
const row = (n, values = {}) => ({ id: id(n), title: `Matter ${String(n).padStart(4, '0')}`, status: 'open', archived: false, paymentReleased: false, applicantsCount: 0, files: [], practiceArea: 'Contract Law', totalAmount: 40001, remainingAmount: 40001, currency: 'usd', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), ...values });
async function install(page) {
  const user = (await (await page.request.get('/api/auth/me')).json()).user, owner = user.id || user._id;
  const data = { active: [...Array.from({length:103}, (_,i)=>row(i+1)), ...Array.from({length:104}, (_,i)=>row(i+2001,{applicantsCount:1}))], archived: Array.from({length:102}, (_,i)=>row(i+1001,{status:'completed',archived:true,paymentReleased:true})), drafts:{items:[]} };
  const state = { failures:{}, transform:value=>value, reads:[], respond:null, errors:[] };
  page.on('pageerror', error=>state.errors.push(error.message));
  await page.route('**/api/cases/my?**', route=>{const url=new URL(route.request().url());const view=url.searchParams.get('archived')==='true'?'archived':'active';return route.fulfill({status:state.failures[view]||200,contentType:'application/json',body:JSON.stringify(data[view].slice(-100))});});
  await page.route('**/api/cases/inventory?**', async route=>{
    const url=new URL(route.request().url());state.reads.push(Object.fromEntries(url.searchParams));
    if(state.respond)return state.respond(route,url);
    return route.fulfill({status:state.failures[url.searchParams.get('view')]||200,contentType:'application/json',body:JSON.stringify(state.transform(await inventoryFixture(data,owner,url.searchParams)))});
  });
  return { data,state,owner };
}

for(const [view,total,last] of [['active',103,13],['archived',102,12],['inquiries',104,14]]) test(`current ${view} reaches complete older pages and preserves reload context`, async({page},info)=>{
  const observed = await observeInventoryReload(page, info);
  const {state,owner}=await install(page);
  observed.attorneyOwnerId = owner;
  await page.goto(`/dashboard-attorney.html?${view}Page=7#cases:${view}`,{waitUntil:'commit'});
  await expect(page.locator(`[data-case-count="${view}"]`)).toHaveText(String(total));
  await ready(page,view);await expect(rows(page,view)).toHaveCount(last);
  await expect(page.locator(`[data-page-info="${view}"]`)).toHaveText(`91–${total} of ${total}`);
  await page.locator(`[data-page-target="${view}"][data-page-action="prev"]`).click();await ready(page,view);
  await expect(page.locator(`[data-page-target="${view}"][data-page-action="prev"]`)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`${view}Page=6`));await expect(rows(page,view)).toHaveCount(15);
  await page.reload();await ready(page,view);await expect(page.locator(`[data-page-info="${view}"]`)).toHaveText(`76–90 of ${total}`);
  await page.locator('[data-case-filter="draft"]').click();await page.locator(`[data-case-filter="${view}"]`).click();await ready(page,view);await expect(page.locator(`[data-page-info="${view}"]`)).toHaveText(`76–90 of ${total}`);
  expect(state.reads.filter(read=>read.view===(view==='inquiries'?'applications':view)).every(read=>read.expectedOwnerId===owner)).toBe(true);
  expect(observed.errors).toHaveLength(state.errors.length);
  const diagnostics = inspectBrowserDiagnostics(observed);
  expect(diagnostics.documentFailures).toEqual([]);
  expect(diagnostics.unexplainedPageErrors).toEqual([]);
});

for(const view of ['active','archived','inquiries']) test(`current ${view} failure is unavailable and recovers deliberately`,async({page})=>{
  const {state}=await install(page);state.failures[view==='inquiries'?'applications':view]=503;
  await page.route('**/api/notifications',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.goto(`/dashboard-attorney.html#cases:${view}`,{waitUntil:'commit'});
  const retry=page.getByRole('button',{name:'Retry matters',exact:true});await expect(retry).toBeVisible();await expect(rows(page,view)).toHaveCount(0);
  await expect(page.locator(`[data-matters-refresh="${view}"]`)).toBeHidden();
  await expect(page.locator(`[data-case-count="${view}"]`)).toHaveText('—');await expect(body(page,view)).not.toContainText('No matters');
  state.failures={};await retry.focus();await retry.press('Enter');await ready(page,view);
  await expect(rows(page,view)).toHaveCount(15);await expect(page.locator(`[data-matters-refresh="${view}"]`)).toBeFocused();
  const before=state.reads.filter(read=>read.view===(view==='inquiries'?'applications':view)).length;
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed',{detail:{types:['application_submitted']}})));
  await expect.poll(()=>state.reads.filter(read=>read.view===(view==='inquiries'?'applications':view)).length).toBeGreaterThan(before);
  await ready(page,view);await expect(rows(page,view)).toHaveCount(15);
  await expect(page.locator(`[data-matters-refresh="${view}"]`)).toBeFocused();
});

test('notifications do not retry an unavailable Matter list before the person chooses recovery', async ({ page }) => {
  const { state } = await install(page); state.failures.archived = 503;
  await page.route('**/api/notifications', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto('/dashboard-attorney.html#cases:archived', { waitUntil: 'domcontentloaded' });
  const retry = page.getByRole('button', { name: 'Retry matters', exact: true });
  await expect(retry).toBeVisible();
  const homeSettled = async () => {
    await expect(page.locator('#overviewMattersBody')).toHaveAttribute('data-state', /^(ready|failed)$/);
    await expect(page.locator('#overviewApplicationsBody')).toHaveAttribute('data-state', /^(ready|failed)$/);
    await expect(page.locator('#attorneyNeedsAttentionList')).not.toContainText('Checking remaining items…');
  };
  await homeSettled();
  const control = await retry.elementHandle(), before = state.reads.filter(read => read.view === 'archived').length;
  let releaseHome, heldHome = false;
  const gate = new Promise(resolve => { releaseHome = resolve; });
  await page.route('**/api/cases/inventory/home?**', async route => {
    const response = await route.fetch();
    heldHome = true; await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    const homeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/cases/inventory/home');
    state.failures = {};
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed', { detail: { types: ['application_submitted'] } })));
    await expect.poll(() => heldHome).toBe(true);
    expect(await control.evaluate(node => node.isConnected)).toBe(true);
    expect(state.reads.filter(read => read.view === 'archived')).toHaveLength(before);
    // The notification also refreshes Home. Finish that read before explicit
    // recovery, rather than assuming its request settled within one second.
    releaseHome(); await homeResponse; await homeSettled();
    expect(await control.evaluate(node => node.isConnected)).toBe(true);
    expect(state.reads.filter(read => read.view === 'archived')).toHaveLength(before);
    await expect(page.locator('[data-case-count="archived"]')).toHaveText('—');
    await retry.focus(); await retry.press('Enter'); await ready(page, 'archived');
    await expect(rows(page, 'archived')).toHaveCount(15);
    expect(state.reads.filter(read => read.view === 'archived')).toHaveLength(before + 1);
  } finally { releaseHome(); }
});

test('older Matter search and practice refinement are complete and persist across reload',async({page})=>{
  const {data}=await install(page);data.active[0].title='Older (estate) [NY]';data.active[0].practiceArea='Estate planning';
  await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'commit'});await ready(page,'active');
  await page.locator('[data-cases-search]').fill('(estate) [NY]');await ready(page,'active');
  await expect(rows(page,'active')).toHaveCount(1);await expect(rows(page,'active')).toContainText('Older (estate) [NY]');
  await page.locator('[data-matter-filter-menu] > summary').click();await page.locator('[data-matter-practice-filter]').selectOption('Estate planning');await ready(page,'active');
  await page.reload();await ready(page,'active');await expect(rows(page,'active')).toHaveCount(1);await expect(page.locator('[data-case-count="active"]')).toHaveText('103');
});

for(const fault of ['wrong-owner','malformed']) test(`current Matter ${fault} payload does not expose rows or a false zero`,async({page})=>{
  const {state}=await install(page);state.transform=value=>fault==='wrong-owner'?{...value,ownerId:id(99999)}:{};
  await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'commit'});
  await expect(page.getByRole('button',{name:'Retry matters',exact:true})).toBeVisible();await expect(rows(page,'active')).toHaveCount(0);await expect(page.locator('[data-case-count="active"]')).toHaveText('—');
});

test('an archived Matter highlight selects its older page and preserves that page on reload',async({page})=>{
  await install(page);await page.goto(`/dashboard-attorney.html?highlightCase=${id(1001)}#cases:archived`,{waitUntil:'commit'});await ready(page,'archived');
  await expect(rows(page,'archived').filter({hasText:'Matter 1001'})).toBeVisible();await expect(page).toHaveURL(/archivedPage=7/);await expect(page).not.toHaveURL(/highlightCase/);
  await expect(page.locator('[data-page-info="archived"]')).toHaveText('91–102 of 102');
  await page.reload();await ready(page,'archived');await expect(rows(page,'archived').filter({hasText:'Matter 1001'})).toBeVisible();
});

test('an older Applicants direct link opens only its selected Matter after inventory arrives',async({page})=>{
  await install(page);const caseId=id(2001);let reads=0;
  await page.route(`**/api/cases/${caseId}/applicants`,route=>{reads++;return route.fulfill({contentType:'application/json',body:'[]'});});
  await page.goto(`/dashboard-attorney.html?openApplicants=1&caseId=${caseId}#cases:inquiries`,{waitUntil:'commit'});await ready(page,'inquiries');
  await expect(page.locator(`[data-applicants-row][data-case-id="${caseId}"]`)).toBeVisible();await expect(page).toHaveURL(/inquiriesPage=7/);await expect(page).not.toHaveURL(/openApplicants/);expect(reads).toBe(1);
});

test('a removed final Matter page explains the change and offers the available last page',async({page})=>{
  const {data}=await install(page);await page.goto('/dashboard-attorney.html?activePage=7#cases:active',{waitUntil:'commit'});await ready(page,'active');
  data.active=data.active.slice(0,20);await page.locator('[data-matters-refresh="active"]').click();
  await expect(page.getByRole('button',{name:'Go to the last page',exact:true})).toBeVisible();await expect(rows(page,'active')).toHaveCount(0);
  await page.getByRole('button',{name:'Go to the last page',exact:true}).click();await ready(page,'active');await expect(rows(page,'active')).toHaveCount(5);await expect(page).toHaveURL(/activePage=2/);
});

test('a delayed prior query cannot replace the selected Matter search',async({page})=>{
  const {state,data,owner}=await install(page);let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{const value=await inventoryFixture(data,owner,url.searchParams);if(url.searchParams.get('view')==='active'&&!url.searchParams.get('q')){arrived();await gate;}await route.fulfill({contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});};
  try {await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'commit'});await pending;await page.locator('[data-cases-search]').fill('Matter 0001');await ready(page,'active');await expect(rows(page,'active')).toHaveCount(1);release();await expect(rows(page,'active')).toContainText('Matter 0001');} finally {release();}
});

test('the complete Matter list and its controls do not wait for unrelated legacy summaries',async({page})=>{
  await install(page);let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/cases/my?**',async route=>{await gate;await route.fulfill({contentType:'application/json',body:'[]'}).catch(()=>{});});
  await page.route('**/api/applications/my-postings*',async route=>{await gate;await route.fulfill({contentType:'application/json',body:'[]'}).catch(()=>{});});
  try {
    await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'domcontentloaded'});await ready(page,'active');await expect(rows(page,'active')).toHaveCount(15);
    await page.locator('[data-cases-search]').fill('Matter 0001');await ready(page,'active');await expect(rows(page,'active')).toHaveCount(1);
    const menu=rows(page,'active').getByRole('button',{name:/More actions/});await menu.click();release();await expect(menu).toHaveAttribute('aria-expanded','true');
  } finally {release();}
});

for (const duringRead of [false, true, 'pointer']) test(`notification refresh preserves the open applicant panel ${duringRead === 'pointer' ? 'when its refresh lands during the opening click' : duringRead ? 'when its summary read is already pending' : 'and resumes after it closes'}`, async ({page}) => {
  const {state}=await install(page), caseId=id(2104);
  // The explicit notification below owns this held-read scenario; unrelated
  // notifications from earlier cases must not start it before the hold exists.
  await page.route('**/api/notifications',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route(`**/api/cases/${caseId}/applicants`, route=>route.fulfill({contentType:'application/json',body:JSON.stringify({_id:caseId,applicants:[]})}));
  await page.goto('/dashboard-attorney.html#cases:inquiries',{waitUntil:'domcontentloaded'});await ready(page,'inquiries');
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  if(duringRead) await page.route('**/api/cases/inventory/home?**',async route=>{arrived();await gate;await route.fallback();});
  const notify=()=>page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed',{detail:{types:['application_submitted']}})));
  try {
    if(duringRead){await notify();await pending;}
    const toggle=rows(page,'inquiries').filter({has:page.locator(`[data-applicants-toggle][data-case-id="${caseId}"]`)}).getByRole('button',{name:'Review 1 applicant',exact:true});
    if(duringRead==='pointer') {
      const bounds=await toggle.boundingBox(),control=await toggle.elementHandle();
      await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();release();
      await page.waitForTimeout(1000);expect(await control.evaluate(node=>node.isConnected)).toBe(true);await page.mouse.up();
    } else await toggle.click();
    const drawer=page.locator(`[data-applicants-row][data-case-id="${caseId}"]`);await expect(drawer).toBeVisible();await expect(drawer).toContainText('No applications yet.');
    const selected=await drawer.elementHandle(),before=state.reads.filter(read=>read.view==='applications').length;
    if(duringRead)release();else await notify();
    // Exercise the actual 400ms notification debounce without another user action.
    await page.waitForTimeout(1000);
    expect(await selected.evaluate(node=>node.isConnected)).toBe(true);await expect(drawer).toBeVisible();
    expect(state.reads.filter(read=>read.view==='applications')).toHaveLength(before);
    await drawer.getByRole('button',{name:'Close applicants',exact:true}).click();
    await expect.poll(()=>state.reads.filter(read=>read.view==='applications').length).toBeGreaterThan(before);
    await ready(page,'inquiries');await expect(rows(page,'inquiries')).toHaveCount(15);
  } finally {release();if(duringRead==='pointer')await page.mouse.up();}
});

test('account departure clears Matter rows and cannot be undone by a delayed refresh',async({page})=>{
  const {state,data,owner}=await install(page);await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'commit'});await ready(page,'active');
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{const value=await inventoryFixture(data,owner,url.searchParams);arrived();await gate;await route.fulfill({contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});};
  try {await page.locator('[data-matters-refresh="active"]').click();await pending;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:user-updated',{detail:{id:'f'.repeat(24),role:'attorney'}})));await expect(rows(page,'active')).toHaveCount(0);release();await expect(page.getByRole('button',{name:'Retry matters',exact:true})).toBeVisible();await expect(rows(page,'active')).toHaveCount(0);} finally {release();}
});

test('refresh leaves focus on the selected category when the person moves during its read',async({page})=>{
  const {state,data,owner}=await install(page);
  // This scenario holds a manual refresh. Notifications for unrelated records
  // created by other scenarios must not consume that deliberate hold first;
  // notification-driven timing has its own explicit cases above.
  await page.route('**/api/notifications',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'commit'});await ready(page,'active');
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{const value=await inventoryFixture(data,owner,url.searchParams);if(url.searchParams.get('view')==='active'){arrived();await gate;}await route.fulfill({contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});};
  try {await page.locator('[data-matters-refresh="active"]').click();await pending;const archived=page.locator('[data-case-filter="archived"]');await archived.focus();await archived.press('Enter');await ready(page,'archived');release();await expect(archived).toBeFocused();await expect(rows(page,'archived')).toHaveCount(15);} finally {release();}
});

test('current inventory refresh and recovery controls remain usable in both themes and enlarged text',async({page},info)=>{
  test.setTimeout(120000);const {state}=await install(page);await page.goto('/dashboard-attorney.html?archivedPage=7#cases:archived',{waitUntil:'commit'});await ready(page,'archived');
  for(const [width,theme,text] of [[1440,'light','100%'],[390,'dark','100%'],[320,'dark','200%']]) {
    await page.setViewportSize({width,height:1000});await page.evaluate(({theme,text})=>{window.applyThemePreference(theme);document.documentElement.style.fontSize=text;},{theme,text});await page.waitForTimeout(350);
    const refresh=page.locator('[data-matters-refresh="archived"]');await refresh.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(Math.round((await refresh.boundingBox()).height*1000)/1000).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({page}).include('#matter-panel-archived').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`archived-${width}-${theme}-${text}.png`),fullPage:true});
  }
  state.failures.archived=503;await page.locator('[data-matters-refresh="archived"]').click();await expect(page.getByRole('button',{name:'Retry matters',exact:true})).toBeVisible();
  await expect(page.locator('[data-matters-refresh="archived"]')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('unavailable-320-dark-200.png'),fullPage:true});
});

test('Matter selection stays out of background financial history while a Payments link keeps its exact selection',async({page})=>{
  await install(page);const reads=[];
  await page.route('**/api/payments/attorney-financial-history?**',route=>{reads.push(Object.fromEntries(new URL(route.request().url()).searchParams));return route.fulfill({status:503,contentType:'application/json',body:'{}'});});
  await page.goto(`/dashboard-attorney.html?highlightCase=${id(1001)}&q=Matter#cases:archived`,{waitUntil:'commit'});await ready(page,'archived');
  await expect.poll(()=>reads.length).toBeGreaterThan(0);expect(reads.every(read=>!read.caseId&&!read.q)).toBe(true);
  reads.length=0;await page.goto(`/dashboard-attorney.html?highlightCase=${id(1001)}&q=Matter#funds`,{waitUntil:'commit'});
  await expect.poll(()=>reads.some(read=>read.caseId===id(1001)&&read.q==='Matter')).toBe(true);await expect(page).not.toHaveURL(/login.html/);
});

test('an actual archived Matter leaves the active inventory even when both legacy summary refreshes fail',async({page})=>{
  const {randomUUID}=require('node:crypto'),title=`Inventory archive ${randomUUID()}`;
  const user=(await(await page.request.get('/api/auth/me')).json()).user,owner=user.id||user._id;
  async function api(method,path,data){const csrf=await(await page.request.get('/api/csrf')).json();const response=await page.request[method](path,{headers:{'X-CSRF-Token':csrf.csrfToken},data:{...data,expectedOwnerId:owner}});expect(response.ok(),await response.text()).toBe(true);return response.json();}
  const {draft}=await api('post','/api/case-drafts',{title,practiceArea:'Contract Law',state:'New York',compAmount:'400.01',experience:'3+ years',deadline:'2027-03-14',description:'Private synthetic inventory reconciliation.',tasks:[{title:'Prepare agreement'}]});
  const {publication}=await api('post','/api/cases/posting/publications',{draftId:draft.id,revision:draft.revision,requestId:randomUUID(),practiceArea:'contract law'});
  await page.goto(`/dashboard-attorney.html?q=${encodeURIComponent(title)}#cases:active`,{waitUntil:'commit'});await ready(page,'active');
  const selected=rows(page,'active').filter({hasText:title});await expect(selected).toHaveCount(1);await selected.locator('[data-case-menu-trigger]').click();await selected.getByRole('button',{name:'Archive Matter',exact:true}).click();
  const panel=page.locator('[data-matter-archive]');await expect(panel).toHaveAttribute('data-state','ready');await panel.getByRole('button',{name:'Review archive change',exact:true}).click();
  await page.route('**/api/cases/my?**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  await panel.getByRole('button',{name:'Archive Matter',exact:true}).click();await expect(panel).toContainText('Your archive change was recorded.');
  await page.locator('#caseNoteModal').getByRole('button',{name:'Close',exact:true}).click();await ready(page,'active');await expect(rows(page,'active')).toHaveCount(0);
  await page.locator('[data-case-filter="archived"]').click();await ready(page,'archived');await expect(rows(page,'archived')).toHaveCount(1);await expect(rows(page,'archived')).toHaveAttribute('data-case-id',publication.caseId);
});

for (const depart of [false, true]) test(`notification refresh preserves pager focus without stealing a later choice: ${depart}`, async ({ page }) => {
  const { state, data, owner } = await install(page);
  await page.route('**/api/notifications', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto('/dashboard-attorney.html?archivedPage=7#cases:archived', { waitUntil: 'domcontentloaded' });
  await ready(page, 'archived');
  await expect(page.locator('[data-page-info="archived"]')).toHaveText('91–102 of 102');
  const back = page.locator('[data-page-target="archived"][data-page-action="prev"]');
  await back.focus();
  await back.press('Enter');
  await ready(page, 'archived');
  await expect(back).toBeFocused();
  await expect(page.locator('[data-page-info="archived"]')).toHaveText('76–90 of 102');
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { arrived = resolve; });
  state.respond = async (route, url) => {
    const value = await inventoryFixture(data, owner, url.searchParams);
    if (url.searchParams.get('view') === 'archived') { arrived(); await held; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) }).catch(() => {});
  };
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed', { detail: { types: ['application_submitted'] } })));
    await pending;
    const chosen = page.locator('[data-case-filter="archived"]');
    if (depart) { await chosen.focus(); await expect(chosen).toBeFocused(); }
    release();
    await ready(page, 'archived');
    await expect(page.locator('[data-page-info="archived"]')).toHaveText('76–90 of 102');
    await expect(depart ? chosen : back).toBeFocused();
    await expect(rows(page, 'archived')).toHaveCount(15);
    await expect(page).toHaveURL(/archivedPage=6/);
    expect(state.errors).toEqual([]);
  } finally { release(); }
});

// Preserve every native report and actual document failure for the three reload
// journeys. Only the precisely reproduced archived departure can be classified.
async function observeInventoryReload(page, info) {
  const observed = { engine: info.project.name, origin: new URL(info.project.use.baseURL).origin, errors: [], events: [] };
  reloadObservations.set(info.testId, observed);
  await page.addInitScript(() => {
    const documentId = crypto.randomUUID();
    const report = (type, detail = {}) => console.debug('LPC_INVENTORY_RELOAD ' + JSON.stringify({ documentId, type, page: location.href, at: Date.now(), ...detail }));
    for (const type of ['beforeunload','pagehide','pageshow']) addEventListener(type, event => report(type, { persisted: event.persisted }));
    addEventListener('error', event => report('windowerror', { message: event.message, filename: event.filename, stack: event.error?.stack }));
    addEventListener('unhandledrejection', event => report('unhandledrejection', { message: String(event.reason), stack: event.reason?.stack }));
  });
  page.on('pageerror', error => observed.errors.push({ role: 'attorney', name: error.name, message: error.message, stack: error.stack, page: page.url(), at: Date.now() }));
  page.on('console', message => {
    const prefix = 'LPC_INVENTORY_RELOAD ';
    if (message.text().startsWith(prefix)) observed.events.push({ role: 'attorney', ...JSON.parse(message.text().slice(prefix.length)) });
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) observed.events.push({ role: 'attorney', type: 'navigation', page: frame.url(), at: Date.now() }); });
  return observed;
}
test.afterEach(async ({}, info) => {
  const observed = reloadObservations.get(info.testId);
  if (!observed) return;
  await info.attach('inventory-reload-browser-diagnostics.json', { body: Buffer.from(JSON.stringify({ ...observed, diagnostics: inspectBrowserDiagnostics(observed) }, null, 2)), contentType: 'application/json' });
  reloadObservations.delete(info.testId);
});

// Keep background status layout from moving the native Matter-menu press.
const applicationStatusPressObservations = new Map();
test.afterEach(async ({}, info) => {
  await info.attach('menu-layout-observation.json', {body:Buffer.from(JSON.stringify({project:info.project.name,status:info.status,...applicationStatusPressObservations.get(info.testId)},null,2)),contentType:'application/json'});
  applicationStatusPressObservations.delete(info.testId);
});
for(const {width,outcome} of [{width:390,outcome:'success'},{width:1366,outcome:'success'},{width:390,outcome:'failure'},{width:390,outcome:'account-change'}]) test(`application ${outcome} keeps the pressed menu target safe at ${width}px`,async({page},info)=>{
  const {state,owner}=await install(page);
  const observed={width,outcome,held:0,delivered:0};applicationStatusPressObservations.set(info.testId,observed);
  await page.route('**/api/notifications',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/applications/my-postings*',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.setViewportSize({width,height:900});
  await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'domcontentloaded'});
  await ready(page,'active');await expect(rows(page,'active')).toHaveCount(15);
  const caseId=await rows(page,'active').first().getAttribute('data-case-id');
  await page.route(new RegExp('/api/cases/'+caseId+'/downloads[?]'),route=>route.fulfill({contentType:'application/json',body:JSON.stringify({caseId,ownerId:owner,caseTitle:'Synthetic menu Matter',access:'available',legacyAttachments:false,files:[],nextCursor:null})}));
  const actions=page.locator(`.case-actions[data-case-id="${caseId}"]`),trigger=actions.locator('[data-case-menu-trigger]'),action=actions.getByRole('button',{name:'Download Files',exact:true});
  // Use the normal file dialog to establish its existing owner-bound parent read.
  await trigger.click();await action.click();await expect(page.locator('[data-matter-downloads]')).toHaveAttribute('data-state','ready');
  await page.locator('#caseNoteModal').getByRole('button',{name:'Close',exact:true}).click();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/applications/my-postings*',async route=>{observed.held++;await gate;await route.fulfill({status:outcome==='failure'?503:200,contentType:'application/json',body:'[]'}).catch(()=>{});observed.delivered++;});
  try{
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed',{detail:{types:['application_submitted']}})));
    await expect.poll(()=>observed.held).toBeGreaterThan(0);
    const status=page.locator('[data-application-parent-status]'),wrapper=page.locator('[data-cases-wrapper]');
    await expect(status).toHaveText('Updating applications…');await expect(status).toBeVisible();
    await trigger.scrollIntoViewIfNeeded();const original=await trigger.elementHandle(),before=await trigger.boundingBox();
    observed.layoutBefore=await actions.boundingBox();
    await page.mouse.move(before.x+before.width/2,before.y+before.height/2);await page.mouse.down();
    if(outcome==='account-change') {
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:user-updated',{detail:{id:'0'.repeat(24),role:'attorney'}})));
      await expect(rows(page,'active')).toHaveCount(0);await expect(status).toBeHidden();
      release();await expect.poll(()=>observed.delivered).toBeGreaterThan(0);await page.mouse.up();
      await expect(rows(page,'active')).toHaveCount(0);await expect(status).toBeHidden();
      await expect(page.locator('[data-matter-downloads]')).toHaveCount(0);expect(state.errors).toEqual([]);return;
    }
    release();await expect.poll(()=>observed.delivered).toBeGreaterThan(0);
    await expect(wrapper).not.toHaveAttribute('aria-busy','true');
    const after=await trigger.boundingBox();observed.layoutAfter=await actions.boundingBox();observed.before=before;observed.after=after;observed.connected=await original.evaluate(n=>n.isConnected);observed.statusVisible=await status.isVisible();
    // The native pointer stays at its original coordinates until mouseup.
    await page.mouse.up();observed.expanded=await trigger.getAttribute('aria-expanded');
    expect(observed.connected).toBe(true);expect(observed.layoutAfter.y).toBe(observed.layoutBefore.y);
    await expect(trigger).toHaveAttribute('aria-expanded','true');await expect(action).toBeVisible();
    if(outcome==='failure') {
      await expect(status).toContainText('Applications could not be refreshed.');
      await expect(status.getByRole('button',{name:'Retry',exact:true})).toBeEnabled();
    } else await expect(status).toBeHidden();
    await action.click();await expect(page.locator('[data-matter-downloads]')).toHaveAttribute('data-state','ready');
    expect(state.errors).toEqual([]);
  }finally{release();await page.mouse.up();}
});

// Protect menu targeting before the native press as background reads settle.
const applicationStatusHoverObservations = new Map();
test.afterEach(async ({}, info) => {
  await info.attach('menu-hover-observation.json', {body:Buffer.from(JSON.stringify({project:info.project.name,status:info.status,...applicationStatusHoverObservations.get(info.testId)},null,2)),contentType:'application/json'});
  applicationStatusHoverObservations.delete(info.testId);
});
for(const {width,outcome,departure} of [
  {width:390,outcome:'success'}, {width:1366,outcome:'success'},
  {width:390,outcome:'failure'}, {width:1366,outcome:'failure'},
  {width:390,outcome:'failure',departure:'leave'}, {width:390,outcome:'success',departure:'account-change'},
]) test(`application ${outcome} keeps the hovered menu target in place before a press at ${width}px${departure ? ' then '+departure : ''}`,async({page},info)=>{
  const {state,owner}=await install(page);
  const observed={width,outcome,departure,held:0,delivered:0};applicationStatusHoverObservations.set(info.testId,observed);
  await page.route('**/api/notifications',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/applications/my-postings*',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.setViewportSize({width,height:900});
  await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'domcontentloaded'});
  await ready(page,'active');await expect(rows(page,'active')).toHaveCount(15);
  const caseId=await rows(page,'active').first().getAttribute('data-case-id');
  await page.route(new RegExp('/api/cases/'+caseId+'/downloads[?]'),route=>route.fulfill({contentType:'application/json',body:JSON.stringify({caseId,ownerId:owner,caseTitle:'Synthetic menu Matter',access:'available',legacyAttachments:false,files:[],nextCursor:null})}));
  const actions=page.locator(`.case-actions[data-case-id="${caseId}"]`),trigger=actions.locator('[data-case-menu-trigger]'),action=actions.getByRole('button',{name:'Download Files',exact:true});
  // Use the normal file dialog to establish its existing owner-bound parent read.
  await trigger.click();await action.click();await expect(page.locator('[data-matter-downloads]')).toHaveAttribute('data-state','ready');
  await page.locator('#caseNoteModal').getByRole('button',{name:'Close',exact:true}).click();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/applications/my-postings*',async route=>{observed.held++;await gate;await route.fulfill({status:outcome==='failure'?503:200,contentType:'application/json',body:'[]'}).catch(()=>{});observed.delivered++;});
  try{
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed',{detail:{types:['application_submitted']}})));
    await expect.poll(()=>observed.held).toBeGreaterThan(0);
    const status=page.locator('[data-application-parent-status]'),wrapper=page.locator('[data-cases-wrapper]');
    await expect(status).toHaveText('Updating applications…');await expect(status).toBeVisible();
    await trigger.scrollIntoViewIfNeeded();const original=await trigger.elementHandle(),before=await trigger.boundingBox();
    await trigger.evaluate(target=>{
      const status=document.querySelector('[data-application-parent-status]');window.__menuHoverEvents=[];
      const note=(type,event)=>window.__menuHoverEvents.push({type,time:performance.now(),target:event?.target===target?'trigger':event?.target?.tagName||null,hidden:status.hidden,y:target.getBoundingClientRect().y,expanded:target.getAttribute('aria-expanded')});
      for(const type of ['pointerover','pointermove','pointerdown','mousedown','pointerup','mouseup','click']) document.addEventListener(type,event=>note(type,event),true);
      new MutationObserver(()=>note('status-mutation')).observe(status,{attributes:true,childList:true,subtree:true,characterData:true});
    });
    observed.layoutBefore=await actions.boundingBox();
    await page.mouse.move(before.x+before.width/2,before.y+before.height/2);
    if(departure==='account-change') {
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:user-updated',{detail:{id:'0'.repeat(24),role:'attorney'}})));
      await expect(rows(page,'active')).toHaveCount(0);await expect(status).toBeHidden();
      release();await expect.poll(()=>observed.delivered).toBeGreaterThan(0);
      await expect(rows(page,'active')).toHaveCount(0);await expect(status).toBeHidden();
      await expect(page.locator('[data-matter-downloads]')).toHaveCount(0);expect(state.errors).toEqual([]);return;
    }
    release();await expect.poll(()=>observed.delivered).toBeGreaterThan(0);
    await expect(wrapper).not.toHaveAttribute('aria-busy','true');
    const after=await trigger.boundingBox();observed.layoutAfter=await actions.boundingBox();observed.before=before;observed.after=after;observed.connected=await original.evaluate(n=>n.isConnected);observed.statusVisible=await status.isVisible();
    if(departure==='leave') {
      expect(observed.layoutAfter.y).toBe(observed.layoutBefore.y);
      await page.mouse.move(0,0);
      await expect(status).toContainText('Applications could not be refreshed.');
      await expect(status.getByRole('button',{name:'Retry',exact:true})).toBeEnabled();
      await expect(trigger).toHaveAttribute('aria-expanded','false');
      await trigger.click();await expect(action).toBeVisible();
      await action.click();await expect(page.locator('[data-matter-downloads]')).toHaveAttribute('data-state','ready');
      expect(state.errors).toEqual([]);return;
    }
    // The native pointer stays at its original coordinates from hover through the later press.
    await page.mouse.down();await page.mouse.up();observed.expanded=await trigger.getAttribute('aria-expanded');observed.events=await page.evaluate(()=>window.__menuHoverEvents);
    expect(observed.connected).toBe(true);expect(observed.layoutAfter.y).toBe(observed.layoutBefore.y);
    await expect(trigger).toHaveAttribute('aria-expanded','true');await expect(action).toBeVisible();
    if(outcome==='failure') {
      await expect(status).toContainText('Applications could not be refreshed.');
      await expect(status.getByRole('button',{name:'Retry',exact:true})).toBeEnabled();
    } else await expect(status).toBeHidden();
    await action.click();await expect(page.locator('[data-matter-downloads]')).toHaveAttribute('data-state','ready');
    expect(state.errors).toEqual([]);
  }finally{release();await page.mouse.up();}
});
