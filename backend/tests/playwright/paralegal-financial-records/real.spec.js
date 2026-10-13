const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/paralegalFinancialBrowserServer');
let server, record;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ context }, info) => { record = await server.seed({ samePayee: info.title.includes('Matter payments') }); await context.addCookies([record.para.cookie]); await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:5874' ? route.continue() : route.abort('blockedbyclient')); });
const home = surface => surface === 'v2' ? '/paralegal-v2.html#/home?view=history' : '/dashboard-paralegal.html#home';
const history = surface => surface === 'v2' ? '/paralegal-v2.html#/work?section=history' : '/dashboard-paralegal.html#cases';
const list = (page, surface) => page.locator(surface === 'v2' ? '#v2-work-history' : '#completedCasesContainer');
for (const surface of ['original', 'v2']) {
  test(`${surface}: actual retained earnings, remaining-budget estimate, history and PDF agree without financial writes`, async ({ page }, info) => {
    const pageErrors = [], assetFailures = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => { const url = new URL(response.url()); if (url.origin === 'http://127.0.0.1:5874' && url.pathname.startsWith('/assets/') && response.status() >= 400) assetFailures.push({ path: url.pathname, status: response.status() }); });
    const before = await server.inspect(record.historyId), activeBefore = await server.inspect(record.activeId);
    await page.goto(home(surface));
    const totals = page.locator('[data-payout-totals]'); await expect(totals).toHaveAttribute('data-state', 'ready');
    await expect(totals).toContainText('$81.00'); await expect(totals.locator('.pf-estimates')).toContainText('$246.00'); await expect(totals).not.toContainText('$328.00');
    await page.goto(history(surface)); const root = list(page, surface); await expect(root).toContainText('River Street retained assignment');
    await expect(root.getByText('No payout', { exact: true })).toHaveCount(1);
    await root.getByText('Earlier receipts (1)', { exact: true }).focus(); await page.keyboard.press('Enter'); await expect(root.getByText('$81.00', { exact: true })).toHaveCount(1);
    await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(root.getByRole('button', { name: /^Download earlier receipt/ })).toBeFocused();
    const downloaded = page.waitForEvent('download'); await page.keyboard.press('Enter');
    const download = await downloaded, filename = info.outputPath('actual-retained-payout.pdf'); await download.saveAs(filename);
    const bytes = await fs.readFile(filename); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.length).toBeGreaterThan(1000);
    await expect(root).toContainText('Check your downloads for the receipt.');
    const evidence = server.evidence(); expect(evidence.provider).toEqual([]); expect(evidence.mail).toEqual([]); expect(evidence.financialRequests.every(item => item.method === 'GET')).toBe(true);
    expect(await server.inspect(record.historyId)).toEqual(before); expect(await server.inspect(record.activeId)).toEqual(activeBefore);
    for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      await root.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (surface === 'original') {
        const colors = await root.evaluate(element => ({ page: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(element.querySelector('[data-payout-details]')).color, row: getComputedStyle(element.querySelector('.file-card')).backgroundColor }));
        expect(colors.page).toBe(theme === 'dark' ? 'rgb(17, 27, 42)' : 'rgb(255, 255, 255)');
        expect(colors.text).toBe(theme === 'dark' ? 'rgb(242, 245, 249)' : 'rgb(23, 35, 59)');
        if (theme === 'dark') expect(colors.row).toBe('rgba(0, 0, 0, 0)');
      }
      if (surface === 'v2' && width === 1366) expect(await root.locator('.v2-work-history-row').first().evaluate(row => {
        const main = row.querySelector('.v2-work-row-main').getBoundingClientRect(), actions = row.querySelector('.v2-work-history-actions').getBoundingClientRect();
        return actions.top >= main.bottom && actions.top - main.bottom <= 24;
      })).toBe(true);
      for (const action of await root.locator('[data-payout-receipt]').all()) { await action.focus(); await expect(action).toBeFocused(); await expect(action).toBeInViewport(); }
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await root.screenshot({ path: info.outputPath(`${surface}-actual-history-${theme}-${width}.png`) });
      await page.screenshot({ path: info.outputPath(`${surface}-actual-context-${theme}-${width}.png`) });
      await root.locator('.pf-note').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`${surface}-actual-end-${theme}-${width}.png`) });
    }
    if (surface === 'v2') {
      await expect(page.getByRole('button', { name: 'Open LPC Assistant', exact: true })).toBeVisible();
      await require('./history-layout')(page, info);
    }
    await fs.writeFile(info.outputPath('history-screen-evidence.json'), JSON.stringify({ surface, pageErrors, assetFailures, financialRequests: server.evidence().financialRequests, providerCalls: server.evidence().provider, mailCalls: server.evidence().mail, financialRecordsUnchanged: JSON.stringify(await server.inspect(record.historyId)) === JSON.stringify(before) && JSON.stringify(await server.inspect(record.activeId)) === JSON.stringify(activeBefore) }, null, 2));
    expect(pageErrors).toEqual([]); expect(assetFailures).toEqual([]);
  });
  test(`${surface}: actual reversal rejects the displayed old receipt and fresh history exposes review`, async ({ page }) => {
    await page.goto(history(surface)); const root = list(page, surface); await expect(root).toContainText('River Street retained assignment'); await root.getByText('Earlier receipts (1)', { exact: true }).click();
    const downloads = []; page.on('download', event => downloads.push(event.suggestedFilename()));
    // Reverse at the request boundary, after the old receipt was activated.
    // A routine History refresh must not remove the target before the click.
    let receiptStatus = null;
    await page.route('**/api/payments/receipt/paralegal/**', async route => {
      await server.reverse(record.historyId);
      const response = await route.fetch();
      receiptStatus = response.status();
      await route.fulfill({ response });
    });
    let refreshed = false;
    page.on('response', async response => {
      if (new URL(response.url()).pathname !== '/api/cases/my-completed' || response.status() !== 200) return;
      try { const value = await response.json(); refreshed ||= value.items?.some(item => item.caseId === record.historyId && item.receipts.some(receipt => receipt.payoutState === 'reversed' && receipt.paymentAmount === null && receipt.receiptAvailable === false)) === true; } catch { /* A navigation may dispose an unrelated response body. */ }
    });
    await root.getByRole('button', { name: /^Download earlier receipt/ }).click();
    await expect.poll(() => receiptStatus).toBe(409); expect(downloads).toEqual([]);
    const refresh = root.getByRole('button', { name: 'Refresh history' });
    await expect.poll(async () => refreshed || await refresh.isVisible()).toBe(true);
    if (!refreshed) {
      try { await refresh.click({ timeout: 3000 }); }
      catch (error) { if (!refreshed) throw error; }
    }
    await expect.poll(() => refreshed).toBe(true);
    await expect(root).toContainText('River Street retained assignment');
    const earlier = root.getByText('Earlier receipts (1)', { exact: true });
    if (!await earlier.evaluate(element => element.closest('details').open)) await earlier.click();
    await expect(root).toContainText('Payout reversed'); await expect(root.getByRole('button', { name: /^Download earlier receipt/ })).toHaveCount(0); await expect(root).not.toContainText('$81.00');
    expect(downloads).toEqual([]);
    expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
  });
  test(`${surface}: a managed session revoked after display cannot download the old payout`, async ({ page }) => {
    await page.goto(history(surface)); const root = list(page, surface); await expect(root).toContainText('River Street retained assignment'); await root.getByText('Earlier receipts (1)', { exact: true }).click();
    await server.revoke(record.para.cookie); const downloads = []; page.on('download', event => downloads.push(event.suggestedFilename()));
    // Session verification can remove the receipt before its activation. The
    // missing control is acceptable only after the protected sign-in redirect.
    try { await root.getByRole('button', { name: /^Download earlier receipt/ }).click({ timeout: 3000 }); }
    catch (error) { if (new URL(page.url()).pathname !== '/login.html') throw error; }
    await expect.poll(async () => /login\.html/.test(page.url()) || await root.getByRole('button', { name: 'Refresh history' }).isVisible()).toBe(true);
    expect(downloads).toEqual([]); expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
  });
}

