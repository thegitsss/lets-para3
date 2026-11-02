"use strict";
const { test, expect } = require('playwright/test');
const fs = require('node:fs'), path = require('node:path');
const { installNativeFixture, gotoNative, MATTER, PARA, OWNER, preparation, prepSnapshot } = require('./native-fixture.cjs');
const root = '/api/matter-preparation/matters/' + MATTER;
const clio = '/api/integrations/clio';
const cleanPlan = () => preparation({ items: [{ title: 'Prepare discovery responses for attorney review', citations: [{ sourceId: 'scope', name: 'Agreed matter instructions', quote: 'Prepare discovery responses and a chronology for attorney review.' }] }] });
async function capture(page, name) {
  if (!process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS) return;
  fs.mkdirSync(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, name + '.png'), fullPage: true });
}
async function typography(page) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/Segoe UI|system-ui/);
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).fontWeight)).toBe('400');
}
test('LPC identity continues from native Work navigation into source-linked preparation', async ({ page }) => {
  await installNativeFixture(page, { resolve(call) { if (call.path === root) return prepSnapshot('attorney', { preparation: cleanPlan() }); } });
  await gotoNative(page, '/attorney-v2.html#/matters/' + MATTER + '/work');
  await typography(page);
  await expect(page.locator('#av2-page-title')).toHaveCSS('font-family', /Segoe UI|system-ui/);
  await expect(page.locator('#av2-page-title')).toHaveCSS('font-weight', '600');
  const active = page.locator('.av2-nav a[aria-current=page]').first();
  await expect(active).toHaveCSS('background-color', 'rgb(237, 242, 250)');
  await capture(page, 'brand-work-desktop');
  await page.locator('[data-native-preparation-entry]').click();
  const panel = page.locator('[data-native-preparation]');
  await expect(panel).toBeFocused();
  await expect(panel.locator('.lpc-connected-heading h3')).toHaveCSS('font-family', /Segoe UI|system-ui/);
  await expect(panel.locator('.lpc-connected-source-picker')).toHaveCSS('border-top-width', '0px');
  await expect(panel.locator('.lpc-connected-button').first()).toHaveCSS('color', 'rgb(38, 51, 71)');
  await panel.locator('.lpc-connected-citations summary').click();
  await capture(page, 'brand-preparation-desktop');
});
test('light LPC typography and controls fit the paralegal matter on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installNativeFixture(page, { role: 'paralegal', resolve(call) { if (call.path === root) return prepSnapshot('paralegal', { preparation: cleanPlan() }); } });
  await gotoNative(page, '/paralegal-v2.html#/matter/' + MATTER + '?tab=work');
  await typography(page);
  await expect(page.locator('#v2-matter-title')).toHaveCSS('font-family', /Segoe UI|system-ui/);
  await expect(page.locator('#v2-matter-title')).toHaveCSS('font-weight', '600');
  await page.locator('[data-native-preparation-entry]').click();
  const panel = page.locator('[data-native-preparation]');
  await expect(panel).toBeFocused();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, 'brand-preparation-mobile');
});
for (const mobile of [false, true]) test('LPC matching presents professional evidence in its brand on ' + (mobile ? 'mobile' : 'desktop'), async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await installNativeFixture(page, { resolve(call) {
    if (call.path === '/api/paralegal-matching/search') return { mode: 'lexical', items: [{ id: PARA, name: 'Morgan Ellis', location: 'Virginia', yearsExperience: 6, availability: 'available', evidence: [{ field: 'bio', text: 'Six years preparing discovery responses and organizing litigation records for attorney review.', evidenceType: 'self_reported' }], requirements: [] }], note: 'Based on approved public profile information.' };
  } });
  await gotoNative(page, '/attorney-v2.html#/paralegals?match=work');
  await typography(page);
  await expect(page.locator('#av2-page-title')).toHaveCSS('font-family', /Segoe UI|system-ui/);
  await expect(page.locator('#av2-page-title')).toHaveCSS('font-weight', '600');
  const panel = page.locator('[data-native-matching]');
  await panel.getByLabel('Work description', { exact: true }).fill('Organize discovery records and prepare a chronology for attorney review');
  await panel.getByRole('button', { name: 'Find relevant experience', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Experience to consider' })).toBeVisible();
  await panel.getByText('Why this profile appeared', { exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Find relevant experience', exact: true })).toHaveCSS('background-color', 'rgb(38, 51, 71)');
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, mobile ? 'brand-matching-mobile' : 'brand-matching-desktop');
});
test('Clio keeps its official logotype inside an LPC connection and review dialog', async ({ page }) => {
  const connection = { configured: true, connected: true, ownerId: OWNER, connectionRevision: 'synthetic-brand-connection', needsReconnect: false };
  await installNativeFixture(page, { resolve(call) {
    if (call.path === clio + '/status') return connection;
    if (call.path === clio + '/matters') return { items: [{ id: '123', label: 'Discovery chronology', description: 'Private source matter' }], nextCursor: null };
    if (call.path === clio + '/matters/123/documents') return { items: [], nextCursor: null };
  } });
  await gotoNative(page, '/attorney-v2.html#/settings?tab=connections');
  await typography(page);
  const wordmark = page.locator('.lc-clio-heading .lc-clio-wordmark');
  await expect(wordmark).toBeVisible(); await expect(wordmark).toHaveAttribute('aria-label', 'Clio');
  expect(await page.locator('.lc-clio-symbol').evaluate(element => getComputedStyle(element).maskImage)).toContain('clio-symbol.svg');
  expect(await page.locator('.lc-clio-logotype').evaluate(element => getComputedStyle(element).maskImage)).toContain('clio-wordmark.svg');
  await capture(page, 'brand-clio-connections');
  await page.getByRole('button', { name: 'Start from Clio', exact: true }).click();
  const dialog = page.locator('.lc-clio-dialog');
  await expect(dialog.getByRole('heading', { name: 'Start from Clio', exact: true })).toHaveCSS('font-family', /Segoe UI|system-ui/);
  await expect(page.locator('.lc-clio')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.lc-clio')).toHaveCSS('border-radius', '0px');
  await capture(page, 'brand-clio-dialog');
});
