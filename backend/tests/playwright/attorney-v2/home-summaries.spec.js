const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const { fixtures, install, objectId, region, keys } = require('./home-summaries-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const ready = (page, key) => expect(region(page, key)).toHaveAttribute('data-state', 'ready');
// Exercise the same region update hook used by background invalidation; healthy cards no longer offer a reload button.
async function refresh(page, key) { await region(page, key).evaluate(panel => panel.refresh()); await ready(page, key); }
const item = (n, extra = {}) => ({ id: objectId(n), title: `Matter ${n}`, label: 'Posted', practiceArea: 'Litigation', ...extra });
function populated() {
  const data = fixtures();
  data.home.counts = { active: 106, applications: 2, draft: 203, archived: 102 }; data.home.postedCount = 210;
  data.home.recent = { total: 108, items: [105, 104, 103, 102, 101].map(n => item(n)) };
  data.home.completed = { total: 102, items: [203, 202, 201].map(n => item(n, { label: 'Completed' })) };
  data.home.attention = { total: 6, page: 1, pages: 2, pageSize: 5, items: [5, 4, 3, 2, 1].map(n => item(n, { actions: n === 1 ? ['files', 'moderation', 'payment'] : ['files'] })) };
  data.home.week = { start: '2026-09-07', end: '2026-09-13', total: 4, page: 1, pages: 2, pageSize: 3, items: [1, 2, 3].map(n => item(n, { dueDate: '2026-09-08' })) };
  const attentionSecond = { ...data.home.attention, page: 2, items: [item(6, { actions: ['withdrawal'] })] };
  const deadlineSecond = { ...data.home.week, page: 2, items: [item(4, { dueDate: '2026-09-13' })] };
  data.homePages = { '2:1': { ...data.home, attention: attentionSecond }, '1:2': { ...data.home, week: deadlineSecond }, '2:2': { ...data.home, attention: attentionSecond, week: deadlineSecond } };
  data.applications = Array.from({ length: 7 }, (_, n) => ({ id: objectId(500 + n), caseId: objectId(400), jobTitle: 'Older Matter with applicants', paralegal: { _id: objectId(600 + n), firstName: `Applicant ${n + 1}` } }));
  return data;
}

test('empty Home states each result once and keeps its category links exact', async ({ page }) => {
  const { writes, errors } = await install(page);
  for (const [key, message] of [['applications', 'No applications to review.'], ['messages', 'No Matter conversations yet.'], ['attention', 'No outstanding items in your Matters or private tasks.']]) await expect(region(page, key).getByText(message, { exact: true })).toHaveCount(1);
  for (const href of ['#/matters?view=active', '#/matters?view=applications', '#/matters?view=draft', '#/matters?view=archived']) await expect(region(page, 'overview').locator(`a[href="${href}"]`)).toHaveAttribute('aria-label', /: 0$/);
  await expect(region(page, 'overview')).not.toContainText('overlap'); await expect(region(page, 'completed')).toHaveCount(0);
  await expect(region(page, 'deadlines')).toBeHidden();
  await expect(page.getByText('No outstanding Matter or application reviews.', { exact: true })).toBeVisible();
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('full-inventory category totals and older applications remain visible outside current previews', async ({ page }) => {
  const data = populated(); const { writes, errors } = await install(page, data);
  const values = [['#/matters?view=active', 106], ['#/matters?view=applications', 2], ['#/matters?view=draft', 203], ['#/matters?view=archived', 102]];
  for (const [href, total] of values) await expect(region(page, 'overview').locator(`a[href="${href}"]`)).toHaveAttribute('aria-label', new RegExp(`: ${total}$`));
  await expect(region(page, 'applications')).toContainText('Showing 3 of 7 applications');
  await expect(region(page, 'applications').getByRole('link', { name: /Applicant 1 applied/ })).toHaveAttribute('href', `#/matters/${objectId(400)}/applications?applicantId=${objectId(600)}&applicationId=${objectId(500)}`);
  await expect(region(page, 'recent')).toContainText('5 of 108 current Matters');
  await expect(region(page, 'completed')).toHaveCount(0);
  await expect(page.locator('[data-av2-outlet]')).not.toContainText('latest 100');
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('attention groups each Matter once and pages independently with exact actions, focus, URL and reload', async ({ page }) => {
  const data = populated(); data.overdue.total = 2; await install(page, data); const panel = region(page, 'attention');
  const target = panel.locator('li.av2-summary-row').filter({ has: page.getByText('Matter 1', { exact: true }) });
  await expect(target).toHaveCount(1); await target.locator('summary').click();
  for (const [name, tab] of [['Review files', 'files'], ['Review listing', 'manage'], ['Review payment status', 'financials']]) await expect(target.getByRole('navigation').getByRole('link', { name, exact: true })).toHaveAttribute('href', `#/matters/${objectId(1)}/${tab}`);
  await expect(panel.getByRole('link', { name: /Private tasks.*2 overdue.*View overdue tasks/ })).toHaveAttribute('href', '#/tasks?status=overdue');
  await panel.getByRole('button', { name: 'Next attention page' }).click(); await ready(page, 'attention');
  await expect(panel.getByRole('heading', { name: 'Needs attention', exact: true })).toBeFocused();
  await expect(page).toHaveURL(/attentionPage=2/); await expect(panel).toContainText('Page 2 of 2');
  await expect(panel.getByRole('link', { name: /Matter 6.*Review withdrawal/ })).toHaveAttribute('href', `#/matters/${objectId(6)}/financials`);
  await expect(region(page, 'recent')).toContainText('Matter 105');
  await page.reload(); await ready(page, 'attention'); await expect(panel).toContainText('Matter 6');
  await panel.getByRole('button', { name: 'Previous attention page' }).click(); await ready(page, 'attention'); await expect(panel).toContainText('Matter 1');
});

test('weekly deadline paging reaches the final date with independent return focus and no false empty result', async ({ page }) => {
  await install(page, populated()); const panel = region(page, 'deadlines');
  await expect(panel).toContainText('4 deadlines · Page 1 of 2');
  await panel.getByRole('button', { name: 'Next deadline page' }).click(); await ready(page, 'deadlines');
  await expect(panel.getByRole('heading', { name: 'This week’s deadlines', exact: true })).toBeFocused();
  await expect(panel.locator('time[datetime="2026-09-13"]')).toHaveAttribute('aria-label', 'Sep 13, 2026'); await expect(panel.getByRole('link', { name: /Matter 4/ })).toHaveAttribute('href', `#/matters/${objectId(4)}/activity`);
  await expect(page).toHaveURL(/deadlinePage=2/); await page.reload(); await ready(page, 'deadlines'); await expect(panel).toContainText('Page 2 of 2');
  await panel.getByRole('button', { name: 'Previous deadline page' }).click(); await ready(page, 'deadlines'); await expect(panel).toContainText('Page 1 of 2');
});

test('a page beyond a shrinking inventory offers the first page without claiming no work', async ({ page }) => {
  const data = populated(); data.homePages['2:1'] = { ...data.home, attention: { total: 1, items: [], page: 2, pageSize: 5, pages: 1 } };
  await install(page, data); const panel = region(page, 'attention'); await panel.getByRole('button', { name: 'Next attention page' }).click(); await ready(page, 'attention');
  await expect(panel).toContainText('No Matters on this page.'); await expect(panel).not.toContainText('No outstanding');
  await panel.getByRole('button', { name: 'First attention page' }).click(); await ready(page, 'attention'); await expect(panel).toContainText('Matter 1');
});

test('unavailable or malformed inventory clears all affected panels while applications remain independently available', async ({ page }) => {
  const data = populated(); await install(page, data); const original = data.home;
  data.home = { httpError: 409 };
  for (const key of ['overview', 'attention', 'recent', 'deadlines']) { await region(page, key).evaluate(panel => panel.refresh()); await expect(region(page, key)).toHaveAttribute('data-state', 'error'); await expect(region(page, key)).not.toContainText('Matter 1'); }
  await expect(region(page, 'applications')).toContainText('Applicant 1');
  data.home = { ...original, counts: {} }; await region(page, 'overview').evaluate(panel => panel.refresh()); await expect(region(page, 'overview')).toHaveAttribute('data-state', 'error');
  data.home = original; for (const key of ['overview', 'attention', 'recent', 'deadlines']) await refresh(page, key);
  data.applications = { httpError: 503 }; await region(page, 'applications').evaluate(panel => panel.refresh()); await expect(region(page, 'applications')).toHaveAttribute('data-state', 'error'); await expect(region(page, 'applications')).not.toContainText('No applications');
});

test('populated Home stays readable in both themes and enlarged phone layouts without duplicate Matter headings', async ({ page }, info) => {
  const { writes, errors } = await install(page, populated());
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(({ theme, width }) => { document.documentElement.style.fontSize = width === 320 ? '200%' : ''; for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add('theme-' + theme); } }, { theme, width });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width < 650) {
      // Applications must participate in the page flow, not disappear below
      // an independently scrolling review area on a narrow screen.
      const reviews = page.locator('.av2-review-list');
      expect(await reviews.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
      await expect(region(page, 'applications').getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
      const applications = await region(page, 'applications').boundingBox();
      const messages = await region(page, 'messages').boundingBox();
      expect(applications.y + applications.height).toBeLessThanOrEqual(messages.y);
    }
    // A clipped scroll container can hide overflow from the document check.
    // Counts must remain whole numbers, including with 200% text on a phone.
    expect(await region(page, 'overview').locator('dd a strong').evaluateAll(items => items.every(item => {
      const range = document.createRange(); range.selectNodeContents(item);
      const rows = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
      const box = item.getBoundingClientRect();
      return rows.size === 1 && box.left >= 0 && box.right <= innerWidth;
    }))).toBe(true);
    if (width === 1440) { const tops = await region(page, 'overview').locator('dl > div').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top))); expect(new Set(tops).size).toBe(1); }
    expect((await new AxeBuilder({ page }).include('[data-av2-outlet]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`home-${theme}-${width}.png`), fullPage: true });
  }
  for (const key of keys) await ready(page, key); expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('conversation preview scope counts rendered rows and keeps unread disagreements explicit', async ({ page }) => {
  const data = fixtures(); data.threads = { total: 8, threads: Array.from({ length: 8 }, (_, i) => ({ id: objectId(i + 1), title: `Conversation ${i + 1}`, unread: 1, lastMessageSnippet: 'Latest update', updatedAt: `2026-09-0${i + 1}T12:00:00Z` })).reverse() };
  data.summary.items = data.threads.threads.map(thread => ({ caseId: thread.id, unread: 1 })); data.unread.count = 8;
  await install(page, data); const panel = region(page, 'messages');
  await expect(panel).toContainText('8 unread messages across your Matters'); await expect(panel).toContainText('3 of 8 conversations');
  await expect(panel.locator('.av2-summary-row')).toHaveCount(3);
  await expect(panel.locator('.av2-summary-row').first()).toContainText('Conversation 8');
  data.unread.count = 99; await refresh(page, 'messages');
  await expect(panel).toContainText('Unread counts are updating'); await expect(panel).not.toContainText('99 unread');
  data.unread.count = 8; await refresh(page, 'messages');
  await panel.getByRole('button', { name: 'View All', exact: true }).click();
  await expect(panel.locator('.av2-summary-row')).toHaveCount(8);
  await expect(panel).toContainText('8 of 8 conversations');
  await expect(panel.getByRole('button', { name: 'Show fewer', exact: true })).toBeFocused();
  data.threads.threads = []; await panel.evaluate(panel => panel.refresh());
  await expect(panel).toHaveAttribute('data-state', 'error');
  await expect(panel).not.toContainText('No Matter conversations');
});

test('live message refresh coalesces a held read, preserves keyboard focus and clears failed counts', async ({ page }) => {
  const data = fixtures(), thread = { id: objectId(1), title: 'River Street correspondence', unread: 1, lastMessageSnippet: 'Original exhibit instructions', updatedAt: '2026-09-15T12:00:00Z' };
  data.threads = { total: 1, threads: [thread] }; data.summary.items = [{ caseId: thread.id, unread: 1 }]; data.unread.count = 1;
  const { errors } = await install(page, data), panel = region(page, 'messages');
  await panel.getByRole('link', { name: new RegExp(thread.title) }).focus();
  let release, arrived, unreadReads = 0, notificationReads = 0;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/messages/unread-count', async route => { unreadReads++; arrived(); await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.unread) }); });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/notifications/page') notificationReads++; });
  const signal = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed')));
  try {
    await signal(); await waiting;
    await expect(panel).toContainText('1 unread');
    thread.unread = 2; thread.lastMessageSnippet = 'Revised exhibit instructions'; data.summary.items[0].unread = 2; data.unread.count = 2;
    const before = notificationReads;
    await signal(); await expect.poll(() => notificationReads).toBeGreaterThan(before);
    expect(unreadReads).toBe(1);
  } finally { release(); }
  await expect(panel).toContainText('2 unread');
  await expect(panel).toContainText('Revised exhibit instructions');
  await expect(panel.getByRole('link', { name: new RegExp(thread.title) })).toBeFocused();
  await page.unroute('**/api/messages/unread-count');
  data.unread = { httpError: 503 }; await signal();
  await expect(panel).toHaveAttribute('data-state', 'error');
  await expect(panel).not.toContainText('2 unread'); await expect(panel).not.toContainText('No unread');
  await expect(panel.getByRole('button', { name: 'Retry', exact: true })).toBeFocused();
  data.unread = { count: 2 }; await panel.getByRole('button', { name: 'Retry', exact: true }).click(); await ready(page, 'messages');
  await expect(panel).toContainText('2 unread'); expect(errors).toEqual([]);
});

test('Home preserves server conversation order when newer empty Matters follow a real message', async ({ page }) => {
  const data = fixtures();
  data.threads = { total: 4, threads: [
    { id: objectId(1), title: 'Existing conversation', unread: 1, lastMessageSnippet: 'Please review the signed draft.', updatedAt: '2026-01-01T12:00:00Z' },
    ...[2, 3, 4].map(n => ({ id: objectId(n), title: `New empty Matter ${n}`, unread: 0, lastMessageSnippet: '', updatedAt: '2026-09-13T12:00:00Z' })),
  ] };
  data.summary.items = data.threads.threads.map(thread => ({ caseId: thread.id, unread: thread.unread }));
  data.unread.count = 1;
  await install(page, data);
  const panel = region(page, 'messages');
  await expect(panel.locator('.av2-summary-row').first()).toContainText('Existing conversation');
  await expect(panel.locator('.av2-summary-row').first()).toContainText('Please review the signed draft.');
});

test('positive unread counts without previews never become an empty conversation claim', async ({ page }) => {
  const data = fixtures(); data.unread.count = 1; data.summary.items = [{ caseId: objectId(1), unread: 1 }];
  await install(page, data); await expect(region(page, 'messages')).toHaveAttribute('data-state', 'error');
  await expect(region(page, 'messages')).not.toContainText('No Matter conversations');
  data.threads = { total: 1, threads: [{ id: objectId(1), title: 'Recovered conversation', unread: 1 }] };
  await region(page, 'messages').getByRole('button', { name: 'Retry', exact: true }).click();
  await ready(page, 'messages'); await expect(region(page, 'messages')).toContainText('Recovered conversation');
  await expect(region(page, 'messages')).toContainText('1 unread');
});

test('impossible conversation totals show unavailable and recover without stale previews', async ({ page }) => {
  const data = fixtures(); data.threads.threads = [{ id: objectId(1), title: 'Private conversation', unread: 0 }]; data.summary.items = [{ caseId: objectId(1), unread: 0 }];
  await install(page, data); const panel = region(page, 'messages');
  await expect(panel).toHaveAttribute('data-state', 'error'); await expect(panel).not.toContainText('No Matter conversations');
  data.threads.total = 1; await refresh(page, 'messages'); await expect(panel).toContainText('Private conversation');
  data.unread = { httpError: 503 }; await panel.evaluate(panel => panel.refresh());
  await expect(panel).toHaveAttribute('data-state', 'error'); await expect(panel).not.toContainText('Private conversation');
});
