const { test, expect } = require('playwright/test');
const { MongoClient, ObjectId } = require('mongoose').mongo;
const { randomUUID } = require('node:crypto');
let para, paraId, admin;
async function api(client, method, path, data) {
  const csrf = await (await client.get('/api/csrf')).json(), user = (await (await client.get('/api/auth/me')).json()).user;
  const response = await client[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
test.beforeAll(async ({ playwright, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:5888');
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { 'x-ai-control-room-e2e-secret': process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post('/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal', { headers }); expect(bootstrap.ok()).toBeTruthy();
  const payload = await bootstrap.json(), csrf = await (await para.get('/api/csrf')).json();
  const login = await para.post('/api/auth/login', { headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || 'ControlRoomSupport123!' } }); expect(login.ok()).toBeTruthy();
  const user = (await (await para.get('/api/auth/me')).json()).user; paraId = user.id || user._id;
  admin = await playwright.request.newContext({ baseURL });
  const adminBootstrap = await admin.post('/api/admin/ai-control-room/dev/e2e/bootstrap-admin', { headers }); expect(adminBootstrap.ok()).toBeTruthy();
  const adminPayload = await adminBootstrap.json(), adminCsrf = await (await admin.get('/api/csrf')).json();
  const adminLogin = await admin.post('/api/auth/login', { headers: { 'X-CSRF-Token': adminCsrf.csrfToken }, data: { email: adminPayload.admin.email, password: process.env.CONTROL_ROOM_E2E_ADMIN_PASSWORD || 'ControlRoomHarness123!' } }); expect(adminLogin.ok()).toBeTruthy();
});
test.afterAll(async () => { await para?.dispose(); await admin?.dispose(); });
async function fixture(page) {
  const title = `Synthetic legacy application ${randomUUID()}`;
  const draft = (await api(page.request, 'post', '/api/case-drafts', { title, practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic legacy application verification.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const { publication } = await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' });
  await api(para, 'post', `/api/cases/${publication.caseId}/apply`, { coverLetter: 'Preserve this submitted letter while reviewing the earlier record.' });
  const own = await api(para, 'get', '/api/applications/my'), application = own.find(row => row.caseId === publication.caseId), applicationId = String(application._id);
  // Only this dedicated localhost replica is accessible to the raw fixture.
  // Publish/apply through real APIs first, then alter this exact synthetic record.
  const client = new MongoClient('mongodb://127.0.0.1:5889/control-room-playwright?directConnection=true', { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect(); const db = client.db('control-room-playwright');
    const record = await db.collection('applications').findOne({ _id: new ObjectId(applicationId) });
    const matter = await db.collection('cases').findOne({ _id: new ObjectId(publication.caseId), title });
    expect(String(record.paralegalId)).toBe(paraId); expect(matter.title).toBe(title);
    const job = await db.collection('jobs').findOne({ _id: record.jobId, caseId: matter._id }); expect(job.title).toBe(title);
    const upper = value => String(value).toUpperCase();
    await db.collection('cases').updateOne({ _id: matter._id, title }, { $set: { attorney: upper(matter.attorney), jobId: upper(job._id), 'applicants.0.paralegalId': upper(paraId), 'applicants.0.starredBy': [upper(job.attorneyId)] } });
    await db.collection('jobs').updateOne({ _id: job._id, title }, { $set: { attorneyId: upper(job.attorneyId), caseId: upper(matter._id) } });
    await db.collection('applications').deleteOne({ _id: record._id });
    await db.collection('applications').insertOne({ ...record, _id: upper(record._id), jobId: upper(job._id), paralegalId: upper(paraId), starredBy: [upper(job.attorneyId)] });
  } finally { await client.close(); }
  return { caseId: publication.caseId, applicationId, title };
}
async function assertCounts(client, data, expected) {
  for (const [reader, path] of [[client, '/api/cases/my'], [client, '/api/cases/my-active'], [client, '/api/cases/posted'], [admin, '/api/cases/admin'], [admin, '/api/cases/posted']]) {
    const payload = await api(reader, 'get', path), rows = Array.isArray(payload) ? payload : payload.items || payload.cases;
    expect(rows.find(row => String(row.id || row._id).toLowerCase() === data.caseId), path).toMatchObject({ applicantsCount: expected });
  }
  const user = (await (await client.get('/api/auth/me')).json()).user;
  const inventory = await api(client, 'get', `/api/cases/inventory?expectedOwnerId=${user.id || user._id}&view=${expected ? 'applications' : 'active'}&q=${encodeURIComponent(data.title)}`);
  expect(inventory.items).toHaveLength(1); expect(inventory.items[0]).toMatchObject({ id: data.caseId, applicantsCount: expected });
}
for (const current of [false, true]) test(`${current ? 'current' : 'V2'} selects the raw account application and records its exact reviewed decision`, async ({ page }, info) => {
  const data = await fixture(page), account = await api(page.request, 'get', '/api/applications/my-postings');
  let contextReads = 0;
  page.on('response', response => { if (new URL(response.url()).pathname === `/api/cases/${data.caseId}`) contextReads++; });
  expect(account.some(row => row.id === data.applicationId)).toBe(true);
  await assertCounts(page.request, data, 1);
  await page.goto(current ? '/dashboard-attorney.html#cases:inquiries' : `/attorney-v2.html#/matters/${data.caseId}/applications?applicantId=${paraId.toUpperCase()}`, { waitUntil: 'commit' });
  if (current) {
    const actions = page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`).first();
    await actions.locator('[data-case-menu-trigger]').click(); await actions.getByRole('button', { name: 'Review applications', exact: true }).click();
  }
  const panel = page.locator('[data-matter-applications]'), decisions = page.locator('[data-application-decisions]');
  await expect(panel).toHaveAttribute('data-state', 'ready'); await expect(panel).toContainText('Preserve this submitted letter');
  for (const [label, saved] of [['Remove star', 'Application star removed.'], ['Shortlist application', 'Application shortlisted.'], ['Star application', 'Application starred.'], ['Return to submitted', 'Application returned to submitted status.'], ['Remove star', 'Application star removed.'], ['Reject application', 'Application rejected.']]) {
    await decisions.getByRole('button', { name: /Review application decisions|Refresh decision review/ }).click();
    await expect(decisions).toHaveAttribute('data-state', 'ready');
    await decisions.getByRole('button', { name: label, exact: true }).click();
    const beforeDecision = contextReads;
    await decisions.getByRole('button', { name: label === 'Reject application' ? 'Confirm rejection' : 'Save application decision', exact: true }).click();
    await expect(panel.getByRole('status').first()).toContainText(saved);
    if (label === 'Shortlist application') { const preview = await api(page.request, 'get', `/api/cases/${data.caseId}/applications/${paraId}/preview`); expect(preview.application).toMatchObject({ id: data.applicationId, status: 'shortlisted', coverLetter: 'Preserve this submitted letter while reviewing the earlier record.' }); }
    if (!current) { await expect.poll(() => contextReads).toBeGreaterThan(beforeDecision); await expect(page.getByRole('button', { name: 'Refresh Matter', exact: true })).toBeEnabled(); await expect(page.locator('[data-matter-workspace] > [role="status"]')).toHaveText('Posted'); }
  }
  await assertCounts(page.request, data, 0);
  const own = await api(para, 'get', '/api/applications/my'); expect(own.find(row => row._id === data.applicationId)).toMatchObject({ status: 'rejected', pending: false });
  const outcome = panel.locator('summary'); await outcome.scrollIntoViewIfNeeded(); await expect(outcome).toBeVisible();
  await page.screenshot({ path: info.outputPath('retained-raw-application-decision.png'), fullPage: true });
  if (current) {
    await page.getByRole('dialog', { name: 'Review applications', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`)).toHaveCount(0);
    await expect(page.locator('[data-case-filter="inquiries"]')).toBeFocused();
    await page.screenshot({ path: info.outputPath('retained-current-parent-return.png'), fullPage: true });
  }
});
test('paralegal withdraws the same raw application through Work and retains its history', async ({ page, browser, baseURL }, info) => {
  const data = await fixture(page), context = await browser.newContext({ baseURL, storageState: await para.storageState() });
  try {
    const work = await context.newPage(); await work.goto(`/paralegal-v2.html#/work?applicationId=${data.applicationId}`, { waitUntil: 'commit' });
    await work.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    await work.getByRole('dialog', { name: 'Withdraw this application?', exact: true }).getByRole('button', { name: 'Withdraw application', exact: true }).click();
    await expect(work.locator('[data-v2-toast-region]')).toContainText('Application withdrawn.');
    const row = work.locator(`[data-work-application-id="${data.applicationId}"]`); await expect(row).toBeVisible(); await expect(row).toContainText('Withdrawn'); await expect(row).toContainText(data.title);
    await expect(row.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
    expect((await api(page.request, 'get', '/api/applications/my-postings')).some(value => value.id === data.applicationId)).toBe(false);
    await assertCounts(page.request, data, 0);
    await work.screenshot({ path: info.outputPath('retained-raw-withdrawal.png'), fullPage: true });
  } finally { await context.close(); }
});


for (const outcome of ['delayed', 'failed']) test(`current ${outcome} parent refresh preserves its truthful return and recovery`, async ({ page }, info) => {
  const data = await fixture(page);
  await page.goto('/dashboard-attorney.html#cases:inquiries', { waitUntil: 'commit' });
  const actions = page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`).first();
  await actions.locator('[data-case-menu-trigger]').click(); await actions.getByRole('button', { name: 'Review applications', exact: true }).click();
  const panel = page.locator('[data-matter-applications]'), decisions = page.locator('[data-application-decisions]');
  await expect(panel).toHaveAttribute('data-state', 'ready');
  let release, requested = false; const held = new Promise(resolve => { release = resolve; });
  const target = url => url.pathname === '/api/applications/my-postings' && url.searchParams.has('expectedOwnerId');
  await page.route(target, async route => { requested = true; if (outcome === 'delayed') { await held; await route.continue(); } else if (await page.evaluate(() => window.__lpcParentRetry === true)) await route.continue(); else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic count read unavailable' }) }); });
  await decisions.getByRole('button', { name: 'Review application decisions', exact: true }).click();
  await decisions.getByRole('button', { name: 'Reject application', exact: true }).click();
  await decisions.getByRole('button', { name: 'Confirm rejection', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('Application rejected.'); await expect.poll(() => requested).toBe(true);
  await page.getByRole('dialog', { name: 'Review applications', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  if (outcome === 'delayed') {
    await expect(page.locator('[data-cases-wrapper]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-application-parent-status]')).toBeVisible();
    await expect(page.locator('[data-application-parent-status]')).toContainText('Updating applications'); release();
  } else {
    await expect(page.locator('[data-application-parent-status]')).toBeVisible();
    await expect(page.locator('[data-application-parent-status]')).toContainText('Applications could not be refreshed.');
    await expect(page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('retained-parent-refresh-unavailable.png'), fullPage: true });
    const retry = page.locator('[data-application-parent-status]').getByRole('button', { name: 'Retry', exact: true });
    await page.evaluate(() => document.addEventListener('click', event => { if (event.target.closest('[data-application-parent-status] button')) window.__lpcParentRetry = true; }, { capture: true }));
    await retry.click();
    await expect.poll(() => page.evaluate(() => window.__lpcParentRetry)).toBe(true);
  }
  await expect(page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`)).toHaveCount(0);
  await expect(page.locator('[data-case-filter="inquiries"]')).toBeFocused();
  await expect(page.locator('[data-cases-wrapper]')).not.toHaveAttribute('aria-busy', 'true');
  await page.screenshot({ path: info.outputPath(`retained-parent-${outcome}-return.png`), fullPage: true });
});

test('an earlier notification read cannot restore a rejected application or move the reader focus', async ({ page }, info) => {
  const data = await fixture(page);
  await page.goto('/dashboard-attorney.html#cases:inquiries', { waitUntil: 'commit' });
  await expect(page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`).first()).toBeVisible();
  let release, requested = false, delivered = false; const held = new Promise(resolve => { release = resolve; });
  const target = url => url.pathname === '/api/applications/my-postings' && !url.searchParams.has('expectedOwnerId');
  await page.route(target, async route => {
    const response = await route.fetch(); const body = await response.json();
    expect(body.some(row => row.id === data.applicationId)).toBe(true); requested = true;
    await held; await route.fulfill({ response, json: body }); delivered = true;
  }, { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed', { detail: { types: ['application_submitted'] } })));
  await expect.poll(() => requested).toBe(true);
  const actions = page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`).first();
  await actions.locator('[data-case-menu-trigger]').click(); await actions.getByRole('button', { name: 'Review applications', exact: true }).click();
  const panel = page.locator('[data-matter-applications]'), decisions = page.locator('[data-application-decisions]');
  await expect(panel).toHaveAttribute('data-state', 'ready');
  await decisions.getByRole('button', { name: 'Review application decisions', exact: true }).click();
  await decisions.getByRole('button', { name: 'Reject application', exact: true }).click();
  await decisions.getByRole('button', { name: 'Confirm rejection', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('Application rejected.');
  await page.getByRole('dialog', { name: 'Review applications', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`)).toHaveCount(0);
  const search = page.locator('[data-cases-search]'); await search.focus();
  release(); await expect.poll(() => delivered).toBe(true);
  // Trigger the public filter interaction after the stale response has settled.
  await search.fill(data.title);
  await expect(page.locator(`.case-actions[data-case-id="${data.caseId}"]:visible`)).toHaveCount(0);
  await expect(search).toBeFocused();
  await page.screenshot({ path: info.outputPath('retained-parent-earlier-read.png'), fullPage: true });
});
