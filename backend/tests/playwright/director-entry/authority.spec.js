const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeDirectors: true }); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());
const me = '/api/auth/me', overview = '/api/director/overview';

// Explicitly invalidate a first-document read after a synthetic account sync
// event. Normal already-pinned reads retain their existing expected-owner GET.
async function freshRead(page) {
  await page.evaluate(() => {
    const value = localStorage.getItem('lpc_user');
    window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue: value, newValue: value }));
  });
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
}


async function fixture(browser) {
  const contexts = [], errors = [], observations = [];
  const director = await server.createUser('director');
  const Record = require('../../../models/DirectorOutreachRecord'), User = require('../../../models/User');
  const record = await Record.create({ directorUserId: director.id, directorEmail: (await User.findById(director.id).lean()).email,
    attorneyEmail: 'entry-private@example.test', attorneyName: 'Private synthetic Director entry record', firstOutreachSentAt: new Date(), stage: 'follow_up_failed',
    metadata: { automaticFollowUp: { status: 'unknown', claimId: 'private-entry-claim' } } });
  const original = (await Record.findById(record._id).lean());
  const ownerRecords = [original];
  async function privateRecordFor(actor) {
    const value = await Record.create({ directorUserId: actor.id, directorEmail: (await User.findById(actor.id).lean()).email,
      attorneyEmail: original.attorneyEmail, attorneyName: original.attorneyName, firstOutreachSentAt: new Date(), stage: original.stage,
      metadata: original.metadata });
    ownerRecords.push(await Record.findById(value._id).lean());
  }
  async function contextFor(actor = director) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); contexts.push(context);
    await context.addCookies([actor.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  }
  async function identity(context, expected) {
    const response = await context.request.get(server.origin + me); expect(response.status()).toBe(200);
    const payload = await response.json(); observations.push({ phase: 'actual-me', status: response.status(), user: payload.user ? { id: payload.user.id, role: payload.user.role, status: payload.user.status } : null });
    if (expected) expect(payload.user.id).toBe(expected.id); else expect(payload.user).toBeNull();
    return payload.user;
  }
  async function ready(context, expectedOwner = director) {
    const page = await context.newPage(); await page.goto(server.origin + '/director-portal.html');
    await expect(page.getByRole('heading', { name: 'Director Portal', exact: true })).toBeVisible();
    await expect(page.locator('#recordsBody')).toContainText(original.attorneyName);
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')))).id).toBe(expectedOwner.id);
    const response = await context.request.get(server.origin + '/api/director/records?expectedOwnerId=' + expectedOwner.id);
    expect(response.status()).toBe(200); const payload = await response.json(); expect(payload.ownerId).toBe(expectedOwner.id);
    const expectedIds = ownerRecords.filter(row => String(row.directorUserId) === expectedOwner.id).map(row => String(row._id));
    expect(expectedIds.length).toBeGreaterThan(0);
    for (const id of expectedIds) expect(payload.records.some(row => row.id === id)).toBe(true);
    for (const row of payload.records) expect(row).not.toHaveProperty('metadata');
    if (expectedOwner.id !== String(original.directorUserId)) expect(payload.records.some(row => row.id === String(original._id))).toBe(false);
    observations.push({ phase: 'actual-ready-owner-records', ownerId: payload.ownerId, expectedOwnedRecordIds: expectedIds, actualRecordIds: payload.records.map(row => row.id), foreignOriginalAbsent: expectedOwner.id !== String(original.directorUserId) });
    return page;
  }
  async function noPrivate(page) {
    expect(await page.locator('body').textContent()).not.toContain(original.attorneyName);
    expect(await page.locator('body').textContent()).not.toContain(original.attorneyEmail);
    expect(await page.locator('body').textContent()).not.toContain('private-entry-claim');
    expect(await page.locator('#directorPaymentBody').count() ? await page.locator('#directorPaymentBody').textContent() : '').not.toContain('Save payment record');
    if (await page.locator('#directorIdentity').count()) expect(await page.locator('#directorIdentity').textContent()).toBe('');
  }
  async function finish(info) {
    try {
      const saved = await Record.findById(record._id).lean(); expect(saved.stage).toBe(original.stage); expect(saved.metadata).toEqual(original.metadata);
      expect(saved.followUpSentAt).toEqual(original.followUpSentAt);
      for (const before of ownerRecords) {
        const after = await Record.findById(before._id).lean();
        expect(after.stage).toBe(before.stage); expect(after.metadata).toEqual(before.metadata);
        expect(after.followUpSentAt).toEqual(before.followUpSentAt);
        observations.push({ phase: 'actual-owned-record-conserved', ownerId: String(after.directorUserId), stage: after.stage, metadata: after.metadata, followUpSentAt: after.followUpSentAt || null });
      }
      expect(await require('../../../models/DirectorOutreachEvent').countDocuments()).toBe(0);
      const mutations = server.evidence().requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method));
      const loginChallenges = mutations.filter(row => row.method === 'POST' && row.path === '/api/auth/passkeys/authentication-options' && row.status === 200);
      expect(mutations.filter(row => !loginChallenges.includes(row))).toHaveLength(0);
      observations.push({ phase: 'mutation-conservation', loginChallenges, otherMutations: [] });
      observations.push({ phase: 'actual-persisted-record-conserved', stage: saved.stage, metadata: saved.metadata, followUpSentAt: saved.followUpSentAt || null, events: await require('../../../models/DirectorOutreachEvent').countDocuments(), transport: server.evidence().external });
      expect(server.evidence().external.mail).toHaveLength(0); expect(server.evidence().external.storage).toHaveLength(0); expect(errors).toEqual([]);
    } finally {
      for (const context of contexts) await context.close();
      await info.attach('director-authority-actual-record-evidence.json', { body: Buffer.from(JSON.stringify({ observations, errors, ...server.evidence() })), contentType: 'application/json' });
    }
  }
  return { director, record, contextFor, identity, ready, noPrivate, finish, observations, privateRecordFor };
}

