const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const observe = promise => promise.then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', message: error.message }));

function handlerSource(source, signature, nextSignature) {
  const start = source.indexOf(signature), end = source.indexOf(nextSignature, start);
  if (start < 0 || end <= start) throw new Error(`Current handler boundaries were not found: ${signature}`);
  return source.slice(start, end);
}

// Exercise the current dashboard's real handler without starting its unrelated
// page bootstrap. Browser acceptance also drives its confirmation and menu.
function harness(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/assets/scripts/attorney-tabs.js'), 'utf8');
  const ownerId = 'a'.repeat(24);
  const mocks = {
    state: { user: { id: ownerId } }, pendingMatterDeletions: new Set(),
    getCaseEntryById: jest.fn(id => ({ id, title: 'Synthetic archived Matter' })),
    currentMatterInventory: {}, currentDraftInventory: {},
    verifyCaseNoteOwner: jest.fn(async () => ownerId),
    confirmAction: jest.fn(async () => true),
    secureFetch: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    loadCurrentMatters: jest.fn(async () => {}), loadCaseDrafts: jest.fn(async () => {}), removeCaseFromState: jest.fn(), notifyCases: jest.fn(),
    ...overrides,
  };
  const context = vm.createContext(mocks);
  vm.runInContext(handlerSource(source, 'async function deleteArchivedCase(', '\nfunction removeCaseFromState('), context);
  return { ...mocks, run: context.deleteArchivedCase };
}
const caseId = 'b'.repeat(24);
const response = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

describe('Current Matter deletion acknowledgement', () => {
  test.each([403, 404, 409, 503])('HTTP %s never triggers a second deletion or removes the row', async status => {
    const h = harness({ secureFetch: jest.fn(async () => response(status, { error: 'Deletion denied' })) });
    await expect(h.run(caseId)).rejects.toThrow();
    expect(h.secureFetch).toHaveBeenCalledTimes(1);
    expect(h.loadCurrentMatters).not.toHaveBeenCalled(); expect(h.loadCaseDrafts).not.toHaveBeenCalled(); expect(h.removeCaseFromState).not.toHaveBeenCalled(); expect(h.notifyCases).not.toHaveBeenCalled();
  });
  test.each([null, {}, { ok: false }, { success: true }])('an incomplete success body %j stays unconfirmed', async payload => {
    const h = harness({ secureFetch: jest.fn(async () => response(200, payload)) });
    await expect(h.run(caseId)).rejects.toThrow(/not confirmed/);
    expect(h.secureFetch).toHaveBeenCalledTimes(1); expect(h.removeCaseFromState).not.toHaveBeenCalled(); expect(h.notifyCases).not.toHaveBeenCalled();
  });
  test('unreadable and lost responses remain unconfirmed', async () => {
    for (const secureFetch of [async () => ({ ok: true, status: 200, json: async () => { throw Error('JSON failed'); } }), async () => { throw Error('Network lost'); }]) {
      const h = harness({ secureFetch: jest.fn(secureFetch) }); await expect(h.run(caseId)).rejects.toThrow(/not confirmed/);
      expect(h.secureFetch).toHaveBeenCalledTimes(1); expect(h.removeCaseFromState).not.toHaveBeenCalled();
    }
  });
  test.each([200, 204])('a verified HTTP %s removes the row once after confirmation', async status => {
    const h = harness({ secureFetch: jest.fn(async () => response(status, { ok: true })) }); await h.run(caseId);
    expect(h.confirmAction).toHaveBeenCalledTimes(1); expect(h.secureFetch).toHaveBeenCalledTimes(1);
    expect(h.confirmAction).toHaveBeenCalledWith('Permanently remove “Synthetic archived Matter”? This cannot be undone.', expect.objectContaining({ confirmLabel: 'Delete Matter' }));
    expect(h.secureFetch).toHaveBeenCalledWith(`/api/cases/${caseId}`, expect.objectContaining({ body: { expectedOwnerId: 'a'.repeat(24) } }));
    expect(h.removeCaseFromState).toHaveBeenCalledWith(caseId); expect(h.notifyCases).toHaveBeenCalledWith('Matter deleted.', 'success');
    expect(h.loadCurrentMatters).toHaveBeenCalledWith({ force: true }); expect(h.loadCaseDrafts).toHaveBeenCalledWith({ force: true });
  });
  test('cancelling sends no request', async () => {
    const h = harness({ confirmAction: jest.fn(async () => false) }); await h.run(caseId); expect(h.secureFetch).not.toHaveBeenCalled();
  });
  test('a second invocation while confirming cannot start another confirmation or write', async () => {
    let release; const h = harness({ confirmAction: jest.fn(() => new Promise(resolve => { release = resolve; })) });
    const first = observe(h.run(caseId)); await expect(h.run(caseId)).rejects.toThrow(/already/); release(true); expect(await first).toEqual({ status: 'fulfilled' });
    expect(h.confirmAction).toHaveBeenCalledTimes(1); expect(h.secureFetch).toHaveBeenCalledTimes(1);
  });
  test('a failed request releases the guard for a separately confirmed attempt', async () => {
    const h = harness({ secureFetch: jest.fn().mockResolvedValueOnce(response(503, {})).mockResolvedValueOnce(response(200, { ok: true })) });
    await expect(h.run(caseId)).rejects.toThrow(); await h.run(caseId);
    expect(h.confirmAction).toHaveBeenCalledTimes(2); expect(h.secureFetch).toHaveBeenCalledTimes(2); expect(h.removeCaseFromState).toHaveBeenCalledTimes(1);
  });
  test('an account change during confirmation prevents the write', async () => {
    const h = harness({ verifyCaseNoteOwner: jest.fn(async () => 'c'.repeat(24)) });
    await expect(h.run(caseId)).rejects.toThrow(); expect(h.secureFetch).not.toHaveBeenCalled(); expect(h.removeCaseFromState).not.toHaveBeenCalled();
  });
  test('an account change during the response cannot announce private success', async () => {
    const h = harness({ verifyCaseNoteOwner: jest.fn().mockResolvedValueOnce('a'.repeat(24)).mockResolvedValueOnce('c'.repeat(24)) });
    await expect(h.run(caseId)).rejects.toThrow(); expect(h.secureFetch).toHaveBeenCalledTimes(1); expect(h.removeCaseFromState).not.toHaveBeenCalled(); expect(h.notifyCases).not.toHaveBeenCalled();
  });
});

