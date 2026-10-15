const { test, expect } = require('../workspace-paired-observation.cjs');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0, includeAdminSupport: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

async function api(person, method, route, data) {
  const request = person.context.request;
  const csrf = await (await request.get(`${server.origin}/api/csrf`)).json();
  const response = await request[method](`${server.origin}${route}`, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}
async function pair(browser) {
  const people = {};
  for (const role of ['attorney', 'paralegal']) {
    const actor = await server.createUser(role, {}, true);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([actor.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    people[role] = { ...actor, role, context, page: await context.newPage() };
  }
  return people;
}
async function engage(people) {
  const posted = await api(people.attorney, 'post', '/api/cases', {
    title: 'Shared task review', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14',
    description: 'Review both retained exhibit positions. Private planning does not change the agreed scope.',
    tasks: [{ title: 'Review exhibit' }, { title: 'Review exhibit' }],
  });
  const id = String(posted.case?._id || posted._id || posted.id);
  await api(people.paralegal, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter: 'I can review the two exhibit positions.' });
  await api(people.attorney, 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
  const hiring = await api(people.attorney, 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
  await api(people.attorney, 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: hiring.revision });
  return id;
}
const matterUrl = (person, id) => `${server.origin}/${person.role}-v2.html${person.role === 'attorney' ? `#/matters/${id}/work` : `#/matter/${id}?tab=work`}`;
const financialWrites = () => server.evidence().provider.filter(call => /\.(create|capture|cancel|update)$/.test(call.method));

test('an actual task review changes only the selected duplicate position and reaches the Paralegal without reload or financial change', async ({ browser }, info) => {
  const people = await pair(browser), checkpoints = [];
  let caseId;
  try {
    caseId = await engage(people);
    const { attorney, paralegal } = people;
    const before = await server.inspect(caseId), moneyBefore = JSON.stringify(financialWrites());
    await attorney.page.goto(matterUrl(attorney, caseId));
    const panel = attorney.page.locator('[data-workspace-work]');
    await expect(panel).toHaveAttribute('data-state', 'ready');
    await paralegal.page.goto(matterUrl(paralegal, caseId));
    const rows = paralegal.page.locator('.v2-matter-task-list > li');
    await expect(rows).toHaveCount(2);
    const documentId = await paralegal.page.evaluate(() => { window.lpcTaskDocumentId = crypto.randomUUID(); return window.lpcTaskDocumentId; });
    const inputs = panel.getByRole('checkbox', { name: 'Review exhibit', exact: true });
    await expect(inputs).toHaveCount(2);
    await inputs.nth(1).focus();
    const changed = attorney.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/cases/${caseId}/work-review`);
    await inputs.nth(1).press('Space');
    expect((await changed).status()).toBe(200);
    await expect(inputs.nth(1)).toBeChecked();
    await expect(inputs.nth(0)).not.toBeChecked();
    await expect(inputs.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveClass('is-complete', { timeout: 5000 });
    await expect(rows.nth(0)).not.toHaveClass('is-complete');
    expect(await paralegal.page.evaluate(() => window.lpcTaskDocumentId)).toBe(documentId);
    const completed = await server.inspect(caseId);
    expect(completed.case.tasks[0]).toEqual(before.case.tasks[0]);
    expect(completed.case.tasks[1]).toEqual({ ...before.case.tasks[1], completed: true });
    expect(completed.case.taskRevision).toBe(Number(before.case.taskRevision || 0) + 1);
    checkpoints.push('Only the selected duplicate position persisted; actual Paralegal document received completion without reload');
    await inputs.nth(1).click();
    await expect(inputs.nth(1)).not.toBeChecked();
    await expect(rows.nth(1)).not.toHaveClass('is-complete', { timeout: 5000 });
    expect(await paralegal.page.evaluate(() => window.lpcTaskDocumentId)).toBe(documentId);
    const reopened = await server.inspect(caseId);
    expect(reopened.case.tasks).toEqual(before.case.tasks);
    expect(reopened.case.taskRevision).toBe(Number(before.case.taskRevision || 0) + 2);
    expect(reopened.case.status).toBe(before.case.status);
    expect(reopened.case.paymentReleased).toBe(before.case.paymentReleased);
    for (const key of ['payouts', 'operations', 'income']) expect(reopened[key]).toEqual(before[key]);
    expect(JSON.stringify(financialWrites())).toBe(moneyBefore);
    await attorney.page.screenshot({ path: info.outputPath('actual-attorney-task-review.png') });
    await paralegal.page.screenshot({ path: info.outputPath('actual-paralegal-task-review.png') });
    checkpoints.push('Explicit reopening propagated without scope, payment, income or payout changes');
  } finally {
    await fs.writeFile(info.outputPath('task-review-evidence.json'), JSON.stringify({ caseId, checkpoints, requests: server.evidence().requests }, null, 2));
    for (const person of Object.values(people)) await person.context.close();
  }
});

test('actual private task controls persist owner-only planning and complete, filter and delete it without changing shared scope', async ({ browser }, info) => {
  const people = await pair(browser), checkpoints = [], extraContexts = [];
  let caseId, taskId;
  try {
    caseId = await engage(people);
    const { attorney, paralegal } = people;
    const before = await server.inspect(caseId);
    const title = `Private exhibit planning ${crypto.randomUUID()}`, secret = 'Confidential planning.\n\nKeep these private paragraphs.';
    const origin = `#/matters/${caseId}/work`;
    await attorney.page.goto(`${server.origin}/attorney-v2.html#/tasks?caseId=${caseId}&matterOrigin=${encodeURIComponent(origin)}`);
    const list = attorney.page.getByRole('region', { name: 'Private task list', exact: true });
    await expect(list).toHaveAttribute('data-state', 'ready');
    await expect(attorney.page.getByRole('link', { name: 'Back to Matter', exact: true })).toHaveAttribute('href', origin);
    await attorney.page.getByRole('button', { name: 'New private task', exact: true }).click();
    const form = attorney.page.getByRole('form', { name: 'New private task', exact: true });
    await form.getByLabel('Task title', { exact: true }).fill(title);
    await form.getByLabel('Private details (optional)', { exact: true }).fill(secret);
    await form.getByRole('button', { name: /^Matter \(optional\)/ }).click();
    const chooser = attorney.page.getByRole('dialog', { name: 'Choose a Matter', exact: true });
    await expect(chooser).toHaveAttribute('data-state', 'ready');
    await chooser.locator('.av2-matter-choice').filter({ hasText: 'Shared task review' }).click();
    const created = attorney.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/checklist');
    await form.getByRole('button', { name: 'Create private task', exact: true }).click();
    const creation = await created;
    expect(creation.status()).toBe(201); taskId = (await creation.json()).id;
    const ChecklistTask = require('../../../models/ChecklistTask');
    const persisted = await ChecklistTask.findById(taskId).lean();
    expect(String(persisted.owner)).toBe(attorney.id);
    expect(String(persisted.caseId)).toBe(caseId);
    expect(persisted.title).toBe(title); expect(persisted.notes).toBe(secret); expect(persisted.done).toBe(false);
    const row = attorney.page.locator(`[data-av2-task="${taskId}"]`);
    await expect(row).toContainText(title);
    await row.getByText('Task details', { exact: true }).click();
    await expect(row.locator('.av2-preserve-text')).toHaveText(secret);
    await expect(row.getByRole('link', { name: 'View linked Matter', exact: true })).toHaveAttribute('href', new RegExp(`/matters/${caseId}/overview`));
    const other = await server.createUser('attorney', {}, true), otherContext = await browser.newContext();
    extraContexts.push(otherContext); await otherContext.addCookies([other.cookie]);
    for (const recipient of [paralegal, { ...other, context: otherContext }]) {
      const read = await recipient.context.request.get(`${server.origin}/api/checklist?status=all&caseId=${caseId}`);
      expect(read.status()).toBe(403); expect(await read.text()).not.toContain(secret); expect(await read.text()).not.toContain(title);
      const csrf = await (await recipient.context.request.get(`${server.origin}/api/csrf`)).json();
      const options = { headers: { 'X-CSRF-Token': csrf.csrfToken } };
      for (const response of [await recipient.context.request.post(`${server.origin}/api/checklist/${taskId}/toggle`, options), await recipient.context.request.delete(`${server.origin}/api/checklist/${taskId}`, options)]) {
        expect([403, 404]).toContain(response.status()); expect(await response.text()).not.toContain(secret); expect(await response.text()).not.toContain(title);
      }
    }
    expect((await ChecklistTask.findById(taskId).lean()).done).toBe(false);
    checkpoints.push('Actual owner-bound private text persisted; both opposite-role and other-owner reads/writes denied without leaks');
    await row.getByRole('button', { name: `Mark complete: ${title}`, exact: true }).click();
    await expect(row).toHaveCount(0);
    expect((await ChecklistTask.findById(taskId).lean()).done).toBe(true);
    await attorney.page.getByRole('navigation', { name: 'Task status', exact: true }).getByRole('link', { name: 'Completed', exact: true }).click();
    await expect(list).toHaveAttribute('data-state', 'ready');
    await expect(row).toContainText(title);
    await row.getByText('Task details', { exact: true }).click();
    await row.getByRole('button', { name: 'Delete task', exact: true }).click();
    await row.getByRole('button', { name: 'Keep task', exact: true }).click();
    expect(await ChecklistTask.findById(taskId)).not.toBeNull();
    await row.getByRole('button', { name: 'Delete task', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(row).toHaveCount(0); expect(await ChecklistTask.findById(taskId)).toBeNull();
    expect((await server.inspect(caseId)).case.tasks).toEqual(before.case.tasks);
    await attorney.page.screenshot({ path: info.outputPath('actual-private-task-completed-list.png') });
    checkpoints.push('Actual completion, Completed filter, cancel and explicit deletion preserved shared Case.tasks');
  } finally {
    await fs.writeFile(info.outputPath('private-task-evidence.json'), JSON.stringify({ caseId, taskId, checkpoints, requests: server.evidence().requests }, null, 2));
    for (const context of extraContexts) await context.close();
    for (const person of Object.values(people)) await person.context.close();
  }
});
