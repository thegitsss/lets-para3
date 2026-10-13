const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { randomUUID } = require('crypto');
const fields = { title: 'Synthetic publication outcome', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic publication outcome review.', tasks: [{ title: 'Prepare agreement' }] };
const result = page => page.getByRole('region', { name: 'Publication status', exact: true });
async function api(page, method, path, data) {
  const csrf = await (await page.request.get('/api/csrf')).json(), user = (await (await page.request.get('/api/auth/me')).json()).user;
  const response = await page.request[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function inspectOutcome(page, info, region, selector, prefix) {
  for (const [width, dark, enlarged] of [[1440, false, false], [390, false, false], [1440, true, false], [768, true, false], [320, true, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ dark, enlarged }) => {
      document.documentElement.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-dark', dark);
      document.documentElement.classList.toggle('theme-light', !dark); document.body.classList.toggle('theme-light', !dark);
      document.documentElement.style.fontSize = enlarged ? '200%' : '';
    }, { dark, enlarged });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const brightness = await page.evaluate(() => (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || []).slice(0, 3).reduce((sum, value) => sum + Number(value), 0));
    if (dark) expect(brightness).toBeLessThan(200); else expect(brightness).toBeGreaterThan(600);
    const bounds = await region.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    for (const control of await region.locator('a, button').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${prefix}-${width}-${dark ? 'dark' : 'light'}-${enlarged ? '200' : '100'}.png`), fullPage: true });
  }
}
for (const current of [false, true]) for (const state of ['posted', 'removed', 'cleanup-failed']) test(`${current ? 'current' : 'V2'} ${state} outcome has one relevant heading and bounded recovery actions`, async ({ page }, info) => {
  const draft = (await api(page, 'post', '/api/case-drafts', fields)).draft;
  const publication = (await api(page, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' })).publication;
  if (state === 'removed') {
    const posting = (await api(page, 'get', `/api/cases/posting/${publication.caseId}`)).posting;
    await api(page, 'delete', `/api/cases/posting/${publication.caseId}`, { revision: posting.revision });
  }
  let cleanupFailed = state === 'cleanup-failed', publicationWrites = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cases/posting/publications') publicationWrites++; });
  await page.route('**/api/cases/posting/publications/*/cleanup', route => cleanupFailed ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.bringToFront();
  await page.goto(current ? `/create-case.html?draftId=${draft.id}#review` : `/attorney-v2.html#/matters/new?draftId=${draft.id}`, { waitUntil: 'commit' });
  await expect(result(page)).toHaveAttribute('data-state', 'complete');
  const heading = state === 'removed' ? 'Matter removed' : 'Matter posted';
  await expect(page.locator('h1:visible')).toHaveCount(1); await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page.getByText('Prepare a private draft of the support you need.', { exact: false })).toBeHidden();
  await expect(result(page)).not.toContainText('Your Matter is posted.'); await expect(result(page)).not.toContainText('Publishing succeeded');
  await expect(result(page).getByRole('link', { name: 'Return to Matters', exact: true })).toHaveCount(1);
  await expect(result(page).getByRole('link', { name: 'Open posted Matter', exact: true })).toHaveCount(state === 'removed' ? 0 : 1);
  if (state === 'removed') await expect(result(page)).toContainText('This draft can’t be published again.');
  if (state === 'cleanup-failed') await expect(result(page).getByRole('alert')).toHaveText('The saved draft couldn’t be removed. It can’t be published again.');
  await inspectOutcome(page, info, result(page), '[aria-label="Publication status"]', 'outcome');
  if (state === 'cleanup-failed') {
    cleanupFailed = false; await result(page).getByRole('button', { name: 'Retry draft cleanup', exact: true }).click();
    await expect(result(page).getByRole('alert')).toHaveCount(0); await expect(result(page)).toBeFocused();
  }
  expect(publicationWrites).toBe(0);
});

for (const current of [false, true]) test(`${current ? 'current' : 'V2'} confirmed posting deletion leaves one outcome and a useful return`, async ({ page }, info) => {
  const draft = (await api(page, 'post', '/api/case-drafts', fields)).draft;
  const publication = (await api(page, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' })).publication;
  let deletes = 0; page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/cases/posting/${publication.caseId}`) deletes++; });
  await page.bringToFront(); await page.goto(current ? `/create-case.html?caseId=${publication.caseId}` : `/attorney-v2.html#/matters/new?caseId=${publication.caseId}`, { waitUntil: 'commit' });
  const region = page.getByRole('region', { name: 'Posting save status', exact: true });
  await expect(region).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Delete posting', exact: true }).click();
  await page.getByRole('button', { name: 'Delete posting permanently', exact: true }).click();
  await expect(region).toHaveAttribute('data-state', 'deleted');
  await expect(page.locator('h1:visible')).toHaveCount(1); await expect(region.getByRole('heading', { level: 1, name: 'Posting deleted', exact: true })).toBeVisible();
  await expect(page.getByText('Changes become public only after you review and save them.', { exact: false })).toBeHidden();
  await expect(page.locator('#av2-posting-title')).toBeHidden(); await expect(region).toBeFocused();
  await expect(page.getByRole('link', { name: 'Return to Matters', exact: true })).toHaveCount(1);
  await expect(region.getByRole('link', { name: 'Return to Matters', exact: true })).toHaveAttribute('href', current ? '/dashboard-attorney.html#cases' : '#/matters');
  expect((await page.request.get(`/api/cases/${publication.caseId}`)).status()).toBe(404); expect(deletes).toBe(1);
  await inspectOutcome(page, info, region, '[aria-label="Posting save status"]', 'posting-deleted');
  await region.getByRole('link', { name: 'Return to Matters', exact: true }).click();
  await expect(page).toHaveURL(current ? /dashboard-attorney\.html#cases$/ : /attorney-v2\.html#\/matters$/);
});

for (const input of ['pointer', 'keyboard']) test(`confirmed draft deletion with ${input} removes repeated status and draft instructions while keeping exact next actions`, async ({ page }, info) => {
  await page.addInitScript(() => {
    window.__lpcOutcomeFocus = [];
    const describe = element => element ? { tag: element.tagName, id: element.id, label: element.getAttribute('aria-label') || (element.tagName === 'BUTTON' ? element.textContent.slice(0, 60) : '') } : null;
    for (const type of ['focusin', 'focusout', 'pointerdown', 'pointerup', 'click']) for (const capture of [true, false]) document.addEventListener(type, event => {
      window.__lpcOutcomeFocus.push({ type, capture, target: describe(event.target), active: describe(document.activeElement), at: performance.now() });
    }, capture);
  });
  const draft = (await api(page, 'post', '/api/case-drafts', fields)).draft;
  const destination = '#/matters?view=draft&q=Synthetic';
  await page.bringToFront(); await page.goto(`/attorney-v2.html#/matters/new?draftId=${draft.id}&returnTo=${encodeURIComponent(destination)}`, { waitUntil: 'commit' });
  await expect(page.getByRole('region', { name: 'Draft save status', exact: true })).toHaveAttribute('data-state', 'ready');
  const remove = page.getByRole('button', { name: 'Delete draft', exact: true }), confirm = page.getByRole('button', { name: 'Delete draft permanently', exact: true });
  if (input === 'keyboard') { await remove.focus(); await remove.press('Enter'); await expect(confirm).toBeFocused(); await confirm.press('Enter'); }
  else { await remove.click(); await confirm.click(); }
  const region = page.getByRole('region', { name: 'Draft deletion status', exact: true });
  await expect(region).toBeVisible();
  try { await expect(region).toBeFocused(); }
  finally { await info.attach('draft-deletion-focus', { body: JSON.stringify(await page.evaluate(() => ({ events: window.__lpcOutcomeFocus, active: { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label') } })), null, 2), contentType: 'application/json' }); }
  await expect(page.locator('h1:visible')).toHaveCount(1); await expect(region.getByRole('heading', { level: 1, name: 'Draft deleted', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft save status', exact: true })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Publication status', exact: true })).toBeHidden();
  await expect(page.getByText('Prepare a private draft of the support you need.', { exact: false })).toBeHidden();
  await expect(page.locator('#av2-draft-title')).toBeHidden(); await expect(region.getByRole('link')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Return to drafts', exact: true })).toHaveCount(1);
  await expect(region.getByRole('link', { name: 'Return to drafts', exact: true })).toHaveAttribute('href', destination);
  expect((await page.request.get(`/api/case-drafts/${draft.id}`)).status()).toBe(404);
  await inspectOutcome(page, info, region, '[aria-label="Draft deletion status"]', 'draft-deleted');
  await region.getByRole('link', { name: 'Create another Matter', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Draft save status', exact: true })).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#av2-draft-title')).toHaveValue('');
  await expect(page.getByRole('link', { name: 'Return to drafts', exact: true })).toBeHidden();
  const returnToDrafts = page.getByRole('button', { name: 'Save and return to drafts', exact: true });
  if (input === 'keyboard') { await returnToDrafts.focus(); await returnToDrafts.press('Enter'); }
  else await returnToDrafts.click();
  await expect.poll(() => new URL(page.url()).hash).toBe(destination);
});

test('draft deletion does not take focus from navigation selected while its result is pending', async ({ page }) => {
  const draft = (await api(page, 'post', '/api/case-drafts', fields)).draft;
  await page.bringToFront(); await page.goto(`/attorney-v2.html#/matters/new?draftId=${draft.id}`, { waitUntil: 'commit' });
  await expect(page.getByRole('region', { name: 'Draft save status', exact: true })).toHaveAttribute('data-state', 'ready');
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
  await page.route(`**/api/case-drafts/${draft.id}`, async route => { if (route.request().method() !== 'DELETE') return route.continue(); arrived(); await gate; await route.continue(); });
  try {
    await page.getByRole('button', { name: 'Delete draft', exact: true }).click(); await page.getByRole('button', { name: 'Delete draft permanently', exact: true }).click();
    await pending; const home = page.getByRole('link', { name: 'Home', exact: true }); await home.focus(); release();
    await expect(page.getByRole('region', { name: 'Draft deletion status', exact: true })).toBeVisible(); await expect(home).toBeFocused();
  } finally { release(); }
});
