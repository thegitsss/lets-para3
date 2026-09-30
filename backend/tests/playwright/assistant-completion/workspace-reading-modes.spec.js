const { test } = require('./shell-fixture');
const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installSettingsProjection } = require('../paralegal-support/settings-fixtures');

for (const role of ['attorney', 'paralegal']) test(`${role} profile retains labels, controls and keyboard access under reading modes`, async ({ page }, info) => {
  const state = await installSettingsProjection(page, { user: { role, lawFirm: 'River Street Legal', barNumber: 'NY123', timezone: 'America/New_York', onboarding: { attorneyTourCompleted: true, paralegalTourCompleted: true, paralegalProfileTourCompleted: true } } });
  await page.goto(`/${role}-v2.html#/settings`);
  const first = page.getByLabel('First name', { exact: true });
  await expect(first).toHaveValue('Dana');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: 'body * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' });
  const content = role === 'attorney' ? '[data-account-content]' : '[data-v2-settings]';
  for (const width of [1920, 1440, 1366, 1024, 768, 640, 390, 360, 320]) {
    await page.setViewportSize({ width, height: width === 768 ? 390 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await first.scrollIntoViewIfNeeded(); await first.focus(); await expect(first).toBeFocused();
    const box = await first.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    if (width === 320 || width === 768 || width === 1440) await page.screenshot({ path: info.outputPath(`${role}-spacing-${width}.png`), fullPage: true });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await first.focus(); await page.keyboard.press('Tab');
  await expect(first).not.toBeFocused();
  expect(await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.width > 0 && r.height > 0; })).toBe(true);
  await page.screenshot({ path: info.outputPath(`${role}-forced-colors-320.png`), fullPage: true });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(first).toHaveValue('Dana');
  expect((await new AxeBuilder({ page }).include(content).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(state.profilePatches).toEqual([]); expect(state.preferencePosts).toEqual([]); expect(state.securityMutations).toEqual([]);
});
