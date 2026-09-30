const { test, expect } = require('playwright/test');
const path = require('node:path'), fs = require('node:fs/promises');
const startServer = require('./backend-server.cjs');
let server, cleanupStartup;
test.beforeEach(async ({ context }) => {
  server = await startServer({ frontendRoot: path.join(process.env.LPC_HELP_SOURCE_ROOT, 'frontend'), onStartupCleanup: close => { cleanupStartup = close; } });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
});
test.afterEach(async () => { await (server?.close || cleanupStartup)?.(); server = null; cleanupStartup = null; });

test('actual managed Help intake recovers one committed report and its history with enforced CSRF', async ({ page, context }, testInfo) => {
  const owner = await server.createUser(); await context.addCookies([owner.cookie]); const writes = []; let receipt;
  await page.route('**/api/incidents', async route => {
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) { const committed = await route.fetch(); expect(committed.status()).toBe(201); receipt = await committed.json(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.goto(`${server.origin}/attorney-v2.html#/help`); await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'ready');
  const summary = page.getByLabel('Short summary'), description = page.getByLabel('What happened?'), submit = page.locator('.v2-help-submit'), status = page.locator('.v2-help-report-status');
  await summary.fill('Matter page did not update'); await description.fill('The date stayed unchanged after a successful save.'); await submit.click(); await expect(status).toContainText('Receipt unconfirmed', { timeout: 35000 });
  const before = await server.evidence(owner.id); expect(before).toMatchObject({ incidents: 1, artifacts: 2, timeline: 1, receipts: 1, notifications: 1, events: 1, ownerIncidents: 1 });
  await description.fill('New details that are not part of the previous submission.'); await page.reload(); await expect(submit).toHaveText('Check report'); expect(writes).toHaveLength(1);
  const replay = page.waitForResponse(response => new URL(response.url()).pathname === '/api/incidents' && response.request().method() === 'POST'); await submit.click(); expect((await replay).status()).toBe(200);
  await expect(status).toContainText('Report received'); expect(writes[1]).toEqual(writes[0]); expect(await server.evidence(owner.id)).toEqual(before);
  expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem(`incident-access:${id}`)).reporterAccessToken, receipt.incident.publicId)).toBe(receipt.reporterAccessToken);
  // Legacy Help stored an unstamped token. It cannot establish ownership on a
  // future sign-in; removing it must preserve authenticated reporter access.
  await page.evaluate(async ({ publicId, token }) => {
    sessionStorage.setItem(`incident-access:${publicId}`, JSON.stringify({ publicId, reporterAccessToken: token }));
    const { persistSession } = await import('/assets/scripts/auth.js');
    const result = await (await fetch('/api/auth/me', { credentials: 'include' })).json();
    persistSession({ user: result.user });
  }, { publicId: receipt.incident.publicId, token: receipt.reporterAccessToken });
  expect(await page.evaluate(id => sessionStorage.getItem(`incident-access:${id}`), receipt.incident.publicId)).toBeNull();
  await status.getByRole('link', { name: 'View report' }).click(); await expect(page.locator('.lpc-report-current')).toContainText('Matter page did not update');
  await page.locator('.lpc-report-history summary').click(); await expect(page.locator('.lpc-report-updates li')).toHaveCount(1);
  await page.getByRole('link', { name: 'Back to Help' }).click(); await expect(description).toHaveValue('New details that are not part of the previous submission.');
  const forbidden = await page.request.post(`${server.origin}/api/incidents`, { data: { ...writes[0], requestId: '3a112788-135d-4cf4-9833-1f85ac08f6fb' } }); expect(forbidden.status()).toBe(403); expect((await forbidden.json()).code).toBe('CSRF_INVALID'); expect(await server.evidence(owner.id)).toEqual(before);
  await fs.writeFile(testInfo.outputPath('durable-counts.json'), JSON.stringify({ before, after: await server.evidence(owner.id), sameRequest: true, sameToken: true, csrfRefused: forbidden.status(), unstampedLegacyTokenRemoved: true, authenticatedHistoryRetained: true }, null, 2));
});

test('actual replacement cookie prevents an old-owner report and cannot read their receipt', async ({ page, context }) => {
  const owner = await server.createUser(), other = await server.createUser(); await context.addCookies([owner.cookie]);
  await page.goto(`${server.origin}/attorney-v2.html#/help`); const summary = page.getByLabel('Short summary'), description = page.getByLabel('What happened?');
  await summary.fill('Private issue for the original account'); await description.fill('Only the signed-in reporter should see this report.'); await page.locator('.v2-help-submit').click();
  await expect(page.locator('.v2-help-report-status')).toContainText('Report received'); const initial = await server.evidence(owner.id), publicId = initial.references[0].publicId;
  await summary.fill('Unsent original account draft'); await description.fill('Do not send this draft as the replacement owner.'); await context.addCookies([other.cookie]);
  await page.locator('.v2-help-submit').click(); await expect(page).toHaveURL(/\/login.html/); expect(await server.evidence(owner.id)).toEqual(initial);
  const forbidden = await page.request.get(`${server.origin}/api/incidents/${publicId}?expectedOwnerId=${other.id}`); expect(forbidden.status()).toBe(404);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('incident-access:') || key.startsWith('lpc:v2:help-draft:')))).toEqual([]);
});

test('actual cookie replacement after preflight rejects CSRF and clears old Help error content', async ({ page, context }, testInfo) => {
  const owner = await server.createUser(), replacement = await server.createUser(); await context.addCookies([owner.cookie]);
  await page.goto(`${server.origin}/attorney-v2.html#/help`); await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'ready');
  let swapped = false, writes = 0;
  await page.route('**/api/csrf', async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200);
    if (!swapped) { swapped = true; await context.addCookies([replacement.cookie]); }
    await route.fulfill({ response });
  }, { times: 1 });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/incidents' && request.method() === 'POST') writes++; });
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/incidents' && response.request().method() === 'POST');
  await page.getByLabel('Short summary').fill('Private original-owner report'); await page.getByLabel('What happened?').fill('These details must not remain visible after a silent cookie change.');
  await page.locator('.v2-help-submit').click(); const response = await refused; expect(response.status()).toBe(403); expect((await response.json()).code).toBe('CSRF_INVALID');
  await expect(page).toHaveURL(/\/login.html/); expect(writes).toBe(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('incident-access:') || key.startsWith('lpc:v2:help-draft:')))).toEqual([]);
  const evidence = await server.evidence(owner.id); expect(evidence).toMatchObject({ incidents: 0, artifacts: 0, timeline: 0, receipts: 0, notifications: 0, events: 0 });
  await fs.writeFile(testInfo.outputPath('post-preflight-cookie-change.json'), JSON.stringify({ writes, status: response.status(), code: 'CSRF_INVALID', privateHelpCleared: true, evidence }, null, 2));
});
