const { test } = require('../assistant-completion/shell-fixture');
const { fixture: shell, json, OWNER } = require('../assistant-completion/fixture');
const { expect } = require('playwright/test');
const { inventoryFixture } = require('./inventory-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const id = n => n.toString(16).padStart(24, '0');
const row = (n, values = {}) => ({ id: id(n), title: `Matter ${String(n).padStart(4, '0')}`, status: 'open', archived: false, paymentReleased: false, applicantsCount: 0, filesCount: 0, files: [], practiceArea: 'Litigation', totalAmount: 10005, remainingAmount: 10005, currency: 'usd', createdAt: '2026-07-01T12:00:00.000Z', lastActivityAt: '2026-09-28T12:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 7, 1, 0, n)).toISOString(), ...values });
const panel = page => page.locator('[data-av2-region="matter-list"]');
const ready = page => expect(panel(page)).toHaveAttribute('data-state', 'ready');
const refresh = page => panel(page).evaluate(panel => { void panel.refresh({ background: true }); });
const records = page => page.locator('[data-av2-matter]');
function dataSet() { return { active: Array.from({ length: 103 }, (_, i) => row(i + 1)), archived: Array.from({ length: 102 }, (_, i) => row(i + 1001, { status: 'completed', archived: true, paymentReleased: true })), drafts: { items: Array.from({ length: 203 }, (_, i) => row(i + 2001, { title: `Draft ${i + 1}`, status: 'draft', practiceArea: 'Probate' })) }, applications: [], summary: { items: [] } }; }
async function install(page, data = dataSet(), hash = '/matters') {
  const state = { calls: [], writes: [], errors: [], failures: {}, transform: value => value, respond: null };
  page.on('pageerror', error => state.errors.push(error.message));
  await shell(page, 'attorney', { hash, setup: async account => {
    account.user.onboarding.attorneyTourCompleted = true;
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      state.calls.push({ path, method: request.method(), query: Object.fromEntries(url.searchParams) });
      if (request.method() !== 'GET') state.writes.push(path);
      if (path === '/api/auth/workspace-release') return json(route, { workspace: { schemaVersion: 1, ownerId: OWNER, role: 'attorney', revision: 1, version: 'v2', defaultDestination: '/attorney-v2.html#/home' } });
      if (path === '/api/cases/inventory') {
        const view = url.searchParams.get('view') || 'active';
        if (state.respond) return state.respond(route, url);
        if (state.failures[view]) return json(route, {}, state.failures[view]);
        return json(route, state.transform(await inventoryFixture(data, OWNER, url.searchParams)));
      }
      if (path === '/api/applications/my-postings') return json(route, data.applications);
      if (path === '/api/messages/summary') return json(route, data.summary);
      if (path === '/api/account/dashboard-views') return json(route, { ownerId: OWNER, scope: 'attorney_matters', views: [] });
      if (path === '/api/cases/my') return json(route, url.searchParams.get('archived') === 'true' ? data.archived : data.active);
      if (path === '/api/case-drafts') return json(route, data.drafts);
      return route.fallback();
    });
  } });
  await ready(page); return { data, state };
}

test('older current archive and draft pages are reachable with exact complete counts and no capped collection reads', async ({ page }) => {
  const { state } = await install(page);
  for (const [view, total, pages, lastCount] of [['active', 103, 7, 13], ['archived', 102, 7, 12], ['draft', 203, 14, 8]]) {
    await page.goto(`/attorney-v2.html#/matters?view=${view}&page=${pages}`); await ready(page);
    await expect(panel(page)).toContainText(`${total} of ${total} results`);
    await expect(records(page)).toHaveCount(lastCount); await expect(panel(page).getByRole('link', { name: 'Next page', exact: true })).toHaveCount(0);
    await expect(panel(page)).not.toContainText('limited to the latest');
  }
  expect(state.calls.filter(call => ['/api/cases/my', '/api/case-drafts'].includes(call.path))).toEqual([]);
  expect(state.calls.filter(call => call.path === '/api/cases/inventory').every(call => call.query.expectedOwnerId === OWNER)).toBe(true);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test('search and practice filters find older records across the whole inventory and survive reload', async ({ page }) => {
  const data = dataSet(); data.active[0].title = 'Older (estate) [NY]'; data.active[0].practiceArea = 'Estate planning';
  const { state } = await install(page, data);
  await page.getByRole('searchbox', { name: 'Search matters' }).fill('(estate) [NY]');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('combobox', { name: 'Practice area', exact: true }).selectOption('Estate planning');
  await expect(page).toHaveURL(/matterPractice=Estate/); await ready(page);
  await expect(records(page)).toHaveCount(1); await expect(records(page)).toContainText('Older (estate) [NY]');
  await expect(panel(page).getByRole('navigation', { name: 'Matter pages' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply filters', exact: true })).toHaveCount(0);
  await page.reload(); await ready(page); await expect(records(page)).toHaveCount(1);
  await expect(page.getByRole('searchbox', { name: 'Search matters' })).toHaveValue('(estate) [NY]');
  await expect(page.getByRole('button', { name: 'Filters · 1 active', exact: true })).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('combobox', { name: 'Practice area', exact: true })).toHaveValue('Estate planning');
  const calls = state.calls.filter(call => call.path === '/api/cases/inventory');
  expect(calls.at(-1).query).toMatchObject({ q: '(estate) [NY]', practice: 'Estate planning', page: '1' });
});

test('Next Back and refresh preserve the selected page and prior scroll position', async ({ page }) => {
  await install(page); const first = await records(page).first().getAttribute('data-av2-matter');
  await page.locator('main').evaluate(node => { node.scrollTop = 650; });
  const before = await page.locator('main').evaluate(node => node.scrollTop);
  await page.evaluate(() => { location.hash = '/matters?page=2'; }); await ready(page);
  await expect(records(page).first()).not.toHaveAttribute('data-av2-matter', first);
  await page.goBack(); await ready(page); await expect(records(page).first()).toHaveAttribute('data-av2-matter', first);
  await expect.poll(() => page.locator('main').evaluate(node => node.scrollTop)).toBe(before);
  await panel(page).getByRole('link', { name: 'Next page', exact: true }).click(); await ready(page);
  await expect(page).toHaveURL(/page=2/); const second = await records(page).first().getAttribute('data-av2-matter');
  await page.reload(); await ready(page); await expect(records(page).first()).toHaveAttribute('data-av2-matter', second);
});

test('a removed final page explains the change and returns to the available last page', async ({ page }) => {
  const { data } = await install(page, dataSet(), '/matters?page=7');
  data.active = data.active.slice(0, 20);
  await refresh(page); await ready(page);
  await expect(panel(page)).toContainText('This page is no longer available'); await expect(panel(page)).not.toContainText('No matters match');
  await expect(records(page)).toHaveCount(0);
  await panel(page).getByRole('link', { name: 'Go to the last page' }).click(); await ready(page);
  await expect(page).toHaveURL(/page=2/); await expect(records(page)).toHaveCount(5);
});

test('empty filters have one outcome and filter controls remain usable after unavailable reads', async ({ page }) => {
  const { state } = await install(page);
  await page.getByRole('searchbox', { name: 'Search matters' }).fill('No matching title');
  await expect(page).toHaveURL(/q=No/); await ready(page);
  await expect(panel(page).getByText('No Matters match these filters.', { exact: true })).toHaveCount(1);
  await expect(panel(page)).not.toContainText('0 matching matters');
  state.failures.active = 503; await refresh(page);
  await expect(panel(page)).toHaveAttribute('data-state', 'error'); await expect(panel(page)).not.toContainText('No matters match');
  await expect(page.getByRole('searchbox', { name: 'Search matters' })).toHaveValue('No matching title');
  state.failures = {}; await panel(page).getByRole('button', { name: 'Retry active matters', exact: true }).click(); await ready(page); await panel(page).getByRole('button', { name: 'Clear filters', exact: true }).click(); await ready(page); await expect(records(page)).toHaveCount(15);
});

test('mismatched owner counts or query echoes fail closed and a deliberate refresh recovers', async ({ page }) => {
  const { state } = await install(page);
  for (const transform of [value => ({ ...value, ownerId: id(888) }), value => ({ ...value, total: value.total + 200 }), value => ({ ...value, filters: { ...value.filters, view: 'archived' } }), value => ({ ...value, items: value.items.slice(0, 1) })]) {
    state.transform = transform; await refresh(page);
    await expect(panel(page)).toHaveAttribute('data-state', 'error'); await expect(records(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Matter categories' })).not.toContainText('103');
    state.transform = value => value; await refresh(page); await ready(page);
  }
  expect(state.writes).toEqual([]);
});

test('late page reads cannot replace the new category or discard filter text entered during a refresh', async ({ page }) => {
  const { data, state } = await install(page); let release, started;
  const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; });
  state.respond = async (route, url) => { state.respond = null; started(); await held; return json(route, await inventoryFixture(data, OWNER, url.searchParams)); };
  await refresh(page); await requested;
  await page.getByRole('searchbox', { name: 'Search matters' }).fill('Keep this filter draft'); release(); await ready(page);
  await expect(page.getByRole('searchbox', { name: 'Search matters' })).toHaveValue('Keep this filter draft');
  await expect(page).toHaveURL(/q=Keep/); await ready(page);
  await panel(page).getByRole('button',{name:'Clear filters',exact:true}).click(); await expect(records(page)).toHaveCount(15);
  let releaseOld, signalOld; const old = new Promise(resolve => { releaseOld = resolve; }), oldRequested = new Promise(resolve => { signalOld = resolve; });
  state.respond = async (route, url) => { state.respond = null; signalOld(); await old; return json(route, await inventoryFixture(data, OWNER, url.searchParams)); };
  await refresh(page); await oldRequested;
  await page.getByRole('navigation', { name: 'Matter categories' }).getByRole('link', { name: /^Archived/ }).click(); await ready(page);
  releaseOld(); await expect(panel(page)).toContainText('of 102 results'); await expect(records(page).first()).toContainText('Matter 1102');
});

test('full inventory keeps application and draft context distinct and maintains contextual destinations', async ({ page }) => {
  const data = dataSet(); data.active[0].applicantsCount = 2;
  data.applications = [1, 2].map(n => ({ id: id(5000 + n), caseId: id(1), paralegal: { id: id(6000 + n), name: `Applicant ${n}` } }));
  await install(page, data, '/matters?view=applications&caseId=' + id(1) + '&openApplicants=1');
  await expect(records(page)).toHaveCount(1); await expect(records(page)).toContainText('Applicant 1');
  await expect(records(page).getByRole('link', { name: 'Review applicants', exact: true })).toHaveAttribute('href', `#/matters/${id(1)}/applications?${new URLSearchParams({ returnTo: `#/matters?view=applications&caseId=${id(1)}&openApplicants=1` })}`);
  await expect(panel(page)).not.toContainText('not linked');
  await page.goto('/attorney-v2.html#/matters?view=draft&page=14'); await ready(page);
  await expect(records(page).first().getByRole('link', { name: /^Draft / })).toHaveAttribute('href', /#\/matters\/new\?draftId=[a-f0-9]{24}&step=description/);
});

for (const theme of ['light', 'dark']) for (const width of [1440, 768, 320]) {
test(`long inventory rows filters previews and paging fit both themes narrow widths and enlarged text: ${theme}, ${width}px`, async ({ page }, info) => {
  const data = dataSet(); data.active[102].title = 'Trial preparation and document review for a complex multi-party proceeding — Northeast regional litigation';
  const { state } = await install(page, data); const scans = [];
  await records(page).first().locator('.av2-matter-menu > summary').click();
  await records(page).first().getByRole('button', { name: 'Preview matter', exact: true }).click();
  await expect(records(page).first().locator('.av2-matter-inline-preview')).toHaveAttribute('open', '');
  await expect(records(page).first().getByText('Posted', { exact: true })).toHaveCount(1);
  const destinations = await records(page).first().getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')));
  expect(new Set(destinations).size).toBe(destinations.length);
  await page.setViewportSize({ width, height: 960 });
  await page.evaluate(({ theme, width }) => { document.documentElement.style.fontSize = width === 320 ? '200%' : ''; for (const node of [document.documentElement, document.body]) { node.classList.remove('theme-light', 'theme-dark'); node.classList.add('theme-' + theme); } }, { theme, width });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('main').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath(`matters-${theme}-${width}-overview.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: /^Filters/ }).click();
  const controls = await page.locator('.av2-filters select').evaluateAll(nodes => nodes.map(node => ({ label: node.labels?.[0]?.textContent.trim(), height: node.getBoundingClientRect().height })));
  for (const control of controls) expect(control.height, `${theme} ${width}px ${control.label} target height`).toBeGreaterThanOrEqual(24);
  for (const selector of ['.av2-matters-toolbar', '[data-av2-matter]:first-child', '[aria-label="Matter pages"]']) {
    const target = page.locator(selector); await target.evaluate(node => node.scrollIntoView({ block: 'start' }));
    const violations = (await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
    scans.push({ width, theme, selector, violations }); expect(violations).toEqual([]);
    const geometry = await target.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(geometry.scroll, `${selector}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.client + 1);
  }
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('.av2-filters').screenshot({ path: info.outputPath(`filters-${theme}-${width}.png`) });
  await records(page).first().screenshot({ path: info.outputPath(`row-${theme}-${width}.png`) });
  if (width === 320) {
    // A row at 200% text can exceed the viewport. Retain the element capture,
    // and also record its visible sections without off-screen capture gaps.
    for (const block of ['start', 'center', 'end']) {
      await records(page).first().evaluate((node, block) => node.scrollIntoView({ block }), block);
      await page.screenshot({ path: info.outputPath(`row-${theme}-${width}-viewport-${block}.png`) });
    }
  }
  await expect(page.locator('.av2-saved-views-host')).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
  fs.writeFileSync(info.outputPath('scans.json'), JSON.stringify(scans, null, 2)); fs.writeFileSync(info.outputPath('browser-errors.json'), JSON.stringify(state.errors));
});
}

test('an older archive deep link opens its own preview and explicit paging can leave that page', async ({ page }) => {
  const data = dataSet(), targetId = id(1001);
  await install(page, data, `/matters?view=archived&previewCaseId=${targetId.toUpperCase()}&highlightCase=${targetId.toUpperCase()}`);
  await expect(panel(page)).toContainText('91–102 of 102 results');
  const target = page.locator(`[data-av2-matter="${targetId}"]`);
  await expect(target).toBeVisible(); await expect(target.locator('.av2-matter-inline-preview')).toHaveAttribute('open', '');
  await expect(target).toHaveClass(/av2-highlighted/); await expect(panel(page)).not.toContainText('The linked matter is not on this page');
  await panel(page).getByRole('link', { name: 'Previous page', exact: true }).click(); await ready(page);
  await expect(page).toHaveURL(/page=6/); await expect(panel(page)).toContainText('76–90 of 102 results'); await expect(target).toHaveCount(0);
  await page.goBack(); await ready(page); await expect(target).toBeVisible(); await expect(panel(page)).toContainText('91–102 of 102 results');
});

test('singular applicant return links locate an older Matter and retain candidate context with uppercase IDs', async ({ page }) => {
  const data = dataSet(), targetId = id(10);
  data.active.forEach(item => { item.applicantsCount = 1; });
  data.applications = data.active.map((item, index) => ({ id: id(5000 + index), caseId: item.id, paralegal: { id: id(6000 + index), name: `Applicant ${index + 1}` } }));
  const { state } = await install(page, data, `/matters?view=applications&caseId=${targetId.toUpperCase()}&openApplicant=1`);
  const target = page.locator(`[data-av2-matter="${targetId}"]`);
  await expect(panel(page)).toContainText('91–103 of 103 results');
  await expect(target.getByRole('link', { name: 'Applicant 10', exact: true })).toBeVisible();
  await expect(panel(page)).not.toContainText('The linked matter is not on this page');
  const href = await target.getByRole('link', { name: 'Applicant 10', exact: true }).getAttribute('href');
  const query = new URLSearchParams(href.split('?')[1]);
  expect(query.get('caseId')).toBe(targetId); expect(query.get('applicationId')).toBe(id(5009));
  await page.goto('/attorney-v2.html' + query.get('returnTo')); await ready(page);
  await expect(target.getByRole('link', { name: 'Applicant 10', exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.path === '/api/cases/inventory').every(call => call.query.targetId === targetId)).toBe(true);
});
