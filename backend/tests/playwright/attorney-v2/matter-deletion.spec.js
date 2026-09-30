const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const fields = { title: 'Synthetic deletion review', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic deletion acceptance.', tasks: [{ title: 'Prepare agreement' }] };
async function api(page, method, path, data) {
  const csrf = await (await page.request.get('/api/csrf')).json();
  const user = (await (await page.request.get('/api/auth/me')).json()).user;
  const response = await page.request[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function create(page, draftOnly = false) {
  const draft = (await api(page, 'post', '/api/case-drafts', fields)).draft;
  if (draftOnly) return draft.id;
  return (await api(page, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: require('crypto').randomUUID(), practiceArea: 'contract law' })).publication.caseId;
}
const row = (page, id) => page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
async function choose(page, id) {
  await row(page, id).locator('[data-case-menu-trigger]').click(); await row(page, id).getByRole('button', { name: 'Delete Matter', exact: true }).click();
}
const dialog = page => page.getByRole('dialog', { name: 'Delete this Matter?', exact: true });
const confirm = page => dialog(page).getByRole('button', { name: 'Delete Matter', exact: true }).click();
const notice = page => page.locator('#toastBanner');

test('current Matter deletion cancels without writing, then acknowledges exactly one confirmed delete', async ({ page }, testInfo) => {
  const id = await create(page); let deletes = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/cases/${id}`) deletes++; });
  await page.goto('/dashboard-attorney.html#cases:active', { waitUntil: 'domcontentloaded' }); await choose(page, id);
  await expect(dialog(page)).toContainText(fields.title);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await dialog(page).boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect((await new AxeBuilder({ page }).include('.lpc-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`delete-confirmation-${width}.png`), fullPage: true });
  }
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).focus(); await page.keyboard.press('Enter');
  expect(deletes).toBe(0); expect((await page.request.get(`/api/cases/${id}`)).ok()).toBe(true);
  await choose(page, id); await confirm(page); await expect(notice(page)).toContainText('Matter deleted.'); expect(deletes).toBe(1); await expect(row(page, id)).toHaveCount(0);
  expect((await page.request.get(`/api/cases/${id}`)).status()).toBe(404);
});

test('current failed and malformed delete responses keep the Matter visible without automatic retries', async ({ page }) => {
  const id = await create(page); let deletes = 0, mode = 'rejected';
  await page.route(`**/api/cases/${id}`, route => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletes++;
    return route.fulfill({ status: mode === 'rejected' ? 503 : 200, contentType: 'application/json', body: mode === 'rejected' ? '{"error":"Synthetic deletion unavailable"}' : '<unreadable>' });
  });
  await page.goto('/dashboard-attorney.html#cases:active', { waitUntil: 'domcontentloaded' });
  await choose(page, id); await confirm(page); await expect(notice(page)).toContainText('Synthetic deletion unavailable'); expect(deletes).toBe(1); await expect(row(page, id)).toBeVisible();
  mode = 'malformed'; await choose(page, id); await confirm(page); await expect(notice(page)).toContainText('Deletion was not confirmed'); expect(deletes).toBe(2); await expect(row(page, id)).toBeVisible();
  expect((await page.request.get(`/api/cases/${id}`)).ok()).toBe(true);
});

test('current committed deletion with a lost acknowledgement stays unconfirmed until the list is reloaded', async ({ page }) => {
  const id = await create(page); let deletes = 0;
  await page.route(`**/api/cases/${id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletes++; await route.fetch(); await route.abort('failed');
  });
  await page.goto('/dashboard-attorney.html#cases:active', { waitUntil: 'domcontentloaded' }); await choose(page, id); await confirm(page);
  await expect(notice(page)).toContainText('Deletion was not confirmed'); expect(deletes).toBe(1);
  await expect(notice(page)).not.toContainText('Matter deleted.'); expect((await page.request.get(`/api/cases/${id}`)).status()).toBe(404);
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('[data-table-body="active"]')).toBeVisible(); await expect(row(page, id)).toHaveCount(0); expect(deletes).toBe(1);
});

test('an account change during current Matter confirmation prevents its delete request', async ({ page }) => {
  const id = await create(page); let deletes = 0;
  page.on('request', request => { if (request.method() === 'DELETE') deletes++; });
  await page.goto('/dashboard-attorney.html#cases:active', { waitUntil: 'domcontentloaded' }); await choose(page, id);
  await page.route('**/api/auth/me', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: '0'.repeat(24), role: 'attorney', status: 'approved' } }) }));
  await confirm(page); await expect(notice(page)).toContainText('Your account changed. Reload Matters before continuing.'); expect(deletes).toBe(0); expect((await page.request.get(`/api/cases/${id}`)).ok()).toBe(true);
});

test('current draft deletion requires confirmation and preserves the row after an unreadable acknowledgement', async ({ page }) => {
  const id = await create(page, true); let deletes = 0, malformed = true;
  await page.route(`**/api/case-drafts/${id}`, route => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletes++;
    return malformed ? route.fulfill({ contentType: 'application/json', body: '{}' }) : route.continue();
  });
  const chooseDraft = async () => { await row(page, id).locator('[data-case-menu-trigger]').click(); await row(page, id).getByRole('button', { name: 'Delete draft', exact: true }).click(); };
  const review = page.getByRole('dialog', { name: 'Delete this draft?', exact: true });
  await page.goto('/dashboard-attorney.html#cases:draft', { waitUntil: 'domcontentloaded' }); await chooseDraft();
  await expect(review).toContainText(fields.title);
  await review.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(deletes).toBe(0); await expect(row(page, id)).toBeVisible();
  await chooseDraft(); await review.getByRole('button', { name: 'Delete draft', exact: true }).click(); await expect(notice(page)).toContainText('Draft deletion was not confirmed'); expect(deletes).toBe(1); await expect(row(page, id)).toBeVisible();
  malformed = false; await chooseDraft(); await review.getByRole('button', { name: 'Delete draft', exact: true }).click(); await expect(row(page, id)).toHaveCount(0); expect(deletes).toBe(2);
  expect((await page.request.get(`/api/case-drafts/${id}`)).status()).toBe(404);
});
