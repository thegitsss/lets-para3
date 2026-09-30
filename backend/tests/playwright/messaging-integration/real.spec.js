const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function api(page, method, path, body) {
  const csrf = await (await page.context().request.get(server.origin + '/api/csrf')).json();
  const response = await page.context().request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(body ? { data: body } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
const home = (role, matterId) => role === 'attorney' ? '/attorney-v2.html#/home' : `/paralegal-v2.html#/home?view=matters&item=matter:${matterId}`;
const workspace = (role, matterId, tab = 'messages') => role === 'attorney' ? `/attorney-v2.html#/matters/${matterId}/${tab}` : `/paralegal-v2.html#/matter/${matterId}?tab=${tab}`;
const messages = (page, role) => page.locator(role === 'attorney' ? '[data-workspace-messages]' : '[data-v2-message-panel]');
const composer = (page, role) => page.getByRole('textbox', { name: role === 'attorney' ? 'Message to the paralegal' : 'Write a message', exact: true });
async function hashNavigate(page, path) { await page.evaluate(value => { location.hash = value.split('#')[1]; }, path); }
async function assertUnread(page, matterId, expected) {
  const count = await api(page, 'get', '/api/messages/unread-count'), summary = await api(page, 'get', '/api/messages/summary'), threads = await api(page, 'get', '/api/messages/threads');
  expect(count.count).toBe(expected);
  expect(summary.items.find(item => item.caseId === matterId)?.unread).toBe(expected);
  expect(threads.threads.find(item => item.id === matterId)?.unread).toBe(expected);
}
for (const role of ['attorney', 'paralegal']) test(`actual ${role} Home, a second message tab and reconnect retain one shared unread result`, async ({ browser }, info) => {
  const people = {}, errors = [], observations = [];
  try {
    for (const name of ['attorney', 'paralegal']) {
      const user = await server.createUser(name, {}, true), context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
      await context.addInitScript(() => {
        const Native = window.EventSource;
        window.integrationStreams = { matter: 0, notifications: 0, opened: 0 };
        window.EventSource = class extends Native {
          constructor(url, options) { super(url, options); this.integrationKind = /\/api\/cases\/[^/]+\/stream/.test(String(url)) ? 'matter' : /\/api\/notifications\/stream/.test(String(url)) ? 'notifications' : ''; if (this.integrationKind) { window.integrationStreams[this.integrationKind]++; window.integrationStreams.opened++; } }
          close() { if (this.integrationKind) { window.integrationStreams[this.integrationKind]--; this.integrationKind = ''; } return super.close(); }
        };
      });
      context.on('page', page => page.on('pageerror', error => errors.push({ role: name, message: error.message })));
      people[name] = { ...user, context, page: await context.newPage() };
    }
    const attorney = people.attorney, paralegal = people.paralegal;
    const posted = await api(attorney.page, 'post', '/api/cases', { title: 'River Street exhibit correspondence', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the exhibit index and organize supporting evidence for review.', tasks: [{ title: 'Prepare exhibit index' }] });
    const matterId = String(posted.case?._id || posted.case?.id || posted._id || posted.id);
    await api(paralegal.page, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'I can organize the exhibits for your review.' });
    await api(attorney.page, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(attorney.page, 'get', `/api/cases/${matterId}/hiring-review/${paralegal.id}?expectedOwnerId=${attorney.id}`);
    await api(attorney.page, 'post', `/api/cases/${matterId}/hire/${paralegal.id}`, { expectedOwnerId: attorney.id, reviewedRevision: review.revision });
    const recipient = people[role], sender = people[role === 'attorney' ? 'paralegal' : 'attorney'];
    const homePage = recipient.page;
    await homePage.goto(server.origin + home(role, matterId));
    const homeMessages = role === 'attorney' ? homePage.locator('[data-av2-region="messages"]') : homePage.locator('.ld-detail .ld-message-entry');
    await expect(homeMessages).toBeVisible();
    if (role === 'attorney') await homeMessages.getByRole('link', { name: 'River Street exhibit correspondence', exact: true }).focus();
    await expect.poll(() => homePage.evaluate(() => window.integrationStreams.notifications)).toBe(1);
    const firstText = 'Please retain the original exhibit index.';
    const first = await api(sender.page, 'post', `/api/messages/${matterId}`, { text: firstText, clientMessageId: crypto.randomUUID(), ...(sender === attorney ? { expectedOwnerId: attorney.id } : {}) });
    await assertUnread(recipient.page, matterId, 1);
    await expect(homeMessages).toContainText('1 unread', { timeout: 25000 });
    if (role === 'attorney') await expect(homeMessages.getByRole('link', { name: 'River Street exhibit correspondence', exact: true })).toBeFocused();
    await homeMessages.scrollIntoViewIfNeeded();
    await homePage.screenshot({ path: info.outputPath('home-unread.png'), animations: 'disabled' });
    const conversationPage = await recipient.context.newPage();
    await conversationPage.goto(server.origin + workspace(role, matterId));
    await expect(messages(conversationPage, role)).toContainText(firstText);
    await expect.poll(async () => (await api(recipient.page, 'get', '/api/messages/unread-count')).count).toBe(0);
    await assertUnread(recipient.page, matterId, 0);
    await expect(homeMessages).not.toContainText('1 unread', { timeout: 25000 });
    const draft = 'Unsent instructions: keep the original page numbering.';
    await composer(conversationPage, role).fill(draft);
    const firstStreams = await conversationPage.evaluate(() => ({ ...window.integrationStreams }));
    expect(firstStreams).toMatchObject({ matter: 1, notifications: 1 });
    observations.push({ at: 'before-offline', streams: firstStreams, unread: 0, messageId: first.message._id });
    await recipient.context.setOffline(true);
    const laterText = 'The updated exhibit index is ready for review.';
    await api(sender.page, 'post', `/api/messages/${matterId}`, { text: laterText, clientMessageId: crypto.randomUUID(), ...(sender === attorney ? { expectedOwnerId: attorney.id } : {}) });
    await recipient.context.setOffline(false);
    await expect(composer(conversationPage, role)).toHaveValue(draft);
    await expect(messages(conversationPage, role)).toContainText(laterText, { timeout: 30000 });
    await expect.poll(async () => (await api(recipient.page, 'get', '/api/messages/unread-count')).count).toBe(0);
    await assertUnread(recipient.page, matterId, 0);
    await expect.poll(() => conversationPage.evaluate(() => window.integrationStreams.matter)).toBe(1);
    for (const tab of ['work', 'messages', 'work', 'messages']) {
      await hashNavigate(conversationPage, workspace(role, matterId, tab));
      if (tab === 'messages') await expect(composer(conversationPage, role)).toHaveValue(draft);
      await expect.poll(() => conversationPage.evaluate(() => window.integrationStreams.matter)).toBe(1);
    }
    await conversationPage.setViewportSize({ width: 390, height: 900 });
    await composer(conversationPage, role).scrollIntoViewIfNeeded();
    await conversationPage.screenshot({ path: info.outputPath('reconnected-message-draft-390.png'), animations: 'disabled' });
    expect(await conversationPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await hashNavigate(conversationPage, home(role, matterId));
    await expect.poll(() => conversationPage.evaluate(() => window.integrationStreams.matter)).toBe(0);
    observations.push({ at: 'home-return', streams: await conversationPage.evaluate(() => ({ ...window.integrationStreams })), unread: 0 });
    expect(errors).toEqual([]);
  } finally {
    for (const user of Object.values(people)) { await user.context.setOffline(false); await user.page.screenshot({ path: info.outputPath(user.id + '-last.png') }).catch(() => {}); await user.context.close(); }
    await fs.writeFile(info.outputPath('request-evidence.json'), JSON.stringify({ ...server.evidence(), errors, observations }, null, 2));
  }
});
