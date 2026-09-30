const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const id = n => n.toString(16).padStart(24, '0'), OWNER = id(9001), PARALEGAL = id(9002), MATTER = id(1);
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function setup(page, { replacement = false, unavailable = false, cardRequired = false } = {}) {
  const user = { id: OWNER, _id: OWNER, role: 'attorney', status: 'approved', emailVerified: true, firstName: 'Dana', lastName: 'Ellis', email: 'synthetic@example.test', preferences: { theme: 'light', fontSize: 'md' }, onboarding: { attorneyTourCompleted: true } };
  const profile = { id: PARALEGAL, _id: PARALEGAL, role: 'paralegal', status: 'approved', firstName: 'Priya', lastName: 'Ng', bio: 'Synthetic estate paralegal.', availability: 'available', practiceAreas: ['Contract Law'] };
  const matter = { _id: MATTER, title: 'Selected estate Matter', totalAmount: 60000, lockedTotalAmount: 60000, feeAttorneyPct: 10, status: replacement ? 'paused' : 'open', remainingAmount: replacement ? 12000 : 60000, ...(replacement ? { pausedReason: 'paralegal_withdrew', payoutFinalizedAt: '2026-09-01T12:00:00.000Z' } : {}) };
  const card = { id: 'pm_synthetic', type: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
  const review = { ownerId: OWNER, caseId: MATTER, applicantId: PARALEGAL, caseTitle: matter.title, name: 'Priya Ng', revision: 'a'.repeat(64), reason: 'ready', canHire: true, canResume: false, relisted: replacement, fundingVerified: replacement, assigned: false, budgetCents: 60000, feeCents: replacement ? 0 : 6000, chargeCents: replacement ? 0 : 66000, remainingCents: replacement ? 12000 : null, currency: 'usd', card: replacement ? null : card };
  const requirements = { ownerId: OWNER, caseId: MATTER, applicantId: PARALEGAL, caseTitle: matter.title, name: 'Priya Ng', revision: 'c'.repeat(64), reason: 'ready', canRequest: true, canReview: false, canApprove: false, selectedRequest: false, request: null };
  if (cardRequired) Object.assign(review, { reason: 'card_required', canHire: false, card: null });
  const state = { user, writes: [], errors: [], review, requirements, onHire: null, onRequirements: null, onApproval: null, pendingHire: { ownerId: OWNER, revision: 'd'.repeat(64), pending: null }, onSelection: null };
  await page.addInitScript(user => { localStorage.setItem('lpc_user', JSON.stringify(user)); window.EventSource = class extends EventTarget { close() {} }; }, user);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') state.writes.push({ path, body: String(request.headers()['content-type'] || '').includes('application/json') ? request.postDataJSON() : request.postData() });
    if (path === '/api/auth/me') return reply(route, { user: state.user });
    if (path === '/api/users/me') return reply(route, state.user);
    if (path === `/api/paralegals/${PARALEGAL}` || path === `/api/public/paralegals/${PARALEGAL}`) return reply(route, profile);
    if (path === '/api/csrf') return reply(route, { csrfToken: 'synthetic-csrf' });
    if (path === '/api/account/preferences') return reply(route, user.preferences);
    if (path === '/api/users/me/pending-hire') return request.method() === 'GET' ? reply(route, state.pendingHire) : state.onSelection ? state.onSelection(route) : reply(route, {}, 503);
    if (path.includes('unread-count')) return reply(route, { count: 0 });
    if (path === '/api/notifications/page') return reply(route, { items: [], hasMore: false, nextCursor: null });
    if (path === `/api/cases/${MATTER}`) return reply(route, url.searchParams.get('expectedOwnerId') && url.searchParams.get('expectedOwnerId') !== OWNER ? { error: 'Account changed' } : matter, url.searchParams.get('expectedOwnerId') && url.searchParams.get('expectedOwnerId') !== OWNER ? 403 : 200);
    if (path === '/api/payments/payment-method/default') return reply(route, unavailable ? { error: 'Synthetic payment read unavailable' } : { hasDefault: true, paymentMethod: card }, unavailable ? 503 : 200);
    if (path === `/api/cases/${MATTER}/hiring-review/${PARALEGAL}`) return reply(route, unavailable ? { error: 'Synthetic hiring read unavailable' } : review, unavailable ? 503 : 200);
    if (path === `/api/cases/${MATTER}/hire/${PARALEGAL}`) return state.onHire ? state.onHire(route) : reply(route, {});
    if (path === `/api/cases/${MATTER}/pre-engagement/review/${PARALEGAL}`) return reply(route, state.requirements);
    if (path === `/api/cases/${MATTER}/pre-engagement/${PARALEGAL}/request`) return state.onRequirements ? state.onRequirements(route) : reply(route, {}, 503);
    if (path === `/api/cases/${MATTER}/pre-engagement/review`) return state.onApproval ? state.onApproval(route) : reply(route, {}, 503);
    return reply(route, { items: [], threads: [], events: [] });
  });
  const returnTo = `dashboard-attorney.html?caseId=${MATTER}&applicantId=${PARALEGAL}&openApplicant=1#cases:inquiries`;
  await page.goto(`/profile-paralegal.html?paralegalId=${PARALEGAL}&returnTo=${encodeURIComponent(returnTo)}`);
  const trigger = page.getByRole('button', { name: /Hire for Selected estate Matter|Review hire/, exact: true });
  await expect(trigger).toBeEnabled();
  return { state, trigger, dialog: page.getByRole('dialog') };
}
async function reviewConfirmation(view) {
  await view.trigger.click(); await expect(view.dialog).toBeVisible();
  const next = view.dialog.getByRole('button', { name: /Next: Fund and Hire|Review hiring confirmation/, exact: true });
  await expect(next).toBeEnabled(); await next.click();
}