describe('Current draft deletion acknowledgement', () => {
  function draftHarness(overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../frontend/assets/scripts/attorney-tabs.js'), 'utf8');
    const state = { user: { id: 'a'.repeat(24) }, localDrafts: [{ id: caseId, revision: 'a'.repeat(64) }] };
    const mocks = { state, readLocalDrafts: () => state.localDrafts, pendingDraftDeletions: new Set(), confirmAction: jest.fn(async () => true), verifyCaseNoteOwner: jest.fn(async () => 'a'.repeat(24)), secureFetch: jest.fn(async () => response(200, { success: true })), loadCaseDrafts: jest.fn(async () => {}), ...overrides };
    const context = vm.createContext(mocks); vm.runInContext(handlerSource(source, 'async function removeLocalDraft(', '\nfunction pruneDraftSelection('), context); return { ...mocks, run: context.removeLocalDraft };
  }
  test.each([{}, null, { success: false }, { ok: true }])('malformed success %j cannot remove the draft', async payload => {
    const h = draftHarness({ secureFetch: jest.fn(async () => response(200, payload)) });
    await expect(h.run(caseId)).rejects.toThrow(/not confirmed/); expect(h.state.localDrafts).toHaveLength(1); expect(h.secureFetch).toHaveBeenCalledTimes(1); expect(h.loadCaseDrafts).not.toHaveBeenCalled();
  });
  test('a confirmed removal carries the exact revision and refreshes the owned draft inventory', async () => {
    const h = draftHarness(); await h.run(caseId); expect(h.loadCaseDrafts).toHaveBeenCalledTimes(1); expect(h.loadCaseDrafts).toHaveBeenCalledWith({ force: true });
    expect(h.secureFetch).toHaveBeenCalledWith(`/api/case-drafts/${caseId}`, expect.objectContaining({ method: 'DELETE', body: { revision: 'a'.repeat(64), expectedOwnerId: 'a'.repeat(24) } }));
  });
  test('cancelling the draft confirmation sends no request and preserves the draft', async () => {
    const h = draftHarness({ confirmAction: jest.fn(async () => false) }); await h.run(caseId); expect(h.secureFetch).not.toHaveBeenCalled(); expect(h.state.localDrafts).toHaveLength(1);
  });
  test('a lost acknowledgement keeps the draft and never repeats deletion', async () => {
    const h = draftHarness({ secureFetch: jest.fn(async () => { throw Error('Lost'); }) });
    await expect(h.run(caseId)).rejects.toThrow(/not confirmed/); expect(h.state.localDrafts).toHaveLength(1); expect(h.secureFetch).toHaveBeenCalledTimes(1);
  });
  test('an account change before or after deletion cannot remove a cached draft', async () => {
    for (const after of [false, true]) {
      const verify = jest.fn(); if (after) verify.mockResolvedValueOnce('a'.repeat(24)); verify.mockResolvedValue('c'.repeat(24));
      const h = draftHarness({ verifyCaseNoteOwner: verify }); await expect(h.run(caseId)).rejects.toThrow(); expect(h.state.localDrafts).toHaveLength(1); expect(h.secureFetch).toHaveBeenCalledTimes(after ? 1 : 0);
    }
  });
  test('a second invocation while the request is pending cannot delete again', async () => {
    let release, arrived; const pending = new Promise(resolve => { arrived = resolve; });
    const h = draftHarness({ secureFetch: jest.fn(() => { arrived(); return new Promise(resolve => { release = resolve; }); }) });
    const first = observe(h.run(caseId)); expect(await Promise.race([pending.then(() => 'request_pending'), first])).toBe('request_pending'); await expect(h.run(caseId)).rejects.toThrow(/already/); release(response(200, { success: true })); expect(await first).toEqual({ status: 'fulfilled' }); expect(h.secureFetch).toHaveBeenCalledTimes(1);
  });
});
