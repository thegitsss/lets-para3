const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const start = require('../../helpers/paralegalFinancialBrowserServer');
let server, record;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ calendar: true }); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ context }) => {
  record = await server.seed(); await context.addCookies([record.para.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
});
const route = eventId => `/paralegal-v2.html#/matter/${record.activeId}?tab=deadlines${eventId ? `&eventId=${eventId}` : ''}`;
const reviewPath = () => `/api/events/paralegal/matters/${record.activeId}/review`;
const actionPath = () => `/api/events/paralegal/matters/${record.activeId}/reviewed-action`;
const form = page => page.locator('[data-v2-deadline-form]');
async function open(page, eventId) { await page.goto(route(eventId)); await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready'); await expect(page.getByRole('heading', { name: 'Deadlines', exact: true })).toBeVisible(); }
function financial(value) { const result = structuredClone(value); delete result.case.__v; delete result.case.updatedAt; return result; }
function observe(page) {
  const pageErrors = [], assetFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === server.origin && url.pathname.startsWith('/assets/') && response.status() >= 400) assetFailures.push({ path: url.pathname, status: response.status() }); });
  return { pageErrors, assetFailures };
}
async function evidence(info, observed, extra = {}) {
  const value = { ...server.evidence(), ...observed, ...extra };
  await fs.writeFile(info.outputPath('reminder-evidence.json'), JSON.stringify(value, null, 2));
  expect(value.provider).toEqual([]); expect(value.mail).toEqual([]); expect(value.pageErrors).toEqual([]); expect(value.assetFailures).toEqual([]);
  expect(value.financialRequests.every(item => item.method === 'GET')).toBe(true);
}

test('actual private reminders page beyond 200 and an exact older link stays editable without exposing the attorney calendar', async ({ page }, info) => {
  const observed = observe(page), ids = await server.seedReminders(record.activeId, record.para.id);
  await server.seedReminders(record.activeId, record.attorney.id, 1);
  const before = await server.inspect(record.activeId);
  await open(page, ids.at(-1));
  await expect(page.locator(`[data-event-id="${ids.at(-1)}"]`)).toBeFocused();
  await expect(page.locator('[data-v2-deadline-count]')).toHaveText('51 of 225 shown');
  await page.screenshot({ path: info.outputPath('actual-linked-reminder.png') });
  for (let index = 0; index < 4; index++) await page.getByRole('button', { name: 'Show more reminders', exact: true }).click();
  await expect(page.locator('[data-event-id]')).toHaveCount(225); await expect(page.locator('[data-v2-deadline-count]')).toHaveText('225 reminders');
  expect(new Set(await page.locator('[data-event-id]').evaluateAll(items => items.map(item => item.dataset.eventId))).size).toBe(225);
  const denied = await page.request.get(`${reviewPath()}?expectedOwnerId=${record.attorney.id}`); expect(denied.status()).toBe(403);
  expect(await server.inspect(record.activeId)).toEqual(before);
  expect((await server.inspectReminders(record.activeId, record.para.id)).actions).toHaveLength(0);
  await evidence(info, observed, { actualRemindersRead: 225, financialRecordsUnchanged: true });
});

test('actual create acknowledgement recovery, edit and deletion preserve the shared deadline and financial records', async ({ page }, info) => {
  const observed = observe(page); await server.seedReminders(record.activeId, record.para.id, 2);
  const before = financial(await server.inspect(record.activeId));
  let lost = false, posts = 0;
  await page.route(`**${actionPath()}`, async intercepted => {
    posts += 1; const response = await intercepted.fetch();
    if (!lost) { lost = true; expect(response.status()).toBe(200); return intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic lost response after commit' }) }); }
    return intercepted.fulfill({ response });
  });
  await open(page);
  await page.getByLabel('Reminder', { exact: true }).fill('Prepare the verified final exhibit index');
  await page.getByLabel('Date', { exact: true }).fill('2026-09-25');
  await form(page).evaluate(element => { element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await expect(page.getByRole('button', { name: 'Check saved action', exact: true })).toBeEnabled();
  expect(posts).toBe(1); expect((await server.inspectReminders(record.activeId, record.para.id)).events).toHaveLength(3);
  await page.getByRole('button', { name: 'Check saved action', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Check saved action', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('actual-unconfirmed-create.png') });
  await page.getByRole('button', { name: 'Check saved action', exact: true }).click();
  await expect(page.getByText('Reminder added.', { exact: true })).toBeVisible(); expect(posts).toBe(1);
  const created = (await server.inspectReminders(record.activeId, record.para.id)).events.find(item => item.title === 'Prepare the verified final exhibit index');
  const row = page.locator(`[data-event-id="${created._id}"]`);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Reminder', { exact: true }).fill('Review the final exhibit index with all retained references');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Reminder updated.', { exact: true })).toBeVisible();
  await require('./layout')(page, info);
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete reminder', exact: true }).click();
  await expect(page.getByText('Reminder deleted.', { exact: true })).toBeVisible();
  const final = await server.inspectReminders(record.activeId, record.para.id); expect(final.events).toHaveLength(2); expect(final.actions.map(item => item.meta.operation).sort()).toEqual(['create', 'delete', 'update']); expect(posts).toBe(3);
  expect(financial(await server.inspect(record.activeId))).toEqual(before);
  await evidence(info, observed, { financialRecordsUnchanged: true, actualActionCount: final.actions.length, remainingReminders: final.events.length, requestedWrites: posts });
});

test('actual stale edit requires the current record and revoked access clears private reminders', async ({ page }, info) => {
  const observed = observe(page), ids = await server.seedReminders(record.activeId, record.para.id, 1);
  const before = financial(await server.inspect(record.activeId));
  await open(page); await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Reminder', { exact: true }).fill('My reviewed final reminder');
  const review = await (await page.request.get(`${reviewPath()}?expectedOwnerId=${record.para.id}&eventId=${ids[0]}`)).json();
  const otherTab = await page.request.post(actionPath(), { data: { expectedOwnerId: record.para.id, requestId: crypto.randomUUID(), action: 'update', eventId: ids[0], reviewedRevision: review.selectedEvent.revision, reviewedMatterRevision: review.revision, values: { title: 'Changed in another local tab' } } }); expect(otherTab.status()).toBe(200);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved action', exact: true })).toBeEnabled();
  expect((await server.inspectReminders(record.activeId, record.para.id)).events[0].title).toBe('Changed in another local tab');
  await page.getByRole('button', { name: 'Check saved action', exact: true }).click();
  await expect(page.getByText(/Current reminder: Changed in another local tab/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry these changes', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Retry these changes', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('actual-stale-review.png') });
  await page.getByRole('button', { name: 'Retry these changes', exact: true }).click();
  await expect(page.getByText('Reminder updated.', { exact: true })).toBeVisible();
  expect((await server.inspectReminders(record.activeId, record.para.id)).events[0].title).toBe('My reviewed final reminder');
  expect(financial(await server.inspect(record.activeId))).toEqual(before);
  await server.restrictMatter(record.activeId);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('[data-v2-deadline-panel]')).toHaveCount(0);
  await expect(page.getByText('My reviewed final reminder', { exact: true })).toHaveCount(0);
  await evidence(info, observed, { financialRecordsUnchangedBeforeRevocation: true, revokedPrivateContentCleared: true });
});
