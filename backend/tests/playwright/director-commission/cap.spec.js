const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server, contexts = [];
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeDirectors: true }); });
test.beforeEach(async () => server.reset());
test.afterEach(async ({}, info) => { await require('node:fs/promises').writeFile(info.outputPath('requests.json'), JSON.stringify(server.evidence().requests, null, 2)); for (const context of contexts.splice(0)) await context.close(); });
test.afterAll(async () => server?.close());
async function seed() {
  const director = await server.createUser('director');
  const User = require('../../../models/User'), Case = require('../../../models/Case'), Record = require('../../../models/DirectorOutreachRecord');
  const attorney = await server.createUser('attorney'), other = await server.createUser('attorney');
  const now = Date.now(), para = await server.createUser('paralegal');
  const retain = require('../../helpers/directorCommissionEvidence');
  for (const [index, owner] of [attorney, other].entries()) {
    const user = await User.findById(owner.id).lean();
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date('2019-01-02T12:00:00Z'), approvedAt: new Date('2019-01-03T12:00:00Z') } });
    await Record.create({ directorUserId: director.id, directorEmail: 'director@commission-cap.test', attorneyEmail: user.email, attorneyName: index ? 'Jordan Ellis' : 'Avery Lane', firstOutreachSentAt: new Date('2019-01-01T12:00:00Z'), stage: 'outreach_sent' });
    for (let i = 0; i < 30; i++) await retain({ attorney: { _id: owner.id }, paralegal: { _id: para.id }, amount: 100000, attorneyFee: 22000, completedAt: new Date(now - (60 - (i * 2 + index)) * 60000) });
  }
  return { director, attorney, other };
}
async function pageFor(browser, actor) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [], pendingReads = new Set();
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) pendingReads.clear(); });
  page.on('request', request => { if (new URL(request.url()).origin === server.origin && new URL(request.url()).pathname.startsWith('/api/') && request.method() === 'GET' && ['fetch', 'xhr'].includes(request.resourceType()) && !/\/stream(?:\?|$)/.test(request.url())) pendingReads.add(request); });
  page.on('requestfinished', request => pendingReads.delete(request));
  page.on('requestfailed', request => pendingReads.delete(request));
  page.on('pageerror', error => errors.push(error.message));
  // These original screens require the browser identity written by login as
  // well as the managed cookie. Exercise real login rather than forge storage.
  const user = await require('../../../models/User').findById(actor.id).lean();
  await page.goto(server.origin + '/login.html');
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill('Private synthetic lifecycle password!');
  await Promise.all([
    page.waitForURL(user.role === 'director' ? /director-portal\.html/ : /admin-dashboard\.html/),
    page.locator('#loginForm button[type="submit"]').click(),
  ]);
  const response = await context.request.get(server.origin + '/api/auth/me');
  const session = await response.json();
  expect(session.user?.role).toBe(user.role);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user') || 'null')?.role)).toBe(user.role);
  if (user.role === 'admin') {
    await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
    // The action board starts a second read phase after analytics. An empty
    // request set between phases is not dashboard readiness; let its actual
    // loader settle before leaving the document (WebKit reports aborted reads).
    await page.waitForFunction(() => typeof window.loadOverviewActionBoard === 'function');
    await page.evaluate(() => window.loadOverviewActionBoard());
    await expect.poll(() => [...pendingReads].map(request => ({ path: new URL(request.url()).pathname, type: request.resourceType() }))).toEqual([]);
  }
  return { page, errors };
}
test('director cap remains 50 across date filters, desktop and mobile', async ({ browser }, info) => {
  const { director } = await seed(), { page, errors } = await pageFor(browser, director);
  await expect(page.locator('#metricCompletedCap')).toHaveText('50/50');
  await expect(page.locator('.completed-card')).toContainText('Lifetime commissionable Matters');
  await expect(page.locator('#recordsBody tr')).toHaveCount(2);
  await expect(page.locator('.performance-chart__empty')).toBeHidden();
  await expect(page.locator('#recordsBody')).toContainText('USD 2,750.00');
  for (const range of ['1', '30', '7']) {
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/director/analytics' && new URL(response.url()).searchParams.get('days') === range),
      page.locator('#rangeFilter').selectOption(range),
    ]);
    expect(response.ok()).toBe(true);
    expect((await response.json()).commissionLifetime.commissionableMatterCount).toBe(50);
    await expect(page.locator('#directorStatus')).not.toHaveText(/loading/i);
    await expect(page.locator('#metricCompletedCap')).toHaveText('50/50');
  }
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 900 }]]) {
    await page.setViewportSize(viewport); await page.locator('.completed-card').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const layout = await page.locator('.completed-card').evaluate(card => { const note = card.querySelector('.metric-note').getBoundingClientRect(), bar = card.querySelector('.completed-progress').getBoundingClientRect(); return { noteBottom: note.bottom, barTop: bar.top }; });
    expect(layout.barTop).toBeGreaterThanOrEqual(layout.noteBottom);
    await page.screenshot({ path: info.outputPath(`director-cap-${name}.png`) });
  }
  expect(errors).toEqual([]);
  expect(server.evidence().external.mail).toHaveLength(0);
});
test('admin displays the same capped total and excludes later Matters in the audit', async ({ browser }, info) => {
  await seed(); const admin = await server.createUser('admin'), { page, errors } = await pageFor(browser, admin);
  await page.locator('.admin-nav-group > summary').filter({ hasText: 'Growth' }).click();
  await page.getByRole('link', { name: 'Directors', exact: true }).click();
  await expect(page).toHaveURL(/admin-directors\.html/);
  await expect(page.locator('#metricCommission')).toHaveText('USD 5,500.00 · Test');
  await expect(page.locator('#commissionPayablesBody tr')).toHaveCount(2);
  await page.locator('#commissionPayablesBody [data-audit-id]').first().click();
  await expect(page.locator('#auditBody tbody tr')).toHaveCount(30);
  expect(await page.locator('#auditPanel').evaluate(element => element.matches(':modal'))).toBe(true);
  expect(await page.locator('#downloadCsvBtn').evaluate(element => { element.focus(); return document.activeElement === element; })).toBe(false);
  expect((await page.locator('#auditBody tbody tr td:last-child').allTextContents()).map(text => text.replace(/\s+/g, ' ').trim())).toEqual(expect.arrayContaining(['USD 0.00 · Test', 'USD 110.00 · Test']));
  await page.screenshot({ path: info.outputPath('admin-cap-audit.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#auditPanel')).toBeHidden();
  await expect(page.locator('#commissionPayablesBody [data-audit-id]').first()).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('admin-cap-mobile.png') });
  expect(errors).toEqual([]); expect(server.evidence().external.mail).toHaveLength(0);
});


