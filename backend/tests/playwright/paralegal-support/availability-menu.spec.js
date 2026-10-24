const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const { fixture, home } = require('./alignment-fixture');

test('Home availability opens as an anchored status menu and closes cleanly', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page);
  await home(page);
  const trigger = page.locator('.pv2-overview-header [data-v2-availability-trigger]');
  const editor = page.getByRole('dialog', { name: 'Update availability' });
  await expect(trigger).not.toContainText('Availability');
  await expect(trigger).toContainText('Available now');
  await trigger.click();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('radio', { name: 'Available now' })).toBeChecked();
  await expect(editor.getByRole('radio', { name: 'Not available' })).toBeVisible();
  await expect(editor.getByText('Availability', { exact: true })).toHaveCount(0);
  await expect(editor.getByText('Available again (optional)')).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const desktop = await page.evaluate(() => {
    const anchor = document.querySelector('[data-v2-availability-trigger]').getBoundingClientRect();
    const menu = document.querySelector('#v2-availability-dialog').getBoundingClientRect();
    return { anchorBottom: anchor.bottom, anchorRight: anchor.right, menuTop: menu.top, menuRight: menu.right };
  });
  expect(desktop.menuTop).toBeGreaterThanOrEqual(desktop.anchorBottom);
  expect(Math.abs(desktop.menuRight - desktop.anchorRight)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('availability-desktop.png') });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(editor).toBeVisible();
  const mobile = await editor.boundingBox();
  expect(mobile.x).toBeGreaterThanOrEqual(0);
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath('availability-mobile.png') });
  await page.locator('.pv2-overview-header h1').click();
  await expect(editor).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
