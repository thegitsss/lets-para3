const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function api(person, method, path, data) {
  const request = person.context.request, csrf = await (await request.get(server.origin + '/api/csrf')).json();
  const response = await request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true); return response.json();
}
async function pair(browser) {
  const people = {};
  for (const role of ['attorney', 'paralegal']) {
    const user = await server.createUser(role, {}, true), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([user.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    people[role] = { ...user, role, context, page: await context.newPage() };
  }
  const posted = await api(people.attorney, 'post', '/api/cases', { title: 'Synthetic reply context', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Review the exhibit list and retain the original dates.', tasks: [{ title: 'Review the exhibit list' }] });
  const id = String(posted.case?._id || posted._id || posted.id);
  await api(people.paralegal, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'I can check the exhibit dates.' });
  await api(people.attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
  const review = await api(people.attorney, 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
  await api(people.attorney, 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: review.revision });
  for (const person of Object.values(people)) {
    await person.page.goto(`${server.origin}/${person.role}-v2.html#/conversations?matter=${id}`);
    await expect(person.page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state', 'ready');
  }
  return { people, id };
}
const composer = person => person.page.getByRole('textbox', { name: person.role === 'attorney' ? 'Message to the paralegal' : 'Write a message', exact: true });
const context = person => person.page.locator('[data-message-reply-context]');
async function selectReply(person, id) {
  const row = person.page.locator(`[data-message-id="${id}"]`);
  await expect(row).toBeVisible(); await row.hover(); await row.locator('summary').click();
  await row.getByRole('button', { name: 'Reply to message', exact: true }).click();
  await expect(context(person)).toBeVisible(); await expect(composer(person)).toBeFocused();
}
async function seededParent(person, id, text = 'Original instruction with confidential dates') {
  return (await api(person, 'post', `/api/messages/${id}`, { text, clientMessageId: crypto.randomUUID(), ...(person.role === 'attorney' ? { expectedOwnerId: person.id } : {}) })).message;
}
async function close(people, info, extra = {}) {
  await fs.writeFile(info.outputPath('reply-evidence.json'), JSON.stringify({ ...extra, requests: server.evidence().requests, provider: 'Local real application with synthetic providers' }, null, 2));
  for (const person of Object.values(people)) await person.context.close();
}

test('both participants retain, cancel and send contextual replies across local navigation; exact parent links and nested roots agree', async ({ browser }, info) => {
  const { people, id } = await pair(browser), errors = [];
  for (const person of Object.values(people)) person.page.on('pageerror', error => errors.push(error.message));
  try {
    let parent = await seededParent(people.attorney, id);
    for (const person of Object.values(people)) {
      const recipient = person === people.attorney ? people.paralegal : people.attorney;
      await selectReply(person, parent._id);
      expect(await context(person).innerText()).not.toContain('Original instruction with confidential dates');
      const text = `Context retained for ${person.role}`;
      await composer(person).fill(text);
      await person.page.getByRole('link', { name: 'Home', exact: true }).click();
      await expect(person.page).toHaveURL(/#\/home/);
      await person.page.evaluate(matter => { location.hash = `#/conversations?matter=${matter}`; }, id);
      await expect(context(person)).toBeVisible(); await expect(composer(person)).toHaveValue(text);
      await context(person).getByRole('button', { name: 'Cancel reply', exact: true }).click();
      await expect(context(person)).toBeHidden(); await expect(composer(person)).toHaveValue(text); await expect(composer(person)).toBeFocused();
      await selectReply(person, parent._id);
      const sent = person.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/messages/${id}`);
      await person.page.getByRole('button', { name: 'Send message', exact: true }).click();
      const response = await sent; expect(response.status()).toBe(201); const body = await response.json();
      expect(body.message.replyTo).toBe(parent._id); expect(body.message.threadRoot).toBe(parent.threadRoot || parent._id);
      const reply = recipient.page.locator(`[data-message-id="${body.message._id}"]`);
      await expect(reply).toContainText(text); await expect(context(person)).toBeHidden(); await expect(composer(person)).toHaveValue('');
      const link = reply.getByRole('link', { name: 'View message being replied to', exact: true });
      const href = await link.getAttribute('href'); expect(new URLSearchParams(href.split('?')[1]).getAll('messageId')).toEqual([parent._id]);
      for (const width of [1440, 390]) {
        await person.page.setViewportSize({ width, height: 844 }); expect(await person.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await person.page.screenshot({ path: info.outputPath(`${person.role}-reply-${width}.png`) });
      }
      await link.click(); await expect(recipient.page.locator(`[data-message-id="${parent._id}"]`)).toBeFocused();
      await recipient.page.evaluate(matter => { location.hash = `#/conversations?matter=${matter}`; }, id);
      parent = body.message;
    }
    expect(errors).toEqual([]);
  } finally { await close(people, info, { errors }); }
});

test('a lost real send response keeps both roles bound to the same reply and retry records it exactly once', async ({ browser }, info) => {
  const { people, id } = await pair(browser), receipts = [];
  try {
    const parent = await seededParent(people.attorney, id);
    for (const person of Object.values(people)) {
      await selectReply(person, parent._id); const text = `Exact lost-response reply ${person.role}`; await composer(person).fill(text);
      let dropped = false, dropComplete = false, saved;
      const intercept = async route => {
        if (route.request().method() !== 'POST' || dropped) return route.continue();
        dropped = true; const response = await route.fetch(); expect(response.status()).toBe(201); saved = await response.json(); await route.abort('failed'); dropComplete = true;
      };
      await person.page.route(`**/api/messages/${id}`, intercept);
      await person.page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => dropComplete).toBe(true);
      await person.page.unroute(`**/api/messages/${id}`, intercept);
      if (person.role === 'paralegal') {
        await expect(composer(person)).toHaveValue(text); await expect(composer(person)).toHaveJSProperty('readOnly', true);
        await expect(context(person).getByRole('button', { name: 'Cancel reply' })).toBeDisabled();
        await person.page.getByRole('button', { name: 'Send message', exact: true }).click();
      }
      // Attorney immediately reconciles a lost response through its exact
      // request reader; Paralegal safely retries its same idempotent request.
      await expect(composer(person)).toHaveValue(''); await expect(context(person)).toBeHidden();
      const current = await api(person, 'get', `/api/messages/${id}`), matching = current.messages.filter(message => message.text === text);
      expect(matching).toHaveLength(1); expect(matching[0]._id).toBe(saved.message._id); expect(matching[0].replyTo).toBe(parent._id);
      receipts.push({ role: person.role, id: matching[0]._id });
    }
  } finally { await close(people, info, { receipts }); }
});

test('an unavailable parent retains reply text for cancel/recovery; actual lost Matter permission clears both composers', async ({ browser }, info) => {
  const { people, id } = await pair(browser);
  try {
    for (const person of Object.values(people)) {
      const parent = await seededParent(people.attorney, id, `Parent for ${person.role}`); await selectReply(person, parent._id);
      await composer(person).fill(`Retain unsent text ${person.role}`);
      const feed = await api(people.attorney, 'get', `/api/messages/${id}?expectedOwnerId=${people.attorney.id}`), revision = feed.messages.find(message => message._id === parent._id).revision;
      await api(people.attorney, 'delete', `/api/messages/${id}/${parent._id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: revision });
      await person.page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(person.page.locator('[role="status"]').filter({ hasText: /replied to is unavailable/ })).toBeVisible();
      await expect(composer(person)).toHaveValue(`Retain unsent text ${person.role}`); await expect(context(person)).toBeVisible();
      await context(person).getByRole('button', { name: 'Cancel reply', exact: true }).click();
      await expect(composer(person)).toBeFocused(); await expect(context(person)).toBeHidden();
      await person.page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(composer(person)).toHaveValue('');
    }
    const parent = await seededParent(people.attorney, id, 'Parent before real permission loss');
    for (const person of Object.values(people)) { await selectReply(person, parent._id); await composer(person).fill(`Private unsent ${person.role}`); }
    // Use the actual supported dispute handler to change collaboration access.
    await api(people.paralegal, 'post', `/api/disputes/${id}`, { message: 'Pause this synthetic local Matter for review.' });
    for (const person of Object.values(people)) {
      if (await person.page.getByRole('button', { name: 'Send message', exact: true }).isVisible()) await person.page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(composer(person)).toHaveCount(0); await expect(context(person)).toHaveCount(0);
      await person.page.getByRole('link', { name: 'Home', exact: true }).click();
      await person.page.evaluate(matter => { location.hash = `#/conversations?matter=${matter}`; }, id);
      await expect(person.page.locator('main')).not.toContainText(`Private unsent ${person.role}`);
    }
  } finally { await close(people, info); }
});
