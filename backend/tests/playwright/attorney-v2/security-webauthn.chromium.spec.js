const path = require('path');
const { test, expect } = require('../../helpers/isolatedBrowserTest')('attorney-security-webauthn.chromium');
const start = require(path.resolve(__dirname, '../../../../docs/audits/completion-2026-09-09/security/backend-browser-server.cjs'));
test.use({ baseURL: 'http://localhost:5289', storageState: { cookies: [], origins: [] } });

// This exercises Chromium's CDP virtual authenticator, not a physical passkey.
// security-real.config.js assigns this spec only to the Chromium project.
let server;
test.beforeAll(async () => { test.setTimeout(120000); server = await start({ port: 5289 }); });
test.afterAll(async () => { await server?.close(); });

test('Chromium virtual authenticator registers and removes a real verified passkey under the app CSP', async ({ page, context, browserName }) => {
  expect(browserName).toBe('chromium');
  const owner = await server.createUser();
  await context.addCookies([owner.cookie]);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  try {
    const violations = [];
    page.on('console', message => { if (/content security policy/i.test(message.text())) violations.push(message.text()); });
    await page.goto('/attorney-v2.html#/settings?tab=security');
    await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'ready');
    await expect(page.locator('[data-security-content]')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Current password', { exact: true }).fill(server.password);
    await page.getByLabel('Name (optional)', { exact: true }).fill('Virtual work device');
    await page.getByRole('dialog').getByRole('button', { name: 'Continue on this device' }).click();
    await expect(page.getByRole('heading', { name: 'Virtual work device' })).toBeVisible();
    expect(await server.passkeys(owner.id)).toHaveLength(1);
    expect(violations).toEqual([]);
    await page.getByRole('button', { name: 'Remove Virtual work device' }).click();
    await page.getByRole('dialog').getByLabel('Current password', { exact: true }).fill(server.password);
    await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
    await expect(page.getByText('No passkeys added.', { exact: true })).toBeVisible();
    expect(await server.passkeys(owner.id)).toHaveLength(0);
  } finally { await cdp.detach(); }
});
