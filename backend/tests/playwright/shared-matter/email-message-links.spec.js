const { test, expect } = require('playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.afterAll(async () => server?.close());
async function api(person, method, route, data) {
  const csrf = await (await person.context.request.get(server.origin + '/api/csrf')).json();
  const response = await person.context.request[method](server.origin + route, { headers: { 'X-CSRF-Token': csrf.csrfToken, 'X-LPC-Owner-Id': person.id }, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${route}: ${response.status()}`).toBe(true);
  return response.json();
}
test('both roles can open the exact protected message from its rendered email; an unrelated user cannot', async ({ browser }, info) => {
  const people = {}, checks = [];
  try {
    for (const role of ['attorney', 'paralegal', 'outsider']) {
      const user = await server.createUser(role === 'outsider' ? 'attorney' : role, { email: false }, true);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
      people[role] = { ...user, context, page: await context.newPage() };
    }
    const posted = await api(people.attorney, 'post', '/api/cases', { title: 'Synthetic message action review', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Review the synthetic message action.', tasks: [{ title: 'Review message' }] });
    const id = String(posted.case?._id || posted._id || posted.id);
    await api(people.paralegal, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'Synthetic test applicant.' });
    await api(people.attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(people.attorney, 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
    await api(people.attorney, 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: review.revision });
    const templates = require('../../../email/templates');
    process.env.EMAIL_BASE_URL = server.origin;
    for (const role of ['attorney', 'paralegal']) {
      const recipient = people[role], sender = people[role === 'attorney' ? 'paralegal' : 'attorney'];
      const text = `Synthetic protected message ${role} ${crypto.randomUUID()}`;
      const sent = await api(sender, 'post', `/api/messages/${id}`, { text, clientMessageId: crypto.randomUUID(), ...(sender === people.attorney ? { expectedOwnerId: sender.id } : {}) });
      const messageId = String(sent.message._id);
      const template = templates.newMessage({ caseId: id, messageId, caseTitle: 'Synthetic message action review', fromName: 'Synthetic participant', messageSnippet: text });
      expect(template.html).not.toContain(text);
      await recipient.page.setContent(template.html);
      const action = recipient.page.getByRole('link', { name: 'Read message', exact: true });
      const href = await action.getAttribute('href');
      expect(new URL(href).origin).toBe(server.origin);
      for (const width of [1440, 390]) {
        await recipient.page.setViewportSize({ width, height: 900 });
        expect(await recipient.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await recipient.page.screenshot({ path: info.outputPath(`${role}-message-email-${width}.png`) });
      }
      await action.click();
      await expect(recipient.page.locator(`[data-message-id="${messageId}"]`)).toContainText(text);
      expect(recipient.page.url()).toContain(id);
      expect(recipient.page.url()).toContain(messageId);
      await expect.poll(async () => (await api(recipient, 'get', '/api/messages/unread-count')).count).toBe(0);
      await recipient.page.evaluate(() => document.fonts.ready);
      const currentTab = recipient.page.locator('[role="tab"][aria-selected="true"], .av2-matter-tabs [aria-current="page"], .v2-matter-tabs [aria-current="page"]');
      await expect(currentTab).toHaveText('Messages');
      await expect.poll(() => currentTab.evaluate(item => {
        const selected = item.getBoundingClientRect(), frame = item.parentElement.getBoundingClientRect();
        return selected.left >= Math.max(0, frame.left) - 1 && selected.right <= Math.min(innerWidth, frame.right) + 1;
      }), { message: 'The selected Messages tab should be fully visible on a phone after opening the email action.' }).toBe(true);
      const tabViews = [];
      for (const width of [1440, 390]) {
        await recipient.page.setViewportSize({ width, height: 900 });
        await expect.poll(() => currentTab.evaluate(item => {
          const selected = item.getBoundingClientRect(), frame = item.parentElement.getBoundingClientRect();
          return selected.left >= Math.max(0, frame.left) - 1 && selected.right <= Math.min(innerWidth, frame.right) + 1;
        })).toBe(true);
        expect(await recipient.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        tabViews.push({ width, activeTabFullyVisible: true, pageOverflow: false });
        await recipient.page.screenshot({ path: info.outputPath(`${role}-protected-message-${width}.png`) });
      }
      const forbidden = people.outsider.page.waitForResponse(response => new URL(response.url()).pathname.startsWith(`/api/cases/${id}`) && [403, 404].includes(response.status()));
      await people.outsider.page.goto(href);
      expect([403, 404]).toContain((await forbidden).status());
      await expect(people.outsider.page.getByText(text, { exact: true })).toHaveCount(0);
      checks.push({ role, messageId, surface: new URL(href).pathname, protectedThreadOpened: true, unreadCleared: true, outsiderDenied: true, tabViews });
    }
  } finally {
    await fs.writeFile(info.outputPath('email-actions.json'), JSON.stringify({ scope: 'local application and rendered email; external providers synthetic', checks, requests: server?.evidence().requests || [] }, null, 2));
    for (const person of Object.values(people)) await person.context.close();
  }
});

test('an older protected email link acknowledges its target boundary while newer messages stay unread for both roles', async ({ browser }, info) => {
  const people = {}, checks = [], errors = [];
  try {
    for (const role of ['attorney', 'paralegal']) {
      const user = await server.createUser(role, { email: false }, true);
      const context = await browser.newContext();
      await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      people[role] = { ...user, context, page };
    }
    const posted = await api(people.attorney, 'post', '/api/cases', { title: 'Synthetic older message boundary', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Preserve newer unread instructions.', tasks: [{ title: 'Review linked instruction' }] });
    const id = String(posted.case?._id || posted._id || posted.id);
    await api(people.paralegal, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'Synthetic boundary applicant.' });
    await api(people.attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(people.attorney, 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
    await api(people.attorney, 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: review.revision });
    const templates = require('../../../email/templates'); process.env.EMAIL_BASE_URL = server.origin;
    for (const role of ['attorney', 'paralegal']) {
      const recipient = people[role], sender = people[role === 'attorney' ? 'paralegal' : 'attorney'];
      const send = text => api(sender, 'post', `/api/messages/${id}`, { text, clientMessageId: crypto.randomUUID(), ...(sender === people.attorney ? { expectedOwnerId: sender.id } : {}) });
      const older = (await send(`Older reviewed instruction ${role}`)).message;
      const newer = (await send(`Newer unread instruction ${role}`)).message;
      expect(Date.parse(newer.createdAt)).toBeGreaterThan(Date.parse(older.createdAt));
      await expect.poll(async () => (await api(recipient, 'get', '/api/messages/unread-count')).count).toBe(2);
      const template = templates.newMessage({ caseId: id, messageId: String(older._id), caseTitle: 'Synthetic older message boundary', fromName: 'Synthetic participant' });
      await recipient.page.setContent(template.html);
      const acknowledged = recipient.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/messages/${id}/read`);
      await recipient.page.getByRole('link', { name: 'Read message', exact: true }).click();
      await expect(recipient.page.locator(`[data-message-id="${older._id}"]`)).toContainText(older.text);
      const receipt = await acknowledged;
      expect(receipt.status()).toBe(200);
      expect(receipt.request().postDataJSON()).toMatchObject({ messageId: String(older._id), upTo: new Date(older.createdAt).toISOString() });
      expect(receipt.request().headers()['x-lpc-owner-id']).toBe(recipient.id);
      await expect.poll(async () => (await api(recipient, 'get', '/api/messages/unread-count')).count).toBe(1);
      checks.push({ role, targetAcknowledged: true, newerUnreadPreserved: true });
    }
  } finally {
    for (const person of Object.values(people)) await person.context.close();
    await fs.writeFile(info.outputPath('older-email-boundary.json'), JSON.stringify({ checks, errors, requests: server.evidence().requests }, null, 2));
  }
  expect(checks).toHaveLength(2); expect(errors).toEqual([]);
});
