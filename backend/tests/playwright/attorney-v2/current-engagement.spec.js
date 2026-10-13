const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { randomUUID } = require('node:crypto');
const { inventoryFixture } = require('./inventory-fixture');
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get('/api/csrf')).json();
  const user = (await (await client.get('/api/auth/me')).json()).user;
  const response = await client[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
test.beforeAll(async ({ playwright, baseURL }) => {
  expect(new URL(baseURL).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { 'x-ai-control-room-e2e-secret': process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const response = await para.post('/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal', { headers });
  expect(response.ok()).toBeTruthy();
  const bootstrap = await response.json(), csrf = await (await para.get('/api/csrf')).json();
  const login = await para.post('/api/auth/login', { headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { email: bootstrap.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || 'ControlRoomSupport123!' } });
  expect(login.ok()).toBeTruthy();
  const user = (await (await para.get("/api/auth/me")).json()).user; paraId = user.id || user._id;
});
test.afterAll(async () => { await para?.dispose(); });
// Finish route.fetch/response readers before Playwright disposes their request context.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

const card = { paymentMethod: { id: 'pm_synthetic', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2029 } };
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function fixture(page, pre = false) {
  const draft = (await api(page.request, 'post', '/api/case-drafts', { title: 'Synthetic current engagement', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic engagement verification.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const { publication } = await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' });
  const id = publication.caseId;
  await api(para, 'post', `/api/cases/${id}/apply`, { coverLetter: 'Private synthetic application.' });
  if (pre) {
    await api(page.request, 'post', `/api/cases/${id}/pre-engagement/${paraId}/request`, { conflictsCheckRequired: true, conflictsDetails: 'Synthetic parties.' });
    await api(para, 'post', `/api/cases/${id}/pre-engagement/respond`, { conflictsResponseType: 'none_known' });
  }
  await page.route('**/api/payments/payment-method/default', route => fulfill(route, card));
  await page.goto('/dashboard-attorney.html#cases:inquiries', { waitUntil: 'domcontentloaded' });
  const row = page.locator(`.matter-queue-row[data-case-id="${id}"]:visible`);
  await row.getByRole('button', { name: 'Review 1 applicant', exact: true }).click();
  const drawer = page.locator(`[data-applicants-drawer][data-case-id="${id}"]`);
  await expect(drawer.locator('[data-applicant-detail]')).toBeVisible();
  return { id, drawer };
}

const modal = page => page.locator('#caseNoteModal');
const panel = page => modal(page).locator('[data-hiring]');
async function reviewed(page, { reason = 'ready', mode = 'hire_and_fund', lost = false, parentFailure = false } = {}) {
  const { id, drawer } = await fixture(page), owner = (await (await page.request.get('/api/auth/me')).json()).user, ownerId = owner.id || owner._id;
  const state = { assigned: false, changed: false, writes: 0, parentFailure };
  const interactionBudget = test.info().timeout;
  let inventoryPreparationStarted;
  const inventoryReadTimeout = 30_000;
  // The synthetic hire intercepts the writer. Project that same simulated
  // assignment into the complete inventory, as the existing detail fixture does.
  async function assignedInventory() {
    const data = { active: [], archived: [], drafts: { items: [] } };
    for (const view of ['active', 'applications']) {
      const readPage = async pageNumber => {
        // Keep each finite preparation batch within the existing API timeout,
        // without charging all accumulated pages to the hiring interaction.
        test.setTimeout(interactionBudget + Math.ceil(performance.now() - inventoryPreparationStarted) + inventoryReadTimeout);
        const response = await page.request.get(`/api/cases/inventory?${new URLSearchParams({ expectedOwnerId: ownerId, view, page: String(pageNumber) })}`, { timeout: inventoryReadTimeout });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const first = await readPage(1);
      expect(Number.isSafeInteger(first.pages)).toBe(true);
      expect(first.pages).toBeGreaterThanOrEqual(0);
      const values = [first];
      // Keep the complete actual inventory, with at most four independent
      // fixture reads in flight instead of serializing the accumulated pages.
      for (let start = 2; start <= first.pages; start += 4) {
        const pages = Array.from({ length: Math.min(4, first.pages - start + 1) }, (_, offset) => start + offset);
        values.push(...await Promise.all(pages.map(readPage)));
      }
      for (const value of values) for (const item of value.items) {
        if (String(item.id || item._id) === id) Object.assign(item, { status: 'in progress', paralegal: paraId, paralegalId: paraId, escrowStatus: 'funded', escrowIntentId: 'pi_synthetic', applicantsCount: 0, applicants: [] });
        (item.recordType === 'draft' ? data.drafts.items : view === 'archived' ? data.archived : data.active).push(item);
      }
    }
    return data;
  }
  // Read all synthetic account pages before the interaction. The full browser
  // matrix accumulates Matters; fixture preparation must not consume
  // the UI's post-hire refresh deadline. Serve this projection only once the
  // intercepted hire has actually recorded its simulated assignment.
  let inventorySnapshot;
  inventoryPreparationStarted = performance.now();
  try {
    inventorySnapshot = await assignedInventory();
  } finally {
    // Preserve the original 45/90/120-second budget for every other part of
    // the scenario, including fixture creation and the actual hiring actions.
    test.setTimeout(interactionBudget + Math.ceil(performance.now() - inventoryPreparationStarted));
  }
  await page.route('**/api/cases/inventory?**', async route => {
    const query = new URL(route.request().url()).searchParams;
    if (!state.assigned || !['active', 'applications'].includes(query.get('view'))) return route.fallback();
    const response = await route.fetch(); expect(response.ok(), await response.text()).toBe(true);
    const original = await response.json(), projected = await inventoryFixture(inventorySnapshot, ownerId, query);
    return fulfill(route, { ...projected, practices: original.practices, counts: { ...original.counts, active: projected.counts.active, applications: projected.counts.applications } });
  });
  const value = () => ({ ownerId, caseId: id, applicantId: paraId, caseTitle: 'Synthetic current engagement', name: 'Synthetic selected paralegal', revision: (state.assigned ? 'e' : state.changed ? 'f' : 'd').repeat(64), reason: state.assigned ? 'assigned' : mode === 'finish_hire' ? 'reconciliation' : reason, canHire: !state.assigned && mode !== 'finish_hire' && reason === 'ready', canResume: !state.assigned && mode === 'finish_hire', relisted: mode === 'replacement', assigned: state.assigned, fundingVerified: state.assigned || mode !== 'hire_and_fund', budgetCents: 40001, feeCents: mode === 'replacement' ? 0 : 8800, chargeCents: mode === 'replacement' ? 0 : 48801, remainingCents: mode === 'replacement' ? 12000 : null, currency: 'usd', card: !state.assigned && mode === 'hire_and_fund' && reason === 'ready' ? { id: 'pm_synthetic', type: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2029 } : null });
  await page.route(`**/api/cases/${id}/hiring-review/${paraId}?**`, route => fulfill(route, value()));
  await page.route('**/api/applications/my-postings?**', async route => {
    const response = await route.fetch(), data = await response.json();
    await fulfill(route, state.assigned ? data.filter(item => String(item.caseId?._id || item.caseId || '') !== id) : data);
  });
  await page.route(`**/api/cases/${id}?expectedOwnerId=**`, async route => {
    if (state.parentFailure) return fulfill(route, { error: 'Synthetic parent unavailable' }, 503);
    const response = await route.fetch(), data = await response.json();
    if (state.assigned) Object.assign(data, { status: 'in progress', paralegal: paraId, paralegalId: paraId, escrowStatus: 'funded', escrowIntentId: 'pi_synthetic', applicantsCount: 0, applicants: [] });
    await fulfill(route, data);
  });
  await page.route(`**/api/cases/${id}/hire/${paraId}`, async route => {
    state.writes++; const input = route.request().postDataJSON(); expect(input.expectedOwnerId).toBe(ownerId);
    if (input.reviewedRevision !== value().revision) return fulfill(route, { code: 'HIRING_CHANGED' }, 409);
    const selected = value(); state.assigned = true;
    if (lost) return route.abort('failed');
    return fulfill(route, { hiringConfirmation: { caseId: id, applicantId: paraId, reviewedRevision: selected.revision, mode, chargeCents: mode === 'finish_hire' ? 0 : selected.chargeCents, budgetCents: 40001, remainingCents: selected.remainingCents } });
  });
  await drawer.locator('[data-hire-paralegal]').click(); await expect(panel(page)).toHaveAttribute('data-state', 'ready');
  return { id, state, value };
}
async function confirmation(page) { await panel(page).getByRole('button', { name: 'Review hiring confirmation', exact: true }).click(); }
test('current hiring reviews exact figures once, permits cancellation and submits one selected charge', async ({ page }) => {
  const { id, state } = await reviewed(page);
  await expect(panel(page)).toContainText('visa ending in 4242'); await confirmation(page);
  await expect(panel(page).getByText('Total card charge: $488.01', { exact: true })).toHaveCount(1);
  await expect(panel(page).getByText('Attorney platform fee: $88.00', { exact: true })).toHaveCount(1);
  await panel(page).getByRole('button', { name: 'Return to hiring review', exact: true }).click(); expect(state.writes).toBe(0);
  await confirmation(page); await panel(page).getByRole('button', { name: 'Hire and charge $488.01', exact: true }).click();
  await expect(panel(page)).toContainText("This paralegal is assigned, and the Matter's funding is verified."); expect(state.writes).toBe(1);
  await expect(panel(page).getByRole('link', { name: 'Open this Matter', exact: true })).toHaveAttribute('href', `/case-detail.html?caseId=${id}`);
  await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator(`.matter-queue-row[data-case-id="${id}"]:visible`)).toHaveCount(0);
  await page.getByRole('tab', { name: /^Active/ }).click();
  await page.getByRole('searchbox', { name: 'Search matters', exact: true }).fill('Synthetic current engagement');
  await expect(page.locator(`.matter-queue-row[data-case-id="${id}"]:visible`)).toBeVisible();
});
test('current stale hiring confirmation cannot submit a new revision silently', async ({ page }) => {
  const { state } = await reviewed(page); await confirmation(page); state.changed = true;
  await panel(page).getByRole('button', { name: 'Hire and charge $488.01', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-state', 'uncertain'); expect(state.writes).toBe(1); expect(state.assigned).toBe(false);
  await panel(page).getByRole('button', { name: 'Check saved hiring details', exact: true }).click(); await expect(panel(page)).toHaveAttribute('data-state', 'ready');
});
test('current lost hiring response survives closing and recovers without a second submission', async ({ page }) => {
  const { id, state } = await reviewed(page, { lost: true }); await confirmation(page);
  await panel(page).getByRole('button', { name: 'Hire and charge $488.01', exact: true }).click(); await expect(panel(page)).toHaveAttribute('data-state', 'uncertain');
  await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
  const hire = page.locator(`[data-applicants-drawer][data-case-id="${id}"] [data-hire-paralegal]`); await expect(hire).toBeFocused(); await hire.click();
  await expect(panel(page)).toHaveAttribute('data-state', 'uncertain');
  await panel(page).getByRole('button', { name: 'Check saved hiring details', exact: true }).click();
  await expect(panel(page)).toContainText('This paralegal is assigned'); expect(state.writes).toBe(1);
  await expect(page.locator('[data-application-parent-status]')).toBeHidden();
});
test('a confirmed current hire retains the old list under a visible failed-refresh notice until Retry succeeds', async ({ page }) => {
  const { id, state } = await reviewed(page, { parentFailure: true }); await confirmation(page);
  await panel(page).getByRole('button', { name: 'Hire and charge $488.01', exact: true }).click(); await expect(panel(page)).toContainText('This paralegal is assigned');
  await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
  const status = page.locator('[data-application-parent-status]'); await expect(status).toContainText('Matter and applications could not be refreshed.');
  await expect(page.locator(`.matter-queue-row[data-case-id="${id}"]:visible`)).toBeVisible(); state.parentFailure = false;
  await status.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(status).toBeHidden();
  await expect(page.locator(`.matter-queue-row[data-case-id="${id}"]:visible`)).toHaveCount(0); expect(state.writes).toBe(1);
});
for (const mode of ['replacement', 'finish_hire']) test(`current ${mode} confirmation uses existing money with no new charge`, async ({ page }) => {
  const { state } = await reviewed(page, { mode });
  await panel(page).getByRole('button', { name: mode === 'replacement' ? 'Review hiring confirmation' : 'Review recorded charge and hire', exact: true }).click();
  await expect(panel(page)).toContainText(mode === 'replacement' ? 'Remaining amount for replacement work: $120.00' : 'Earlier charge verified: $488.01');
  await expect(panel(page)).toContainText('No new card charge');
  await panel(page).getByRole('button', { name: mode === 'replacement' ? 'Hire replacement paralegal' : 'Finish hire using recorded charge', exact: true }).click();
  await expect(panel(page)).toContainText('This paralegal is assigned'); expect(state.writes).toBe(1);
  await expect(page.locator('[data-application-parent-status]')).toBeHidden();
});
test('current account change clears a displayed hiring confirmation', async ({ page }) => {
  const { state } = await reviewed(page); await confirmation(page);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', newValue: JSON.stringify({ id: '0'.repeat(24), role: 'attorney' }) })));
  await expect(modal(page)).toBeHidden(); await expect(panel(page)).toHaveCount(0); expect(state.writes).toBe(0);
});
test('current card setup saves and returns to the exact selected applicant without submitting a hire', async ({ page }, info) => {
  const draft = (await api(page.request, 'post', '/api/case-drafts', { title: 'Earlier saved card application', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Separate synthetic selection for card return verification.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const { publication } = await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' });
  await api(para, 'post', `/api/cases/${publication.caseId}/apply`, { coverLetter: 'Synthetic earlier application.' });
  const owner = (await (await page.request.get('/api/auth/me')).json()).user;
  const earlier = await api(page.request, 'get', `/api/users/me/pending-hire?expectedOwnerId=${owner.id || owner._id}`);
  const receipt = await api(page.request, 'put', '/api/users/me/pending-hire', { caseId: publication.caseId, paralegalId: paraId, reviewedRevision: earlier.revision });
  expect(receipt).toMatchObject({ saved: true, caseId: publication.caseId, paralegalId: paraId });
  const { id, state } = await reviewed(page, { reason: 'card_required' });
  const saved = modal(page).locator('[data-hiring-return]'); await expect(saved).toHaveAttribute('data-state', 'ready');
  await expect(saved).toContainText('Earlier saved card application');
  for (const [width, theme, scale] of [[1366, 'light', 1], [390, 'dark', 1], [320, 'dark', 2]]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(({ theme, scale }) => { window.applyThemePreference(theme); document.documentElement.style.fontSize = `${scale * 100}%`; }, { theme, scale });
    const action = saved.getByRole('button', { name: /^(Add payment card|Continue with this applicant)$/ }); await action.scrollIntoViewIfNeeded(); await action.focus(); await expect(action).toBeFocused();
    const geometry = await saved.evaluate(node => {
      const heading = node.querySelector('h2,h3,h4').getBoundingClientRect(), firstText = [...node.querySelectorAll('p')].find(p => p.textContent.trim() && p.getClientRects().length).getBoundingClientRect();
      const groups = [...node.querySelectorAll('.av2-actions')].filter(group => group.getBoundingClientRect().height > 0);
      const crowded = groups.some(group => { const controls = [...group.querySelectorAll('button,a')].filter(control => control.getClientRects().length).map(control => control.getBoundingClientRect()); return controls.some((a, i) => controls.slice(i + 1).some(b => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom) < 8)); });
      return { gap: firstText.top - heading.bottom, groups: groups.length, crowded, overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    expect(geometry.gap).toBeLessThanOrEqual(32 * scale); expect(geometry.groups).toBeGreaterThan(0); expect(geometry.crowded).toBe(false); expect(geometry.overflow).toBe(false);
    expect((await new AxeBuilder({ page }).include('#caseNoteModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`card-selection-${width}-${theme}-${scale}.png`) });
  }
  await page.setViewportSize({ width: 1366, height: 900 }); await page.evaluate(() => { window.applyThemePreference('light'); document.documentElement.style.fontSize = '100%'; });
  if (await saved.getByRole('button', { name: 'Add payment card', exact: true }).count()) await saved.getByRole('button', { name: 'Add payment card', exact: true }).click();
  else {
    await expect(saved).toContainText('Another application is saved for card setup.');
    await saved.getByRole('button', { name: 'Continue with this applicant', exact: true }).click(); await saved.getByRole('button', { name: 'Continue to card setup', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/attorney-v2\.html\?hiringReturn=current#\/payments\/setup$/);
  await expect(page.locator('[data-hiring-return]')).toContainText('Synthetic current engagement');
  const back = page.getByRole('link', { name: 'Return to this application', exact: true });
  await expect(back).toHaveAttribute('href', `/dashboard-attorney.html?caseId=${id}&applicantId=${paraId}&openApplicant=1&continueHire=1#cases:inquiries`);
  await back.click(); await page.waitForLoadState('domcontentloaded'); await expect(page.locator('[data-table-body="inquiries"]')).toHaveAttribute('aria-busy', 'false'); await expect(panel(page)).toHaveAttribute('data-state', 'ready'); expect(state.writes).toBe(0);
});
test('current response review cannot approve an older displayed response', async ({ page }) => {
  const { id, drawer } = await fixture(page, true); await drawer.locator('[data-preengagement-review-action="approve"]').click();
  const pre = modal(page).locator('[data-pre-engagement]'); await expect(pre).toHaveAttribute('data-state', 'ready');
  await pre.getByRole('button', { name: 'Approve pre-engagement response', exact: true }).click();
  await api(page.request, 'post', `/api/cases/${id}/pre-engagement/review`, { action: 'request_changes' });
  await api(para, 'post', `/api/cases/${id}/pre-engagement/respond`, { conflictsResponseType: 'disclosure', conflictsDisclosureText: 'Synthetic newly disclosed connection requiring fresh review.' });
  await pre.getByRole('button', { name: 'Confirm pre-engagement approval', exact: true }).click(); await expect(pre).toHaveAttribute('data-state', 'uncertain');
  await pre.getByRole('button', { name: 'Check saved requirements', exact: true }).click(); await expect(pre).toContainText('Synthetic newly disclosed connection');
  const owner = (await (await page.request.get('/api/auth/me')).json()).user;
  const response = await page.request.get(`/api/cases/${id}/pre-engagement/review/${paraId}?expectedOwnerId=${owner.id || owner._id}`); expect((await response.json()).request.status).toBe('submitted');
});
test('current hiring confirmation stays readable and reachable in the saved light and dark themes', async ({ page }, info) => {
  test.setTimeout(90000); await reviewed(page); await confirmation(page);
  for (const theme of ['light', 'dark']) for (const [width, text] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(({ theme, text }) => { window.applyThemePreference(theme); document.documentElement.style.fontSize = text; }, { theme, text });
    await page.waitForTimeout(350);
    const action = panel(page).getByRole('button', { name: 'Hire and charge $488.01', exact: true }); await action.scrollIntoViewIfNeeded(); await action.focus(); await expect(action).toBeFocused();
    const tabKey = info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
    await action.press(tabKey); await expect(panel(page).getByRole('button', { name: 'Return to hiring review', exact: true })).toBeFocused();
    await page.keyboard.press(tabKey); await expect(modal(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press(tabKey); await expect(action).toBeFocused();
    const bounds = await action.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect((await modal(page).getByRole('button', { name: 'Close', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('#caseNoteModal').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`hiring-${theme}-${width}-${text}.png`) });
  }
});


test('current optional requirements reveal only relevant fields and complete a real response review before hiring', async ({ page }, info) => {
  test.setTimeout(120000);
  const { id, state } = await reviewed(page);
  await panel(page).getByRole('button', { name: 'Review pre-engagement requirements', exact: true }).click();
  const pre = modal(page).locator('[data-pre-engagement]'); await expect(pre).toHaveAttribute('data-state', 'ready');
  await page.screenshot({ path: info.outputPath('requirements-empty.png') });
  await expect.soft(pre.getByLabel('Confidentiality agreement file', { exact: true })).toBeHidden();
  await expect.soft(pre.getByLabel('Parties and details for the conflicts check', { exact: true })).toBeHidden();
  await expect.soft(pre.getByRole('button', { name: 'Continue to hiring review', exact: true })).toBeVisible();
  async function inspectRequirements(stage, actionName) {
    for (const theme of ['light', 'dark']) for (const [width, text] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ theme, text }) => { window.applyThemePreference(theme); document.documentElement.style.fontSize = text; }, { theme, text });
      const action = pre.getByRole('button', { name: actionName, exact: true }); await action.scrollIntoViewIfNeeded(); await action.focus(); await expect(action).toBeFocused();
      const bounds = await action.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      expect((await modal(page).getByRole('button', { name: 'Close', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await pre.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('#caseNoteModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`requirements-${stage}-${theme}-${width}-${text}.png`) });
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => { window.applyThemePreference('light'); document.documentElement.style.fontSize = '100%'; });
  }
  await inspectRequirements('empty', 'Continue to hiring review');
  await pre.getByLabel('Require conflicts check', { exact: true }).check();
  await pre.getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Synthetic client and opposing party.');
  await pre.getByRole('button', { name: 'Review requirements before sending', exact: true }).click();
  await expect(pre.getByLabel('Parties and details for the conflicts check', { exact: true })).toBeHidden();
  await expect(pre.getByRole('button', { name: 'Refresh saved requirements', exact: true })).toBeHidden();
  await inspectRequirements('confirmation', 'Send requirements');
  const tabKey = info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
  await pre.getByRole('button', { name: 'Send requirements', exact: true }).focus();
  await page.keyboard.press(tabKey); await expect(pre.getByRole('button', { name: 'Return to review', exact: true })).toBeFocused();
  await page.keyboard.press(tabKey); await expect(modal(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press(tabKey); await expect(pre.getByRole('button', { name: 'Send requirements', exact: true })).toBeFocused();
  await pre.getByRole('button', { name: 'Send requirements', exact: true }).click();
  await expect(pre).toContainText('Pre-engagement requirements sent.');
  await expect(pre.getByLabel('Parties and details for the conflicts check', { exact: true })).toBeHidden();
  await pre.locator('[data-preengagement-editor] > summary').click();
  await expect(pre.getByLabel('Parties and details for the conflicts check', { exact: true })).toHaveValue('Synthetic client and opposing party.');
  await pre.getByRole('button', { name: 'Review requirements before sending', exact: true }).click();
  await pre.getByRole('button', { name: 'Return to review', exact: true }).click();
  await expect(pre.getByRole('button', { name: 'Refresh saved requirements', exact: true })).toBeFocused();
  await pre.locator('[data-preengagement-editor] > summary').click();
  await page.screenshot({ path: info.outputPath('requirements-saved.png') });
  await api(para, 'post', `/api/cases/${id}/pre-engagement/respond`, { conflictsResponseType: 'disclosure', conflictsDisclosureText: 'Synthetic unrelated former engagement.' });
  await pre.getByRole('button', { name: 'Refresh saved requirements', exact: true }).click();
  await pre.getByRole('button', { name: 'Ask for response changes', exact: true }).click(); await pre.getByRole('button', { name: 'Request response changes', exact: true }).click();
  await expect(pre).toContainText('Response changes requested');
  await api(para, 'post', `/api/cases/${id}/pre-engagement/respond`, { conflictsResponseType: 'disclosure', conflictsDisclosureText: 'Synthetic engagement ended two years ago.' });
  await pre.getByRole('button', { name: 'Refresh saved requirements', exact: true }).click();
  await pre.getByRole('button', { name: 'Approve pre-engagement response', exact: true }).click(); await pre.getByRole('button', { name: 'Confirm pre-engagement approval', exact: true }).click();
  await expect(pre).toContainText('Pre-engagement response approved. Hiring and funding have not been performed.');
  await pre.getByRole('button', { name: 'Continue to hiring review', exact: true }).click(); await expect(panel(page)).toHaveAttribute('data-state', 'ready'); expect(state.writes).toBe(0);
  await expect(page.locator('[data-application-parent-status]')).toBeHidden();
});
