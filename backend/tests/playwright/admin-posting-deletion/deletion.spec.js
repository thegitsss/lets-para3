const { test, expect } = require('playwright/test');
const { randomUUID } = require('node:crypto');
const AxeBuilder = require('@axe-core/playwright').default;
let attorney, paralegal;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function api(client, method, path, data) {
  const csrf = await (await client.get('/api/csrf')).json(), user = (await (await client.get('/api/auth/me')).json()).user;
  const response = await client[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: String(user.id || user._id) } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
test.beforeAll(async ({ playwright, baseURL }) => {
  const clients = [];
  for (const role of ['attorney', 'paralegal']) {
    const client = await playwright.request.newContext({ baseURL }); clients.push(client);
    const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { 'x-ai-control-room-e2e-secret': process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
    const response = await client.post(`/api/admin/ai-control-room/dev/e2e/bootstrap-${role}`, { headers }); expect(response.ok()).toBeTruthy();
    const actor = (await response.json())[role], csrf = await (await client.get('/api/csrf')).json();
    const password = role === 'attorney' ? process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD || 'ControlRoomSupport123!' : process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || 'ControlRoomSupport123!';
    const login = await client.post('/api/auth/login', { headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { email: actor.email, password } }); expect(login.ok()).toBeTruthy();
  }
  [attorney, paralegal] = clients;
});
test.afterAll(async () => { await attorney?.dispose(); await paralegal?.dispose(); });
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });
async function posting() {
  const title = `Synthetic admin deletion ${randomUUID()}`;
  const draft = (await api(attorney, 'post', '/api/case-drafts', { title, practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic administrative posting deletion acceptance.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const receipt = (await api(attorney, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' })).publication;
  return { ...receipt, title, draftId: draft.id };
}
const dialog = page => page.locator('#deletePostModal');
async function open(page, value, { navigate = true, ready = true } = {}) {
  if (navigate) await page.goto('/admin-dashboard.html#posts');
  const row = page.locator('#postsList tr').filter({ hasText: value.title });
  await expect(row).toHaveCount(1); await row.getByRole('button', { name: 'Actions ▾', exact: true }).click();
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  if (ready) await expect(dialog(page).getByRole('button', { name: 'Delete posting', exact: true })).toBeEnabled();
  return row;
}
async function fill(page) { await dialog(page).getByLabel('Reason', { exact: true }).fill('Duplicate synthetic posting'); await dialog(page).getByLabel('Note to attorney (optional)', { exact: true }).fill('Reviewed synthetic removal.'); }
const confirm = page => dialog(page).getByRole('button', { name: 'Delete posting', exact: true }).click();

test('actual admin deletion reconciles the attorney posting, paralegal application and retained publication receipt', async ({ page, browser, baseURL }, info) => {
  const value = await posting(); await api(paralegal, 'post', `/api/cases/${value.caseId}/apply`, { coverLetter: 'I can prepare this agreement and organize its supporting exhibits.' });
  const application = (await api(paralegal, 'get', '/api/applications/my')).find(item => String(item.caseId) === value.caseId); expect(application).toBeTruthy();
  const paraContext = await browser.newContext({ baseURL, storageState: await paralegal.storageState() });
  const attorneyContext = await browser.newContext({ baseURL, storageState: await attorney.storageState() });
  try {
    const paraPage = await paraContext.newPage(), attorneyPage = await attorneyContext.newPage();
    await paraPage.goto('/paralegal-v2.html#/work?section=applications'); await expect(paraPage.locator(`[data-work-application-id="${application._id}"]`)).toContainText(value.title);
    await page.bringToFront(); const row = await open(page, value); await fill(page);
    await confirm(page); await expect(dialog(page)).toBeHidden(); await expect(row).toHaveCount(0); await expect(page.locator('#toastBanner')).toContainText('Posting deleted.');
    expect((await page.request.get(`/api/cases/${value.caseId}`)).status()).toBe(404);
    expect((await api(attorney, 'get', '/api/jobs/my')).some(item => String(item._id) === value.jobId)).toBe(false);
    expect((await api(paralegal, 'get', '/api/jobs/open')).some(item => String(item._id) === value.jobId)).toBe(false);
    expect((await api(paralegal, 'get', '/api/applications/my')).some(item => String(item._id) === String(application._id))).toBe(false);
    await paraPage.bringToFront(); await paraPage.reload(); await expect(paraPage.locator(`[data-work-application-id="${application._id}"]`)).toHaveCount(0);
    await expect(paraPage.locator('[data-work-application-results]')).toBeVisible(); await paraPage.screenshot({ path: info.outputPath('paralegal-after-admin-deletion.png'), fullPage: true });
    await attorneyPage.bringToFront(); await attorneyPage.goto(`/attorney-v2.html#/matters/new?draftId=${value.draftId}`);
    await expect(attorneyPage.getByRole('region', { name: 'Publication status', exact: true })).toContainText('Matter removed'); await attorneyPage.screenshot({ path: info.outputPath('attorney-after-admin-deletion.png'), fullPage: true });
  } finally { await paraContext.close(); await attorneyContext.close(); }
});

test('unavailable admin deletion review remains retryable and does not authorize a write', async ({ page }) => {
  const value = await posting(); let unavailable = true, writes = 0;
  page.on('request', request => { if (request.method() === 'DELETE') writes++; });
  await page.route(`**/api/admin/cases/${value.caseId}/deletion?**`, route => unavailable ? json(route, { msg: 'The posting could not be verified.' }, 503) : route.continue());
  await open(page, value, { ready: false }); await expect(dialog(page).locator('[data-delete-feedback]')).toHaveText('The posting could not be verified.');
  await expect(dialog(page).getByRole('button', { name: 'Delete posting', exact: true })).toBeDisabled();
  unavailable = false; await dialog(page).getByRole('button', { name: 'Review again' }).focus(); await dialog(page).getByRole('button', { name: 'Review again' }).press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Delete posting', exact: true })).toBeEnabled(); await expect(dialog(page).getByLabel('Reason', { exact: true })).toBeFocused(); expect(writes).toBe(0);
});

test('a changed posting requires a fresh review while retaining the drafted moderation reason', async ({ page }) => {
  const value = await posting(); await open(page, value); await fill(page);
  const current = (await api(attorney, 'get', `/api/cases/posting/${value.caseId}`)).posting;
  const title = `Updated ${value.title}`; await api(attorney, 'patch', `/api/cases/posting/${value.caseId}`, { revision: current.revision, changes: { title } });
  await confirm(page); await expect(dialog(page).locator('[data-delete-feedback]')).toContainText('This posting changed.');
  await expect(dialog(page).getByRole('button', { name: 'Review again' })).toBeFocused(); await expect(dialog(page).getByLabel('Reason', { exact: true })).toHaveValue('Duplicate synthetic posting');
  await dialog(page).getByRole('button', { name: 'Review again' }).click(); await expect(dialog(page).locator('[data-delete-matter]')).toHaveText(title);
  await expect(dialog(page).getByRole('button', { name: 'Delete posting', exact: true })).toBeEnabled(); await confirm(page); await expect(dialog(page)).toBeHidden();
});

for (const outcome of ['lost response', 'incomplete acknowledgement', 'wrong Matter acknowledgement']) test(`${outcome} never claims deletion success or automatically retries`, async ({ page }) => {
  const value = await posting(); await open(page, value); await fill(page); let writes = 0;
  await page.route(`**/api/admin/cases/${value.caseId}`, async route => {
    writes++; const response = await route.fetch(); expect(response.ok()).toBeTruthy();
    if (outcome === 'lost response') return route.abort('failed');
    const body = await response.json(); return json(route, outcome === 'incomplete acknowledgement' ? { ok: true } : { ...body, caseId: '1'.repeat(24) });
  });
  await confirm(page); await expect(dialog(page).locator('[data-delete-feedback]')).toContainText('Deletion was not confirmed.');
  await expect(page.locator('#toastBanner')).not.toContainText('Posting deleted.'); await expect(dialog(page).getByRole('button', { name: 'Delete posting', exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Review again' }).click(); await expect(dialog(page).locator('[data-delete-feedback]')).toContainText('Matter not found.');
  expect(writes).toBe(1); expect((await page.request.get(`/api/cases/${value.caseId}`)).status()).toBe(404);
});

test('cancel during CSRF preparation cannot delete a later target or overwrite its new review', async ({ page }) => {
  const first = await posting(), second = await posting(); await open(page, first); await fill(page);
  let release, started, writes = 0; const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  page.on('request', request => { if (request.method() === 'DELETE') writes++; });
  await page.route('**/api/csrf', async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); }, { times: 1 });
  try {
    await confirm(page); await began; await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog(page)).toBeHidden();
    await open(page, second, { navigate: false }); release(); await expect(dialog(page).locator('[data-delete-matter]')).toHaveText(second.title);
    await expect(dialog(page).getByRole('button', { name: 'Delete posting', exact: true })).toBeEnabled(); expect(writes).toBe(0);
    expect((await page.request.get(`/api/cases/${first.caseId}`)).status()).toBe(200); expect((await page.request.get(`/api/cases/${second.caseId}`)).status()).toBe(200);
  } finally { release(); }
});

for(const activation of ['pointer','keyboard']) test(`a sent deletion permits only one request and retains its confirmation until the result settles (${activation})`, async ({ page }) => {
  const value = await posting(); await open(page, value); await fill(page);
  let release, started, writes = 0; const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  await page.route(`**/api/admin/cases/${value.caseId}`, async route => { writes++; const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); });
  try {
    if(activation==='keyboard'){await dialog(page).locator('[data-delete-confirm]').focus();await dialog(page).locator('[data-delete-confirm]').press('Enter');}else await confirm(page);
    await began; await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(dialog(page).locator('[data-delete-close]')).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Tab'); await expect(dialog(page)).toBeFocused();
    await expect(dialog(page).locator('[data-delete-confirm]')).toBeDisabled(); release(); await expect(dialog(page)).toBeHidden(); expect(writes).toBe(1);
  } finally { release(); }
});

for (const change of ['identity', 'role']) test(`admin ${change} change after review clears the prior form and prevents deletion`, async ({ page }) => {
  const value = await posting(); await open(page, value); await fill(page); let writes = 0;
  const me = (await (await page.request.get('/api/auth/me')).json()).user;
  await page.route('**/api/auth/me', route => json(route, { user: { ...me, ...(change === 'identity' ? { id: '2'.repeat(24), _id: '2'.repeat(24) } : { role: 'attorney' }) } }));
  page.on('request', request => { if (request.method() === 'DELETE') writes++; });
  await confirm(page); await expect(dialog(page).locator('[data-delete-feedback]')).toContainText('The signed-in account changed.');
  await expect(dialog(page).getByLabel('Reason', { exact: true })).toHaveValue(''); await expect(dialog(page).getByLabel('Note to attorney (optional)', { exact: true })).toHaveValue(''); expect(writes).toBe(0);
});

test('a cancelled pending review cannot replace the next posting confirmation', async ({ page }) => {
  const first = await posting(), second = await posting(); let release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  await page.route(`**/api/admin/cases/${first.caseId}/deletion?**`, async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); });
  try {
    await open(page, first, { ready: false }); await began; await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await open(page, second, { navigate: false }); release(); await expect(dialog(page).locator('[data-delete-matter]')).toHaveText(second.title); await expect(dialog(page).locator('[data-delete-confirm]')).toBeEnabled();
  } finally { release(); }
});

test('admin posting deletion keeps the reviewed identity, reason and actions readable in both themes and enlarged text', async ({ page }, info) => {
  const value = await posting(); await open(page, value); await confirm(page); await expect(dialog(page).getByLabel('Reason', { exact: true })).toBeFocused();
  await expect(dialog(page).locator('[data-delete-feedback]')).toHaveText('Enter a deletion reason.'); await fill(page);
  await expect(dialog(page).locator('[data-delete-feedback]')).toBeHidden(); await expect(dialog(page).getByLabel('Reason', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  for (const [width, dark, enlarged] of [[1440, false, false], [390, false, false], [1440, true, false], [768, true, false], [320, true, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ dark, enlarged }) => { for(const element of [document.documentElement, document.body]) element.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = enlarged ? '200%' : ''; }, { dark, enlarged });
    await expect.poll(() => dialog(page).locator('.details-content').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(dark ? 'rgb(29, 53, 61)' : 'rgb(255, 255, 255)');
    await expect.poll(() => page.evaluate(() => { const content = document.querySelector('#deletePostModal .details-content'), box = content.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1 && content.scrollWidth <= content.clientWidth + 1; })).toBe(true);
    expect(await dialog(page).getByRole('heading').evaluate(element=>{
      const text=element.firstChild,value=text.textContent;
      return [...value.matchAll(/\S+/g)].every(match=>{const range=document.createRange();range.setStart(text,match.index);range.setEnd(text,match.index+match[0].length);return range.getClientRects().length===1;});
    })).toBe(true);
    for (const control of await dialog(page).locator('button:visible,textarea:visible').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).include('#deletePostModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`admin-deletion-${width}-${dark ? 'dark' : 'light'}-${enlarged ? '200' : '100'}.png`), fullPage: true });
    if(enlarged){
      for(const control of await dialog(page).locator('button:visible,textarea:visible').all()){
        await control.scrollIntoViewIfNeeded();
        expect(await control.evaluate(element=>{const box=element.getBoundingClientRect();return Boolean(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('#deletePostModal'));})).toBe(true);
      }
      await page.screenshot({path:info.outputPath('admin-deletion-320-dark-200-actions.png'),fullPage:true});
    }
  }
});

for (const kind of ['retained', 'wrong record', 'invalid permission']) test(`${kind} review cannot authorize admin deletion`, async ({ page }) => {
  const value = await posting(); let writes = 0;
  page.on('request', request => { if (request.method() === 'DELETE') writes++; });
  await page.route(`**/api/admin/cases/${value.caseId}/deletion?**`, async route => {
    const response = await route.fetch(), body = await response.json();
    Object.assign(body.deletion, kind === 'retained' ? { canDelete: false, reason: 'Matters with retained engagement history cannot be deleted.' } : kind === 'wrong record' ? { caseId: '3'.repeat(24) } : { canDelete: 'yes' });
    return json(route, body);
  });
  await open(page, value, { ready: false }); await expect(dialog(page).locator('[data-delete-feedback]')).toContainText(kind === 'retained' ? 'retained engagement history' : 'review could not be verified');
  await expect(dialog(page).locator('[data-delete-confirm]')).toBeDisabled(); await expect(dialog(page).getByLabel('Reason', { exact: true })).toBeDisabled(); expect(writes).toBe(0);
});

test('an unacknowledged deletion stops waiting and restores explicit recovery controls', async ({ page }) => {
  const value = await posting(); await open(page, value); await fill(page); let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/admin/cases/${value.caseId}`, async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  try {
    await confirm(page); await expect(dialog(page).locator('[data-delete-feedback]')).toContainText('Deletion was not confirmed.', { timeout: 20000 });
    await expect(dialog(page).getByRole('button', { name: 'Review again' })).toBeFocused(); await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(dialog(page).locator('[data-delete-confirm]')).toBeDisabled(); await expect(page.locator('#toastBanner')).not.toContainText('Posting deleted.');
  } finally { release(); }
});
