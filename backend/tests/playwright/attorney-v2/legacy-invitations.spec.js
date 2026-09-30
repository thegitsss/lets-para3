const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const id = n => n.toString(16).padStart(24, '0'), OWNER = id(9001), PARALEGAL = id(9002);
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function install(page, surface, { applicant = false } = {}) {
  const user = { id: OWNER, _id: OWNER, role: 'attorney', status: 'approved', emailVerified: true, firstName: 'Dana', lastName: 'Ellis', email: 'synthetic@example.test', preferences: { theme: 'light', fontSize: 'md' }, onboarding: { attorneyTourCompleted: true } };
  const profile = { id: PARALEGAL, _id: PARALEGAL, role: 'paralegal', status: 'approved', firstName: 'Priya', lastName: 'Ng', email: 'synthetic-para@example.test', availability: 'available', yearsExperience: 5, bio: 'Synthetic experienced paralegal.', practiceAreas: ['Contract Law'], location: 'New York', profilePhotoStatus: 'unsubmitted', stripeAccountId: 'acct_synthetic', stripeOnboarded: true, stripePayoutsEnabled: true };
  const canonicalUrl = `/profile-paralegal.html?paralegalId=${PARALEGAL}`, stamp = '2026-09-14T12:00:00.000Z';
  const card = { _id: PARALEGAL, yearsExperience: 5, presentation: { schemaVersion: 1, source: 'server_projection', kind: 'card', objectType: 'profile', object: { id: PARALEGAL, title: 'Priya Ng', canonicalUrl, version: stamp }, status: { code: 'active', label: 'Available', tone: 'success' }, attention: null, relationship: { code: 'public', label: 'Public profile' }, readOnly: true, actions: [], details: [{ label: 'Location', value: 'New York' }, { label: 'Practice areas', value: 'Contract Law' }], summary: profile.bio, freshness: { state: 'current', sourceUpdatedAt: stamp, projectedAt: stamp }, links: { self: canonicalUrl } } };
  const state = { user, cases: Array.from({ length: 103 }, (_, n) => ({ caseId: id(103-n), title: n === 102 ? 'Older (NY) [A] — Amélie’s estate administration' : `Matter ${103-n}` })), reads: [], writes: [], errors: [], failChoices: false, wrongOwner: false, pending: new Map(), send: null, delay: null };
  await page.addInitScript(user => { localStorage.setItem('lpc_user', JSON.stringify(user)); window.EventSource = class extends EventTarget { close() {} }; }, user);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === 'GET') state.reads.push(path); else state.writes.push({ path, body: request.postDataJSON() });
    if (path === '/api/auth/me') return reply(route, { user: state.user });
    if (applicant && (path === `/api/cases/${id(1)}` || path.startsWith(`/api/cases/${id(1)}/`))) return route.fallback();
    if (path === '/api/users/me') return reply(route, state.user);
    if (path === `/api/paralegals/${PARALEGAL}` || path === `/api/public/paralegals/${PARALEGAL}`) return reply(route, profile);
    if (path === '/api/public/paralegals' || path === '/public/paralegals') return reply(route, { items: [card], total: 1, page: 1, pages: 1 });
    if (path === '/api/csrf') return reply(route, { csrfToken: 'synthetic-invitation-csrf' });
    if (path === '/api/account/preferences') return reply(route, user.preferences);
    if (path.includes('unread-count')) return reply(route, { count: 0 });
    if (path === '/api/notifications/page') return reply(route, { items: [], hasMore: false, nextCursor: null });
    if (path === `/api/cases/invitation-options/${PARALEGAL}`) {
      expect(url.searchParams.get('expectedOwnerId')).toBe(OWNER);
      const search = (url.searchParams.get('q') || '').trim(), cursor = url.searchParams.get('cursor') || '';
      if (state.delay) await state.delay(search);
      if (state.failChoices) return reply(route, { error: 'Synthetic unavailable inventory' }, 503);
      const rows = state.cases.filter(row => (!cursor || row.caseId < cursor) && row.title.toLowerCase().includes(search.toLowerCase()));
      return reply(route, { ownerId: state.wrongOwner ? id(9999) : OWNER, paralegalId: PARALEGAL, search, cursor, next: rows.length > 25 ? rows[24].caseId : null, matters: rows.slice(0,25) });
    }
    const review = path.match(/^\/api\/cases\/([a-f0-9]{24})\/invitation-review\//);
    if (review) {
      const invitation = state.pending.get(review[1]) || null;
      return reply(route, { ownerId: OWNER, paralegalId: PARALEGAL, caseId: review[1], caseTitle: state.cases.find(row => row.caseId === review[1]).title, name: 'Priya Ng', revision: (invitation ? 'b' : 'a').repeat(64), reason: invitation ? 'pending' : 'ready', canInvite: !invitation, amountCents: 40001, currency: 'usd', amountLocked: !!invitation, invitation, relisted: false, remainingCents: null });
    }
    const send = path.match(/^\/api\/cases\/([a-f0-9]{24})\/invite\//);
    if (send) {
      const body = request.postDataJSON(); expect(body).toEqual({ expectedOwnerId: OWNER, reviewedRevision: 'a'.repeat(64) });
      if (state.pending.has(send[1])) return reply(route, { code: 'INVITATION_CHANGED' }, 409);
      const invitation = { status: 'pending', invitedAt: new Date().toISOString(), respondedAt: null }; state.pending.set(send[1], invitation);
      const receipt = { invitationConfirmation: { paralegalId: PARALEGAL, reviewedRevision: body.reviewedRevision, amountCents: 40001, invitedAt: invitation.invitedAt } };
      return state.send ? state.send(route, receipt) : reply(route, receipt);
    }
    return reply(route, { items: [], total: 0, threads: [], files: [], events: [] });
  });
  state.directoryPages = 1; state.directoryPageReads = [];
  await page.route('**/public/paralegals?**', route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page')); state.directoryPageReads.push(pageNumber);
    return reply(route, { items: [card], total: state.directoryPages === 1 ? 1 : 13, page: pageNumber, pages: state.directoryPages });
  });
  if (applicant) {
    const returnTo = `dashboard-attorney.html?caseId=${id(1)}&applicantId=${PARALEGAL}&openApplicant=1#matters`;
    await page.goto(`${canonicalUrl}&returnTo=${encodeURIComponent(returnTo)}`);
    return { state };
  }
  await page.goto(surface === 'directory' ? '/browse-paralegals.html' : canonicalUrl);
  const opener = page.getByRole('button', { name: 'Invite to Matter', exact: true }).first(); await expect(opener).toBeVisible();
  const dialog = page.locator('.lpc-invitation-dialog');
  const open = async () => { await opener.click(); await expect(dialog).toHaveAttribute('data-state', 'choosing'); };
  const chooseOlder = async () => { await dialog.getByLabel('Search Matters', { exact: true }).fill('(NY) [A]'); await expect(dialog.locator('.lpc-invitation-choices button')).toHaveCount(1); await dialog.locator('.lpc-invitation-choices button').click(); await expect(dialog).toHaveAttribute('data-state', 'review'); };
  return { state, opener, dialog, open, chooseOlder };
}
for (const surface of ['directory', 'profile']) {
  test(`${surface}: complete Matter choices lead to one reviewed and confirmed invitation`, async ({ page }) => {
    const view = await install(page, surface); await view.open();
    await expect(view.dialog.locator('.lpc-invitation-choices button')).toHaveCount(25);
    for (let pageNumber = 2; pageNumber <= 5; pageNumber++) { await view.dialog.getByRole('button', { name: 'Next Matters', exact: true }).click(); await expect(view.dialog.getByRole('status')).toHaveText(`Page ${pageNumber}`); }
    await expect(view.dialog.locator('.lpc-invitation-choices button')).toHaveCount(3); await view.chooseOlder();
    await expect(view.dialog).toContainText('$400.01'); await expect(view.dialog.locator('textarea')).toHaveCount(0); await expect(view.dialog.getByRole('button', { name: 'Send invitation', exact: true })).toHaveCount(1);
    expect(view.state.writes).toEqual([]); await view.dialog.getByRole('button', { name: 'Send invitation', exact: true }).click(); await expect(view.dialog).toHaveAttribute('data-state', 'sent'); expect(view.state.pending.size).toBe(1);
    await view.dialog.getByRole('button', { name: 'Done', exact: true }).click(); await expect(view.dialog).toHaveCount(0); await expect(view.opener).toBeFocused();
    expect(view.state.reads).not.toContain('/api/cases/my-active'); expect(view.state.errors).toEqual([]);
  });
  test(`${surface}: failed and invalid choices recover without pretending the account has no Matters`, async ({ page }) => {
    const view = await install(page, surface); view.state.failChoices = true; await view.opener.click(); await expect(view.dialog).toHaveAttribute('data-state', 'error'); await expect(view.dialog).not.toContainText('No Matters');
    view.state.failChoices = false; view.state.wrongOwner = true; await view.dialog.getByRole('button', { name: 'Retry search' }).click(); await expect(view.dialog).toHaveAttribute('data-state', 'error');
    view.state.wrongOwner = false; await view.dialog.getByRole('button', { name: 'Retry search' }).click(); await expect(view.dialog).toHaveAttribute('data-state', 'choosing'); await expect(view.dialog.getByRole('button', { name: 'Retry search' })).toHaveCount(0);
    await view.dialog.getByLabel('Search Matters', { exact: true }).fill('not recorded'); await expect(view.dialog.getByRole('status')).toHaveText('No Matters match this search.'); await page.keyboard.press('Escape'); await expect(view.opener).toBeFocused(); expect(view.state.errors).toEqual([]);
  });
  test(`${surface}: an interrupted acknowledgement checks the recorded invitation before any second send`, async ({ page }) => {
    const view = await install(page, surface); view.state.send = route => reply(route, {}); await view.open(); await view.chooseOlder();
    await view.dialog.getByRole('button', { name: 'Send invitation', exact: true }).click(); await expect(view.dialog).toHaveAttribute('data-state', 'uncertain'); await expect(view.dialog.getByRole('button', { name: 'Send invitation', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape'); await view.opener.click(); await expect(view.dialog).toHaveAttribute('data-state', 'review'); await expect(view.dialog).toContainText('already awaiting'); expect(view.state.writes).toHaveLength(1); expect(view.state.pending.size).toBe(1); expect(view.state.errors).toEqual([]);
  });
  test(`${surface}: stale and stalled searches clear safely and a restored page can reopen the chooser`, async ({ page }) => {
    const view = await install(page, surface); let release, requested = false;
    view.state.delay = async search => { if (search === 'older') { requested = true; await new Promise(resolve => { release = resolve; }); } };
    await view.open(); await view.dialog.getByLabel('Search Matters', { exact: true }).fill('older'); await expect.poll(() => requested).toBe(true);
    await view.dialog.getByLabel('Search Matters', { exact: true }).fill('Matter 12'); await expect(view.dialog.locator('.lpc-invitation-choices button')).toHaveCount(1); release(); await expect(view.dialog.locator('.lpc-invitation-choices')).toContainText('Matter 12');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await expect(view.dialog).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await view.open();
    await page.clock.install(); requested = false;
    view.state.delay = async search => { if (search === 'stall') { requested = true; await new Promise(resolve => { release = resolve; }); } };
    await view.dialog.getByLabel('Search Matters', { exact: true }).fill('stall'); await expect.poll(() => requested).toBe(true); await page.clock.fastForward(31000);
    await expect(view.dialog).toHaveAttribute('data-state','error'); await expect(view.dialog.locator('.lpc-invitation-choices')).toHaveCount(0); release(); view.state.delay = null;
    await view.dialog.getByRole('button', { name: 'Retry search' }).click(); await expect(view.dialog).toHaveAttribute('data-state','choosing'); expect(view.state.errors).toEqual([]);
  });
  test(`${surface}: a pending send cannot be dismissed or submitted twice`, async ({ page }) => {
    const view = await install(page, surface); let release;
    view.state.send = async (route, receipt) => { await new Promise(resolve => { release = resolve; }); return reply(route, receipt); };
    await view.open(); await view.chooseOlder(); await view.dialog.getByRole('button', { name: 'Send invitation', exact: true }).click(); await expect.poll(() => !!release).toBe(true);
    await expect(view.dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled(); await expect(view.dialog.getByRole('button', { name: 'Send invitation', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(view.dialog).toBeVisible(); expect(view.state.writes).toHaveLength(1);
    release(); await expect(view.dialog).toHaveAttribute('data-state','sent'); await view.dialog.getByRole('button', { name: 'Done', exact: true }).click(); await expect(view.opener).toBeFocused(); expect(view.state.pending.size).toBe(1); expect(view.state.errors).toEqual([]);
  });
  test(`${surface}: a replacement session clears the invitation before any write`, async ({ page }) => {
    const view = await install(page, surface); await view.open(); await view.chooseOlder(); view.state.user = { ...view.state.user, id: id(9999), _id: id(9999) };
    await view.dialog.getByRole('button', { name: 'Send invitation', exact: true }).click(); await expect(view.dialog).toHaveCount(0);
    expect(view.state.writes).toEqual([]); expect(view.state.pending.size).toBe(0); expect(view.state.errors).toEqual([]);
  });
  test(`${surface}: invitation reading and sending remain usable in both themes and enlarged text`, async ({ page }, info) => {
    const view = await install(page, surface);
    for (const [width, theme, scale] of [[1440,'light',1],[390,'light',1],[390,'dark',1],[320,'dark',2]]) {
      await page.setViewportSize({ width, height: 960 }); await page.evaluate(({theme,scale}) => { document.documentElement.classList.toggle('theme-dark',theme==='dark'); document.body.classList.toggle('theme-dark',theme==='dark'); document.documentElement.style.fontSize=`${16*scale}px`; }, {theme,scale});
      await view.open(); await page.evaluate(() => document.fonts.ready);
      for (const phase of ['choices','review']) {
        if (phase === 'review') await view.chooseOlder();
        if (phase === 'choices') await view.dialog.locator('.lpc-invitation-choices button').first().hover();
        const scan = await new AxeBuilder({ page }).include('.lpc-invitation-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(scan.violations).toEqual([]);
        expect(await view.dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
        expect(await view.dialog.locator('.lpc-invitation-content').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
        expect(await view.dialog.locator('h2').evaluate(node => getComputedStyle(node).fontFamily)).toContain('Sarabun');
        for (const control of await view.dialog.locator('button:visible,input:visible').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: info.outputPath(`${surface}-${width}-${theme}-${scale}-${phase}.png`), animations: 'disabled' });
      }
      await page.keyboard.press('Escape'); await expect(view.opener).toBeFocused();
    }
    expect(view.state.errors).toEqual([]);
  });
}

test('profile applicant context opens an owned hiring review without loading the full Matter first', async ({ page }) => {
  const requests = [];
  await page.route(`**/api/cases/${id(1)}**`, route => {
    const url = new URL(route.request().url()); requests.push({ path: url.pathname, owner: url.searchParams.get('expectedOwnerId') });
    if (url.pathname !== `/api/cases/${id(1)}/hiring-review/${PARALEGAL}`) return reply(route, {}, 503);
    return reply(route, { ownerId: OWNER, caseId: id(1), applicantId: PARALEGAL, caseTitle: 'Selected estate Matter', name: 'Priya Ng', revision: 'a'.repeat(64), reason: 'application_unavailable', canHire: false, canResume: false, relisted: false, fundingVerified: false, assigned: false, budgetCents: null, feeCents: null, chargeCents: null, remainingCents: null, currency: 'usd', card: null });
  });
  const { state } = await install(page, 'profile', { applicant: true });
  const trigger = page.getByRole('button', { name: 'Review hire', exact: true }); await expect(trigger).toBeEnabled(); expect(requests).toEqual([]);
  await trigger.click(); await expect(page.locator('[data-hiring]')).toHaveAttribute('data-state', 'ready'); await expect(page.getByRole('dialog')).toContainText('Selected estate Matter');
  expect(requests).toEqual([{ path: `/api/cases/${id(1)}/hiring-review/${PARALEGAL}`, owner: OWNER }]); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});


test('directory pagination omits a single-page summary and wraps genuine paging controls at enlarged text', async ({ page }) => {
  const { state } = await install(page, 'directory'); await expect(page.locator('#pagination')).toBeHidden();
  state.directoryPages = 2; await page.reload(); await expect(page.locator('#pagination')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 960 }); await page.evaluate(() => document.documentElement.style.fontSize = '32px');
  await expect(page.locator('#paginationLabel')).toHaveText('Page 1 of 2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.locator('#nextPage').click(); await expect(page.locator('#paginationLabel')).toHaveText('Page 2 of 2'); await expect(page.locator('#nextPage')).toBeDisabled();
  await page.locator('#prevPage').click(); await expect(page.locator('#paginationLabel')).toHaveText('Page 1 of 2');
  expect(state.directoryPageReads).toEqual([1, 1, 2, 1]); expect(state.errors).toEqual([]);
});
