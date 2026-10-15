const { test, expect } = require(process.env.LPC_WORKSPACE_ACTUAL_FIXTURE === 'true' ? '../workspace-paired-observation.cjs' : 'playwright/test');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0, includeSyntheticDownloads: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function api(person, method, path, data) {
  const req = person.context.request;
  const csrf = await (await req.get(server.origin + '/api/csrf')).json();
  const response = await req[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}
async function pair(browser) {
  const people = {};
  for (const role of ['attorney', 'paralegal']) {
    const user = await server.createUser(role, {}, true), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([user.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    people[role] = { ...user, role, context, page: await context.newPage() };
  }
  return people;
}
async function engage(people) {
  const posted = await api(people.attorney, 'post', '/api/cases', { title: 'River Street shared review', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the exhibit index and check supporting evidence.', tasks: [{ title: 'Prepare exhibit index' }] });
  const id = String(posted.case?._id || posted._id || posted.id);
  await api(people.paralegal, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'I can prepare the index and check the evidence.' });
  await api(people.attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
  const review = await api(people.attorney, 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
  await api(people.attorney, 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: review.revision });
  return id;
}
const matterUrl = (person, id, tab) => `${server.origin}/${person.role}-v2.html${person.role === 'attorney' ? `#/matters/${id}/${tab}` : `#/matter/${id}?tab=${tab}`}`;

test('shared submissions and revisions update the other participant without reload; private notes stay private', async ({ browser }, info) => {
  const people = await pair(browser), checkpoints = [], errors = [];
  for (const person of Object.values(people)) person.page.on('pageerror', error => errors.push(error.message));
  try {
    const id = await engage(people), { attorney, paralegal } = people;
    await paralegal.page.goto(matterUrl(paralegal, id, 'work'));
    const submissionStatus = paralegal.page.locator('[data-v2-work-submissions]');
    await expect(submissionStatus.getByRole('link', { name: 'Submit work', exact: true })).toBeVisible();
    await submissionStatus.getByRole('link', { name: 'Submit work', exact: true }).focus();
    await paralegal.page.keyboard.press('Enter');
    await expect(paralegal.page.locator('[data-v2-file-input]')).toBeAttached();
    await attorney.page.goto(matterUrl(attorney, id, 'files'));
    const panel = attorney.page.locator('[data-workspace-files]');
    await expect(panel).toHaveAttribute('data-state', 'ready');
    const bytes = Buffer.from('Exhibit index\n\n1. Original evidence\n');
    await paralegal.page.locator('[data-v2-file-input]').setInputFiles({ name: 'Exhibit index.txt', mimeType: 'text/plain', buffer: bytes });
    await paralegal.page.getByRole('button', { name: 'Submit file', exact: true }).click();
    const dialog = paralegal.page.getByRole('dialog', { name: 'Submit this file?' });
    const upload = paralegal.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/uploads/case/${id}`);
    await dialog.getByRole('button', { name: 'Submit file', exact: true }).click();
    expect((await upload).status()).toBe(201);
    const uploadedAt = Date.now();
    await expect(panel.getByRole('button', { name: 'Exhibit index.txt', exact: true })).toBeVisible({ timeout: 5000 });
    checkpoints.push({ state: 'file visible to attorney without reload', elapsedMs: Date.now() - uploadedAt });
    const files = await api(paralegal, 'get', `/api/uploads/case/${id}?presentation=matter`), file = files.files.find(item => item.originalName === 'Exhibit index.txt');
    await panel.locator(`[data-download-file="${file.id}"]`).getByRole('button').click();
    const detail = panel.getByRole('region', { name: 'Document review' });
    await detail.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(detail.locator('pre')).toHaveText(bytes.toString());
    const download = attorney.page.waitForEvent('download');
    await detail.getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await fs.readFile(await (await download).path())).toEqual(bytes);
    const paraDownload = await paralegal.context.request.get(`${server.origin}/api/uploads/case/${id}/${file.id}/download`);
    expect(paraDownload.ok()).toBe(true); expect(await paraDownload.body()).toEqual(bytes);
    checkpoints.push({ state: 'preview and downloads preserve uploaded bytes', provider: 'in-memory object storage' });
    await paralegal.page.goto(matterUrl(paralegal, id, 'work'));
    await expect(submissionStatus).toContainText('1 awaiting review');
    await detail.getByLabel('Revision instructions (optional)').fill('Add the missing exhibit date.');
    await detail.getByRole('button', { name: 'Request revisions', exact: true }).click();
    await detail.getByRole('button', { name: 'Confirm revision request', exact: true }).click();
    const revisedAt = Date.now();
    await expect(submissionStatus).toContainText('1 revision requested', { timeout: 5000 });
    await expect(submissionStatus.getByRole('link', { name: 'Submit revised work', exact: true })).toBeVisible();
    checkpoints.push({ state: 'revision visible on paralegal Work without reload', elapsedMs: Date.now() - revisedAt });
    await paralegal.page.screenshot({ path: info.outputPath('paralegal-revision-work-desktop.png') });
    await attorney.page.goto(matterUrl(attorney, id, 'overview'));
    await attorney.page.getByRole('button', { name: 'Add note', exact: true }).click();
    const secret = 'Private strategy: retain the original review checklist.';
    await attorney.page.getByRole('textbox', { name: 'Notes', exact: true }).fill(secret);
    await attorney.page.getByRole('button', { name: 'Save Matter note', exact: true }).click();
    await expect(attorney.page.locator('[data-note-feedback]')).toContainText('saved', { ignoreCase: true });
    const forbidden = await paralegal.context.request.get(`${server.origin}/api/cases/${id}/notes`);
    expect(forbidden.status()).toBe(403); expect(await forbidden.text()).not.toContain(secret);
    for (const role of ['attorney', 'paralegal']) {
      const outsider = await server.createUser(role, {}, true), context = await browser.newContext();
      try {
        await context.addCookies([outsider.cookie]);
        for (const path of [`/api/cases/${id}?presentation=matter`, `/api/messages/${id}`, `/api/uploads/case/${id}?presentation=matter`]) {
          const response = await context.request.get(server.origin + path);
          expect([403, 404], `${role} outsider ${path}`).toContain(response.status());
          expect(await response.text()).not.toContain(secret);
          expect(await response.text()).not.toContain('River Street shared review');
        }
      } finally { await context.close(); }
    }
    checkpoints.push({ state: 'both outsider roles denied Matter, message and file reads' });
    for (const person of Object.values(people)) {
      await person.page.goto(matterUrl(person, id, 'work'));
      if (person.role === 'attorney') {
        await expect(person.page.locator('[data-workspace-work]')).toHaveAttribute('data-state', 'ready');
        await expect(person.page.locator('.av2-matter-review-summary')).toHaveAttribute('data-state', 'ready');
      } else await expect(person.page.locator('[data-v2-work-submissions]')).toContainText('1 revision requested');
      const sections = await person.page.locator(person.role === 'attorney' ? '.av2-matter-tabs a' : '.v2-matter-tabs a').allTextContents();
      expect(sections.filter(section => section !== 'Applications')).toEqual(['Overview', 'Work', 'Files', 'Messages', 'Deadlines', 'Activity', 'Financials']);
      for (const width of [1440, 390, 320]) {
        await person.page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await expect(person.page.getByRole('heading', { name: 'River Street shared review', exact: true })).toBeVisible();
        expect(await person.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await person.page.screenshot({ path: info.outputPath(`${person.role}-work-${width}.png`) });
      }
      await expect(person.page.locator('main iframe')).toHaveCount(0);
      // This scope has no frames. Analyze it in place without an auxiliary
      // browser page competing with the two active participant workspaces.
      expect((await new AxeBuilder({ page: person.page }).include('main').setLegacyMode().analyze()).violations).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await fs.writeFile(info.outputPath('shared-workspace-evidence.json'), JSON.stringify({ checkpoints, errors, requests: server.evidence().requests }, null, 2));
    for (const person of Object.values(people)) await person.context.close();
  }
});

test('messages remain live with alerts disabled and notification links return to the exact conversation', async ({ browser }, info) => {
  const people = await pair(browser), latency = [];
  try {
    const id = await engage(people);
    for (const person of Object.values(people)) {
      await api(person, 'patch', '/api/users/me/notification-prefs', { email: false, inApp: false, expectedOwnerId: person.id, expectedValues: { email: true, inApp: true } });
      await person.page.goto(`${server.origin}/${person.role}-v2.html#/conversations?matter=${id}`);
      await expect(person.page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state', 'ready');
    }
    for (const sender of Object.values(people)) {
      const recipient = sender === people.attorney ? people.paralegal : people.attorney;
      const text = `Live ${sender.role} reply ${crypto.randomUUID()}`;
      const input = sender.page.getByRole('textbox', { name: sender.role === 'attorney' ? 'Message to the paralegal' : 'Write a message', exact: true });
      await input.fill(text);
      const started = Date.now();
      await sender.page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(recipient.page.locator('.av2-preserve-lines').filter({ hasText: text })).toBeVisible({ timeout: 5000 });
      latency.push({ sender: sender.role, elapsedMs: Date.now() - started });
      await expect(input).toHaveValue('');
      await expect.poll(async () => (await api(recipient, 'get', '/api/messages/unread-count')).count).toBe(0);
    }
    for (const sender of Object.values(people)) {
      const recipient = sender === people.attorney ? people.paralegal : people.attorney;
      await recipient.page.goto(matterUrl(recipient, id, 'work'));
      const text = `Menu stability for ${sender.role}`;
      const input = sender.page.getByRole('textbox', { name: sender.role === 'attorney' ? 'Message to the paralegal' : 'Write a message', exact: true });
      await input.fill(text);
      await sender.page.getByRole('button', { name: 'Send message', exact: true }).click();
      const row = sender.page.locator('[data-message-own="true"]').filter({ hasText: text });
      await expect(row).toBeVisible();
      await row.hover();
      await row.locator('summary').click();
      await expect(row.locator('.av2-context-menu')).toHaveAttribute('open', '');
      await row.locator('.av2-context-menu').evaluate(element => {
        window.sharedMenuBeforeRead = element;
        window.sharedMenuEvents = [{ at: Date.now(), type: 'initial', connected: element.isConnected, open: element.open }];
        const record = event => window.sharedMenuEvents.push({ at: Date.now(), type: event.type, target: event.target?.tagName, connected: element.isConnected, open: element.open, hidden: document.hidden });
        element.addEventListener('toggle', record);
        document.addEventListener('pointerdown', record, true);
        document.addEventListener('visibilitychange', record);
        new MutationObserver(() => record({ type: 'mutation' })).observe(document.querySelector('[data-workspace-messages]'), { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
      });
      await recipient.page.goto(`${server.origin}/${recipient.role}-v2.html#/conversations?matter=${id}`);
      await expect(recipient.page.locator('.av2-preserve-lines').filter({ hasText: text })).toBeVisible();
      await expect.poll(async () => (await api(recipient, 'get', '/api/messages/unread-count')).count).toBe(0);
      await sender.page.waitForTimeout(700);
      expect(await sender.page.evaluate(() => window.sharedMenuBeforeRead.isConnected && window.sharedMenuBeforeRead.open)).toBe(true);
      await row.getByRole('button', { name: /^Edit(?: message)?$/ }).click();
      await sender.page.getByRole('textbox', { name: 'Message text', exact: true }).fill(`${text} — reviewed`);
      await sender.page.getByRole('button', { name: 'Save message', exact: true }).click();
      await expect(recipient.page.locator('.av2-preserve-lines').filter({ hasText: `${text} — reviewed` })).toBeVisible();
    }
    const recipient = people.paralegal, sender = people.attorney;
    await api(recipient, 'patch', '/api/users/me/notification-prefs', { inApp: true, inAppMessages: true, expectedOwnerId: recipient.id, expectedValues: { inApp: false, inAppMessages: true } });
    const alertMatter = await engage(people);
    await recipient.page.goto(matterUrl(recipient, alertMatter, 'work'));
    const sent = await api(sender, 'post', `/api/messages/${alertMatter}`, { text: 'Please check the linked exhibit date.', clientMessageId: crypto.randomUUID(), expectedOwnerId: sender.id });
    await recipient.page.getByRole('button', { name: /^View notifications/ }).click();
    const panel = recipient.page.locator('[data-v2-notifications-panel]');
    const link = panel.getByRole('link', { name: /sent a message/ }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(recipient.page.locator(`[data-message-id="${sent.message._id}"]`)).toContainText('Please check the linked exhibit date.');
    expect(new URL(recipient.page.url()).hash).toContain(alertMatter);
    expect(new URL(recipient.page.url()).hash).toContain('tab=messages');
    await expect.poll(async () => (await api(recipient, 'get', '/api/messages/unread-count')).count).toBe(0);
  } finally {
    await fs.writeFile(info.outputPath('message-latency.json'), JSON.stringify({ latency, menus: await Promise.all(Object.values(people).map(async person => ({ role: person.role, events: await person.page.evaluate(() => window.sharedMenuEvents || []).catch(() => []) }))), provider: 'local application only' }, null, 2));
    for (const person of Object.values(people)) await person.context.close();
  }
});