test('a director with no completed Matters sees an empty cap and chart without overlap', async ({ browser }, info) => {
  const director = await server.createUser('director'), { page, errors } = await pageFor(browser, director);
  await expect(page.locator('#metricCompletedCap')).toHaveText('0/50');
  await expect(page.locator('.performance-chart__empty')).toBeVisible();
  await expect(page.locator('.performance-chart svg polyline')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('director-empty-cap.png') });
  expect(errors).toEqual([]);
});


async function seedOne({ mixed = false, review = false } = {}) {
  const director = await server.createUser('director'), attorney = await server.createUser('attorney'), para = await server.createUser('paralegal');
  const User = require('../../../models/User'), Record = require('../../../models/DirectorOutreachRecord');
  const owner = await User.findById(attorney.id).lean();
  await User.collection.updateOne({ _id: owner._id }, { $set: { createdAt: new Date('2019-01-02T12:00:00Z'), approvedAt: new Date('2019-01-03T12:00:00Z') } });
  await Record.create({ directorUserId: director.id, directorEmail: 'director@commission.test', attorneyEmail: owner.email, attorneyName: 'Avery Lane', firstOutreachSentAt: new Date('2019-01-01T12:00:00Z') });
  const retain = require('../../helpers/directorCommissionEvidence');
  const retained = await retain({ attorney: owner, paralegal: { _id: para.id } });
  if (mixed) await retain({ attorney: owner, paralegal: { _id: para.id }, currency: 'eur' });
  if (review) await require('../../../models/PlatformIncome').collection.updateOne({ _id: retained.income._id }, { $set: { feeAmount: 1 } });
  return { director, attorney, retained };
}
async function directorAdminPage(browser) {
  const admin = await server.createUser('admin'), result = await pageFor(browser, admin);
  await result.page.locator('.admin-nav-group > summary').filter({ hasText: 'Growth' }).click();
  await result.page.getByRole('link', { name: 'Directors', exact: true }).click();
  await expect(result.page).toHaveURL(/admin-directors\.html/);
  return result;
}

