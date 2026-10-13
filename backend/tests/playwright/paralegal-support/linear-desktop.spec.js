const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
test.use({ actionTimeout: 15000 });
const { FIRST, SECOND, LONG, active, installCurrentHome: fixture, home, expectSameDocument, tab, view } = require('./current-home-fixtures');
const detail = page => page.getByRole('region', { name: 'Record details', exact: true });
const title = page => page.locator('[data-home-detail-title]');
const row = (page, id) => page.locator(`[data-home-matter-id="${id}"]`);

test('inline Matter links remain readable throughout light and dark theme changes',async({page},info)=>{
 await fixture(page);await home(page,'?view=matters');await page.getByRole('button',{name:'Affidavit chronology review',exact:true}).click();
 const target=detail(page).getByRole('link',{name:'Open workspace',exact:true});await target.scrollIntoViewIfNeeded();
 const frames=await target.evaluate(async element=>{
  const rgb=value=>{const numbers=value.match(/[\d.]+/g).map(Number);return [...numbers.slice(0,3),numbers[3]??1];};
  const blend=(front,back)=>front.slice(0,3).map((value,index)=>value*front[3]+back[index]*(1-front[3]));
  const luminance=color=>color.slice(0,3).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const results=[];
  for(const theme of ['dark','light']){
   for(const node of [document.documentElement,document.body]){node.classList.remove('theme-dark','theme-light');node.classList.add('theme-'+theme);}
   const start=performance.now();
   while(performance.now()-start<220){await new Promise(requestAnimationFrame);const colors=[];for(let node=element;node;node=node.parentElement)colors.unshift(rgb(getComputedStyle(node).backgroundColor));let background=[255,255,255];for(const color of colors)background=blend(color,background);const foreground=blend(rgb(getComputedStyle(element).color),background),a=luminance(foreground),b=luminance(background);results.push({theme,elapsed:performance.now()-start,foreground,background,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});}
  }
  return results;
 });
 await info.attach('theme-contrast-frames',{body:JSON.stringify(frames,null,2),contentType:'application/json'});
 expect(frames.length).toBeGreaterThan(8);expect(frames.filter(frame=>frame.contrast<4.5)).toEqual([]);
});

test('Matter overview shows each fact once and keeps its chooser and workspace destinations coherent', async ({page}, info) => {
 const state=await fixture(page);await home(page,'?view=document');
 const initialReads=structuredClone(state.protectedReads);
 const overview=page.locator('.ld-document');
 await expect(overview.getByRole('heading',{name:LONG,exact:true})).toHaveCount(1);
 await expect(page.locator('.ph-desktop').getByText(LONG,{exact:true})).toHaveCount(1);
 for(const fact of ['Civil Litigation','In progress','Jordan Lee']) await expect(overview.getByText(fact,{exact:true})).toHaveCount(1);
 await expect(overview.getByText('3 of 5 work items complete',{exact:true})).toHaveCount(1);
 await expect(page.locator('.ph-desktop').getByRole('tab')).toHaveCount(0);
 const links=overview.getByRole('navigation',{name:'Matter workspace'});
 for(const [label,target] of [['Open workspace','overview'],['Files & submissions','files'],['Messages','messages'],['Deadlines','deadlines']])await expect(links.getByRole('link',{name:label,exact:true})).toHaveAttribute('href',`paralegal-v2.html#/matter/${FIRST}?tab=${target}`);
 await page.getByRole('button',{name:'Show properties',exact:true}).click();await expect(overview.locator('dl')).toBeHidden();await expect(links).toBeVisible();
 const properties=page.getByRole('button',{name:'Show properties',exact:true});
 await properties.focus();await page.keyboard.press('Space');await expect(overview.locator('dl')).toBeVisible();await expect(properties).toBeFocused();
 await page.keyboard.press('Space');await expect(overview.locator('dl')).toBeHidden();await expect(links).toBeVisible();await expect(properties).toBeFocused();
 await page.keyboard.press('Space');await expect(overview.locator('dl')).toBeVisible();
 await page.getByRole('button',{name:'Choose matter',exact:true}).click();
 const chooser=page.getByRole('navigation',{name:'Choose matter',exact:true});
 await chooser.getByRole('button',{name:LONG,exact:true}).focus();await page.keyboard.press('Escape');await expect(chooser).toHaveCount(0);await expect(page.getByRole('button',{name:'Choose matter',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'Choose matter',exact:true}).click();await chooser.getByRole('button',{name:'Affidavit chronology review',exact:true}).click();
 await expect(overview.getByRole('heading',{name:'Affidavit chronology review',exact:true})).toBeFocused();
 await expect(links.getByRole('link',{name:'Open workspace',exact:true})).toHaveAttribute('href',`paralegal-v2.html#/matter/${SECOND}?tab=overview`);
 await expect(overview.getByText('5 of 5 work items complete',{exact:true})).toHaveCount(1);
 await overview.screenshot({path:info.outputPath('selected-overview.png')});
 expect(state.protectedReads).toEqual(initialReads);expect(state.mutations).toEqual([]);await expectSameDocument(page,state);
});

test('Matter overview fits long facts and preserves every destination in light dark and doubled text',async({page},info)=>{
 const state=await fixture(page);await home(page,'?view=document');
 const initialReads=structuredClone(state.protectedReads);
 for(const theme of ['light','dark'])for(const width of [1440,320]){
  await page.setViewportSize({width,height:960});await page.evaluate(({theme,width})=>{document.documentElement.style.fontSize=width===320?'200%':'';for(const element of [document.documentElement,document.body]){element.classList.remove('theme-light','theme-dark');element.classList.add('theme-'+theme);}}, {theme,width});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const overview=page.locator('.ld-document');await overview.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({page}).include('.ph-desktop').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await overview.screenshot({path:info.outputPath(`overview-${theme}-${width}.png`)});
  for(const link of await overview.getByRole('link').all()){await link.focus();await expect(link).toBeInViewport();const bounds=await link.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);}
 }
 expect(state.protectedReads).toEqual(initialReads);expect(state.mutations).toEqual([]);
});