test('profile hiring uses the recorded Matter fee instead of a hardcoded default', async ({ page }, info) => {
  const view = await setup(page); await reviewConfirmation(view);
  await page.screenshot({ path: info.outputPath('recorded-fee.png'), animations: 'disabled' });
  await expect(view.dialog).toContainText('$660.00'); await expect(view.dialog).not.toContainText('$732.00'); expect(view.state.writes).toEqual([]);
});
test('profile replacement hiring shows the remaining funding and no new card charge', async ({ page }, info) => {
  const view = await setup(page, { replacement: true }); await reviewConfirmation(view);
  await page.screenshot({ path: info.outputPath('replacement-funding.png'), animations: 'disabled' });
  await expect(view.dialog).toContainText('$120.00'); await expect(view.dialog).toContainText('No new card charge'); expect(view.state.writes).toEqual([]);
});
test('profile hiring cannot claim funding from an empty acknowledgement', async ({ page }, info) => {
  const view = await setup(page); await reviewConfirmation(view);
  await view.dialog.getByRole('button', { name: /Confirm Hire|Hire and charge \$660.00/, exact: true }).click();
  await expect.poll(() => view.state.writes.length).toBe(1);
  await page.screenshot({ path: info.outputPath('unconfirmed-hire.png'), animations: 'disabled' });
  await expect(view.dialog).toContainText('The hiring result could not be confirmed.'); expect(view.state.errors).toEqual([]);
});
test('profile hiring distinguishes unavailable reads from a missing payment card', async ({ page }) => {
  const view = await setup(page, { unavailable: true }); await view.trigger.click();
  await expect(page.getByText('Hiring details are unavailable. Refresh the review to try again.', { exact: true })).toBeVisible();
  await expect(page.getByText('Add a payment method to hire before hiring.', { exact: true })).toHaveCount(0); expect(view.state.writes).toEqual([]);
});


async function requirements(view) {
  await view.dialog.getByRole('button', { name: 'Review pre-engagement requirements', exact: true }).click();
  await expect(view.dialog.locator('[data-pre-engagement]')).toHaveAttribute('data-state', 'ready');
}
const assign = state => Object.assign(state.review, { revision: 'b'.repeat(64), reason: 'assigned', canHire: false, assigned: true, fundingVerified: true });
const confirmation = state => ({ hiringConfirmation: { caseId: MATTER, applicantId: PARALEGAL, reviewedRevision: 'a'.repeat(64), mode: 'hire_and_fund', chargeCents: 66000, budgetCents: 60000, remainingCents: null } });

