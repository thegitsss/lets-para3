const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

async function actors() {
  const attorney = await server.createUser('attorney'), paralegal = await server.createUser('paralegal', {}, true);
  await require('../../../models/User').updateMany({}, { $set: { isFirstLogin: false, 'onboarding.attorneyTourCompleted': true, 'onboarding.paralegalTourCompleted': true, 'onboarding.paralegalProfileTourCompleted': true } });
  return { attorney, paralegal };
}
async function matter(people) {
  return require('../../../models/Case').create({ title: 'River Street exhibits', details: 'Prepare agreed exhibits.', attorney: people.attorney.id, attorneyId: people.attorney.id, paralegal: people.paralegal.id, paralegalId: people.paralegal.id, hiredAt: new Date(), status: 'in progress', totalAmount: 40000, lockedTotalAmount: 40000, currency: 'usd', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_behavior', tasks: [{ title: 'Prepare exhibits', completed: false }] });
}
async function session(browser, actor, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}
async function ready(page) {
  await page.locator('.lpc-boot-screen[open]').waitFor({ state: 'hidden' });
  await page.evaluate(() => document.fonts.ready);
}
async function a11y(page, selector) {
  expect((await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
function providersUntouched() {
  const evidence = server.evidence();
  expect(evidence.external.mail).toEqual([]); expect(evidence.external.storage).toEqual([]);
  expect(evidence.requests.filter(row => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(row.method))).toEqual([]);
}

for (const role of ['attorney', 'paralegal']) for (const width of [1440, 390]) test(`${role} document-only search and no-match recovery ${width}`, async ({ browser }, info) => {
  const people = await actors(), doc = await matter(people);
  const file = await require('../../../models/CaseFile').create({ caseId: doc._id, userId: people.paralegal.id, originalName: 'Chronology.pdf', storageKey: `cases/${doc._id}/chronology.pdf`, uploadedByRole: 'paralegal', mimeType: 'application/pdf', securityStatus: 'clean' });
  const { context, page, errors } = await session(browser, people[role], width);
  try {
    await page.goto(`${server.origin}/${role}-v2.html#/home`); await ready(page);
    await page.keyboard.press('ControlOrMeta+KeyK');
    const input = page.locator(role === 'attorney' ? '#av2-query' : '[data-v2-search-input]');
    const panel = page.locator(role === 'attorney' ? '[data-av2-panel="search"]' : '[data-v2-search-panel]');
    await expect(input).toBeFocused(); await input.fill('Chronology'); await input.press('Enter');
    const option = panel.getByRole('option', { name: /Chronology.pdf/ });
    await expect(option).toBeVisible(); await expect(panel).not.toContainText('No results');
    await expect(panel.locator('[role="status"]').filter({ hasText: '1 result available.' })).toHaveCount(1);
    await expect(option).toHaveAttribute('href', role === 'attorney' ? `/attorney-v2.html#/matters/${doc._id}/files?fileId=${file._id}` : `/paralegal-v2.html#/matter/${doc._id}?tab=files&fileId=${file._id}`);
    await a11y(page, role === 'attorney' ? '[data-av2-panel="search"]' : '[data-v2-search-panel]');
    await page.screenshot({ path: info.outputPath(`${role}-document-result-${width}.png`) });
    await input.fill('NoSuchRecord734'); await input.press('Enter');
    await expect(panel).toContainText('No results for “NoSuchRecord734”.');
    await expect(panel).toContainText(role === 'attorney' ? 'Try a Matter title, document name, or paralegal name.' : 'Try a Matter title or document name.');
    await page.screenshot({ path: info.outputPath(`${role}-no-match-${width}.png`) });
    await panel.getByRole('button', { name: 'Clear search', exact: true }).focus();
    await page.keyboard.press('Enter'); await expect(input).toHaveValue(''); await expect(input).toBeFocused();
    await input.fill('Chronology'); await input.press('Enter'); await expect(option).toBeVisible();
    await input.press('ArrowDown'); await expect(option).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter'); await expect(page).toHaveURL(new RegExp(`fileId=${file._id}`));
    providersUntouched(); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Attorney receipt filters survive refresh and browser return and clear only their own scope', async ({ browser }, info) => {
  const people = await actors(), doc = await matter(people), { context, page, errors } = await session(browser, people.attorney);
  const query = new URLSearchParams({ q: 'River', caseId: String(doc._id), from: 'notice', matterOrigin: `#/matters/${doc._id}/financials?returnHome=1` });
  const records = page.locator('[data-payment-records]');
  try {
    await page.goto(`${server.origin}/attorney-v2.html#/payments?${query}`); await ready(page);
    await expect(records).toHaveAttribute('data-state', 'ready');
    await records.getByLabel('Payment records', { exact: true }).selectOption('unreleased');
    await records.getByLabel('Matter title', { exact: true }).fill('NoSuchRecord734');
    await records.getByRole('button', { name: 'Filter payment records', exact: true }).click();
    await expect(records).toContainText('No Matters match these payment filters.');
    await expect(records.locator('[data-payment-applied-filters]')).toContainText('NoSuchRecord734');
    await expect(page).toHaveURL(/receiptView=unreleased&receiptQ=NoSuchRecord734/);
    await expect(page.locator('#av2-financial-search')).toHaveValue('River');
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await a11y(page, '[data-payment-records]'); await page.screenshot({ path: info.outputPath(`payment-filters-${width}.png`), fullPage: true }); }
    await page.reload(); await ready(page); await expect(records).toHaveAttribute('data-state', 'ready');
    await expect(records.getByLabel('Matter title', { exact: true })).toHaveValue('NoSuchRecord734');
    await records.getByRole('link', { name: 'Open Matter', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/matters/${doc._id}/overview`));
    await page.goBack(); await expect(records).toHaveAttribute('data-state', 'ready');
    await expect(records.getByLabel('Matter title', { exact: true })).toHaveValue('NoSuchRecord734');
    await records.getByRole('button', { name: 'Clear filters', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(records.getByLabel('Matter title', { exact: true })).toHaveValue('');
    await expect(records.getByLabel('Payment records', { exact: true })).toHaveValue('all');
    await expect(records).toHaveAttribute('data-state', 'ready');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(records.getByLabel('Matter title', { exact: true })).toBeFocused();
    await expect(records.getByRole('button', { name: 'Clear filters', exact: true })).toBeHidden();
    const retained = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?').slice(1).join('?'))));
    expect(retained).toMatchObject({ q: 'River', caseId: String(doc._id), from: 'notice', matterOrigin: `#/matters/${doc._id}/financials?returnHome=1`, receiptView: 'all', receiptQ: '' });
    await expect(page.locator('#av2-financial-search')).toHaveValue('River');
    await page.reload(); await ready(page); await expect(records.getByLabel('Matter title', { exact: true })).toHaveValue('');
    providersUntouched(); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Payout retry keeps navigation usable and preserves the selected section through reload', async ({ browser }, info) => {
  const people = await actors(), { context, page, errors } = await session(browser, people.paralegal, 390);
  let fail = true, release, arrived = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/api/paralegal/dashboard', async route => {
    if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    arrived = true; await gate; await route.fallback().catch(() => {});
  });
  const root = page.locator('[data-v2-payouts]');
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/payouts?from=notice`); await ready(page);
    await expect(root).toHaveAttribute('data-state', 'unavailable'); await expect(root).toContainText('Payout totals unavailable.');
    await expect(root).not.toContainText('$0.00'); await expect(root.getByRole('button', { name: 'Retry payouts', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('payout-unavailable-390.png') });
    fail = false; await root.getByRole('button', { name: 'Retry payouts', exact: true }).click(); await expect.poll(() => arrived).toBe(true);
    await expect(root).toHaveAttribute('data-state', 'loading'); await expect(root.getByRole('navigation', { name: 'Payout sections' })).toBeVisible();
    await root.getByRole('button', { name: 'Payout account', exact: true }).click();
    await expect(root.getByRole('link', { name: 'Manage payout account', exact: true })).toBeVisible();
    await root.getByRole('button', { name: 'Needs attention', exact: true }).click();
    await expect(page).toHaveURL(/from=notice&section=attention/); await page.screenshot({ path: info.outputPath('payout-retry-navigation-390.png') });
    release(); await expect(root).toHaveAttribute('data-state', 'ready'); await expect(root).toContainText('No payments need attention.');
    await expect(root.getByRole('button', { name: 'Retry payouts', exact: true })).toHaveCount(0);
    await page.reload(); await ready(page); await expect(root).toHaveAttribute('data-state', 'ready');
    await expect(root.getByRole('button', { name: 'Needs attention', exact: true })).toHaveAttribute('aria-current', 'page');
    await a11y(page, '[data-v2-payouts]');
    await root.getByRole('button', { name: 'Payment records', exact: true }).click();
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await a11y(page, '[data-v2-payouts]'); await page.screenshot({ path: info.outputPath(`payout-recovered-${width}.png`) }); }
    providersUntouched(); expect(errors).toEqual([]);
  } finally { release(); await context.close(); }
});

test('Payout history failure preserves verified totals and offers a direct recovery', async ({ browser }) => {
  const people = await actors(), { context, page, errors } = await session(browser, people.paralegal);
  let failed = true, reads = 0;
  await page.route(url => url.pathname === '/api/cases/my-completed', route => { reads++; return failed ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.fallback(); });
  const root = page.locator('[data-v2-payouts]');
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/payouts`); await ready(page);
    await expect(root).toHaveAttribute('data-state', 'ready'); await expect(root).toContainText('No confirmed payouts yet.');
    await expect(root).toContainText('Payment records are currently unavailable.');
    await expect(root.getByRole('button', { name: 'Retry payouts', exact: true })).toHaveCount(1);
    failed = false; await root.getByRole('button', { name: 'Retry payouts', exact: true }).click();
    await expect(root).toContainText('No payment records yet.'); await expect(root.getByRole('button', { name: 'Retry payouts', exact: true })).toHaveCount(0);
    expect(reads).toBe(2); providersUntouched(); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Payout timeout can recover with a fresh request and cannot overwrite a later route', async ({ browser }) => {
  const people = await actors(), { context, page, errors } = await session(browser, people.paralegal);
  let failed = true, stall = false, arrived = false, release;
  let gate = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/api/paralegal/dashboard', async route => {
    if (failed) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    if (stall) { arrived = true; await gate; return route.abort('failed').catch(() => {}); }
    return route.fallback();
  });
  const root = page.locator('[data-v2-payouts]');
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/payouts`); await ready(page); await expect(root).toHaveAttribute('data-state', 'unavailable');
    await page.clock.install(); failed = false; stall = true;
    await root.getByRole('button', { name: 'Retry payouts', exact: true }).click(); await expect.poll(() => arrived).toBe(true);
    await page.clock.fastForward(10001); await expect(root).toHaveAttribute('data-state', 'unavailable');
    stall = false; release(); await root.getByRole('button', { name: 'Retry payouts', exact: true }).click();
    await expect(root).toHaveAttribute('data-state', 'ready'); await expect(root).toContainText('No confirmed payouts yet.');
    failed = true; await page.reload(); await ready(page); await expect(root).toHaveAttribute('data-state', 'unavailable');
    gate = new Promise(resolve => { release = resolve; }); failed = false; stall = true; arrived = false;
    await root.getByRole('button', { name: 'Retry payouts', exact: true }).click(); await expect.poll(() => arrived).toBe(true);
    await page.evaluate(() => { location.hash = '/help'; }); await expect(root).toHaveCount(0);
    release();
    await expect(page.locator('[data-v2-rendered-route="help"]')).toBeVisible();
    providersUntouched(); expect(errors).toEqual([]);
  } finally { release(); await context.close(); }
});

test('Account replacement during payout recovery clears protected content', async ({ browser }) => {
  const people = await actors(), { context, page } = await session(browser, people.paralegal);
  await page.route(url => url.pathname === '/api/paralegal/dashboard', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  const root = page.locator('[data-v2-payouts]');
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/payouts`); await ready(page); await expect(root).toHaveAttribute('data-state', 'unavailable');
    const other = await server.createUser('paralegal');
    await page.route(url => url.pathname === '/api/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: other.id, role: 'paralegal', status: 'approved' } }) }));
    await root.getByRole('button', { name: 'Retry payouts', exact: true }).click();
    await expect(page).toHaveURL(/login.html/); await expect(root).toHaveCount(0); providersUntouched();
  } finally { await context.close(); }
});
