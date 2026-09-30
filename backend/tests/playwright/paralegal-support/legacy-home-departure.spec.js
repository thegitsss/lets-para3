const { test, expect } = require('../payment-summary/legacy-fixture');
const { install } = require('./legacy-home-fixture');
for (const [departure, returned] of [['beforeunload', 'pageshow'], ['pagehide', 'pageshow'], ['beforeunload', 'focus']]) test(`current paralegal Home stops queued reads on ${departure} and rechecks on ${returned}`, async ({ page }, info) => {
  await page.addInitScript(() => {
    window.__departureFetches = []; window.__departed = false;
    const original = window.fetch;
    window.fetch = function (input, options) { window.__departureFetches.push({ url: String(input?.url || input), method: options?.method || "GET", departed: window.__departed, stack: new Error().stack }); return original.call(this, input, options); };
  });
  const state = await install(page, { count: 0 });
  await expect(page.locator('[data-paralegal-priority-list]')).toHaveAttribute('data-state', 'ready');
  state.hold = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect.poll(() => state.held.length).toBeGreaterThan(0);
  await page.evaluate(type => {
    window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh'));
    window.__departed = true;
    window.dispatchEvent(new Event(type));
  }, departure);
  state.hold = false; state.held.splice(0).forEach(release => release());
  // Release the held response and give its queued completion a bounded turn.
  // This is observation of late I/O, not an increased application deadline.
  await page.waitForTimeout(400);
  const observed = await page.evaluate(() => window.__departureFetches);
  await info.attach("fetch-departure-observations", { body: JSON.stringify(observed, null, 2), contentType: "application/json" });
  // Count initiation in the document. A previously started request can reach
  // Playwright's route handler after the departure marker.
  expect(observed.filter(row => row.departed)).toEqual([]);
  const stopped = state.reads['/api/paralegal/dashboard'];
  await page.evaluate(type => window.dispatchEvent(type === 'pageshow' ? new PageTransitionEvent('pageshow', { persisted: true }) : new Event('focus')), returned);
  await expect.poll(() => state.reads['/api/paralegal/dashboard']).toBeGreaterThan(stopped);
  await expect(page.locator('[data-paralegal-priority-list]')).toHaveAttribute('data-state', 'ready');
  expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
});
