const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { eventPage } = require('./event-page-fixture');
test.use({ actionTimeout: 15000 });
const { USER, FIRST, RECOMMENDATION, FILE, LONG, active, json, installCurrentHome: fixture, home, tab, view } = require('./current-home-fixtures');
const work = page => page.locator('.lc-workspace');
const row = (page, id = FIRST) => page.locator(`[data-home-matter-id="${id}"]`);
const contextPane = page => page.locator('.lc-context');
async function refresh(page, accessMayChange = false) { await page.mouse.move(0, 0); await page.evaluate(accessMayChange => { document.activeElement?.blur(); window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'current-home-fixture', accessMayChange } })); }, accessMayChange); await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-freshness', 'current'); await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false'); }
async function deadlines(page) { await page.locator('[data-desktop-home-view="deadlines"]').click(); await expect(page.locator('[data-home-timeline]')).toBeVisible(); }
async function ready(page) { await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false'); }
// The same fifteen Home journeys now use the current tabs, contextual scope,
// Reviews, deadline timeline and account destinations. Financial reader tests
// separately verify actual retained records; these are synthetic UI projections.

test('recommendation and message identities retain their exact destinations', async ({ page }) => {
 const state = await fixture(page); await home(page); await tab(page, 'Recommended').click(); await page.locator('[data-home-recommendation-id]').click();
 await expect(contextPane(page).getByRole('link', { name: 'Review listing and apply', exact: true })).toHaveAttribute('href', `paralegal-v2.html#/browse?matterId=${RECOMMENDATION}`);
 state.notifications = [{ id: '64b000000000000000070099', type: 'message', message: 'Jordan sent a message.', context: { caseId: FIRST }, action: { label: 'Open message', href: `/case-detail.html?caseId=${FIRST}&tab=messages` }, createdAt: '2026-09-08T13:00:00Z', isRead: false, available: true }];
 await refresh(page); await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Home', exact: true }).click(); await view(page, 'inbox'); await page.locator('.lc-event').click(); await expect(page).toHaveURL(new RegExp(`#/matter/${FIRST}\\?tab=messages(?:&|$)`));
});

test('partial feeds preserve invitations and do not present failed deadlines or updates as empty', async ({ page }) => {
 await fixture(page, { failures: { events: 503, notifications: 503 } }); await home(page); await tab(page, 'Invitations').click(); await expect(page.locator('[data-home-invitation-id]')).toBeVisible();
 await deadlines(page); await expect(page.locator('[data-home-deadline-state="unavailable"]')).toContainText('Reminders for this period could not be loaded.');
 await expect(page.locator('[data-home-timeline]')).not.toContainText('No deadlines in this period.');
 await page.locator('[data-desktop-home-view="inbox"]').click(); await expect(work(page)).toContainText('These records could not be loaded.'); await expect(work(page)).not.toContainText('No recorded updates in this view.');
});

test('Deadlines loads all pages for the displayed six months and navigates beyond the old default window', async ({ page }) => {
 const events = Array.from({ length: 203 }, (_, index) => ({ id: (index + 100000).toString(16).padStart(24, '0'), owner: USER, type: 'deadline', start: '2026-09-10T12:00:00Z', isAllDay: true, title: `Personal reminder ${index + 1}` }));
 events.push({ id: '64b000000000000000090001', owner: USER, type: 'deadline', start: '2027-01-30T12:00:00Z', isAllDay: true, title: 'January filing reminder' }, { id: '64b000000000000000090002', owner: USER, type: 'deadline', start: '2027-06-04T12:00:00Z', isAllDay: true, title: 'June filing reminder' });
 const state = await fixture(page, { events: { items: events } }); await home(page, '?view=deadlines'); await ready(page);
 const timeline = page.locator('[data-home-timeline]');
 await expect(timeline).toHaveAttribute('data-deadline-range', '2026-08-01:2027-02-01');
 await expect(timeline).toContainText('Personal reminder 203'); await expect(timeline).toContainText('January filing reminder'); await expect(timeline).not.toContainText('June filing reminder');
 expect(state.reads.events).toBe(2);
 await page.getByRole('button', { name: 'Next three months', exact: true }).click();
 await expect(timeline).toHaveAttribute('data-deadline-range', '2026-11-01:2027-05-01'); await expect(timeline).toHaveAttribute('aria-busy', 'false');
 await expect(timeline).toContainText('January filing reminder'); await expect(timeline).not.toContainText('Personal reminder 203');
 await page.getByRole('button', { name: 'Next three months', exact: true }).click();
 await expect(timeline).toHaveAttribute('data-deadline-range', '2027-02-01:2027-08-01'); await expect(timeline).toContainText('June filing reminder');
 await page.getByRole('button', { name: 'Today', exact: true }).click(); await expect(timeline).toContainText('Personal reminder 203');
 expect(state.reads.events).toBe(4);
});

test('Deadlines rejects a failed later page, recovers explicitly and keeps verified Matter dates', async ({ page }) => {
 const events = Array.from({ length: 201 }, (_, index) => ({ id: (index + 100000).toString(16).padStart(24, '0'), owner: USER, type: 'deadline', start: '2026-09-10T12:00:00Z', isAllDay: true, title: `Private deadline ${index + 1}` }));
 const state = await fixture(page, { events: { items: events } }); let fail = true;
 state.eventRespond = route => { const params = new URL(route.request().url()).searchParams; return fail && params.get('page') === '2' ? json(route, { error: 'Synthetic later page failed.' }, 503) : json(route, eventPage(USER, events, params)); };
 await home(page, '?view=deadlines'); await expect(page.locator('[data-home-deadline-state="unavailable"]')).toBeVisible();
 const timeline = page.locator('[data-home-timeline]'); await expect(timeline).toContainText(LONG); await expect(timeline).not.toContainText('Private deadline 1'); await expect(timeline).not.toContainText('No deadlines in this period.');
 fail = false; await page.locator('[data-home-deadline-retry]').click(); await expect(timeline).toContainText('Private deadline 201'); await expect(page.locator('[data-home-deadline-state]')).toHaveCount(0);
});

test('a different Home feed timing out cannot disable reminder retry or later period reads', async ({ page }) => {
 const reminder = { id: '64b000000000000000090006', owner: USER, type: 'deadline', start: '2027-01-20T12:00:00Z', isAllDay: true, title: 'Recovered January reminder' };
 const state = await fixture(page, { events: { items: [reminder] }, failures: { events: 503 } });
 let release; const held = new Promise(resolve => release = resolve);
 await page.route('**/api/payments/connect/status', async route => { await held; await json(route, { error: 'Synthetic delayed optional feed.' }, 503).catch(() => {}); });
 try {
  // This case intentionally exceeds the ordinary helper's five-second load
  // expectation so the real ten-second Home request timeout can take effect.
  await page.goto('/paralegal-v2.html#/home?view=deadlines', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  await expect(page.locator('[data-home-deadline-state="unavailable"]')).toBeVisible();
  await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false', { timeout: 15000 });
  delete state.failures.events; await page.locator('[data-home-deadline-retry]').click();
  await expect(page.locator('[data-home-timeline]')).toContainText('Recovered January reminder');
  await page.getByRole('button', { name: 'Next three months', exact: true }).click();
  await expect(page.locator('[data-home-timeline]')).toHaveAttribute('data-deadline-range', '2026-11-01:2027-05-01');
  await expect(page.locator('[data-home-timeline]')).toContainText('Recovered January reminder');
 } finally { release(); }
});

test('a late prior period cannot replace the selected calendar and its next control keeps focus', async ({ page }) => {
 const state = await fixture(page); await home(page, '?view=deadlines'); await ready(page);
 let release, requested = false; const held = new Promise(resolve => release = resolve);
 state.eventRespond = async route => {
  const params = new URL(route.request().url()).searchParams;
  if (params.get('from') === '2026-11-01T00:00:00.000Z') { requested = true; await held; }
  return json(route, eventPage(USER, [{ id: '64b000000000000000090003', owner: USER, type: 'deadline', start: '2027-01-20T12:00:00Z', isAllDay: true, title: 'Obsolete selected period' }], params));
 };
 try {
  const next = page.getByRole('button', { name: 'Next three months', exact: true }); await next.focus(); await next.press('Enter'); await expect.poll(() => requested).toBe(true);
  await expect(next).toBeFocused(); await next.press('Enter');
  await expect(page.locator('[data-home-timeline]')).toHaveAttribute('data-deadline-range', '2027-02-01:2027-08-01'); await expect(page.locator('[data-home-timeline]')).toHaveAttribute('aria-busy', 'false');
 } finally { release(); }
 await expect(page.locator('[data-home-timeline]')).not.toContainText('Obsolete selected period'); await expect(page.getByRole('button', { name: 'Next three months', exact: true })).toBeFocused();
});

test('Deadlines presents a contained mobile agenda and readable desktop timeline with long titles', async ({ page }, info) => {
 const title = `Private follow-up for the remaining lease exhibits ${'annex'.repeat(24)}`;
 const state = await fixture(page, { events: { items: [
  { id: '64b000000000000000090004', owner: USER, caseId: FIRST, type: 'deadline', start: '2026-09-10T12:00:00Z', isAllDay: true, title },
  { id: '64b000000000000000090005', owner: USER, type: 'deadline', start: '2027-01-30T12:00:00Z', isAllDay: true, title: 'January follow-up' },
 ] } });
 await home(page, '?view=deadlines'); await ready(page); const timeline = page.locator('[data-home-timeline]');
 for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
  state.profile.preferences = { ...state.profile.preferences, theme };
  await page.setViewportSize({ width, height: 1000 });
  await page.evaluate(theme => { document.documentElement.classList.remove('theme-light', 'theme-dark'); document.documentElement.classList.add(`theme-${theme}`); }, theme);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(resolve)); await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
  const geometry = await timeline.evaluate((root, width) => {
   const rows = [...root.querySelectorAll('.ld-deadline-marker')].map(node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, overflow: node.scrollWidth > node.clientWidth + 1 }; });
   return { overflow: document.documentElement.scrollWidth > innerWidth + 1, clipped: rows.some(r => r.overflow || width <= 700 && (r.x < 0 || r.right > innerWidth + 1)), overlap: rows.some((r, i) => i && rows[i - 1].bottom > r.y + 1), horizontalAgenda: width <= 700 && root.scrollWidth > root.clientWidth + 1 };
  }, width);
  expect(geometry).toEqual({ overflow: false, clipped: false, overlap: false, horizontalAgenda: false });
  expect((await new AxeBuilder({ page }).include('[data-home-timeline]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath(`deadlines-${theme}-${width}.png`), animations: 'disabled' });
 }
 await page.getByRole('tab', { name: 'Private reminders', exact: true }).click();
 await expect(timeline.locator('time').filter({ hasText: 'Private reminder' })).toHaveCount(0); await expect(timeline).toContainText(title);
});

test('a private event ID never becomes a Matter destination', async ({ page }) => {
 const eventId = '64b000000000000000070077'; await fixture(page, { events: { items: [{ id: eventId, _id: eventId, owner: USER, caseId: null, title: 'Private follow-up', type: 'deadline', start: '2026-09-09' }] } }); await home(page); await deadlines(page);
 await expect(page.locator('[data-home-timeline]')).toContainText('Private follow-up'); await expect(page.locator('[data-home-timeline]')).toContainText('Private reminder'); await expect(page.locator(`a[href*="/matter/${eventId}"]`)).toHaveCount(0);
});

test('one authoritative Home projection keeps assigned work, applications and earnings distinct', async ({ page }) => {
 await fixture(page, { dashboard: { activeCases: [active()], metrics: { earnings: 840, earningsLast30Days: 1120, earningsTotal: 4820, expectedPayouts: 640 } } }); await home(page);
 await expect(tab(page, 'Assigned')).toHaveAttribute('aria-selected', 'true'); await expect(row(page)).toHaveCount(1); await expect(page.locator('.lc-list')).not.toContainText('Contract chronology review');
 await tab(page, 'Applications').click(); await page.locator('[data-home-application-id]').click(); await expect(contextPane(page)).toContainText('Shortlisted'); await expect(contextPane(page)).not.toContainText('Hired');
 await home(page, '?view=history'); await expect(page.getByRole('heading', { name: 'Payouts', exact: true })).toBeVisible(); await expect(page.locator('[data-payout-totals]')).toContainText('$4,820.00'); await expect(page.locator('[data-payout-totals]')).not.toContainText('$640.00');
});

test('private reminders never replace the shared Matter deadline', async ({ page }) => {
 await fixture(page, { events: { items: [{ _id: '64b000000000000000070078', owner: USER, caseId: null, title: 'Personal follow-up', type: 'deadline', start: '2026-09-09' }] } }); await home(page);
 await expect(row(page)).toContainText('Oct 1'); await deadlines(page); const marker = page.locator('.ld-deadline-marker').filter({ hasText: LONG }); await expect(marker).toContainText('Oct 1'); await expect(page.locator('[data-home-timeline]')).toContainText('Personal follow-up'); await expect(marker).not.toContainText('Sep 9');
});

test('application context remains readable with the Assistant open and on a narrow screen', async ({ page }, info) => {
 const state = await fixture(page); state.applications[0].jobId.title = 'Employment records review with a long scope across several jurisdictions'; await page.setViewportSize({ width: 1440, height: 1000 }); await home(page); await tab(page, 'Applications').click(); await page.locator('[data-home-application-id]').click();
 await page.getByRole('button', { name: 'Open LPC Assistant', exact: true }).click(); await expect(page.locator('body')).toHaveClass(/support-drawer-open/);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(contextPane(page)).toContainText('Employment records review'); await page.screenshot({ path: info.outputPath('application-with-assistant.png') });
 await page.getByRole('button', { name: 'Close assistant', exact: true }).click(); await page.setViewportSize({ width: 320, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(contextPane(page)).toContainText('Employment records review'); await page.screenshot({ path: info.outputPath('application-phone.png') });
});

test('payout setup is contextual to finding work and a failed setup request remains retryable', async ({ page }) => {
 await fixture(page, { stripe: { readiness: { ready: false } }, dashboard: { activeCases: [], metrics: {} }, invites: { items: [] }, applications: [] }); await home(page);
 const setup = page.getByLabel('Application and invitation requirements', { exact: true }); await expect(setup.getByRole('heading', { name: 'Set up payouts', exact: true })).toHaveCount(1); await expect(page.locator('[data-home-matter-id]')).toHaveCount(0); await expect(page.locator('[data-home-recommendation-id]')).toHaveCount(1);
 let requests = 0; await page.route('**/api/payments/connect', route => { requests++; return json(route, requests === 1 ? { error: 'Stripe is temporarily unavailable. Try again.' } : { url: 'https://connect.stripe.com/setup/synthetic-home-test' }, requests === 1 ? 503 : 200); });
 await page.route('https://connect.stripe.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic payout setup</h1>' }));
 const connect = setup.getByRole('button', { name: 'Continue to Stripe', exact: true }); await connect.click(); await expect(page.locator('[data-v2-toast-region]')).toContainText('Stripe is temporarily unavailable.'); await expect(connect).toBeEnabled(); await connect.click(); await expect(page).toHaveURL('https://connect.stripe.com/setup/synthetic-home-test'); expect(requests).toBe(2);
});

test('finding-work requirements appear once and disappear only after confirmed completion', async ({ page }, info) => {
 const state = await fixture(page); state.stripe.readiness.ready = false; Object.assign(state.profile, { stateExperience: [], practiceAreas: [], yearsExperience: null }); state.recommendations.hasMatchingProfile = false; await home(page); await tab(page, 'Recommended').click();
 const setup = page.getByLabel('Application and invitation requirements', { exact: true }); await expect(setup).toHaveCount(1); await expect(setup.getByRole('heading', { name: 'Set up payouts', exact: true })).toHaveCount(1); await expect(setup.getByRole('heading', { name: 'Complete your professional profile', exact: true })).toHaveCount(1); await expect(setup.getByRole('link', { name: 'Update profile', exact: true })).toHaveAttribute('href', 'paralegal-v2.html#/settings?tab=profile');
 for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
  await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => document.documentElement.classList.toggle('theme-dark', theme === 'dark'), theme);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => tab(page, 'Recommended').evaluate(el => { const active=el.getBoundingClientRect(), frame=el.parentElement.getBoundingClientRect(); return active.left>=frame.left-1 && active.right<=frame.right+1; })).toBe(true);
  for (const control of await setup.locator('button,a').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include('.lc-workspace').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath(`finding-work-setup-${theme}-${width}.png`) });
 }
 await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => document.documentElement.classList.remove('theme-dark'));
 await tab(page, 'Assigned').click(); await expect(setup).toHaveCount(0); await expect(row(page)).toBeVisible(); await tab(page, 'Recommended').click(); await expect(setup).toHaveCount(1);
 state.stripe.readiness.ready = true; await refresh(page); await expect(setup.getByRole('heading', { name: 'Set up payouts', exact: true })).toHaveCount(0); await expect(setup.getByRole('heading', { name: 'Complete your professional profile', exact: true })).toHaveCount(1);
 Object.assign(state.profile, { stateExperience: ['New York'], practiceAreas: ['Civil Litigation'], yearsExperience: 6 }); state.recommendations.hasMatchingProfile = true; await refresh(page); await expect(setup).toHaveCount(0);
});

