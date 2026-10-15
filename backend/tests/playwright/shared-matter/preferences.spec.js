const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0, includeSyntheticMail: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
const labels = {
  attorney: { inApp: 'In-app notifications', inAppMessages: 'In-app messages', inAppCase: 'In-app Matter updates', email: 'Email notifications', emailMessages: 'Email messages', emailCase: 'Email Matter updates' },
  paralegal: { inApp: 'In-app notifications', inAppMessages: 'In-app messages', inAppCase: 'In-app Matter updates', email: 'Email notifications', emailMessages: 'New message alerts', emailCase: 'Matter updates' },
};
for (const role of ['attorney', 'paralegal']) test(`${role} saved settings govern message and Matter alerts independently`, async ({ browser }, info) => {
  const user = await server.createUser(role, {}, true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([user.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(), results = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `${server.origin}/${role}-v2.html#/settings?tab=preferences`;
  const Notification = require('../../../models/Notification');
  const { notifyUser } = require('../../../utils/notifyUser');
  async function savedValue(key) {
    const response = await context.request.get(`${server.origin}/api/users/me`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    return (body.user || body).notificationPrefs?.[key] !== false;
  }
  async function dispatch(key, enabled) {
    for (const type of ['message', 'case_update']) {
      const beforeNotifications = await Notification.countDocuments({ userId: user.id, type });
      const beforeEmail = server.evidence().external.mail.length;
      // Exercise the actual common dispatcher after the actual settings write.
      // Provider receipt is deliberately captured locally, never sent externally.
      await notifyUser(user.id, type, { fromName: 'Matter participant', caseTitle: 'River Street evidence', summary: 'Review status changed.' });
      const appExpected = !(enabled === false && (key === 'inApp' || key === (type === 'message' ? 'inAppMessages' : 'inAppCase')));
      const emailExpected = !(enabled === false && (key === 'email' || key === (type === 'message' ? 'emailMessages' : 'emailCase')));
      expect(await Notification.countDocuments({ userId: user.id, type }) - beforeNotifications).toBe(Number(appExpected));
      expect(server.evidence().external.mail.length - beforeEmail).toBe(Number(emailExpected));
      results.push({ key, enabled, type, appExpected, emailExpected });
    }
  }
  try {
    await page.goto(url);
    const sibling = await context.newPage();
    await sibling.goto(url);
    await expect(sibling.getByRole('checkbox', { name: labels[role].email, exact: true })).toBeChecked();
    for (const [key, label] of Object.entries(labels[role])) {
      const control = page.getByRole('checkbox', { name: label, exact: true });
      await expect(control).toBeChecked();
      await control.uncheck();
      await expect.poll(() => savedValue(key)).toBe(false);
      await expect(sibling.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked({ timeout: 10000 });
      await page.reload();
      await expect(control).not.toBeChecked();
      await dispatch(key, false);
      await control.check();
      await expect.poll(() => savedValue(key)).toBe(true);
      await expect(sibling.getByRole('checkbox', { name: label, exact: true })).toBeChecked({ timeout: 10000 });
      await page.reload();
      await expect(control).toBeChecked();
      await dispatch(key, true);
    }
    await page.screenshot({ path: info.outputPath(`${role}-preferences-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath(`${role}-preferences-mobile.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('main iframe')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include('main').setLegacyMode().analyze()).violations).toEqual([]);
    const csrf = await (await context.request.get(`${server.origin}/api/csrf`)).json();
    const appearance = await context.request.post(`${server.origin}/api/account/preferences`, {
      headers: { 'X-CSRF-Token': csrf.csrfToken },
      data: { theme: 'dark', fontSize: 'xl', expectedOwnerId: user.id, expectedValues: { theme: 'light', fontSize: 'md' } },
    });
    expect(appearance.ok()).toBe(true);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.reload();
    await expect(page.getByRole('checkbox', { name: labels[role].inAppMessages, exact: true })).toBeChecked();
    await expect(page.locator('html')).toHaveClass(/theme-dark/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${role}-preferences-dark-xl-320.png`) });
    expect((await new AxeBuilder({ page }).include('main').setLegacyMode().analyze()).violations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await fs.writeFile(info.outputPath('preferences-evidence.json'), JSON.stringify({ role, results, errors, requests: server.evidence().requests, provider: 'local capture only' }, null, 2));
    await context.close();
  }
});
