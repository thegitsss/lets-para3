const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0, includeAdminSupport: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

for (const role of ['attorney', 'paralegal']) for (const width of [1440, 390]) test(`supported Assistant keeps the current authorized Matter and unsent draft: ${role} ${width}`, async ({ browser }, info) => {
  const attorney = await server.createUser('attorney'), paralegal = await server.createUser('paralegal');
  const people = { attorney, paralegal }, actor = people[role], User = require('../../../models/User'), Case = require('../../../models/Case');
  await User.updateMany({}, { $set: { isFirstLogin: false, 'onboarding.attorneyTourCompleted': true, 'onboarding.paralegalTourCompleted': true, 'onboarding.paralegalProfileTourCompleted': true } });
  const matter = await Case.create({ title: 'Authorized Assistant context', details: 'Synthetic agreed work.', attorney: attorney.id, attorneyId: attorney.id, paralegal: paralegal.id, paralegalId: paralegal.id, status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_context', totalAmount: 40000, lockedTotalAmount: 40000, currency: 'usd', tasks: [{ title: 'Prepare exhibits', completed: false }] });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], sent = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/support\/.*message/.test(request.url()) && request.method() === 'POST') sent.push(request.url()); });
  try {
    const target = role === 'attorney' ? `/attorney-v2.html#/matters/${matter._id}/overview?returnHome=1` : `/paralegal-v2.html#/matter/${matter._id}?tab=overview&returnTo=%2Fhome`;
    await page.goto(server.origin + target);
    await page.locator('.lpc-boot-screen[open]').waitFor({ state: 'hidden' });
    const ask = page.getByRole('button', { name: 'Ask Assistant about this step', exact: true });
    await expect(ask).toBeVisible();
    const resolved = await page.evaluate(async args => {
      const { getSupportMatterContext } = await import('/assets/scripts/utils/support-workspace-context.mjs');
      return getSupportMatterContext(args);
    }, { ownerId: actor.id, role });
    expect(resolved.caseId).toBe(String(matter._id));
    await ask.click();
    const composer = page.locator('#supportDrawer textarea');
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(/Explain the current next step/);
    await composer.fill('Keep this unsent question');
    await page.locator('#supportDrawer [data-support-close]').click();
    await ask.click();
    await expect(composer).toHaveValue('Keep this unsent question');
    const notice = page.locator('[data-support-prompt-preserved]');
    await expect(notice).toBeVisible();
    const noticeBox = await notice.boundingBox(), shellBox = await page.locator('#supportDrawer .support-composer-shell').boundingBox(), inputBox = await composer.boundingBox();
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(shellBox.y + 0.5);
    expect(inputBox.width).toBeGreaterThan(shellBox.width * 0.6);
    await page.screenshot({ path: info.outputPath(`supported-assistant-${role}-${width}.png`) });
    await composer.fill('Keep this unsent question while I edit');
    await expect(notice).toHaveCount(0);
    await page.locator('#supportDrawer [data-support-close]').click();
    await page.getByRole('link', { name: 'Back to Home', exact: true }).first().click();
    await expect(page).toHaveURL(/#\/home$/);
    const cleared = await page.evaluate(async args => {
      const { getSupportMatterContext } = await import('/assets/scripts/utils/support-workspace-context.mjs');
      return getSupportMatterContext(args);
    }, { ownerId: actor.id, role });
    expect(cleared).toBeNull();
    expect(sent).toEqual([]);
    expect(server.evidence().external.mail).toEqual([]);
    expect(server.evidence().external.storage).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