async function availabilityRoute(page, state) {
 await page.route('**/api/paralegals/update-availability', route => { expect(route.request().postDataJSON()).toEqual({ expectedOwnerId: USER, expectedValues: { availability: { availability: state.profile.availability, availabilityDetails: state.profile.availabilityDetails } }, status: 'unavailable', nextAvailable: '2026-09-18' }); Object.assign(state.profile, { availability: 'Unavailable', availabilityDetails: { status: 'unavailable', nextAvailable: '2026-09-18', updatedAt: '2026-09-08T18:00:00Z' } }); return json(route, { ownerId: USER, availability: state.profile.availability, availabilityDetails: state.profile.availabilityDetails }); });
}
async function saveAvailability(page) { await page.locator('[data-v2-availability-trigger]').click(); await page.getByLabel('Availability', { exact: true }).selectOption('unavailable'); await page.getByLabel('Available again', { exact: true }).fill('2026-09-18'); await page.getByRole('button', { name: 'Save availability', exact: true }).click(); }

test('availability updates in Updates and navigation retains the persistent shell', async ({ page }) => {
 const state = await fixture(page); await availabilityRoute(page, state); await home(page, '?view=pulse'); await saveAvailability(page); await expect(page.locator('[data-v2-availability-trigger]')).toContainText('Not available');
 await page.locator('[data-v2-availability-trigger]').click(); await expect(page.getByLabel('Availability', { exact: true })).toHaveValue('unavailable'); await expect(page.getByLabel('Available again', { exact: true })).toHaveValue('2026-09-18'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Matters', exact: true }).click(); await expect(page.locator('[data-v2-work]')).toBeVisible(); await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Home', exact: true }).click(); await view(page, 'pulse'); await expect(page.locator('[data-v2-availability-trigger]')).toContainText('Not available');
 expect(await page.evaluate(() => window.__desktopOriginalDocument === document && window.__desktopOriginalSidebar === document.querySelector('[data-v2-persistent="sidebar"]'))).toBe(true);
});

