const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeDirectors: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

test('a current managed Director enters the first portal document without a saved public identity', async ({ browser }, info) => {
  test.setTimeout(90000);
  const actor = await server.createUser('director');
  const User = require('../../../models/User'), Session = require('../../../models/AuthSession');
  const Record = require('../../../models/DirectorOutreachRecord');
  const current = await User.findById(actor.id).select('+authVersion').lean();
  const claims = require('jsonwebtoken').verify(actor.cookie.value, process.env.JWT_SECRET);
  const managed = await Session.findOne({ sessionId: claims.sid, userId: current._id }).lean();
  expect(current).toMatchObject({ role: 'director', status: 'approved', disabled: false, deleted: false });
  expect(claims.av).toBe(Number(current.authVersion || 0));
  expect(managed.revokedAt).toBeNull(); expect(managed.expiresAt.getTime()).toBeGreaterThan(Date.now());
  const record = await Record.create({ directorUserId: actor.id, directorEmail: current.email,
    attorneyEmail: 'private-director-entry@example.test', attorneyName: 'Private synthetic Director portal entry',
    firstOutreachSentAt: new Date(), stage: 'follow_up_failed',
    metadata: { automaticFollowUp: { status: 'unknown', claimId: 'private-director-entry-claim' } } });
  const original = await Record.findById(record._id).lean();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const errors = [], responses = [], pageRequests = [], observations = [];
  let page;
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  await context.addInitScript(() => {
    if (location.pathname === '/director-portal.html') {
      window.__directorFirstDocumentCache = localStorage.getItem('lpc_user');
      sessionStorage.setItem('director-entry-initial-cache', JSON.stringify({ present: localStorage.getItem('lpc_user') !== null }));
    }
  });
  try {
    const meResponse = await context.request.get(server.origin + '/api/auth/me');
    expect(meResponse.status()).toBe(200); const me = (await meResponse.json()).user;
    expect(me).toMatchObject({ id: actor.id, role: 'director', status: 'approved' });
    observations.push({ phase: 'actual-managed-session', role: me.role, status: me.status, ownerId: me.id,
      realSessionPresent: true, revoked: false, authVersionMatches: true, publicCacheSeeded: false });
    for (const path of ['/api/director/overview', '/api/director/analytics', '/api/director/records']) {
      const response = await context.request.get(server.origin + path + '?expectedOwnerId=' + actor.id);
      expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
      const payload = await response.json(); expect(payload.ownerId).toBe(actor.id);
      expect(JSON.stringify(payload)).not.toContain('private-director-entry-claim');
      if (path.endsWith('/records')) {
        expect(payload.records.find(row => row.id === String(record._id)).attorneyName).toBe(original.attorneyName);
        for (const row of payload.records) expect(row).not.toHaveProperty('metadata');
      }
      observations.push({ phase: 'actual-owner-read', path, status: response.status(), ownerId: payload.ownerId, privateMetadataWithheld: true });
    }
    const other = await server.createUser('director'), otherContext = await browser.newContext();
    try {
      await otherContext.addCookies([other.cookie]);
      const response = await otherContext.request.get(server.origin + '/api/director/overview?expectedOwnerId=' + actor.id);
      expect(response.status()).toBe(403);
      observations.push({ phase: 'actual-other-owner-denied', status: response.status(), expectedOwner: actor.id });
    } finally { await otherContext.close(); }
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) pageRequests.push({ method: request.method(), path: url.pathname, expectedOwnerId: url.searchParams.get('expectedOwnerId') });
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) responses.push({ path: url.pathname, status: response.status() });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(server.origin + '/director-portal.html', { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/login\.html/);
    await expect(page.getByRole('heading', { name: 'Director Portal', exact: true })).toBeVisible();
    await expect(page.locator('#recordsBody')).toContainText(original.attorneyName);
    expect(await page.evaluate(() => window.__directorFirstDocumentCache)).toBeNull();
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user') || 'null'));
    expect(cached).toMatchObject({ id: actor.id, role: 'director', status: 'approved' });
    for (const key of ['email', 'pendingEmail', 'state', 'stateExperience', 'authVersion']) expect(cached).not.toHaveProperty(key);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('#recordsBody')).toContainText(original.attorneyName);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`director-first-document-${width}.png`) });
    }
    expect(await page.locator('body').textContent()).not.toContain('private-director-entry-claim');
    observations.push({ phase: 'first-document-ready', ownerId: cached.id, role: cached.role, cacheInitiallyAbsent: true, authoritativeReads: responses });
  } finally {
    try {
      if (page && !page.isClosed()) {
        observations.push({ phase: 'terminal-browser-checkpoint', path: new URL(page.url()).pathname,
          projection: await page.evaluate(() => {
            const user = JSON.parse(localStorage.getItem('lpc_user') || 'null');
            return { initial: JSON.parse(sessionStorage.getItem('director-entry-initial-cache') || 'null'),
              user: user ? { id: user.id, role: user.role, status: user.status, keys: Object.keys(user) } : null };
          }), privateRecordVisible: (await page.locator('body').textContent()).includes(original.attorneyName) });
        await page.screenshot({ path: info.outputPath('director-first-document-terminal.png') });
      }
      const saved = await Record.findById(record._id).lean();
      expect(saved.stage).toBe(original.stage); expect(saved.metadata).toEqual(original.metadata);
      expect(saved.followUpSentAt).toEqual(original.followUpSentAt);
      expect(await require('../../../models/DirectorOutreachEvent').countDocuments()).toBe(0);
      expect(server.evidence().requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method))).toHaveLength(0);
      expect(server.evidence().external.mail).toHaveLength(0); expect(server.evidence().external.storage).toHaveLength(0);
      observations.push({ phase: 'actual-record-conserved', stage: saved.stage, privateMetadataUnchanged: true, outwardMail: 0, clientMutations: 0 });
    } finally {
      await context.close();
      await info.attach('director-entry-actual-record-evidence.json', { body: Buffer.from(JSON.stringify({ observations, errors, pageRequests, responses, ...server.evidence() })), contentType: 'application/json' });
    }
    expect(errors).toEqual([]);
  }
});
