const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');
const { ObjectId } = require('mongoose').mongo;
const { seed, seedChargebacks, database, ACTIVE, DONE } = require('./fixtures');
test.beforeEach(async ({ page }) => { await seed(); await page.emulateMedia({ reducedMotion: 'reduce' }); });
async function reports(page, fee = '$160.00') {
  await page.goto('/admin-dashboard.html');
  await page.locator('[data-section="finance"]').click();
  await page.locator('[data-finance-view="reporting"]').click();
  await expect(page.locator('[data-admin-finance-panel="reconcile"]')).toBeHidden();
  await expect(page.locator('#adminFinanceRecordStatus')).toContainText('matching records');
  const details = page.locator('#section-revenue > details');
  await details.locator('summary').click();
  await expect(page.locator('#revenueTotalValue')).toHaveText(fee);
}
test('one verified euro unit stays in euros across totals, charts, receipts and CSV', async ({ page }) => {
  await seed({ allEuro: true }); await reports(page, '€160.00');
  await expect(page.locator('#accountingHeldValue')).toHaveText('€400.00');
  await expect(page.locator('#fundsReleasedValue')).toHaveText('€328.00');
  await expect(page.locator('#pendingPayoutsValue')).toHaveText('€0.00');
  await expect(page.locator('#revMainChart')).toBeVisible();
  expect(await page.evaluate(() => Chart.getChart('revMainChart').options.scales.y.title.text)).toBe('EUR · Test records');
  await expect(page.locator('#receiptsBody')).toContainText('€328.00');
  await page.locator('[data-finance-kind="income"]').click();
  await expect(page.locator('#adminFinanceRecordList')).toContainText('€160.00');
  const pending = page.waitForEvent('download'); await page.locator('#adminFinanceExport').click();
  const download = await pending, csv = await fs.readFile(await download.path(), 'utf8');
  expect(csv).toContain('"EUR","16000","16000"');
});
test('actual retained admin totals, record sources and receipt recipients agree', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await reports(page);
  await expect(page.locator('#fundsReleasedValue')).toHaveText('$328.00');
  await expect(page.locator('#adminFinancialReportStatus')).toHaveText('Test records — no money moved.');
  await expect(page.locator('#payoutsRecordedValue')).toHaveCount(0);
  await expect(page.locator('#receiptsBody')).toContainText('Bailey Lane');
  await expect(page.locator('#receiptsBody')).toContainText('$328.00');
  await page.locator('[data-finance-kind="income"]').click();
  await expect(page.locator('#adminFinanceRecordList')).toContainText('$160.00');
  expect(errors).toEqual([]);
});
test('a reviewed export downloads complete CSV bytes with explicit units and evidence basis', async ({ page }) => {
  await reports(page);
  await page.locator('[data-finance-kind="income"]').click();
  await expect(page.locator('#adminFinanceRecordList')).toContainText('$160.00');
  const pending = page.waitForEvent('download'); await page.locator('#adminFinanceExport').click();
  const download = await pending, csv = await fs.readFile(await download.path(), 'utf8');
  expect(csv).toContain('"retained_platform_fee"'); expect(csv).toContain('"USD","16000","16000"'); expect(csv.trim().split('\n')).toHaveLength(2);
  await expect(page.locator('#adminFinanceRecordStatus')).toHaveText('Download requested. Check your browser’s downloads.');
});
test('a changed source prevents an export and offers a fresh record read', async ({ page }) => {
  await reports(page); const downloads = []; page.on('download', value => downloads.push(value));
  await database(db => db.collection('paymentoperations').updateOne({ caseId: new ObjectId(ACTIVE), kind: 'funding' }, { $set: { grossAmount: 48801 } }));
  await page.locator('#adminFinanceExport').click();
  await expect(page.locator('#adminFinanceRecordStatus')).toContainText('Refresh'); expect(downloads).toEqual([]);
  await page.locator('#adminFinanceApply').click();
  await expect(page.locator('#adminFinanceRecordList')).toContainText('Needs review');
});
test('unavailable analytics clear earlier amounts without displaying a fabricated zero', async ({ page }) => {
  await reports(page);
  await page.route('**/api/admin/analytics?**', route => route.fulfill({ status: 503, json: { error: 'Synthetic reporting unavailable.' } }));
  await page.evaluate(() => window.refreshAdminFinancialReports());
  await expect(page.locator('#revenueTotalValue')).toHaveText('—');
  await expect(page.locator('#adminFinancialReportStatus')).toHaveText('Synthetic reporting unavailable.');
  await expect(page.locator('#ledgerBody')).not.toContainText('$328.00');
  await page.unroute('**/api/admin/analytics?**'); await page.evaluate(() => window.refreshAdminFinancialReports());
  await expect(page.locator('#revenueTotalValue')).toHaveText('$160.00');
});
test('separate currency and provider groups do not become one total or chart', async ({ page }, testInfo) => {
  await seed({ mixed: true });
  await page.goto('/admin-dashboard.html'); await page.locator('[data-section="finance"]').click(); await page.locator('[data-finance-view="reporting"]').click();
  await page.locator('#section-revenue > details > summary').click();
  await expect(page.locator('#adminFinancialGroups')).toContainText('EUR · Live records');
  await expect(page.locator('#adminFinancialGroups')).toContainText('USD · Test records');
  await expect(page.locator('#adminFinancialGroups')).toContainText('€328.00');
  await expect(page.locator('#adminFinancialSummary')).toBeHidden();
  await expect(page.locator('#escrowReportChart')).toBeHidden();
  await page.locator('#adminFinancialGroups').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mixed-units.png') });
});
test('empty financial records and unavailable records have distinct states', async ({ page }, testInfo) => {
  await seed({ empty: true });
  await page.goto('/admin-dashboard.html'); await page.locator('[data-section="finance"]').click(); await page.locator('[data-finance-view="reporting"]').click();
  await expect(page.locator('#adminFinanceRecordStatus')).toHaveText('No records match these filters.');
  await expect(page.locator('#adminFinanceRecordList')).toBeEmpty(); await expect(page.locator('#adminFinanceRecordPager')).toBeHidden();
  await page.locator('#adminFinanceRecords').screenshot({ path: testInfo.outputPath('empty-records.png') });
  await page.route('**/api/admin/workspace/finance/records?**', route => route.fulfill({ status: 503, json: { error: 'Synthetic records unavailable.' } }));
  await page.locator('#adminFinanceApply').click();
  await expect(page.locator('#adminFinanceRecordStatus')).toHaveText('Synthetic records unavailable.');
  await expect(page.locator('#adminFinanceExport')).toBeDisabled();
  await expect(page.locator('#adminFinanceRecordList')).not.toContainText('No records match');
  await expect(page.locator('#adminFinanceRecordPager')).toBeHidden(); await expect(page.locator('#adminFinanceRecordPager span')).toBeEmpty();
  await page.locator('#adminFinanceRecords').screenshot({ path: testInfo.outputPath('unavailable-records.png') });
});
test('Matter financial context agrees with the same retained payout and currency', async ({ page }) => {
  await reports(page);
  await page.evaluate(id => window.openAdminMatter(id), DONE);
  await page.locator('[data-matter-tab="financials"]').click();
  const panel = page.locator('[data-matter-panel="financials"]');
  await expect(panel).toContainText('Settled'); await expect(panel).toContainText('$328.00'); await expect(panel).toContainText('Bailey Lane');
  await expect(panel).not.toContainText('Release recorded:');
});
test('account changes discard a delayed private response and disable export', async ({ page }) => {
  await reports(page); let release, started;
  const began = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  await page.route('**/api/admin/workspace/finance/records?**', async route => { const response = await route.fetch(); started(); await wait; await route.fulfill({ response }); });
  await page.locator('#adminFinanceApply').click(); await began;
  await page.route('**/api/auth/me', route => route.fulfill({ status: 200, json: { user: { id: '650000000000000000009999', role: 'admin', status: 'approved' } } }));
  release(); await expect(page.locator('#adminFinanceExport')).toBeDisabled();
  await expect(page.locator('#adminFinanceRecordList')).not.toContainText('Discovery response support');
  await expect(page.locator('#revenueTotalValue')).toHaveText('—');
});
test('a revoked account clears all visible report amounts even when identity responds successfully', async ({ page }) => {
  await reports(page);
  await page.route('**/api/auth/me', async route => { const response = await route.fetch(), body = await response.json(); body.user.status = 'denied'; await route.fulfill({ response, json: body }); });
  await page.locator('#receiptRefreshBtn').click();
  await expect(page.locator('#revenueTotalValue')).toHaveText('—');
  await expect(page.locator('#adminFinanceRecordList')).not.toContainText('Discovery response support');
  await expect(page.locator('#adminFinanceExport')).toBeDisabled();
  await expect(page.locator('#receiptsBody')).not.toContainText('$328.00');
});
test('global payment-reference search uses the current financial owner and clears revoked results', async ({ page }) => {
  await reports(page); await page.locator('#adminSearchOpen').click();
  await page.locator('#adminGlobalSearch').fill(`pi_browser_${ACTIVE}`);
  await expect(page.locator('#adminGlobalResults')).toContainText('Discovery response support');
  await page.route('**/api/auth/me', async route => { const response = await route.fetch(), body = await response.json(); body.user.status = 'denied'; await route.fulfill({ response, json: body }); });
  await page.locator('#adminGlobalSearch').fill(`pi_browser_${DONE}`);
  await expect(page.locator('#revenueTotalValue')).toHaveText('—');
  await expect(page.locator('#adminGlobalResults')).not.toContainText('Discovery response support');
});
test('leaving Finance discards a delayed export instead of downloading stale context', async ({ page }) => {
  await reports(page); let release, started;
  const began = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  await page.route('**/api/admin/workspace/finance/export?**', async route => { const response = await route.fetch(); started(); await wait; await route.fulfill({ response }); });
  await page.locator('#adminFinanceExport').click(); await began;
  await page.locator('[data-finance-view="exceptions"]').click();
  release();
  expect(await page.waitForEvent('download', { timeout: 1500 }).catch(() => null)).toBeNull();
});
test('a source-change notice prevents delayed analytics from restoring cleared amounts', async ({ page }) => {
  await reports(page); let release, started;
  const began = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  await page.route('**/api/admin/analytics?**', async route => { const response = await route.fetch(); started(); await wait; await route.fulfill({ response }); });
  await page.evaluate(() => { window.adminFinancialTestRead = window.refreshAdminFinancialReports(); }); await began;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('admin:financial-source-changed')));
  release(); await page.evaluate(() => window.adminFinancialTestRead);
  await expect(page.locator('#revenueTotalValue')).toHaveText('—');
  await expect(page.locator('#adminFinancialReportStatus')).toHaveText('Financial records changed. Refresh before continuing.');
});
async function chargebacks(page) {
  await page.goto('/admin-dashboard.html'); await page.locator('[data-section="finance"]').click();
  await page.locator('[data-finance-view="exceptions"]').click();
  await page.locator('[data-exception-source="chargebacks"]').click();
  await page.locator('#refreshChargebacks').click();
  await expect(page.locator('#chargebacksBody')).toContainText('$502.00');
}
test('chargeback paging retains the reviewed revision and rejects changed evidence', async ({ page }) => {
  await seedChargebacks(26); await chargebacks(page);
  await expect(page.locator('#chargebacksBody tr')).toHaveCount(25);
  await expect(page.locator('#chargebacksBody tr').first()).toContainText('$14.00');
  await database(db => db.collection('financialadjustments').updateOne({ caseId: new ObjectId(ACTIVE), adjustmentType: 'processor_dispute_fee' }, { $set: { amount: 1500 } }));
  await page.locator('#adminChargebackPager [data-next]').click();
  await expect(page.locator('#chargebacksBody')).toContainText('Financial records changed');
  await expect(page.locator('#chargebacksBody')).not.toContainText('$502.00');
  await expect(page.locator('#adminChargebackPager [data-next]')).toBeDisabled();
  await page.locator('#refreshChargebacks').click();
  await expect(page.locator('#adminChargebackPager')).toContainText('26 records · page 1 of 2');
  await page.locator('#adminChargebackPager [data-next]').click();
  await expect(page.locator('#chargebacksBody tr')).toHaveCount(1);
});
test('unavailable chargeback reads clear amounts and recover with a fresh read', async ({ page }, testInfo) => {
  await seedChargebacks(); await chargebacks(page);
  for (const [name, width, dark] of [['desktop', 1440, false], ['phone-dark', 320, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-dark', dark); }, dark);
    await page.locator('#chargebackPanel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`chargebacks-${name}.png`) });
    const checks = await new AxeBuilder({ page }).include('#chargebackPanel').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(checks.violations.map(v => ({ id: v.id, targets: v.nodes.map(node => node.target) }))).toEqual([]);
  }
  await page.route('**/api/admin/chargebacks?**', route => route.fulfill({ status: 503, json: { error: 'Synthetic chargebacks unavailable.' } }));
  await page.locator('#refreshChargebacks').click();
  await expect(page.locator('#chargebacksBody')).toHaveText('Synthetic chargebacks unavailable.');
  await page.unroute('**/api/admin/chargebacks?**'); await page.locator('#refreshChargebacks').click();
  await expect(page.locator('#chargebacksBody')).toContainText('$502.00');
});
test('the reconciliation activity chart retains the exact currency, flows and usable phone plot', async ({ page }, testInfo) => {
  await seed({ allEuro: true }); await reports(page, '€160.00');
  await page.locator('[data-finance-view="reconcile"]').click();
  await expect(page.locator('#escrowReportChart')).toBeVisible();
  expect(await page.evaluate(() => { const chart = Chart.getChart('escrowReportChart'); return { unit: chart.options.scales.y.title.text, values: chart.data.datasets.map(series => series.data) }; })).toEqual({ unit: 'EUR · Test records', values: [[976], [328]] });
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.locator('#escrowReportChart').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => { const area = Chart.getChart('escrowReportChart').chartArea; return area.bottom - area.top; })).toBeGreaterThan(140);
  await page.screenshot({ path: testInfo.outputPath('payment-activity-phone.png') });
});
test('financial reporting wraps long records in light, dark, narrow and enlarged-text layouts', async ({ page }, testInfo) => {
  await seed({ long: true }); await reports(page);
  for (const [name, width, dark, large] of [['light-desktop', 1440, false, false], ['dark-desktop', 1440, true, false], ['light-phone', 320, false, false], ['dark-phone', 320, true, false], ['large-phone', 390, false, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ dark, large }) => { document.documentElement.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = large ? '24px' : ''; }, { dark, large });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const layout = await page.locator('.main').evaluate(main => ({ width: main.clientWidth, scrollWidth: main.scrollWidth, outside: [...main.querySelectorAll('*')].filter(node => node.getClientRects().length && node.getBoundingClientRect().right > main.getBoundingClientRect().right + 1).slice(0, 30).map(node => ({ tag: node.tagName, id: node.id, className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth, right: node.getBoundingClientRect().right })) }));
    await testInfo.attach(`layout-${name}`, { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
    await expect.poll(() => page.locator('.main').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect.poll(() => page.locator('#section-revenue .panel').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await expect.poll(() => page.locator('#adminFinanceSearch').evaluate(node => node.clientWidth)).toBeGreaterThan(180);
    expect(await page.locator('#adminFinanceRecordList tbody tr td:nth-child(3)').evaluateAll(nodes => nodes.every(node => { const range = document.createRange(); range.selectNodeContents(node.firstChild); return range.getClientRects().length === 1; }))).toBe(true);
    expect(await page.locator('#adminFinanceRecordList tbody tr').evaluateAll(rows => Math.max(...rows.map(row => row.getBoundingClientRect().height)))).toBeLessThan(400);
    await expect.poll(() => page.evaluate(() => { const area = Chart.getChart('revMainChart').chartArea; return area.bottom - area.top; })).toBeGreaterThan(140);
    for (const [area, selector] of [['records', '#adminFinanceRecords'], ['totals', '#adminFinancialSummary'], ['activity', '#ledgerBody'], ['receipts', '#receiptsBody']]) {
      await page.locator(selector).evaluate(node => (node.closest('.panel') || node).scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: testInfo.outputPath(`admin-financial-${name}-${area}.png`) });
    }
    if (width <= 390) {
      const scroll = page.getByRole('region', { name: 'Financial records columns', exact: true });
      await page.locator('#adminFinanceExport').focus();
      await page.keyboard.press(testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(scroll).toBeFocused(); await expect(scroll).toBeInViewport();
      // WebKit can discard an instantaneous native scroll key before a frame.
      await page.keyboard.press('ArrowRight', { delay: 60 });
      await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
      await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await page.screenshot({ path: testInfo.outputPath(`admin-financial-${name}-record-amounts.png`) });
      await scroll.evaluate(node => { node.scrollLeft = 0; });
    }
    const checks = await new AxeBuilder({ page }).include('#section-revenue').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(checks.violations.map(v => ({ id: v.id, nodes: v.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }))).toEqual([]);
  }
});

test('record pagination clears stale controls and preserves its revision and recovery focus', async ({ page }, testInfo) => {
  await seedChargebacks(26);
  await page.goto('/admin-dashboard.html'); await page.locator('[data-section="finance"]').click(); await page.locator('[data-finance-view="reporting"]').click();
  const panel = page.locator('#adminFinanceRecords'), pager = page.locator('#adminFinanceRecordPager'), status = page.locator('#adminFinanceRecordStatus');
  await expect(status).toHaveText('29 matching records'); await expect(pager.locator('span')).toHaveText('Page 1 of 2');
  const first = await (await page.request.get('/api/admin/workspace/finance/records?kind=operations&page=1&status=all')).json();
  let release, arrived, blocked = true, failNext = false;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), queries = [];
  await page.route('**/api/admin/workspace/finance/records?**', async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams); queries.push(query);
    if (query.page === '2' && failNext) return route.fulfill({ status: 503, json: { error: 'Synthetic page unavailable.' } });
    if (query.page === '2' && blocked) { arrived(); await gate; }
    await route.continue();
  });
  try {
    await pager.locator('[data-next]').focus(); await pager.locator('[data-next]').press('Enter'); await waiting;
    await expect(pager).toBeHidden(); await expect(pager.locator('[data-next]')).toBeDisabled(); await expect(pager.locator('[data-prev]')).toBeDisabled();
    await expect(status).toHaveText('Loading financial records…'); await expect(page.locator('#adminFinanceRecordList')).toBeEmpty(); await expect(page.locator('#adminFinanceExport')).toBeDisabled();
    blocked = false; release();
    await expect(pager.locator('span')).toHaveText('Page 2 of 2'); await expect(pager.locator('[data-prev]')).toBeFocused();
    await expect(page.locator('#adminFinanceRecordList tbody tr')).toHaveCount(4);
    expect(queries.filter(value => value.page === '2')).toHaveLength(1); expect(queries.find(value => value.page === '2').revision).toBe(first.revision);
    for (const [name, width, dark, font] of [['desktop', 1440, false, ''], ['phone-dark', 320, true, '20px']]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(({ dark, font }) => { for (const el of [document.documentElement, document.body]) el.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = font; }, { dark, font });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('#adminFinanceRecords').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await pager.screenshot({ path: testInfo.outputPath(`record-pager-${name}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => { for (const el of [document.documentElement, document.body]) el.classList.remove('theme-dark'); document.documentElement.style.fontSize = ''; });
    await page.locator('#adminFinanceFrom').fill('2020-01-01');
    await expect(pager).toBeHidden(); await expect(status).toHaveText('Apply filters to update records.'); await expect(page.locator('#adminFinanceRecordList')).toBeEmpty(); await expect(page.locator('#adminFinanceExport')).toBeDisabled();
    await page.locator('#adminFinanceApply').click(); await expect(pager.locator('span')).toHaveText('Page 1 of 2');
    expect(queries.at(-1).page).toBe('1'); expect(queries.at(-1).revision).toBeUndefined();
    failNext = true; await pager.locator('[data-next]').focus(); await pager.locator('[data-next]').press('Enter');
    await expect(status).toHaveText('Synthetic page unavailable.'); await expect(pager).toBeHidden(); await expect(page.locator('#adminFinanceApply')).toHaveText('Try again'); await expect(page.locator('#adminFinanceApply')).toBeFocused();
    await expect(page.locator('#adminFinanceRecordList')).toBeEmpty(); await expect(page.locator('#adminFinanceExport')).toBeDisabled();
    failNext = false; await page.locator('#adminFinanceApply').click(); await expect(pager.locator('span')).toHaveText('Page 1 of 2');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('admin:financial-source-changed')));
    await expect(pager).toBeHidden(); await expect(status).toHaveText('Financial records changed. Refresh before continuing.'); await expect(page.locator('#adminFinanceRecordList')).toBeEmpty();
    await page.locator('#adminFinanceApply').click(); await expect(status).toHaveText('29 matching records'); await expect(pager.locator('span')).toHaveText('Page 1 of 2');
    await panel.screenshot({ path: testInfo.outputPath('records-recovered.png') });
    let releaseOld, arrivedOld;
    const oldGate = new Promise(resolve => { releaseOld = resolve; }), oldWaiting = new Promise(resolve => { arrivedOld = resolve; });
    await page.route('**/api/admin/workspace/finance/records?**', async route => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('kind') === 'operations' && query.get('page') === '2') { arrivedOld(); await oldGate; await route.continue(); }
      else await route.fallback();
    });
    try {
      await pager.locator('[data-next]').click(); await oldWaiting;
      await page.locator('[data-finance-kind="payouts"]').click();
      await expect(status).toHaveText('1 matching record'); await expect(pager).toBeHidden(); await expect(page.locator('#adminFinanceApply')).not.toBeFocused();
      const oldResponse = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname.endsWith('/finance/records') && url.searchParams.get('kind') === 'operations' && url.searchParams.get('page') === '2'; });
      releaseOld(); await oldResponse;
      await expect(status).toHaveText('1 matching record'); await expect(page.locator('[data-finance-kind="payouts"]')).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('#adminFinanceRecordList tbody tr')).toHaveCount(1);
      await panel.screenshot({ path: testInfo.outputPath('source-change-while-paging.png') });
    } finally { releaseOld(); }
  } finally { blocked = false; release(); }
});
