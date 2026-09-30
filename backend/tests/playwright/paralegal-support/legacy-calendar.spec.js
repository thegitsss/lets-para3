const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { install, MATTER } = require('./legacy-home-fixture');
const calendar = page => page.locator('#deadlineList');
const ready = page => expect(calendar(page)).toHaveAttribute('data-state', 'ready');

test('original calendar combines all reminder pages and Matter dates without hiding later entries', async ({ page }) => {
  const state = await install(page); await ready(page);
  // Initial notification delivery can queue another legitimate dashboard read.
  // Require the complete first traversal and ordered pages in every later
  // cycle, including a refresh whose second page is still in flight.
  const initialPages = state.pages.slice();
  expect(initialPages.slice(0, 2)).toEqual([1, 2]);
  expect(initialPages.every((pageNumber, index) => pageNumber === index % 2 + 1)).toBe(true);
  const nav = page.getByRole('navigation', { name: 'Calendar pages' });
  await expect(nav).toContainText('1–5 of 204'); const seen = new Set();
  for (let p = 1; p <= 41; p++) {
    for (const key of await calendar(page).locator('[data-calendar-key]').evaluateAll(nodes => nodes.map(node => node.dataset.calendarKey))) { expect(seen.has(key)).toBe(false); seen.add(key); }
    if (p < 41) await nav.getByRole('button', { name: 'Next calendar page' }).click();
  }
  expect(seen.size).toBe(204); await expect(calendar(page)).toBeFocused();
  await expect(calendar(page).getByRole('link')).toHaveAttribute('href', `case-detail.html?caseId=${MATTER}&tab=work`);
  await expect(calendar(page)).toContainText('Reminder 203'); await expect(calendar(page)).toContainText('Matter deadline —');
  await page.reload(); await ready(page); await expect(nav).toContainText('201–204 of 204');
  await expect(page.locator('[data-paralegal-priority-list]')).not.toContainText('deadline');
  expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
});

test('failed later reminder pages and failed Matter reads remain visibly incomplete and retry', async ({ page }) => {
  const state = await install(page, { failure: 'events' });
  await expect(calendar(page)).toHaveAttribute('data-state','unavailable');
  await expect(calendar(page)).toContainText('Private reminders couldn’t load.'); await expect(calendar(page)).toContainText('Matter deadline —');
  await expect(calendar(page)).not.toContainText('Reminder 001'); await expect(calendar(page)).not.toContainText('No deadlines');
  state.failure = ''; await calendar(page).getByRole('button',{name:'Retry calendar'}).click(); await ready(page);
  state.failure = 'dashboard'; await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect(calendar(page)).toHaveAttribute('data-state','unavailable'); await expect(calendar(page)).toContainText('Matter deadlines couldn’t load.');
  await expect(page.locator('#assignmentList')).not.toContainText('Matter deadline —');
  state.failure = ''; await calendar(page).getByRole('button',{name:'Retry calendar'}).click(); await ready(page);
  expect(state.errors).toEqual([]);
});

test('an empty calendar stays distinct from an unavailable one and clears on account departure', async ({ page }) => {
  const state = await install(page, { empty: true }); await ready(page); await expect(calendar(page)).toContainText('No deadlines or reminders this week.');
  state.empty = false; await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh'))); await ready(page); await expect(calendar(page)).toContainText('Reminder 001');
  await page.evaluate(() => { localStorage.removeItem('lpc_user'); window.dispatchEvent(new StorageEvent('storage',{key:'lpc_user'})); });
  await expect(page.locator('#paralegalHomeView')).toHaveAttribute('data-state','account-changed');
  await expect(page.locator('#paralegalHomeView')).not.toContainText('Reminder 001'); expect(state.errors).toEqual([]);
});

test('leaving while a calendar refresh is pending discards it and returning reloads the full period', async ({ page }) => {
  const state = await install(page, { count: 6 }); await ready(page);
  state.hold = true; await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect.poll(() => state.held.length).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(calendar(page)).toHaveAttribute('data-state', 'loading'); await expect(calendar(page)).not.toContainText('Reminder 001');
  state.hold = false; state.held.splice(0).forEach(resolve => resolve());
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await ready(page); await expect(calendar(page)).toContainText('Reminder 001'); expect(state.errors).toEqual([]);
});

test('calendar layout wraps long titles with accessible controls in both themes and enlarged phone text', async ({ page }, testInfo) => {
  const state = await install(page, { count: 6 }); await ready(page);
  for (const theme of ['light', 'dark']) for (const [width, scale] of [[1440,1],[390,1],[390,2],[320,2]]) {
    await page.setViewportSize({width,height:1000});
    await page.evaluate(({theme,scale}) => { document.documentElement.dataset.theme = theme; document.body.dataset.theme = theme; document.documentElement.classList.toggle('theme-dark',theme==='dark'); document.body.classList.toggle('theme-dark',theme==='dark'); document.documentElement.style.fontSize = `${16*scale}px`; }, {theme,scale});
    await calendar(page).scrollIntoViewIfNeeded();
    const result = await new AxeBuilder({page}).include('.private-office-calendar').analyze(); expect(result.violations).toEqual([]);
    const bad = await calendar(page).locator('a,strong,button,nav').evaluateAll(nodes => nodes.filter(n=>n.scrollWidth>n.clientWidth+2 || n.scrollHeight>n.clientHeight+2).map(n=>n.outerHTML)); expect(bad).toEqual([]);
    if (scale === 2) expect(await calendar(page).locator('.office-calendar-entry > div').evaluateAll(nodes=>nodes.every(n=>n.clientWidth>=n.parentElement.clientWidth-2))).toBe(true);
    if (scale === 1) {
      const boxes = await calendar(page).locator('nav button').evaluateAll(nodes=>nodes.map(n=>({y:n.getBoundingClientRect().y,height:n.getBoundingClientRect().height})));
      expect(boxes[0].y).toBe(boxes[1].y); expect(boxes.every(b=>b.height>=44)).toBe(true);
    }
    await page.screenshot({path:testInfo.outputPath(`${theme}-${width}-${scale}.png`)});
  }
  expect(state.errors).toEqual([]);
});