test('unverified fees remain review items across director, admin and audit', async ({ browser }, info) => {
  const { director } = await seedOne({ review: true }), { page, errors } = await pageFor(browser, director);
  await expect(page.locator('#metricCompletedCap')).toHaveText('Needs review');
  await expect(page.locator('#recordsBody [data-label="Commission"]')).toHaveText('Needs review');
  await expect(page.locator('#completedMatterBar')).toBeHidden();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.completed-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('director-review-narrow.png') });
  const adminView = await directorAdminPage(browser);
  await expect(adminView.page.locator('#metricCommission')).toHaveText('Needs review');
  await expect(adminView.page.locator('[data-payout-id]')).toBeDisabled();
  await adminView.page.locator('#commissionPayablesBody [data-audit-id]').click();
  await expect(adminView.page.locator('#auditBody [data-label="Fee evidence"]')).toHaveText('Needs review');
  await expect(adminView.page.locator('#auditBody tbody tr td:last-child')).toHaveText('—');
  await expect(adminView.page.locator('#auditBody')).not.toContainText('No events.');
  await adminView.page.screenshot({ path: info.outputPath('admin-review-audit.png') });
  expect(errors).toEqual([]); expect(adminView.errors).toEqual([]);
});

test('different currencies remain separate in both screens and the real CSV', async ({ browser }, info) => {
  const { director } = await seedOne({ mixed: true }), { page, errors } = await pageFor(browser, director);
  await expect(page.locator('#recordsBody [data-label="Commission"]')).toHaveText(/EUR\s+44.00 · Test.*USD\s+44.00 · Test/s);
  await expect(page.locator('#metricCompletedCap')).toHaveText('2/50');
  const adminView = await directorAdminPage(browser);
  await expect(adminView.page.locator('#metricCommission')).toHaveText(/EUR\s+44.00 · Test.*USD\s+44.00 · Test/s);
  const [download] = await Promise.all([adminView.page.waitForEvent('download'), adminView.page.locator('#downloadCsvBtn').click()]);
  const downloadPath = info.outputPath('commission-currencies.csv'); await download.saveAs(downloadPath);
  const csv = await require('node:fs/promises').readFile(downloadPath, 'utf8');
  expect(csv).toContain('44.00,EUR,test,recorded'); expect(csv).toContain('44.00,USD,test,recorded');
  await adminView.page.setViewportSize({ width: 320, height: 900 });
  expect(await adminView.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await adminView.page.screenshot({ path: info.outputPath('admin-currencies-narrow.png') });
  await adminView.page.setViewportSize({ width: 1280, height: 1000 });
  await adminView.page.evaluate(() => { document.documentElement.classList.add('theme-dark'); document.documentElement.style.fontSize = '200%'; });
  expect(await adminView.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(adminView.page.locator('#metricCommission')).toContainText('USD 44.00 · Test');
  const wrappedMoney = await adminView.page.locator('.commission-value').evaluateAll(elements => elements.flatMap(element => {
    const node = element.firstChild; if (!node || node.nodeType !== Node.TEXT_NODE) return [];
    return [...node.textContent.matchAll(/[A-Z]{3}\s+[\d,.]+/g)].filter(match => {
      const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      return [...range.getClientRects()].filter(rect => rect.width && rect.height).length !== 1;
    }).map(match => match[0]);
  }));
  expect(wrappedMoney).toEqual([]);
  await expect.poll(() => adminView.page.locator('#refreshBtn, #downloadCsvBtn').evaluateAll(elements => {
    const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722; };
    return Math.min(...elements.map(element => { const style = getComputedStyle(element), a = luminance(style.color), b = luminance(style.backgroundColor); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }));
  })).toBeGreaterThanOrEqual(4.5);
  expect(await adminView.page.locator('.skip-link').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await adminView.page.screenshot({ path: info.outputPath('admin-currencies-dark-large-text.png') });
  await adminView.page.locator('#commissionPayablesBody [data-audit-id]').click();
  await expect(adminView.page.locator('#auditBody tbody tr')).toHaveCount(2);
  expect(await adminView.page.locator('#auditPanel .audit-dialog').evaluate(element => {
    const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722; };
    const style = getComputedStyle(element), a = luminance(style.color), b = luminance(style.backgroundColor); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  })).toBeGreaterThanOrEqual(4.5);
  await expect(adminView.page.locator('#auditBody thead')).toBeHidden();
  const wrappedStatuses = await adminView.page.locator('#auditBody [data-label="Status"], #auditBody [data-label="Fee evidence"]').evaluateAll(elements => elements.filter(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    return [...range.getClientRects()].filter(rect => rect.width && rect.height).length !== 1;
  }).map(element => element.textContent));
  expect(wrappedStatuses).toEqual([]);
  await adminView.page.screenshot({ path: info.outputPath('admin-currencies-dark-audit.png') });
  await adminView.page.setViewportSize({ width: 390, height: 844 });
  expect(await adminView.page.locator('#auditPanel .audit-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await adminView.page.locator('#auditBody [data-label="Commission"]').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= parseFloat(getComputedStyle(element, '::before').fontSize))).toBe(true);
  await adminView.page.screenshot({ path: info.outputPath('admin-currencies-dark-audit-mobile.png') });



  expect(errors).toEqual([]); expect(adminView.errors).toEqual([]);
});

test('failed refreshes clear financial claims and recover through Refresh', async ({ browser }, info) => {
  const { director } = await seedOne(), { page, errors } = await pageFor(browser, director);
  await expect(page.locator('#metricCompletedCap')).toHaveText('1/50');
  const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Records temporarily unavailable.' }) });
  await page.route('**/api/director/overview?*', fail);
  await page.locator('#rangeFilter').selectOption('30');
  await expect(page.locator('#directorStatus')).toContainText('Unable to load director overview.');
  await expect(page.locator('#metricCompletedCap')).toHaveText('—');
  await expect(page.locator('#recordsBody')).toContainText('Records unavailable');
  await expect(page.locator('#recordsBody')).not.toContainText('No attorneys found');
  await page.screenshot({ path: info.outputPath('director-unavailable.png') });
  await page.unroute('**/api/director/overview?*', fail); await page.locator('#retryDirectorBtn').click();
  await expect(page.locator('#metricCompletedCap')).toHaveText('1/50');
  const adminView = await directorAdminPage(browser);
  await expect(adminView.page.locator('#metricCommission')).toHaveText('USD 44.00 · Test');
  await adminView.page.route('**/api/admin/directors/overview?*', fail); await adminView.page.locator('#refreshBtn').click();
  await expect(adminView.page.locator('#directorAdminStatus')).toContainText('Unable to load director oversight.');
  await expect(adminView.page.locator('#metricCommission')).toHaveText('—');
  await expect(adminView.page.locator('#downloadCsvBtn')).toBeDisabled();
  await expect(adminView.page.locator('[data-payout-id]')).toHaveCount(0);
  await adminView.page.unroute('**/api/admin/directors/overview?*', fail); await adminView.page.locator('#refreshBtn').click();
  await expect(adminView.page.locator('#metricCommission')).toHaveText('USD 44.00 · Test');
  expect(errors).toEqual([]); expect(adminView.errors).toEqual([]);
});

test('a different managed account cannot receive the previous viewer financial read', async ({ browser }, info) => {
  const { director } = await seedOne(), { page, errors } = await pageFor(browser, director);
  await expect(page.locator('#metricCompletedCap')).toHaveText('1/50');
  const replacement = await server.createUser('director');
  await page.context().addCookies([replacement.cookie]);
  const [response] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/director/overview'), page.locator('#rangeFilter').selectOption('30')]);
  expect(response.status()).toBe(403);
  expect(new URL(response.url()).searchParams.get('expectedOwnerId')).toBe(director.id);
  await expect(page.locator('#metricCompletedCap')).toHaveText('—');
  await expect(page.locator('#recordsBody')).not.toContainText('USD 44.00');
  await page.screenshot({ path: info.outputPath('director-account-changed.png') });
  expect(errors).toEqual([]);
});

async function fillPayment(page, amount = '10.00') {
  await page.locator('#paymentAmount').fill(amount);
  await page.locator('#paymentDate').fill('2026-09-01');
  await page.locator('#paymentReference').fill('Synthetic ACH reference');
  await page.locator('#paymentNote').fill('Private synthetic payment confirmation.');
}
async function savePayment(page) {
  const [response] = await Promise.all([page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/commission-payout')), page.locator('#savePaymentBtn').click()]);
  return { status: response.status(), body: await response.json() };
}
test('manual payment, later accrual, history and reversal agree across admin and director', async ({ browser }, info) => {
  const seeded = await seedOne(), directorView = await pageFor(browser, seeded.director), { page, errors } = await directorAdminPage(browser);
  await page.locator('#commissionPayablesBody [data-payout-id]').click();
  await expect(page.locator('#paymentAmount')).toBeVisible();
  expect(await page.locator('#paymentPanel').evaluate(element => element.matches(':modal'))).toBe(true);
  await fillPayment(page); const saved = await savePayment(page); expect(saved.status).toBe(200);
  expect(saved.body.record.commissionPayments).toMatchObject({ paidCents: 1000, outstandingCents: 3400 });
  await expect(page.locator('#paymentTitle')).toHaveText('Payment history saved');
  await page.locator('#closePaymentBtn').click();
  await expect(page.locator('#metricUnpaidCommission')).toHaveText('USD 34.00 · Test');
  await expect(page.locator('#commissionPayablesBody [data-payout-id]')).toBeFocused();
  await directorView.page.reload();
  await expect(directorView.page.locator('[data-payment-history]')).toHaveText('Partly paid');
  await directorView.page.locator('[data-payment-history]').click();
  await expect(directorView.page.locator('#directorPaymentBody .payment-entries')).toContainText('Sep 1, 2026');
  await expect(directorView.page.locator('#directorPaymentBody .payment-entries')).not.toContainText('Private synthetic');
  await directorView.page.setViewportSize({ width: 390, height: 844 });
  expect(await directorView.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(directorView.page.locator('#directorPaymentPanel')).toBeVisible();
  expect(await directorView.page.locator('#directorPaymentPanel').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await directorView.page.locator('#directorPaymentPanel').evaluate(element => element.matches(':modal'))).toBe(true);
  await directorView.page.screenshot({ path: info.outputPath('director-payment-mobile.png') });
  await directorView.page.keyboard.press('Escape');
  await expect(directorView.page.locator('#directorPaymentPanel')).toBeHidden();
  await expect(directorView.page.locator('[data-payment-history]')).toBeFocused();
  const retain = require('../../helpers/directorCommissionEvidence');
  await retain({ attorney: { _id: seeded.retained.matter.attorney }, paralegal: { _id: seeded.retained.matter.paralegal } });
  await page.locator('#refreshBtn').click(); await expect(page.locator('#metricUnpaidCommission')).toHaveText('USD 78.00 · Test');
  await page.locator('#commissionPayablesBody [data-audit-id]').click();
  await expect(page.locator('#auditBody .payment-entries')).toContainText('Synthetic ACH reference');
  await page.locator('#auditBody [data-payment-reverse]').click();
  await page.locator('#paymentNote').fill('Correction of synthetic bookkeeping only.');
  const reversed = await savePayment(page); expect(reversed.status).toBe(200);
  expect(reversed.body.record.commissionPayments).toMatchObject({ paidCents: 0, outstandingCents: 8800 });
  expect(reversed.body.record.commissionPayments.history).toHaveLength(2);
  await expect(page.locator('#paymentBody .payment-entries')).toContainText('Record reversed');
  await page.screenshot({ path: info.outputPath('admin-payment-reversal.png') });
  expect(errors).toEqual([]); expect(directorView.errors).toEqual([]); expect(server.evidence().external.mail).toHaveLength(0);
});
test('a stale payment form preserves entered details while the balance is reviewed again', async ({ browser }, info) => {
  const seeded = await seedOne(), { page, errors } = await directorAdminPage(browser);
  await page.locator('#commissionPayablesBody [data-payout-id]').click(); await fillPayment(page);
  const retain = require('../../helpers/directorCommissionEvidence');
  await retain({ attorney: { _id: seeded.retained.matter.attorney }, paralegal: { _id: seeded.retained.matter.paralegal } });
  expect((await savePayment(page)).status).toBe(409);
  await expect(page.locator('#paymentStatus')).toContainText('changed');
  await page.locator('#paymentBody [data-payment-reload]').click();
  await expect(page.locator('#paymentAmount')).toHaveValue('10');
  await expect(page.locator('#paymentReference')).toHaveValue('Synthetic ACH reference');
  await expect(page.locator('#paymentUnit')).toContainText('USD 88.00 · Test');
  expect((await savePayment(page)).status).toBe(200);
  await expect(page.locator('#paymentTitle')).toHaveText('Payment history saved');
  await page.screenshot({ path: info.outputPath('admin-payment-stale-return.png') });
  expect(errors).toEqual([]);
});
test('an unconfirmed payment response retries the same real write without duplication', async ({ browser }, info) => {
  await seedOne(); const { page, errors } = await directorAdminPage(browser); let intercepted = false;
  await page.route('**/api/admin/directors/records/*/commission-payout?*', async route => {
    if (intercepted) return route.continue(); intercepted = true;
    const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic response lost after commit.' }) });
  });
  await page.locator('#commissionPayablesBody [data-payout-id]').click(); await fillPayment(page);
  expect((await savePayment(page)).status).toBe(503);
  await expect(page.locator('#paymentAmount')).toBeDisabled();
  await expect(page.locator('#savePaymentBtn')).toHaveText('Retry record');
  const retry = await savePayment(page); expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(true);
  expect(retry.body.record.commissionPayments.history).toHaveLength(1);
  await expect(page.locator('#paymentTitle')).toHaveText('Payment history saved');
  await page.screenshot({ path: info.outputPath('admin-payment-retry.png') }); expect(errors).toEqual([]);
});
test('legacy reconciliation is explicit and payment forms reflow in dark enlarged text', async ({ browser }, info) => {
  const seeded = await seedOne(); const Record = require('../../../models/DirectorOutreachRecord');
  await Record.collection.updateOne({ directorUserId: new (require('mongoose').Types.ObjectId)(seeded.director.id) }, { $set: { commissionPayoutStatus: 'paid', commissionPaidAt: new Date('2026-08-01T12:00:00Z'), commissionPayoutNote: 'Synthetic historical flag' } });
  const { page, errors } = await directorAdminPage(browser);
  await expect(page.locator('#metricUnpaidCommission')).toHaveText('Needs review');
  await page.locator('#commissionPayablesBody [data-payout-id]').click();
  await expect(page.locator('#paymentTitle')).toHaveText('Review historical payment');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.add('theme-dark'); document.documentElement.style.fontSize = '200%'; });
  expect(await page.locator('.payment-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator('#closePaymentBtn')).toBeEnabled();
  const readControlStyles = () => page.locator('#closePaymentBtn, #paymentAction, #savePaymentBtn').evaluateAll(elements => elements.map(element => {
    const luminance = color => { const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722; };
    const style = getComputedStyle(element), a = luminance(style.color), b = luminance(style.backgroundColor);
    return { id: element.id, color: style.color, background: style.backgroundColor, opacity: style.opacity, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  }));
  await expect.poll(async () => Math.min(...(await readControlStyles()).map(control => control.contrast))).toBeGreaterThanOrEqual(4.5);
  const controls = await readControlStyles();
  await require('node:fs/promises').writeFile(info.outputPath('payment-control-styles.json'), JSON.stringify(controls, null, 2));
  expect(Math.min(...controls.map(control => control.contrast))).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: info.outputPath('admin-payment-dark-large-mobile.png') });
  await page.locator('#paymentAction').selectOption('legacy_none');
  await expect(page.locator('#paymentAmountFields')).toBeHidden();
  await page.locator('#paymentNote').fill('Synthetic bank review found no previous payment.');
  const saved = await savePayment(page); expect(saved.status).toBe(200);
  expect(saved.body.record.commissionPayments).toMatchObject({ legacyState: 'reconciled', paidCents: 0, outstandingCents: 4400 });
  await expect(page.locator('#paymentBody')).toContainText('No historical payment confirmed');
  await page.keyboard.press('Escape'); await expect(page.locator('#paymentPanel')).toBeHidden();
  expect(errors).toEqual([]);
});


test('admin Finance renders the same outstanding commission and opens its exact audit', async ({ browser }, info) => {
  await seedOne(); const { page, errors } = await directorAdminPage(browser);
  await page.locator('#commissionPayablesBody [data-payout-id]').click(); await fillPayment(page); expect((await savePayment(page)).status).toBe(200);
  await page.locator('#closePaymentBtn').click();
  await page.goto(server.origin + '/admin-dashboard.html');
  await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => typeof window.loadOverviewActionBoard === 'function'); await page.evaluate(() => window.loadOverviewActionBoard());
  await page.locator('[data-section="finance"]').click(); await page.locator('[data-finance-view="reporting"]').click();
  await page.locator('[data-finance-kind="commissions"]').click();
  await expect(page.locator('#adminFinanceRecordList')).toContainText('USD 34.00 · Test');
  await expect(page.locator('#adminFinanceRecordList')).toContainText('Partly paid');
  await expect(page.locator('#adminFinanceRecordList thead')).toContainText('Director');
  await expect(page.locator('#adminFinanceRecordList tbody tr td').nth(2)).toHaveText('director@commission.test');
  await expect(page.locator('#adminFinanceRecordList tbody tr td').nth(1)).not.toContainText('director@commission.test');
  const tableRegion = page.getByRole('region', { name: 'Financial records columns' });
  for (const [name, width, enlarged] of [['desktop', 1440, false], ['mobile-dark', 390, false], ['narrow-large', 320, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ dark, enlarged }) => { document.documentElement.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = enlarged ? '200%' : ''; }, { dark: width < 1440, enlarged });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(width < 1440 ? 'rgb(20, 42, 50)' : 'rgb(255, 255, 255)');
    if (width < 1440) await expect.poll(() => page.locator('#sidebarNav').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await tableRegion.scrollIntoViewIfNeeded();
    await expect.poll(() => tableRegion.evaluate(region => {
      const issues = [];
      for (const cell of region.querySelectorAll('td')) {
        const bounds = cell.getBoundingClientRect(), css = getComputedStyle(cell), walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          if (!text.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(text);
          for (const rect of range.getClientRects()) if (rect.left < bounds.left + parseFloat(css.paddingLeft) - 1 || rect.right > bounds.right - parseFloat(css.paddingRight) + 1) issues.push(text.textContent);
        }
      }
      if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Document overflow');
      return issues;
    })).toEqual([]);
    if (width < 1440) {
      await tableRegion.focus(); await expect(tableRegion).toBeFocused();
      expect(await tableRegion.evaluate(region => region.scrollWidth > region.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`admin-finance-commission-${name}.png`) });
    if (width < 1440) {
      await page.getByRole('link', { name: 'Review director commission' }).focus();
      await expect(page.getByRole('link', { name: 'Review director commission' })).toBeFocused();
      expect(await tableRegion.evaluate(region => region.scrollLeft)).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`admin-finance-commission-${name}-action.png`) });
      await tableRegion.evaluate(region => { region.scrollLeft = 0; });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.classList.remove('theme-dark'); document.body.classList.remove('theme-dark'); document.documentElement.style.fontSize = ''; });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#adminFinanceExport').click()]);
  const csvPath = info.outputPath('manual-finance.csv'); await download.saveAs(csvPath);
  expect(await require('node:fs/promises').readFile(csvPath, 'utf8')).toContain('"USD","3400"');
  await page.getByRole('link', { name: 'Review director commission' }).click();
  await expect(page.locator('#auditPanel')).toBeVisible();
  await expect(page.locator('#auditBody .payment-entries')).toContainText('Synthetic ACH reference');
  expect(errors).toEqual([]);
});

