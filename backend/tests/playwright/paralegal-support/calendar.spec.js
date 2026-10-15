const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { USER, MATTER, active, invitation, application, fixture, home } = require('./alignment-fixture');

test('Empty Home keeps the work summary, discovery action, and calendar usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page);
  await home(page);
  await expect(page.getByRole('heading', { name: 'For your review' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Messages', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your Matters', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Find work' })).toBeVisible();
  await expect(page.getByText('Nothing needs your attention right now.')).toBeVisible();
  const sections = await page.locator('.pv2-overview-primary > section').evaluateAll(nodes => nodes.map(node => ({
    name: node.getAttribute('aria-label'), top: node.getBoundingClientRect().top, width: node.getBoundingClientRect().width,
  })));
  expect(sections.slice(0, 4).map(section => section.name)).toEqual(['For your review', 'Messages', 'Your Matters', 'Find work']);
  expect(sections.slice(1).every((section, index) => section.top > sections[index].top && Math.abs(section.width - sections[0].width) < 1)).toBe(true);
  await expect(page.getByRole('link', { name: 'Browse Matters →' })).toHaveAttribute('href', 'paralegal-v2.html#/browse');
  await expect(page.getByText('Your practice areas')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Civil Litigation Browse area →' })).toHaveAttribute('href', /browse\?practice=Civil%20Litigation$/);
  await expect(page.getByText('No matches in your areas today')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Work summary' }).getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('link', { name: '0 Active Matters' })).toHaveAttribute('href', /work\?section=active$/);
  await expect(page.getByRole('button', { name: 'Applications', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-home-calendar]')).toBeVisible();
  await expect(page.locator('[data-home-calendar]')).toContainText('Matter deadlines will appear here once you begin work.');
  await page.screenshot({ path: testInfo.outputPath('paralegal-empty-home.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Browse Matters →' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('paralegal-empty-home-mobile.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('theme-dark'));
  await page.screenshot({ path: testInfo.outputPath('paralegal-empty-home-mobile-dark.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('theme-dark'));
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole('link', { name: 'Browse Matters →' })).toBeVisible();
  const browseRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/jobs/open' && url.searchParams.get('view') === 'browse';
  });
  await page.getByRole('link', { name: 'Browse Matters →' }).click();
  await browseRequest;
  await expect(page).toHaveURL(/#\/browse/);
});

test('Current Home is accessible at desktop and mobile sizes', async ({ page }) => {
  await fixture(page, { dashboard: { activeCases: [active()], metrics: {} }, applications: [application()] });
  await home(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(audit.violations, `${width}px accessibility violations`).toEqual([]);
  }
});

test('Home gives verified matching Matters their own scannable rows', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page, { recommendations: { hasMatchingProfile: true, items: [
    { _id: '64b000000000000000010004', title: 'Prepare a medical chronology', practiceArea: 'Civil Litigation', state: 'New York', briefSummary: 'Review treatment records and identify gaps in care.', totalAmount: 65000, deadlineDate: '2026-10-01', status: 'open' },
    { _id: '64b000000000000000010005', title: 'Organize deposition exhibits', practiceArea: 'Civil Litigation', state: 'New York', briefSummary: 'Organize the provided exhibits for an upcoming deposition.', totalAmount: 50000, status: 'open' },
  ] } });
  await home(page);
  const matches = page.getByRole('region', { name: 'Matters for you' });
  await expect(matches.getByRole('link')).toHaveCount(3);
  await expect(matches).toContainText('Prepare a medical chronology');
  await expect(matches).toContainText('$650');
  await expect(matches).toContainText('Due Oct 1');
  await expect(page.getByText('No matches in your areas today')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('paralegal-home-with-matches.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(matches.getByText('Prepare a medical chronology')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('paralegal-home-with-matches-mobile.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('theme-dark'));
  await expect(matches.getByText('Organize deposition exhibits')).toBeVisible();
  await expect.poll(() => matches.locator('.pv2-overview-match').first().evaluate(row => getComputedStyle(row).color)).toBe('rgb(242, 245, 249)');
  await page.screenshot({ path: testInfo.outputPath('paralegal-home-with-matches-mobile-dark.png'), fullPage: true });
});

test('Home puts current work before opportunities without a caught-up message', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page, {
    dashboard: { activeCases: [active()], metrics: {} },
    recommendations: { hasMatchingProfile: true, items: [
      { _id: '64b000000000000000010004', title: 'Prepare a medical chronology', practiceArea: 'Civil Litigation', state: 'New York', briefSummary: 'Review treatment records and identify gaps in care.', totalAmount: 65000, status: 'open' },
    ] },
  });
  await home(page);
  const current = page.getByRole('region', { name: 'Your Matters' });
  const matches = page.getByRole('region', { name: 'Matters for you' });
  await expect(current).toContainText('Discovery response support');
  await expect(matches).toContainText('Prepare a medical chronology');
  await expect(page.getByText("You're caught up.")).toHaveCount(0);
  expect(await current.evaluate((node, next) => Boolean(node.compareDocumentPosition(document.querySelector(next)) & Node.DOCUMENT_POSITION_FOLLOWING), '.pv2-overview-matches')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('paralegal-home-with-work.png') });
});

test('Home keeps the browse action available with an incomplete profile and distinguishes unavailable recommendations', async ({ page }) => {
  const state = await fixture(page, { recommendations: { hasMatchingProfile: false, items: [] } });
  state.profile.practiceAreas = [];
  await home(page);
  await expect(page.getByRole('heading', { name: 'Find work' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse Matters →' })).toHaveAttribute('href', 'paralegal-v2.html#/browse');
  state.failures.recommendations = 503;
  await page.reload();
  await expect(page.getByText('No matches in your areas today')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Find work' })).toBeVisible();
  await expect(page.locator('[data-home-source-state="partial"]')).toBeVisible();
  state.failures.recommendations = 0;
  state.failures.profile = 503;
  await page.reload();
  await expect(page.locator('[data-home-source-state="partial"]')).toBeVisible();
  await expect(page.locator('.pv2-overview-side')).toBeHidden();
  await expect(page.locator('[data-home-calendar]')).toBeVisible();
});

test('Home calendar shows only engaged Matter deadlines in week and month views', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page, {
    dashboard: { activeCases: [active()], metrics: {} },
    invites: { items: [invitation({ deadlineDate: '2026-09-09' })] },
    applications: [application()],
  });
  await home(page);
  const calendar = page.locator('[data-home-calendar]');
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole('button', { name: 'Full month view' })).toHaveAttribute('aria-pressed', 'false');
  await expect(calendar).toContainText('No Matter deadlines this week.');
  await calendar.getByRole('button', { name: 'Next week' }).click();
  await calendar.getByRole('button', { name: 'Next week' }).click();
  await calendar.getByRole('button', { name: 'Next week' }).click();
  await expect(calendar.locator('[data-calendar-date="2026-10-01"]')).toContainText('Discovery response support');
  await expect(calendar.getByRole('link', { name: 'Discovery response support' })).toHaveAttribute('href', new RegExp(`matter/${MATTER}\\?tab=deadlines`));
  await expect(calendar).not.toContainText('Probate inventory support');
  await page.screenshot({ path: testInfo.outputPath('paralegal-week-calendar.png') });
  await calendar.getByRole('button', { name: 'Full month view' }).click();
  await expect(calendar.getByRole('button', { name: 'Week view' })).toHaveAttribute('aria-pressed', 'true');
  await calendar.getByRole('button', { name: 'Next month' }).click();
  await expect(calendar.locator('.pv2-calendar-period')).toHaveText('October 2026');
  await calendar.getByRole('button', { name: /Thursday, October 1, 2026, 1 Matter deadline/ }).click();
  await expect(calendar.locator('.pv2-calendar-agenda')).toContainText('Discovery response support');
  await page.screenshot({ path: testInfo.outputPath('paralegal-month-calendar.png') });
  await calendar.getByRole('button', { name: 'Previous month' }).click();
  await expect(calendar.locator('.pv2-calendar-period')).toHaveText('September 2026');
});

test('Calendar updates with engagements and does not expose another paralegal Matter', async ({ page }) => {
  const state = await fixture(page, {
    dashboard: { activeCases: [active({ deadlineDate: '2026-09-10' }), active({ caseId: '64b000000000000000010099', paralegalId: '64b000000000000000000099', jobTitle: 'Other assignment', deadlineDate: '2026-09-11' })], metrics: {} },
  });
  await home(page);
  const calendar = page.locator('[data-home-calendar]');
  await expect(calendar).toContainText('Discovery response support');
  await expect(calendar).not.toContainText('Other assignment');
  state.dashboard.activeCases = [active({ caseId: MATTER, jobTitle: 'Updated assignment', deadlineDate: '2026-09-12', paralegalId: USER })];
  await page.reload();
  await expect(calendar.locator('[data-calendar-date="2026-09-12"]')).toContainText('Updated assignment');
  await expect(calendar).not.toContainText('Discovery response support');
  state.dashboard.activeCases = [];
  await page.reload();
  await expect(calendar).toContainText('Matter deadlines will appear here once you begin work.');
});

test('Calendar distinguishes an unavailable dashboard from an empty week', async ({ page }) => {
  await fixture(page, { failures: { dashboard: 503 } });
  await home(page);
  const calendar = page.locator('[data-home-calendar]');
  await expect(calendar).toContainText('Matter deadlines could not be loaded.');
  await expect(calendar).not.toContainText('No Matter deadlines this week.');
});

test('Calendar remains usable at a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { dashboard: { activeCases: [active({ deadlineDate: '2026-09-10' })], metrics: {} } });
  await home(page);
  const calendar = page.locator('[data-home-calendar]');
  await expect(calendar.getByRole('link', { name: 'Discovery response support' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await calendar.getByRole('button', { name: 'Full month view' }).click();
  await calendar.getByRole('button', { name: /Thursday, September 10, 2026, 1 Matter deadline/ }).click();
  await expect(calendar.locator('.pv2-calendar-agenda')).toContainText('Discovery response support');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('paralegal-mobile-calendar.png'), fullPage: true });
});
