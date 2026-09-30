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
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

for (const entry of ['v2', 'current']) test(`actual ${entry} publishing, application, reviewed hire and completion agree in all three role browsers`, async ({ browser }, info) => {
  const contexts = [], pages = {}, actors = {}, errors = [], browserEvents = [];
  try {
    for (const role of ['attorney', 'paralegal', 'admin']) {
      actors[role] = await server.createUser(role);
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); contexts.push(context);
      context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
      await context.addCookies([actors[role].cookie]);
      // Distinguish document failures from native browser diagnostics during departure.
      // This observes lifecycle events without changing requests or filtering page errors.
      await context.addInitScript(() => {
        const documentId = crypto.randomUUID();
        const report = (type, detail = {}) => console.debug('LPC_LIFECYCLE_DIAGNOSTIC ' + JSON.stringify({
          documentId, type, page: location.href, at: Date.now(), visibility: document.visibilityState, ...detail,
        }));
        for (const type of ['beforeunload', 'pagehide', 'pageshow']) addEventListener(type, event => report(type, { persisted: event.persisted }));
        addEventListener('error', event => report('windowerror', { message: event.message, filename: event.filename, stack: event.error?.stack }));
        addEventListener('unhandledrejection', event => report('unhandledrejection', { message: String(event.reason), stack: event.reason?.stack }));
      });
      // Only external assets are blocked. Every application request reaches its route.
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage(); pages[role] = page;
      page.on('console', message => {
        const prefix = 'LPC_LIFECYCLE_DIAGNOSTIC ';
        if (message.text().startsWith(prefix)) browserEvents.push({ role, ...JSON.parse(message.text().slice(prefix.length)) });
      });
      page.on('pageerror', error => errors.push({ role, name: error.name, message: error.message, stack: error.stack, page: page.url(), at: Date.now() }));
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) browserEvents.push({ role, type: 'navigation', page: frame.url(), at: Date.now() }); });
      page.on('requestfailed', request => { if (request.url().startsWith(server.origin + '/api/')) browserEvents.push({ role, type: 'requestfailed', url: request.url(), error: request.failure()?.errorText, page: page.url(), at: Date.now() }); });
      page.on('response', response => { if (response.url().startsWith(server.origin + '/api/notifications')) browserEvents.push({ role, type: 'notification-response', url: response.url(), status: response.status(), page: page.url(), at: Date.now() }); });
    }
    const { attorney, paralegal, admin } = pages;
    const drafted = await api(attorney.context(), 'post', '/api/case-drafts', { expectedOwnerId: actors.attorney.id, title: 'River Street filing', practiceArea: 'immigration', state: 'CA', compAmount: '400', experience: '5+ years', deadline: '2027-03-14', description: 'Prepare a filing package and organize supporting evidence for attorney review.', tasks: [{ title: 'Prepare filing package' }] });
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/new?draftId=${drafted.draft.id}&step=review`);
    const publication = attorney.getByRole('region', { name: 'Publication status', exact: true });
    const reviewPublication = attorney.getByRole('button', { name: 'Review publishing confirmation', exact: true });
    await expect(reviewPublication).toBeEnabled();
    await reviewPublication.click();
    await expect(publication).toHaveAttribute('data-state', 'ready');
    await attorney.getByRole('button', { name: 'Confirm and publish Matter', exact: true }).click();
    await expect(publication).toHaveAttribute('data-state', 'complete');
    console.log('Lifecycle checkpoint: published');
    const receipt = await api(attorney.context(), 'get', `/api/cases/posting/drafts/${drafted.draft.id}`);
    const caseId = receipt.publication.caseId;
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/browse`);
    await paralegal.getByRole('button', { name: 'Apply', exact: true }).first().click();
    const application = paralegal.getByRole('dialog', { name: 'Apply to River Street filing' });
    await application.getByLabel('Cover letter', { exact: true }).fill('I can prepare the filing package and organize supporting evidence for your review.');
    await application.getByRole('button', { name: 'Submit application', exact: true }).click();
    await expect(application).toHaveCount(0);
    console.log('Lifecycle checkpoint: applied');
    // External card collection is synthetic; saving it still uses the actual authenticated route.
    await api(attorney.context(), 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    if (entry === 'current') {
      await attorney.goto(`${server.origin}/dashboard-attorney.html#cases:inquiries`);
      await attorney.locator(`.matter-queue-row[data-case-id="${caseId}"]:visible`).getByRole('button', { name: 'Review 1 applicant', exact: true }).click();
      await attorney.locator(`[data-applicants-drawer][data-case-id="${caseId}"] [data-hire-paralegal]`).click();
      const modal = attorney.locator('#caseNoteModal');
      await expect(modal.locator('[data-hiring]')).toHaveAttribute('data-state', 'ready');
      await modal.getByRole('button', { name: 'Review pre-engagement requirements', exact: true }).click();
      const pre = modal.locator('[data-pre-engagement]');
      await expect(pre).toHaveAttribute('data-state', 'ready');
      await pre.getByLabel('Require conflicts check', { exact: true }).check();
      await pre.getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Synthetic River Street client and opposing party.');
      await pre.getByRole('button', { name: 'Review requirements before sending', exact: true }).click();
      await pre.getByRole('button', { name: 'Send requirements', exact: true }).click();
      await expect(pre).toContainText('Pre-engagement requirements sent.');
      const applications = await api(paralegal.context(), 'get', '/api/applications/my');
      const selected = applications.find(value => String(value.caseId?._id || value.caseId) === caseId);
      expect(selected).toBeDefined();
      for (const response of ['Possible earlier connection.', 'The earlier engagement ended two years ago.']) {
        const legacy = response === 'Possible earlier connection.';
        await paralegal.goto(`${server.origin}/${legacy ? `dashboard-paralegal.html?applicationId=${selected._id}#cases` : `paralegal-v2.html#/work?applicationId=${selected._id}`}`);
        const request = legacy ? paralegal.locator('#applicationDetailModal') : paralegal.getByRole('dialog', { name: 'River Street filing', exact: true });
        await request.getByLabel('Disclose a possible conflict', { exact: true }).check();
        await request.getByLabel('Possible conflict details', { exact: true }).fill(response);
        if (legacy) {
          await pre.locator('[data-preengagement-editor] > summary').click();
          await pre.getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Synthetic River Street client, opposing party and newly added witness.');
          await pre.getByRole('button', { name: 'Review requirements before sending', exact: true }).click();
          await pre.getByRole('button', { name: 'Send requirements', exact: true }).click();
          await expect(pre).toContainText('Pre-engagement requirements sent.');
          await request.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
          await expect(request).toContainText('The requirements changed since you opened them.');
          await expect(request.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
          expect((await server.inspect(caseId)).case.preEngagement.status).toBe('requested');
          await request.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
          await expect(request).toContainText('newly added witness');
          await request.getByLabel('Disclose a possible conflict', { exact: true }).check();
          await expect(request.getByLabel('Possible conflict details', { exact: true })).toHaveValue(response);
        }
        await paralegal.screenshot({ path: info.outputPath(`paralegal-${legacy ? 'current' : 'v2'}-requirements.png`) });
        if (legacy) await paralegal.route(`**/api/cases/${caseId}/pre-engagement/respond`, async route => {
          const result = await route.fetch(); expect(result.status()).toBe(200);
          // The real writer ran, but its confirmation body was interrupted.
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await request.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
        if (legacy) {
          await expect(request).toContainText('Submission could not be confirmed.');
          await request.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
          await expect(request.locator('[data-preengagement-submit]')).toHaveCount(0);
          await paralegal.unroute(`**/api/cases/${caseId}/pre-engagement/respond`);
        }
        else await expect(request).toHaveCount(0);
        await pre.getByRole('button', { name: 'Refresh saved requirements', exact: true }).click();
        await expect(pre).toContainText(response);
        if (response === 'Possible earlier connection.') {
          await pre.getByRole('button', { name: 'Ask for response changes', exact: true }).click();
          await pre.getByRole('button', { name: 'Request response changes', exact: true }).click();
          await expect(pre).toContainText('Response changes requested');
        }
      }
      await pre.getByRole('button', { name: 'Approve pre-engagement response', exact: true }).click();
      await pre.getByRole('button', { name: 'Confirm pre-engagement approval', exact: true }).click();
      await expect(pre).toContainText('Pre-engagement response approved.');
      expect(server.provider.calls.filter(row => row.method === 'paymentIntents.create')).toEqual([]);
      await pre.getByRole('button', { name: 'Continue to hiring review', exact: true }).click();
    } else {
      await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/applications?applicantId=${actors.paralegal.id}`);
      await attorney.locator('[data-hiring]').getByRole('button', { name: 'Review hiring and funding', exact: true }).click();
    }
    const hiring = attorney.locator('[data-hiring]');
    await expect(hiring).toHaveAttribute('data-state', 'ready');
    await expect(hiring).toContainText('Total card charge: $488.00');
    await hiring.getByRole('button', { name: 'Review hiring confirmation', exact: true }).click();
    await hiring.getByRole('button', { name: 'Hire and charge $488.00', exact: true }).click();
    await expect.poll(async () => (await server.inspect(caseId)).case.status).toBe('in progress');
    await expect(hiring).toContainText("This paralegal is assigned, and the Matter's funding is verified.");
    if (entry === 'current') await expect(attorney.locator('[data-application-parent-status]')).toBeHidden();
    console.log('Lifecycle checkpoint: hired and funded');
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/home?view=history`);
    await expect(paralegal.locator('[data-payout-totals] .pf-estimates')).toContainText('$328.00');
    await inspectPayoutLayout(paralegal, info, 'expected');
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/work`);
    const workItem = attorney.locator('[data-workspace-work]').getByRole('checkbox', { name: 'Prepare filing package' });
    await workItem.click();
    await expect(workItem).toBeChecked();
    await expect.poll(async () => (await server.inspect(caseId)).case.tasks[0].completed).toBe(true);
    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/financials`);
    const completion = attorney.locator('[data-workspace-completion]');
    await expect(completion).toHaveAttribute('data-state', 'ready');
    if (entry === 'v2') await inspectFinancialLayout(attorney, info, 'ready');
    await completion.getByRole('button', { name: 'Review completion', exact: true }).click();
    const mailBeforeCompletion = server.evidence().external.mail.length;
    // Payment release is an intermediate record: completion still finalizes its
    // archive, receipts and notices before acknowledging this same request.
    // Use the existing UI operation deadline, then retain the normal UI checks.
    const [completedResponse] = await Promise.all([
      attorney.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/cases/${caseId}/complete`, { timeout: 120000 }),
      completion.getByRole('button', { name: 'Complete Matter and release $328.00', exact: true }).click(),
    ]);
    expect(completedResponse.status()).toBe(200);
    expect(await completedResponse.json()).toMatchObject({ ok: true, completionRecorded: true, requestId: completedResponse.request().postDataJSON().requestId });
    await expect.poll(async () => (await server.inspect(caseId)).case.paymentReleased).toBe(true);
    await expect(completion).toContainText('Payout recorded.');
    console.log('Lifecycle checkpoint: completed and paid');
    const completionNotices = await server.completionNotices(caseId);
    expect(completionNotices).toHaveLength(2);
    expect(completionNotices.map(item => String(item.userId)).sort()).toEqual([actors.attorney.id, actors.paralegal.id].sort());
    for (const item of completionNotices) expect(item).toMatchObject({ status: 'pending', attempts: 0 });
    expect(server.evidence().external.mail.length).toBe(mailBeforeCompletion);
    const completionActions = [];
    for (const page of [attorney, paralegal]) {
      const items = await api(page.context(), 'get', '/api/notifications/');
      const message = page === attorney ? 'River Street filing: Matter completed and archived.' : 'Payout released for River Street filing';
      const item = items.find(row => row.message === message);
      expect(item?.action.href).toBe(page === attorney ? `/case-detail.html?caseId=${caseId}&tab=financials` : `/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`);
      completionActions.push(item.action);
    }
    await fs.writeFile(info.outputPath('completion-notice-evidence.json'), JSON.stringify({ notices: completionNotices, actions: completionActions, immediateEmails: server.evidence().external.mail.length - mailBeforeCompletion }, null, 2));

    await expect(completion).not.toContainText('0 documents:');
    await expect(completion).not.toContainText('agreed work items complete.');
    await expect(attorney.locator('[data-workspace-disputes]').getByRole('textbox', { name: 'Dispute details', exact: true })).toHaveCount(0);
    await expect(attorney.locator('[data-workspace-disputes]')).not.toContainText('The dispute discussion or decision changed.');
    await expect(attorney.locator('.av2-financial-status-row')).toContainText(/archived|closed to further work|completed/i);
    await expect(attorney.locator('.av2-financial-status-row')).not.toContainText('This Matter has changed.');
    await expect(attorney.locator('[data-matter-workspace]').getByRole('link', { name: 'Download Matter archive', exact: true })).toHaveCount(1);
    const paymentReceipt = attorney.locator('[data-matter-receipt]'), receiptDetails = paymentReceipt.locator('.av2-financial-receipt-details');
    await expect(paymentReceipt).toHaveAttribute('data-state', 'ready');
    await receiptDetails.locator('summary').focus(); await attorney.keyboard.press('Enter');
    await expect(receiptDetails).toHaveAttribute('open', '');
    await expect(receiptDetails.locator('.matter-receipt-details')).toContainText('$488.00');
    await paymentReceipt.getByRole('button', { name: 'Refresh receipt', exact: true }).click();
    await expect(paymentReceipt).toHaveAttribute('data-state', 'ready');
    await expect(receiptDetails).toHaveAttribute('open', '');
    await receiptDetails.locator('summary').focus(); await attorney.keyboard.press('Enter');
    await expect(receiptDetails).not.toHaveAttribute('open', '');
    if (entry === 'v2') await inspectFinancialLayout(attorney, info, 'completed');
    await attorney.screenshot({ path: info.outputPath('attorney-completed-financials.png'), fullPage: true });
    await fs.writeFile(info.outputPath('attorney-completed-financials.txt'), await attorney.locator('[data-matter-workspace]').innerText());
    await attorney.getByRole('button', { name: /^View notifications/ }).click();
    const completionCenter = attorney.locator('#av2-notifications');
    await expect(completionCenter.getByText('River Street filing: Matter completed and archived.', { exact: true })).toBeVisible();
    await expect(completionCenter.getByRole('link', { name: /^River Street filing: Matter completed and archived\./ })).toHaveAttribute('href', `/attorney-v2.html#/matters/${caseId}/financials`);
    await attorney.screenshot({ path: info.outputPath('completion-notifications-desktop.png') });
    await attorney.keyboard.press('Escape'); await expect(completionCenter).toBeHidden();

    await attorney.locator('[data-matter-workspace]').getByRole('button', { name: 'Refresh Matter', exact: true }).click();
    await expect(completion).toHaveAttribute('data-state', 'ready');
    await expect(attorney.locator('[data-matter-workspace]').getByRole('button', { name: 'Refresh Matter', exact: true })).toBeEnabled();
    await expect(attorney.locator('[data-matter-workspace]').getByRole('link', { name: 'Download Matter archive', exact: true })).toHaveCount(1);
    await expect(attorney.locator('[data-workspace-disputes]').getByRole('textbox', { name: 'Dispute details', exact: true })).toHaveCount(0);
    for (const [name, selector] of [['completion', '[data-workspace-completion]'], ['disputes', '[data-workspace-disputes]']]) {
      await attorney.locator(selector).scrollIntoViewIfNeeded();
      await attorney.screenshot({ path: info.outputPath(`attorney-retained-${name}.png`) });
    }
    await attorney.screenshot({ path: info.outputPath('attorney-retained-financials.png'), fullPage: true });
    await fs.writeFile(info.outputPath('attorney-retained-financials.txt'), await attorney.locator('[data-matter-workspace]').innerText());
    await attorney.goto(`${server.origin}/attorney-v2.html#/payments`);
    const attorneyHistory = attorney.locator('[data-financial-history]');
    await expect(attorneyHistory).toHaveAttribute('data-state', 'ready');
    await expect(attorneyHistory.locator('dl')).toContainText('$488.00');
    await expect(attorneyHistory.locator('dl')).toContainText('$328.00');
    const csvPending = attorney.waitForEvent('download');
    await attorneyHistory.getByRole('button', { name: 'Download CSV', exact: true }).click();
    const csv = await csvPending; await csv.saveAs(info.outputPath('actual-attorney-history.csv'));
    const csvText = await fs.readFile(info.outputPath('actual-attorney-history.csv'), 'utf8');
    expect(csvText).toContain('"USD","488.00","Original payment before refunds"');
    expect(csvText).toContain('"USD","328.00","Net amount in payout record"');
    expect(csvText).toContain('River Street filing');
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/work?section=history`);
    const history = paralegal.locator('#v2-work-history');
    await expect(history).toContainText('River Street filing'); await expect(history).toContainText('$328.00');
    const downloadPending = paralegal.waitForEvent('download');
    await history.locator('[data-payout-receipt]').click();
    const download = await downloadPending, pdfPath = info.outputPath('actual-completion-receipt.pdf'); await download.saveAs(pdfPath);
    const bytes = await fs.readFile(pdfPath); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.length).toBeGreaterThan(1000);
    console.log('Lifecycle checkpoint: actual payout PDF downloaded');
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/home?view=history`);
    await expect(paralegal.locator('[data-payout-totals]')).toContainText('$328.00');
    await inspectPayoutLayout(paralegal, info, 'paid');
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/work?section=history`);
    await expect(history).toContainText('$328.00');
    await admin.goto(`${server.origin}/admin-dashboard.html`);
    await admin.locator('[data-section="finance"]').click(); await admin.locator('[data-finance-view="reporting"]').click();
    await expect(admin.locator('#fundsReleasedValue')).toHaveText('$328.00');
    await expect(admin.locator('#revenueTotalValue')).toHaveText('$160.00');
    await expect(admin.locator('#receiptsBody')).toContainText('River Street filing');
    const final = await server.inspect(caseId);
    expect(final.case.status).toBe('completed'); expect(final.payouts).toHaveLength(1);
    expect(final.operations.filter(row => row.kind === 'funding')).toHaveLength(1);
    expect(server.provider.calls.filter(row => row.method === 'paymentIntents.create')).toHaveLength(1);
    expect(server.provider.calls.filter(row => row.method === 'transfers.create')).toHaveLength(1);
    expect(server.provider.calls.filter(row => row.method === 'forbidden_network')).toEqual([]);
    const diagnostics = inspectBrowserDiagnostics({ engine: info.project.name, origin: server.origin, paralegalOwnerId: actors.paralegal.id, errors, events: browserEvents });
    expect(diagnostics.documentFailures).toEqual([]);
    expect(diagnostics.unexplainedPageErrors).toEqual([]);
    for (const [role, page] of Object.entries(pages)) await page.screenshot({ path: info.outputPath(`${role}-final.png`) });
    for (const [role, page, panel] of [['attorney', attorney, attorneyHistory], ['paralegal', paralegal, history], ['admin', admin, admin.locator('#adminFinanceRecordList')]]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light'); element.classList.add('theme-dark'); }
        document.documentElement.style.fontSize = '20px';
      });
      if (role === 'admin') await expect.poll(async () => page.locator('#sidebarNav').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
      await panel.scrollIntoViewIfNeeded();
      const layout = await panel.evaluate(element => {
        const box = el => { const r = el.getBoundingClientRect(), css = getComputedStyle(el); return { tag: el.tagName, id: el.id, className: String(el.className), x: r.x, y: r.y, width: r.width, height: r.height, scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: css.overflowX, transform: css.transform, position: css.position, marginLeft: css.marginLeft }; };
        const ancestors = []; for (let current = element; current; current = current.parentElement) ancestors.push(box(current));
        return { scrollX, scrollY, innerWidth, innerHeight, ancestors, sidebars: [...document.querySelectorAll('aside, .sidebar')].map(box) };
      });
      await fs.writeFile(info.outputPath(`${role}-mobile-layout.json`), JSON.stringify(layout, null, 2));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${role}-mobile-dark-large.png`), animations: 'disabled' });
    }
    await fs.writeFile(info.outputPath('writer-evidence.json'), JSON.stringify({ requests: server.evidence().requests, caseId, status: final.case.status, payoutCount: final.payouts.length, originalFunding: final.operations.find(row => row.kind === 'funding').grossAmount }, null, 2));
  } finally {
    const browserDiagnostics = inspectBrowserDiagnostics({ engine: info.project.name, origin: server.origin, paralegalOwnerId: actors.paralegal?.id, errors, events: browserEvents });
    await fs.writeFile(info.outputPath('request-evidence.json'), JSON.stringify({ requests: server.evidence().requests, assets: server.evidence().assets, browserEvents, errors, browserDiagnostics }, null, 2));
    for (const [role, page] of Object.entries(pages)) await page.screenshot({ path: info.outputPath(`${role}-last.png`) }).catch(() => {});
    for (const context of contexts) await context.close();
  }
});