for (const paid of [false, true]) test(`full refund restores the director slot with ${paid ? 'retained paid history' : 'no previous payment'}`, async ({ browser }, info) => {
  const seeded = await seedOne(), directorView = await pageFor(browser, seeded.director), adminView = await directorAdminPage(browser), page = adminView.page;
  await expect(directorView.page.locator('#metricCompletedCap')).toHaveText('1/50');
  if (paid) {
    await page.locator('#commissionPayablesBody [data-payout-id]').click();
    await fillPayment(page, '44.00'); expect((await savePayment(page)).status).toBe(200);
    await expect(page.locator('#paymentTitle')).toHaveText('Payment history saved');
    await page.locator('#closePaymentBtn').click();
  }
  // Retained synthetic provider evidence only; this test sends no refund.
  const { funding, matter } = seeded.retained, Operation = require('../../../models/PaymentOperation');
  await Operation.create({ caseId: matter._id, operationKey: `refund:${matter._id}:slot`, kind: 'refund', fingerprint: String(matter._id), status: 'succeeded', amount: funding.amount, refundAmount: funding.amount, stripeRefundId: `re_slot_browser_${matter._id}`, stripePaymentIntentId: funding.stripePaymentIntentId, stripeChargeId: funding.stripeChargeId, currency: funding.currency, stripeMode: funding.stripeMode, refundStatus: 'succeeded', refundEvidenceStatus: 'verified', refundVerifiedAt: new Date(), refundCreatedAt: new Date() });
  await directorView.page.reload();
  await expect(directorView.page.locator('#metricCompletedCap')).toHaveText('0/50');
  await expect(directorView.page.locator('#recordsBody [data-label="Commission"]')).toHaveText('No commission');
  if (paid) {
    await expect(directorView.page.locator('[data-payment-history]')).toHaveText('Payment to verify');
    await directorView.page.locator('[data-payment-history]').click();
    await expect(directorView.page.locator('#directorPaymentBody .payment-entries')).toContainText('Sep 1, 2026');
    await expect(directorView.page.locator('#directorPaymentBody .payment-entries')).toContainText('44.00');
    await directorView.page.keyboard.press('Escape');
  }
  await page.locator('#refreshBtn').click();
  await expect(page.locator('#metricCommission')).toHaveText('No commission');
  // A refunded unpaid record correctly leaves Payables; its audit stays in All records.
  await page.locator('#recordsBody [data-audit-id]').click();
  await expect(page.locator('#auditBody [data-label="Fee evidence"]')).toHaveText('Fully refunded · slot restored');
  await expect(page.locator('#auditBody [data-label="Attorney fee"]')).toHaveText('USD 0.00 · Test');
  await expect(page.locator('#auditBody [data-label="Commission"]')).toHaveText('USD 0.00 · Test');
  if (paid) await expect(page.locator('#auditBody .payment-entries')).toContainText('Synthetic ACH reference');
  for (const [width, dark, enlarged] of [[1440, false, false], [390, true, false], [320, true, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ dark, enlarged }) => { document.documentElement.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = enlarged ? '200%' : ''; }, { dark, enlarged });
    expect(await page.locator('#auditPanel .audit-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.locator('#auditBody [data-label="Fee evidence"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`refunded-slot-${paid ? 'paid' : 'unpaid'}-${width}.png`) });
  }
  expect(directorView.errors).toEqual([]); expect(adminView.errors).toEqual([]);
  expect(server.evidence().external.mail).toEqual([]);
  expect(server.provider.calls).toEqual([]);
});
