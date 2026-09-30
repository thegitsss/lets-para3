const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sourceFiles = ['frontend/assets/scripts/attorney-v2/workspace-messages.mjs', 'frontend/assets/scripts/paralegal-v2/matter-messages.mjs', 'backend/routes/messages.js'];
async function sourceHashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, crypto.createHash('sha256').update(await fs.readFile(path.resolve(__dirname, '../../../..', file))).digest('hex')]))); }
const start = require('../../helpers/financialLifecycleBrowserServer');
let server, startupMs;
// Match the existing Attorney V2 disposable-replica startup allowance.
test.beforeAll(async () => { test.setTimeout(240000); const started = Date.now(); server = await start({ port: 0 }); startupMs = Date.now() - started; });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function api(page, method, path, body) {
  const csrf = await (await page.context().request.get(server.origin + '/api/csrf')).json();
  const response = await page.context().request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(body ? { data: body } : {}) });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}
const input = (page, role) => page.getByRole('textbox', { name: role === 'attorney' ? 'Message to the paralegal' : 'Write a message', exact: true });
const own = page => page.locator('[data-message-own="true"]').last();
async function action(page, label) {
  await own(page).hover(); await own(page).locator('summary').click();
  await own(page).getByRole('button', { name: label === 'Edit message' ? /^Edit(?: message)?$/ : /^Delete(?: message)?$/ }).click();
}

test('both authenticated V2 shells send, read, edit, cancel and delete through real messaging routes', async ({ browser }, info) => {
  const people = {}, errors = [], sourceBefore = await sourceHashes();
  try {
    for (const role of ['attorney', 'paralegal']) {
      const user = await server.createUser(role, {}, true);
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
      await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage(); page.on('pageerror', error => errors.push({ role, message: error.message }));
      people[role] = { ...user, role, page, context };
    }
    const { attorney, paralegal } = people;
    const posted = await api(attorney.page, 'post', '/api/cases', { title: 'Synthetic conversation verification', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the exhibit index and organize supporting evidence for review.', tasks: [{ title: 'Prepare exhibit index' }] });
    const matterId = String(posted.case?._id || posted.case?.id || posted._id || posted.id);
    await api(paralegal.page, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'I can organize the exhibits for your review.' });
    await api(attorney.page, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(attorney.page, 'get', `/api/cases/${matterId}/hiring-review/${paralegal.id}?expectedOwnerId=${attorney.id}`);
    await api(attorney.page, 'post', `/api/cases/${matterId}/hire/${paralegal.id}`, { expectedOwnerId: attorney.id, reviewedRevision: review.revision });
    for (const person of Object.values(people)) {
      await person.page.goto(`${server.origin}/${person.role}-v2.html#/conversations?matter=${matterId}`);
      await expect(person.page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state', 'ready');
      await expect(input(person.page, person.role)).toBeVisible();
      await expect(person.page.getByRole('button', { name: 'Attach document', exact: true })).toBeVisible();
    }
    for (const sender of Object.values(people)) {
      const recipient = sender === attorney ? paralegal : attorney;
      const page = sender.page, composer = input(page, sender.role);
      await composer.fill('hi');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(own(page).locator('.av2-preserve-lines')).toHaveText('hi');
      await expect(input(page, sender.role)).toHaveValue('');
      await expect(recipient.page.locator('.av2-preserve-lines').filter({ hasText: /^hi$/ })).toBeVisible();
      await expect.poll(async () => (await api(recipient.page, 'get', '/api/messages/unread-count')).count).toBe(0);
      expect(await own(page).locator('.av2-preserve-lines').evaluate(e => e.getBoundingClientRect().width)).toBeLessThan(100);
      await composer.fill('Unsent reply stays separate');
      await action(page, 'Edit message');
      await page.getByRole('textbox', { name: 'Message text', exact: true }).fill('Please retain the original page references.');
      await page.getByRole('button', { name: 'Save message', exact: true }).click();
      await expect(own(page).locator('.av2-preserve-lines')).toHaveText('Please retain the original page references.');
      await expect(composer).toHaveValue('Unsent reply stays separate');
      await expect(recipient.page.locator('.av2-preserve-lines').filter({ hasText: 'Please retain the original page references.' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${sender.role}-desktop.png`) });
      await action(page, 'Delete message');
      await page.getByRole('button', { name: 'Keep message', exact: true }).click();
      await expect(own(page).locator('.av2-preserve-lines')).toHaveText('Please retain the original page references.');
      await action(page, 'Delete message');
      await page.getByRole('dialog').getByRole('button', { name: 'Delete message', exact: true }).click();
      await expect(page.locator('.av2-preserve-lines').filter({ hasText: 'Please retain the original page references.' })).toHaveCount(0);
      await expect(recipient.page.locator('.av2-preserve-lines').filter({ hasText: 'Please retain the original page references.' })).toHaveCount(0);
      await expect(composer).toHaveValue('Unsent reply stays separate');
      // Confidential unsent correspondence is memory-only by design.
      await page.reload();
      await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state', 'ready');
      await expect(composer).toHaveValue('');
      await expect(page.locator('.av2-preserve-lines').filter({ hasText: 'Please retain the original page references.' })).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('button', { name: '← Conversations', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${sender.role}-mobile.png`) });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await composer.clear();
    }
    expect(errors).toEqual([]);
    expect(await sourceHashes()).toEqual(sourceBefore);
  } finally {
    await fs.writeFile(info.outputPath('integration-evidence.json'), JSON.stringify({ startupMs, sourceBefore, sourceAfter: await sourceHashes(), ...server.evidence(), errors }, null, 2));
    for (const person of Object.values(people)) await person.context.close();
  }
});
