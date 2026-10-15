const path = require('node:path');
let createDirectorManualImport;
beforeAll(async () => { ({ createDirectorManualImport } = await import(path.resolve(__dirname, '../../frontend/assets/scripts/utils/director-manual-import.mjs'))); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (ownerId, imported = 1, scanned = 1, status = 200, extra = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ ok: status === 200, ownerId, imported, scanned, ...extra }) });
function fixture() {
  const ownerId = 'a'.repeat(24), urls = [], statuses = [], discarded = [], reloaded = [];
  let active = true, publicOwner = ownerId, current;
  const account = { ownerId, verify(payload) { if (publicOwner !== ownerId || payload && payload.ownerId !== ownerId) throw new Error('The signed-in account changed.'); }, url(value) { this.verify(); return value + '?expectedOwnerId=' + ownerId; } };
  current = account;
  const f = { ownerId, account, urls, statuses, discarded, reloaded, handler: async () => response(ownerId),
    switchOwner() { publicOwner = 'b'.repeat(24); }, replaceAccount() { current = { ownerId: 'b'.repeat(24) }; }, leave() { active = false; }, noAccount() { current = null; },
    reloadResult: true };
  f.flow = createDirectorManualImport({ getAccount: () => current, isCurrent: value => active && value === current,
    request: async url => { urls.push(url); return f.handler(url, urls.length); },
    reload: async value => { reloaded.push(value); return f.reloadResult; },
    setStatus: (text, options) => statuses.push({ text, ...options }), onDiscard: value => discarded.push(value) });
  return f;
}
const success = f => f.statuses.filter(value => value.tone === 'success');