const matterPage = surface => surface === 'v2' ? `/paralegal-v2.html#/matter/${record.activeId}?tab=financials` : `/case-detail.html?caseId=${record.activeId}&tab=financials`;
for (const surface of ['original', 'v2']) {
  test(`${surface}: Matter payments agree with the actual remaining estimate and earlier PDF`, async ({ page }, info) => {
    const before = await server.inspect(record.activeId), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(matterPage(surface)); const root = page.locator('[data-matter-payments]');
    await expect(root).toHaveAttribute('data-state', 'estimate');
    await expect(root.locator('[data-amount-code="net"]')).toContainText('$246.00');
    await expect(root).toContainText('Earlier payouts'); await expect(root.getByText('$81.00', { exact: true })).toHaveCount(1);
    await expect(root).not.toContainText('$328.00');
    const downloadEvent = page.waitForEvent('download'); await root.getByRole('button', { name: 'Download receipt', exact: true }).click();
    const downloaded = await downloadEvent, file = info.outputPath('matter-earlier-payout.pdf'); await downloaded.saveAs(file);
    const bytes = await fs.readFile(file); expect(bytes.subarray(0,5).toString()).toBe('%PDF-'); expect(bytes.length).toBeGreaterThan(1000);
    for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      await root.scrollIntoViewIfNeeded();
      if (surface === 'v2') await expect(page.locator('.v2-matter-tabs [aria-current="page"]')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await root.getByRole('button', { name: 'Download receipt', exact: true }).focus(); await expect(root.getByRole('button', { name: 'Download receipt', exact: true })).toBeInViewport();
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await root.screenshot({ path: info.outputPath(`${surface}-matter-payments-${theme}-${width}.png`) });
      await page.screenshot({ path: info.outputPath(`${surface}-matter-context-${theme}-${width}.png`) });
    }
    expect(errors).toEqual([]); expect(await server.inspect(record.activeId)).toEqual(before); expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
  });
  test(`${surface}: Matter payments clear old amounts after the earlier payout reverses`, async ({ page }) => {
    await page.goto(matterPage(surface)); const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'estimate');
    await server.reverse(record.activeId); const downloads = []; page.on('download', event => downloads.push(event.suggestedFilename()));
    await root.getByRole('button', { name: 'Download receipt', exact: true }).click();
    await expect(root).not.toContainText('$246.00'); await expect(root).not.toContainText('$81.00');
    expect(downloads).toEqual([]);
    // The live Matter stream can complete the same refresh before the recovery
    // button can be clicked. A detached button is acceptable only after the
    // authoritative replacement has reached the expected review state.
    if (await root.getAttribute('data-state') !== 'needs_review') {
      try { await root.getByRole('button', { name: 'Refresh payments', exact: true }).click({ timeout: 3000 }); }
      catch (error) { if (await root.getAttribute('data-state') !== 'needs_review') throw error; }
    }
    await expect(page.locator('[data-matter-payments]')).toHaveAttribute('data-state', 'needs_review');
    await expect(page.locator('[data-matter-payments]')).toContainText('Payout reversed');
  });
  test(`${surface}: Matter payments cannot download after managed-session revocation`, async ({ page }) => {
    await page.goto(matterPage(surface)); const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'estimate');
    await server.revoke(record.para.cookie); const downloads = []; page.on('download', event => downloads.push(event.suggestedFilename()));
    try { await root.getByRole('button', { name: 'Download receipt', exact: true }).click({ timeout: 3000 }); }
    catch (error) { if (!/login\.html/.test(page.url()) && await page.getByText('$246.00', { exact: true }).isVisible()) throw error; }
    await expect.poll(async () => /login\.html/.test(page.url()) || !(await page.getByText('$246.00', { exact: true }).isVisible())).toBe(true);
    expect(downloads).toEqual([]); expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
  });
}