test('confirmed availability refreshes another open tab without a document reload', async ({ page, context }) => {
 const state = await fixture(page), second = await context.newPage(); await fixture(second, { profile: state.profile, dashboard: state.dashboard }); await availabilityRoute(page, state); await home(page, '?view=pulse'); await home(second, '?view=pulse');
 await saveAvailability(page); await expect(second.locator('[data-v2-availability-trigger]')).toContainText('Not available'); expect(await second.evaluate(() => window.__desktopOriginalDocument === document && window.__desktopOriginalSidebar === document.querySelector('[data-v2-persistent="sidebar"]'))).toBe(true); await second.close();
});

test('assigned work uses real due-date order without mixing setup or recommendations into it', async ({ page }, info) => {
 const cases = [['Undated work', ''], ['Routine work', '2026-10-01'], ['Due soon work', '2026-09-09'], ['Overdue work', '2026-09-01']].map(([jobTitle, deadlineDate], n) => active({ caseId: `64b00000000000000000800${n + 1}`, jobTitle, deadlineDate }));
 const state = await fixture(page, { dashboard: { activeCases: cases, metrics: {} }, stripe: { readiness: { ready: false } } }); await page.route('**/api/uploads/case/*?presentation=matter', route => json(route, { files: [] })); await home(page);
 expect(await page.locator('[data-home-matter-id] .lc-record-title').allTextContents()).toEqual(['Overdue work', 'Due soon work', 'Routine work', 'Undated work']); await expect(tab(page, 'Assigned')).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('.lc-list')).not.toContainText('Set up payouts'); await expect(page.locator('.lc-list')).not.toContainText('Contract chronology review');
 expect(state.protectedReads.filter(r => r.path.startsWith('/api/cases/'))).toEqual([]); for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`ordered-work-${width}.png`) }); }
});

