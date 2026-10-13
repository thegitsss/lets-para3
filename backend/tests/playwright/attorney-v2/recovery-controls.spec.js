const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const { fixtures, install, objectId, region } = require('./home-summaries-fixture');
async function component(page) {
  await page.route('**/attorney-v2.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>[hidden]{display:none!important}</style></head><body></body></html>' }));
  await page.goto('/attorney-v2.html');
}
test('Home offers Retry only for a failed source and restores focus after recovery', async ({ page }) => {
  const data = fixtures(); data.applications = { httpError: 503 }; await install(page, data);
  await expect(page.getByRole('button', { name: /^Refresh\b/ })).toHaveCount(0);
  const panel = region(page, 'applications'); await expect(panel).toHaveAttribute('data-state', 'error');
  await expect(region(page, 'recent')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('button', { name: /^Retry/ })).toHaveCount(1);
  data.applications = []; const retry = panel.getByRole('button', { name: 'Retry applications', exact: true }); await retry.focus(); await retry.press('Enter');
  await expect(panel).toHaveAttribute('data-state', 'ready'); await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.getByRole('heading')).toBeFocused(); await expect(panel).toContainText('No applications to review.');
});
test('Home picks up changed records on return without a manual refresh control', async ({ page }) => {
  const data = fixtures(); await install(page, data);
  const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
  await nav.getByRole('link', { name: 'Help', exact: true }).click();
  data.home.counts.active = 1; data.home.postedCount = 1;
  data.home.recent = { total: 1, items: [{ id: objectId(42), title: 'Newly updated Matter', label: 'Posted', practiceArea: 'Contracts' }] };
  await nav.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(region(page, 'recent')).toContainText('Newly updated Matter');
  await expect(page.getByRole('button', { name: /^(Refresh|Retry)\b/ })).toHaveCount(0);
});
test('background failure clears stale values and exposes working recovery', async ({ page }) => {
  await component(page);
  await page.evaluate(async () => {
    const { region } = await import('/assets/scripts/attorney-v2/dom.mjs'); window.failed = false;
    window.panel = region('Records', { signal: new AbortController().signal, load: async () => { if (window.failed) throw Error('unavailable'); return 'Current record'; }, render: value => { const a = document.createElement('a'); a.href = '#record'; a.textContent = value; return [a]; } });
    document.body.append(window.panel); await window.panel.readiness;
  });
  await page.getByRole('link', { name: 'Current record' }).focus();
  await page.evaluate(async () => { window.failed = true; await window.panel.refresh({ background: true }); });
  await expect(page.getByRole('link')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Retry records' })).toBeFocused();
  await page.evaluate(() => { window.failed = false; }); await page.getByRole('button', { name: 'Retry records' }).click();
  await expect(page.getByRole('link', { name: 'Current record' })).toBeVisible(); await expect(page.getByRole('button')).toHaveCount(0);
});
test('uncertain financial actions retain a status check that disappears after confirmation', async ({ page }) => {
  await component(page);
  await page.evaluate(async () => {
    const { node, setRecovery } = await import('/assets/scripts/attorney-v2/dom.mjs'); const { financialRefresh } = await import('/assets/scripts/attorney-v2/financial-section.mjs');
    const section = node('section', { 'data-state': 'ready' }, [node('h2', { text: 'Payment status' })]); window.reads = 0;
    const control = financialRefresh('Refresh payment status', () => { window.reads++; setRecovery(control, section); }); section.append(control); document.body.append(section);
    setRecovery(control, section, { pending: true, label: 'Check payment status' });
  });
  const check = page.getByRole('button', { name: 'Check payment status' }); await check.focus(); await check.press('Enter'); expect(await page.evaluate(() => window.reads)).toBe(1);
  await expect(page.getByRole('button')).toHaveCount(0); await expect(page.getByRole('heading')).toBeFocused();
});
test('healthy Home stays uncluttered on desktop and mobile in both themes', async ({ page }, info) => {
  await install(page);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(theme => { for (const e of [document.body, document.documentElement]) { e.classList.remove('theme-light', 'theme-dark'); e.classList.add('theme-' + theme); } }, theme);
    await expect(page.getByRole('button', { name: /^(Refresh|Retry)\b/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`home-${theme}-${width}.png`), fullPage: true });
  }
});

