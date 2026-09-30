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
for (const [current, holdRefresh] of [[true, false], [false, false], [true, true]]) test(`${current ? 'current' : 'reviewed'} confirmed deletion removes the listing and application from both roles and retains publication recovery${holdRefresh ? ' while inventory refresh is pending' : ''}`, async ({ page, browser, baseURL }, testInfo) => {
  const title = `Synthetic deletion ${randomUUID()}`;
  const draft = (await api(page.request, 'post', '/api/case-drafts', { title, practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic posting deletion acceptance.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const receipt = (await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' })).publication;
  const id = receipt.caseId;
  await api(para, 'post', `/api/cases/${id}/apply`, { coverLetter: 'I can prepare the agreement and organize its supporting exhibits.' });
  const applications = await api(para, 'get', '/api/applications/my');
  const application = applications.find(value => String(value.jobId?.caseId?._id || value.jobId?.caseId) === id); expect(application).toBeTruthy();
  const applicationId = application._id || application.id, jobId = application.jobId._id || application.jobId.id;
  const paraContext = await browser.newContext({ baseURL, storageState: await para.storageState() });
  let releaseRefresh, refreshHeld = 0;
  try {
    const paraPage = await paraContext.newPage();
    await enterSecondaryDocument(paraPage, new URL('/paralegal-v2.html#/work?section=applications', baseURL).href, { waitUntil: 'commit' });
    const paraRow = () => paraPage.locator(`[data-work-application-id="${applicationId}"]`);
    await expect(paraRow()).toContainText(title);
    let deletes = 0; const deletePath = current ? `/api/cases/${id}` : `/api/cases/posting/${id}`;
    page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === deletePath) deletes++; });
    if (holdRefresh) {
      let deletionAcknowledged = false;
      const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
      page.on('response', response => { if (response.request().method() === 'DELETE' && new URL(response.url()).pathname === deletePath && response.status() === 200) deletionAcknowledged = true; });
      await page.route('**/api/cases/inventory?**', async route => { if (deletionAcknowledged) { refreshHeld++; await refreshGate; } await route.continue().catch(() => {}); });
    }
    // Each role is a separate browser window. Activate the one being used so
    // Firefox's first pointer action is not consumed by window activation.
    await page.bringToFront();
    if (current) {
      await page.goto('/dashboard-attorney.html#cases:inquiries', { waitUntil: 'commit' });
      const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
      await actions.locator('[data-case-menu-trigger]').click(); await actions.getByRole('button', { name: 'Delete Matter', exact: true }).click();
      const confirmation = page.getByRole('dialog', { name: 'Delete this Matter?', exact: true }); await expect(confirmation).toContainText(title);
      const deletionResponse = holdRefresh ? page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === deletePath) : null;
      await confirmation.getByRole('button', { name: 'Delete Matter', exact: true }).click();
      if (holdRefresh) {
        const acknowledgement = await deletionResponse; expect(acknowledgement.status()).toBe(200); expect((await acknowledgement.json()).ok).toBe(true);
        await expect.poll(() => refreshHeld).toBeGreaterThan(0);
      }
      await expect(page.locator('#toastBanner')).toContainText('Matter deleted.');
      releaseRefresh?.();
      await expect(page.locator('[data-table-body="inquiries"]')).toHaveAttribute('aria-busy', 'false');
      await expect(actions).toHaveCount(0);
    } else {
      await page.goto(`/attorney-v2.html#/matters/new?caseId=${id}`, { waitUntil: 'commit' });
      const status = page.getByRole('region', { name: 'Posting save status', exact: true }); await expect(status).toHaveAttribute('data-state', 'ready');
      await page.getByRole('button', { name: 'Delete posting', exact: true }).click(); await page.getByRole('button', { name: 'Delete posting permanently', exact: true }).click();
      await expect(status).toHaveAttribute('data-state', 'deleted'); await expect(status.getByRole('heading', { level: 1, name: 'Posting deleted', exact: true })).toBeVisible();
    }
    expect(deletes).toBe(1);
    expect((await page.request.get(`/api/cases/${id}`)).status()).toBe(404);
    expect((await api(page.request, 'get', '/api/jobs/my')).some(value => String(value._id) === jobId)).toBe(false);
    expect((await api(para, 'get', '/api/jobs/open')).some(value => String(value._id) === jobId)).toBe(false);
    expect((await api(para, 'get', '/api/applications/my')).some(value => String(value._id) === String(applicationId))).toBe(false);
    await paraPage.bringToFront(); await paraPage.reload({ waitUntil: 'commit' }); await expect(paraPage.getByRole('heading', { level: 1, name: 'My matters & applications' })).toBeVisible();
    await expect(paraPage.locator('[data-work-application-results]')).toBeVisible(); await expect(paraRow()).toHaveCount(0);
    await paraPage.screenshot({ path: testInfo.outputPath('paralegal-after-deletion.png'), fullPage: true });
    await page.bringToFront(); await page.goto(`/attorney-v2.html#/matters/new?draftId=${draft.id}`, { waitUntil: 'commit' });
    await expect(page.getByRole('region', { name: 'Publication status', exact: true })).toContainText('Matter removed'); expect(deletes).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('attorney-retained-publication.png'), fullPage: true });
  } finally { releaseRefresh?.(); await paraContext.close(); }
});
