const { test, expect, fixture, group, summary, json } = require('./fixture');
const AxeBuilder = require('@axe-core/playwright').default;

test('Home and Payments show the same distinct currencies and remaining funds without repeating card setup', async ({ page }) => {
  const f = await fixture(page, { value: summary([group({ activeFunds: 30000 }), group({ currency: 'EUR', activeFunds: 20000 })]) });
  await expect(f.panel).toContainText('$300.00'); await expect(f.panel).toContainText('€200.00'); await expect(f.panel).not.toContainText('$500.00'); await expect(f.panel).not.toContainText('Payment method ready');
  await f.panel.getByRole('link', { name: 'Open Payments', exact: true }).click();
  const current = page.locator('[data-av2-region="payment-summary"]'); await expect(current).toHaveAttribute('data-state', 'ready'); await expect(current).toContainText('$300.00'); await expect(current).toContainText('€200.00');
  await page.reload(); await expect(current).toHaveAttribute('data-state', 'ready'); await expect(current).toContainText('$300.00'); expect(f.state.posts).toEqual([]);
});

test('funding needed and a pending attempt use distinct wording without a success claim', async ({ page }) => {
  const f = await fixture(page, { value: summary([group({ originalFunding: 0, activeFunds: 0, fundingNeeded: 48800, activeMatters: 0, fundedMatters: 0, unfundedMatters: 1 })]) });
  await expect(f.panel).toContainText('Funding needed'); await expect(f.panel).toContainText('$488.00'); await expect(f.panel).not.toContainText('Pending funding');
  f.state.value = summary([group({ originalFunding: null, activeFunds: null, pendingCharges: 48800, fundingUnknown: true, balanceUnknown: true, pendingMatters: 1, activeMatters: 0 })]);
  await f.refresh.click(); await expect(f.panel).toContainText('Pending funding'); await expect(f.panel).not.toContainText('Funding needed'); await expect(f.panel).not.toContainText('Remaining Matter funds'); await expect(f.panel).not.toContainText('$0.00');
});

test('uncertain amounts have one review message and never turn into zero or repeated completion text', async ({ page }) => {
  const f = await fixture(page, { value: summary([group({ originalFunding: null, activeFunds: null, pendingCharges: null, fundingUnknown: true, balanceUnknown: true, pendingUnknown: true, requiresReview: 1 })]) });
  await expect(f.panel.getByText('1 Matter needs payment review.', { exact: true })).toHaveCount(1); await expect(f.panel.locator('dl')).toHaveCount(0); await expect(f.panel).not.toContainText('$0.00'); await expect(f.panel).not.toContainText('No payment activity');
});

test('failed and malformed refreshes remove earlier money and keep a usable retry', async ({ page }) => {
  const f = await fixture(page); await expect(f.panel).toContainText('$400.00');
  f.state.status = 503; await f.refresh.click(); await expect(f.panel).toHaveAttribute('data-state', 'error'); await expect(f.panel).not.toContainText('$400.00'); await expect(f.panel).not.toContainText('No payment activity');
  f.state.status = 200; f.state.value = { ...f.state.value, activeFunds: 1 }; await f.refresh.click(); await expect(f.panel).toHaveAttribute('data-state', 'error'); await expect(f.panel.locator('dl')).toHaveCount(0);
  f.state.value = summary(); await f.refresh.click(); await expect(f.panel).toHaveAttribute('data-state', 'ready'); await expect(f.panel).toContainText('$400.00');
});

test('a bounded read timeout exits loading and does not erase the ability to retry', async ({ page }) => {
  const f = await fixture(page); await page.clock.install(); let entered, release;
  const started = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  f.state.respond = async route => { entered(); await held; await json(route, f.state.value).catch(() => {}); };
  try { await f.refresh.click(); await started; await page.clock.fastForward(31000); await expect(f.panel).toHaveAttribute('data-state', 'error'); await expect(f.refresh).toBeEnabled(); await expect(f.panel).not.toContainText('$400.00'); }
  finally { f.state.respond = null; release(); }
  await f.refresh.click(); await expect(f.panel).toHaveAttribute('data-state', 'ready');
});

test('a replaced account cannot receive the held original-owner amounts', async ({ page }) => {
  const f = await fixture(page); let entered, release; const started = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  f.state.respond = async route => { entered(); await held; await json(route, summary([group({ activeFunds: 123456 })])).catch(() => {}); };
  try { await f.refresh.click(); await started; await page.route('**/api/auth/me', route => json(route, { user: { id: '222222222222222222222222', role: 'attorney', status: 'approved' } })); }
  finally { release(); }
  await expect(page).toHaveURL(/\/login.html/); await expect(page.locator('body')).not.toContainText('$1,234.56');
});

test('navigation discards a late summary without remounting or repainting the old page', async ({ page }) => {
  const f = await fixture(page); let entered, release; const started = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  f.state.respond = async route => { entered(); await held; await json(route, summary([group({ activeFunds: 123456 })])).catch(() => {}); };
  try { await f.refresh.click(); await started; await page.evaluate(() => { location.hash = '/help'; }); await expect(page.locator('html')).toHaveAttribute('data-attorney-route', 'help'); }
  finally { release(); }
  await expect(page.locator('[data-av2-region="payments"]')).toHaveCount(0); await expect(page.locator('body')).not.toContainText('$1,234.56');
});

for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) test(`${theme} payment summary fits ${width}px with visible keyboard focus and no contrast violations`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 }); const f = await fixture(page, { view: 'payments', theme, value: summary([group({ activeFunds: 30000, fundingNeeded: 48800 }), group({ currency: 'EUR', activeFunds: 20000 })]) });
  await f.panel.scrollIntoViewIfNeeded(); if (width === 320) await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  await f.refresh.focus(); await expect(f.refresh).toBeFocused(); expect(await f.refresh.evaluate(element => { const s = getComputedStyle(element); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none'; })).toBe(true);
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/theme-dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[data-av2-region="payment-summary"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('payment-summary.png'), fullPage: true });
});
