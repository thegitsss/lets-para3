const { test, expect } = require('playwright/test');
const f = require('./manual-import-fixture.cjs');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await f.start({ includeDirectors: true }); });
test.beforeEach(async () => { await server.reset(); f.configure(); });
test.afterAll(async () => server?.close());
const sentPath = '/api/director/import-today', repliesPath = '/api/director/import-replies';

// secureFetch can retry one explicit CSRF rejection after a cookie changes.
// An intermediate CSRF403 is not proof that the account-intent writer denied
// the reviewed owner. Preserve that response and observe the final attempt.
function finalImportResponse(page, path, observations) {
  let attempts = 0;
  return page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== path || response.request().method() !== 'POST') return false;
    const attempt = ++attempts, payload = await response.json().catch(() => ({}));
    observations.push({ phase: 'actual-native-import-http-attempt', path, url: response.url(), attempt,
      status: response.status(), code: payload.code || null, explicitCsrfRejection: response.status() === 403 && payload.code === 'CSRF_INVALID' });
    return !(attempt === 1 && response.status() === 403 && payload.code === 'CSRF_INVALID');
  });
}

async function fixture(browser) {
  const actor = await server.createUser('director'), contexts = [], observations = [], errors = [];
  const User = require('../../../models/User'), Record = require('../../../models/DirectorOutreachRecord');
  const stored = await User.findById(actor.id).select('+authVersion').lean();
  const reviewed = await Record.create({ directorUserId: actor.id, directorEmail: stored.email,
    attorneyEmail: 'reviewed-local@example.test', attorneyName: 'Reviewed synthetic Director record', source: 'portal_send',
    firstOutreachSentAt: new Date(), stage: 'outreach_sent', metadata: { diagnostic: 'retain existing record' } });
  async function contextFor(owner = actor) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); contexts.push(context);
    await context.addCookies([owner.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  }
  async function ready(context) {
    await f.review(context.request, server.origin, actor, expect);
    const page = await context.newPage(); await page.goto(server.origin + '/director-portal.html');
    await expect(page.getByRole('heading', { name: 'Director Portal', exact: true })).toBeVisible();
    await expect(page.locator('#recordsBody')).toContainText(reviewed.attorneyName);
    await expect(page.getByRole('button', { name: 'Sync Zoho', exact: true })).toBeVisible();
    const publicCache = await page.evaluate(() => localStorage.getItem('lpc_user'));
    expect(JSON.parse(publicCache).id).toBe(actor.id);
    const response = await context.request.get(server.origin + '/api/director/records?expectedOwnerId=' + actor.id);
    expect(response.status()).toBe(200); const payload = await response.json();
    expect(payload.ownerId).toBe(actor.id); expect(payload.records.some(row => row.id === String(reviewed._id))).toBe(true);
    observations.push({ phase: 'actual-reviewed-owner-before-native-sync', ownerId: actor.id, ownedRecordId: String(reviewed._id), actualRecordIds: payload.records.map(row => row.id), publicCache });
    return { page, publicCache };
  }
  async function finish(info) {
    const actual = await f.snapshot(); observations.push({ phase: 'independent-final-bookkeeping', actual, transport: [...f.calls] });
    const evidence = server.evidence();
    const forbidden = evidence.requests.filter(row => !['GET','HEAD','OPTIONS'].includes(row.method) &&
      !(row.method === 'POST' && [sentPath,repliesPath].includes(row.path)) &&
      !(row.method === 'POST' && row.path === '/api/auth/passkeys/authentication-options' && row.status === 200));
    try {
      expect(evidence.external.mail).toHaveLength(0); expect(evidence.external.storage).toHaveLength(0);
      expect(server.provider.calls).toHaveLength(0); expect(forbidden).toHaveLength(0);
    } finally {
      let contextsClosed = 0;
      for (const context of contexts) { await context.close(); contextsClosed++; }
      await info.attach('director-manual-import-owner-evidence.json', { body: Buffer.from(JSON.stringify({ observations, errors, contextsCreated: contexts.length, contextsClosed, capturedThroughNormalContextClose: true, transport: f.calls, forbiddenMutations: forbidden, ...evidence })), contentType: 'application/json' });
      expect(errors).toEqual([]);
    }
  }
  return { actor, contextFor, ready, finish, observations };
}

