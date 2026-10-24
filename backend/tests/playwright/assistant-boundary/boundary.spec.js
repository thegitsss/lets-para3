const { expect } = require('playwright/test');
const { test } = require('./shell-fixture');
const { fixture, json, OWNER, OTHER, MATTER } = require('./fixture');
const ACONV = '555555555555555555555555', BCONV = '888888888888888888888888';
const A_PRIVATE = 'Owner A private Assistant guidance', B_PRIVATE = 'Owner B private Assistant guidance';
const message = (text = A_PRIVATE) => ({ id: '777777777777777777777777', sender: 'assistant', text, metadata: {}, createdAt: '2026-09-09T10:00:01.000Z' });
const conversation = id => ({ id, status: 'open', escalation: { requested: false } });
const ui = page => ({ drawer: page.locator('#supportDrawer'), composer: page.locator('[data-support-textarea]'), thread: page.locator('[data-support-thread]') });
async function prepare(page, role, { holdHistory = false, holdJson = false, live = false } = {}) {
  await page.addInitScript(() => window.addEventListener('pagehide', () => { const thread = document.querySelector('[data-support-thread]'); if (thread) sessionStorage.setItem('boundary-departed-state', JSON.stringify({ thread: thread.textContent || '', draft: document.querySelector('[data-support-textarea]')?.value || '', behavior: sessionStorage.getItem('lpc-support-context'), pin: sessionStorage.getItem('lpc_support_drawer_pin') })); }));
  if (holdJson) await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes('/api/support/conversation/') && new URL(String(args[0]), location.origin).pathname.endsWith('/messages') && (args[1]?.method || 'GET') === 'GET' && !window.__assistantHeldOnce) {
        window.__assistantHeldOnce = true; const read = response.json.bind(response);
        response.json = async () => { const payload = await read(); window.__assistantJsonHeld = true; await new Promise(resolve => window.__releaseAssistantJson = resolve); return payload; };
      }
      return response;
    };
  });
  const result = await fixture(page, role);
  if (live) await page.evaluate(() => { window.__boundaryStreams = []; window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; this.closed = false; window.__boundaryStreams.push(this); } close() { this.closed = true; } }; });
  await page.evaluate(owner => sessionStorage.setItem('lpc_support_session_user', owner), OWNER);
  const calls = [], state = { holdHistory, release: null, historyText: null };
  const dto = id => ({ ...conversation(id), escalation: { requested: live } });
  await page.route('**/api/support/**', async route => {
    const req = route.request(), url = new URL(req.url()), currentOwner = result.state.user?.id;
    calls.push({ path: url.pathname, method: req.method(), owner: currentOwner, role: result.state.user?.role, body: req.postData() ? req.postDataJSON() : null });
    if (url.pathname === '/api/support/conversation') return json(route, { ok: true, conversation: dto(currentOwner === OWNER ? ACONV : BCONV) });
    const id = url.pathname.split('/')[4], owner = id === ACONV ? OWNER : OTHER;
    if (currentOwner !== owner) return json(route, { error: 'Conversation not found' }, 404);
    if (url.pathname.endsWith('/messages') && req.method() === 'GET') {
      const responseText = state.historyText || (owner === OWNER ? A_PRIVATE : B_PRIVATE);
      if (state.holdHistory) { state.holdHistory = false; await new Promise(resolve => state.release = resolve); }
      return json(route, { ok: true, conversation: dto(id), messages: [message(responseText)] });
    }
    if (url.pathname.endsWith('/feedback')) return json(route, { ok: true, message: { ...message(), metadata: { feedback: { rating: 'helpful' } } } });
    if (url.pathname.endsWith('/messages') && req.method() === 'POST') return json(route, { ok: true, request: { id: req.postDataJSON().requestId, action: 'send', state: 'succeeded' }, conversation: dto(id), userMessage: { id: '666666666666666666666666', sender: 'user', text: req.postDataJSON().text }, assistantMessage: message() }, 201);
    return json(route, { ok: true });
  });
  const clickOpen = () => page.locator(role === 'attorney' ? '[data-av2-assistant]' : '[data-v2-assistant-trigger]').click();
  const open = async () => { await clickOpen(); await expect(ui(page).thread).toContainText(A_PRIVATE); };
  return { ...result, support: state, calls, open, clickOpen };
}
async function seedPrivateState(page, role) {
  await ui(page).composer.fill('Owner A unsent private draft');
  await page.evaluate(async ({ role, owner, matter }) => {
    const context = await import('/assets/scripts/utils/support-workspace-context.mjs');
    const address = { pathname: `/${role}-v2.html`, hash: role === 'attorney' ? `#/matters/${matter}/overview` : `#/matter/${matter}` };
    window.__boundaryContext = { ownerId: owner, role, location: address };
    context.setSupportMatterContext({ ownerId: owner, role, matterId: matter, routeMatterId: matter, currentTab: 'overview', availableMatterTabs: ['overview'], location: address });
    sessionStorage.setItem('lpc-support-context', JSON.stringify({ views: [{ viewName: 'case-detail', at: Date.now() }], opens: [] }));
    sessionStorage.setItem('lpc_support_drawer_pin', JSON.stringify({ userId: owner, pinned: true }));
  }, { role, owner: OWNER, matter: MATTER });
}
async function snapshot(page) {
  for (let attempt = 0; attempt < 4; attempt++) try { return await page.evaluate(async () => {
    const context = await import('/assets/scripts/utils/support-workspace-context.mjs');
    return { departed: JSON.parse(sessionStorage.getItem('boundary-departed-state') || 'null'), url: location.href, storedUser: JSON.parse(localStorage.getItem('lpc_user') || 'null'), thread: document.querySelector('[data-support-thread]')?.textContent || '', draft: document.querySelector('[data-support-textarea]')?.value || '', drawerHidden: document.querySelector('#supportDrawer')?.getAttribute('aria-hidden') !== 'false', matterContext: window.__boundaryContext ? context.getSupportMatterContext(window.__boundaryContext) : null, behavior: sessionStorage.getItem('lpc-support-context'), pin: sessionStorage.getItem('lpc_support_drawer_pin'), legacyRefreshSessionPresent: typeof window.refreshSession === 'function' };
  }); } catch (error) { if (attempt === 3 || !/Execution context was destroyed|Cannot find context/.test(error.message)) throw error; await page.waitForLoadState('domcontentloaded'); }
}
async function record(page, testInfo, run) {
  const value = { ...(await snapshot(page)), supportCalls: run.calls, authCalls: run.state.calls.filter(call => call.path === '/api/auth/me'), serverUser: run.state.user };
  if (value.departed) { expect(value.departed.thread).not.toContain(A_PRIVATE); expect(value.departed.draft).toBe(''); expect(value.departed.behavior).toBeNull(); expect(value.departed.pin).toBeNull(); }
  await testInfo.attach('account-boundary-observation', { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' });
  return value;
}
async function waitForEffect(page, run, initialCalls) {
  await expect.poll(async () => (await snapshot(page)).drawerHidden || run.calls.length > initialCalls).toBe(true);
}
const replaced = user => ({ ...user, id: OTHER, _id: OTHER, firstName: 'Replacement' });

for (const role of ['attorney', 'paralegal']) {
  test(`${role}: silent cookie replacement before conversation GET cannot display replacement history in the old shell`, async ({ page }, info) => {
    const run = await prepare(page, role); const authBefore = run.state.calls.filter(call => call.path === '/api/auth/me').length; run.state.user = replaced(run.state.user); await run.clickOpen();
    await expect.poll(() => run.calls.length > 0 || run.state.calls.filter(call => call.path === '/api/auth/me').length > authBefore).toBe(true);
    await expect.poll(async () => { const s = await snapshot(page); return s.drawerHidden || s.thread.includes(B_PRIVATE); }).toBe(true);
    const s = await record(page, info, run); expect(s.thread).not.toContain(B_PRIVATE); expect(s.drawerHidden).toBe(true);
  });
  for (const action of ['send', 'feedback']) test(`${role}: silent cookie replacement prevents stale ${action} dispatch and clears private state`, async ({ page }, info) => {
    const run = await prepare(page, role); await run.open(); await seedPrivateState(page, role);
    run.state.user = replaced(run.state.user); const before = run.calls.length;
    if (action === 'send') await ui(page).composer.press('Enter'); else await page.getByRole('button', { name: 'Helpful', exact: true }).click();
    await waitForEffect(page, run, before); const s = await record(page, info, run);
    expect(run.calls.filter(call => call.method === 'POST')).toEqual([]);
    expect(s.thread).not.toContain(A_PRIVATE); expect(s.draft).toBe(''); expect(s.matterContext).toBeNull(); expect(s.behavior).toBeNull(); expect(s.pin).toBeNull();
  });
  test(`${role}: access revoked during a held history read discards the previously authorized response`, async ({ page }, info) => {
    const run = await prepare(page, role, { holdHistory: true }); await run.clickOpen();
    await expect.poll(() => Boolean(run.support.release)).toBe(true);
    run.state.user = { ...run.state.user, status: 'disabled' }; run.support.release();
    await expect.poll(async () => { const s = await snapshot(page); return s.drawerHidden || s.thread.includes(A_PRIVATE); }).toBe(true);
    const s = await record(page, info, run); expect(s.thread).not.toContain(A_PRIVATE); expect(s.drawerHidden).toBe(true);
  });
  test(`${role}: replacement after response headers but before JSON cannot publish stale history`, async ({ page }, info) => {
    const run = await prepare(page, role, { holdJson: true }); await run.clickOpen();
    await expect.poll(() => page.evaluate(() => Boolean(window.__assistantJsonHeld))).toBe(true);
    run.state.user = replaced(run.state.user); await page.evaluate(() => window.__releaseAssistantJson());
    await expect.poll(async () => { const s = await snapshot(page); return s.drawerHidden || s.thread.includes(A_PRIVATE); }).toBe(true);
    const s = await record(page, info, run); expect(s.thread).not.toContain(A_PRIVATE); expect(s.drawerHidden).toBe(true);
  });
  test(`${role}: a silent same-ID role swap cannot send using the old role context`, async ({ page }, info) => {
    const run = await prepare(page, role); await run.open(); await seedPrivateState(page, role);
    run.state.user = { ...run.state.user, role: role === 'attorney' ? 'paralegal' : 'attorney' }; const before = run.calls.length;
    await ui(page).composer.press('Enter'); await waitForEffect(page, run, before); const s = await record(page, info, run);
    expect(run.calls.filter(call => call.method === 'POST')).toEqual([]); expect(s.thread).not.toContain(A_PRIVATE); expect(s.draft).toBe(''); expect(s.matterContext).toBeNull();
  });
  test(`${role}: explicit identity clear during held JSON already cancels late rendering`, async ({ page }, info) => {
    const run = await prepare(page, role, { holdJson: true }); await run.clickOpen();
    await expect.poll(() => page.evaluate(() => Boolean(window.__assistantJsonHeld))).toBe(true);
    await page.evaluate(async () => { const drawer = await import('/assets/scripts/utils/support-drawer.js'); drawer.clearSupportIdentity(); window.__releaseAssistantJson(); });
    await expect(ui(page).drawer).toHaveAttribute('aria-hidden', 'true'); const s = await record(page, info, run);
    expect(s.thread).not.toContain(A_PRIVATE); expect(s.draft).toBe(''); expect(s.matterContext).toBeNull();
  });
}

for (const role of ['attorney', 'paralegal']) {
 test(`${role}: same-owner successful send and feedback retain guarded request bindings`, async ({ page }, info) => {
  const run = await prepare(page, role); await run.open(); await ui(page).composer.fill('Synthetic guarded question'); await ui(page).composer.press('Enter');
  await expect(ui(page).thread).toContainText('Synthetic guarded question'); await page.getByRole('button', { name: 'Helpful', exact: true }).last().click();
  await expect.poll(() => run.calls.filter(call => call.method === 'POST').length).toBe(2);
  for (const call of run.calls.filter(call => call.method === 'POST')) { expect(call.body.expectedOwnerId).toBe(OWNER); expect(call.body.expectedRole).toBe(role); }
  expect((await snapshot(page)).drawerHidden).toBe(false); await record(page, info, run);
 });
 test(`${role}: same-owner streamed read deadline retains draft and recovers on the next verified hint`, async ({ page }, info) => {
  const run = await prepare(page, role, { live: true }); await run.open(); await seedPrivateState(page, role);
  await expect.poll(() => page.evaluate(() => window.__boundaryStreams.length)).toBe(1);
  expect(await page.evaluate(() => new URL(window.__boundaryStreams[0].url, location.origin).searchParams.get('expectedOwnerId'))).toBe(OWNER);
  await page.clock.install(); run.support.holdHistory = true; run.support.historyText = 'Late expired history must be ignored';
  const hint = () => page.evaluate(() => window.__boundaryStreams[0].dispatchEvent(new MessageEvent('conversation.updated', { data: JSON.stringify({ text: 'Untrusted streamed text must not render' }) })));
  await hint(); await expect.poll(() => Boolean(run.support.release)).toBe(true); await page.clock.runFor(31000);
  expect(run.calls.filter(call => call.method === 'POST')).toEqual([]); expect(run.calls.filter(call => call.path.endsWith('/messages')).length).toBe(2);
  await expect(ui(page).composer).toHaveValue('Owner A unsent private draft'); await expect(ui(page).thread).toContainText(A_PRIVATE); await expect(ui(page).thread).not.toContainText('Untrusted streamed text');
  run.support.historyText = 'Confirmed recovered history'; run.support.release(); await page.clock.runFor(50); await expect(ui(page).thread).not.toContainText('Late expired history');
  await hint(); await expect(ui(page).thread).toContainText('Confirmed recovered history'); await expect(ui(page).composer).toHaveValue('Owner A unsent private draft'); await record(page, info, run);
 });
}
for (const role of ['attorney', 'paralegal']) {
 test(`${role}: stream error immediately verifies access loss and clears old private state`, async ({ page }, info) => {
  const run = await prepare(page, role, { live: true }); await run.open(); await seedPrivateState(page, role); await page.clock.install();
  const before = run.state.calls.filter(call => call.path === '/api/auth/me').length; run.state.user = replaced(run.state.user);
  await page.evaluate(() => window.__boundaryStreams[0].onerror(new Event('error')));
  await expect.poll(() => run.state.calls.filter(call => call.path === '/api/auth/me').length).toBeGreaterThan(before);
  await expect.poll(async () => (await snapshot(page)).drawerHidden).toBe(true); const value = await record(page, info, run);
  expect(value.thread).not.toContain(A_PRIVATE); expect(value.draft).toBe(''); expect(value.matterContext).toBeNull(); expect(run.calls.filter(call => call.method === 'POST')).toEqual([]);
 });
 test(`${role}: stream error with same-owner unavailable verification keeps the draft and verified recovery`, async ({ page }, info) => {
  const run = await prepare(page, role, { live: true }); await run.open(); await seedPrivateState(page, role); await page.clock.install();
  const before = run.state.calls.filter(call => call.path === '/api/auth/me').length; run.state.authRespond = route => json(route, { error: 'Synthetic verification unavailable' }, 503);
  await page.evaluate(() => window.__boundaryStreams[0].onerror(new Event('error'))); await page.clock.runFor(15001);
  await expect.poll(() => run.state.calls.filter(call => call.path === '/api/auth/me').length).toBeGreaterThan(before);
  await expect(ui(page).composer).toHaveValue('Owner A unsent private draft'); await expect(ui(page).thread).toContainText(A_PRIVATE); expect((await snapshot(page)).drawerHidden).toBe(false); expect(await page.evaluate(() => window.__boundaryStreams.length)).toBe(1); expect(run.state.calls.filter(call => call.path === '/api/auth/me').length - before).toBeLessThanOrEqual(3);
  run.state.authRespond = null; run.support.historyText = 'Recovered after stream interruption'; const connected = await page.evaluate(() => { const source = window.__boundaryStreams.at(-1); if (source.closed) return false; source.dispatchEvent(new MessageEvent('conversation.updated', { data: '{}' })); return true; }); if (!connected) await page.clock.runFor(15001);
  await expect(ui(page).thread).toContainText('Recovered after stream interruption'); await expect(ui(page).composer).toHaveValue('Owner A unsent private draft');
  expect(run.calls.filter(call => call.method === 'POST')).toEqual([]); await record(page, info, run);
 });
}