test('Director portal first document rejects current inactive unapproved Admin version-invalid and revoked sessions', async ({ browser }, info) => {
  test.setTimeout(90000); const f = await fixture(browser), User = require('../../../models/User'), Session = require('../../../models/AuthSession');
  try {
    for (const kind of ['disabled', 'deleted', 'pending', 'foreign-role', 'auth-version', 'revoked']) {
      const actor = await server.createUser('director'), context = await f.contextFor(actor);
      if (kind === 'auth-version') await User.updateOne({ _id: actor.id }, { $inc: { authVersion: 1 } });
      else if (kind === 'revoked') await Session.updateMany({ userId: actor.id }, { $set: { revokedAt: new Date(), revokedReason: 'Synthetic entry boundary.' } });
      else await User.updateOne({ _id: actor.id }, { $set: kind === 'foreign-role' ? { role: 'admin' } : kind === 'pending' ? { status: 'pending' } : { [kind]: true } });
      const hasCurrentUser = ['pending', 'foreign-role'].includes(kind), current = await f.identity(context, hasCurrentUser ? actor : null);
      if (hasCurrentUser) expect(current[kind === 'pending' ? 'status' : 'role']).toBe(kind === 'pending' ? 'pending' : 'admin');
      const page = await context.newPage(); await page.goto(server.origin + '/director-portal.html');
      if (hasCurrentUser) await expect(page.locator('#directorStatus')).toContainText('Director access could not be verified');
      else await expect(page).toHaveURL(/\/login\.html\?next=/);
      await f.noPrivate(page); expect(await page.locator('#directorPaymentPanel').count()).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem('lpc_user'))).toBeNull();
      f.observations.push({ phase: 'denied-entry', kind, path: new URL(page.url()).pathname, noPrivateRecords: true });
      await page.screenshot({ path: info.outputPath(`denied-${kind}.png`) });
    }
    expect(server.evidence().requests.filter(row => row.path === overview)).toHaveLength(0);
  } finally { await f.finish(info); }
});

