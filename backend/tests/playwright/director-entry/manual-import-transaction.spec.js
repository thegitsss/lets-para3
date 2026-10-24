const { test, expect, request } = require('playwright/test');
const mongoose = require('mongoose');
const f = require('./manual-import-fixture.cjs');
const Record = require('../../../models/DirectorOutreachRecord'), Event = require('../../../models/DirectorOutreachEvent');
const Profile = require('../../../models/DirectorProfile'), User = require('../../../models/User'), Session = require('../../../models/AuthSession');
let server;
test.beforeAll(async () => {
  test.setTimeout(180000);
  // Deliberately preserve the first-loaded service, then replace the harness
  // capture. The notice checks must observe that actual cached sender.
  const first = await f.start({ includeDirectors: true }); await first.close();
  server = await f.start({ includeDirectors: true });
});
test.beforeEach(async () => { await server.reset(); f.configure(); });
test.afterAll(async () => server?.close());
const sent = '/api/director/import-today', inbox = '/api/director/import-replies';
async function contextFor(actor) {
  return request.newContext({ baseURL: server.origin, storageState: { cookies: [{ name: actor.cookie.name, value: actor.cookie.value,
    domain: new URL(server.origin).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] } });
}
async function post(context, actor, path = sent) {
  const token = await f.csrf(context, server.origin, expect);
  const response = await context.post(path + '?expectedOwnerId=' + actor.id, { data: {}, headers: { 'X-CSRF-Token': token } });
  return { status: response.status(), payload: await response.json() };
}
async function scenario(info, body, { expectedSyntheticNotices = 0 } = {}) {
  const actor = await server.createUser('director'), context = await contextFor(actor), observations = [], restores = [];
  actor.email = (await User.findById(actor.id).lean()).email;
  function replace(object, key, value) { const original = object[key]; object[key] = value; restores.push(() => { object[key] = original; }); return original; }
  try { await body({ actor, context, observations, replace }); }
  finally {
    while (restores.length) restores.pop()();
    observations.push({ phase: 'independent-final-bookkeeping', actual: await f.snapshot(), mailbox: [...f.calls], noticeBinding: server.noticeEvidence(), ...server.evidence() });
    try {
      expect(server.noticeEvidence().actualOwningCaptureCalls).toHaveLength(expectedSyntheticNotices);
      expect(server.evidence().external.storage).toHaveLength(0); expect(server.provider.calls).toHaveLength(0);
      expect(server.evidence().requests.filter(row => !['GET','HEAD','OPTIONS'].includes(row.method) && !(row.method === 'POST' && [sent,inbox].includes(row.path)))).toHaveLength(0);
    } finally {
      await context.dispose();
      await info.attach('director-manual-import-transaction-evidence.json', { body: Buffer.from(JSON.stringify({ observations, apiContextsCreated: 1, apiContextsDisposed: 1, mockNoticeContract: expectedSyntheticNotices, realOutwardTransport: false })), contentType: 'application/json' });
    }
  }
}
function replyMessage(actor) {
  return { subject: 'Re: On-demand paralegal support for your firm', fromAddress: `"Synthetic reply" <import-${actor.id}@example.test>`,
    toAddress: actor.email, receivedTime: new Date().toISOString(), messageId: 'isolated-reply-' + actor.id, summary: 'Synthetic reply for transaction verification.' };
}
async function seedReplyTarget(actor) {
  return Record.create({ directorUserId: actor.id, directorEmail: actor.email, attorneyEmail: 'import-' + actor.id + '@example.test',
    attorneyName: 'Retained synthetic reply target', stage: 'outreach_sent', source: 'portal_send', firstOutreachSentAt: new Date(Date.now() - 10000) });
}

test('a valid empty manual mailbox initializes and saves only authorized success bookkeeping', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    f.configure(async () => []); const before = await f.snapshot(), result = await post(context, actor), after = await f.snapshot();
    observations.push({ phase: 'actual-valid-empty-mailbox', before, result, after });
    expect(result).toMatchObject({ status: 200, payload: { ok: true, ownerId: actor.id, imported: 0, scanned: 0 } });
    expect(after.records).toEqual([]); expect(after.events).toEqual([]); expect(after.profiles).toHaveLength(1); expect(after.profiles[0].zohoLastSyncStatus).toBe('success');
  });
});
test('a revoked account cannot leave a newly initialized profile after a held mailbox read', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    const entered = f.deferred(), gate = f.deferred(); let returned;
    f.configure(async () => { entered.release(); await gate.promise; return [f.sentMessage(actor.id)]; });
    try {
      const before = await f.snapshot(); returned = post(context, actor); await entered.promise;
      expect((await f.snapshot()).profiles).toEqual([]); await f.revoke(actor, 'disabled'); gate.release();
      const result = await returned, after = await f.snapshot(); observations.push({ phase: 'no-pre-mail-profile-upsert', before, result, after });
      expect(result.status).toBe(403); expect(after).toEqual(before);
    } finally { gate.release(); await returned?.catch(() => {}); }
  });
});
test('an exact repeated sent provider event is a no-op rather than another imported event', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    const first = await post(context, actor), before = await f.snapshot(), repeated = await post(context, actor), after = await f.snapshot();
    observations.push({ phase: 'actual-repeated-event-no-op', first, before, repeated, after });
    expect(first.status).toBe(200); expect(first.payload.imported).toBe(1); expect(repeated).toMatchObject({ status: 200, payload: { ownerId: actor.id, imported: 0, scanned: 1 } });
    expect(after.records).toHaveLength(1); expect(after.events).toEqual(before.events);
    expect(after.records[0].firstOutreachSentAt).toBe(before.records[0].firstOutreachSentAt);
  });
});
test('a later imported event failure rolls back every earlier record and event in the batch', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    const original = Event.create.bind(Event); let number = 0;
    replace(Event, 'create', async (...args) => { if (++number === 2) throw Error('Synthetic second event failure'); return original(...args); });
    f.configure(async () => [f.sentMessage(actor.id), { ...f.sentMessage(actor.id), toAddress: 'second-import@example.test', messageId: 'isolated-second-event' }]);
    const before = await f.snapshot(), result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-whole-batch-event-rollback', before, result, after, number });
    expect(result.status).toBe(502); expect(after.records).toEqual(before.records); expect(after.events).toEqual(before.events); expect(after.profiles[0].zohoLastSyncStatus).toBe('failed');
  });
});
test('a refresh write failure rolls back the imported record event and derived cache together', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    await f.review(context, server.origin, actor, expect);
    const existing = await Record.create({ directorUserId: actor.id, directorEmail: actor.email, attorneyEmail: 'earlier@example.test', attorneyName: 'Retained earlier record', stage: 'outreach_sent', source: 'portal_send', metadata: { ownerNote: 'Keep current source' } });
    const before = await f.snapshot(), save = Record.prototype.save; let encountered = false;
    replace(Record.prototype, 'save', async function (...args) { if (String(this._id) === String(existing._id)) { encountered = true; throw Error('Synthetic refresh-cache failure'); } return save.apply(this, args); });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-refresh-and-import-rollback', before, result, after, encountered });
    expect(encountered).toBe(true); expect(result.status).toBe(502); expect(after.records).toEqual(before.records); expect(after.events).toEqual(before.events); expect(after.profiles[0].zohoLastSyncStatus).toBe('failed');
  });
});
test('profile settings and existing record edits made during the mailbox read remain current', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    await f.review(context, server.origin, actor, expect);
    const existing = await Record.create({ directorUserId: actor.id, directorEmail: actor.email, attorneyEmail: 'edited@example.test', attorneyName: 'Existing record', source: 'portal_send', stage: 'suppressed', metadata: { ownerNote: 'Earlier' } });
    f.configure(async () => {
      await Profile.updateOne({ userId: actor.id }, { $set: { notes: 'Latest profile note', displayName: 'Latest chosen display' } });
      await Record.updateOne({ _id: existing._id }, { $set: { attorneyName: 'Latest chosen name', metadata: { ownerNote: 'Latest saved owner fact' } } });
      return [f.sentMessage(actor.id)];
    });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-latest-edit-conservation', result, after });
    expect(result.status).toBe(200); expect(after.profiles[0]).toMatchObject({ notes: 'Latest profile note', displayName: 'Latest chosen display' });
    expect(after.records.find(row => row._id === String(existing._id))).toMatchObject({ attorneyName: 'Latest chosen name', stage: 'suppressed', metadata: { ownerNote: 'Latest saved owner fact' } });
  });
});
test('a changed mailbox profile cannot receive an earlier mailbox result or success stamp', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    await f.review(context, server.origin, actor, expect); let changed;
    f.configure(async () => { await Profile.updateOne({ userId: actor.id }, { $set: { zohoEmail: 'new-mailbox@example.test' } }); changed = await f.snapshot(); return [f.sentMessage(actor.id)]; });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-profile-intent-change', changed, result, after });
    expect(result.status).toBe(409); expect(after).toEqual(changed);
  });
});
test('all manual import initialization record event cache and retained-source operations share the actual transaction session', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    let active; const checks = [], start = mongoose.startSession.bind(mongoose);
    replace(mongoose, 'startSession', async (...args) => { active = await start(...args); return active; });
    for (const Model of [User, Session, Profile, Record, Event, require('../../../models/Case'), require('../../../models/PaymentOperation'), require('../../../models/Payout'), require('../../../models/PlatformIncome')]) {
      for (const method of ['find','findOne','findOneAndUpdate','updateOne','updateMany','insertOne','insertMany']) {
        const original = Model.collection[method]; if (typeof original !== 'function') continue;
        replace(Model.collection, method, function (...args) {
          if (active?.inTransaction()) { const options = args.at(-1); checks.push({ model: Model.modelName, method, sameActualSession: options?.session === active }); }
          return original.apply(this, args);
        });
      }
    }
    const result = await post(context, actor); observations.push({ phase: 'actual-complete-session-propagation', result, checks });
    expect(result.status).toBe(200); expect(checks.length).toBeGreaterThan(15); expect(checks.every(row => row.sameActualSession)).toBe(true);
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'DirectorProfile', method: 'findOneAndUpdate' }), expect.objectContaining({ model: 'DirectorOutreachRecord', method: 'updateOne' }), expect.objectContaining({ model: 'DirectorOutreachEvent', method: 'insertOne' }), expect.objectContaining({ model: 'PaymentOperation', method: 'find' })]));
  });
});
test('a session invalidated within the actual write transaction aborts the protected import', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    await f.review(context, server.origin, actor, expect); const before = await f.snapshot(), original = Event.create.bind(Event); let injected = false;
    replace(Event, 'create', async (...args) => { const saved = await original(...args); if (!injected) { injected = true; await Session.collection.updateMany({ userId: new mongoose.Types.ObjectId(actor.id) }, { $set: { expiresAt: new Date(0) } }, { session: args[1].session }); } return saved; });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-session-final-commit-check', before, result, after, injected });
    expect(injected).toBe(true); expect(result.status).toBe(403); expect(after).toEqual(before);
  });
});
test('an unknown commit preserves accepted records without failed-status overwrite or automatic retry', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    const start = mongoose.startSession.bind(mongoose); let commits = 0;
    replace(mongoose, 'startSession', async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); commits++; throw Object.assign(Error('Synthetic accepted but unknown commit acknowledgement'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' }); }; return session; });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-unknown-commit-conservation', result, after, commits });
    expect(result).toMatchObject({ status: 503, payload: { code: 'ACCOUNT_WRITE_UNCONFIRMED' } }); expect(commits).toBe(1);
    expect(after.records).toHaveLength(1); expect(after.events).toHaveLength(1); expect(after.profiles[0].zohoLastSyncStatus).toBe('success'); expect(f.calls).toHaveLength(1);
  });
});
test('a definite mailbox failure after authority loss cannot overwrite earlier sync bookkeeping', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    await f.review(context, server.origin, actor, expect); const before = await f.snapshot();
    f.configure(async () => { await f.revoke(actor, 'disabled'); throw Error('Synthetic definite mailbox failure'); });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-failure-status-authority-loss', before, result, after });
    expect(result.status).toBe(403); expect(after).toEqual(before); expect(f.calls).toHaveLength(1);
  });
});
test('a Director reclassified during mailbox reading cannot save records or sync bookkeeping', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations }) => {
    await f.review(context, server.origin, actor, expect); const before = await f.snapshot();
    f.configure(async () => { await User.updateOne({ _id: actor.id }, { $set: { role: 'attorney' } }); return [f.sentMessage(actor.id)]; });
    const result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-current-role-loss', before, result, after });
    expect(result.status).toBe(403); expect(after).toEqual(before);
  });
});
test('a duplicate-key event failure aborts the actual batch instead of continuing an aborted transaction', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    const original = Event.create.bind(Event); let duplicateCode;
    replace(Event, 'create', async (...args) => { await original(...args); try { return await original(...args); } catch (error) { duplicateCode = error.code; throw error; } });
    const before = await f.snapshot(), result = await post(context, actor), after = await f.snapshot(); observations.push({ phase: 'actual-duplicate-key-batch-abort', before, result, after, duplicateCode });
    expect(duplicateCode).toBe(11000); expect(result.status).toBe(502); expect(after.records).toEqual(before.records); expect(after.events).toEqual(before.events); expect(after.profiles[0].zohoLastSyncStatus).toBe('failed');
  });
});
test('a committed reply has one synthetic notice after commit and a repeated provider event has none', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    await seedReplyTarget(actor); f.configure(async () => [replyMessage(actor)]);
    const start = mongoose.startSession.bind(mongoose); let committed = false;
    const beforeBinding = server.noticeEvidence();
    expect(beforeBinding.owningSenderId).not.toBe(beforeBinding.activeInstalledSenderId); expect(beforeBinding.serviceCacheStillSameObservedExports).toBe(true);
    const commitCheckpoints = [];
    replace(mongoose, 'startSession', async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => {
      const beforeCommit = server.noticeEvidence(); expect(beforeCommit.actualOwningCaptureCalls).toHaveLength(committed ? 1 : 0);
      commitCheckpoints.push({ phase: 'before-actual-driver-commit', inTransaction: session.inTransaction(), owningNoticeCalls: beforeCommit.actualOwningCaptureCalls.length });
      await commit(); committed = true; const afterCommit = server.noticeEvidence();
      commitCheckpoints.push({ phase: 'after-actual-driver-commit-before-deferred-notice', inTransaction: session.inTransaction(), owningNoticeCalls: afterCommit.actualOwningCaptureCalls.length });
    }; return session; });
    const first = await post(context, actor, inbox), before = await f.snapshot(), repeated = await post(context, actor, inbox), after = await f.snapshot();
    observations.push({ phase: 'actual-reply-commit-and-idempotent-mock-notice', first, before, repeated, after, committed, commitCheckpoints, beforeBinding, afterBinding: server.noticeEvidence(), mockNoticeCalls: server.noticeEvidence().actualOwningCaptureCalls.length, noRealMailTransport: true });
    expect(committed).toBe(true); expect(first).toMatchObject({ status: 200, payload: { imported: 1 } }); expect(repeated).toMatchObject({ status: 200, payload: { imported: 0 } });
    expect(after.events).toEqual(before.events); expect(after.events).toHaveLength(1); expect(after.records[0].stage).toBe('founder_attention');
    expect(commitCheckpoints).toHaveLength(4); expect(commitCheckpoints[0]).toMatchObject({ inTransaction: true, owningNoticeCalls: 0 }); expect(commitCheckpoints[1]).toMatchObject({ inTransaction: false, owningNoticeCalls: 0 });
    expect(server.noticeEvidence().actualOwningCaptureCalls).toHaveLength(1); expect(server.noticeEvidence().activeHarnessCaptureCalls).toHaveLength(0);
  }, { expectedSyntheticNotices: 1 });
});
test('a reply refresh failure rolls back its event and sends no synthetic notice before commit', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    await f.review(context, server.origin, actor, expect); const record = await seedReplyTarget(actor), before = await f.snapshot(), save = Record.prototype.save;
    replace(Record.prototype, 'save', async function (...args) { if (String(this._id) === String(record._id)) throw Error('Synthetic reply refresh failure'); return save.apply(this, args); });
    const beforeBinding = server.noticeEvidence(); expect(beforeBinding.owningSenderId).not.toBe(beforeBinding.activeInstalledSenderId);
    f.configure(async () => [replyMessage(actor)]); const result = await post(context, actor, inbox), after = await f.snapshot(); observations.push({ phase: 'actual-reply-rollback-no-notice', before, result, after, beforeBinding, afterBinding: server.noticeEvidence() });
    expect(result.status).toBe(502); expect(after.records).toEqual(before.records); expect(after.events).toEqual(before.events); expect(after.profiles[0].zohoLastSyncStatus).toBe('failed');
    expect(server.noticeEvidence().actualOwningCaptureCalls).toHaveLength(0); expect(server.noticeEvidence().activeHarnessCaptureCalls).toHaveLength(0);
  });
});
for (const route of [sent, inbox]) test('authority loss after committed ' + route.split('/').pop() + ' is reported as saved work requiring review', async ({}, info) => {
  test.setTimeout(30000); await scenario(info, async ({ actor, context, observations, replace }) => {
    if (route === inbox) { await seedReplyTarget(actor); f.configure(async () => [replyMessage(actor)]); }
    const start = mongoose.startSession.bind(mongoose); let commits = 0;
    replace(mongoose, 'startSession', async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); commits++; await User.updateOne({ _id: actor.id }, { $inc: { authVersion: 1 } }); }; return session; });
    const result = await post(context, actor, route), after = await f.snapshot(); observations.push({ phase: 'actual-committed-work-with-post-commit-authority-loss', route, result, after, commits });
    expect(result).toMatchObject({ status: 403, payload: { code: 'DIRECTOR_IMPORT_SAVED_REVIEW' } }); expect(result.payload.error).toContain('saved');
    expect(commits).toBe(1); expect(after.records).toHaveLength(1); expect(after.events).toHaveLength(1); expect(after.profiles[0].zohoLastSyncStatus).toBe('success'); expect(f.calls).toHaveLength(1);
  });
});