for (const surface of ['original', 'v2']) {
  test(`${surface}: Matter payments preserve a pending receipt through routine refresh`, async ({ page }, info) => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/payments/receipt/paralegal/**', async route => { await gate; await route.continue().catch(() => {}); });
    try {
      await page.goto(matterPage(surface)); const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'estimate');
      await root.getByRole('button', { name: 'Download receipt', exact: true }).click(); await expect(root.getByRole('button', { name: 'Cancel download', exact: true })).toBeVisible();
      await server.updateWork(record.activeId);
      await page.evaluate(surface => surface === 'v2' ? window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { reason: 'matter_refresh', sourceId: 'synthetic-matter-test', accessMayChange: false } })) : document.dispatchEvent(new Event('visibilitychange')), surface);
      await page.waitForTimeout(900);
      await expect(root.getByRole('button', { name: 'Cancel download', exact: true })).toBeVisible(); await expect(root).toContainText('$246.00');
      const downloaded = page.waitForEvent('download'); release();
      const download = await downloaded, file = info.outputPath('matter-refresh-payout.pdf');
      await download.saveAs(file); expect(await download.failure()).toBeNull();
      const bytes = await fs.readFile(file); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.length).toBeGreaterThan(1000);
      // A deferred route refresh may replace the temporary success message after
      // the download finishes. Verify the actual file and retained amounts.
      await expect(root).toContainText('$246.00'); await expect(root).toContainText('$81.00');
      await expect(root.getByRole('button', { name: 'Download receipt', exact: true })).toBeEnabled();
      await expect(root.getByRole('button', { name: 'Cancel download', exact: true })).toBeHidden();
      expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
    } finally { release(); }
  });
  test(`${surface}: Matter payments cancel a pending receipt on explicit cancellation`, async ({ page }) => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const downloads = []; page.on('download', event => downloads.push(event.suggestedFilename()));
    await page.route('**/api/payments/receipt/paralegal/**', async route => { await gate; await route.continue().catch(() => {}); });
    try {
      await page.goto(matterPage(surface)); const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'estimate');
      await root.getByRole('button', { name: 'Download receipt', exact: true }).click(); await root.getByRole('button', { name: 'Cancel download', exact: true }).click();
      await expect(root).toContainText('Download canceled.'); release(); expect(downloads).toEqual([]);
    } finally { release(); }
  });
}

for (const surface of ['original', 'v2']) test(`${surface}: Matter payments cancel pending downloads on account loss without claiming completion`, async ({ page }) => {
  let release; const gate = new Promise(resolve => { release = resolve; }), downloads = [], notices = [];
  page.on('download', event => downloads.push(event.suggestedFilename()));
  page.on('console', message => { if (message.text() === 'LPC_TEST_COMPLETION_NOTICE') notices.push(true); });
  await page.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'lpc-case-completed-toast') console.log('LPC_TEST_COMPLETION_NOTICE'); return original.call(this, key, value); }; });
  await page.route('**/api/payments/receipt/paralegal/**', async route => { await gate; await route.continue().catch(() => {}); });
  try {
    await page.goto(matterPage(surface)); const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'estimate');
    await root.getByRole('button', { name: 'Download receipt', exact: true }).click(); await expect(root.getByRole('button', { name: 'Cancel download', exact: true })).toBeVisible();
    await server.revoke(record.para.cookie);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { reason: 'account_participation_refresh', sourceId: 'synthetic-matter-access', accessMayChange: true } }))).catch(async error => { if (!/Execution context was destroyed/.test(error.message)) throw error; await page.waitForURL('**/login.html**'); });
    await expect.poll(async () => /login\.html/.test(page.url()) || !(await page.getByText('$246.00', { exact: true }).isVisible())).toBe(true);
    release(); expect(downloads).toEqual([]); expect(notices).toEqual([]);
  } finally { release(); }
});