test('Director portal verified reentry preserves the owner through outages and confirms current session loss', async ({ browser }, info) => {
  test.setTimeout(90000); const f = await fixture(browser);
  try {
    const context = await f.contextFor(); await f.identity(context, f.director); const page = await f.ready(context);
    await page.evaluate(() => { const oldValue = localStorage.getItem('lpc_user'); localStorage.removeItem('lpc_user'); window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue, newValue: null })); });
    await expect(page.locator('#recordsBody')).toContainText('Records unavailable'); await f.noPrivate(page);
    await f.identity(context, f.director); await freshRead(page);
    await expect(page.locator('#recordsBody')).toContainText('Private synthetic Director entry record');
    const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic current-read outage.' }) });
    await page.route(server.origin + me, unavailable); await freshRead(page);
    await expect(page.locator('#directorStatus')).toContainText('Unable to verify your account.'); await f.noPrivate(page);
    expect(new URL(page.url()).pathname).toBe('/director-portal.html');
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')))).id).toBe(f.director.id);
    f.observations.push({ phase: 'synthetic-first-read503-preserved-owner', responseMocked: true, ownerId: f.director.id, noPrivateRecords: true });
    await page.unroute(server.origin + me, unavailable); await freshRead(page);
    await expect(page.locator('#recordsBody')).toContainText('Private synthetic Director entry record');
    await require('../../../models/AuthSession').updateMany({ userId: f.director.id }, { $set: { revokedAt: new Date(), revokedReason: 'Synthetic current-session loss.' } });
    await f.identity(context, null);
    let confirmationReads = 0;
    const unavailableConfirmation = route => ++confirmationReads === 1 ? route.continue() : unavailable(route);
    await page.route(server.origin + me, unavailableConfirmation); await freshRead(page);
    await expect(page.locator('#directorStatus')).toContainText('Unable to verify your account.'); await f.noPrivate(page);
    expect(confirmationReads).toBe(2); expect(new URL(page.url()).pathname).toBe('/director-portal.html');
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')))).id).toBe(f.director.id);
    f.observations.push({ phase: 'actual-first-null-synthetic-confirmation503-preserved-owner', responseMockedOnlyForConfirmation: true, ownerId: f.director.id, noPrivateRecords: true });
    await page.unroute(server.origin + me, unavailableConfirmation); await freshRead(page);
    await expect(page).toHaveURL(/\/login\.html\?next=/); await f.noPrivate(page);
    expect(await page.evaluate(() => localStorage.getItem('lpc_user'))).toBeNull();
    f.observations.push({ phase: 'removed-cache-recovered-current-cookie-then-real-managed-session-revoked', noPrivateRecords: true });
    await page.screenshot({ path: info.outputPath('revoked-after-current-refresh.png') });
  } finally { await f.finish(info); }
});

