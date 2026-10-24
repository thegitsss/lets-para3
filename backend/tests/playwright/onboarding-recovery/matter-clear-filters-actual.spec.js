'use strict';
const { test, expect } = require('../workspace-paired-observation.cjs');
const { install, fixtures, matter } = require('../attorney-v2/home-summaries-fixture');
const { inventoryFixture } = require('../attorney-v2/inventory-fixture');
const { json, OWNER } = require('../assistant-completion/fixture');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
for (const width of [1440, 390]) test(`Attorney Clear filters resets search, practice and retained query ${width}`, async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: server.origin, viewport: { width, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    const state = await install(page, fixtures(), []);
    const records = [matter(1, { title: 'Synthetic contract research', practiceArea: 'Contract Law' }), matter(2, { title: 'Synthetic litigation research', practiceArea: 'Litigation' })];
    await page.route('**/api/cases/inventory?**', async route => json(route, await inventoryFixture({ active: records, archived: [], drafts: { items: [] } }, OWNER, new URL(route.request().url()).searchParams)));
    await page.goto('/attorney-v2.html#/matters?q=Synthetic&matterPractice=Contract%20Law');
    await expect(page.locator('.av2-matter-row')).toHaveCount(1);
    const clear = page.locator('.av2-active-matter-filters').getByRole('button', { name: 'Clear filters', exact: true });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator('.av2-matter-row')).toHaveCount(2);
    await expect(page.locator('#av2-matter-search')).toHaveValue('');
    await expect(page.locator('.av2-active-matter-filters')).toBeHidden();
    expect(new URL(page.url()).hash).not.toMatch(/(?:q=|matterPractice=)/);
    await page.reload();
    await expect(page.locator('.av2-matter-row')).toHaveCount(2);
    await expect(page.locator('#av2-matter-search')).toHaveValue('');
    expect(state.errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('actual-clear-filters.png'), fullPage: true });
  } finally { await context.close(); }
});