test('native Sync Zoho cannot import a silently switched managed account from the previously reviewed Director page', async ({ browser }, info) => {
  test.setTimeout(90000); const x = await fixture(browser);
  try {
    const newer = await server.createUser('director'), context = await x.contextFor(), other = await x.contextFor(newer);
    await f.review(other.request, server.origin, newer, expect); const { page, publicCache } = await x.ready(context);
    const before = await f.snapshot(); await context.clearCookies(); await context.addCookies([newer.cookie]);
    await f.current(context.request, server.origin, newer, expect);
    expect(await page.evaluate(() => localStorage.getItem('lpc_user'))).toBe(publicCache);
    const returned = finalImportResponse(page, sentPath, x.observations);
    await page.getByRole('button', { name: 'Sync Zoho', exact: true }).click(); const response = await returned; await response.finished();
    const after = await f.snapshot(); x.observations.push({ phase: 'actual-native-stale-owner-response', reviewedOwner: x.actor.id, currentOwner: newer.id,
      url: response.url(), status: response.status(), payload: await response.json(), before, after, transport: [...f.calls] });
    await page.screenshot({ path: info.outputPath('native-stale-reviewed-owner.png') });
    expect(response.status()).toBe(403); expect((await response.json()).code).not.toBe('CSRF_INVALID');
    expect(f.calls).toHaveLength(0); expect(after).toEqual(before);
  } finally { await x.finish(info); }
});

test('native Sync Zoho cannot commit an import after actual access revocation while its synthetic mailbox read is held', async ({ browser }, info) => {
  test.setTimeout(90000); const x = await fixture(browser), entered = f.deferred(), gate = f.deferred(); let returned;
  f.configure(async input => { entered.release(); await gate.promise; return input.folderKind === 'sent' ? [f.sentMessage(x.actor.id)] : []; });
  try {
    const context = await x.contextFor(), { page } = await x.ready(context), before = await f.snapshot();
    returned = finalImportResponse(page, sentPath, x.observations);
    await page.getByRole('button', { name: 'Sync Zoho', exact: true }).click(); await entered.promise;
    await f.revoke(x.actor, 'auth-version');
    const denied = await context.request.get(server.origin + '/api/director/overview?expectedOwnerId=' + x.actor.id);
    expect(denied.status()).toBe(403); x.observations.push({ phase: 'actual-version-revoked-during-mailbox-read', status: denied.status(), payload: await denied.json() });
    gate.release(); const response = await returned; await response.finished(); const after = await f.snapshot();
    x.observations.push({ phase: 'actual-native-revoked-import-response', url: response.url(), status: response.status(), payload: await response.json(), before, after, transport: [...f.calls] });
    await page.screenshot({ path: info.outputPath('native-revoked-during-mailbox-read.png') });
    expect(response.status()).toBe(403); expect((await response.json()).code).not.toBe('CSRF_INVALID'); expect(after).toEqual(before);
  } finally { gate.release(); if (returned) await returned.catch(() => {}); await x.finish(info); }
});