async function cardSelection(page) {
  const view = await setup(page, { cardRequired: true });
  await page.route('**/attorney-v2.html?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Synthetic card setup</title><body><main><h1>Card setup destination</h1></main></body></html>' }));
  const save = () => { view.state.pendingHire = { ownerId: OWNER, revision: 'e'.repeat(64), pending: { state: 'available', caseId: MATTER, paralegalId: PARALEGAL, caseTitle: 'Selected estate Matter', paralegalName: 'Priya Ng' } }; return { saved: true, ownerId: OWNER, cleared: false, caseId: MATTER, paralegalId: PARALEGAL }; };
  await view.trigger.click(); const selected = view.dialog.locator('[data-hiring-return]'); await expect(selected).toHaveAttribute('data-state', 'ready');
  return { ...view, selected, save };
}
test('profile card setup opens in one action only after the exact applicant is saved and verified', async ({ page }) => {
  const view = await cardSelection(page); view.state.onSelection = route => reply(route, view.save());
  await expect(view.selected).not.toContainText('No application return'); await expect(view.selected.getByRole('button')).toHaveCount(1);
  await view.selected.getByRole('button', { name: 'Add payment card', exact: true }).click();
  await expect(page).toHaveURL(/\/attorney-v2\.html\?hiringReturn=current#\/payments\/setup$/);
  expect(view.state.writes).toEqual([{ path: '/api/users/me/pending-hire', body: { caseId: MATTER, paralegalId: PARALEGAL, reviewedRevision: 'd'.repeat(64), expectedOwnerId: OWNER } }]);
  expect(view.state.errors).toEqual([]);
});
test('profile card setup recovers a lost selection acknowledgement without saving twice', async ({ page }) => {
  const view = await cardSelection(page); view.state.onSelection = route => { view.save(); return reply(route, {}); };
  await view.selected.getByRole('button', { name: 'Add payment card', exact: true }).click(); await expect(view.selected).toHaveAttribute('data-state', 'uncertain');
  await expect(page).toHaveURL(/profile-paralegal/); await expect(view.selected.getByRole('link', { name: 'Add payment card', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape'); await view.trigger.click(); await expect(view.selected).toHaveAttribute('data-state', 'ready');
  await view.selected.getByRole('link', { name: 'Add payment card', exact: true }).click(); await expect(page).toHaveURL(/#\/payments\/setup$/);
  expect(view.state.writes).toHaveLength(1); expect(view.state.errors).toEqual([]);
});
test('profile card setup refuses a changed saved selection even after a matching save acknowledgement', async ({ page }) => {
  const view = await cardSelection(page); view.state.onSelection = route => { const receipt = view.save(); view.state.pendingHire.pending.caseId = id(2); return reply(route, receipt); };
  await view.selected.getByRole('button', { name: 'Add payment card', exact: true }).click(); await expect(view.selected).toHaveAttribute('data-state', 'uncertain');
  await expect(view.selected).toContainText('The saved details changed'); await expect(page).toHaveURL(/profile-paralegal/);
  await view.selected.getByRole('button', { name: 'Check saved selection', exact: true }).click(); await expect(view.selected).toHaveAttribute('data-state', 'ready');
  await expect(view.selected).toContainText('Another application is saved'); expect(view.state.writes).toHaveLength(1); expect(view.state.errors).toEqual([]);
});
test('profile card setup confirms replacing another applicant and allows cancellation without a write', async ({ page }) => {
  const view = await cardSelection(page); view.save(); view.state.pendingHire.pending.caseId = id(2);
  await page.keyboard.press('Escape'); await view.trigger.click(); await expect(view.selected).toContainText('Another application is saved');
  await view.selected.getByRole('button', { name: 'Continue with this applicant', exact: true }).click(); await view.selected.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(view.state.writes).toEqual([]); await expect(view.selected.getByRole('button', { name: 'Continue with this applicant', exact: true })).toBeFocused();
  await view.selected.getByRole('button', { name: 'Continue with this applicant', exact: true }).click(); view.state.onSelection = route => reply(route, view.save());
  await view.selected.getByRole('button', { name: 'Continue to card setup', exact: true }).click(); await expect(page).toHaveURL(/#\/payments\/setup$/); expect(view.state.writes).toHaveLength(1); expect(view.state.errors).toEqual([]);
});
test('profile card setup keeps a pending selection in place and rejects an account change before navigation', async ({ page }) => {
  const view = await cardSelection(page); let finish; const held = new Promise(resolve => { finish = resolve; });
  view.state.onSelection = async route => { await held; view.state.user = { ...view.state.user, id: id(9999), _id: id(9999) }; return reply(route, view.save()); };
  await view.selected.getByRole('button', { name: 'Add payment card', exact: true }).click(); await expect(view.selected).toHaveAttribute('data-state', 'saving');
  await expect(view.dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(view.dialog).toBeVisible();
  finish(); await expect(view.dialog).toBeHidden(); await expect(page).toHaveURL(/profile-paralegal/); expect(view.state.writes).toHaveLength(1);
});

test('profile hiring preserves an uncertain result across closing and checks the actual assignment before another charge', async ({ page }) => {
  const view = await setup(page); view.state.onHire = route => { assign(view.state); return reply(route, {}); };
  await reviewConfirmation(view); await view.dialog.getByRole('button', { name: 'Hire and charge $660.00', exact: true }).click();
  await expect(view.dialog.locator('[data-hiring]')).toHaveAttribute('data-state', 'uncertain');
  await page.keyboard.press('Escape'); await expect(view.trigger).toBeFocused(); await view.trigger.click();
  await expect(view.dialog.locator('[data-hiring]')).toHaveAttribute('data-state', 'uncertain');
  await view.dialog.getByRole('button', { name: 'Check saved hiring details', exact: true }).click();
  await expect(view.dialog.getByRole('link', { name: 'Open this Matter', exact: true })).toHaveAttribute('href', `/case-detail.html?caseId=${MATTER}`);
  await expect(view.dialog.getByRole('button', { name: /Hire and charge/ })).toHaveCount(0); expect(view.state.writes).toHaveLength(1); expect(view.state.errors).toEqual([]);
});
test('profile hiring keeps a pending charge open and confirms the exact receipt once', async ({ page }) => {
  const view = await setup(page); let release;
  view.state.onHire = async route => { expect(route.request().postDataJSON()).toEqual({ reviewedRevision: 'a'.repeat(64), expectedOwnerId: OWNER }); await new Promise(resolve => { release = resolve; }); assign(view.state); return reply(route, confirmation(view.state)); };
  await reviewConfirmation(view); await view.dialog.getByRole('button', { name: 'Hire and charge $660.00', exact: true }).click(); await expect.poll(() => !!release).toBe(true);
  await expect(view.dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(view.dialog).toBeVisible(); expect(view.state.writes).toHaveLength(1);
  release(); await expect(view.dialog).toContainText('funding is verified'); await expect(view.dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await view.dialog.getByRole('button', { name: 'Close', exact: true }).click(); await expect(view.trigger).toBeFocused(); expect(view.state.writes).toHaveLength(1); expect(view.state.errors).toEqual([]);
});
test('profile hiring refuses a replacement account before sending the reviewed charge', async ({ page }) => {
  const view = await setup(page); await reviewConfirmation(view); view.state.user = { ...view.state.user, id: id(9999), _id: id(9999) };
  await view.dialog.getByRole('button', { name: 'Hire and charge $660.00', exact: true }).click(); await expect(view.dialog).toHaveCount(0);
  expect(view.state.writes).toEqual([]); expect(view.state.errors).toEqual([]);
});
test('profile requirements preserve the selected document and unsent details through close and page restoration', async ({ page }) => {
  const view = await setup(page); await view.trigger.click(); await requirements(view);
  await view.dialog.getByLabel('Require confidentiality agreement', { exact: true }).check();
  await view.dialog.getByLabel('Confidentiality agreement file', { exact: true }).setInputFiles({ name: 'synthetic-agreement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 synthetic agreement') });
  await view.dialog.getByLabel('Require conflicts check', { exact: true }).check();
  await view.dialog.getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Synthetic estate parties and prior representatives.');
  await page.keyboard.press('Escape'); await view.trigger.click(); await requirements(view);
  expect(await view.dialog.getByLabel('Confidentiality agreement file', { exact: true }).evaluate(input => [...input.files].map(file => file.name))).toEqual(['synthetic-agreement.pdf']);
  await expect(view.dialog).not.toContainText('Selected in this tab:'); await expect(view.dialog.getByLabel('Parties and details for the conflicts check', { exact: true })).toHaveValue('Synthetic estate parties and prior representatives.');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await expect(view.dialog).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await view.trigger.click(); await requirements(view);
  expect(await view.dialog.getByLabel('Confidentiality agreement file', { exact: true }).evaluate(input => [...input.files].map(file => file.name))).toEqual(['synthetic-agreement.pdf']);
  await view.dialog.getByRole('button', { name: 'Discard unsent requirements', exact: true }).click();
  await expect(view.dialog.getByLabel('Require conflicts check', { exact: true })).not.toBeChecked(); expect(view.state.writes).toEqual([]); expect(view.state.errors).toEqual([]);
});
test('profile pre-engagement records requirements and approval before returning to a fresh hiring review', async ({ page }) => {
  const view = await setup(page);
  view.state.onRequirements = route => {
    const body = route.request().postData(); expect(body).toContain(OWNER); expect(body).toContain('c'.repeat(64)); expect(body).toContain('Synthetic estate parties.');
    Object.assign(view.state.requirements, { revision: 'd'.repeat(64), selectedRequest: true, request: { status: 'requested', revision: 1, applicantId: PARALEGAL, confidentialityRequired: false, conflictsRequired: true, acknowledged: false, acknowledgedAt: null, conflictsResponse: null, disclosure: '', conflictsDetails: 'Synthetic estate parties.', requestedAt: '2026-09-14T12:00:00.000Z', submittedAt: null, reviewedAt: null, documents: [] } });
    return reply(route, { success: true, preEngagement: { status: 'requested', revision: 1, requestedParalegalId: PARALEGAL } });
  };
  view.state.onApproval = route => {
    expect(route.request().postDataJSON()).toEqual({ reviewedRevision: 'e'.repeat(64), action: 'approve', applicantId: PARALEGAL, expectedOwnerId: OWNER });
    Object.assign(view.state.requirements, { revision: 'f'.repeat(64), canReview: false, canApprove: false }); Object.assign(view.state.requirements.request, { status: 'approved', revision: 2, reviewedAt: '2026-09-14T14:00:00.000Z' });
    return reply(route, { success: true, preEngagement: { status: 'approved', revision: 2, requestedParalegalId: PARALEGAL } });
  };
  await view.trigger.click(); await requirements(view); await view.dialog.getByLabel('Require conflicts check', { exact: true }).check(); await view.dialog.getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Synthetic estate parties.');
  await view.dialog.getByRole('button', { name: 'Review requirements before sending', exact: true }).click(); await view.dialog.getByRole('button', { name: 'Send requirements', exact: true }).click();
  await expect(view.dialog.locator('[role="status"]')).toHaveText('Pre-engagement requirements sent.');
  Object.assign(view.state.requirements, { revision: 'e'.repeat(64), canRequest: false, canReview: true, canApprove: true }); Object.assign(view.state.requirements.request, { status: 'submitted', submittedAt: '2026-09-14T13:00:00.000Z', conflictsResponse: 'none_known' });
  await view.dialog.getByRole('button', { name: 'Refresh saved requirements', exact: true }).click(); await view.dialog.getByRole('button', { name: 'Approve pre-engagement response', exact: true }).click(); await view.dialog.getByRole('button', { name: 'Confirm pre-engagement approval', exact: true }).click();
  await expect(view.dialog.locator('[role="status"]')).toContainText('Pre-engagement response approved.'); await view.dialog.getByRole('button', { name: 'Continue to hiring review', exact: true }).click();
  await expect(view.dialog.locator('[data-hiring]')).toHaveAttribute('data-state', 'ready'); await expect(view.dialog).toContainText('$660.00'); expect(view.state.writes).toHaveLength(2); expect(view.state.errors).toEqual([]);
});
test('profile engagement stays readable and operable across themes, narrow screens and enlarged text', async ({ page }, info) => {
  const view = await setup(page);
  for (const [width, theme, scale] of [[1440, 'light', 1], [390, 'light', 1], [390, 'dark', 1], [320, 'dark', 2]]) {
    await page.setViewportSize({ width, height: 960 }); await page.evaluate(({ theme, scale }) => { document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.body.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = `${16 * scale}px`; }, { theme, scale });
    await view.trigger.click(); await expect(view.dialog.locator('[data-hiring]')).toHaveAttribute('data-state', 'ready');
    for (const phase of ['review', 'confirmation', 'requirements']) {
      if (phase === 'confirmation') await view.dialog.getByRole('button', { name: 'Review hiring confirmation', exact: true }).click();
      if (phase === 'requirements') { await view.dialog.getByRole('button', { name: 'Return to hiring review', exact: true }).click(); await requirements(view); await view.dialog.getByLabel('Require conflicts check', { exact: true }).check(); await view.dialog.getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Synthetic estate parties and prior counsel.'); }
      await page.evaluate(() => document.fonts.ready);
      const scan = await new AxeBuilder({ page }).include('.lpc-engagement-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(scan.violations).toEqual([]);
      expect(await view.dialog.evaluate(node => document.documentElement.scrollWidth > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1 || node.querySelector('.lpc-engagement-content').scrollWidth > node.querySelector('.lpc-engagement-content').clientWidth + 1)).toBe(false);
      for (const control of await view.dialog.locator('button:visible,input:not([type="checkbox"]):visible,textarea:visible').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await view.dialog.locator('h2').evaluate(node => getComputedStyle(node).fontFamily)).toContain('Sarabun');
      await page.screenshot({ path: info.outputPath(`profile-engagement-${width}-${theme}-${scale}-${phase}.png`), animations: 'disabled' });
    }
    await view.dialog.getByRole('button', { name: 'Discard unsent requirements', exact: true }).click(); await page.keyboard.press('Escape'); await expect(view.trigger).toBeFocused();
  }
  expect(view.state.errors).toEqual([]);
});