test('a normal sync pins both mailbox requests and verified readback to the one reviewed owner', async () => {
  const f = fixture(); expect((await f.flow.sync()).ok).toBe(true);
  expect(f.urls).toEqual(['/api/director/import-today?expectedOwnerId=' + f.ownerId, '/api/director/import-replies?expectedOwnerId=' + f.ownerId]);
  expect(f.reloaded).toEqual([f.account]); expect(success(f)[0].text).toBe('Sync complete: 1 sent message imported.');
});
test('a valid empty mailbox remains a verified zero-count success', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 0, 0);
  expect((await f.flow.sync()).ok).toBe(true); expect(success(f)[0].text).toBe('Sync complete: 0 sent messages imported.');
});
test('a denied first import never calls the inbox or readback and never reports completion', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 0, 0, 403, { error: 'Access revoked.' });
  expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(1); expect(f.reloaded).toEqual([]); expect(success(f)).toEqual([]); expect(f.statuses.at(-1).text).toBe('Access revoked.');
});
test.each([403, 503])('a known saved import requiring review at HTTP %s is never described as unsaved or automatically retried', async status => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 0, 0, status, { code: 'DIRECTOR_IMPORT_SAVED_REVIEW' });
  expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(1); expect(f.reloaded).toEqual([]); expect(success(f)).toEqual([]);
  expect(f.statuses.at(-1)).toMatchObject({ tone: 'error', text: 'The import was saved. Sign in and review your records before syncing again.' });
  expect(f.discarded).toEqual(status === 403 ? [f.account] : []);
});
test('a final import denial invalidates the old reviewed view while preserving truthful recovery status', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 0, 0, 403, { error: 'Current Director access is unavailable.' });
  await f.flow.sync(); expect(f.discarded).toEqual([f.account]); expect(f.statuses.at(-1).text).toBe('Current Director access is unavailable.'); expect(f.urls).toHaveLength(1);
});
test('a service outage leaves current account authority unchanged and never initiates signout or a retry', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 0, 0, 503); await f.flow.sync();
  expect(f.discarded).toEqual([]); expect(f.urls).toHaveLength(1); expect(f.statuses.at(-1).tone).toBe('error'); expect(success(f)).toEqual([]);
});
test('a failed inbox step retains the acknowledged sent result without full-sync success or resending', async () => {
  const f = fixture(); f.handler = async (_url, number) => response(f.ownerId, 1, 1, number === 1 ? 200 : 502);
  expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(2); expect(f.reloaded).toEqual([]); expect(success(f)).toEqual([]); expect(f.statuses.at(-1).text).toContain('Sent mail imported. Reply checking was not completed.');
});
test('a lost first response is left for review without an automatic second request', async () => {
  const f = fixture(); f.handler = async () => { throw new Error('Connection lost.'); };
  expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(1); expect(success(f)).toEqual([]);
});
test('an owner switch while the first response is held prevents the chained request', async () => {
  const f = fixture(), gate = deferred(); f.handler = async () => { await gate.promise; return response(f.ownerId); };
  const returned = f.flow.sync(); f.switchOwner(); gate.resolve(); expect((await returned).discarded).toBe(true); expect(f.urls).toHaveLength(1); expect(f.discarded).toEqual([f.account]); expect(success(f)).toEqual([]);
});
test('a replaced account does not receive an earlier account completion or readback', async () => {
  const f = fixture(), gate = deferred(); f.handler = async () => { await gate.promise; return response(f.ownerId); };
  const returned = f.flow.sync(); f.replaceAccount(); gate.resolve(); expect((await returned).discarded).toBe(true); expect(f.reloaded).toEqual([]); expect(success(f)).toEqual([]);
});
test('a newer manual intent owns result status and discards the late earlier acknowledgement', async () => {
  const f = fixture(), gate = deferred(); f.handler = async (_url, number) => { if (number === 1) await gate.promise; return response(f.ownerId); };
  const older = f.flow.sync(); expect((await f.flow.replies()).ok).toBe(true); const count = f.statuses.length; gate.resolve(); expect((await older).discarded).toBe(true); expect(f.statuses).toHaveLength(count); expect(success(f).at(-1).text).toBe('Replies flagged: 1'); expect(f.urls).toHaveLength(2);
});
test('owner loss while replies are held cannot turn earlier sent acceptance into another owner completion', async () => {
  const f = fixture(), entered = deferred(), gate = deferred(); f.handler = async (_url, number) => { if (number === 2) { entered.resolve(); await gate.promise; } return response(f.ownerId); };
  const returned = f.flow.sync(); await entered.promise; f.switchOwner(); gate.resolve(); expect((await returned).discarded).toBe(true); expect(f.urls).toHaveLength(2); expect(f.reloaded).toEqual([]); expect(success(f)).toEqual([]);
});
test('successful imports with a failed current-record readback report saved but unverified records', async () => {
  const f = fixture(); f.reloadResult = false; expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(2); expect(success(f)).toEqual([]); expect(f.statuses.at(-1).text).toContain('Mailbox import saved. Current records could not be refreshed.');
});
test('an import response belonging to another owner is never used for a completion claim', async () => {
  const f = fixture(); f.handler = async () => response('b'.repeat(24)); expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(1); expect(success(f)).toEqual([]);
});
test.each([['string count', '1', 1], ['negative count', -1, 1], ['missing scanned', 1, undefined], ['unsafe count', Number.MAX_SAFE_INTEGER + 1, 1]])('a %s is unverified rather than invented as zero or successful', async (_label, imported, scanned) => {
  const f = fixture(); f.handler = async () => response(f.ownerId, imported, 1, 200, { scanned }); expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toHaveLength(1); expect(success(f)).toEqual([]); expect(f.statuses.at(-1).text).toContain('could not be verified');
});
test('a successful HTTP status without the accepted operation outcome is not completion', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 1, 1, 200, { ok: false }); expect((await f.flow.sync()).ok).toBe(false); expect(success(f)).toEqual([]); expect(f.urls).toHaveLength(1);
});
test('missing authoritative page account cannot issue a mailbox request', async () => {
  const f = fixture(); f.noAccount(); expect((await f.flow.sync()).ok).toBe(false); expect(f.urls).toEqual([]); expect(success(f)).toEqual([]);
});
test('a leaving document discards its response before chained work or status', async () => {
  const f = fixture(), gate = deferred(); f.handler = async () => { await gate.promise; return response(f.ownerId); };
  const returned = f.flow.sync(); f.leave(); gate.resolve(); expect((await returned).discarded).toBe(true); expect(f.urls).toHaveLength(1); expect(f.reloaded).toEqual([]); expect(success(f)).toEqual([]);
});
test('standalone reply checking uses the same owner boundary and truthful count', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 2, 2); expect((await f.flow.replies()).ok).toBe(true); expect(f.urls).toEqual(['/api/director/import-replies?expectedOwnerId=' + f.ownerId]); expect(success(f)[0].text).toBe('Replies flagged: 2');
});
test('silent reply failure returns an explicit failed result and retains recovery status', async () => {
  const f = fixture(); f.handler = async () => response(f.ownerId, 0, 0, 502); expect((await f.flow.replies({ silent: true, reload: false })).ok).toBe(false); expect(success(f)).toEqual([]); expect(f.statuses.at(-1).tone).toBe('error');
});