test('pre-hiring context asks for exactly the required conflicts and confidentiality information', async ({ page }) => {
 const state = await fixture(page);
 for (const [conflicts, confidentiality] of [[true, false], [false, true], [true, true]]) {
  state.applications[0].preEngagement = { status: 'requested', requestedParalegalId: USER, conflictsCheckRequired: conflicts, confidentialityAgreementRequired: confidentiality, requestedAt: '2026-09-07T12:00:00Z' }; await home(page, '?view=applications'); await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await page.locator('[data-home-application-id]').click();
  await expect(contextPane(page).getByText('Disclose a possible conflict', { exact: true })).toHaveCount(conflicts ? 1 : 0); await expect(contextPane(page).getByLabel('Upload signed confidentiality agreement', { exact: true })).toHaveCount(confidentiality ? 1 : 0); await expect(contextPane(page).getByRole('button', { name: 'Submit to attorney', exact: true })).toHaveCount(1);
 }
});

test('Home keeps its current surface, readable text and usable controls in both themes and at 200 percent text', async ({ page }, info) => {
 test.setTimeout(180000); await fixture(page); await home(page); await page.emulateMedia({ reducedMotion: 'reduce' });
 for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
  await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => document.documentElement.classList.toggle('theme-dark', theme === 'dark'), theme); await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.lc-list')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(17, 27, 42)' : 'rgb(255, 255, 255)'); await expect(work(page).locator('h1')).toHaveText('My work'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scan = await new AxeBuilder({ page }).include('.lc-workspace').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(scan.violations).toEqual([]); await page.screenshot({ path: info.outputPath(`home-${theme}-${width}.png`) });
 }
 await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => document.documentElement.style.fontSize = '34px'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await row(page).first().locator('.lc-record-title').evaluate(el => { const s = getComputedStyle(el); return parseFloat(s.lineHeight) >= parseFloat(s.fontSize); })).toBe(true); await page.screenshot({ path: info.outputPath('home-200-percent.png') });
});

