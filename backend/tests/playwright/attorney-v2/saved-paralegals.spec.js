const { test, expect } = require('../support-session-fixture');
const { MongoClient, ObjectId } = require('mongoose').mongo;
const AxeBuilder = require('@axe-core/playwright').default;
async function fixture(page) {
  const user = (await (await page.request.get('/api/auth/me')).json()).user, ownerId = user.id || user._id;
  const mongo = new MongoClient('mongodb://127.0.0.1:5889/control-room-playwright?directConnection=true', { serverSelectionTimeoutMS: 5000 });
  await mongo.connect(); const db = mongo.db(), id = new ObjectId(), caseId = new ObjectId();
  try {
    await db.collection('users').insertOne({ _id: id, firstName: 'Priya', lastName: 'Morgan', email: `saved-${id}@example.test`, role: 'paralegal', status: 'approved', bio: 'Experienced in contracts and document review.', skills: ['Document review'], practiceAreas: ['Contract Law'], location: 'New York', availability: 'Available now', yearsExperience: 5, resumeURL: `users/${id}/resume.pdf`, profileImage: '/assets/avatar-placeholder.svg', profilePhotoStatus: 'approved', preferences: {} });
    await db.collection('cases').insertOne({ _id: caseId, attorney: new ObjectId(ownerId), attorneyId: new ObjectId(ownerId), paralegal: id, title: 'Saved paralegal browser check', status: 'completed' });
  } finally { await mongo.close(); }
  return { id: String(id), caseId: String(caseId), ownerId };
}
async function open(page) {
  await page.goto('/attorney-v2.html#/paralegals?view=saved');
  await page.reload();
  await expect(page.locator('[data-saved-paralegals]')).toBeVisible();
  await expect(page.locator('[data-saved-paralegals]')).not.toContainText('Loading saved paralegals');
}
async function completion(page, value) {
  await page.evaluate(async value => {
    const { createWorkspaceCompletion } = await import('/assets/scripts/attorney-v2/workspace-completion.mjs');
    const { createApiClient } = await import('/assets/scripts/attorney-v2/api-client.mjs');
    const api = createApiClient(), controller = new AbortController();
    const review = { ownerId: value.ownerId, caseId: value.caseId, caseTitle: 'Lease review', paralegalId: value.id, paralegalName: 'Priya Morgan', revision: 'd'.repeat(64), canComplete: false, blockers: ['completed'], mode: 'finish_completion', payoutState: 'recorded', grossCents: 65000, feeCents: 11700, payoutCents: 53300, currency: 'USD', work: { total: 1, complete: 1 }, documents: { total: 0, approved: 0, awaitingReview: 0, revisions: 0, securityPending: 0 }, completedAt: '2026-09-20T12:00:00Z', purgeAt: null, archiveReady: false, operation: null, retentionMonths: 6 };
    const content = createWorkspaceCompletion(value.caseId, { api: { ...api, readCompletion: async () => review }, signal: controller.signal, ownerId: value.ownerId, privateState: { completions: new Map() } });
    document.querySelector('[data-av2-outlet]').append(content); await content.readiness;
  }, value);
}
test('completion save persists, opens the profile, and supports removal on desktop and mobile', async ({ page }, testInfo) => {
  const value = await fixture(page); await open(page); await completion(page, value);
  const prompt = page.locator(`[data-save-paralegal="${value.id}"]`);
  await expect(prompt).toContainText('Save this paralegal for future work?');
  await prompt.getByRole('button', { name: 'Yes, save', exact: true }).click(); await expect(prompt).toContainText('Saved. Find them');
  await open(page); const card = page.locator(`[data-saved-profile="${value.id}"]`); await expect(card).toContainText('Priya Morgan');
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('[data-saved-paralegals]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`saved-${width}.png`), fullPage: true });
  }
  await page.goto(`/attorney-v2.html#/paralegals?caseId=${value.caseId}&q=Priya&minYears=3`);
  await expect(page.locator('[data-av2-region="directory"]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('link', { name: 'Saved paralegals', exact: true }).click();
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`caseId=${value.caseId}`));
  await card.getByRole('link', { name: 'Priya Morgan', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`caseId=${value.caseId}`));
  await page.getByRole('link', { name: /Back to results$/ }).click();
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/view=saved/);
  await page.getByRole('link', { name: 'Browse paralegals', exact: true }).click();
  await expect(page.locator('[data-av2-region="directory"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('searchbox', { name: 'Search profiles', exact: true })).toHaveValue('Priya');
  await expect(page).toHaveURL(/minYears=3/);
  await page.getByRole('link', { name: 'Saved paralegals', exact: true }).click();
  await card.getByRole('link', { name: 'Priya Morgan', exact: true }).click();
  const saved = page.locator(`[data-save-paralegal="${value.id}"]`); await expect(saved).toContainText('Saved to your paralegals.');
  await saved.getByRole('button', { name: 'Remove from saved' }).click(); await expect(saved.getByRole('button', { name: 'Save paralegal', exact: true })).toBeVisible();
  await open(page); await expect(page.locator(`[data-saved-profile="${value.id}"]`)).toHaveCount(0);
});
test('No thanks persists without saving or repeatedly prompting', async ({ page }) => {
  const value = await fixture(page); await open(page); await completion(page, value);
  const prompt = page.locator(`[data-save-paralegal="${value.id}"]`);
  await prompt.getByRole('button', { name: 'No, thanks', exact: true }).click(); await expect(prompt).toContainText('No problem.');
  await open(page); await completion(page, value); await expect(prompt).toBeHidden();
  await expect(page.locator(`[data-saved-profile="${value.id}"]`)).toHaveCount(0);
});
test('failed list reads show Retry rather than an empty saved list', async ({ page }) => {
  await page.route('**/api/paralegals/saved?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await open(page); const section = page.locator('[data-saved-paralegals]');
  await expect(section).toContainText('Saved paralegals couldn’t load.'); await expect(section).not.toContainText('No saved paralegals yet');
  await page.unroute('**/api/paralegals/saved?*'); await section.getByRole('button', { name: 'Retry' }).click();
  await expect(section).not.toContainText('Saved paralegals couldn’t load.');
});
test('current-workspace completion dialog supports keyboard saving and continuing', async ({ page }) => {
  const value = await fixture(page); await open(page);
  await page.evaluate(value => {
    void Promise.all([import('/assets/scripts/attorney-v2/saved-paralegals.mjs'), import('/assets/scripts/attorney-v2/api-client.mjs')]).then(([saved, api]) => saved.showSaveParalegalDialog(value.id, { api: api.createApiClient(), ownerId: value.ownerId }));
  }, value);
  const dialog = page.getByRole('dialog', { name: 'Save paralegal for future work' }); await expect(dialog).toBeVisible();
  const yes = dialog.getByRole('button', { name: 'Yes, save' }); await yes.focus(); await page.keyboard.press('Enter'); await expect(dialog).toContainText('Saved. Find them');
  await dialog.getByRole('button', { name: 'Continue' }).click(); await expect(dialog).toHaveCount(0);
  await open(page); await expect(page.locator(`[data-saved-profile="${value.id}"]`)).toBeVisible();
});

test('existing Browse Paralegals exposes the private saved list without entering V2', async ({ page }, testInfo) => {
  const value = await fixture(page); await open(page); await completion(page, value);
  await page.locator(`[data-save-paralegal="${value.id}"]`).getByRole('button', { name: 'Yes, save' }).click();
  await expect(page.locator(`[data-save-paralegal="${value.id}"]`)).toContainText('Saved. Find them');
  await page.goto('/browse-paralegals.html');
  await page.locator('[data-saved-paralegal-link]').click();
  const card = page.locator(`[data-saved-profile="${value.id}"]`); await expect(card).toContainText('Priya Morgan');
  await expect(card.getByRole('link', { name: 'Priya Morgan', exact: true })).toHaveAttribute('href', `/profile-paralegal.html?id=${value.id}`);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.locator('.results-header')).toBeHidden();
  await expect(page.locator('.authenticated-browse-sidebar')).toBeHidden();
  const bounds = await card.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath('saved-legacy-390.png'), fullPage: true });
  await page.locator('[data-auth-sidebar-toggle]').click(); await expect(page.locator('.authenticated-browse-sidebar')).toBeVisible();
  await page.locator('[data-auth-sidebar-toggle]').click(); await expect(page.locator('.authenticated-browse-sidebar')).toBeHidden();
  await card.getByRole('button', { name: 'Remove from saved' }).click(); await expect(card).toHaveCount(0);
});