test('Director portal stale entry responses cannot replace a different owner or clear a newer same-owner session', async ({ browser }, info) => {
  test.setTimeout(90000); const f = await fixture(browser); let release;
  try {
    const other = await server.createUser('director'), context = await f.contextFor();
    let holding = true; const barrier = new Promise(resolve => { release = resolve; }), held = [];
    await context.route(server.origin + me, async route => {
      const response = await route.fetch(), payload = await response.json(); held.push({ status: response.status(), ownerId: payload.user?.id });
      if (holding) await barrier; await route.fulfill({ response });
    });
    const page = await context.newPage(); await page.goto(server.origin + '/director-portal.html');
    await expect.poll(() => held.length).toBeGreaterThan(0); expect(held[0]).toEqual({ status: 200, ownerId: f.director.id });
    await context.clearCookies(); await context.addCookies([other.cookie]); const otherUser = await f.identity(context, other);
    await page.evaluate(user => { const oldValue = localStorage.getItem('lpc_user'), value = JSON.stringify({ id: user.id, role: user.role, status: user.status }); localStorage.setItem('lpc_user', value); window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue, newValue: value })); }, otherUser);
    holding = false; release(); await expect(page.locator('#directorStatus')).toContainText('signed-in account changed');
    await f.noPrivate(page); expect((await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')))).id).toBe(other.id);
    expect(await page.locator('#directorPaymentPanel').count()).toBe(0); expect(server.evidence().requests.filter(row => row.path === overview)).toHaveLength(0);
    f.observations.push({ phase: 'late-actual-me200-preserved-new-owner', held, latestOwner: other.id });

    const pinnedContext = await f.contextFor(), pinnedPage = await f.ready(pinnedContext);
    await pinnedContext.clearCookies(); await pinnedContext.addCookies([other.cookie]); await f.identity(pinnedContext, other);
    await pinnedPage.evaluate(user => { const oldValue = localStorage.getItem('lpc_user'), value = JSON.stringify({ id: user.id, role: user.role, status: user.status }); localStorage.setItem('lpc_user', value); window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue, newValue: value })); }, otherUser);
    await expect(pinnedPage.locator('#recordsBody')).toContainText('Records unavailable'); await f.noPrivate(pinnedPage);
    await freshRead(pinnedPage); await expect(pinnedPage.locator('#directorStatus')).toContainText('signed-in account changed');
    await f.noPrivate(pinnedPage); expect((await pinnedPage.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')))).id).toBe(other.id);
    const denied = await pinnedContext.request.get(server.origin + overview + '?expectedOwnerId=' + f.director.id); expect(denied.status()).toBe(403);
    f.observations.push({ phase: 'pinned-owner-denied-after-current-cookie-change', actualHandlerStatus: denied.status(), expectedOwner: f.director.id, currentOwner: other.id });
    await pinnedPage.screenshot({ path: info.outputPath('owner-changed-no-private-records.png') });

    // A new same-owner cookie need not change the public identity. Hold a real
    // older null response across that case and a different-owner transition.
    for (const mode of ['different-owner', 'same-owner-new-session']) {
      const actor = await server.createUser('director'), latest = mode === 'different-owner' ? other : actor;
      await f.privateRecordFor(actor);
      const raceContext = await f.contextFor(actor); await f.identity(raceContext, actor);
      const racePage = await f.ready(raceContext, actor);
      await require('../../../models/AuthSession').updateMany({ userId: actor.id }, { $set: { revokedAt: new Date(), revokedReason: 'Synthetic old-session revocation.' } });
      let first = true, releaseNull; const nullBarrier = new Promise(resolve => { releaseNull = resolve; }); const heldNull = [], actualCurrentReads = [];
      const holdOldNull = async route => {
        const response = await route.fetch(), payload = await response.json();
        actualCurrentReads.push({ status: response.status(), ownerId: payload.user?.id || null });
        if (first) { first = false; heldNull.push({ status: response.status(), user: payload.user }); await nullBarrier; }
        await route.fulfill({ response });
      };
      await raceContext.route(server.origin + me, holdOldNull);
      try {
        await freshRead(racePage);
        await expect.poll(() => heldNull.length).toBe(1); expect(heldNull[0]).toEqual({ status: 200, user: null });
        const oldPublicIdentity = await racePage.evaluate(() => localStorage.getItem('lpc_user'));
        let cookie = latest.cookie;
        if (mode === 'same-owner-new-session') {
          const user = await require('../../../models/User').findById(actor.id).select('+authVersion');
          const session = await require('../../../services/authSessionService').createAuthSession(user, { headers: { 'user-agent': 'Private current-owner recovery fixture' }, ip: '192.0.2.23' });
          const stored = await require('../../../models/AuthSession').findOne({ sessionId: session.sessionId, userId: actor.id }).lean();
          expect(stored.revokedAt).toBeNull(); expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
          cookie = { ...actor.cookie, value: require('jsonwebtoken').sign({ id: actor.id, role: user.role, status: user.status, sid: session.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }) };
        }
        await raceContext.clearCookies(); await raceContext.addCookies([cookie]); const latestUser = await f.identity(raceContext, latest);
        if (mode === 'different-owner') {
          await racePage.evaluate(user => { const oldValue = localStorage.getItem('lpc_user'), value = JSON.stringify({ id: user.id, role: user.role, status: user.status }); localStorage.setItem('lpc_user', value); window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue, newValue: value })); }, latestUser);
        } else {
          expect(await racePage.evaluate(() => localStorage.getItem('lpc_user'))).toBe(oldPublicIdentity);
        }
        const returnedOldRead = racePage.waitForResponse(response => new URL(response.url()).pathname === me);
        releaseNull(); await (await returnedOldRead).finished();
        await racePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (mode === 'same-owner-new-session') {
          await expect(racePage.locator('#recordsBody')).toContainText('Private synthetic Director entry record');
          await expect(racePage.locator('#directorStatus')).toHaveText('');
          expect(actualCurrentReads).toEqual([{ status: 200, ownerId: null }, { status: 200, ownerId: actor.id }]);
        } else {
          await expect(racePage.locator('#directorStatus')).toContainText('signed-in account changed'); await f.noPrivate(racePage);
        }
        expect(new URL(racePage.url()).pathname).toBe('/director-portal.html');
        expect((await racePage.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')))).id).toBe(latest.id);
        f.observations.push({ phase: 'actual-old-null-preserved-latest-session', mode, heldNull, actualCurrentReads, latestOwnerId: latest.id, publicIdentityChanged: mode === 'different-owner', publicIdentityUnchangedBeforeRelease: mode === 'same-owner-new-session', freshManagedSessionIssued: mode === 'same-owner-new-session' });
        await racePage.screenshot({ path: info.outputPath(`old-null-${mode}-preserved.png`) });
      } finally { releaseNull?.(); await raceContext.unroute(server.origin + me, holdOldNull); }
    }
  } finally { release?.(); await f.finish(info); }
});

