const { test: base, expect } = require('playwright/test');
const test = base.extend({ context: async ({ context }, use, info) => {
  const native = { closed: false, pageErrors: [], console: [], requestFailures: [] };
  const observe = page => { page.on('pageerror', e => native.pageErrors.push({ message: e.message, stack: e.stack })); page.on('console', m => native.console.push({ type: m.type(), text: m.text() })); page.on('requestfailed', r => native.requestFailures.push({ url: r.url(), error: r.failure()?.errorText })); };
  context.on('page', observe); for (const page of context.pages()) observe(page);
  context.on('close', () => { native.closed = true; });
  try { await use(context); } finally { await context.close(); await info.attach('unfiltered-native-lifetime', { body: JSON.stringify(native), contentType: 'application/json' }); expect(native.closed).toBe(true); expect(native.pageErrors).toEqual([]); }
} });

test('an unchanged passive calendar read preserves a native reminder press and current read guards', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/attorney-v2.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>[hidden]{display:none!important}button{min-height:44px;margin:3px}dialog{min-width:300px}</style></head><body></body></html>' }));
  await page.goto('/attorney-v2.html');
  await page.evaluate(async () => {
    const { createWorkspaceDates } = await import('/assets/scripts/attorney-v2/workspace-dates.mjs');
    const { createPrivateState } = await import('/assets/scripts/attorney-v2/private-state.mjs');
    const caseId = '222222222222222222222222', ownerId = '111111111111111111111111', id = '333333333333333333333333';
    const entry = { id, caseId, revision: 'a'.repeat(64), title: 'Exhibit meeting 1', type: 'meeting', isAllDay: false, start: '2027-03-14T16:00:15.123Z', end: '2027-03-14T17:00:20.456Z', timezone: 'America/New_York', notes: 'Bring the original exhibits.', where: 'Conference room', rrule: '', attendees: [{ name: 'Morgan Lee', email: 'morgan@synthetic.test', response: 'accepted', role: 'guest', required: true }], reminders: [] };
    window.calendarProbe = { writes: [], reads: 0, held: false, deny: false, entry, fail: false };
    const api = {
      readWorkspaceDates: async () => {
        window.calendarProbe.reads++;
        if (window.calendarProbe.held) await new Promise(resolve => { window.calendarProbe.release = resolve; });
        if (window.calendarProbe.fail) throw Object.assign(Error('temporarily unavailable'), { status: 503 });
        if (window.calendarProbe.deny) throw Object.assign(Error('forbidden'), { status: 403 });
        return structuredClone({ caseId, ownerId, revision: 'b'.repeat(64), items: [entry], total: 1, nextCursor: null, selection: 'found', selectedEvent: entry, operation: null });
      },
      saveWorkspaceDate: async (...args) => { window.calendarProbe.writes.push(args); throw Error('No write is expected in this controlled read test.'); },
    };
    window.calendarProbe.controller = new AbortController();
    window.calendarProbe.panel = createWorkspaceDates(caseId, { api, ownerId, signal: window.calendarProbe.controller.signal, route: { query: new URLSearchParams({ eventId: id }) }, privateState: createPrivateState() });
    document.body.append(window.calendarProbe.panel); await window.calendarProbe.panel.readiness;
  });
  const panel = page.locator('[data-workspace-dates]'), reminder = panel.getByRole('button', { name: 'Record reminder', exact: true });
  await expect(panel).toContainText('Morgan Lee'); await expect(reminder).toBeEnabled();
  await reminder.scrollIntoViewIfNeeded(); const box = await reminder.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(reminder).toBeFocused();
  await page.evaluate(() => { window.calendarProbe.pressedButton = document.activeElement; window.calendarProbe.held = true; window.calendarProbe.sync = window.calendarProbe.panel.sync(); });
  await expect.poll(() => page.evaluate(() => typeof window.calendarProbe.release)).toBe('function');
  const during = await reminder.isEnabled();
  await page.evaluate(async () => { window.calendarProbe.held = false; window.calendarProbe.release(); await window.calendarProbe.sync; });
  const sameButton = await page.evaluate(() => window.calendarProbe.pressedButton.isConnected);
  await page.mouse.up();
  await info.attach('native-press-observations', { body: JSON.stringify({ enabledDuringRead: during, pressedButtonStillConnected: sameButton }), contentType: 'application/json' });
  await expect(panel.locator('[data-calendar-editor]')).toContainText('Delivery is not confirmed');
  expect(during).toBe(true); expect(sameButton).toBe(true);
  await page.screenshot({ path: info.outputPath('reminder-open-after-native-press.png'), fullPage: true });
  await panel.getByLabel('Minutes before the entry').fill('60');
  await panel.getByRole('button', { name: 'Discard calendar changes', exact: true }).click();
  await page.evaluate(async () => { window.calendarProbe.entry.notes = 'Fresh authorized calendar notes.'; await window.calendarProbe.panel.sync(); });
  await expect(panel).toContainText('Fresh authorized calendar notes.');
  await page.evaluate(async () => { window.calendarProbe.fail = true; await window.calendarProbe.panel.sync(); });
  await expect(panel).toHaveAttribute('data-state', 'error'); await expect(panel).not.toContainText('Morgan Lee');
  await page.evaluate(() => { window.calendarProbe.fail = false; });
  await panel.getByRole('button', { name: 'Retry calendar', exact: true }).click();
  await expect(panel).toHaveAttribute('data-state', 'ready'); await expect(reminder).toBeEnabled();
  await expect(panel).toContainText('Fresh authorized calendar notes.');
  await page.evaluate(() => { window.calendarProbe.release = null; window.calendarProbe.held = true; window.calendarProbe.sync = window.calendarProbe.panel.sync(); });
  await expect.poll(() => page.evaluate(() => typeof window.calendarProbe.release)).toBe('function');
  await reminder.click();
  await expect(panel.getByLabel('Minutes before the entry')).toHaveValue('30');
  await expect(panel.getByRole('button', { name: 'Save calendar entry', exact: true })).toBeDisabled();
  await page.evaluate(async () => { window.calendarProbe.deny = true; window.calendarProbe.held = false; window.calendarProbe.release(); await window.calendarProbe.sync; });
  await expect(panel).toHaveAttribute('data-state', 'error');
  await expect(panel.getByLabel('Minutes before the entry')).toHaveCount(0);
  await expect(panel).not.toContainText('Morgan Lee');
  expect(await page.evaluate(() => window.calendarProbe.writes)).toEqual([]);
  await page.screenshot({ path: info.outputPath('calendar-private-cleared-after403.png'), fullPage: true });
  expect(errors).toEqual([]);
});