for(const condition of ['empty','unavailable','unfunded','sparse'])test(`Matter overview keeps ${condition} distinct without empty preview filler`,async({page})=>{
 const overrides=condition==='empty'?{dashboard:{activeCases:[],metrics:{}}}:condition==='unavailable'?{failures:{dashboard:503}}:{dashboard:{activeCases:[active(condition==='unfunded'?{escrowStatus:'pending',escrowIntentId:null}:{practiceArea:'',attorneyName:'',latestUpdate:'',latestFileName:'',tasksTotal:null,tasksRemaining:null,deadlineDate:null})],metrics:{}}};
 const state=await fixture(page,overrides);await home(page,'?view=document');const root=page.locator('.ph-desktop');
 await expect(root).not.toContainText('included in this preview');await expect(root).not.toContainText('No labels recorded');
 if(condition==='empty'){await expect(root.getByText('No active matters.',{exact:true})).toHaveCount(1);await expect(root.getByRole('button',{name:'Choose matter',exact:true})).toHaveCount(0);}
 if(condition==='unavailable'){await expect(root.getByText('No active matters.',{exact:true})).toHaveCount(0);await expect(root.getByText('Matter overview could not be loaded.',{exact:true})).toBeVisible();await expect(root).not.toContainText('Showing the verified information');delete state.failures.dashboard;await root.getByRole('button',{name:'Try again',exact:true}).click();await expect(root.locator('.ld-document')).toBeVisible();}
 if(condition==='unfunded'){await expect(root.locator('a[href*="/matter/"]')).toHaveCount(0);await expect(root.getByRole('link',{name:'Review matter',exact:true})).toHaveAttribute('href','paralegal-v2.html#/work');}
 if(condition==='sparse'){await expect(root.locator('.ld-document-update')).toHaveCount(0);await expect(root.locator('.ld-document-facts dt')).toHaveText(['Status']);await expect(root.locator('.ld-document-progress')).toHaveCount(0);}
 const expectedIds=condition==='unavailable'?[FIRST,SECOND]:condition==='sparse'?[FIRST]:[];
 await expect.poll(()=>state.protectedReads.map(item=>({path:item.path,method:item.method}))).toEqual(expectedIds.map(id=>({path:`/api/uploads/case/${id}`,method:'GET'})));
 expect(state.mutations).toEqual([]);
});