test('original attorney: Matter payments open actual retained receipt choices without a new tab', async ({ page, context }, info) => {
  await context.clearCookies(); await context.addCookies([record.attorney.cookie]);
  const before = await server.inspect(record.historyId), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/case-detail.html?caseId=${record.historyId}&tab=financials`);
  const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'needs_review');
  await root.getByRole('button', { name: 'View receipts', exact: true }).click();
  const receipt = page.locator('[data-matter-receipt]'); await expect(receipt).toBeFocused(); await expect(root.getByRole('button', { name: 'View receipts', exact: true })).toBeHidden(); await expect(receipt).toContainText('No payout');
  await receipt.getByRole('button', { name: 'Choose another receipt', exact: true }).click();
  await expect(receipt.getByText('Decision amounts do not confirm payouts.', { exact: true })).toHaveCount(1);
  const earlier = receipt.locator('[data-receipt-choice]').filter({ hasText: '$100.00' }); await expect(earlier).toHaveCount(1);
  await earlier.getByRole('button', { name: 'Review this receipt', exact: true }).click();
  await expect(receipt).toContainText('$81.00'); await expect(receipt).toContainText('$19.00');
  const downloaded = page.waitForEvent('download'); await receipt.getByRole('button', { name: 'Download receipt', exact: true }).click();
  const file = info.outputPath('attorney-matter-withdrawal.pdf'); await (await downloaded).saveAs(file); expect((await fs.readFile(file)).length).toBeGreaterThan(1000);
  for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
    await receipt.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await receipt.locator('h3').first().evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: info.outputPath(`attorney-matter-context-${theme}-${width}.png`) });
    await receipt.getByRole('button', { name: 'Download receipt', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`attorney-matter-actions-${theme}-${width}.png`) });
    await receipt.locator('[data-receipt-choice]').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`attorney-matter-history-${theme}-${width}.png`) });
  }
  expect(errors).toEqual([]); expect(await server.inspect(record.historyId)).toEqual(before); expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
});

test('original: completion notice uses one outcome and optional Matter name with keyboard dismissal', async ({ page }, info) => {
  await page.goto(home('original'));
  for (const caseTitle of ['River Street retained assignment', '']) {
    await page.evaluate(caseTitle => sessionStorage.setItem('lpc-case-completed-toast', JSON.stringify({ caseTitle, message: 'The work is completed.' })), caseTitle);
    await page.reload();
    const dialog = page.getByRole('dialog', { name: 'Matter complete', exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByText('Matter complete', { exact: true })).toHaveCount(1);
    await expect(dialog).not.toContainText('The work is completed.');
    if (caseTitle) await expect(dialog.locator('#caseCompletedText')).toHaveText(caseTitle);
    else { await expect(dialog.locator('#caseCompletedText')).toBeHidden(); await expect(dialog).not.toHaveAttribute('aria-describedby'); }
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    if (caseTitle) for (const theme of ['light', 'dark']) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${theme}`); } document.documentElement.style.fontSize = '20px'; }, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const colors = await dialog.evaluate(element => ({ surface: getComputedStyle(element).backgroundColor, title: getComputedStyle(element.querySelector('.tour-title')).color }));
      expect(colors.surface).toBe(theme === 'dark' ? 'rgb(25, 37, 56)' : 'rgb(255, 255, 255)');
      expect(colors.title).toBe(theme === 'dark' ? 'rgb(242, 245, 249)' : 'rgb(23, 35, 59)');
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`completion-notice-${theme}-${width}.png`) });
    }
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('lpc-case-completed-toast'))).toBeNull();
  }
  expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
});

