const { test, expect, request } = require('playwright/test');
const f = require('./manual-import-fixture.cjs');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await f.start({ includeDirectors: true }); });
test.beforeEach(async () => { await server.reset(); f.configure(); });
test.afterAll(async () => server?.close());
const routes = ['/api/director/import-today', '/api/director/import-replies'];
async function contextFor(actor) {
  return request.newContext({ baseURL: server.origin, storageState: { cookies: [{
    name: actor.cookie.name, value: actor.cookie.value, domain: new URL(server.origin).hostname,
    path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
  }], origins: [] } });
}
async function finish(info, contexts, observations) {
  try {
    observations.push({ phase: 'independent-final-bookkeeping', actual: await f.snapshot(), transport: [...f.calls], ...server.evidence() });
    expect(server.evidence().external.mail).toHaveLength(0); expect(server.evidence().external.storage).toHaveLength(0);
    const permitted = routes;
    expect(server.evidence().requests.filter(row => !['GET','HEAD','OPTIONS'].includes(row.method) && !(row.method === 'POST' && permitted.includes(row.path)))).toHaveLength(0);
    expect(server.provider.calls).toHaveLength(0);
  } finally {
    let apiContextsDisposed = 0;
    for (const context of contexts) { await context.dispose(); apiContextsDisposed++; }
    await info.attach('director-manual-import-handler-evidence.json', { body: Buffer.from(JSON.stringify({ observations, apiContextsCreated: contexts.length, apiContextsDisposed, transport: f.calls, ...server.evidence() })), contentType: 'application/json' });
  }
}

test('current reviewed Director imports synthetic sent mail and reads back its exact record event and sync status', async ({}, info) => {
  test.setTimeout(30000); const actor = await server.createUser('director'), context = await contextFor(actor), observations = [];
  try {
    await f.review(context, server.origin, actor, expect); const before = await f.snapshot();
    const token = await f.csrf(context, server.origin, expect);
    for (const route of routes) {
      const response = await context.post(route + '?expectedOwnerId=' + actor.id, { data: {}, headers: { 'X-CSRF-Token': token } });
      observations.push({ phase: 'actual-response', route, status: response.status(), payload: await response.json() });
      expect(response.status()).toBe(200);
    }
    const after = await f.snapshot(); observations.push({ phase: 'independent-bookkeeping', before, after });
    expect(after.records).toHaveLength(1); expect(after.events).toHaveLength(1);
    expect(after.records[0].directorUserId).toBe(actor.id); expect(after.records[0].source).toBe('zoho_import');
    expect(after.events[0].directorUserId).toBe(actor.id); expect(after.events[0].eventType).toBe('outreach_sent');
    expect(after.events[0].providerMessageId).toBe('isolated-sent-' + actor.id);
    expect(after.profiles.find(row => row.ownerId === actor.id).zohoLastSyncStatus).toBe('success');
    expect(f.calls.map(row => ({ ownerId: row.ownerId, folderKind: row.folderKind }))).toEqual([{ ownerId: actor.id, folderKind: 'sent' }, { ownerId: actor.id, folderKind: 'inbox' }]);
  } finally { await finish(info, [context], observations); }
});

for (const route of routes) {
  test(`manual ${route.split('/').pop()} rejects a different managed cookie from the reviewed expected owner before reading either mailbox`, async ({}, info) => {
    test.setTimeout(30000); const intended = await server.createUser('director'), newer = await server.createUser('director');
    const original = await contextFor(intended), changed = await contextFor(newer), observations = [];
    try {
      await f.review(original, server.origin, intended, expect); await f.review(changed, server.origin, newer, expect);
      const before = await f.snapshot(), token = await f.csrf(changed, server.origin, expect);
      const response = await changed.post(route + '?expectedOwnerId=' + intended.id, { data: {}, headers: { 'X-CSRF-Token': token } });
      const after = await f.snapshot(); observations.push({ phase: 'stale-reviewed-owner', intendedOwner: intended.id, currentOwner: newer.id,
        route, status: response.status(), payload: await response.json(), before, after, transport: [...f.calls] });
      expect(response.status()).toBe(403); expect(f.calls).toHaveLength(0); expect(after).toEqual(before);
    } finally { await finish(info, [original, changed], observations); }
  });
  for (const kind of ['disabled', 'auth-version', 'managed-session']) {
    test(`manual ${route.split('/').pop()} cannot commit records events or sync bookkeeping after ${kind} revocation during the mailbox read`, async ({}, info) => {
      test.setTimeout(30000); const actor = await server.createUser('director'), context = await contextFor(actor), observations = [];
      const entered = f.deferred(), gate = f.deferred(); let responsePromise;
      f.configure(async input => { entered.release(); await gate.promise; return input.folderKind === 'sent' ? [f.sentMessage(actor.id)] : []; });
      try {
        await f.review(context, server.origin, actor, expect); const before = await f.snapshot(), token = await f.csrf(context, server.origin, expect);
        responsePromise = context.post(route + '?expectedOwnerId=' + actor.id, { data: {}, headers: { 'X-CSRF-Token': token } });
        await entered.promise; await f.revoke(actor, kind);
        const denied = await context.get('/api/director/overview?expectedOwnerId=' + actor.id); expect(denied.status()).toBe(403);
        observations.push({ phase: 'actual-revoked-read', kind, status: denied.status(), payload: await denied.json() });
        gate.release(); const response = await responsePromise, after = await f.snapshot();
        observations.push({ phase: 'revoked-import-return', kind, route, status: response.status(), payload: await response.json(), before, after, transport: [...f.calls] });
        expect(response.status()).toBe(403); expect(after).toEqual(before);
      } finally { gate.release(); if (responsePromise) await responsePromise.catch(() => {}); await finish(info, [context], observations); }
    });
  }
}
