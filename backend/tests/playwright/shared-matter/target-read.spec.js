const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
const Message = require('../../../models/Message');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function api(person, method, path, data) {
  const csrf = await (await person.context.request.get(server.origin + '/api/csrf')).json();
  const response = await person.context.request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json();
}
test('opening an older protected Paralegal message preserves unseen newer unread messages until the participant opens the latest messages', async ({ browser }, info) => {
  const people = {}, readRequests = [], observations = {};
  try {
    for (const role of ['attorney', 'paralegal']) {
      const user = await server.createUser(role, {}, true), context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
      people[role] = { ...user, role, context, page: await context.newPage() };
    }
    const posted = await api(people.attorney, 'post', '/api/cases', { title: 'Synthetic older message review', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Review the earlier instruction before opening later messages.', tasks: [{ title: 'Review earlier message' }] });
    const id = String(posted.case?._id || posted._id || posted.id);
    await api(people.paralegal, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'Synthetic earlier message review.' });
    await api(people.attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const review = await api(people.attorney, 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
    await api(people.attorney, 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: review.revision });
    // Only the owned historical records are seeded; routes, access, rendering
    // and read acknowledgements below are the actual application handlers.
    const records = await Message.create(Array.from({ length: 25 }, (_, index) => ({ caseId: id, senderId: people.attorney.id, senderRole: 'attorney', type: 'text', text: `Synthetic instruction ${index + 1}: review these dated exhibits carefully. `.repeat(4), createdAt: new Date(Date.now() - (60 - index) * 1000) })));
    const target = records[0], newer = records.at(-1), person = people.paralegal;
    person.page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/messages/${id}/read`) readRequests.push(request.postDataJSON()); });
    const read = person.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/messages/${id}/read`);
    await person.page.goto(`${server.origin}/paralegal-v2.html#/conversations?matter=${id}&messageId=${target._id}`);
    await expect(person.page.locator(`[data-message-id="${target._id}"]`)).toBeFocused();
    expect((await read).ok()).toBe(true);
    const viewport = await person.page.locator('[data-v2-message-content]').evaluate(element => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom }));
    const latestRect = await person.page.locator(`[data-message-id="${newer._id}"]`).boundingBox();
    expect(latestRect.y).toBeGreaterThan(viewport.bottom);
    observations.target = String(target._id); observations.newer = String(newer._id); observations.firstRead = readRequests[0];
    observations.unreadBeforeLatest = (await api(person, 'get', '/api/messages/unread-count')).count;
    observations.newerReadBy = (await Message.findById(newer._id)).readBy.map(String);
    expect(new Date(readRequests[0].upTo).getTime()).toBeLessThanOrEqual(target.createdAt.getTime());
    expect(observations.unreadBeforeLatest).toBe(24);
    expect(observations.newerReadBy).not.toContain(person.id);
    await person.page.screenshot({ path: info.outputPath('older-message-unread-preserved.png') });
    await person.page.getByRole('button', { name: 'New messages ↓', exact: true }).click();
    await expect.poll(async () => (await api(person, 'get', '/api/messages/unread-count')).count).toBe(0);
    expect((await Message.findById(newer._id)).readBy.map(String)).toContain(person.id);
    observations.unreadAfterLatest = 0;
    const ordinary = await Message.create({ caseId: id, senderId: people.attorney.id, senderRole: 'attorney', type: 'text', text: 'Synthetic ordinary conversation acknowledgement.' });
    await person.page.goto(`${server.origin}/paralegal-v2.html#/conversations?matter=${id}`);
    await expect(person.page.locator(`[data-message-id="${ordinary._id}"]`)).toBeVisible();
    await expect.poll(async () => (await Message.findById(ordinary._id)).readBy.map(String)).toContain(person.id);
    observations.ordinaryRead = readRequests.at(-1);
    expect(observations.ordinaryRead.messageId).toBeUndefined();
    // Leave the ordinary reader before creating an unread record. Its active
    // realtime refresh is allowed to acknowledge new visible conversation work.
    await person.page.goto(`${server.origin}/paralegal-v2.html#/home`);
    await expect(person.page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(person.page.locator('[data-v2-message-panel]')).toHaveCount(0);
    const missing = await Message.create({ caseId: id, senderId: people.attorney.id, senderRole: 'attorney', type: 'text', text: 'Synthetic newer message beyond a removed reference.' });
    observations.missingTargetUnreadBeforeOpen = (await api(person, 'get', '/api/messages/unread-count')).count;
    expect(observations.missingTargetUnreadBeforeOpen).toBe(1);
    await person.page.goto(`${server.origin}/paralegal-v2.html#/conversations?matter=${id}&messageId=000000000000000000000001`);
    await expect(person.page.locator('[data-v2-message-status]')).toContainText('referenced message is unavailable');
    await expect(person.page.getByRole('button', { name: 'New messages ↓', exact: true })).toBeVisible();
    observations.missingTargetUnread = (await api(person, 'get', '/api/messages/unread-count')).count;
    expect(observations.missingTargetUnread).toBe(1);
    expect((await Message.findById(missing._id)).readBy.map(String)).not.toContain(person.id);
    await person.page.getByRole('button', { name: 'New messages ↓', exact: true }).click();
    await expect.poll(async () => (await Message.findById(missing._id)).readBy.map(String)).toContain(person.id);
    observations.missingTargetRecovered = true;
  } finally {
    await fs.writeFile(info.outputPath('target-read-evidence.json'), JSON.stringify({ readRequests, observations, requests: server?.evidence().requests || [], boundary: 'Actual local app/handler; owned synthetic history and providers only' }, null, 2));
    for (const person of Object.values(people)) await person.context.close();
  }
});