test('routine work needs no scope prefetch and a failed optional feed preserves authorized work', async ({ page }) => {
 const state = await fixture(page); await home(page); expect(state.protectedReads.filter(r => r.path.startsWith('/api/cases/'))).toEqual([]); await expect(row(page)).toBeVisible();
 state.failures.notifications = 503; await refresh(page); await expect(row(page)).toBeVisible(); await row(page).click(); await expect(contextPane(page)).toContainText('Prepare a verified chronology'); await expect(contextPane(page).getByRole('link', { name: 'Open files and revisions', exact: true })).toHaveAttribute('href', new RegExp(`#/matter/${FIRST}\\?tab=files&fileId=${FILE}$`));
});

test('revision context uses authorized file records and keeps its exact Files destination', async ({ page }) => {
 const state = await fixture(page); let releaseFiles, requested = false; const gate = new Promise(resolve => { releaseFiles = resolve; });
 await page.route(`**/api/uploads/case/${FIRST}?presentation=matter`, async route => { requested = true; await gate; return state.failures.files ? json(route, { error: 'Files unavailable' }, state.failures.files) : json(route, { files: state.files[FIRST] }); });
 await page.goto('/paralegal-v2.html#/home'); await expect.poll(() => requested).toBe(true); await expect(work(page)).not.toContainText('Correct citations on pages 3–5 and replace exhibit 4.'); releaseFiles(); await ready(page); await expect(row(page)).toContainText('Correct citations on pages 3–5 and replace exhibit 4.');
 expect(state.protectedReads.filter(r => r.path.startsWith('/api/cases/'))).toEqual([]); await view(page, 'reviews'); await page.locator('.lc-event').click(); await expect(contextPane(page)).toContainText('Correct citations on pages 3–5 and replace exhibit 4.');
 await expect(contextPane(page).getByRole('link', { name: 'Upload revision', exact: true })).toHaveAttribute('href', `paralegal-v2.html#/matter/${FIRST}?tab=files&fileId=${FILE}`);
 state.failures.files = 403; await refresh(page, true); await expect(work(page)).not.toContainText('Correct citations on pages 3–5 and replace exhibit 4.'); await expect(work(page)).toContainText(/access|verified/i);
});
