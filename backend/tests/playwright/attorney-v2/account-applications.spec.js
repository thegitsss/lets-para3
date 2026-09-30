const { test, expect } = require('../support-session-fixture');
const { enterSecondaryDocument } = require('../secondary-document-entry');
const { randomUUID } = require('crypto');
let para;
async function api(client, method, path, data) {
  const csrf = await (await client.get('/api/csrf')).json(), user = (await (await client.get('/api/auth/me')).json()).user;
  const response = await client[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
test.beforeAll(async ({ playwright, baseURL }) => {
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { 'x-ai-control-room-e2e-secret': process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post('/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal', { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await para.get('/api/csrf')).json();
  const login = await para.post('/api/auth/login', { headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || 'ControlRoomSupport123!' } }); expect(login.ok(), await login.text()).toBeTruthy();
});
test.afterAll(async () => para?.dispose());
test('actual application and withdrawal agree across both Home views, counts and retained history', async ({ page, browser, baseURL }, info) => {
  // This cross-role journey includes publication, application, withdrawal,
  // two independent agreement reads, four Home visits and retained-history
  // focus checks. Keep each assertion's existing deadline while allowing
  // the complete sequence to finish against a populated account.
  test.setTimeout(90_000);
  const title = `Synthetic application agreement ${randomUUID()}`;
  const draft = (await api(page.request, 'post', '/api/case-drafts', { title, practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic application agreement acceptance.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const publication = (await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' })).publication;
  await api(para, 'post', `/api/cases/${publication.caseId}/apply`, { coverLetter: 'I can prepare the agreement and organize its supporting exhibits.' });
  let own = await api(para, 'get', '/api/applications/my');
  const application = own.find(row => row.caseId === publication.caseId); expect(application.pending).toBe(true);
  const applicationId = String(application._id);
  async function agreement(pending) {
    own = await api(para, 'get', '/api/applications/my');
    const received = await api(page.request, 'get', '/api/applications/my-postings');
    const attorney = await api(page.request, 'get', '/api/attorney/dashboard');
    const paralegal = await api(para, 'get', '/api/paralegal/dashboard');
    expect(own.find(row => String(row._id) === applicationId).pending).toBe(pending);
    expect(received.some(row => row.id === applicationId)).toBe(pending);
    expect(attorney.metrics.pendingApplications).toBe(received.length);
    expect(paralegal.metrics.pendingApplications).toBe(own.filter(row => row.pending).length);
  }
  await agreement(true);
  const context = await browser.newContext({ baseURL, storageState: await para.storageState() });
  try {
    const paraPage = await context.newPage();
    await paraPage.addInitScript(() => {
      window.__applicationFocus = [];
      const describe = el => ({ tag: el?.tagName || '', id: el?.id || '', className: typeof el?.className === 'string' ? el.className : '', label: el?.getAttribute?.('aria-label') || '', connected: el?.isConnected === true });
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) { window.__applicationFocus.push({ kind: 'requested', ...describe(this) }); return focus.apply(this, args); };
      document.addEventListener('focusin', event => window.__applicationFocus.push({ kind: 'entered', ...describe(event.target) }), true);
    });
    await enterSecondaryDocument(paraPage, new URL('/paralegal-v2.html#/home?view=applications', baseURL).href, { waitUntil: 'commit' });
    await expect(paraPage.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false');
    await expect(paraPage.locator(`[data-home-application-id="${applicationId}"]`)).toContainText(title);
    await paraPage.screenshot({ path: info.outputPath('paralegal-pending.png'), fullPage: true });
    await page.bringToFront(); await page.goto('/attorney-v2.html#/home', { waitUntil: 'commit' });
    const applications = page.getByRole('region', { name: 'Applications', exact: true });
    await expect(applications).toHaveAttribute('data-state', 'ready');
    await expect(applications).toContainText(title);
    await applications.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('attorney-pending.png'), fullPage: true });
    await paraPage.bringToFront(); await paraPage.goto(`/paralegal-v2.html#/work?applicationId=${applicationId}`, { waitUntil: 'commit' });
    await paraPage.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    await paraPage.getByRole('dialog', { name: 'Withdraw this application?', exact: true }).getByRole('button', { name: 'Withdraw application', exact: true }).click();
    await expect(paraPage.locator('[data-v2-toast-region]')).toContainText('Application withdrawn.');
    await agreement(false);
    const retained = own.find(row => String(row._id) === applicationId); expect(retained.status).toBe('withdrawn'); expect(retained.jobId.title).toBe(title);
    const retainedRow = paraPage.locator(`[data-work-application-id="${applicationId}"]`);
    await expect(retainedRow).toBeVisible();
    await expect(retainedRow).toContainText('Withdrawn');
    try { await expect(retainedRow.getByRole('button', { name: 'Details', exact: true })).toBeFocused(); }
    catch (error) {
      await info.attach('application-focus', { contentType: 'application/json', body: Buffer.from(JSON.stringify(await paraPage.evaluate(() => ({ events: window.__applicationFocus, active: { tag: document.activeElement?.tagName, id: document.activeElement?.id, className: document.activeElement?.className } })))) });
      throw error;
    }
    await expect(paraPage).toHaveURL(/section=applications/);
    await paraPage.screenshot({ path: info.outputPath('paralegal-retained-withdrawal.png'), fullPage: true });
    let releaseRead, requested = false;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    await paraPage.route('**/api/applications/my', async route => { requested = true; await gate; await route.continue(); });
    await paraPage.evaluate(id => {
      window.__applicationRowBeforeRefresh = document.querySelector(`[data-work-application-id="${id}"]`);
      window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'application-focus-acceptance' } }));
    }, applicationId);
    await expect.poll(() => requested).toBe(true);
    const navigation = paraPage.getByRole('link', { name: 'Help', exact: true });
    try {
      await navigation.focus(); releaseRead();
      await expect.poll(() => paraPage.evaluate(() => window.__applicationRowBeforeRefresh?.isConnected)).toBe(false);
      await expect(navigation).toBeFocused();
    } finally { releaseRead(); await paraPage.unroute('**/api/applications/my'); }
    // This programmatic route return must not leave the prior confirmation
    // pointer hovering a Home record and deliberately deferring its late paint.
    await paraPage.mouse.move(0, 0);
    await paraPage.goto('/paralegal-v2.html#/home?view=applications', { waitUntil: 'commit' });
    await expect(paraPage.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false');
    await expect(paraPage.locator(`[data-home-application-id="${applicationId}"]`)).toHaveCount(0);
    await page.bringToFront(); await page.reload({ waitUntil: 'commit' });
    await expect(applications).toHaveAttribute('data-state', 'ready');
    await expect(applications).not.toContainText(title);
    await applications.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('attorney-after-withdrawal.png'), fullPage: true });
  } finally { await context.close(); }
});