test('Director portal a held accepted identity cannot bypass the current account version boundary', async ({ browser }, info) => {
  test.setTimeout(90000); const f = await fixture(browser); let release;
  try {
    const context = await f.contextFor(); let holding = true;
    const barrier = new Promise(resolve => { release = resolve; }), held = [];
    await context.route(server.origin + me, async route => {
      const response = await route.fetch(), payload = await response.json(); held.push({ status: response.status(), ownerId: payload.user?.id });
      if (holding) await barrier; await route.fulfill({ response });
    });
    const page = await context.newPage(); await page.goto(server.origin + '/director-portal.html');
    await expect.poll(() => held.length).toBeGreaterThan(0); expect(held[0]).toEqual({ status: 200, ownerId: f.director.id });
    await require('../../../models/User').updateOne({ _id: f.director.id }, { $inc: { authVersion: 1 } });
    const denied = await context.request.get(server.origin + overview + '?expectedOwnerId=' + f.director.id); expect(denied.status()).toBe(403);
    expect((await denied.json()).msg).toBe('Session expired');
    holding = false; release(); await expect(page).toHaveURL(/\/login\.html\?next=/); await f.noPrivate(page);
    expect(await page.evaluate(() => localStorage.getItem('lpc_user'))).toBeNull();
    expect(server.evidence().requests.filter(row => row.path === overview && row.status === 200)).toHaveLength(0);
    f.observations.push({ phase: 'actual-me200-before-version-change-current-overview403', held, actualHandlerStatus: denied.status(), noPrivateRecords: true });
    await page.screenshot({ path: info.outputPath('version-revoked-after-held-me.png') });
  } finally { release?.(); await f.finish(info); }
});
