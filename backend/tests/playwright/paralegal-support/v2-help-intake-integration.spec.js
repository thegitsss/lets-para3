const { test, expect } = require('../../helpers/isolatedBrowserTest')('paralegal-help-intake-real');
test.use({ storageState: { cookies: [], origins: [] } });
const path = require('node:path');
const fs = require('node:fs/promises');
const evidenceRoot = path.resolve(__dirname, '../../../../docs/audits/completion-2026-09-09/help');
const startServer = require(path.join(evidenceRoot, 'backend-browser-server.cjs'));
const accountId = '64b000000000000000000001';
let server;

test.beforeAll(async () => {
  server = await startServer({ reporterId: accountId, frontendRoot: process.env.LPC_HELP_FRONTEND_ROOT || path.resolve(__dirname, '../../../../frontend') });
});
test.afterAll(async () => { await server?.close(); });

test('Help recovers a committed lost response through the real intake route without duplicate records', async ({ page, context }, testInfo) => {
  await context.addCookies([server.cookie]);
  const user = {
    _id: accountId, id: accountId, firstName: 'Dana', lastName: 'Young', role: 'paralegal', status: 'approved',
    email: 'dana@example.com', profileImage: '/assets/avatar-placeholder.svg', profilePhotoStatus: 'approved',
    yearsExperience: 8, practiceAreas: ['Litigation'], stateExperience: ['NY'], location: 'NY',
    resumeURL: `users/${accountId}/resume/current.pdf`, availability: 'Available',
    preferences: { theme: 'light', fontSize: 'md', hideProfile: false },
    onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true },
  };
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; this.readyState = 1; } close() { this.readyState = 2; } };
  });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/incidents')) return route.continue();
    const fixtures = {
      '/api/auth/me': { user }, '/api/users/me': user, '/api/users/me/onboarding': { onboarding: user.onboarding },
      '/api/csrf': { csrfToken: 'synthetic-help-csrf' }, '/api/account/preferences': user.preferences,
      '/api/paralegal/dashboard': { activeCases: [], completedCases: [] }, '/api/jobs/recommended': [], '/api/jobs/open': [],
      '/api/applications/my': [], '/api/cases/invited-to': [], '/api/cases/my-completed': { items: [] },
      '/api/notifications': [], '/api/notifications/unread-count': { count: 0, unreadCount: 0 },
      '/api/messages/threads': { items: [] }, '/api/messages/unread-count': { count: 0, unreadCount: 0 }, '/api/events': { items: [] },
      '/api/payments/connect/status': { readiness: { ready: true, accountPresent: true, evidenceState: 'verified' } },
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[pathname] || {}) });
  });
  const requests = [];
  let firstReceipt;
  await page.route('**/api/incidents', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      firstReceipt = await committed.json();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.origin}/paralegal-v2.html#/help`);
  await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  const summary = page.getByLabel('Short summary');
  const description = page.getByLabel('What happened?');
  const submit = page.locator('.v2-help-submit');
  const status = page.locator('.v2-help-report-status');
  await summary.fill('Browse Matters filter did not update');
  await description.fill('The practice area selection changed but the visible list did not update.');
  await submit.click();
  await expect(status).toContainText('Receipt unconfirmed');
  const committedEvidence = await server.getEvidence();
  expect(committedEvidence).toMatchObject({ incidents: 1, artifacts: 2, timelineEvents: 1, incidentReceipts: 1, appNotifications: 1, lpcCreatedEvents: 1 });
  expect(committedEvidence.references).toEqual([{ publicId: firstReceipt.incident.publicId, reporterId: accountId, source: 'help_form', routePath: '/paralegal-v2.html' }]);
  await page.reload();
  await expect(submit).toHaveText('Check report');
  await expect(summary).toHaveValue('Browse Matters filter did not update');
  const replayResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/incidents' && response.request().method() === 'POST');
  await submit.press('Enter');
  expect((await replayResponse).status()).toBe(200);
  await expect(status).toContainText(`Reference: ${firstReceipt.incident.publicId}`);
  await expect(status).toContainText('Report received');
  await expect(summary).toHaveValue('');
  await expect(description).toHaveValue('');
  expect(requests[1]).toEqual(requests[0]);
  const replayEvidence = await server.getEvidence();
  expect(replayEvidence).toEqual(committedEvidence);
  const stored = await page.evaluate(publicId => JSON.parse(sessionStorage.getItem(`incident-access:${publicId}`)), firstReceipt.incident.publicId);
  expect(stored.reporterAccessToken).toBe(firstReceipt.reporterAccessToken);
  const reporterStatus = await page.request.get(`${server.origin}/api/incidents/${firstReceipt.incident.publicId}`);
  expect(reporterStatus.status()).toBe(200);
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-real-intake-recovered.png`) });
  await fs.writeFile(testInfo.outputPath(`${testInfo.project.name}-durable-counts.json`), JSON.stringify({ committedEvidence, replayEvidence, reporterStatus: reporterStatus.status(), sameRequest: requests[1].requestId === requests[0].requestId, sameReporterAccess: stored.reporterAccessToken === firstReceipt.reporterAccessToken }, null, 2));
});
