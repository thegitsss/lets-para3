const strict = require('../financial-lifecycle/financial-strict-observation.cjs');
const base = { test: strict.test, expect: strict.expect };
const start = strict.start;
let server;
const test = base.test.extend({
  page: async ({ browser }, use, info) => {
    await server.reset();
    const actor = await server.createUser('director');
    const User = require('../../../models/User'), Profile = require('../../../models/DirectorProfile');
    await User.updateOne({ _id: actor.id }, { $set: { firstName: 'Drew', lastName: 'Harness' } });
    const context = await browser.newContext({ baseURL: server.origin, viewport: { width: 1366, height: 900 } });
    const errors = [], observations = [], screenshotMappings = [];
    await context.addCookies([actor.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    // The historical body retains its original screenshot calls. Keep their
    // artifacts in this run instead of overwriting earlier /tmp evidence.
    const screenshot = page.screenshot.bind(page);
    page.screenshot = options => {
      if (['/tmp/lpc-director-portal-desktop.png','/tmp/lpc-director-portal-mobile.png'].includes(options?.path)) {
        const mapped = info.outputPath(require('node:path').basename(options.path));
        screenshotMappings.push({ original: options.path, actual: mapped });
        return screenshot({ ...options, path: mapped });
      }
      return screenshot(options);
    };
    try {
      const initial = await context.request.get(server.origin + '/api/auth/me');
      base.expect(initial.status()).toBe(200);
      const initialUser = (await initial.json()).user;
      base.expect(initialUser).toMatchObject({ id: actor.id, role: 'director', status: 'approved' });
      const overview = await context.request.get(server.origin + '/api/director/overview?expectedOwnerId=' + actor.id);
      base.expect(overview.status()).toBe(200); base.expect((await overview.json()).ownerId).toBe(actor.id);
      await Profile.updateOne({ userId: actor.id }, { $set: { displayName: 'Drew Harness' } });
      // This original portal scenario requires a returning managed session.
      // Establish its real CSRF cookie before opening the login document; the
      // separate first-login/autofill bootstrap race remains an auth diagnostic.
      const csrf = await context.request.get(server.origin + '/api/csrf');
      base.expect(csrf.status()).toBe(200);
      const csrfToken = (await csrf.json()).csrfToken;
      base.expect(typeof csrfToken).toBe('string'); base.expect(csrfToken.length).toBeGreaterThan(0);
      const csrfCookie = (await context.cookies(server.origin)).find(row => row.name === '_csrf');
      base.expect(csrfCookie?.value).toBe(csrfToken);
      observations.push({ phase: 'actual-authenticated-returning-csrf-precondition', ownerId: actor.id,
        status: csrf.status(), actualCookieMatchesToken: true,
        tokenDigest: require('node:crypto').createHash('sha256').update(csrfToken).digest('hex') });
      await page.goto(server.origin + '/login.html');
      await page.locator('#email').fill(initialUser.email);
      await page.locator('#password').fill('Private synthetic lifecycle password!');
      await Promise.all([page.waitForURL(/director-portal\.html/), page.locator('#loginForm button[type="submit"]').click()]);
      const current = await context.request.get(server.origin + '/api/auth/me');
      base.expect(current.status()).toBe(200); const user = (await current.json()).user;
      base.expect(user).toMatchObject({ id: actor.id, role: 'director', status: 'approved' });
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user') || 'null'));
      base.expect(stored).toMatchObject({ id: actor.id, role: 'director', status: 'approved' });
      for (const key of ['email','authVersion','pendingEmail','state','stateExperience']) base.expect(stored).not.toHaveProperty(key);
      const cookie = (await context.cookies(server.origin)).find(row => row.name === 'token');
      const claims = require('jsonwebtoken').verify(cookie.value, process.env.JWT_SECRET);
      const account = await User.findById(actor.id).select('+authVersion').lean();
      const session = await require('../../../models/AuthSession').findOne({ sessionId: claims.sid, userId: account._id }).lean();
      base.expect(account).toMatchObject({ role: 'director', status: 'approved', disabled: false, deleted: false });
      base.expect(claims.av).toBe(Number(account.authVersion || 0));
      base.expect(session.revokedAt).toBeNull(); base.expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await base.expect(page.locator('#directorStatus')).toHaveText('');
      observations.push({ phase: 'actual-password-login-ready', ownerId: actor.id, role: user.role, status: user.status, publicIdentityWrittenByActualLogin: true, currentManagedSessionVerified: true, authVersionMatches: true, syntheticProfileLabel: 'Drew Harness', privateCacheFieldsWithheld: true });
      await use(page);
    } finally {
      try {
        const mutations = server.evidence().requests.filter(row => !['GET','HEAD','OPTIONS'].includes(row.method));
        const expectedAuthentication = mutations.filter(row => row.method === 'POST' && row.status === 200 && ['/api/auth/login','/api/auth/passkeys/authentication-options'].includes(row.path));
        base.expect(mutations.filter(row => !expectedAuthentication.includes(row))).toHaveLength(0);
        base.expect(server.evidence().external.mail).toHaveLength(0); base.expect(server.evidence().external.storage).toHaveLength(0);
        base.expect(await require('../../../models/DirectorOutreachRecord').countDocuments()).toBe(0);
        base.expect(await require('../../../models/DirectorOutreachEvent').countDocuments()).toBe(0);
        base.expect(errors).toEqual([]);
        observations.push({ phase: 'actual-empty-records-and-no-financial-or-mail-mutations', legitimateAuthentication: expectedAuthentication, recordCount: 0, eventCount: 0 });
      } finally {
        await context.close();
        await info.attach('director-original-managed-fixture-evidence.json', { body: Buffer.from(JSON.stringify({ observations, errors, screenshotMappings, ...server.evidence() })), contentType: 'application/json' });
      }
    }
  },
});
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeDirectors: true, port: 0 }); });
test.afterAll(async () => server?.close());
module.exports = { test, expect: base.expect };
