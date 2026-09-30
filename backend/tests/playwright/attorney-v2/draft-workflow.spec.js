const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const fields = { title: 'Review the services agreement for a new commercial engagement', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'First retained paragraph.\n\nSecond retained paragraph.', tasks: [{ title: 'Prepare the agreement and supporting exhibits' }] };
const recovery = page => page.getByRole('region', { name: 'Draft save status', exact: true });
const publication = page => page.getByRole('region', { name: 'Publication status', exact: true });
let originalTheme;
async function savedTheme(page, theme, remember = true) {
  let user = (await (await page.request.get('/api/auth/me')).json()).user;
  const id = user.id || user._id;
  const response = await page.request.get(`/api/account/preferences?expectedOwnerId=${id}`); expect(response.ok()).toBe(true);
  const previous = (await response.json()).theme;
  if (remember && originalTheme === undefined) originalTheme = previous;
  if (previous !== theme) {
    const csrf = (await (await page.request.get('/api/csrf')).json()).csrfToken;
    const saved = await page.request.post('/api/account/preferences', { headers: { 'X-CSRF-Token': csrf }, data: { theme, expectedOwnerId: id, expectedValues: { theme: previous } } }); expect(saved.ok()).toBe(true);
    user = (await (await page.request.get('/api/auth/me')).json()).user;
  }
  await page.evaluate(user => window.updateSessionUser?.(user), user);
}
test.afterEach(async ({ page }) => { if (originalTheme !== undefined) { const restore = originalTheme; originalTheme = undefined; await savedTheme(page, restore, false); } });
async function create(page, values) {
  const csrf = (await (await page.request.get('/api/csrf')).json()).csrfToken;
  const response = await page.request.post('/api/case-drafts', { headers: { 'X-CSRF-Token': csrf }, data: values }); expect(response.ok()).toBe(true);
  return (await response.json()).draft;
}
async function capture(page, info, current, stage) {
  const selector = current ? '#main' : '[data-av2-outlet]';
  for (const [width, theme, text] of [[1440, 'light', '100%'], [390, 'light', '100%'], [390, 'dark', '100%'], [320, 'dark', '200%']]) {
    await page.setViewportSize({ width, height: 1000 });
    await savedTheme(page, theme);
    await page.evaluate(({ theme, text }) => {
      if (window.applyThemePreference) window.applyThemePreference(theme);
      for (const root of [document.documentElement, document.body]) {
        root.classList.toggle('theme-dark', theme === 'dark'); root.classList.toggle('theme-light', theme === 'light');
      }
      document.documentElement.style.fontSize = text;
    }, { theme, text });
    await page.evaluate(() => document.fonts.ready);
    // Inspect the settled user-selected theme, including the existing color transitions.
    await page.waitForTimeout(350);
    const target = stage === 'confirmation' ? publication(page).getByRole('heading').first() : stage === 'details' ? page.locator(current ? '#caseTitleInput' : '#av2-draft-title') : stage === 'description' ? page.locator(current ? '#caseDescription' : '#av2-draft-description') : page.locator(current ? '#postBtn' : '[data-draft-step="review"] > .av2-button');
    await target.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${stage}-${width}-${theme}-${text}.png`), fullPage: true });
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect.soft(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const box = await target.boundingBox(); expect.soft(box.x).toBeGreaterThanOrEqual(0); expect.soft(box.x + box.width).toBeLessThanOrEqual(width + 1);
    const brightness = await page.evaluate(() => (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || []).slice(0, 3).reduce((sum, v) => sum + Number(v), 0));
    if (theme === 'dark') expect.soft(brightness).toBeLessThan(200); else expect.soft(brightness).toBeGreaterThan(600);
    expect.soft((await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    if (stage === 'confirmation') {
      const cancel = publication(page).getByRole('button', { name: 'Keep editing draft', exact: true }); await cancel.scrollIntoViewIfNeeded();
      for (const control of await publication(page).getByRole('button').all()) {
        const bounds = await control.boundingBox(); expect.soft(bounds.height).toBeGreaterThanOrEqual(44); expect.soft(bounds.x).toBeGreaterThanOrEqual(0); expect.soft(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      }
      await page.screenshot({ path: info.outputPath(`confirmation-actions-${width}-${theme}-${text}.png`), fullPage: true });
      if (current && theme === 'dark') {
        for (const surface of ['body', '.lpc-auth-page-shell', '#main']) {
          const color = await page.locator(surface).evaluate(el => (getComputedStyle(el).backgroundColor.match(/\d+/g) || []).slice(0, 3).reduce((sum, value) => sum + Number(value), 0)); expect.soft(color).toBeLessThan(200);
        }
      }
      expect.soft((await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    }
  }
}
for (const current of [true, false]) test(`${current ? 'current' : 'V2'} draft review opens a relevant confirmation and cancel restores keyboard editing without publishing`, async ({ page }, info) => {
  test.setTimeout(90000);
  const draft = await create(page, fields);
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cases/posting/publications') writes++; });
  await page.goto(current ? `/create-case.html?draftId=${draft.id}#details` : `/attorney-v2.html#/matters/new?draftId=${draft.id}`, { waitUntil: 'domcontentloaded' });
  await expect(recovery(page)).toHaveAttribute('data-state', 'ready');
  await page.screenshot({ path: info.outputPath('initial-details.png'), fullPage: true });
  await expect(publication(page)).toBeHidden();
  await capture(page, info, current, 'details');
  if (current) {
    const menu = page.locator('#sidebarToggle'), header = page.getByRole('group', { name: 'Workspace tools', exact: true });
    const m = await menu.boundingBox(), h = await header.boundingBox(); expect(m.height).toBeGreaterThanOrEqual(44); expect(Math.abs((m.y + m.height / 2) - (h.y + h.height / 2))).toBeLessThanOrEqual(2);
    await menu.click(); await expect(menu).toHaveAttribute('aria-expanded', 'true'); await menu.click(); await expect(menu).toHaveAttribute('aria-expanded', 'false');
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  if (current) await page.locator('[data-step="details"] [data-step-link="description"]').click();
  else await page.getByRole('button', { name: 'Continue to description', exact: true }).click();
  await capture(page, info, current, 'description');
  if (current) await page.locator('[data-step="description"] [data-step-link="review"]').click();
  else await page.getByRole('button', { name: '3. Review', exact: true }).click();
  const review = page.locator(current ? '#reviewSummary' : '.av2-draft-review'); await expect(review).toContainText('First retained paragraph.'); await expect(review).toContainText('Second retained paragraph.');
  if (!current) {
    await expect(review.getByRole('heading', { name: 'Compensation', exact: true }).locator('+ p')).toHaveText('$400.01');
    await expect(review.getByRole('heading', { name: 'Deadline', exact: true }).locator('+ p')).toHaveText('Mar 14, 2027');
    await expect(page.getByRole('link', { name: 'Return to drafts', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Save and return to drafts', exact: true })).toBeEnabled();
  }
  await expect(publication(page)).toBeHidden(); await capture(page, info, current, 'review');
  const open = current ? page.locator('#postBtn') : page.getByRole('button', { name: 'Review publishing confirmation', exact: true });
  await open.focus(); await open.press('Enter'); await expect(publication(page)).toBeVisible();
  await expect(publication(page).getByRole('button', { name: 'Confirm and publish Matter', exact: true })).toBeVisible();
  await capture(page, info, current, 'confirmation');
  const cancel = publication(page).getByRole('button', { name: 'Keep editing draft', exact: true }); await cancel.focus(); await cancel.press('Enter');
  await expect(publication(page)).toBeHidden(); await expect(open).toBeFocused();
  expect(writes).toBe(0);
  const saved = await page.request.get(`/api/case-drafts/${draft.id}`); expect(saved.ok()).toBe(true); expect((await saved.json()).draft).toMatchObject(fields);
});

for (const current of [true, false]) test(`${current ? 'current' : 'V2'} review includes the entire saved description and all tasks`, async ({ page }) => {
  const description = 'First paragraph with <retained & exact> details.\n\n' + 'This saved requirement must remain available for review. '.repeat(40) + '\n\nFINAL_SAVED_REQUIREMENT';
  const values = { ...fields, description, tasks: Array.from({ length: 25 }, (_, i) => ({ title: `Task ${i + 1}: retain this complete requirement for the published Matter.` })) };
  const draft = await create(page, values);
  await page.goto(current ? `/create-case.html?draftId=${draft.id}#review` : `/attorney-v2.html#/matters/new?draftId=${draft.id}&step=review`, { waitUntil: 'domcontentloaded' });
  await expect(recovery(page)).toHaveAttribute('data-state', 'ready');
  const review = page.locator(current ? '#reviewSummary' : '.av2-draft-review');
  await expect(review).toContainText('FINAL_SAVED_REQUIREMENT');
  await expect(review).toContainText('<retained & exact>');
  await expect(review).toContainText(values.tasks[24].title);
  if (current) {
    await expect(review.locator('.summary-wide > p').first()).toHaveText(description, { useInnerText: true });
    await expect(review.locator('.review-task-list li')).toHaveCount(25);
    expect(await review.locator('.review-task-list').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  }
  const saved = await page.request.get(`/api/case-drafts/${draft.id}`); expect((await saved.json()).draft).toMatchObject(values);
});

test('V2 finishing a held draft save does not take focus from navigation selected during publication review', async ({ page }) => {
  const draft = await create(page, fields);
  await page.goto(`/attorney-v2.html#/matters/new?draftId=${draft.id}&step=description`, { waitUntil: 'domcontentloaded' });
  await expect(recovery(page)).toHaveAttribute('data-state', 'ready');
  let release, arrived, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
  await page.route(`**/api/case-drafts/${draft.id}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++; arrived(); await gate; await route.continue();
  });
  try {
    await page.locator('#av2-draft-description').fill('Retained edits before the explicit publication review.');
    await page.getByRole('button', { name: 'Review draft', exact: true }).click();
    await page.getByRole('button', { name: 'Review publishing confirmation', exact: true }).click(); await pending;
    const home = page.getByRole('link', { name: 'Home', exact: true }); await home.focus(); release();
    await expect(publication(page).getByRole('button', { name: 'Confirm and publish Matter', exact: true })).toBeVisible();
    await expect(home).toBeFocused(); expect(writes).toBe(1);
    const saved = await page.request.get(`/api/case-drafts/${draft.id}`); expect((await saved.json()).draft.description).toBe('Retained edits before the explicit publication review.');
  } finally { release(); }
});

for (const current of [true, false]) test(`${current ? 'current' : 'V2'} oversized saved task lists stay complete and become publishable after explicit correction`, async ({ page }) => {
  const values = { ...fields, tasks: Array.from({ length: 26 }, (_, i) => ({ title: `Retained task ${i + 1}` })) };
  const draft = await create(page, values); let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cases/posting/publications') writes++; });
  await page.goto(current ? `/create-case.html?draftId=${draft.id}#review` : `/attorney-v2.html#/matters/new?draftId=${draft.id}&step=review`, { waitUntil: 'domcontentloaded' });
  await expect(recovery(page)).toHaveAttribute('data-state', 'ready');
  const review = page.locator(current ? '#reviewSummary' : '.av2-draft-review');
  await expect(review).toContainText('Retained task 26');
  await expect(page.getByRole('alert').filter({ hasText: 'Use 25 tasks or fewer before publishing.' })).toBeVisible();
  const publish = current ? page.locator('#postBtn') : page.getByRole('button', { name: 'Review publishing confirmation', exact: true }); await expect(publish).toBeDisabled();
  const unchanged = await page.request.get(`/api/case-drafts/${draft.id}`); expect((await unchanged.json()).draft.tasks).toEqual(values.tasks);
  if (current) {
    await page.locator('[data-step="review"] [data-step-switch="description"]').click();
    await page.locator('#caseTaskList li').filter({ hasText: 'Retained task 26' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await page.locator('[data-step="description"] [data-step-link="review"]').click();
  } else {
    await page.getByRole('button', { name: 'Back to description', exact: true }).click();
    await page.getByRole('button', { name: 'Remove task 26', exact: true }).click();
    await page.getByRole('button', { name: 'Review draft', exact: true }).click();
  }
  await expect(publish).toBeEnabled(); await expect(review).not.toContainText('Retained task 26');
  await expect.poll(async () => (await (await page.request.get(`/api/case-drafts/${draft.id}`)).json()).draft.tasks).toEqual(values.tasks.slice(0, 25));
  expect(writes).toBe(0);
});

test('current listing preview preserves full saved content and keyboard return across themes and enlarged text', async ({ page }, info) => {
  test.setTimeout(90000);
  const values = { ...fields, description: 'First retained paragraph.\n\n' + 'Retain this private review detail. '.repeat(40) + '\n\nFINAL_PREVIEW_REQUIREMENT', tasks: Array.from({ length: 26 }, (_, i) => ({ title: `Full preview task ${i + 1}` })) };
  const draft = await create(page, values);
  await page.goto(`/create-case.html?draftId=${draft.id}#review`, { waitUntil: 'domcontentloaded' }); await expect(recovery(page)).toHaveAttribute('data-state', 'ready');
  const open = page.getByRole('button', { name: 'Preview Listing', exact: true }), dialog = page.getByRole('dialog');
  for (const [width, theme, text] of [[1440, 'light', '100%'], [390, 'light', '100%'], [390, 'dark', '100%'], [320, 'dark', '200%']]) {
    await savedTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ theme, text }) => { window.applyThemePreference(theme); document.documentElement.style.fontSize = text; }, { theme, text }); await page.waitForTimeout(350);
    await open.focus(); await open.press('Enter'); await expect(dialog).toBeVisible(); await expect(dialog).toBeFocused();
    await expect(dialog.locator('#previewDescription')).toHaveText(values.description); await expect(dialog.locator('.task-list li')).toHaveCount(26);
    await expect(dialog.getByRole('alert')).toHaveText('Use 25 tasks or fewer before publishing.');
    await dialog.getByRole('heading').first().scrollIntoViewIfNeeded();
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const bounds = await dialog.boundingBox(); expect.soft(bounds.x).toBeGreaterThanOrEqual(0); expect.soft(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect.soft(bounds.y).toBeGreaterThanOrEqual(0); expect.soft(bounds.y + bounds.height).toBeLessThanOrEqual(1001);
    await expect(dialog.getByRole('heading').first()).toBeInViewport({ ratio: 1 });
    expect.soft(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`preview-${width}-${theme}-${text}.png`), fullPage: true });
    expect.soft((await new AxeBuilder({ page }).include('#previewModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    const close = dialog.getByRole('button', { name: 'Close Preview', exact: true }); await close.focus(); await expect(close).toBeFocused();
    await expect(close).toBeInViewport({ ratio: 1 });
    expect(await close.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    await page.screenshot({ path: info.outputPath(`preview-actions-${width}-${theme}-${text}.png`), fullPage: true });
    await page.keyboard.press('Tab');
    const feeHelp = dialog.locator('summary'); await expect(feeHelp).toBeFocused();
    await feeHelp.press('Enter'); await expect(dialog.locator('.preview-fee-details')).toHaveAttribute('open', '');
    await expect(dialog.locator('.preview-fee-details')).toContainText('The platform fee is not a fee for legal services.');
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await feeHelp.press('Enter'); await page.keyboard.press('Shift+Tab'); await expect(close).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(open).toBeFocused();
  }
  const saved = await page.request.get(`/api/case-drafts/${draft.id}`); expect((await saved.json()).draft).toMatchObject(values);
});
