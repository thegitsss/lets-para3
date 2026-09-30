const { test, expect } = require('playwright/test');
const { seed, seedChargebacks } = require('./fixtures');
test.beforeEach(async ({ page }) => { await seed(); await seedChargebacks(); await page.emulateMedia({ reducedMotion: 'reduce' }); });

async function chooseFinance(page, layout) {
  if (layout === 'mobile') {
    await page.locator('#sidebarToggle').click();
    await expect(page.getByRole('dialog', { name: 'Admin navigation', exact: true })).toBeVisible();
  }
  await page.locator('#sidebarNav [data-section="finance"]').click();
  if (layout === 'mobile') await expect(page.getByRole('dialog', { name: 'Admin navigation', exact: true })).toBeHidden();
}

for (const layout of ['desktop', 'mobile']) {
for (const stage of ['queue', 'task']) {
  test(`sidebar selection survives a pending Home ${stage} read (${layout})`, async ({ page }) => {
    if (layout === 'mobile') await page.setViewportSize({width:390,height:844});
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { started = resolve; });
    const pattern = stage === 'queue' ? '**/api/admin/workspace/flow?**' : '**/api/admin/chargebacks?**';
    await page.route(pattern, async route => {
      if (stage === 'task' && !new URL(route.request().url()).searchParams.has('id')) return route.continue();
      const response = await route.fetch(); started(); await held; await route.fulfill({ response });
    });
    try {
      await page.goto('/admin-dashboard.html'); await began;
      await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'true');
      await chooseFinance(page, layout);
      release();
      await expect(page.getByRole('group', { name: 'Finance workspace', exact: true })).toBeVisible();
      await expect(page.locator('#adminFlow')).not.toBeVisible();
      await page.locator('[data-finance-view="exceptions"]').click();
      await expect(page.locator('#section-disputes')).toBeVisible();
    } finally { release(); }
  });
}

test(`an active work operation keeps its navigation guard until it settles (${layout})`, async ({ page }) => {
  if (layout === 'mobile') await page.setViewportSize({width:390,height:844});
  await page.goto('/admin-dashboard.html');
  await expect(page.locator('#adminFlowTitle')).toHaveText('Review a chargeback');
  await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  const operation = await page.evaluate(() => window.adminFlowChargebackId);
  expect(operation).toMatch(/^[a-f0-9]{24}$/);
  await page.evaluate(id => dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: true } })), operation);
  await chooseFinance(page, layout);
  await expect(page.locator('#adminFlowStatus')).toHaveText('Finish the current action first.');
  await expect(page.getByRole('group', { name: 'Finance workspace', exact: true })).not.toBeVisible();
  await page.evaluate(id => dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: false } })), operation);
  await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('group', { name: 'Finance workspace', exact: true })).not.toBeVisible();
  await chooseFinance(page, layout);
  await expect(page.getByRole('group', { name: 'Finance workspace', exact: true })).toBeVisible();
});

}
