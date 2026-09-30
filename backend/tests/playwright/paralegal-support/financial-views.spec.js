const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const f = require('./financial-fixtures');
const OWNER = '64b000000000000000000001', CASE = '64b000000000000000000101';
const surfaces = ['original', 'v2'];
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function fixture(page) {
  const user = { id: OWNER, _id: OWNER, role: 'paralegal', status: 'approved', firstName: 'Dana', lastName: 'Young', email: 'synthetic-financial@lpc.test', stateExperience: ['New York'], practiceAreas: ['Civil Litigation'], yearsExperience: 6, profileImage: '/assets/avatar-placeholder.svg', profilePhotoStatus: 'approved', preferences: { theme: 'light', fontSize: 'md' }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true }, availability: 'Available now', availabilityDetails: { status: 'available', nextAvailable: null } };
  const zero = f.receipt(CASE, OWNER, { receiptId: 'a'.repeat(64), payoutState: 'no_payout', paymentAmount: 0 }), earlier = f.receipt(CASE, OWNER, { receiptId: 'b'.repeat(64), currency: 'EUR' });
  const pendingCase = '64b000000000000000000102', pending = f.receipt(pendingCase, OWNER, { paymentAmount: null, payoutState: 'pending', receiptAvailable: false, stripeMode: null });
  const state = { user, dashboardStatus: 200, historyStatus: 200, downloadStatus: 200, receipts: [], reads: [], downloads: [], errors: [],
    earnings: f.earnings(OWNER, { earnings: 81, earningsLast30Days: 81, earningsTotal: 81 }), expected: f.expected(OWNER),
    history: [{ caseId: CASE, title: 'River Street repeated assignment', attorneyName: 'Jordan Lee', completedAt: '2026-09-04T00:00:00Z', isWithdrawn: true, receipts: [zero, earlier] }, { caseId: pendingCase, title: 'Payout awaiting confirmation', attorneyName: 'Jordan Lee', completedAt: '2026-09-01T00:00:00Z', isWithdrawn: true, receipts: [pending] }],
  };
  state.earnings.currencies.push({ ...state.earnings.currencies[0], currency: 'EUR', stripeMode: 'live', total: 24300, month: null, last30: null, undated: 1 });
  state.earnings.count = 2; state.earnings.states.recorded = 2; state.earnings.undated = 1; state.earnings.requiresReview = 1; state.earnings.states.needs_review = 1;
  await page.addInitScript(user => localStorage.setItem('lpc_user', JSON.stringify(user)), user);
  page.on('download', download => state.downloads.push(download.suggestedFilename()));
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname; state.reads.push(path + url.search);
    if ((route.request().headers().accept || '').includes('text/event-stream') || path.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic financial stream\n\n' });
    if (path === '/api/auth/me') return json(route, { user: state.user });
    if (path === '/api/users/me') return json(route, state.user);
    if (path === '/api/csrf') return json(route, { csrfToken: 'synthetic-financial' });
    if (path === '/api/users/me/onboarding') return json(route, { onboarding: user.onboarding });
    if (path === '/api/paralegal/dashboard') {
      if (state.dashboardGate) await state.dashboardGate;
      return json(route, { metrics: { activeCases: state.activeCases?.length || 0, earningsReport: state.earnings, expectedCompensation: state.expected }, activeCases: state.activeCases || [] }, state.dashboardStatus);
    }
    if (path === '/api/cases/my-completed') {
      state.historyPages = (state.historyPages || 0) + 1;
      if (state.historyGate) await state.historyGate;
      if (state.failSecondPage && url.searchParams.has('cursor')) return json(route, { error: 'Changed' }, 409);
      return json(route, f.history(OWNER, state.history, url.searchParams), state.historyStatus);
    }
    if (path.startsWith('/api/payments/receipt/paralegal/')) {
      state.receipts.push(url.searchParams.toString());
      if (state.receiptGate) await state.receiptGate;
      if (state.changeOwnerAfterReceipt) state.user = { ...user, id: 'f'.repeat(24), _id: 'f'.repeat(24) };
      return route.fulfill({ status: state.downloadStatus, contentType: state.pdfType || 'application/pdf', body: state.pdfBody || '%PDF-1.4\nSynthetic browser receipt\n' }).catch(() => {});
    }
    if (path === '/api/payments/connect/status') return json(route, { readiness: { ready: true }, connected: true });
    if (path === '/api/jobs/recommended') return json(route, { items: [], hasMatchingProfile: true });
    if (path === '/api/messages/threads') return json(route, { threads: [], total: 0, pages: 0 });
    if (path === '/api/messages/unread-count') return json(route, { count: 0 });
    if (path === '/api/applications/my') return json(route, []);
    if (path === '/api/account/dashboard-views') return json(route, { views: [] });
    return json(route, { items: [], total: 0, pages: 0, count: 0 });
  });
  return state;
}
async function open(page, surface, history = false, highlight = '', title = 'River Street repeated assignment') {
  const suffix = highlight ? `&highlightCase=${highlight}` : '';
  await page.goto(surface === 'v2' ? `/paralegal-v2.html#/${history ? `work?section=history${suffix}` : 'home?view=history'}` : `/dashboard-paralegal.html${highlight ? `?highlightCase=${highlight}` : ''}#${history ? 'cases' : 'home'}`);
  if (surface === 'v2') await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  const root = page.locator(history ? surface === 'v2' ? '#v2-work-history' : '#completedCasesContainer' : '[data-payout-totals]');
  await expect(root).toBeVisible();
  if (history) await expect(root).toContainText(title);
  else await expect(root).toHaveAttribute('data-state', 'ready');
  return root;
}
for (const surface of surfaces) {
  test(`${surface}: termination review status fits retained History without a completion or payout claim`, async ({ page }, info) => {
    const state = await fixture(page), title = 'River Street termination review';
    state.history = [{ caseId: CASE, title, attorneyName: 'Jordan Lee', completedAt: null, workState: 'needs_review', isWithdrawn: false, reviewState: 'open', reviewKind: 'termination', receipts: [f.receipt(CASE, OWNER, { payoutState: 'unconfirmed', paymentAmount: null, receiptAvailable: false, stripeMode: null })] }];
    const root = await open(page, surface, true, CASE, title);
    await expect(root).toContainText('Termination review');
    await expect(root.locator('[data-review-status="open"]')).toHaveText('An LPC review is open for this termination request. No decision is recorded.');
    await expect(root).toContainText('Payout not confirmed'); await expect(root.getByRole('button', { name: 'Download receipt', exact: true })).toHaveCount(0);
    await expect(root).not.toContainText('Work status needs review'); await expect(root).not.toContainText('Withdrawn');
    for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      await root.locator('[data-review-status="open"]').scrollIntoViewIfNeeded();
      expect(await root.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('[data-review-status="open"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await root.screenshot({ path: info.outputPath(`${surface}-termination-${theme}-${width}.png`) });
    }
    expect(state.errors).toEqual([]);
  });
  test(`${surface}: current withdrawal review stays distinct from retained payouts`, async ({ page }, info) => {
    const state = await fixture(page); state.history[0].reviewState = 'open';
    const root = await open(page, surface, true);
    await expect(root.locator('[data-review-status="open"]')).toHaveText('An LPC review is open for this withdrawal. No decision is recorded.');
    await expect(root.getByText('No payout', { exact: true })).toHaveCount(1);
    for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      const notice = root.locator('[data-review-status="open"]'); await notice.scrollIntoViewIfNeeded();
      expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('[data-review-status="open"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await root.screenshot({ path: info.outputPath(`${surface}-review-${theme}-${width}.png`) });
    }
    expect(state.errors).toEqual([]);
  });
  test(`${surface}: grouped earnings and missing dates fit light/dark and large phone/desktop`, async ({ page }, info) => {
    const state = await fixture(page), root = await open(page, surface);
    await expect(root).toContainText('USD · Test'); await expect(root).toContainText('EUR'); await expect(root).toContainText('€243.00');
    await expect(root.getByText('Unavailable', { exact: true })).toHaveCount(2);
    await expect(root).toContainText('1 needs review'); await expect(root).not.toContainText('$243.00');
    for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      await root.scrollIntoViewIfNeeded();
      expect(await root.evaluate(element => ({ fits: element.scrollWidth <= element.clientWidth + 1, document: document.documentElement.scrollWidth <= innerWidth + 1 }))).toEqual({ fits: true, document: true });
      expect((await new AxeBuilder({ page }).include('[data-payout-totals]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await root.screenshot({ path: info.outputPath(`${surface}-earnings-${theme}-${width}.png`) });
    }
    expect(state.errors).toEqual([]);
  });
  test(`${surface}: remaining-work estimates stay separate from payouts and unverified amounts`, async ({ page }, info) => {
    const state = await fixture(page), second = '64b000000000000000000199';
    state.activeCases = [CASE, second].map(caseId => ({ caseId, title: 'Current funded work', paralegalId: OWNER, status: 'in progress', archived: false, paymentReleased: false, escrowStatus: 'funded', escrowIntentId: `pi_${caseId}`, tasksTotal: 1, tasksRemaining: 1 }));
    state.expected = { ownerId: OWNER, revision: 'd'.repeat(64), requiresReview: 1, items: [{ caseId: CASE, currency: 'USD', stripeMode: 'test', grossCents: 30000, feeCents: 5400, netCents: 24600, state: 'estimate' }, { caseId: second, currency: 'EUR', stripeMode: 'unknown', grossCents: null, feeCents: null, netCents: null, state: 'needs_review' }], currencies: [{ currency: 'USD', stripeMode: 'test', netCents: 24600, count: 1, requiresReview: 0 }, { currency: 'EUR', stripeMode: 'unknown', netCents: null, count: 1, requiresReview: 1 }] };
    const root = await open(page, surface), estimates = root.locator('.pf-estimates');
    await expect(estimates.getByRole('heading', { name: 'Estimated from active work' })).toBeVisible();
    await expect(estimates).toContainText('USD · Test · $246.00'); await expect(estimates).not.toContainText('$328.00');
    await expect(estimates).toContainText('EUR · Mode unverified · Unavailable'); await expect(estimates).toContainText('1 estimate needs review.');
    await expect(estimates).toContainText('not a scheduled payout');
    await page.setViewportSize({ width: 320, height: 1000 }); await page.evaluate(() => document.documentElement.style.fontSize = '20px');
    const layout = () => estimates.evaluate(element => {
      const frame = document.querySelector('.v2-app-frame'), rect = frame?.getBoundingClientRect();
      return { scroll: element.scrollWidth, client: element.clientWidth, frameX: rect?.x ?? null, frameWidth: rect?.width ?? null, viewport: innerWidth };
    });
    const initialLayout = await layout();
    // The shell animates its width and margin when the viewport changes.
    // Measure the phone layout after that existing transition reaches its target.
    if (surface === 'v2') await expect.poll(async () => {
      const current = await layout();
      return Math.abs(current.frameX) < 1 && Math.abs(current.frameWidth - current.viewport) < 1;
    }).toBe(true);
    await info.attach('estimate-phone-layout.json', { body: JSON.stringify({ initial: initialLayout, settled: await layout() }), contentType: 'application/json' });
    expect(await estimates.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('.pf-estimates').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await estimates.screenshot({ path: info.outputPath(`${surface}-estimates-320.png`) }); expect(state.errors).toEqual([]);
  });
  test(`${surface}: invalid financial reports are unavailable and refresh recovers`, async ({ page }) => {
    const state = await fixture(page); state.earnings.ownerId = 'f'.repeat(24);
    await page.goto(surface === 'v2' ? '/paralegal-v2.html#/home?view=history' : '/dashboard-paralegal.html#home');
    const root = page.locator('[data-payout-totals]'); await expect(root).toHaveAttribute('data-state', 'unavailable'); await expect(root).not.toContainText('$0.00');
    let release; state.dashboardGate = new Promise(resolve => { release = resolve; });
    await root.getByRole('button', { name: 'Refresh payouts' }).click();
    state.earnings.ownerId = OWNER; release(); await expect(root).toHaveAttribute('data-state', 'ready');
  });
  test(`${surface}: source refresh clears old payout totals before a delayed failure`, async ({ page }) => {
    const state = await fixture(page), root = await open(page, surface);
    let release; state.dashboardGate = new Promise(resolve => { release = resolve; }); state.dashboardStatus = 503;
    await page.evaluate(surface => window.dispatchEvent(new CustomEvent(surface === 'v2' ? 'lpc:lifecycle-refresh' : 'lpc:paralegal-dashboard-request-refresh', { detail: { reason: 'financial-source-check', sourceId: 'synthetic-financial-source' } })), surface);
    await expect(root).not.toContainText('$81.00'); await expect(root).not.toContainText('€243.00'); release();
    await expect(page.locator('[data-payout-totals]')).toHaveAttribute('data-state', 'unavailable');
    await expect(page.locator('[data-payout-totals]')).not.toContainText('$0.00');
  });
  test(`${surface}: history keeps zero, pending and exact earlier receipts distinct`, async ({ page }, info) => {
    const state = await fixture(page); state.history[0].blockStatus = { blocked: false, canBlock: true };
    const root = await open(page, surface, true);
    await expect(root.getByText('No payout', { exact: true })).toHaveCount(1); await expect(root.getByText('$0.00', { exact: true })).toHaveCount(1);
    await expect(root.getByText('Payout pending', { exact: true })).toHaveCount(1); await expect(root.getByRole('button', { name: 'Download receipt', exact: true })).toHaveCount(1);
    await root.getByText('Earlier receipts (1)', { exact: true }).click(); await expect(root).toContainText('€81.00');
    const pendingDownload = page.waitForEvent('download'); await root.getByRole('button', { name: /^Download earlier receipt/ }).click(); const download = await pendingDownload; await download.saveAs(info.outputPath('earlier-receipt.pdf'));
    expect(state.receipts[0]).toContain(`receiptId=${'b'.repeat(64)}`); expect(state.receipts[0]).toContain(`expectedOwnerId=${OWNER}`); expect(state.receipts[0]).toContain('receiptRevision=');
    for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      await root.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (surface === 'original') {
        const colors = await root.evaluate(element => ({ page: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(element.querySelector('[data-payout-details]')).color }));
        expect(colors).toEqual(theme === 'dark' ? { page: 'rgb(17, 27, 42)', text: 'rgb(242, 245, 249)' } : { page: 'rgb(255, 255, 255)', text: 'rgb(23, 35, 59)' });
      }
      if (surface === 'v2' && width === 320) expect(await root.evaluate(element => [...element.querySelectorAll('.v2-work-history-row')].every(row => {
        const payout = row.querySelector('[data-payout-details]').getBoundingClientRect(), title = row.querySelector('.v2-work-row-main').getBoundingClientRect();
        return payout.width >= 180 && Math.abs(payout.left - title.left) <= 1 && Math.abs(payout.width - title.width) <= 1;
      }))).toBe(true);
      if (surface === 'v2' && width === 1366) expect(await root.locator('.v2-work-history-row').first().evaluate(row => {
        const main = row.querySelector('.v2-work-row-main').getBoundingClientRect(), actions = row.querySelector('.v2-work-history-actions').getBoundingClientRect();
        return actions.top >= main.bottom && actions.top - main.bottom <= 24;
      })).toBe(true);
      for (const action of await root.locator('[data-payout-receipt]').all()) { await action.focus(); await expect(action).toBeFocused(); await expect(action).toBeInViewport(); }
      expect((await new AxeBuilder({ page }).include(surface === 'v2' ? '#v2-work-history' : '#completedCasesContainer').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await root.screenshot({ path: info.outputPath(`${surface}-history-${theme}-${width}.png`) });
      await page.screenshot({ path: info.outputPath(`${surface}-history-context-${theme}-${width}.png`) });
    }
    expect(state.errors).toEqual([]);
  });
  test(`${surface}: work status remains separate from missing payout evidence`, async ({ page }) => {
    const state = await fixture(page);
    state.history = ['closed', 'needs_review', 'completed'].map((workState, index) => ({ caseId: (2000 + index).toString(16).padStart(24, '0'), title: index ? `Retained work ${index}` : 'River Street repeated assignment', attorneyName: 'Jordan Lee', workState, completedAt: null, isWithdrawn: false, receiptAvailable: false }));
    const root = await open(page, surface, true);
    for (const label of ['Closed', 'Work status needs review', 'Completed']) await expect(root.getByText(new RegExp(`(?:^| · )${label}$`))).toHaveCount(1);
    await expect(root.getByRole('button', { name: 'Download receipt', exact: true })).toHaveCount(0);
    await expect(root).not.toContainText('$0.00'); expect(state.errors).toEqual([]);
  });
  test(`${surface}: a routine refresh preserves an in-progress exact receipt download`, async ({ page }) => {
    const state = await fixture(page), root = await open(page, surface, true);
    let release; state.receiptGate = new Promise(resolve => { release = resolve; });
    await root.getByText('Earlier receipts (1)', { exact: true }).click();
    await root.getByRole('button', { name: /^Download earlier receipt/ }).click(); await expect.poll(() => state.receipts.length).toBe(1);
    const reads = state.historyPages;
    await page.evaluate(surface => window.dispatchEvent(new CustomEvent(surface === 'v2' ? 'lpc:lifecycle-refresh' : 'lpc:paralegal-dashboard-refresh', { detail: { reason: 'routine-history-check', sourceId: 'synthetic-history-source', signalTypes: ['payout_refresh'] } })), surface);
    if (surface === 'original') await expect.poll(() => state.historyPages).toBeGreaterThan(reads);
    // Cross the shell's scheduled refresh boundary while the body stays pending.
    await page.waitForTimeout(650);
    try { await expect(root.getByRole('button', { name: 'Cancel download' })).toBeVisible(); } finally { release(); }
    await expect.poll(() => state.downloads.length).toBe(1);
    await expect.poll(() => state.historyPages).toBeGreaterThan(reads);
    if (surface === 'v2') await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(root.locator('[data-payout-details] details').first()).toHaveAttribute('open', '');
    expect(state.errors).toEqual([]);
  });
  test(`${surface}: account loss during a pending receipt still clears the protected download`, async ({ page }) => {
    const state = await fixture(page), root = await open(page, surface, true);
    let release; state.receiptGate = new Promise(resolve => { release = resolve; });
    await root.getByRole('button', { name: 'Download receipt', exact: true }).click(); await expect.poll(() => state.receipts.length).toBe(1);
    state.user = { ...state.user, id: 'f'.repeat(24), _id: 'f'.repeat(24) };
    await page.evaluate(({ surface, user }) => {
      if (surface === 'v2') window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'synthetic-access-loss', accessMayChange: true } }));
      else { localStorage.setItem('lpc_user', JSON.stringify(user)); window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', newValue: JSON.stringify(user) })); }
    }, { surface, user: state.user });
    try { await expect(root.getByRole('button', { name: 'Cancel download' })).toHaveCount(0); } finally { release(); }
    await page.waitForTimeout(650); expect(state.downloads).toEqual([]);
  });
  for (const mode of ['changed', 'invalid-pdf', 'canceled', 'owner-changed']) test(`${surface}: ${mode} receipt cannot become a successful download`, async ({ page }) => {
    const state = await fixture(page), root = await open(page, surface, true);
    let release;
    if (mode === 'changed') state.downloadStatus = 409;
    if (mode === 'invalid-pdf') state.pdfBody = '<html>Not a receipt</html>';
    if (mode === 'owner-changed') state.changeOwnerAfterReceipt = true;
    if (mode === 'canceled') state.receiptGate = new Promise(resolve => { release = resolve; });
    const button = root.getByRole('button', { name: 'Download receipt', exact: true }); await button.click();
    if (mode === 'canceled') { await expect(root.getByRole('button', { name: 'Cancel download' })).toBeVisible(); await root.getByRole('button', { name: 'Cancel download' }).click(); release(); await expect(root).toContainText('Download canceled.'); }
    else if (mode === 'invalid-pdf') await expect(root).toContainText('Receipt unavailable. Try again.');
    else if (mode === 'owner-changed' && surface === 'original') {
      // The receipt owner check and the background History owner check can
      // finish in either order. Both must refuse the old account's download.
      await expect(root.getByRole('button', { name: /^(?:Refresh history|Retry)$/ })).toBeVisible();
      await expect(root).toContainText(/Payout details changed or access is unavailable|Past Matters could not be loaded/);
    }
    else await expect(root.getByRole('button', { name: 'Refresh history' })).toBeVisible();
    expect(state.downloads).toEqual([]);
  });
  test(`${surface}: complete history loads every page and rejects partial-page success`, async ({ page }) => {
    const state = await fixture(page);
    for (let i = 0; i < 102; i++) state.history.push({ caseId: (1000 + i).toString(16).padStart(24, '0'), title: `Older work ${i}`, attorneyName: 'Jordan Lee', completedAt: '2026-08-01T00:00:00Z', receiptAvailable: false, isWithdrawn: false });
    await open(page, surface, true); expect(state.historyPages).toBe(2);
    const pager = page.locator(surface === 'v2' ? '#v2-work-history .v2-work-pager' : '#completedCasesPagination'); await expect(pager).toContainText('104');
    await pager.getByRole('button', { name: 'Next', exact: true }).click();
    const pageLabel = await pager.innerText(), reads = state.historyPages;
    await page.evaluate(surface => window.dispatchEvent(new CustomEvent(surface === 'v2' ? 'lpc:lifecycle-refresh' : 'lpc:paralegal-dashboard-refresh', { detail: { reason: 'routine-history-page', sourceId: 'synthetic-history-page' } })), surface);
    await expect.poll(() => state.historyPages).toBeGreaterThanOrEqual(reads + 2);
    if (surface === 'v2') await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(pager).toHaveText(pageLabel, { useInnerText: true });
    state.failSecondPage = true;
    await page.reload();
    const root = page.locator(surface === 'v2' ? '#v2-work-history' : '#completedCasesContainer'); await expect(root).toContainText(/couldn.t load|could not be loaded/i); await expect(root.locator('[data-payout-details]')).toHaveCount(0);
  });
}


test('v2: navigation during a pending History read does not cache a false load failure', async ({ page }) => {
  const state = await fixture(page); let release;
  state.historyGate = new Promise(resolve => { release = resolve; });
  await page.goto('/paralegal-v2.html#/work?section=history');
  await expect.poll(() => state.historyPages || 0).toBe(1);
  await page.evaluate(() => new Promise(resolve => {
    window.addEventListener('hashchange', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
    window.location.hash = '/work?section=active';
  }));
  release();
  await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
  await page.goto('/paralegal-v2.html#/work?section=history');
  await expect(page.locator('#v2-work-history')).toContainText('River Street repeated assignment');
  await expect(page.locator('#v2-work-history')).not.toContainText('These records couldn’t load.');
  expect(state.errors).toEqual([]);
});


test('v2: a superseded History refresh does not report a user-facing error', async ({ page }) => {
  const state = await fixture(page); state.historyStatus = 503;
  await page.goto('/paralegal-v2.html#/work?section=history');
  const root = page.locator('#v2-work-history'); await expect(root).toContainText('These records couldn’t load.');
  await page.evaluate(() => {
    window.__historyRefreshToasts = [];
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.v2-toast')) window.__historyRefreshToasts.push(node.textContent);
    }).observe(document.querySelector('[data-v2-toast-region]'), { childList: true });
  });
  state.historyStatus = 200; let release;
  state.historyGate = new Promise(resolve => { release = resolve; });
  const reads = state.historyPages;
  await root.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => state.historyPages).toBeGreaterThan(reads);
  await page.evaluate(() => new Promise(resolve => {
    window.addEventListener('hashchange', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
    window.location.hash = '/work?section=active';
  }));
  release();
  await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
  await page.goto('/paralegal-v2.html#/work?section=history');
  await expect(page.locator('#v2-work-history')).toContainText('River Street repeated assignment');
  expect(await page.evaluate(() => window.__historyRefreshToasts)).toEqual([]);
  expect(state.errors).toEqual([]);
});