test('v2: Matter payments drop a queued routine-refresh delay when workspace access changes', async ({ page }) => {
  let release; const gate = new Promise(resolve => { release = resolve; }), downloads = [];
  page.on('download', event => downloads.push(event.suggestedFilename()));
  // Require the account-change path to enforce access while the Matter stream
  // is unavailable; the periodic 15-second fallback cannot satisfy this check.
  await page.route(url => /^\/api\/cases\/[a-f0-9]{24}\/stream$/.test(url.pathname), route => route.abort());
  await page.route('**/api/payments/receipt/paralegal/**', async route => { await gate; await route.continue().catch(() => {}); });
  try {
    await page.goto(matterPage('v2')); const root = page.locator('[data-matter-payments]'); await expect(root).toHaveAttribute('data-state', 'estimate');
    await root.getByRole('button', { name: 'Download receipt', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { reason: 'matter_refresh', sourceId: 'synthetic-queued-refresh', accessMayChange: false } })));
    await page.waitForTimeout(700); await expect(root.getByRole('button', { name: 'Cancel download', exact: true })).toBeVisible();
    await server.restrictMatter(record.activeId);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { reason: 'account_participation_refresh', sourceId: 'synthetic-workspace-restriction', accessMayChange: true } })));
    await expect(page.getByText('$246.00', { exact: true })).toBeHidden({ timeout: 5000 });
    expect(page.url()).not.toContain('login.html'); expect(downloads).toEqual([]);
    release(); await expect(page.locator('[data-payout-receipt]:disabled')).toHaveCount(0);
  } finally { release(); }
});

for (const first of ['list', 'Matter']) test(`original attorney: Matter payments retain the selected Matter when ${first} loads first`, async ({ page, context }) => {
  await context.clearCookies(); await context.addCookies([record.attorney.cookie]);
  const detail = `/api/cases/${record.historyId}`, listPath = '/api/cases/workspace-choices';
  const delayed = first === 'list' ? detail : listPath, preceding = first === 'list' ? listPath : detail;
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === preceding && response.status() === 200);
  const choicesRead = page.waitForResponse(response => new URL(response.url()).pathname === listPath && response.status() === 200);
  await page.route(url => url.pathname === delayed, async route => { await ready; await route.continue(); });
  await page.goto(`/case-detail.html?caseId=${record.historyId}&tab=financials`, { waitUntil: 'domcontentloaded' });
  const switcher = page.getByRole('button', { name: 'Switch Matter', exact: true });
  await switcher.click();
  const dialog = page.getByRole('dialog', { name: 'Choose a Matter', exact: true });
  await expect(dialog).toHaveAttribute('data-state', 'ready');
  const choices = await (await choicesRead).json();
  expect(choices.ownerId).toBe(record.attorney.id);
  expect(choices.items.map(item => item.id)).toContain(record.activeId);
  expect(choices.items.find(item => item.id === record.historyId)).toMatchObject({ status: 'paused', title: 'River Street retained assignment' });
  await expect(dialog.locator('[aria-current="true"]')).toContainText('River Street retained assignment');
  await expect(dialog.locator('[aria-current="true"]')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('[data-matter-payments]')).toHaveAttribute('data-state', 'needs_review');
  expect(new URL(page.url()).searchParams.get('caseId')).toBe(record.historyId);
  await expect(page.locator('#caseTitle')).toHaveText('River Street retained assignment');
  await expect(switcher).toBeEnabled();
  expect(server.evidence().provider).toEqual([]); expect(server.evidence().mail).toEqual([]);
});