test('Matter overview loading is distinct from empty and unavailable results',async({page},info)=>{
 await fixture(page);let release;const held=new Promise(resolve=>{release=resolve;});
 await page.route(url=>url.pathname==='/api/paralegal/dashboard',async route=>{await held;await route.fallback();});
 try{
  await page.goto('/paralegal-v2.html#/home?view=document');const root=page.locator('.ph-desktop');
  await expect(root.getByText('Loading matter overview…',{exact:true})).toBeVisible();
  await expect(root.getByText('No active matters.',{exact:true})).toHaveCount(0);await expect(root.getByText('Matter overview could not be loaded.',{exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('overview-loading.png')});
 }finally{release();}
 await expect(page.locator('.ld-document')).toBeVisible();await expect(page.getByText('Loading matter overview…',{exact:true})).toHaveCount(0);
});
// Retains the eight earlier desktop journeys against the current workspace.
// Board/table detail still owns traversal, sorting, favorites and Copy link;
// My work owns the new list-and-context flow. No retired skin is reintroduced.

test('desktop frame keeps LPC type, colors and bounded large-screen geometry', async ({ page }, info) => {
 await fixture(page); await home(page);
 for (const width of [1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  expect((await page.locator('.v2-sidebar').boundingBox()).width).toBe(230);
  const rail = await page.locator('.v2-sidebar').boundingBox(), frame = await page.locator('[data-v2-persistent="application-frame"]').boundingBox();
  expect(frame.x).toBeGreaterThanOrEqual(rail.x + rail.width); expect(frame.x + frame.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.lc-heading h1')).toHaveText('My work');
  const style = await page.locator('.lc-workspace').evaluate(el => ({ family: getComputedStyle(el).fontFamily, background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, loaded: document.fonts.check('14px Sarabun') }));
  expect(style.family).toContain('Sarabun'); expect(style).toMatchObject({ background: 'rgb(255, 255, 255)', color: 'rgb(26, 31, 54)', loaded: true });
  await page.screenshot({ path: info.outputPath(`current-home-${width}.png`) });
 }
});

test('row selection keeps the list, loads authorized context and returns focus across widths', async ({ page }, info) => {
 const state = await fixture(page); await page.setViewportSize({ width: 1440, height: 1000 }); await home(page);
 expect(state.protectedReads.filter(r => r.path.startsWith('/api/cases/'))).toEqual([]);
 await row(page, FIRST).click(); await expect(title(page)).toHaveText(LONG); await expect(title(page)).toBeFocused();
 await expect(detail(page)).toContainText('Prepare a verified chronology'); await expect(page.locator('.lc-list')).toBeVisible();
 await row(page, SECOND).click(); await expect(title(page)).toHaveText('Affidavit chronology review'); await expect(detail(page)).toContainText('Review the verified affidavit chronology.');
 await page.getByRole('button', { name: 'Close details', exact: true }).click(); await expect(row(page, SECOND)).toBeFocused();
 for (const width of [320, 768, 1920]) {
  await page.setViewportSize({ width, height: 1000 }); await row(page, FIRST).click(); await expect(detail(page)).toContainText('Prepare a verified chronology');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await detail(page).boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  await page.screenshot({ path: info.outputPath(`current-context-${width}.png`) });
  await page.getByRole('button', { name: width <= 1100 ? 'Back to list' : 'Close details', exact: true }).click(); await expect(row(page, FIRST)).toBeFocused();
 }
 expect(state.mutations.filter(path => /\/api\/(cases|uploads|messages)\//.test(path))).toEqual([]);
 const scan = await new AxeBuilder({ page }).include('.lc-workspace').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(scan.violations).toEqual([]);
});

test('keyboard tabs and local filtering retain the current records; board remains usable', async ({ page }, info) => {
 const state = await fixture(page); await page.setViewportSize({ width: 1440, height: 1000 }); await home(page);
 await tab(page, 'Assigned').focus(); await page.keyboard.press('ArrowRight'); await expect(tab(page, 'Invitations')).toBeFocused(); await page.keyboard.press('Enter'); await expect(tab(page, 'Invitations')).toHaveAttribute('aria-selected', 'true');
 await tab(page, 'Assigned').click(); await expect(page.locator('[data-home-matter-id]')).toHaveCount(2);
 await page.getByRole('button', { name: 'Filter records', exact: true }).click(); const filter = page.getByRole('searchbox', { name: 'Filter records', exact: true });
 await filter.fill('Affidavit'); await expect(page.locator('[data-home-matter-id]')).toHaveCount(1); await expect(row(page, SECOND)).toBeVisible();
 await filter.fill('no-such-synthetic-record'); await expect(page.locator('[data-home-matter-id]')).toHaveCount(0); await expect(page.getByText('No matching records.', { exact: true })).toBeVisible();
 await filter.fill(''); await expect(page.locator('[data-home-matter-id]')).toHaveCount(2);
 const reads = state.reads.dashboard; await page.locator('[data-desktop-home-view="board"]').click(); await expect(page.locator('.ph-desktop')).toHaveAttribute('data-desktop-layout', 'board');
 await expect(page.locator('[data-home-matter-id]')).toHaveCount(2);
 await page.getByRole('button', { name: 'Display options', exact: true }).click(); await page.getByRole('combobox', { name: 'Sort Home records', exact: true }).selectOption('title');
 expect(await page.locator('[data-home-matter-id]').evaluateAll(rows => rows.map(row => row.dataset.homeMatterId))).toEqual([SECOND, FIRST]);
 await row(page, SECOND).click(); await expect(title(page)).toHaveText('Affidavit chronology review'); await expect(detail(page).getByRole('button', { name: 'Previous record', exact: true })).toBeDisabled();
 await detail(page).getByRole('button', { name: 'Next record', exact: true }).click(); await expect(title(page)).toHaveText(LONG); await expect(detail(page).getByRole('button', { name: 'Next record', exact: true })).toBeDisabled();
 await detail(page).getByRole('button', { name: 'Previous record', exact: true }).click(); await expect(title(page)).toHaveText('Affidavit chronology review'); await detail(page).getByRole('button', { name: 'Back to list', exact: true }).click();
 for (const width of [1440, 320]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`current-board-${width}.png`) }); }
 await row(page, SECOND).click(); await detail(page).getByRole('button', { name: 'Next record', exact: true }).click(); await expect(title(page)).toHaveText(LONG); await detail(page).getByRole('button', { name: 'Previous record', exact: true }).click(); await expect(title(page)).toHaveText('Affidavit chronology review'); await expect(detail(page)).toContainText('Attorney updated the scope'); await expect(detail(page).getByRole('link', { name: 'Open workspace', exact: true })).toHaveAttribute('href', `paralegal-v2.html#/matter/${SECOND}?tab=overview`); await page.mouse.move(0, 0); await page.screenshot({ path: info.outputPath('current-board-detail-phone.png'), animations: 'disabled' });
 for (const theme of ['light', 'dark']) for (const width of [320, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.evaluate(theme => { document.documentElement.style.fontSize = '20px'; for (const el of [document.documentElement, document.body]) { el.classList.remove('theme-light', 'theme-dark'); el.classList.add(`theme-${theme}`); } }, theme);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[data-home-desktop-detail]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath(`board-detail-${theme}-${width}-large-text.png`), animations: 'disabled' });
 }
 expect(state.reads.dashboard).toBe(reads);
});

test('failed application source stays unavailable through filtering and recovers through retry', async ({ page }) => {
 const state = await fixture(page, { failures: { applications: 503 } }); await home(page); await tab(page, 'Applications').click();
 await expect(page.locator('.lc-source')).toContainText(/could not be loaded/); await expect(tab(page, 'Applications')).toContainText('?');
 await page.getByRole('button', { name: 'Filter records', exact: true }).click(); await page.getByRole('searchbox', { name: 'Filter records', exact: true }).fill('Employment');
 await expect(page.locator('.lc-source')).toContainText(/could not be loaded/); await expect(page.locator('.lc-workspace')).not.toContainText('No records in this view.');
 delete state.failures.applications; await page.locator('.lc-source').getByRole('button', { name: 'Try again', exact: true }).click(); await expect(page.locator('[data-home-application-id]')).toBeVisible();
});

test('sidebar projections retain selected navigation and deadline paging stays local', async ({ page }, info) => {
 const state = await fixture(page); await page.setViewportSize({ width: 1440, height: 1000 }); await home(page);
 for (const name of ['inbox', 'reviews', 'pulse', 'work']) { await view(page, name); await expect(page.locator(`[data-desktop-home-view="${name}"]`)).toHaveAttribute('aria-current', 'page'); }
 await page.locator('[data-desktop-home-view="deadlines"]').click(); await expect(page.locator('[data-home-timeline]')).toBeVisible(); await expect(page.locator('.ld-deadline-marker')).toHaveCount(2);
 const reads = state.reads.dashboard; await page.getByRole('button', { name: 'Next three months', exact: true }).click(); await expect(page.locator('.ld-deadline-marker')).toHaveCount(0); await expect(page.locator('[data-home-timeline]')).toContainText('No deadlines in this period.');
 await page.getByRole('button', { name: 'Today', exact: true }).click(); await expect(page.locator('.ld-deadline-marker')).toHaveCount(2); expect(state.reads.dashboard).toBe(reads);
 await expect(page.locator('[data-home-timeline]').getByRole('link', { name: LONG, exact: true })).toHaveAttribute('href', `paralegal-v2.html#/matter/${FIRST}?tab=deadlines`);
 await page.screenshot({ path: info.outputPath('current-deadlines.png') }); await expectSameDocument(page, state);
});

test('table record Copy link resolves the same current context and Assistant uses the persistent control', async ({ page }) => {
 const state = await fixture(page); await home(page, '?view=matters'); await page.getByRole('button', { name: LONG, exact: true }).click();
 await detail(page).getByRole('button', { name: 'Copy link', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.__desktopCopiedLinks.length)).toBe(1);
 const copied = await page.evaluate(() => window.__desktopCopiedLinks[0]); expect(new URL(copied).hash).toBe(`#/home?view=work&item=matter%3A${FIRST}`); expect(copied).not.toContain('Attorney');
 await detail(page).getByRole('button', { name: 'Open LPC Assistant', exact: true }).click(); await expect(page.locator('[data-v2-persistent="assistant"]')).toHaveAttribute('aria-hidden', 'false'); await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
 expect(state.protectedReads.filter(r => r.path.startsWith('/api/cases/'))).toEqual([]);
 await page.goto(copied); await expect(title(page)).toHaveText(LONG); await expect(detail(page)).toContainText('Prepare a verified chronology');
});

test('unfunded records do not expose workspace access and funded context uses its existing destination', async ({ page }) => {
 const state = await fixture(page, { dashboard: { activeCases: [active(), active({ caseId: SECOND, jobTitle: 'Awaiting funding', escrowStatus: 'pending', escrowIntentId: null })], metrics: {} } });
 state.files[FIRST] = []; await home(page);
 await row(page, SECOND).click(); await expect(detail(page).locator('a[href*="/matter/"]')).toHaveCount(0); await expect(detail(page).getByRole('link')).toHaveAttribute('href', /#\/work/);
 await page.getByRole('button', { name: 'Close details', exact: true }).click(); await row(page, FIRST).click(); await expect(detail(page)).toContainText('Prepare a verified chronology');
 await expect(detail(page).getByRole('link', { name: 'Open full workspace', exact: true })).toHaveAttribute('href', `paralegal-v2.html#/matter/${FIRST}?tab=work`);
 expect(state.protectedReads.some(r => r.path === `/api/cases/${FIRST}`)).toBe(true); expect(state.protectedReads.some(r => r.path === `/api/cases/${SECOND}`)).toBe(false);
 expect(state.mutations.filter(path => /\/api\/(cases|uploads|messages)\//.test(path))).toEqual([]);
});

test('access invalidation removes selected context and shortcuts before restricted data settles', async ({ page }) => {
 const state = await fixture(page); await home(page); await row(page, FIRST).click(); await expect(detail(page)).toContainText('Prepare a verified chronology');
 state.failures.dashboard = 403; await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'synthetic-desktop-access', accessMayChange: true } })));
 await expect(title(page)).toHaveCount(0); await expect(page.locator('[data-v2-home]')).not.toContainText(LONG); await expect(page.locator('[data-v2-desktop-matters]')).not.toContainText(LONG); await expect(page.locator('.lc-source')).toContainText(/access|unavailable|loaded/i);
});
