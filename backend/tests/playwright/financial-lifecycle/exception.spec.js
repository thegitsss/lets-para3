const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
const inspectPayoutLayout = require('./payout-layout');
const inspectFinancialLayout = require('./financial-layout');
const inspectBrowserDiagnostics = require('./browser-diagnostics');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.beforeEach(async () => server.reset());
test.afterEach(() => {
  expect(server.evidence().assets.filter(asset => asset.status >= 400)).toEqual([]);
  expect(server.evidence().requests.filter(row => row.path === '/api/notifications/workspace-presence' && row.status >= 400)).toEqual([]);
});
test.afterAll(async () => server?.close());

async function api(context, method, path, data) {
  const csrf = await (await context.request.get(`${server.origin}/api/csrf`)).json();
  const response = await context.request[method](`${server.origin}${path}`, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.headers()['x-lpc-test-server']).toBe('financial-lifecycle-browser');
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function roles(browser, { replacement = false, preferences = {}, publicProfile = false } = {}) {
  const pages = {}, actors = {}, errors = [], browserEvents = [], requestIds = new WeakMap();
  let requestSequence = 0;
  for (const role of ['attorney', 'paralegal', 'admin', ...(replacement ? ['replacement'] : [])]) {
    actors[role] = await server.createUser(role === 'replacement' ? 'paralegal' : role, preferences, publicProfile);
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
    await context.addCookies([actors[role].cookie]);
    // Observe document departure and exceptions without changing requests or
    // suppressing native page errors. Unknown observations still fail below.
    await context.addInitScript(() => {
      const documentId = crypto.randomUUID();
      const report = (type, detail = {}) => console.debug('LPC_LIFECYCLE_DIAGNOSTIC ' + JSON.stringify({ documentId, type, page: location.href, at: Date.now(), visibility: document.visibilityState, ...detail }));
      for (const type of ['beforeunload', 'pagehide', 'pageshow']) addEventListener(type, event => report(type, { persisted: event.persisted }));
      addEventListener('resize', () => report('resize', { width: innerWidth, height: innerHeight }));
      addEventListener('error', event => report('windowerror', { message: event.message, filename: event.filename, stack: event.error?.stack }));
      addEventListener('unhandledrejection', event => report('unhandledrejection', { message: String(event.reason), stack: event.reason?.stack }));
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    pages[role] = await context.newPage();
    pages[role].on('pageerror', error => errors.push({ role, name: error.name, message: error.message, stack: error.stack, page: pages[role].url(), at: Date.now() }));
    pages[role].on('console', message => {
      const prefix = 'LPC_LIFECYCLE_DIAGNOSTIC ';
      if (message.text().startsWith(prefix)) browserEvents.push({ role, ...JSON.parse(message.text().slice(prefix.length)) });
    });
    pages[role].on('framenavigated', frame => { if (frame === pages[role].mainFrame()) browserEvents.push({ role, type: 'navigation', page: frame.url(), at: Date.now() }); });
    for (const type of ['request', 'requestfinished', 'requestfailed']) pages[role].on(type, request => {
      if (!request.url().startsWith(server.origin + '/api/')) return;
      if (!requestIds.has(request)) requestIds.set(request, ++requestSequence);
      browserEvents.push({ role, type, id: requestIds.get(request), method: request.method(), path: new URL(request.url()).pathname, at: Date.now(), ...(type === 'requestfailed' ? { error: request.failure()?.errorText } : {}) });
    });
    pages[role].on('response', response => {
      const request = response.request();
      if (requestIds.has(request)) browserEvents.push({ role, type: 'response', id: requestIds.get(request), status: response.status(), at: Date.now() });
    });
  }
  return { pages, actors, errors, browserEvents };
}
function browserDiagnostics(errors, events, info, actors) {
  return inspectBrowserDiagnostics({ engine: info.project.name, origin: server.origin, attorneyOwnerId: actors?.attorney?.id, paralegalOwnerId: actors?.paralegal?.id, errors, events });
}
function expectCleanBrowser(errors, events, info, actors) {
  const diagnostics = browserDiagnostics(errors, events, info, actors);
  expect(diagnostics.documentFailures).toEqual([]);
  expect(diagnostics.unexplainedPageErrors).toEqual([]);
}
async function fund(pages, actors, title) {
  const attorney = pages.attorney.context(), para = pages.paralegal.context();
  const published = await api(attorney, 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence for review.', tasks: [{ title: 'Prepare filing package' }, { title: 'Review supporting evidence' }] });
  const caseId = String(published.case?._id || published.case?.id || published._id || published.id);
  const jobId = String(published.jobId);
  expect(jobId).toMatch(/^[a-f0-9]{24}$/);
  await api(para, 'post', `/api/jobs/${jobId}/apply`, { coverLetter: 'I can prepare the requested filing package and supporting evidence.' });
  await api(attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
  const review = await api(attorney, 'get', `/api/cases/${caseId}/hiring-review/${actors.paralegal.id}?expectedOwnerId=${actors.attorney.id}`);
  await api(attorney, 'post', `/api/cases/${caseId}/hire/${actors.paralegal.id}`, { expectedOwnerId: actors.attorney.id, reviewedRevision: review.revision });
  console.log(`Lifecycle checkpoint: funded ${title}`);
  return caseId;
}
async function recordEnd(pages, errors, info, caseId, browserEvents, actors) {
  const saved = caseId ? await server.inspect(caseId) : null;
  await fs.writeFile(info.outputPath('request-evidence.json'), JSON.stringify({ requests: server.evidence().requests, assets: server.evidence().assets, requestProgress: server.evidence().requestProgress, browserEvents, errors, browserDiagnostics: browserDiagnostics(errors, browserEvents, info, actors), ...(saved ? { saved: { status: saved.case.status, payoutCount: saved.payouts.length, operations: saved.operations.map(row => ({ kind: row.kind, status: row.status, amount: row.amount })) }, providerMethods: server.provider.calls.map(row => row.method) } : {}) }, null, 2));
  for (const [role, page] of Object.entries(pages)) { await page.screenshot({ path: info.outputPath(`${role}-last.png`) }).catch(() => {}); await page.context().close(); }
}

async function inspectResolutionNotices(pages, actors, info, caseId, mailBefore) {
  const notices = (await server.reviewNotices(caseId)).filter(row => row.kind === 'resolved');
  expect(notices).toHaveLength(2); expect(notices.map(row => String(row.userId)).sort()).toEqual([actors.attorney.id, actors.paralegal.id].sort());
  expect(notices.every(row => row.status === 'pending' && row.attempts === 0 && row.operationId && row.resolvedAt)).toBe(true);
  expect(server.evidence().external.mail.length).toBe(mailBefore);
  const actions = {};
  for (const role of ['attorney', 'paralegal']) {
    const page = pages[role], items = await api(page.context(), 'get', '/api/notifications/');
    const notice = items.find(row => row.type === 'dispute_resolved' && row.context.caseId === caseId);
    expect(notice?.action.href).toBe(role === 'attorney' ? `/case-detail.html?caseId=${caseId}&tab=financials` : `/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
    actions[role] = notice.action;
    // Email and older links retain the current entry point. The V2 notification
    // center adapts that same protected destination inside its active shell.
    await page.goto(server.origin + notice.action.href);
    if (role === 'attorney') await expect(page.locator('[data-matter-payments]')).toBeVisible();
    else await expect(page.locator(`.file-card[data-case-id="${caseId}"]`)).toBeVisible();
    await page.goto(`${server.origin}/${role === 'attorney' ? 'attorney' : 'paralegal'}-v2.html#/home`);
    await page.getByRole('button', { name: /^View notifications/ }).click();
    await page.locator(`[data-notification-focus="open:${notice.id || notice._id}"]`).click();
    if (role === 'attorney') {
      await expect(page.locator('[data-workspace-disputes]')).toContainText('Recorded administrator decision');
      await expect(page.locator('[data-workspace-disputes]')).not.toContainText('Administrator review open');
    } else {
      await expect(page.locator(`[data-work-history-id="${caseId}"]`)).toBeVisible();
      await expect(page.locator(`[data-work-history-id="${caseId}"]`)).not.toContainText('Request LPC review');
      await expect(page.locator(`[data-work-history-id="${caseId}"] [data-review-status]`)).toHaveCount(0);
    }
  }
  const adminItems = await api(pages.admin.context(), 'get', '/api/notifications/');
  expect(adminItems.filter(row => row.type === 'dispute_resolved')).toEqual([]);
  await fs.writeFile(info.outputPath('resolution-notice-evidence.json'), JSON.stringify({ notices, actions, immediateEmailCount: server.evidence().external.mail.length - mailBefore }, null, 2));
}

test('actual participant dispute and administrator refund update all role browsers', async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser);
  let caseId;
  try {
    caseId = await fund(pages, actors, 'River Street refund');
    const { attorney, paralegal, admin } = pages;
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const dispute = attorney.locator('[data-workspace-disputes]');
    await dispute.getByText('Report a disagreement', { exact: true }).click();
    await dispute.getByLabel('Dispute details', { exact: true }).fill('The requested scope needs administrator review before any further payment.');
    await dispute.getByRole('button', { name: 'Review dispute request', exact: true }).click();
    await dispute.getByRole('button', { name: 'Open dispute review', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('disputed');
    const notices = await server.reviewNotices(caseId);
    expect(notices).toHaveLength(3); expect(notices.every(row => row.status === 'pending' && row.attempts === 0)).toBe(true);
    expect(notices.map(row => String(row.userId)).sort()).toEqual(Object.values(actors).map(actor => actor.id).sort());
    expect(server.evidence().external.mail.filter(row => /^Review opened:/.test(row[1]))).toEqual([]);
    const reviewActions = {};
    for (const [role, page] of Object.entries(pages)) {
      const items = await api(page.context(), 'get', '/api/notifications/');
      const item = items.find(row => row.type === 'dispute_opened');
      expect(item?.action.href).toBe(role === 'admin' ? `/admin-dashboard.html?review=${notices[0].disputeId}&reviewMatter=${caseId}#finance` : `/case-detail.html?caseId=${caseId}&tab=financials`);
      reviewActions[role] = item.action;
    }
    await fs.writeFile(info.outputPath('review-notice-evidence.json'), JSON.stringify({ notices, actions: reviewActions }, null, 2));
    await paralegal.goto(server.origin + reviewActions.paralegal.href);
    await expect(paralegal.locator('[data-matter-payments]')).toHaveAttribute('data-state', 'needs_review');
    await expect(paralegal.locator('[data-matter-payments]')).toContainText('Payment under LPC review');
    await expect(paralegal.locator('[data-matter-payments] .matter-payment-amounts')).toHaveCount(0);
    console.log('Lifecycle checkpoint: participant dispute opened');
    await expect(attorney.locator('.av2-financial-status-row')).toContainText('Under review');
    await expect(attorney.locator('[data-workspace-funding]')).not.toContainText('before funding');
    await expect(attorney.locator('[data-workspace-completion]')).toContainText('A work-quality review is open');
    await inspectFinancialLayout(attorney, info, 'disputed');
    await admin.goto(`${server.origin}/admin-dashboard.html?review=${notices[0].disputeId}&reviewMatter=${caseId}#finance`);
    const row = admin.locator('#disputesBody tr').filter({ hasText: 'River Street refund' });
    await expect(row.getByRole('button', { name: 'Review dispute', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(admin.locator('.admin-dispute-detail:not([hidden])')).toContainText('The requested scope needs administrator review');
    await admin.locator('.admin-dispute-detail:not([hidden]) [data-dispute-action="refund"]').click();
    const confirmation = admin.getByRole('dialog', { name: 'Confirm financial settlement' });
    await expect(confirmation).toContainText('$488.00');
    const mailBeforeResolution = server.evidence().external.mail.length;
    await confirmation.getByRole('button', { name: 'Issue refund', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('closed');
    console.log('Lifecycle checkpoint: administrator refund recorded');
    await expect(attorney.locator('[data-matter-receipt]').getByText(/^Refund processed ·/)).toBeVisible();
    await expect(attorney.locator('[data-workspace-completion]')).toContainText('No completion payout is recorded.');
    await expect(attorney.locator('[data-workspace-completion] .av2-completion-amounts')).toHaveCount(0);
    await expect(attorney.locator('[data-workspace-completion]')).not.toContainText('Completion details changed');
    await expect(dispute.getByText('Resolved', { exact: true })).toHaveCount(1);
    await expect(dispute).toContainText('Recorded administrator decision');
    await expect(dispute).not.toContainText('Administrator review open');
    await inspectFinancialLayout(attorney, info, 'refunded');
    await inspectResolutionNotices(pages, actors, info, caseId, mailBeforeResolution);
    await attorney.goto(`${server.origin}/attorney-v2.html#/payments`);
    const history = attorney.locator('[data-financial-history]');
    await expect(history).toHaveAttribute('data-state', 'ready');
    await expect(history.locator('[data-financial-record]').filter({ hasText: 'Refund · Recorded' })).toContainText('$488.00');
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/home?view=history`);
    await expect(paralegal.locator('[data-payout-totals]')).toHaveAttribute('data-state', 'ready');
    await expect(paralegal.locator('[data-payout-totals]')).toHaveText('No payouts recorded.');
    await inspectPayoutLayout(paralegal, info, 'empty');
    await admin.locator('[data-finance-view="reporting"]').click();
    await expect(admin.locator('#fundsReleasedValue')).toHaveText('$0.00');
    await expect(admin.locator('#revenueTotalValue')).toHaveText('$0.00');
    const final = await server.inspect(caseId);
    expect(final.payouts).toEqual([]); expect(final.case.paymentReleased).toBe(false);
    expect(server.provider.calls.filter(row => row.method === 'refunds.create')).toHaveLength(1);
    expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toEqual([]);
    expect(server.provider.calls.filter(row => row.method === 'forbidden_network')).toEqual([]);
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const outcome of ['release_full', 'release_partial', 'withdrawn_refund', 'withdrawn_release_partial', 'withdrawn_release_full']) test(`actual ${outcome} decision reaches both parties through protected notice actions`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser); let caseId;
  const withdrawn = outcome.startsWith('withdrawn_'), action = outcome.replace('withdrawn_', ''), partial = action === 'release_partial';
  const selectedAction = withdrawn && action === 'release_full' ? 'release_partial' : action;
  const selectedPayout = partial ? 16400 : 32800;
  try {
    caseId = await fund(pages, actors, `River Street ${outcome}`);
    const { attorney, paralegal, admin } = pages;
    if (withdrawn) {
      await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/work`);
      const task = attorney.locator('[data-workspace-work]').getByRole('checkbox', { name: 'Prepare filing package' });
      await task.click(); await expect(task).toBeChecked();
      await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=work`);
      await paralegal.locator('.v2-matter-options > summary').click(); await paralegal.locator('[data-v2-withdraw-matter]').click();
      await paralegal.getByRole('dialog', { name: 'Withdraw from this matter?' }).getByRole('button', { name: 'Withdraw from matter', exact: true }).click();
      await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('paused');
      await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
      const withdrawal = attorney.locator('[data-workspace-withdrawal]');
      await withdrawal.getByRole('button', { name: 'Review decline of payment', exact: true }).click();
      await withdrawal.getByRole('button', { name: 'Decline release and start review window', exact: true }).click();
      await expect.poll(async () => Boolean((await server.inspect(caseId)).case.disputeDeadlineAt)).toBe(true);
      await paralegal.goto(`${server.origin}/paralegal-v2.html#/work?section=history&matterId=${caseId}`);
      await paralegal.locator(`[data-work-history-id="${caseId}"]`).getByRole('button', { name: 'Request LPC review', exact: true }).click();
      const request = paralegal.getByRole('dialog', { name: 'Request a withdrawal review', exact: true });
      await request.getByLabel('Review request details', { exact: true }).fill('LPC review of the completed filing work and remaining Matter funds.');
      await request.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('disputed');
    } else await api(paralegal.context(), 'post', `/api/disputes/${caseId}`, { message: 'LPC review of the completed filing work and remaining Matter funds.' });
    if (outcome === 'withdrawn_release_partial') {
      const mailBeforeReminder = server.evidence().external.mail.length;
      expect(await server.issueOverdueReviewReminder(caseId)).toEqual({ scanned: 1, notified: 1, failed: 0 });
      const reminders = (await server.reviewNotices(caseId)).filter(row => row.kind === 'overdue');
      expect(reminders).toHaveLength(2); expect(reminders.every(row => row.status === 'pending' && row.attempts === 0 && row.deadlineAt && row.remindedAt)).toBe(true);
      expect(reminders.map(row => String(row.userId)).sort()).toEqual([actors.attorney.id, actors.paralegal.id].sort());
      const actions = {};
      for (const role of ['attorney', 'paralegal']) {
        const page = pages[role], items = await api(page.context(), 'get', '/api/notifications/');
        const reminder = items.find(row => row.type === 'admin_review_overdue');
        expect(reminder?.action.href).toBe(role === 'attorney' ? `/case-detail.html?caseId=${caseId}&tab=financials` : `/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
        actions[role] = reminder.action;
        await page.goto(`${server.origin}/${role === 'attorney' ? 'attorney' : 'paralegal'}-v2.html#/home`);
        await page.getByRole('button', { name: /^View notifications/ }).click();
        await page.locator(`[data-notification-focus="open:${reminder.id || reminder._id}"]`).click();
        if (role === 'attorney') await expect(page.locator('[data-workspace-disputes]')).toContainText('Administrator review open');
        else {
          await expect(page.locator(`[data-work-history-id="${caseId}"] [data-review-status="open"]`)).toHaveText('An LPC review is open for this withdrawal. No decision is recorded.');
          await expect(page.locator('[data-v2-toast-region]')).not.toContainText('View changed');
        }
        await page.screenshot({ path: info.outputPath(`overdue-review-${role}.png`) });
      }
      const adminNotices = await api(admin.context(), 'get', '/api/notifications/'); expect(adminNotices.some(row => row.type === 'admin_review_overdue')).toBe(false);
      expect(server.evidence().external.mail.length).toBe(mailBeforeReminder);
      await fs.writeFile(info.outputPath('overdue-review-evidence.json'), JSON.stringify({ reminders, actions, immediateEmailCount: 0 }, null, 2));
    }
    const opened = await server.inspect(caseId), disputeId = opened.case.disputes[0].disputeId;
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    await admin.goto(`${server.origin}/admin-dashboard.html?review=${disputeId}&reviewMatter=${caseId}#finance`);
    const detail = admin.locator('.admin-dispute-detail:not([hidden])'); await expect(detail).toContainText('LPC review of the completed filing work');
    // Withdrawal review uses its existing amount field and Finalize payout control, including the full remaining amount.
    if (selectedAction === 'release_partial') await detail.locator('[data-dispute-amount]').fill(String(selectedPayout / 100));
    await detail.locator(`[data-dispute-action="${selectedAction.replace('_', '-')}"]`).click();
    const confirmation = admin.getByRole('dialog', { name: withdrawn ? 'Finalize withdrawal dispute?' : 'Confirm financial settlement', exact: true });
    const mailBefore = server.evidence().external.mail.length;
    await confirmation.getByRole('button', { name: action === 'refund' ? 'Finalize zero payout' : 'Release payout', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe(withdrawn ? 'paused' : 'closed');
    await expect.poll(async () => (await server.inspect(caseId)).case.disputes[0].status).toBe('resolved');
    await inspectResolutionNotices(pages, actors, info, caseId, mailBefore);
    const final = await server.inspect(caseId), paid = action !== 'refund';
    if (withdrawn) {
      const section = attorney.locator('[data-workspace-withdrawal]');
      await expect(section).not.toContainText('Payout records need review');
      await expect(section).toContainText(paid ? `Recorded paralegal payout: ${partial ? '$164.00' : '$328.00'}` : 'No payout was issued for this decision.');
      const review = await api(attorney.context(), 'get', `/api/cases/${caseId}/withdrawal-review?expectedOwnerId=${actors.attorney.id}`);
      expect(review.decision.payoutState).toBe(paid ? 'recorded' : 'none');
      expect(review.canDecide).toBe(false); expect(review.canPay).toBe(false); expect(review.blockers).not.toContain('payout_needs_review');
      if (outcome === 'withdrawn_release_full') {
        expect(review.remainingCents).toBe(0);
        if (review.relistedAt) {
          await expect(section).toContainText('Relisting request recorded:');
          await expect(section).toContainText('No funds remain for replacement work.');
        }
        await expect(section.getByRole('link',{name:'Review replacement applications',exact:true})).toHaveCount(0);
      }
      const layouts = [];
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        await attorney.setViewportSize(viewport); await section.scrollIntoViewIfNeeded();
        const measured = await section.evaluate(el => { const rect = el.getBoundingClientRect(); return { width: rect.width, left: rect.left, right: rect.right, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth }; });
        expect(measured.documentWidth).toBeLessThanOrEqual(viewport.width + 1); expect(measured.left).toBeGreaterThanOrEqual(0); expect(measured.right).toBeLessThanOrEqual(viewport.width + 1);
        layouts.push(measured); await attorney.screenshot({ path: info.outputPath(`withdrawal-settlement-${viewport.width}.png`), fullPage: true });
      }
      await fs.writeFile(info.outputPath('withdrawal-settlement-projection.json'), JSON.stringify({ review, layouts }, null, 2));
    }

    expect(final.payouts).toHaveLength(paid ? 1 : 0); expect(final.case.disputeSettlement.payoutAmount).toBe(paid ? partial ? 16400 : 32800 : 0);
    expect(final.case.disputeSettlement.refundAmount).toBe(!withdrawn && partial ? 24400 : 0);
    expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toHaveLength(paid ? 1 : 0);
    expect(server.provider.calls.filter(row => row.method === 'refunds.create')).toHaveLength(!withdrawn && partial ? 1 : 0);
    const replay = await api(admin.context(), 'post', `/api/payments/dispute/settle/${caseId}`, { action: selectedAction, disputeId, ...(selectedAction === 'release_partial' ? { payoutAmountCents: selectedPayout } : {}) });
    expect(replay.alreadySettled).toBe(true); expect((await server.reviewNotices(caseId)).filter(row => row.kind === 'resolved')).toHaveLength(2);
    expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toHaveLength(paid ? 1 : 0);
    expect(server.provider.calls.filter(row => row.method === 'refunds.create')).toHaveLength(!withdrawn && partial ? 1 : 0);
    expect(server.provider.calls.filter(row => row.method === 'forbidden_network')).toEqual([]); expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

test('actual paralegal opens review through the current route and all recipients retain their notices', async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser); let caseId;
  try {
    caseId = await fund(pages, actors, 'River Street participant review');
    const { attorney, paralegal, admin } = pages;
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=work`);
    await paralegal.getByText('Matter options', { exact: true }).click();
    await paralegal.locator('[data-v2-open-dispute]').click();
    const dialog = paralegal.getByRole('dialog', { name: 'Open a dispute?' });
    await dialog.getByLabel('What should LPC know?').fill('The exhibit scope requires LPC review.');
    await dialog.getByRole('button', { name: 'Open dispute', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('disputed');
    const notices = await server.reviewNotices(caseId); expect(notices).toHaveLength(3);
    expect(notices.every(row => row.status === 'pending' && row.attempts === 0)).toBe(true);
    expect(server.evidence().external.mail.filter(row => /^Review opened:/.test(row[1]))).toEqual([]);
    await expect(attorney.locator('[data-workspace-disputes]')).toContainText('The exhibit scope requires LPC review.');
    await admin.goto(`${server.origin}/admin-dashboard.html?review=${notices[0].disputeId}&reviewMatter=${caseId}#finance`);
    await expect(admin.locator('.admin-dispute-detail:not([hidden])')).toContainText('The exhibit scope requires LPC review.');
    expect(server.provider.calls.filter(row => ['transfers.create', 'refunds.create', 'forbidden_network'].includes(row.method))).toEqual([]);
    await fs.writeFile(info.outputPath('review-notice-evidence.json'), JSON.stringify({ notices }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

test('actual partial withdrawal survives a card hold, authorized clearance and replacement completion', async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser, { replacement: true });
  let caseId;
  try {
    caseId = await fund(pages, actors, 'River Street replacement');
    const { attorney, paralegal, admin, replacement } = pages;
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/work`);
    const firstWork = attorney.locator('[data-workspace-work]').getByRole('checkbox', { name: 'Prepare filing package' });
    await firstWork.click(); await expect(firstWork).toBeChecked();
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=work`);
    await paralegal.locator('.v2-matter-options > summary').click();
    const mailBeforeWithdrawal = server.evidence().external.mail.length;
    await paralegal.locator('[data-v2-withdraw-matter]').click();
    await paralegal.getByRole('dialog', { name: 'Withdraw from this matter?' }).getByRole('button', { name: 'Withdraw from matter', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('paused');
    const notices = await server.withdrawalNotices(caseId);
    expect(notices).toHaveLength(2);
    expect(notices.map(item => String(item.userId)).sort()).toEqual([actors.attorney.id, actors.paralegal.id].sort());
    for (const notice of notices) expect(notice).toMatchObject({ status: 'pending', outcome: 'awaiting_attorney_decision', attempts: 0 });
    expect(server.evidence().external.mail.length).toBe(mailBeforeWithdrawal);
    const ownerNotices = await api(attorney.context(), 'get', '/api/notifications/');
    const ownerNotice = ownerNotices.find(item => item.action?.label === 'Review withdrawal');
    expect(ownerNotice?.action.href).toBe(`/case-detail.html?caseId=${caseId}&tab=financials`);
    const previousNotices = await api(paralegal.context(), 'get', '/api/notifications/');
    const previousNotice = previousNotices.find(item => item.action?.label === 'View Matter history');
    expect(previousNotice?.action.href).toBe(`/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
    await fs.writeFile(info.outputPath('withdrawal-notice-evidence.json'), JSON.stringify({ notices, attorneyAction: ownerNotice.action, paralegalAction: previousNotice.action, immediateEmailCount: server.evidence().external.mail.length - mailBeforeWithdrawal }, null, 2));
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const withdrawal = attorney.locator('[data-workspace-withdrawal]');
    await expect(attorney.locator('[data-workspace-completion]')).toBeHidden();
    await inspectFinancialLayout(attorney, info, 'withdrawal-review');
    await withdrawal.getByLabel(/Withdrawal amount before the paralegal fee/).fill('100');
    await withdrawal.getByRole('button', { name: 'Review payout amount', exact: true }).click();
    await withdrawal.getByRole('button', { name: 'Record decision and pay $82.00', exact: true }).click();
    await expect(withdrawal).toContainText('Withdrawal decision recorded.');
    await expect.poll(async () => (await server.inspect(caseId)).payouts.length).toBe(1);
    const decidedNotices = (await server.withdrawalNotices(caseId)).filter(item => item.kind === 'partial');
    expect(decidedNotices).toHaveLength(2);
    for (const notice of decidedNotices) expect(notice).toMatchObject({ status: 'pending', outcome: 'partial_recorded', attempts: 0 });
    expect(server.evidence().external.mail.length).toBe(mailBeforeWithdrawal);
    const decisionActions = [];
    for (const page of [attorney, paralegal]) {
      const items = await api(page.context(), 'get', '/api/notifications/');
      const item = items.find(row => row.message === 'River Street replacement: A withdrawal payout decision was recorded.');
      expect(item?.action.href).toBe(page === attorney ? `/case-detail.html?caseId=${caseId}&tab=financials` : `/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
      decisionActions.push(item.action);
    }
    await fs.writeFile(info.outputPath('withdrawal-decision-notice-evidence.json'), JSON.stringify({ notices: decidedNotices, actions: decisionActions, immediateEmailCount: server.evidence().external.mail.length - mailBeforeWithdrawal }, null, 2));
    console.log('Lifecycle checkpoint: earlier partial payout recorded');
    await expect(attorney.locator('[data-workspace-completion]')).toBeHidden();
    await inspectFinancialLayout(attorney, info, 'withdrawal-recorded');
    const earlier = (await server.inspect(caseId)).payouts;
    await api(replacement.context(), 'post', `/api/cases/${caseId}/apply`, { coverLetter: 'I can complete the remaining filing work and supporting evidence review.' });
    server.provider.state.cardDispute = server.provider.cardDispute(caseId);
    async function deliverCard(type) {
      const response = await admin.context().request.post(`${server.origin}/api/webhooks/stripe`, { headers: { 'Stripe-Signature': 'synthetic-phase2-signature', 'Content-Type': 'application/json' }, data: JSON.stringify({ id: `evt_${require('node:crypto').randomUUID().replaceAll('-', '')}`, type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object: server.provider.state.cardDispute } }) });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await deliverCard('charge.dispute.created');
    console.log('Lifecycle checkpoint: card hold delivered');
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/applications?applicantId=${actors.replacement.id}`);
    const hiring = attorney.locator('[data-hiring]');
    await hiring.getByRole('button', { name: 'Review hiring and funding', exact: true }).click();
    await expect(hiring).toHaveAttribute('data-state', 'ready');
    await expect(hiring.getByRole('button', { name: 'Review hiring confirmation', exact: true })).toHaveCount(0);
    await expect(hiring).toContainText('withdrawal');
    server.provider.cardRecovery(); await deliverCard('charge.dispute.closed');
    await admin.goto(`${server.origin}/admin-dashboard.html`);
    // The actual guided Home queue presents this eligible card hold directly.
    await admin.locator('#chargebacksBody').getByRole('button', { name: 'Clear eligible hold', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).operations.find(row => row.kind === 'chargeback')?.administrativeStatus).toBe('hold_cleared');
    console.log('Lifecycle checkpoint: eligible card hold cleared');
    await expect(await server.inspect(caseId)).toMatchObject({ payouts: earlier });
    await hiring.getByRole('button', { name: 'Refresh hiring review', exact: true }).click();
    await hiring.getByRole('button', { name: 'Review hiring confirmation', exact: true }).click();
    await hiring.getByRole('button', { name: 'Hire replacement paralegal', exact: true }).click();
    await expect.poll(async () => String((await server.inspect(caseId)).case.paralegalId)).toBe(actors.replacement.id);
    await replacement.goto(`${server.origin}/paralegal-v2.html#/home?view=history`);
    await expect(replacement.locator('[data-payout-totals] .pf-estimates')).toContainText('$246.00');
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/work`);
    const lastWork = attorney.locator('[data-workspace-work]').getByRole('checkbox', { name: 'Review supporting evidence' });
    await lastWork.click(); await expect(lastWork).toBeChecked();
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const completion = attorney.locator('[data-workspace-completion]');
    await completion.getByRole('button', { name: 'Review completion', exact: true }).click();
    await completion.getByRole('button', { name: 'Complete Matter and release $246.00', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.paymentReleased).toBe(true);
    await expect(completion).toContainText('Payout recorded.');
    const replacementReceipt = attorney.locator('[data-matter-receipt]');
    await expect(replacementReceipt.getByRole('button', { name: 'Download receipt', exact: true })).toBeVisible();
    await expect(replacementReceipt).not.toContainText('The payment details need review');
    const originalReceipt = await attorney.context().request.get(`${server.origin}/api/payments/receipt/attorney/${caseId}/review?expectedOwnerId=${actors.attorney.id}&receiptId=payment`);
    expect(originalReceipt.ok()).toBe(true);
    expect(await originalReceipt.json()).toMatchObject({ reason: 'available', receipt: { type: 'payment', status: 'received', total: { amount: 48800 } } });
    await inspectFinancialLayout(attorney, info, 'replacement-completed');
    const recoveredDownloadPending = attorney.waitForEvent('download');
    await replacementReceipt.getByRole('button', { name: 'Download receipt', exact: true }).click();
    const recoveredDownload = await recoveredDownloadPending;
    await recoveredDownload.saveAs(info.outputPath('recovered-original-payment.pdf'));
    expect((await fs.readFile(info.outputPath('recovered-original-payment.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
    for (const [page, amount, name] of [[paralegal, '$82.00', 'earlier'], [replacement, '$246.00', 'replacement']]) {
      await page.goto(`${server.origin}/paralegal-v2.html#/work?section=history`);
      const history = page.locator('#v2-work-history'); await expect(history).toContainText(amount);
      const downloadPending = page.waitForEvent('download'); await history.locator('[data-payout-receipt]').click();
      const download = await downloadPending; await download.saveAs(info.outputPath(`${name}-payout.pdf`));
      expect((await fs.readFile(info.outputPath(`${name}-payout.pdf`))).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const final = await server.inspect(caseId);
    expect(final.payouts).toHaveLength(2); expect(final.payouts.find(row => String(row._id) === String(earlier[0]._id))).toEqual(earlier[0]);
    const completedNotices = await server.completionNotices(caseId);
    expect(completedNotices).toHaveLength(2);
    expect(completedNotices.map(item => String(item.userId)).sort()).toEqual([actors.attorney.id, actors.replacement.id].sort());
    expect(completedNotices.some(item => String(item.userId) === actors.paralegal.id)).toBe(false);
    for (const item of completedNotices) expect(item).toMatchObject({ status: 'pending', attempts: 0 });
    await fs.writeFile(info.outputPath('completion-notice-evidence.json'), JSON.stringify(completedNotices, null, 2));

    expect(server.provider.calls.filter(row => row.method === 'paymentIntents.create')).toHaveLength(1);
    expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toHaveLength(2);
    expect(server.provider.calls.filter(row => row.method === 'forbidden_network')).toEqual([]);
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

test('actual declined withdrawal expires through the Matter read and retains both outcomes', async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser);
  let caseId;
  try {
    caseId = await fund(pages, actors, 'River Street withdrawal review');
    const { attorney, paralegal } = pages;
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/work`);
    const firstWork = attorney.locator('[data-workspace-work]').getByRole('checkbox', { name: 'Prepare filing package' });
    await firstWork.click(); await expect(firstWork).toBeChecked();
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=work`);
    await paralegal.locator('.v2-matter-options > summary').click();
    const before = server.evidence().external.mail.length;
    await paralegal.locator('[data-v2-withdraw-matter]').click();
    await paralegal.getByRole('dialog', { name: 'Withdraw from this matter?' }).getByRole('button', { name: 'Withdraw from matter', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('paused');
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const panel = attorney.locator('[data-workspace-withdrawal]');
    await panel.getByRole('button', { name: 'Review decline of payment', exact: true }).click();
    await panel.getByRole('button', { name: 'Decline release and start review window', exact: true }).click();
    await expect.poll(async () => Boolean((await server.inspect(caseId)).case.disputeDeadlineAt)).toBe(true);
    const reviewed = await server.withdrawalNotices(caseId);
    expect(reviewed.filter(item => item.kind === 'reject')).toHaveLength(2);
    expect(reviewed.every(item => item.status === 'pending')).toBe(true);
    await inspectFinancialLayout(attorney, info, 'withdrawal-window');
    await server.makeWithdrawalReviewDue(caseId);
    await api(attorney.context(), 'get', `/api/cases/${caseId}`);
    const expired = await server.inspect(caseId), notices = await server.withdrawalNotices(caseId);
    expect(expired.case).toMatchObject({ payoutFinalizedType: 'expired_zero', partialPayoutAmount: 0, remainingAmount: 40000, postingSyncStatus: 'synced' });
    expect(expired.payouts).toHaveLength(0); expect(notices).toHaveLength(6);
    const expiry = notices.filter(item => item.kind === 'expired'); expect(expiry).toHaveLength(2);
    expect(expiry.map(item => String(item.userId)).sort()).toEqual([actors.attorney.id, actors.paralegal.id].sort());
    for (const item of expiry) expect(item).toMatchObject({ status: 'pending', outcome: 'expired_zero', attempts: 0 });
    await api(attorney.context(), 'get', `/api/cases/${caseId}`);
    expect(await server.withdrawalNotices(caseId)).toEqual(notices);
    const actions = [];
    for (const page of [attorney, paralegal]) {
      const items = await api(page.context(), 'get', '/api/notifications/');
      const item = items.find(row => row.message === 'River Street withdrawal review: The payment-review window ended without a review request. No payout was issued for this withdrawal.');
      expect(item?.action.href).toBe(page === attorney ? `/case-detail.html?caseId=${caseId}&tab=financials` : `/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
      actions.push(item.action);
    }
    expect(server.evidence().external.mail.length).toBe(before);
    expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toHaveLength(0);
    await attorney.reload(); await expect(panel).toContainText('No payout was issued for this decision.');
    await inspectFinancialLayout(attorney, info, 'withdrawal-expired');
    for (const width of [1366, 390]) {
      await attorney.setViewportSize({ width, height: 900 });
      await attorney.evaluate(narrow => { document.documentElement.classList.toggle('theme-dark', narrow); document.documentElement.style.fontSize = narrow ? '20px' : '17px'; }, width === 390);
      await attorney.getByRole('button', { name: /^View notifications/ }).click();
      const center = attorney.locator('#av2-notifications');
      await expect(center.getByText('River Street withdrawal review: The payment-review window ended without a review request. No payout was issued for this withdrawal.', { exact: true })).toBeVisible();
      await expect(center.getByText('River Street withdrawal review: Release was declined and a payment-review window was opened.', { exact: true })).toBeVisible();
      await expect(center).not.toContainText('window is open');
      await expect(center).not.toContainText('choose a partial payout');
      expect(await center.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await attorney.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await attorney.screenshot({ path: info.outputPath(`withdrawal-expiry-notifications-${width}.png`) });
      await attorney.keyboard.press('Escape'); await expect(center).toBeHidden();
    }
    await fs.writeFile(info.outputPath('withdrawal-expiry-notice-evidence.json'), JSON.stringify({ notices, actions, simulatedElapsedDeadline: true, immediateEmailCount: server.evidence().external.mail.length - before }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});


test('actual zero-work withdrawal relists once and retains both recipient notices', async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser);
  let caseId;
  try {
    caseId = await fund(pages, actors, 'River Street zero-work withdrawal');
    const { attorney, paralegal } = pages;
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=work`);
    await paralegal.locator('.v2-matter-options > summary').click();
    const mailBeforeWithdrawal = server.evidence().external.mail.length;
    await paralegal.locator('[data-v2-withdraw-matter]').click();
    await paralegal.getByRole('dialog', { name: 'Withdraw from this matter?' }).getByRole('button', { name: 'Withdraw from matter', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.payoutFinalizedType).toBe('zero_auto');
    const state = await server.inspect(caseId), notices = await server.withdrawalNotices(caseId);
    expect(state.case).toMatchObject({ status: 'paused', partialPayoutAmount: 0, remainingAmount: 40000, postingSyncStatus: 'synced', paymentReleased: false });
    expect(state.payouts).toEqual([]); expect(notices).toHaveLength(2);
    for (const notice of notices) expect(notice).toMatchObject({ status: 'pending', outcome: 'zero_auto', attempts: 0 });
    expect(notices.map(item => String(item.userId)).sort()).toEqual([actors.attorney.id, actors.paralegal.id].sort());
    expect(server.evidence().external.mail.length).toBe(mailBeforeWithdrawal);
    const replay = await api(paralegal.context(), 'post', `/api/cases/${caseId}/withdraw`, {});
    expect(replay.alreadyProcessed).toBe(true); expect(await server.withdrawalNotices(caseId)).toEqual(notices);
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const withdrawal = attorney.locator('[data-workspace-withdrawal]');
    await expect(withdrawal).toContainText('No payout was issued');
    await expect(withdrawal).toContainText('Relisting request recorded');
    await expect(withdrawal.getByRole('link', { name: 'Review remaining work', exact: true })).toHaveAttribute('href', `#/matters/${caseId}/work`);
    await expect(withdrawal.getByRole('link', { name: 'Review completed work', exact: true })).toHaveCount(0);
    await inspectFinancialLayout(attorney, info, 'zero-work-withdrawal');
    await fs.writeFile(info.outputPath('withdrawal-notice-evidence.json'), JSON.stringify({ notices, outcome: replay.withdrawalOutcome, immediateEmailCount: server.evidence().external.mail.length - mailBeforeWithdrawal }, null, 2));
    expect(server.provider.calls.filter(row => row.method === 'transfers.create' || row.method === 'forbidden_network')).toEqual([]);
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

test('actual termination review notice reaches retained History through resolution', async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser); let caseId;
  try {
    caseId = await fund(pages, actors, 'River Street termination review');
    const { attorney, paralegal, admin } = pages;
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const mailBefore = server.evidence().external.mail.length;
    // Exercise the retained API entry; this case does not claim a new V2 termination control.
    const result = await api(attorney.context(), 'post', `/api/cases/${caseId}/terminate`, { reason: 'The remaining filing work requires an LPC review.\n\nRetain the engagement history and current funding record.' });
    expect(result.requiresAdmin).toBe(true);
    const saved = await server.inspect(caseId), disputeId = saved.case.terminationDisputeId;
    expect(saved.case.status).toBe('disputed'); expect(saved.case.paralegalAccessRevokedAt).toBeTruthy(); expect(saved.case.paymentReleased).toBe(false); expect(saved.payouts).toEqual([]);
    const notices = await server.reviewNotices(caseId); expect(notices).toHaveLength(1); expect(notices[0]).toMatchObject({ kind: 'opened', reviewContext: 'termination', userRole: 'paralegal', status: 'pending', attempts: 0 }); expect(String(notices[0].userId)).toBe(actors.paralegal.id);
    for (const role of ['attorney', 'admin']) expect((await api(pages[role].context(), 'get', '/api/notifications/')).filter(row => row.type === 'dispute_opened')).toEqual([]);
    const items = await api(paralegal.context(), 'get', '/api/notifications/'), notice = items.find(row => row.type === 'dispute_opened');
    expect(notice.action.href).toBe(`/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
    const inspectHistory = async surface => {
      const row = paralegal.locator(surface === 'original' ? `.file-card[data-case-id="${caseId}"]` : `[data-work-history-id="${caseId}"]`);
      await expect(row).toContainText('Termination review');
      await expect(row.locator('[data-review-status="open"]')).toHaveText('An LPC review is open for this termination request. No decision is recorded.');
      await expect(row).toContainText('Payout not confirmed'); await expect(row.getByRole('button', { name: 'Download receipt', exact: true })).toHaveCount(0); await expect(row).not.toContainText('Withdrawn');
      for (const theme of ['light', 'dark']) for (const width of [1366, 390]) {
        await paralegal.setViewportSize({ width, height: 1000 });
        await paralegal.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
        await row.scrollIntoViewIfNeeded();
        expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await row.screenshot({ path: info.outputPath(`termination-${surface}-${theme}-${width}.png`) });
      }
    };
    await paralegal.goto(server.origin + notice.action.href); await inspectHistory('original');
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/home`); await paralegal.getByRole('button', { name: /^View notifications/ }).click(); await paralegal.locator(`[data-notification-focus="open:${notice.id || notice._id}"]`).click(); await inspectHistory('v2');
    const denied = await paralegal.context().request.get(`${server.origin}/api/cases/${caseId}`); expect(denied.status()).toBe(404);
    await expect(attorney.locator('[data-workspace-disputes]')).toContainText('Administrator review open');
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    await fs.writeFile(info.outputPath('termination-review-evidence.json'), JSON.stringify({ notices, action: notice.action, immediateEmailCount: 0, workspaceStatus: denied.status() }, null, 2));
    await admin.goto(`${server.origin}/admin-dashboard.html?review=${disputeId}&reviewMatter=${caseId}#finance`);
    const detail = admin.locator('.admin-dispute-detail:not([hidden])'); await expect(detail).toContainText('Retain the engagement history and current funding record.');
    await detail.locator('[data-dispute-action="refund"]').click();
    const confirmation = admin.getByRole('dialog', { name: 'Confirm financial settlement', exact: true }); await confirmation.getByRole('button', { name: 'Issue refund', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('closed');
    await inspectResolutionNotices(pages, actors, info, caseId, mailBefore);
    expect(server.provider.calls.filter(row => row.method === 'refunds.create')).toHaveLength(1); expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toEqual([]); expect(server.provider.calls.filter(row => row.method === 'forbidden_network')).toEqual([]);
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const entry of ['v2', 'current']) test(`actual ${entry} nonselection decision reaches the applicant notice and retained application`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser); let caseId;
  try {
    const { attorney, paralegal } = pages, title = 'River Street application review';
    const published = await api(attorney.context(), 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence for attorney review.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    const application = await api(paralegal.context(), 'post', `/api/jobs/${published.jobId}/apply`, { coverLetter: 'I can prepare the filing package and organize the supporting exhibits.' });
    const applicationId = String(application.applicationId || application._id || application.id);
    await attorney.goto(`${server.origin}/${entry === 'v2' ? `attorney-v2.html#/matters/${caseId}/applications` : 'dashboard-attorney.html#cases:inquiries'}`);
    if (entry === 'current') {
      const actions = attorney.locator(`.case-actions[data-case-id="${caseId}"]:visible`).first();
      await actions.locator('[data-case-menu-trigger]').click();
      await actions.getByRole('button', { name: 'Review applications', exact: true }).click();
    }
    const panel = attorney.locator('[data-matter-applications]'), decision = panel.locator('[data-application-decisions]');
    await expect(panel).toHaveAttribute('data-state', 'ready');
    await decision.getByRole('button', { name: 'Review application decisions', exact: true }).click();
    await expect(decision).toHaveAttribute('data-state', 'ready');
    await decision.getByRole('button', { name: 'Reject application', exact: true }).click();
    const mailBefore = server.evidence().external.mail.length;
    const savedResponse = attorney.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/cases/${caseId}/application-review/${actors.paralegal.id}/decision`);
    await decision.getByRole('button', { name: 'Confirm rejection', exact: true }).click();
    const response = await savedResponse; expect(response.status()).toBe(200); const { receipt } = await response.json();
    await expect(panel).toHaveAttribute('data-state', 'ready'); await expect(panel.getByRole('status').first()).toContainText('Application rejected.');
    const retained = await api(attorney.context(), 'get', `/api/cases/${caseId}/application-review/${actors.paralegal.id}/decision/${receipt.requestId}?expectedOwnerId=${actors.attorney.id}`);
    expect(retained.receipt).toEqual(receipt);
    const notices = (await api(paralegal.context(), 'get', '/api/notifications/')).filter(row => row.type === 'application_denied' && row.context.caseId === caseId);
    expect(notices).toHaveLength(1); const notice = notices[0];
    expect(notice.message).toBe(`Your application for ${title} was not selected`);
    expect(notice.action).toEqual({ label: 'View applications', href: '/dashboard-paralegal.html#cases' });
    for (const role of ['attorney', 'admin']) expect((await api(pages[role].context(), 'get', '/api/notifications/')).filter(row => row.type === 'application_denied')).toEqual([]);
    await paralegal.goto(server.origin + notice.action.href);
    const originalRow = paralegal.locator('.applied-card').filter({ has: paralegal.locator(`[data-application-id="${applicationId}"]`) });
    await expect(originalRow).toContainText(title); await expect(originalRow).toContainText('Not selected');
    await originalRow.screenshot({ path: info.outputPath('nonselection-original-application.png') });
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/home`);
    await paralegal.getByRole('button', { name: /^View notifications/ }).click();
    const noticeButton = paralegal.locator(`[data-notification-focus="open:${notice.id || notice._id}"]`);
    await expect(noticeButton).toContainText(notice.message);
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await paralegal.setViewportSize({ width, height: 1000 });
      await paralegal.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      await expect(noticeButton).toBeVisible();
      expect(await noticeButton.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await paralegal.locator('[data-v2-notifications-panel]').screenshot({ path: info.outputPath(`nonselection-notice-${theme}-${width}.png`) });
    }
    await noticeButton.click();
    const row = paralegal.locator(`[data-work-application-id="${applicationId}"]`);
    await expect(row).toContainText(title); await expect(row).toContainText('Not selected');
    await row.screenshot({ path: info.outputPath('nonselection-v2-application-dark-390.png') });
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    const saved = await server.inspect(caseId); expect(saved.case.status).toBe('open'); expect(saved.case.paralegalId).toBeFalsy(); expect(saved.payouts).toEqual([]); expect(saved.operations).toEqual([]);
    expect(server.provider.calls.filter(row => ['paymentIntents.create', 'transfers.create', 'refunds.create', 'forbidden_network'].includes(row.method))).toEqual([]);
    await fs.writeFile(info.outputPath('nonselection-notice-evidence.json'), JSON.stringify({ entry, caseId, applicationId, receipt, notice, immediateEmailCount: server.evidence().external.mail.length - mailBefore }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const entry of ['v2', 'current']) test(`actual ${entry} application submission notice opens the exact applicant and retains its email`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser); let caseId;
  try {
    const { attorney, paralegal } = pages, title = 'River Street application submission';
    const published = await api(attorney.context(), 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence for attorney review.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    const mailBefore = server.evidence().external.mail.length;
    const coverLetter = 'I can organize the River Street exhibits.\n\nI will check the filing references with the attorney.';
    const application = await api(paralegal.context(), 'post', entry === 'v2' ? `/api/cases/${caseId}/apply` : `/api/jobs/${published.jobId}/apply`, { coverLetter });
    const applicationId = String(application.applicationId || application._id || application.id);
    const notices = (await api(attorney.context(), 'get', '/api/notifications/')).filter(row => row.context.caseId === caseId);
    const notice = notices.find(row => row.type === 'application_submitted'), locked = notices.find(row => row.type === 'case_budget_locked');
    expect(notice.message).toBe(`River applied to ${title}`); expect(locked.message).toBe(`Matter amount locked for ${title}`);
    expect(notice.action).toEqual({ label: 'Review application', href: `/case-detail.html?caseId=${caseId}&tab=applications&applicantId=${actors.paralegal.id}` });
    const queued = await server.applicationNotices(caseId); expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(String(queued[0].applicationId)).toBe(applicationId); expect(String(queued[0].userId)).toBe(actors.attorney.id); expect(String(queued[0].paralegalId)).toBe(actors.paralegal.id);
    await attorney.goto(`${server.origin}/${entry === 'v2' ? 'attorney-v2.html#/home' : 'dashboard-attorney.html#home'}`);
    await attorney.getByRole('button', { name: /^View notifications/ }).click();
    const noticeId = notice.id || notice._id;
    const link = entry === 'v2' ? attorney.locator(`[data-notification-focus="open:${noticeId}"]`) : attorney.locator(`.notif-item[data-id="${noticeId}"] .notif-main`);
    const center = entry === 'v2' ? attorney.locator('[data-av2-panel="notifications"]') : attorney.locator('[data-notification-panel]:visible');
    await expect(link).toContainText(notice.message);
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await attorney.setViewportSize({ width, height: 1000 });
      await attorney.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      expect(await link.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await center.screenshot({ path: info.outputPath(`submission-notice-${theme}-${width}.png`) });
    }
    if (entry === 'current' && info.project.name === 'chromium') {
      await attorney.evaluate(() => {
        sessionStorage.removeItem('lpc:notice-matter-transition');
        addEventListener('pageswap', event => {
          event.viewTransition?.ready.catch(() => {});
          sessionStorage.setItem('lpc:notice-matter-transition', String(Boolean(event.viewTransition)));
        }, { once: true });
      });
    }
    await link.click();
    if (entry === 'current') {
      const preview = attorney.getByRole('dialog', { name: 'River paralegal', exact: true });
      await expect(preview).toContainText('I can organize the River Street exhibits.');
      await expect(preview).toContainText('Submitted');
      if (info.project.name === 'chromium') expect(await attorney.evaluate(() => sessionStorage.getItem('lpc:notice-matter-transition'))).toBe('false');
      const reviewLink = preview.getByRole('link', { name: 'Open candidate review', exact: true });
      await expect(reviewLink).toHaveAttribute('href', `/dashboard-attorney.html?caseId=${caseId}&applicantId=${actors.paralegal.id}&openApplicant=1#cases:inquiries`);
      await reviewLink.click();
    }
    const panel = entry === 'v2'
      ? attorney.locator('[data-matter-applications]')
      : attorney.getByRole('row').filter({ has: attorney.getByRole('button', { name: 'Close applicants', exact: true }) });
    await expect(panel).toBeVisible();
    if (entry === 'v2') await expect(panel).toHaveAttribute('data-state', 'ready');
    await expect(panel).toContainText('I can organize the River Street exhibits.');
    await expect(panel).toContainText('I will check the filing references with the attorney.');
    if (entry === 'v2') expect(attorney.url()).toContain(`applicantId=${actors.paralegal.id}`);
    else {
      // The original dashboard consumes its return query after selecting the applicant.
      const drawer = panel.locator(`[data-applicants-drawer][data-case-id="${caseId}"]`);
      await expect(drawer.locator('[data-applicant-row][aria-pressed="true"]')).toContainText('River');
      await expect(drawer.locator(`[data-applicant-detail] [data-paralegal-id="${actors.paralegal.id}"]`).first()).toBeVisible();
    }
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await attorney.setViewportSize({ width, height: 1000 });
      await attorney.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      await panel.scrollIntoViewIfNeeded(); expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await panel.screenshot({ path: info.outputPath(`submission-application-${theme}-${width}.png`) });
    }
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    for (const role of ['paralegal', 'admin']) expect((await api(pages[role].context(), 'get', '/api/notifications/')).filter(row => row.type === 'application_submitted')).toEqual([]);
    const saved = await server.inspect(caseId); expect(saved.case.status).toBe('open'); expect(saved.case.lockedTotalAmount).toBe(40000); expect(saved.case.paralegalId).toBeFalsy(); expect(saved.operations).toEqual([]); expect(saved.payouts).toEqual([]);
    expect(server.provider.calls.filter(row => ['paymentIntents.create', 'transfers.create', 'refunds.create', 'forbidden_network'].includes(row.method))).toEqual([]);
    await fs.writeFile(info.outputPath('submission-notice-evidence.json'), JSON.stringify({ entry, caseId, applicationId, notice, locked, queued, immediateEmailCount: server.evidence().external.mail.length - mailBefore }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const entry of ['v2', 'current']) test(`actual ${entry} invitation send retains the invitee notice and opens the pending invitation`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser, { preferences: { theme: 'dark' }, publicProfile: true }); let caseId;
  try {
    const { attorney, paralegal } = pages, title = 'River Street invitation review';
    const published = await api(attorney.context(), 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Organize the River Street exhibits and check the filing references with the attorney.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    const mailBefore = server.evidence().external.mail.length;
    await attorney.goto(`${server.origin}/${entry === 'v2' ? `attorney-v2.html#/paralegals/${actors.paralegal.id}?caseId=${caseId}` : `profile-paralegal.html?paralegalId=${actors.paralegal.id}`}`);
    const sending = entry === 'v2' ? attorney.locator('[data-invitation-actions]') : attorney.locator('.lpc-invitation-dialog');
    if (entry === 'v2') {
      await sending.getByRole('button', { name: 'Review invitation', exact: true }).click();
      await sending.getByRole('button', { name: 'Review invitation before sending', exact: true }).click();
    } else {
      await attorney.getByRole('button', { name: 'Invite to Matter', exact: true }).click();
      await sending.getByRole('button', { name: title, exact: true }).click();
    }
    await expect(sending).toContainText('$400.00');
    for (const width of [1366, 390]) { await attorney.setViewportSize({ width, height: 1000 }); await sending.scrollIntoViewIfNeeded(); await sending.screenshot({ path: info.outputPath(`invitation-send-dark-${width}.png`) }); }
    await sending.getByRole('button', { name: 'Send invitation', exact: true }).click(); await expect(sending.getByRole('status')).toContainText('Invitation sent.');
    const queued = await server.invitationNotices(caseId); expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ kind: 'sent', status: 'pending', attempts: 0 });
    expect(String(queued[0].userId)).toBe(actors.paralegal.id); expect(String(queued[0].ownerId)).toBe(actors.attorney.id);
    const notices = await api(paralegal.context(), 'get', '/api/notifications/'), notice = notices.find(item => item.type === 'case_invite' && item.context.caseId === caseId);
    expect(notice.action).toEqual({ label: 'View invitation', href: `/dashboard-paralegal.html?inviteCase=${caseId}#home` });
    await paralegal.goto(`${server.origin}/${entry === 'v2' ? 'paralegal-v2.html#/home' : 'dashboard-paralegal.html#home'}`);
    await paralegal.getByRole('button', { name: /^View notifications/ }).click();
    const noticeId = notice.id || notice._id, link = entry === 'v2' ? paralegal.locator(`[data-notification-focus="open:${noticeId}"]`) : paralegal.locator(`.notif-item[data-id="${noticeId}"] .notif-main`);
    await expect(link).toContainText(title); await paralegal.setViewportSize({ width: 390, height: 1000 });
    await link.screenshot({ path: info.outputPath('invitation-notice-dark-390.png') }); await link.click();
    const review = entry === 'v2' ? paralegal.locator(`[data-work-invite-id="${caseId}"]`) : paralegal.locator('#inviteOverlay [role="dialog"]');
    await expect(review).toBeVisible(); await expect(review).toContainText(title);
    if (entry === 'v2') await expect(review.locator('details')).toHaveAttribute('open', '');
    await expect(review).toContainText('Organize the River Street exhibits and check the filing references with the attorney.');
    await expect(review.getByRole('button', { name: /^Accept invitation$/i })).toBeVisible();
    for (const width of [1366, 390]) { await paralegal.setViewportSize({ width, height: 1000 }); await review.scrollIntoViewIfNeeded(); expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true); await review.screenshot({ path: info.outputPath(`invitation-review-dark-${width}.png`) }); }
    const saved = await server.inspect(caseId); expect(saved.case.invites).toHaveLength(1); expect(saved.case.invites[0].status).toBe('pending'); expect(saved.case.lockedTotalAmount).toBe(40000); expect(saved.case.paralegalId).toBeFalsy(); expect(saved.case.status).toBe('open'); expect(saved.payouts).toEqual([]); expect(saved.operations).toEqual([]);
    expect(server.evidence().external.mail.length).toBe(mailBefore); expect(server.provider.calls.filter(row => ['paymentIntents.create', 'transfers.create', 'refunds.create', 'forbidden_network'].includes(row.method))).toEqual([]);
    await fs.writeFile(info.outputPath('invitation-notice-evidence.json'), JSON.stringify({ entry, caseId, queued, notice, immediateEmailCount: server.evidence().external.mail.length - mailBefore }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const entry of ['v2', 'current']) for (const decision of ['accept', 'decline']) test(`actual ${entry} invitation response ${decision} preserves recipients and protected destinations`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser, { publicProfile: true }); let caseId;
  try {
    const { attorney, paralegal } = pages, title = 'River Street invitation response';
    const published = await api(attorney.context(), 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Organize exhibits for the River Street filing.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    const review = await api(attorney.context(), 'get', `/api/cases/${caseId}/invitation-review/${actors.paralegal.id}?expectedOwnerId=${actors.attorney.id}`);
    await api(attorney.context(), 'post', `/api/cases/${caseId}/invite/${actors.paralegal.id}`, { expectedOwnerId: actors.attorney.id, reviewedRevision: review.revision });
    const mailBefore = server.evidence().external.mail.length;
    await paralegal.goto(`${server.origin}/${entry === 'v2' ? `paralegal-v2.html#/work?section=invitations&highlightCase=${caseId}` : `dashboard-paralegal.html?inviteCase=${caseId}#home`}`);
    const invitation = entry === 'v2' ? paralegal.locator(`[data-work-invite-id="${caseId}"]`) : paralegal.locator('#inviteOverlay [role="dialog"]');
    await expect(invitation).toBeVisible();
    const responsePromise = paralegal.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/cases/${caseId}/invite/${decision}`);
    if (decision === 'accept') await invitation.getByRole('button', { name: /^Accept invitation$/i }).click();
    else {
      await invitation.getByRole('button', { name: 'Decline', exact: true }).click();
      if (entry === 'v2') await paralegal.getByRole('dialog', { name: 'Decline this invitation?' }).getByRole('button', { name: 'Decline invitation', exact: true }).click();
    }
    expect((await responsePromise).status()).toBe(200);
    const queued = (await server.invitationNotices(caseId)).filter(row => row.kind !== 'sent');
    expect(queued).toHaveLength(decision === 'accept' ? 1 : 2);
    expect(queued.every(row => row.status === 'pending' && row.attempts === 0)).toBe(true);
    const notices = (await api(attorney.context(), 'get', '/api/notifications/')).filter(row => row.type === 'case_invite_response' && row.context.caseId === caseId);
    expect(notices).toHaveLength(1); const notice = notices[0];
    await attorney.goto(`${server.origin}/${entry === 'v2' ? 'attorney-v2.html#/home' : 'dashboard-attorney.html#home'}`);
    await attorney.getByRole('button', { name: /^View notifications/ }).click();
    const link = entry === 'v2' ? attorney.locator(`[data-notification-focus="open:${notice.id || notice._id}"]`) : attorney.locator(`.notif-item[data-id="${notice.id || notice._id}"] .notif-main`);
    await expect(link).toContainText(title);
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await attorney.setViewportSize({ width, height: 1000 });
      await attorney.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      await link.scrollIntoViewIfNeeded(); expect(await link.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await link.screenshot({ path: info.outputPath(`response-notice-${theme}-${width}.png`) });
    }
    await link.click();
    const applications = entry === 'v2' ? attorney.locator('[data-matter-applications]') : attorney.getByRole('tabpanel', { name: 'Applications', exact: true });
    await expect(applications).toBeVisible();
    if (entry === 'v2') await expect(applications).toHaveAttribute('data-state', 'ready');
    if (decision === 'accept') {
      await expect(applications).toContainText('River paralegal');
      if (entry === 'current') {
        const preview = attorney.getByRole('dialog', { name: 'River paralegal', exact: true });
        await expect(preview).toContainText('Accepted invitation'); await expect(preview).toContainText(title);
        await expect(preview.getByRole('link', { name: 'Open candidate review', exact: true })).toHaveAttribute('href', `/dashboard-attorney.html?caseId=${caseId}&applicantId=${actors.paralegal.id}&openApplicant=1#cases:inquiries`);
      }
      // Exercise the actual response writer without claiming new revoke-control coverage.
      await api(paralegal.context(), 'post', `/api/cases/${caseId}/invite/revoke`, {});
      expect((await server.invitationNotices(caseId)).filter(row => row.kind === 'revoked')).toHaveLength(2);
    }
    const self = (await api(paralegal.context(), 'get', '/api/notifications/')).find(row => row.type === 'case_invite_response' && row.context.caseId === caseId);
    expect(self.message).toContain(decision === 'accept' ? 'You withdrew from consideration' : 'You declined the invitation');
    expect(self.action).toEqual({ label: 'Browse Matters', href: '/browse-jobs.html' });
    await paralegal.goto(server.origin + self.action.href); await expect(paralegal.locator('body')).toContainText('Browse');
    const saved = await server.inspect(caseId); expect(saved.case.paralegalId).toBeFalsy(); expect(saved.payouts).toEqual([]); expect(saved.operations).toEqual([]);
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    await fs.writeFile(info.outputPath('invitation-response-evidence.json'), JSON.stringify({ entry, decision, caseId, queued, notice, self, immediateEmailCount: server.evidence().external.mail.length - mailBefore }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const [theme, width, fontSize] of [['light', 1366, 'md'], ['dark', 390, 'md'], ['dark', 390, 'lg']]) test(`saved ${theme} ${width} ${fontSize} preference keeps original withdrawal confirmation readable`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser, { preferences: { theme, fontSize } }); let caseId;
  try {
    const { attorney, paralegal } = pages;
    await paralegal.setViewportSize({ width, height: 844 });
    expect((await api(paralegal.context(), 'get', '/api/auth/me')).user.preferences).toMatchObject({ theme, fontSize });
    const published = await api(attorney.context(), 'post', '/api/cases', { title: 'River Street confirmation review', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence for attorney review.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    await api(paralegal.context(), 'post', `/api/jobs/${published.jobId}/apply`, { coverLetter: 'I can organize the River Street exhibits for review.' });
    await paralegal.goto(`${server.origin}/dashboard-paralegal.html?jobId=${published.jobId}#cases`);
    const details = paralegal.locator('#applicationDetailModal');
    await expect(details).toContainText('I can organize the River Street exhibits for review.');
    await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    const confirmation = paralegal.locator('#revokeConfirmModal');
    await expect(confirmation).toBeVisible();
    const authPreferences = (await api(paralegal.context(), 'get', '/api/auth/me')).user.preferences;
    const accountPreferences = (await api(paralegal.context(), 'get', '/api/users/me')).preferences;
    const computed = await confirmation.evaluate(element => {
      const describe = node => {
        const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
        const rules = [];
        const visit = (items, href) => { for (const rule of items) {
          if (rule.selectorText) { try { if (node.matches(rule.selectorText)) rules.push({ href, selector: rule.selectorText, css: rule.style.cssText }); } catch {} }
          if (rule.cssRules) visit(rule.cssRules, href);
        } };
        for (const sheet of document.styleSheets) { try { visit(sheet.cssRules, sheet.href || 'inline'); } catch {} }
        return { text: node.textContent.trim(), color: style.color, background: style.backgroundColor, border: style.borderColor, opacity: style.opacity, filter: style.filter, disabled: node.disabled, bounds: bounds.toJSON(), rules };
      };
      return { cachedTheme: window.getThemePreference?.(), storedPreferences: JSON.parse(localStorage.getItem('lpc_user') || '{}').preferences, root: document.documentElement.className, body: document.body.className, fontSize: getComputedStyle(document.documentElement).fontSize, card: describe(element.querySelector('.note-modal-card')), buttons: [...element.querySelectorAll('button')].map(describe) };
    });
    const AxeBuilder = require('@axe-core/playwright').default;
    const accessibility = await new AxeBuilder({ page: paralegal }).include('#revokeConfirmModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await fs.writeFile(info.outputPath('confirmation-theme-evidence.json'), JSON.stringify({ theme, width, fontSize, authPreferences, accountPreferences, computed, violations: accessibility.violations }, null, 2));
    await confirmation.screenshot({ path: info.outputPath('confirmation.png') });
    expect(authPreferences).toMatchObject({ theme, fontSize });
    await expect(paralegal.locator('html')).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
    await expect(paralegal.locator('body')).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
    expect(computed.fontSize).toBe(fontSize === 'lg' ? '20px' : '17px');
    expect(computed.card.bounds.x).toBeGreaterThanOrEqual(0); expect(computed.card.bounds.right).toBeLessThanOrEqual(width);
    expect(computed.card.bounds.y).toBeGreaterThanOrEqual(0); expect(computed.card.bounds.bottom).toBeLessThanOrEqual(844);
    for (const button of computed.buttons) { expect(button.disabled).toBe(false); expect(button.bounds.height).toBeGreaterThanOrEqual(44); }
    expect(accessibility.violations).toEqual([]);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirmation).toBeHidden();
    expect((await api(paralegal.context(), 'get', '/api/applications/my')).find(row => String(row.caseId) === caseId).status).toBe('submitted');
    expect((await server.applicationNotices(caseId)).filter(row => row.kind === 'withdrawn')).toEqual([]);
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const source of ['canonical', 'earlier']) for (const entry of ['v2', 'current']) test(`actual ${entry} ${source} application withdrawal retains the attorney notice and opens its saved application`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser); let caseId;
  try {
    const { attorney, paralegal } = pages, title = 'River Street application withdrawal';
    const published = await api(attorney.context(), 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence for attorney review.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    const coverLetter = 'I can organize the River Street exhibits.\n\nI will check the filing references with the attorney.', mailBefore = server.evidence().external.mail.length;
    if (source === 'canonical') await api(paralegal.context(), 'post', `/api/jobs/${published.jobId}/apply`, { coverLetter });
    else await server.seedEarlierApplication(caseId, actors.paralegal.id, coverLetter);
    await paralegal.goto(`${server.origin}/${entry === 'v2' ? `paralegal-v2.html#/work?jobId=${published.jobId}` : `dashboard-paralegal.html?jobId=${published.jobId}#cases`}`);
    const details = entry === 'v2' ? paralegal.getByRole('dialog', { name: title, exact: true }) : paralegal.locator('#applicationDetailModal');
    await expect(details).toBeVisible(); await expect(details).toContainText('I can organize the River Street exhibits.');
    await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    const confirmation = entry === 'v2' ? paralegal.getByRole('dialog', { name: 'Withdraw this application?', exact: true }) : paralegal.locator('#revokeConfirmModal');
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await paralegal.setViewportSize({ width, height: 1000 });
      await paralegal.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      await expect(confirmation).toBeVisible(); expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await confirmation.screenshot({ path: info.outputPath(`application-withdrawal-confirmation-${theme}-${width}.png`) });
    }
    const revokePath = source === 'earlier' ? `/api/applications/earlier/${caseId}/revoke` : '/api/applications/';
    const savedResponse = paralegal.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.startsWith(revokePath) && new URL(response.url()).pathname.endsWith('/revoke'));
    await confirmation.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    expect((await savedResponse).status()).toBe(200); await expect(confirmation).toBeHidden();
    const own = (await api(paralegal.context(), 'get', '/api/applications/my')).find(row => String(row.caseId) === caseId);
    expect(own).toMatchObject({ status: 'withdrawn', pending: false, coverLetter });
    const notices = await api(attorney.context(), 'get', '/api/notifications/');
    const notice = notices.find(row => row.context.caseId === caseId && row.message === `River withdrew their application for ${title}`);
    expect(notice.action).toEqual({ label: 'View application', href: `/dashboard-attorney.html?caseId=${caseId}&applicantId=${actors.paralegal.id}&openApplicant=1&applicationHistory=1#cases:inquiries` });
    const queued = (await server.applicationNotices(caseId)).filter(row => row.kind === 'withdrawn'); expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ source, status: 'pending', attempts: 0 });
    expect(String(queued[0].userId)).toBe(actors.attorney.id); expect(String(queued[0].paralegalId)).toBe(actors.paralegal.id);
    await attorney.goto(`${server.origin}/${entry === 'v2' ? 'attorney-v2.html#/home' : 'dashboard-attorney.html#home'}`);
    await attorney.getByRole('button', { name: /^View notifications/ }).click();
    const noticeId = notice.id || notice._id;
    const link = entry === 'v2' ? attorney.locator(`[data-notification-focus="open:${noticeId}"]`) : attorney.locator(`.notif-item[data-id="${noticeId}"] .notif-main`);
    const center = entry === 'v2' ? attorney.locator('[data-av2-panel="notifications"]') : attorney.locator('[data-notification-panel]:visible');
    await expect(link).toContainText(notice.message);
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await attorney.setViewportSize({ width, height: 1000 });
      await attorney.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      expect(await link.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await center.screenshot({ path: info.outputPath(`application-withdrawal-notice-${theme}-${width}.png`) });
    }
    await link.click();
    const panel = attorney.locator('[data-matter-applications]'); await expect(panel).toBeVisible(); await expect(panel).toHaveAttribute('data-state', 'ready');
    const selected = panel.locator('details').filter({ hasText: 'I can organize the River Street exhibits.' });
    await expect(selected).toHaveCount(1); await expect(selected).toHaveAttribute('open', '');
    await expect(selected.locator(':scope > summary')).toContainText('Withdrawn');
    await expect(selected).toContainText('I will check the filing references with the attorney.');
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await attorney.setViewportSize({ width, height: 1000 });
      await attorney.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } }, theme);
      await panel.scrollIntoViewIfNeeded(); expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await panel.screenshot({ path: info.outputPath(`application-withdrawal-history-${theme}-${width}.png`) });
    }
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    const saved = await server.inspect(caseId); expect(saved.case.status).toBe('open'); expect(saved.case.paralegalId).toBeFalsy(); expect(saved.operations).toEqual([]); expect(saved.payouts).toEqual([]);
    expect(server.provider.calls.filter(row => ['paymentIntents.create', 'transfers.create', 'refunds.create', 'forbidden_network'].includes(row.method))).toEqual([]);
    await fs.writeFile(info.outputPath('application-withdrawal-notice-evidence.json'), JSON.stringify({ source, entry, caseId, own, notice, queued, immediateEmailCount: server.evidence().external.mail.length - mailBefore }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const entry of ['v2', 'current']) test(`actual ${entry} pre-engagement notices open the selected requirements and response`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser, { publicProfile: true }); let caseId;
  try {
    const { attorney, paralegal } = pages, title = 'River Street pre-engagement notices';
    const published = await api(attorney.context(), 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Organize exhibits for the River Street filing.', tasks: [{ title: 'Prepare filing package' }] });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    await api(paralegal.context(), 'post', `/api/jobs/${published.jobId}/apply`, { coverLetter: 'I can organize exhibits and review the listed parties.' });
    const mailBefore = server.evidence().external.mail.length;
    const review = await api(attorney.context(), 'get', `/api/cases/${caseId}/pre-engagement/review/${actors.paralegal.id}?expectedOwnerId=${actors.attorney.id}`);
    await api(attorney.context(), 'post', `/api/cases/${caseId}/pre-engagement/${actors.paralegal.id}/request`, { expectedOwnerId: actors.attorney.id, reviewedRevision: review.revision, conflictsCheckRequired: true, conflictsDetails: 'Review the River Street client, opposing party and witnesses.' });
    async function openNotice(role, kind) {
      const page = pages[role], notices = await api(page.context(), 'get', '/api/notifications/');
      const notice = notices.find(row => row.type === `pre_engagement_${kind}` && row.context.caseId === caseId);
      expect(notice?.available).toBe(true);
      await page.goto(`${server.origin}/${entry === 'v2' ? `${role}-v2.html#/home` : `dashboard-${role}.html#home`}`);
      await page.getByRole('button', { name: /^View notifications/ }).click();
      const link = entry === 'v2' ? page.locator(`[data-notification-focus="open:${notice.id || notice._id}"]`) : page.locator(`.notif-item[data-id="${notice.id || notice._id}"] .notif-main`);
      await expect(link).toContainText(title); await link.click();
      return notice;
    }
    const requested = await openNotice('paralegal', 'requested');
    const application = entry === 'v2' ? paralegal.getByRole('dialog', { name: title, exact: true }) : paralegal.locator('#applicationDetailModal');
    await expect(application).toContainText('Review the River Street client, opposing party and witnesses.');
    await application.getByLabel('Disclose a possible conflict', { exact: true }).check();
    await application.getByLabel('Possible conflict details', { exact: true }).fill('I previously assisted with a related filing.');
    await application.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.preEngagement.status).toBe('submitted');
    const submitted = await openNotice('attorney', 'submitted');
    if (entry === 'current') {
      const preview = attorney.getByRole('dialog', { name: 'River paralegal', exact: true });
      await preview.getByRole('link', { name: 'Open candidate review', exact: true }).click();
      await attorney.locator('[data-hire-paralegal]').first().click();
    }
    await attorney.getByRole('button', { name: 'Review pre-engagement requirements', exact: true }).click();
    const pre = attorney.locator('[data-pre-engagement]');
    await expect(pre).toContainText('I previously assisted with a related filing.');
    await pre.getByRole('button', { name: 'Ask for response changes', exact: true }).click();
    await pre.getByRole('button', { name: 'Request response changes', exact: true }).click();
    await expect(pre).toContainText('Response changes requested');
    const changes = await openNotice('paralegal', 'changes_requested');
    await expect(application).toContainText('I previously assisted with a related filing.');
    await expect(application.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeVisible();
    for (const [width, theme] of [[1366, 'light'], [390, 'dark']]) {
      await paralegal.setViewportSize({ width, height: 1000 });
      await paralegal.evaluate(theme => { for (const el of [document.documentElement, document.body]) { el.classList.remove('theme-light', 'theme-dark'); el.classList.add(`theme-${theme}`); } }, theme);
      expect(await application.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await application.screenshot({ path: info.outputPath(`pre-engagement-${theme}-${width}.png`) });
    }
    // A direct email action uses the same protected original destination, independent of the shell adapter.
    await paralegal.goto(server.origin + changes.action.href);
    await expect(paralegal.locator('#applicationDetailModal')).toContainText('Review the River Street client, opposing party and witnesses.');
    const queued = await server.preEngagementNotices(caseId);
    expect(queued.map(row => row.kind)).toEqual(['requested', 'submitted', 'changes_requested']);
    expect(queued.every(row => row.status === 'pending' && row.attempts === 0)).toBe(true);
    expect(queued.map(row => String(row.userId))).toEqual([actors.paralegal.id, actors.attorney.id, actors.paralegal.id]);
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    const saved = await server.inspect(caseId); expect(saved.case.paralegalId).toBeFalsy(); expect(saved.operations).toEqual([]); expect(saved.payouts).toEqual([]);
    await fs.writeFile(info.outputPath('pre-engagement-notice-evidence.json'), JSON.stringify({ entry, caseId, requested, submitted, changes, queued }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, caseId, browserEvents, actors); }
});

for (const entry of ['v2', 'current']) test(`actual ${entry} posting notices preserve application, moderation and removed-posting destinations`, async ({ browser }, info) => {
  const { pages, actors, errors, browserEvents } = await roles(browser, { publicProfile: true }); let caseId, removed = false;
  try {
    const { attorney, paralegal, admin } = pages, title = 'River Street posting notice journey', revised = 'River Street revised filing scope';
    const fields = { title, practiceArea: 'immigration', state: 'CA', experience: '5+ years', deadline: '2027-03-14', description: 'Organize the filing package and its supporting exhibits.', tasks: [{ title: 'Prepare filing package' }] };
    let jobId;
    if (entry === 'v2') {
      const { draft } = await api(attorney.context(), 'post', '/api/case-drafts', { ...fields, compAmount: '400' });
      const { publication } = await api(attorney.context(), 'post', '/api/cases/posting/publications', { expectedOwnerId: actors.attorney.id, requestId: require('node:crypto').randomUUID(), draftId: draft.id, revision: draft.revision, practiceArea: 'immigration' });
      caseId = publication.caseId; jobId = String((await server.inspect(caseId)).case.jobId);
    } else {
      const posted = await api(attorney.context(), 'post', '/api/cases', { ...fields, totalAmount: 400 });
      caseId = String(posted.case?._id || posted.case?.id || posted._id || posted.id); jobId = String(posted.jobId);
    }
    await api(paralegal.context(), 'post', `/api/jobs/${jobId}/apply`, { coverLetter: 'I can organize the River Street exhibits and prepare the filing.' });
    const update = async changes => {
      if (entry === 'current') return api(attorney.context(), 'patch', `/api/cases/${caseId}`, changes);
      const { posting } = await api(attorney.context(), 'get', `/api/cases/posting/${caseId}`);
      return api(attorney.context(), 'patch', `/api/cases/posting/${caseId}`, { expectedOwnerId: actors.attorney.id, revision: posting.revision, changes });
    };
    await update({ title: revised });
    async function openNotice(role, label) {
      const page = pages[role], items = await api(page.context(), 'get', '/api/notifications/');
      const notice = items.find(row => row.action?.label === label && (row.context?.caseId === caseId || row.type === 'case_deleted'));
      expect(notice?.available).toBe(true);
      await page.goto(`${server.origin}/${entry === 'v2' ? `${role}-v2.html#/home` : `dashboard-${role}.html#home`}`);
      await page.getByRole('button', { name: /^View notifications/ }).click();
      const link = entry === 'v2' ? page.locator(`[data-notification-focus="open:${notice.id || notice._id}"]`) : page.locator(`.notif-item[data-id="${notice.id || notice._id}"] .notif-main`);
      await expect(link).toContainText(revised);
      await link.screenshot({ path: info.outputPath(`posting-notice-${role}-${label.replaceAll(' ', '-')}.png`) });
      await link.click(); return notice;
    }
    const updated = await openNotice('paralegal', 'View application');
    // The retained application preserves the scope/title as listed when applied.
    // The list and notification identify the current posting independently.
    const application = entry === 'v2' ? paralegal.getByRole('dialog', { name: title, exact: true }) : paralegal.locator('#applicationDetailModal');
    await expect(application).toContainText('I can organize the River Street exhibits and prepare the filing.');
    await api(admin.context(), 'post', `/api/cases/${caseId}/flags/request-edits`, { message: 'Identify the exhibits and the specific filing requested.' });
    const editRequest = await openNotice('attorney', 'Review requested revisions');
    if (entry === 'current') {
      const preview = attorney.locator('#casePreviewModal');
      await expect(preview).toBeVisible(); await expect(preview).toContainText(revised);
      await preview.getByRole('button', { name: 'Close Matter preview', exact: true }).click();
      await expect(preview).toBeHidden();
    } else await expect(attorney.getByText(revised, { exact: true }).first()).toBeVisible();
    const reviewBefore = await api(attorney.context(), 'get', `/api/cases/${caseId}/flags/review`); expect(reviewBefore.feedback).toBe('Identify the exhibits and the specific filing requested.');
    await update({ description: 'Organize exhibits A through D for the River Street filing package.' });
    const review = await api(attorney.context(), 'get', `/api/cases/${caseId}/flags/review`); expect(review.canRequestReview).toBe(true);
    await api(attorney.context(), 'post', `/api/cases/${caseId}/flags/mark-resolved`, { expectedOwnerId: actors.attorney.id, revision: review.revision, requestId: require('node:crypto').randomUUID() });
    const adminNotice = (await api(admin.context(), 'get', '/api/notifications/')).find(row => row.action?.label === 'Review posting');
    expect(adminNotice?.action.href).toBe('/admin-dashboard.html#posts'); expect(adminNotice.message).toContain(revised);
    const beforeRemoval = await server.inspect(caseId); expect(beforeRemoval.case.paralegalId).toBeFalsy(); expect(beforeRemoval.operations).toEqual([]); expect(beforeRemoval.payouts).toEqual([]);
    await api(admin.context(), 'delete', `/api/cases/${caseId}`, { expectedOwnerId: actors.admin.id, reason: 'Outside the permitted posting scope', message: 'Review the scope before posting again.' }); removed = true;
    const removal = await openNotice('attorney', 'View Matters'); expect(removal.context).toEqual({}); expect(removal.action.href).not.toContain(caseId);
    expect((await attorney.context().request.get(`${server.origin}/api/cases/${caseId}`)).status()).toBe(404);
    const queued = await server.postingNotices(caseId, actors.attorney.id);
    expect(queued.map(row => row.kind)).toEqual(['created', 'updated', 'edits_requested', 'updated', 'review_requested', 'deleted']);
    expect(queued.every(row => row.status === 'pending' && row.attempts === 0)).toBe(true); expect(server.evidence().external.mail).toEqual([]);
    await fs.writeFile(info.outputPath('posting-notice-evidence.json'), JSON.stringify({ entry, caseId, updated, editRequest, adminNotice, removal, queued, financialOperations: beforeRemoval.operations, payouts: beforeRemoval.payouts }, null, 2));
    expectCleanBrowser(errors, browserEvents, info, actors);
  } finally { await recordEnd(pages, errors, info, removed ? null : caseId, browserEvents, actors); }
});
