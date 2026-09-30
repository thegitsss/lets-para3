const { test, expect, fixture } = require('./legacy-fixture');
test('the actual original Payments table loads every page and preserves currency, uncertainty and lifecycle meaning', async ({ page }, testInfo) => {
  const { state, body } = await fixture(page, { count: 501 });
  await expect(page.locator('[data-escrow-page-info]')).toHaveText('1–5 of 501'); expect(state.pages).toEqual([0, 500]);
  await page.locator('[data-escrow-sort-key="case"]').click();
  await expect(body).toContainText('$300.00'); await expect(body).toContainText('€200.00'); await expect(body).toContainText('Not confirmed');
  const uncertain = body.locator('tr').filter({ hasText: 'Matter 0003' }); await expect(uncertain).toContainText('Closed'); await expect(uncertain).toContainText('Needs review'); await expect(uncertain).not.toContainText('$0.00');
  await page.locator('[data-escrow-page-action="next"]').click(); await expect(page.locator('[data-escrow-page-info]')).toHaveText('6–10 of 501');
  await page.setViewportSize({ width: 390, height: 900 }); await page.locator('[data-escrow-page-action="prev"]').click(); await expect(page.locator('[data-escrow-page-info]')).toHaveText('1–5 of 501');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(state.posts).toEqual([]);
  const scroll = page.locator('[data-escrow-scroll]'); await scroll.focus(); await expect(scroll).toBeFocused();
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  const amountSort = page.locator('[data-escrow-sort-key="amount"]'); await amountSort.focus(); await expect(amountSort).toBeFocused();
  await expect.poll(() => amountSort.evaluate(element => {
    const box = element.getBoundingClientRect(), viewport = element.closest('[data-escrow-scroll]').getBoundingClientRect();
    return box.left >= viewport.left - 1 && box.right <= viewport.right + 1;
  })).toBe(true);
  expect(await body.locator('td').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth + 1 && cell.scrollHeight <= cell.clientHeight + 1))).toBe(true);
  expect(await uncertain.locator('td').nth(2).evaluate(element => getComputedStyle(element).textOverflow)).not.toBe('ellipsis');
  await page.locator('.active-funds-panel').screenshot({ path: testInfo.outputPath('legacy-funds-mobile.png') });
});
test('an interrupted later payment page never presents the earlier partial page as the whole record', async ({ page }) => {
  const { state, body } = await fixture(page, { count: 501, secondPageFailure: true }); await expect(body).toContainText('Payment activity could not be verified'); await expect(body).not.toContainText('$300.00'); await expect(body.locator('tr[data-case-id]')).toHaveCount(0); expect(state.pages).toEqual([0, 500]);
  state.secondPageFailure = false; await page.getByRole('button', { name: 'Refresh Matter funds', exact: true }).click(); await expect(page.locator('[data-escrow-page-info]')).toHaveText('1–5 of 501'); expect(state.pages).toEqual([0, 500, 0, 500]);
});
test('an account replaced during the payment inventory cannot display the old account amounts', async ({ page }) => {
  const { state, body } = await fixture(page, { count: 501, replaceAfterFirst: true }); await expect(body).toContainText('Payment activity could not be verified'); await expect(body).not.toContainText('$300.00'); await expect(body.locator('tr[data-case-id]')).toHaveCount(0); expect(state.pages).toEqual([0]);
});
