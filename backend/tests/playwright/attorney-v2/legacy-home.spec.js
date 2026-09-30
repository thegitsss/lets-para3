const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { inventoryFixture } = require('./inventory-fixture');
const OWNER = '111111111111111111111111', OTHER = '222222222222222222222222';
const id = n => n.toString(16).padStart(24, '0');
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const item = n => ({ id: id(n), title: `Matter ${n} — Complex commercial litigation and document preparation`, label: 'In Progress', practiceArea: 'Commercial Litigation' });
async function install(page, { empty = false, draftsOnly = false, failure = '', swapped = false } = {}) {
  const user = { id: OWNER, _id: OWNER, role: 'attorney', status: 'approved', emailVerified: true, firstName: 'Dana', lastName: 'Ellis', lawFirm: 'Ellis Legal', email: 'synthetic@example.test', preferences: { theme: 'light', fontSize: 'md' }, onboarding: { attorneyTourCompleted: true } };
  const state = { user, failure, swapped, reads: [], writes: [], errors: [], empty, draftsOnly, paused: null, held: [] };
  await page.addInitScript(user => { localStorage.setItem('lpc_user', JSON.stringify(user)); sessionStorage.setItem('lpc_attorney_onboarding_dismissed', '1'); window.EventSource = class extends EventTarget { close() {} }; }, user);
  page.on('pageerror', error => state.errors.push(error.message));
  const home = query => {
    const a = Number(query.get('attentionPage') || 1), d = Number(query.get('deadlinePage') || 1), n = state.empty || state.draftsOnly ? 0 : 1;
    return { ownerId: OWNER, revision: 'a'.repeat(64), counts: { active: 202*n, applications: n, draft: state.draftsOnly ? 203 : 201*n, archived: 104*n }, postedCount: 307*n,
      attention: { total: 17*n, page: a, pages: n ? 4 : 1, pageSize: 5, items: Array.from({ length: 17*n }, (_, i) => ({ ...item(1001+i), actions: i === 16 ? ['files','payment'] : ['moderation'] })).slice((a-1)*5, a*5) },
      recent: { total: 203*n, items: n ? Array.from({ length: 5 }, (_, i) => ({ ...item(2001+i), label: i === 1 ? 'In Progress' : 'Posted' })) : [] }, completed: { total: 104*n, items: n ? [item(3001),item(3002),item(3003)] : [] },
      week: { start: '2026-09-07', end: '2026-09-13', total: 9*n, page: d, pages: n ? 3 : 1, pageSize: 3, items: Array.from({ length: 9*n }, (_, i) => ({ ...item(4001+i), dueDate: `2026-09-${String(7 + i%7).padStart(2,'0')}` })).slice((d-1)*3, d*3) } };
  };
  const cases = [2001,2002,2003,2004,2005,3001,4007,4008,4009,1017].map(n => ({ ...item(n), title: item(n).title, _id: id(n), attorney: OWNER, attorneyId: OWNER, status: n === 3001 ? 'completed' : 'open', archived: n === 3001, files: [], applicants: [], applicantsCount: 0, briefSummary: 'Original description.', practiceArea: 'Commercial Litigation', totalAmount: 40000 }));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (req.method() !== 'GET') { state.writes.push({ path: p, method: req.method() }); return json(route, { error: 'Read-only fixture' }, 501); }
    state.reads.push(p);
    if (state.paused === p) { state.held.push(route); return; }
    if (p === state.failure) return json(route, { error: 'Synthetic unavailable source' }, 503);
    if (p === '/api/csrf') return json(route, { csrfToken: 'synthetic-unused-token' });
    if (p === '/api/auth/me') return json(route, { user: state.user });
    if (p === '/api/users/me') return json(route, state.user);
    if (p === '/api/cases/inventory/home') {
      expect(url.searchParams.get('expectedOwnerId')).toBe(OWNER);
      if (state.swapped) state.user = { ...user, id: OTHER, _id: OTHER };
      return json(route, home(url.searchParams));
    }
    if (p === '/api/applications/my-postings') {
      expect(url.searchParams.get('expectedOwnerId')).toBe(OWNER);
      return json(route, state.empty || state.draftsOnly ? [] : ['submitted','viewed','shortlisted'].map((status,i) => ({ id: id(5001+i), caseId: id(8001+i), jobTitle: `Older posting ${i}`, status, paralegal: { id: id(6001+i), firstName: 'Priya' } })));
    }
    if (p === '/api/users/me/pending-hire') return json(route, { ownerId: OWNER, revision: 'a'.repeat(64), pending: null });
    if (p === '/api/payments/attorney-financial-history') return json(route, { ownerId: OWNER, revision: 'a'.repeat(64), view: 'all', q: '', caseId: null, entries: [], total: 0, nextCursor: null, summary: { currencies: [], requiresReview: 0, pending: 0, undated: 0 } });
    if (p === '/api/payments/payment-method/default') return json(route, { hasDefault: true, paymentMethod: { id: 'pm_synthetic', type: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
    if (p === '/api/messages/summary') return json(route, { items: [] });
    if (p === '/api/messages/threads') return json(route, { threads: [], total: 0 });
    if (p.includes('unread-count')) return json(route, { count: 0 });
    if (p === '/api/notifications/page') return json(route, { items: [], nextCursor: null, hasMore: false });
    if (p === '/api/notifications' || p === '/api/cases/my') return json(route, []);
    if (p === '/api/account/preferences') return json(route, user.preferences);
    if (p === '/api/checklist') return json(route, { items: [], total: state.empty || state.draftsOnly ? 0 : 6 });
    if (p === '/api/cases/inventory') return json(route, await inventoryFixture({ active: cases.filter(c => !c.archived), archived: cases.filter(c => c.archived), drafts: { items: [] } }, OWNER, url.searchParams));
    if (/^\/api\/cases\/[a-f0-9]{24}\/flags\/review$/.test(p)) return json(route, { ownerId: OWNER, caseId: p.split('/')[3], caseTitle: item(Number.parseInt(p.split('/')[3],16)).title, status: 'flagged', revision: 'a'.repeat(64), canRequestReview: false, reason: 'legacy_edit_required', feedback: 'Clarify the scope before posting.', flaggedAt: null, requestedAt: null });
    if (/^\/api\/cases\/[a-f0-9]{24}$/.test(p)) return json(route, cases.find(c => c.id === p.split('/').at(-1)) || {}, cases.some(c => c.id === p.split('/').at(-1)) ? 200 : 404);
    return json(route, { items: [], total: 0, threads: [] });
  });
  await page.goto('/dashboard-attorney.html#home');
  return state;
}
const ready = page => expect(page.locator('#overviewMattersBody')).toHaveAttribute('data-state','ready');
test('original Home uses complete totals and exact older actions, pages survive reload and browser Back', async ({ page }) => {
  const state = await install(page); await ready(page);
  await expect(page.locator('#overviewMattersBody')).toHaveText('203 current');
  await expect(page.locator('#overviewCompletedBody')).toHaveText('104');
  await expect(page.locator('#overviewApplicationsBody')).toHaveText('3 awaiting review');
  expect(state.reads).not.toContain('/api/cases/my');
  await expect(page.locator('#caseCards a').nth(1)).toHaveAttribute('href',`case-detail.html?caseId=${id(2002)}&tab=overview`);
  const flag = page.locator(`[data-home-attention="${id(1001)}"]`).getByRole('button',{name:'Review flagged listing'});
  await flag.click(); await expect(page.locator('[data-matter-moderation]')).toHaveAttribute('data-state','ready');
  await expect(page.locator('[data-matter-moderation]')).toContainText('Clarify the scope before posting.');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh'))); await ready(page);
  await expect(page.locator('[data-matter-moderation]')).toHaveAttribute('data-state','ready');
  await page.keyboard.press('Escape'); await expect(flag).toBeFocused();
  expect(new URL(page.url()).hash).toBe('#home');
  await expect(page.locator('#attorneyNeedsAttentionList')).toContainText('6 overdue tasks');
  const attention = page.getByRole('navigation', { name: 'Attention pages' });
  for (let n=0;n<3;n++) { await attention.getByRole('button', { name: 'Next attention page' }).click(); await ready(page); }
  await expect(attention).toContainText('Page 4 of 4');
  await expect(page.locator('#attorneyNeedsAttentionTitle')).toBeFocused();
  await expect(page.locator(`[data-home-attention="${id(1017)}"]`)).toContainText('Matter 1017');
  await expect(page.getByRole('link',{name:'Review submitted files',exact:true})).toHaveAttribute('href', `case-detail.html?caseId=${id(1017)}&tab=files`);
  const week = page.getByRole('navigation', { name: 'Deadline pages' });
  for(let n=0;n<2;n++) { await week.getByRole('button',{name:'Next deadline page'}).click(); await ready(page); }
  await expect(week).toContainText('Page 3 of 3');
  await expect(page.locator('#deadlineList')).toBeFocused();
  await page.reload(); await ready(page); await expect(attention).toContainText('Page 4 of 4'); await expect(week).toContainText('Page 3 of 3');
  const origin = page.url();
  await page.locator('#caseCards a').first().click();
  await expect(page.locator('#casePreviewModal')).toBeVisible();
  await expect(page.locator('#casePreviewModal')).toContainText('Matter 2001');
  await page.goBack(); await ready(page); expect(page.url()).toBe(origin); await expect(week).toContainText('Page 3 of 3');
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});
test('failed Home sources remain unavailable, retry independently and never claim all clear or missing payment method', async ({ page }) => {
  const state = await install(page,{empty:true,failure:'/api/payments/payment-method/default'}); await ready(page);
  await expect(page.locator('#attorneyNeedsAttentionList')).toContainText('could not be verified');
  await expect(page.locator('.view-home')).not.toContainText('Add a payment method');
  await expect(page.locator('.view-home')).not.toContainText('All clear');
  state.failure = '/api/cases/inventory/home'; await page.locator('[data-home-refresh]').click();
  await expect(page.locator('#overviewMattersBody')).toHaveAttribute('data-state','failed');
  await expect(page.locator('#caseCards')).not.toContainText('No current Matters');
  await expect(page.locator('#overviewApplicationsBody')).toHaveText('No applications to review.');
  state.failure = ''; await page.locator('#overviewMattersBody').getByRole('button',{name:'Retry matters',exact:true}).click(); await ready(page);
  await expect(page.locator('#attorneyNeedsAttentionList')).not.toContainText('could not be verified');
  state.failure = '/api/applications/my-postings'; await page.locator('[data-home-refresh]').click();
  await expect(page.locator('#overviewApplicationsBody')).toHaveAttribute('data-state','failed');
  await expect(page.locator('#overviewApplicationsBody')).not.toContainText('No applications');
  expect(state.errors).toEqual([]);
});
test('private drafts do not complete posting setup and a changed owner clears all old Home data', async ({ page }) => {
  const state = await install(page,{draftsOnly:true}); await ready(page);
  await expect(page.locator('[data-attention-item="first-matter"]')).toContainText('Post your first matter');
  state.draftsOnly = false; state.swapped = true; await page.locator('[data-home-refresh]').click();
  await expect(page.locator('#overviewMattersBody')).toContainText('Your account changed');
  await expect(page.locator('#caseCards [data-home-matter]')).toHaveCount(0);
  await expect(page.locator('[data-home-attention]')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});
test('late Home reads cannot restore departed data and a stored page can recover after its last records disappear', async ({ page }) => {
  const state = await install(page); await ready(page);
  const next = page.getByRole('button',{name:'Next attention page'}); await next.click(); await ready(page);
  state.empty = true; await page.locator('[data-home-refresh]').click(); await ready(page);
  await expect(page.getByRole('button',{name:'First attention page'})).toBeVisible();
  await page.getByRole('button',{name:'First attention page'}).click(); await ready(page); expect(new URL(page.url()).searchParams.has('attentionPage')).toBe(false);
  state.paused = '/api/cases/inventory/home'; await page.locator('[data-home-refresh]').click(); await expect.poll(()=>state.held.length).toBe(1);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  for(const route of state.held) await json(route, { ownerId: OTHER }).catch(()=>{});
  state.paused = null; state.empty = false; await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))); await ready(page);
  await expect(page.locator('#overviewMattersBody')).toHaveText('203 current'); expect(state.errors).toEqual([]);
});
test('original Home stays readable in both themes, phone widths and enlarged text', async ({ page }, testInfo) => {
  const state = await install(page); await ready(page); await expect(page.locator('#overviewApplicationsBody')).toHaveAttribute('data-state','ready');
  for(const [width,theme,size] of [[1440,'light',100],[1440,'dark',100],[390,'light',100],[390,'dark',100],[320,'light',200],[320,'dark',200]]) {
    await page.setViewportSize({width,height:960});
    await page.evaluate(({theme,size})=>{ document.documentElement.dataset.theme=theme; document.body.dataset.theme=theme; document.documentElement.classList.toggle('theme-dark',theme==='dark'); document.body.classList.toggle('theme-dark',theme==='dark'); document.documentElement.style.fontSize=`${size}%`; },{theme,size});
    await page.evaluate(()=>document.fonts.ready);
    if(width<1000) await expect.poll(()=>page.locator('main').evaluate(e=>Math.round(e.getBoundingClientRect().left))).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
    if(width===1440) {
      expect(await page.locator('.home-layout').evaluate(e=>getComputedStyle(e).gridTemplateColumns.trim().split(/\s+/).length)).toBe(1);
      const tops=await page.locator('.view-home .status-item').evaluateAll(items=>items.map(e=>Math.round(e.getBoundingClientRect().top)));
      expect(tops).toHaveLength(4); expect(new Set(tops).size).toBe(1);
    }
    if(theme==='dark' && width<1000) expect(await page.locator('#sidebarToggle').evaluate(e=>getComputedStyle(e).backgroundColor)).not.toMatch(/255, 255, 255/);
    const deadlineGeometry=await page.locator('.overview-deadline-row a, .overview-deadline-row time').evaluateAll(items=>items.map(e=>{
      const box=e.getBoundingClientRect(),panel=e.closest('.mini-deadlines').getBoundingClientRect();
      return {fits:box.left>=panel.left && box.right<=panel.right+1, unclipped:e.scrollWidth<=e.clientWidth+1 && e.scrollHeight<=e.clientHeight+1, ellipsis:getComputedStyle(e).textOverflow==='ellipsis'};
    }));
    expect(deadlineGeometry).toHaveLength(6);expect(deadlineGeometry.every(e=>e.fits && e.unclipped && !e.ellipsis)).toBe(true);
    await page.locator('.view-home .queue-action').first().hover();
    const axe = await new AxeBuilder({page}).include('.view-home').include('#sidebarToggle').analyze(); expect(axe.violations).toEqual([]);
    for (const section of ['.command-header', '[aria-label="Attention pages"]', '#caseCards', '#homeOverviewTitle', '#deadlineList']) {
      const target = page.locator(section); await target.scrollIntoViewIfNeeded();
      await page.screenshot({path:testInfo.outputPath(`legacy-home-${width}-${theme}-${size}-${section.replace(/[^a-zA-Z]+/g,'')}.png`)});
    }
    if(width<1000) {
      await page.locator('#sidebarToggle').click(); await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-expanded','true');
      await page.keyboard.press('Escape'); await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-expanded','false');
      await expect(page.locator('#sidebarToggle')).toBeFocused();
    }
  }
  expect(state.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`Matters navigation opens the full list with a single activation at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 960 }); const state = await install(page); await ready(page);
  for (const path of ['/dashboard-attorney.html#home', '/create-case.html', '/browse-paralegals.html']) {
    if (!path.startsWith('/dashboard-attorney')) await page.goto(path);
    const sidebar = page.locator('.sidebar, #sidebarNav, .authenticated-browse-sidebar').first();
    await expect(sidebar.locator('.sidebar-profile-host')).toBeAttached();
    if (width < 900) await page.locator('#sidebarToggle,[data-auth-sidebar-toggle]').filter({ visible: true }).click();
    const link = sidebar.getByRole('link', { name: 'Matters', exact: true }); await expect(link).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${width}-${path.split('/').pop().split('.')[0]}-navigation.png`), animations: 'disabled' });
    if (path === '/create-case.html') { await link.focus(); await page.keyboard.press('Enter'); } else await link.click();
    await expect(page).toHaveURL(/\/dashboard-attorney\.html(?:\?[^#]*)?#cases/);
    await expect(page.locator('.view-cases')).toBeVisible();
    await expect(page.locator('.lpc-sidebar-matters-panel,.lpc-sidebar-matters-caret')).toHaveCount(0);
    await expect(page.locator('#sidebarNav a[data-view-target=cases]')).not.toHaveAttribute('aria-expanded');
  }
  expect(state.reads.filter(path => path === '/api/cases/my-active')).toEqual([]);
  expect(state.errors).toEqual([]);
});
