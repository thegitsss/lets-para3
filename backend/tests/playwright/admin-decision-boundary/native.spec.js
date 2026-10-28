const { test, expect } = require('playwright/test');
const f = require('./fixture.cjs');
let server;
test.beforeAll(async () => { test.setTimeout(360000); server = await f.start(); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());
async function fixture(browser) {
  const actor = await server.createUser('admin'), applicant = await f.applicant(server), contexts = [], observations = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); contexts.push(context);
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  async function ready() {
    await f.authority(context.request, server, actor, observations);
    const csrf = await f.csrf(context.request, server);
    expect((await context.cookies(server.origin)).find(row => row.name === '_csrf')?.value).toBe(csrf);
    // This is a returning managed Admin journey. Actual password sign-in owns
    // the public cache; its authenticated CSRF precondition is explicit.
    await page.goto(server.origin + '/login.html');
    const storedActor = await require('../../../models/User').findById(actor.id).lean();
    await page.locator('#email').fill(storedActor.email); await page.locator('#password').fill('Private synthetic lifecycle password!');
    await Promise.all([page.waitForURL(/admin-dashboard\.html/), page.locator('#loginForm button[type="submit"]').click()]);
    await f.authority(context.request, server, actor, observations);
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user') || 'null'));
    expect(cache).toMatchObject({ id: actor.id, role: 'admin', status: 'approved' });
    const currentCookie = (await context.cookies(server.origin)).find(row => row.name === 'token');
    const claims = require('jsonwebtoken').verify(currentCookie.value, process.env.JWT_SECRET);
    const session = await require('../../../models/AuthSession').findOne({ userId: actor.id, sessionId: claims.sid }).lean();
    expect(session.revokedAt).toBeNull(); expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    observations.push({ phase: 'actual-native-returning-admin-login', ownerId: actor.id, cacheWrittenByActualLogin: true, managedSessionActive: true, authVersion: claims.av });
    await page.goto(server.origin + '/admin-dashboard.html?area=signups#user-management');
    const row = page.locator('#pendingUsersBody tr').filter({ hasText: applicant.lastName });
    await expect(row).toHaveCount(1); await row.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.locator('#pendingUserModal')).toBeVisible();
    await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admission-user-id', applicant.id);
    await expect(page.locator('.admin-qualification-review')).toHaveCount(0);
    await expect(page.locator('#approveUserBtn')).toBeEnabled();
    const stored = await require('../../../models/User').findById(applicant.id).lean();
    const revision = require('../../../services/admissionReview').admissionRevision(stored);
    await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admission-revision', revision);
    observations.push({ phase: 'actual-native-reviewed-application', reviewedAdmin: actor.id, applicantId: applicant.id, revision, noticeCapture: server.noticeEvidence() });
  }
  async function capture(info, label, target = '#approveUserBtn') {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 }); const element = page.locator(target);
      await element.scrollIntoViewIfNeeded(); await expect(element).toBeVisible(); await expect(element).toBeInViewport();
      const geometry = await element.evaluate(element => {
        const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const range = document.createRange(); range.selectNodeContents(element);
        return { width: innerWidth, text: element.textContent, hit: hit === element || element.contains(hit),
          lines: [...range.getClientRects()].map(line => ({ left: line.left, right: line.right, top: line.top, bottom: line.bottom })) };
      });
      observations.push({ phase: 'actual-native-control-or-status-geometry', label, target, ...geometry });
      expect(geometry.lines.length).toBeGreaterThan(0);
      expect(geometry.lines.every(line => line.left >= 0 && line.right <= width && line.top >= 0 && line.bottom <= 900)).toBe(true);
      if (target === '#approveUserBtn') expect(geometry.hit).toBe(true);
      await page.screenshot({ path: info.outputPath(label + '-' + width + '.png'), animations: 'disabled' });
    }
  }
  const finish = info => f.finish(server, info, contexts, observations, [applicant.id], errors, true);
  return { actor, applicant, context, page, observations, ready, capture, finish };
}
test('native Admin application review permits owner approval without a qualification form and records the decision through the actual approve control at both widths', async ({ browser }, info) => {
  test.setTimeout(150000); const x = await fixture(browser);
  try {
    await x.ready(); await x.capture(info, 'native-reviewed-admission');
    const path = '/api/admin/users/' + x.applicant.id + '/approve';
    const returned = f.finalResponse(x.page, path, x.observations);
    await x.page.locator('#approveUserBtn').click(); const response = await returned; await response.finished();
    const saved = await f.snapshot([x.applicant.id]); x.observations.push({ phase: 'actual-native-approved-record', status: response.status(), payload: await response.json(), saved });
    expect(response.status()).toBe(200); expect(saved.applicants[0].status).toBe('approved'); expect(saved.applicants[0].audit).toHaveLength(1);
    expect(saved.applicants[0].audit[0]).toMatchObject({ adminId: x.actor.id, action: 'approved' });
    expect(saved.applicants[0].audit[0].qualificationReview).toBeUndefined();
    await expect(x.page.locator('#pendingUserModal')).toBeHidden(); await expect(x.page.locator('#toastBanner')).toContainText('User approved.');
    await x.capture(info, 'native-approved-admission-result', '#toastBanner');
    expect(server.noticeEvidence().actualOwningCalls.filter(row => row[0] === x.applicant.email)).toHaveLength(1);
  } finally { await x.finish(info); }
});
test('native Admin approval cannot silently use a newer managed account after the original owner reviewed the application', async ({ browser }, info) => {
  test.setTimeout(150000); const x = await fixture(browser);
  try {
    await x.ready(); await x.capture(info, 'native-owner-reviewed-admission');
    const newer = await server.createUser('admin'), before = await f.snapshot([x.applicant.id]);
    const oldCache = await x.page.evaluate(() => localStorage.getItem('lpc_user'));
    await x.context.clearCookies(); await x.context.addCookies([newer.cookie]);
    await f.authority(x.context.request, server, newer, x.observations);
    expect(await x.page.evaluate(() => localStorage.getItem('lpc_user'))).toBe(oldCache);
    const returned = f.finalResponse(x.page, '/api/admin/users/' + x.applicant.id + '/approve', x.observations);
    await x.page.locator('#approveUserBtn').click(); const response = await returned; await response.finished();
    const after = await f.snapshot([x.applicant.id]); x.observations.push({ phase: 'actual-native-reviewed-admin-switched-cookie', originalOwner: x.actor.id, currentOwner: newer.id, before, after, status: response.status(), payload: await response.json() });
    expect(response.status()).toBe(403); expect((await response.json()).code).not.toBe('CSRF_INVALID');
    expect(after).toEqual(before); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
    await expect(x.page.locator('#toastBanner')).not.toContainText('User approved.');
    await x.capture(info, 'native-switched-admin-decision-denied', '#toastBanner');
  } finally { await x.finish(info); }
});
test('native Admin approval cannot commit or announce admission after managed-session revocation during its held actual clean-tag scan', async ({ browser }, info) => {
  test.setTimeout(150000); const x = await fixture(browser); let returned, gate;
  try {
    await x.ready(); await x.capture(info, 'native-before-held-admission');
    const before = await f.snapshot([x.applicant.id]); gate = f.hold(x.applicant.resumeURL);
    returned = f.finalResponse(x.page, '/api/admin/users/' + x.applicant.id + '/approve', x.observations);
    await x.page.locator('#approveUserBtn').click(); await expect.poll(() => gate.entered).toBe(true);
    await f.revoke(x.actor, 'managed-session');
    const denied = await x.context.request.get(server.origin + '/api/admin/pending-users'); expect(denied.status()).toBe(403);
    x.observations.push({ phase: 'actual-native-admin-session-revoked-before-decision', status: denied.status(), payload: await denied.json() });
    gate.release(); const response = await returned; await response.finished();
    const after = await f.snapshot([x.applicant.id]); x.observations.push({ phase: 'actual-native-revoked-admission-result', before, after, status: response.status(), payload: await response.json() });
    expect(response.status()).toBe(403); expect(after).toEqual(before); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
    await expect(x.page.locator('#toastBanner')).not.toContainText('User approved.');
    await x.capture(info, 'native-revoked-admission-denied', '#toastBanner');
  } finally { gate?.release(); if (returned) await returned.catch(() => {}); await x.finish(info); }
});
