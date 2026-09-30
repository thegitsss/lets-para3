const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function request(page, method, path, data) {
  const csrf = await (await page.context().request.get(server.origin + '/api/csrf')).json();
  return page.context().request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
}
async function api(page, method, path, data) {
  const response = await request(page, method, path, data);
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function actors(browser) {
  const result = {}, errors = [];
  for (const role of ['attorney', 'paralegal']) {
    const user = await server.createUser(role, {}, true), context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    context.setDefaultTimeout(15000); await context.addCookies([user.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage(); page.on('pageerror', error => errors.push({ role, message: error.message }));
    result[role] = { ...user, page };
  }
  return { ...result, errors };
}
async function publish(attorney, title) {
  const value = await api(attorney.page, 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and organize supporting evidence for review.', tasks: [{ title: 'Prepare filing package' }] });
  return { id: String(value.case?._id || value.case?.id || value._id || value.id), jobId: String(value.jobId) };
}
async function finish(people, info) {
  await fs.writeFile(info.outputPath('request-evidence.json'), JSON.stringify({ ...server.evidence(), errors: people.errors }, null, 2));
  for (const role of ['attorney','paralegal']) { await people[role].page.screenshot({ path: info.outputPath(role + '-last.png') }).catch(() => {}); await people[role].page.context().close(); }
}
for (const entry of ['current','v2']) test(`actual ${entry} contextual applicant block preserves the application and stops future interaction`, async ({ browser }, info) => {
  const people = await actors(browser), { attorney, paralegal } = people;
  try {
    const matter = await publish(attorney, 'River Street screening');
    await api(paralegal.page, 'post', `/api/jobs/${matter.jobId}/apply`, { coverLetter: 'I can organize the filing package and supporting evidence for review.' });
    const applicationBefore = await api(attorney.page, 'get', `/api/cases/${matter.id}/application-review?expectedOwnerId=${attorney.id}`);
    if (entry === 'current') {
      await attorney.page.goto(server.origin + '/dashboard-attorney.html#cases:inquiries');
      await attorney.page.locator(`.matter-queue-row[data-case-id="${matter.id}"]:visible`).getByRole('button', { name: 'Review 1 applicant', exact: true }).click();
    } else await attorney.page.goto(`${server.origin}/attorney-v2.html#/matters/${matter.id}/applications?applicantId=${paralegal.id}`);
    const block = attorney.page.getByRole('button', { name: 'Block applicant', exact: true });
    await expect(block).toBeVisible();
    // Capture the actual action, after responsive transitions have settled.
    if (entry === 'v2') {
      await attorney.page.setViewportSize({ width: 390, height: 900 });
      await attorney.page.evaluate(() => { document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark'); document.documentElement.style.fontSize = '20px'; });
    }
    await block.scrollIntoViewIfNeeded();
    await attorney.page.screenshot({ path: info.outputPath('contextual-action-before.png'), animations: 'disabled' });
    const noticesBefore = await api(paralegal.page, 'get', '/api/notifications/'), mailBefore = server.evidence().external.mail.length;
    await block.click();
    const confirmation = entry === 'current' ? attorney.page.getByRole('dialog', { name: 'Block River paralegal?', exact: true }) : attorney.page.locator('[data-contextual-block]');
    const confirm = confirmation.getByRole('button', { name: entry === 'current' ? 'Block applicant' : 'Confirm block', exact: true });
    await expect(confirm).toBeVisible();
    if (entry === 'v2') { await expect(confirmation.getByRole('button', { name: 'Keep interaction available', exact: true })).toBeFocused(); await confirmation.screenshot({ path: info.outputPath('contextual-confirmation-390-dark.png'), animations: 'disabled' }); }
    await confirmation.getByRole('button', { name: entry === 'current' ? 'Cancel' : 'Keep interaction available', exact: true }).click();
    expect(await api(attorney.page, 'get', `/api/blocks/${paralegal.id}?expectedOwnerId=${attorney.id}`)).toMatchObject({ blocked: false });
    let writes = 0, failReadback = entry === 'v2';
    if (entry === 'v2') {
      await attorney.page.route('**/api/blocks', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        writes++; const response = await route.fetch(); expect(response.status()).toBe(201);
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic interrupted confirmation' }) });
      });
      await attorney.page.route(`**/api/blocks/${paralegal.id}?*`, route => failReadback ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
    }
    await block.click(); await confirm.click();
    await expect.poll(async () => (await api(attorney.page, 'get', `/api/blocks/${paralegal.id}?expectedOwnerId=${attorney.id}`)).blocked).toBe(true);
    if (entry === 'v2') {
      const check = attorney.page.getByRole('button', { name: 'Check block result', exact: true });
      await expect(check).toBeVisible(); await check.click();
      await expect(attorney.page.locator('[data-contextual-block]')).toContainText('The block result could not be confirmed.');
      expect(writes).toBe(1); failReadback = false; await check.click();
      await expect(attorney.page.getByText('Future interaction is blocked.', { exact: true })).toBeVisible();
      expect(writes).toBe(1);
    }
    await expect(attorney.page.getByText(entry === 'current' ? 'Applicant blocked from future interaction.' : 'Future interaction is blocked.', { exact: true })).toBeVisible();
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    expect(await api(paralegal.page, 'get', '/api/notifications/')).toEqual(noticesBefore);
    const applicationAfter = await api(attorney.page, 'get', `/api/cases/${matter.id}/application-review?expectedOwnerId=${attorney.id}`);
    expect(applicationAfter.applications[0].coverLetter).toBe(applicationBefore.applications[0].coverLetter);
    expect(applicationAfter.applications[0]).toMatchObject({ blocked: true, profileAvailable: false });
    const browse = await api(paralegal.page, 'get', '/api/jobs/open?view=browse');
    expect(JSON.stringify(browse)).not.toContain(matter.id);
    expect((await request(attorney.page, 'get', `/api/paralegals/${paralegal.id}`)).status()).toBe(403);
    expect((await api(attorney.page, 'get', `/api/cases/${matter.id}/hiring-review/${paralegal.id}?expectedOwnerId=${attorney.id}`)).reason).toBe('blocked');
    const next = await publish(attorney, 'River Street next filing');
    expect((await request(paralegal.page, 'post', `/api/jobs/${next.jobId}/apply`, { coverLetter: 'Another filing.' })).status()).toBe(403);
    expect((await api(attorney.page, 'get', `/api/cases/${next.id}/invitation-review/${paralegal.id}?expectedOwnerId=${attorney.id}`)).canInvite).toBe(false);
    if (entry === 'v2') {
      await attorney.page.locator('[data-contextual-block]').scrollIntoViewIfNeeded();
      expect(await attorney.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await attorney.page.locator('[data-contextual-block]').screenshot({ path: info.outputPath('contextual-saved-390-dark.png'), animations: 'disabled' });
    }
    await attorney.page.screenshot({ path: info.outputPath('contextual-action-after.png'), animations: 'disabled' });
    expect(people.errors).toEqual([]);
  } finally { await finish(people, info); }
});

test('actual paralegal finalized-withdrawal block preserves history and silently restricts future contact', async ({ browser }, info) => {
  const people = await actors(browser), { attorney, paralegal } = people;
  try {
    const matter = await publish(attorney, 'River Street prior assignment');
    await api(paralegal.page, 'post', `/api/jobs/${matter.jobId}/apply`, { coverLetter: 'I can organize the filing package and supporting evidence for review.' });
    await api(attorney.page, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(attorney.page, 'get', `/api/cases/${matter.id}/hiring-review/${paralegal.id}?expectedOwnerId=${attorney.id}`);
    await api(attorney.page, 'post', `/api/cases/${matter.id}/hire/${paralegal.id}`, { expectedOwnerId: attorney.id, reviewedRevision: review.revision });
    await paralegal.page.goto(`${server.origin}/paralegal-v2.html#/matter/${matter.id}?tab=work`);
    await paralegal.page.locator('.v2-matter-options > summary').click();
    await paralegal.page.locator('[data-v2-withdraw-matter]').click();
    await paralegal.page.getByRole('dialog', { name: 'Withdraw from this matter?' }).getByRole('button', { name: 'Withdraw from matter', exact: true }).click();
    await expect.poll(async () => (await server.inspect(matter.id)).case.payoutFinalizedType).toBe('zero_auto');
    await paralegal.page.goto(`${server.origin}/paralegal-v2.html#/work?section=history`);
    await expect(paralegal.page.locator('#v2-work-history')).toContainText('River Street prior assignment');
    const block = paralegal.page.getByRole('button', { name: 'Block attorney', exact: true });
    await block.click();
    let dialog = paralegal.page.getByRole('dialog', { name: 'Block this attorney?', exact: true });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await api(paralegal.page, 'get', `/api/blocks/${attorney.id}?expectedOwnerId=${paralegal.id}`)).toMatchObject({ blocked: false });
    const noticesBefore = await api(attorney.page, 'get', '/api/notifications/'), mailBefore = server.evidence().external.mail.length;
    await block.click(); await dialog.getByRole('button', { name: 'Block attorney', exact: true }).click();
    await expect.poll(async () => (await api(paralegal.page, 'get', `/api/blocks/${attorney.id}?expectedOwnerId=${paralegal.id}`)).blocked).toBe(true);
    await expect(paralegal.page.locator('#v2-work-history')).toContainText('River Street prior assignment');
    await expect(paralegal.page.getByRole('link', { name: 'Blocked · manage in Settings', exact: true })).toBeVisible();
    expect(server.evidence().external.mail.length).toBe(mailBefore);
    expect(await api(attorney.page, 'get', '/api/notifications/')).toEqual(noticesBefore);
    const retained = await server.inspect(matter.id);
    expect(retained.case).toMatchObject({ payoutFinalizedType: 'zero_auto', partialPayoutAmount: 0, remainingAmount: 40000 });
    expect(retained.payouts).toEqual([]);
    const next = await publish(attorney, 'River Street future assignment');
    expect(JSON.stringify(await api(paralegal.page, 'get', '/api/jobs/open?view=browse'))).not.toContain(next.id);
    expect((await request(paralegal.page, 'post', `/api/jobs/${next.jobId}/apply`, { coverLetter: 'Another filing.' })).status()).toBe(403);
    expect((await request(attorney.page, 'post', `/api/messages/${matter.id}`, { text: 'No new contact.' })).status()).toBe(403);
    await paralegal.page.setViewportSize({ width: 390, height: 900 });
    await paralegal.page.evaluate(() => { document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark'); document.documentElement.style.fontSize = '20px'; });
    await expect.poll(() => paralegal.page.locator('.v2-app-frame').evaluate(element => Math.abs(element.getBoundingClientRect().x))).toBeLessThan(2);
    await expect(paralegal.page.locator('#v2-work-history')).not.toContainText('Refreshing payout details');
    await paralegal.page.screenshot({ path: info.outputPath('blocked-history-390-dark.png'), animations: 'disabled' });
    expect(await paralegal.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(people.errors).toEqual([]);
  } finally { await finish(people, info); }
});

test('actual attorney finalized-withdrawal overview offers a contextual block while keeping financial history', async ({ browser }, info) => {
  const people = await actors(browser), { attorney, paralegal } = people;
  try {
    const matter = await publish(attorney, 'River Street finalized withdrawal');
    await api(paralegal.page, 'post', `/api/jobs/${matter.jobId}/apply`, { coverLetter: 'I can organize the filing package and supporting evidence for review.' });
    await api(attorney.page, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(attorney.page, 'get', `/api/cases/${matter.id}/hiring-review/${paralegal.id}?expectedOwnerId=${attorney.id}`);
    await api(attorney.page, 'post', `/api/cases/${matter.id}/hire/${paralegal.id}`, { expectedOwnerId: attorney.id, reviewedRevision: review.revision });
    await paralegal.page.goto(`${server.origin}/paralegal-v2.html#/matter/${matter.id}?tab=work`);
    await paralegal.page.locator('.v2-matter-options > summary').click();
    await paralegal.page.locator('[data-v2-withdraw-matter]').click();
    await paralegal.page.getByRole('dialog', { name: 'Withdraw from this matter?' }).getByRole('button', { name: 'Withdraw from matter', exact: true }).click();
    await expect.poll(async () => (await server.inspect(matter.id)).case.payoutFinalizedType).toBe('zero_auto');
    await attorney.page.goto(`${server.origin}/attorney-v2.html#/matters/${matter.id}/overview`);
    const block = attorney.page.getByRole('button', { name: 'Block paralegal', exact: true });
    await expect(block).toBeVisible(); await block.click();
    await expect(attorney.page.getByRole('button', { name: 'Keep interaction available', exact: true })).toBeFocused();
    // macOS WebKit uses Option+Tab to include buttons in sequential navigation.
    await attorney.page.keyboard.press(info.project.name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
    await expect(attorney.page.getByRole('button', { name: 'Confirm block', exact: true })).toBeFocused();
    await attorney.page.keyboard.press('Enter');
    await expect(attorney.page.getByText('Future interaction is blocked.', { exact: true })).toBeVisible();
    expect(await api(attorney.page, 'get', `/api/blocks/${paralegal.id}?expectedOwnerId=${attorney.id}`)).toMatchObject({ blocked: true });
    await expect(attorney.page.getByRole('link', { name: 'Manage blocked users', exact: true })).toBeFocused();
    await attorney.page.locator('[data-contextual-block]').screenshot({ path: info.outputPath('finalized-block-focus.png'), animations: 'disabled' });
    await attorney.page.goto(`${server.origin}/attorney-v2.html#/matters/${matter.id}/financials`);
    await expect(attorney.page.locator('[data-workspace-withdrawal]')).toContainText('No payout was issued for this decision.');
    await expect(attorney.page.locator('[data-workspace-funding]')).toHaveAttribute('data-state', 'ready');
    await attorney.page.locator('[data-workspace-withdrawal]').scrollIntoViewIfNeeded();
    await attorney.page.screenshot({ path: info.outputPath('blocked-retained-financials.png'), animations: 'disabled' });
    expect(people.errors).toEqual([]);
  } finally { await finish(people, info); }
});