test('native Sync Zoho preserves its accepted sent-mail record without continuing into a newer managed account inbox', async ({ browser }, info) => {
  test.setTimeout(90000); const x = await fixture(browser), gate = f.deferred(); let held = false, returned;
  try {
    const newer = await server.createUser('director'), context = await x.contextFor(), other = await x.contextFor(newer);
    await f.review(other.request, server.origin, newer, expect); const { page, publicCache } = await x.ready(context);
    await page.route('**/api/director/import-today*', async route => {
      const response = await route.fetch(); const payload = await response.json();
      x.observations.push({ phase: 'actual-accepted-sent-return-held-before-client-continuation', status: response.status(), payload, url: route.request().url() });
      held = true; await gate.promise; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Sync Zoho', exact: true }).click(); await expect.poll(() => held).toBe(true);
    const acceptedSent = await f.snapshot();
    expect(acceptedSent.records.filter(row => row.directorUserId === x.actor.id && row.source === 'zoho_import')).toHaveLength(1);
    expect(acceptedSent.events.filter(row => row.directorUserId === x.actor.id && row.eventType === 'outreach_sent')).toHaveLength(1);
    await context.clearCookies(); await context.addCookies([newer.cookie]); await f.current(context.request, server.origin, newer, expect);
    expect(await page.evaluate(() => localStorage.getItem('lpc_user'))).toBe(publicCache);
    returned = finalImportResponse(page, repliesPath, x.observations);
    gate.release(); const response = await returned; await response.finished(); const after = await f.snapshot();
    x.observations.push({ phase: 'actual-newer-cookie-chained-replies-response', reviewedOwner: x.actor.id, currentOwner: newer.id,
      url: response.url(), status: response.status(), payload: await response.json(), acceptedSent, after, transport: [...f.calls] });
    await page.screenshot({ path: info.outputPath('native-chained-replies-owner-change.png') });
    expect(response.status()).toBe(403); expect((await response.json()).code).not.toBe('CSRF_INVALID'); expect(after).toEqual(acceptedSent);
    expect(f.calls.map(row => ({ ownerId: row.ownerId, folderKind: row.folderKind }))).toEqual([{ ownerId: x.actor.id, folderKind: 'sent' }]);
  } finally { gate.release(); if (returned) await returned.catch(() => {}); await x.finish(info); }
});

async function captureResult(page, info, observations, label, expected, recoveryRequired = false) {
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#directorStatus').scrollIntoViewIfNeeded();
    if (recoveryRequired) await page.getByRole('button', { name: 'Refresh records', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.locator('#directorStatus')).toHaveText(expected);
    if (recoveryRequired) await expect(page.getByRole('button', { name: 'Refresh records', exact: true })).toBeVisible();
    const actual = await page.evaluate(() => {
      const status = document.getElementById('directorStatus'), refresh = document.getElementById('retryDirectorBtn');
      const text = document.createRange(); text.selectNodeContents(status);
      const lines = [...text.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
      const rect = refresh.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { width: innerWidth, text: status.textContent, lines, refreshHit: refresh === hit || refresh.contains(hit) };
    });
    observations.push({ phase: 'native-result-visibility', label, ...actual });
    expect(actual.lines.length).toBeGreaterThan(0); expect(actual.lines.every(line => line.left >= 0 && line.right <= width && line.top >= 0 && line.bottom <= 900)).toBe(true); if (recoveryRequired) expect(actual.refreshHit).toBe(true);
    await page.screenshot({ path: info.outputPath(label + '-' + width + '.png') });
  }
}

test('native Sync Zoho treats a valid empty mailbox as verified success without inventing imported records', async ({ browser }, info) => {
  test.setTimeout(90000); const x = await fixture(browser); f.configure(async () => []);
  try {
    const context = await x.contextFor(), { page } = await x.ready(context), before = await f.snapshot();
    const sent = finalImportResponse(page, sentPath, x.observations), replies = finalImportResponse(page, repliesPath, x.observations);
    await page.getByRole('button', { name: 'Sync Zoho', exact: true }).click();
    const first = await sent, second = await replies; await second.finished();
    expect(first.status()).toBe(200); expect(second.status()).toBe(200);
    await captureResult(page, info, x.observations, 'native-valid-empty-result', 'Sync complete: 0 sent messages imported.');
    const after = await f.snapshot(); x.observations.push({ phase: 'actual-native-empty-result', first: await first.json(), second: await second.json(), before, after });
    expect(after.events).toEqual(before.events); expect(after.records.map(row => row._id)).toEqual(before.records.map(row => row._id));
    expect(after.profiles.find(row => row.ownerId === x.actor.id).zohoLastSyncStatus).toBe('success');
    expect(f.calls.map(row => ({ ownerId: row.ownerId, folderKind: row.folderKind }))).toEqual([{ ownerId: x.actor.id, folderKind: 'sent' }, { ownerId: x.actor.id, folderKind: 'inbox' }]);
  } finally { await x.finish(info); }
});
test('native Sync Zoho truthfully retains accepted sent work when reply import fails without retrying or claiming full completion', async ({ browser }, info) => {
  test.setTimeout(90000); const x = await fixture(browser);
  f.configure(async input => { if (input.folderKind === 'inbox') throw Error('Synthetic definite reply transport failure'); return [f.sentMessage(x.actor.id)]; });
  try {
    const context = await x.contextFor(), { page } = await x.ready(context);
    const sent = finalImportResponse(page, sentPath, x.observations), replies = finalImportResponse(page, repliesPath, x.observations);
    await page.getByRole('button', { name: 'Sync Zoho', exact: true }).click();
    const first = await sent, second = await replies; await second.finished(); expect(first.status()).toBe(200); expect(second.status()).toBe(502);
    await captureResult(page, info, x.observations, 'native-partial-import-result', 'Sent mail imported. Reply checking was not completed. Refresh and review before syncing again.', true);
    const after = await f.snapshot(); x.observations.push({ phase: 'actual-native-accepted-sent-with-reply-failure', first: await first.json(), second: await second.json(), after });
    expect(after.events).toHaveLength(1); expect(after.events[0]).toMatchObject({ directorUserId: x.actor.id, eventType: 'outreach_sent' });
    expect(after.records.filter(row => row.directorUserId === x.actor.id && row.source === 'zoho_import')).toHaveLength(1);
    expect(after.profiles.find(row => row.ownerId === x.actor.id).zohoLastSyncStatus).toBe('failed'); expect(f.calls).toHaveLength(2);
  } finally { await x.finish(info); }
});