test('Matter panels retain retries after failed reads without replaying writes', async ({ page }) => {
  await component(page);
  for (const [moduleName, exportName, label] of [
    ['workspace-work', 'createWorkspaceWork', 'Retry work'],
    ['workspace-dates', 'createWorkspaceDates', 'Retry calendar'],
    ['workspace-funding', 'createWorkspaceFunding', 'Retry funding details'],
    ['workspace-withdrawal', 'createWorkspaceWithdrawal', 'Retry withdrawal details'],
    ['workspace-completion', 'createWorkspaceCompletion', 'Retry completion details'],
    ['workspace-disputes', 'createWorkspaceDisputes', 'Retry dispute review'],
    ['matter-receipts', 'createMatterReceipt', 'Retry receipt'],
    ['matter-downloads', 'createMatterDownloads', 'Retry files'],
    ['matter-exports', 'createMatterExport', 'Retry archive details'],
  ]) {
    await page.evaluate(async ({ moduleName, exportName }) => {
      const { createPrivateState } = await import('/assets/scripts/attorney-v2/private-state.mjs');
      window.panelController?.abort(); document.body.replaceChildren(); window.panelController = new AbortController(); window.apiCalls = [];
      const api = new Proxy({}, { get: (_, name) => async () => { window.apiCalls.push(name); throw Object.assign(Error('unavailable'), { status: 503 }); } });
      const factory = (await import('/assets/scripts/attorney-v2/' + moduleName + '.mjs'))[exportName];
      const context = { api, signal: window.panelController.signal, ownerId: '111111111111111111111111', privateState: createPrivateState(), route: { name: 'matter', caseId: '222222222222222222222222', query: new URLSearchParams() } };
      const panel = factory(context.route.caseId, context); document.body.append(panel); await panel.readiness;
    }, { moduleName, exportName });
    const retry = page.getByRole('button', { name: label, exact: true }); await expect(retry).toBeVisible();
    const before = await page.evaluate(() => window.apiCalls.length);
    await retry.click(); await expect.poll(() => page.evaluate(() => window.apiCalls.length)).toBeGreaterThan(before);
    await expect(retry).toBeEnabled();
    expect(await page.evaluate(() => window.apiCalls.every(name => /^(read|get)/.test(name)))).toBe(true);
  }
});

test('saved card and saved views expose checks only when their reads fail', async ({ page }) => {
  await component(page);
  await page.evaluate(async () => {
    const { createPaymentCard } = await import('/assets/scripts/attorney-v2/payment-card.mjs');
    const { createSavedViews } = await import('/assets/scripts/attorney-v2/saved-views.mjs');
    const { createPrivateState } = await import('/assets/scripts/attorney-v2/private-state.mjs');
    window.recoveryReads = { card: 0, views: 0 }; window.failReads = true;
    const ownerId = '111111111111111111111111', signal = new AbortController().signal;
    const api = { readDefaultCard: async () => { window.recoveryReads.card++; if (window.failReads) throw Error(); return { hasDefault: false, paymentMethod: null }; }, readMatterViews: async () => { window.recoveryReads.views++; if (window.failReads) throw Error(); return { ownerId, scope: 'attorney_matters', views: [] }; } };
    const card = createPaymentCard({ query: new URLSearchParams() }, { api, signal, ownerId });
    const views = createSavedViews({ api, signal, ownerId, privateState: createPrivateState(), getState: () => ({ view: 'active', search: '', practice: '', deadline: '', updated: '', sort: 'recent', archiveStatus: 'all' }), applyState: () => {} });
    document.body.append(card, views); await Promise.all([card.readiness, views.readiness]);
  });
  await expect(page.getByRole('button', { name: 'Retry saved card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry saved views' })).toBeVisible();
  await page.evaluate(() => { window.failReads = false; });
  await page.getByRole('button', { name: 'Retry saved card' }).click(); await page.getByRole('button', { name: 'Retry saved views' }).click();
  await expect(page.getByRole('button', { name: /^(Retry|Check saved)/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.recoveryReads)).toEqual({ card: 2, views: 2 });
});
