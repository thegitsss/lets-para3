const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { buildMatterExperience } = require('../../../services/matterExperience');
const id = n => n.toString(16).padStart(24, '0');
const ATTORNEY = id(9001), PARALEGAL = id(9002);
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function install(page, role, { bare = false } = {}) {
  const ownerId = role === 'attorney' ? ATTORNEY : PARALEGAL;
  const profile = { id: ownerId, _id: ownerId, role, status: 'approved', emailVerified: true, email: `${role}@example.test`, firstName: 'Jordan', lastName: 'Quinn', preferences: { theme: 'light', fontSize: 'md' }, onboarding: { attorneyTourCompleted: true, paralegalTourCompleted: true } };
  const cases = Array.from({ length: 203 }, (_, n) => ({
    _id: id(n + 1), id: id(n + 1), title: `Matter ${String(n + 1).padStart(3, '0')}`,
    attorney: { _id: ATTORNEY, firstName: 'Dana', lastName: 'Morgan' }, attorneyId: ATTORNEY,
    paralegal: { _id: PARALEGAL, firstName: 'Priya', lastName: 'Ng' }, paralegalId: PARALEGAL,
    status: 'in progress', archived: false, paymentReleased: false, escrowStatus: 'funded', escrowIntentId: `pi_synthetic_${n}`,
    fundingIntegrityStatus: 'verified', totalAmount: 60000, lockedTotalAmount: 60000, remainingAmount: 60000, currency: 'usd',
    practiceArea: 'Contract Law', state: 'NY', details: `Private synthetic instructions for Matter ${n + 1}.`, deadlineDate: '2026-10-01',
    tasks: [], files: [], applicants: [], invites: [], disputes: [], withdrawalHistory: [], hiredAt: '2026-09-01T12:00:00Z',
  }));
  cases[202].title = 'Older estate (NY) [A] — Amélie’s multijurisdictional document review and inherited estate administration';
  const state = { user: profile, cases, choiceQueries: [], reads: [], writes: [], messages: new Map(), files: new Map(), failChoices: false, badOwner: false, choiceDelay: null, send: null, upload: null };
  const present = record => ({ ...record, matterExperience: buildMatterExperience(record, { viewer: profile, acl: { isAttorney: role === 'attorney', isParalegal: role === 'paralegal' } }) });
  await page.addInitScript(user => { localStorage.setItem('lpc_user', JSON.stringify(user)); window.EventSource = class extends EventTarget { close() {} }; }, profile);
  const saveMessage = route => {
    const body = route.request().postDataJSON(), caseId = new URL(route.request().url()).pathname.split('/').pop();
    const messages = state.messages.get(caseId) || [];
    let message = messages.find(row => row.clientMessageId === body.clientMessageId);
    if (!message) { message = { _id: id(50000 + state.writes.length), caseId, senderId: ownerId, senderRole: role, text: body.text, content: body.text, clientMessageId: body.clientMessageId, createdAt: new Date().toISOString(), type: 'text' }; messages.push(message); state.messages.set(caseId, messages); }
    return { message };
  };
  const saveUpload = route => {
    const body = route.request().postDataBuffer().toString(), caseId = new URL(route.request().url()).pathname.split('/').pop();
    const requestId = body.match(/name="clientUploadId"\r\n\r\n([^\r]+)/)?.[1]; expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    const files = state.files.get(caseId) || [];
    let file = files.find(row => row.clientUploadId === requestId);
    if (!file) { file = { id: id(70000 + state.writes.length), caseId, clientUploadId: requestId, filename: 'synthetic-note.txt', originalName: 'synthetic-note.txt', mimeType: 'text/plain', size: 12, uploadedByRole: role, status: 'submitted', securityStatus: 'pending', createdAt: new Date().toISOString() }; files.push(file); state.files.set(caseId, files); }
    return { file };
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (method === 'GET') state.reads.push(path); else state.writes.push({ path, method, owner: request.headers()['x-lpc-owner-id'], data: request.postData() });
    if (path === '/api/auth/me') return json(route, { user: state.user });
    if (path === '/api/users/me') return json(route, state.user);
    if (path === '/api/csrf') return json(route, { csrfToken: 'private-synthetic-csrf' });
    if (path === '/api/cases/workspace-choices') {
      expect(url.searchParams.get('expectedOwnerId')).toBe(ownerId);
      const search = (url.searchParams.get('q') || '').trim(), pageNumber = Number(url.searchParams.get('page') || 1);
      state.choiceQueries.push({ search, page: pageNumber });
      if (state.choiceDelay) await state.choiceDelay(search);
      if (state.failChoices) return json(route, { error: 'Synthetic unavailable inventory' }, 503);
      const all = state.cases.filter(row => row.title.toLowerCase().includes(search.toLowerCase()));
      return json(route, { ownerId: state.badOwner ? id(9999) : ownerId, revision: 'a'.repeat(64), filters: { search, page: pageNumber, selectedId: '' }, total: all.length, page: pageNumber, pages: Math.max(1, Math.ceil(all.length / 10)), pageSize: 10, selected: null, items: all.slice((pageNumber - 1) * 10, pageNumber * 10).map(row => ({ id: row.id, title: row.title, status: row.status, archived: false, practiceArea: row.practiceArea })) });
    }
    const caseMatch = path.match(/^\/api\/cases\/([a-f0-9]{24})$/);
    if (caseMatch) {
      if (url.searchParams.get('expectedOwnerId') !== state.user.id) return json(route, { code: 'ACCOUNT_CHANGED' }, 403);
      const record = state.cases.find(row => row.id === caseMatch[1]);
      return json(route, record ? present(record) : {}, record ? 200 : 404);
    }
    const messages = path.match(/^\/api\/messages\/([a-f0-9]{24})$/);
    if (messages) {
      if (method === 'GET') return json(route, { messages: state.messages.get(messages[1]) || [] });
      expect(request.headers()['x-lpc-owner-id']).toBe(ownerId);
      if (state.user.id !== ownerId) return json(route, { code: 'ACCOUNT_CHANGED', error: 'The signed-in account changed.' }, 403);
      return state.send ? state.send(route, () => saveMessage(route)) : json(route, saveMessage(route), 201);
    }
    const uploads = path.match(/^\/api\/uploads\/case\/([a-f0-9]{24})$/);
    if (uploads) {
      if (method === 'GET') return json(route, { files: state.files.get(uploads[1]) || [] });
      expect(request.headers()['x-lpc-owner-id']).toBe(ownerId);
      return state.upload ? state.upload(route, () => saveUpload(route)) : json(route, saveUpload(route), 201);
    }
    if (path.includes('unread-count')) return json(route, { count: 0 });
    if (path === '/api/notifications/page') return json(route, { items: [], nextCursor: null, hasMore: false });
    if (path === '/api/account/preferences') return json(route, profile.preferences);
    if (path === '/api/cases/my') return json(route, cases.slice(0, 100));
    return json(route, { items: [], messages: [], files: [], events: [], total: 0, count: 0, ok: true });
  });
  await page.goto('/case-detail.html' + (bare ? '' : `?caseId=${cases[0].id}&tab=overview`));
  if (!bare) await expect(page.locator('#caseTitle')).toHaveText(cases[0].title);
  const opener = () => page.getByRole('button', { name: bare ? 'Choose a Matter' : 'Switch Matter', exact: true });
  const dialog = () => page.getByRole('dialog', { name: 'Choose a Matter', exact: true });
  const open = async () => { await page.getByRole('button', { name: /^(Switch Matter|Choose a Matter)$/ }).click(); await expect(dialog()).toHaveAttribute('data-state', 'ready'); };
  const choose = async term => { await open(); await dialog().getByLabel('Search Matters', { exact: true }).fill(term); await expect(dialog().locator('.matter-switch-matter-choice')).toHaveCount(1); await dialog().locator('.matter-switch-matter-choice').click(); };
  const composer = async () => { await page.getByRole('tab', { name: 'Messages', exact: true }).click(); await expect(page.locator('#caseMessageInput')).toBeEnabled(); };
  return { state, ownerId, opener, dialog, open, choose, composer, present };
}

for (const role of ['attorney', 'paralegal']) {
  test(`${role}: complete choices preserve exact navigation, title and history`, async ({ page }) => {
    const view = await install(page, role); await view.open();
    await expect(view.dialog()).toContainText('203 Matters · Page 1 of 21');
    await expect(view.dialog().getByRole('button', { name: 'Retry search', includeHidden: true })).toBeHidden();
    await expect(view.dialog().getByRole('button', { name: 'Matter 001 Current Matter · Contract Law', exact: true })).toBeDisabled();
    await view.dialog().getByRole('button', { name: 'Next Matters', exact: true }).click(); await expect(view.dialog()).toContainText('Page 2 of 21'); await expect(view.dialog().getByRole('status')).toBeFocused();
    await view.dialog().getByLabel('Search Matters', { exact: true }).fill('(NY) [A]'); await expect(view.dialog().locator('.matter-switch-matter-choice')).toHaveCount(1); await view.dialog().locator('.matter-switch-matter-choice').click();
    await expect(page).toHaveURL(new RegExp(`caseId=${id(203)}&tab=overview`)); await expect(page.locator('#caseTitle')).toHaveText(view.state.cases[202].title);
    await expect(page.locator('#caseTitle')).toBeFocused();
    await page.goBack(); await expect(page.locator('#caseTitle')).toHaveText('Matter 001'); expect(view.state.reads.filter(path => path === '/api/cases/my')).toEqual([]);
    const nav = page.getByRole('navigation', { name: role === 'attorney' ? 'Attorney navigation' : 'Paralegal navigation', exact: true });
    await expect(nav.getByRole('link', { name: role === 'attorney' ? 'Matters' : 'My Matters', exact: true })).toHaveAttribute('href', `dashboard-${role}.html#cases`);
    await expect(nav.getByRole('link', { name: role === 'attorney' ? 'Matters' : 'My Matters', exact: true })).not.toHaveAttribute('aria-expanded');
  });

  test(`${role}: unavailable and invalid choices recover without false empty work`, async ({ page }) => {
    const view = await install(page, role); view.state.failChoices = true; await view.opener().click(); await expect(view.dialog()).toHaveAttribute('data-state', 'error'); await expect(view.dialog()).not.toContainText('No current Matters');
    view.state.failChoices = false; view.state.badOwner = true; await view.dialog().getByRole('button', { name: 'Retry search' }).click(); await expect(view.dialog()).toHaveAttribute('data-state', 'error');
    view.state.badOwner = false; await view.dialog().getByRole('button', { name: 'Retry search' }).click(); await expect(view.dialog()).toHaveAttribute('data-state', 'ready');
    await expect(view.dialog().getByRole('button', { name: 'Retry search', includeHidden: true })).toBeHidden();
    await view.dialog().getByLabel('Search Matters', { exact: true }).fill('not present'); await expect(view.dialog()).toContainText('No Matters match this search.'); await page.keyboard.press('Escape'); await expect(view.opener()).toBeFocused(); await expect(page.locator('#caseTitle')).toHaveText('Matter 001');
  });

  test(`${role}: stale searches and restored pages cannot revive a departed chooser`, async ({ page }) => {
    const view = await install(page, role); let release; const gate = new Promise(resolve => { release = resolve; }); view.state.choiceDelay = search => search === 'old' ? gate : Promise.resolve();
    await view.open(); await view.dialog().getByLabel('Search Matters', { exact: true }).fill('old'); await expect.poll(() => view.state.choiceQueries.some(query => query.search === 'old')).toBe(true);
    await view.dialog().getByLabel('Search Matters', { exact: true }).fill('Matter 002'); await page.keyboard.press('Enter'); await expect(view.dialog().locator('.matter-switch-matter-choice')).toHaveCount(1); release(); await expect(view.dialog()).toContainText('Matter 002');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await expect(page.locator('.matter-switch-matter-choice-dialog')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await view.open(); await expect(view.dialog()).toContainText('203 Matters'); await page.keyboard.press('Escape'); await expect(view.opener()).toBeFocused();
  });

  test(`${role}: a bare workspace asks for a Matter and distinguishes verified empty choices`, async ({ page }) => {
    const view = await install(page, role, { bare: true }); await expect(view.dialog()).toHaveAttribute('data-state', 'ready'); await expect(page.locator('.matter-stage')).toBeHidden();
    await page.keyboard.press('Escape'); view.state.cases = []; await view.open(); await expect(view.dialog()).toContainText('No current Matters are available.'); await page.keyboard.press('Escape'); await expect(page.locator('#caseTitle')).toHaveText('Your Matters');
  });

  test(`${role}: unsent text and files stay with their Matter through switching and refresh`, async ({ page }) => {
    const view = await install(page, role); await view.composer(); await page.locator('#caseMessageInput').fill('Draft intended only for Matter 001'); await page.locator('#message-attachment').setInputFiles({ name: 'synthetic-note.txt', mimeType: 'text/plain', buffer: Buffer.from('private test') });
    await view.choose('Matter 002'); await view.composer(); await expect(page.locator('#caseMessageInput')).toHaveValue(''); await expect(page.locator('#caseAttachmentStaging')).toBeHidden(); await page.locator('#caseMessageInput').fill('Separate Matter 002 draft');
    expect(await page.locator('#message-attachment').evaluate(input => input.files.length)).toBe(0);
    await page.goBack(); await expect(page).toHaveURL(new RegExp(`caseId=${id(2)}&tab=overview`));
    await page.goBack(); await expect(page.locator('#caseTitle')).toHaveText('Matter 001'); await view.composer(); await expect(page.locator('#caseMessageInput')).toHaveValue('Draft intended only for Matter 001'); await expect(page.locator('#caseAttachmentStaging')).toContainText('synthetic-note.txt');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await expect(page.locator('#caseMessageInput')).toHaveValue('Draft intended only for Matter 001'); await expect(page.locator('#caseAttachmentStaging')).toContainText('synthetic-note.txt');
  });

  test(`${role}: a pending send cannot erase another Matter draft and an unreadable receipt retries the same request`, async ({ page }) => {
    const view = await install(page, role); let release; view.state.send = async (route, save) => { const receipt = save(); await new Promise(resolve => { release = resolve; }); return json(route, receipt, 201); };
    await view.composer(); await page.locator('#caseMessageInput').fill('First Matter message'); await page.locator('#caseMessageForm button[type=submit]').click(); await expect.poll(() => !!release).toBe(true);
    await view.choose('Matter 002'); await view.composer(); await page.locator('#caseMessageInput').fill('Keep the second Matter draft'); release(); await expect(page.locator('#caseMessageInput')).toHaveValue('Keep the second Matter draft');
    await view.choose('Matter 001'); await view.composer(); await expect(page.locator('#caseMessageInput')).toHaveValue('');
    view.state.send = (route, save) => { save(); return json(route, {}); }; await page.locator('#caseMessageInput').fill('Recover this committed message'); await page.locator('#caseMessageForm button[type=submit]').click(); await expect(page.locator('#caseMessageStatus')).toContainText('could not be confirmed'); await expect(page.locator('#caseMessageInput')).toHaveValue('Recover this committed message');
    view.state.send = null; await page.locator('#caseMessageForm button[type=submit]').click(); await expect(page.locator('#caseMessageInput')).toHaveValue(''); expect(view.state.messages.get(id(1))).toHaveLength(2);
    const writes = view.state.writes.filter(row => row.path === `/api/messages/${id(1)}`).map(row => JSON.parse(row.data)); expect(writes[1].clientMessageId).toBe(writes[2].clientMessageId);
  });

  test(`${role}: an unconfirmed upload preserves its file and retries the recorded upload`, async ({ page }) => {
    const view = await install(page, role); view.state.upload = (route, save) => { save(); return json(route, {}); }; await view.composer(); await page.locator('#message-attachment').setInputFiles({ name: 'synthetic-note.txt', mimeType: 'text/plain', buffer: Buffer.from('private test') });
    await page.locator('#caseMessageForm button[type=submit]').click(); await expect(page.locator('#caseMessageStatus')).toContainText('could not be confirmed'); await expect(page.locator('#caseAttachmentStaging')).toContainText('synthetic-note.txt');
    view.state.upload = null; await page.locator('#caseMessageForm button[type=submit]').click(); await expect(page.locator('#caseAttachmentStaging')).toBeHidden(); expect(view.state.files.get(id(1))).toHaveLength(1);
  });

  test(`${role}: a server account replacement clears the private workspace instead of sending as that account`, async ({ page }) => {
    const view = await install(page, role); await view.composer(); await page.locator('#caseMessageInput').fill('Do not send under another account'); view.state.user = { ...view.state.user, id: id(9999), _id: id(9999) };
    await page.locator('#caseMessageForm button[type=submit]').click(); await expect(page.getByRole('button', { name: 'Reload workspace', exact: true })).toBeVisible(); await expect(page.locator('.matter-stage')).toBeHidden(); await expect(page.locator('#caseMessageInput')).toHaveCount(0); expect(view.state.messages.size).toBe(0);
  });

  test(`${role}: switching never presents the previous Matter during a pending or failed detail read`, async ({ page }) => {
    const view = await install(page, role); let release, requested = false; const gate = new Promise(resolve => { release = resolve; }); let fail = true;
    await page.route(url => url.pathname === `/api/cases/${id(2)}`, async route => { requested = true; await gate; return json(route, fail ? { error: 'Synthetic temporary read failure' } : view.present(view.state.cases[1]), fail ? 503 : 200); });
    await view.choose('Matter 002'); await expect.poll(() => requested).toBe(true); await expect(page.locator('#caseTitle')).toHaveText('Loading Matter…'); await expect(page.locator('.matter-stage')).toBeHidden();
    release(); await expect(page.locator('#caseTitle')).toHaveText('Matter unavailable'); await expect(page.locator('#matterLoadState')).toContainText('Synthetic temporary read failure'); await expect(page.locator('.matter-stage')).toBeHidden();
    fail = false; await page.locator('#matterLoadRetry').click(); await expect(page.locator('#caseTitle')).toHaveText('Matter 002'); await expect(page.locator('.matter-stage')).toBeVisible(); await expect(page.locator('#matterLoadState')).toBeHidden();
  });

  test(`${role}: superseded and departed Matter reads abort and cannot restore stale work`, async ({ page }) => {
    const view = await install(page, role);
    await page.evaluate(caseId => {
      const fetch = window.fetch; window.workspaceReadAborts = 0;
      window.fetch = function(input, options) {
        if (String(input?.url || input).includes(`/api/cases/${caseId}?`)) options?.signal?.addEventListener('abort', () => window.workspaceReadAborts++, { once: true });
        return fetch.apply(this, arguments);
      };
    }, id(2));
    const pending = []; let reads = 0;
    await page.route(url => url.pathname === `/api/cases/${id(2)}`, async route => {
      if (++reads <= 2) await new Promise(resolve => pending.push(resolve));
      return json(route, view.present(view.state.cases[1]));
    });
    await view.choose('Matter 002'); await expect.poll(() => pending.length).toBe(1);
    await view.choose('Matter 003'); await expect(page.locator('#caseTitle')).toHaveText('Matter 003');
    await expect.poll(() => page.evaluate(() => window.workspaceReadAborts)).toBe(1);
    pending[0](); await expect(page.locator('#caseTitle')).toHaveText('Matter 003');
    await view.choose('Matter 002'); await expect.poll(() => pending.length).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect.poll(() => page.evaluate(() => window.workspaceReadAborts)).toBe(2);
    pending[1](); await expect(page.locator('.matter-stage')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#caseTitle')).toHaveText('Matter 002'); await expect(page.locator('.matter-stage')).toBeVisible(); expect(reads).toBe(3);
  });

  test(`${role}: a stalled Matter read offers a bounded retry and rejects a changed account`, async ({ page }) => {
    const view = await install(page, role); await page.clock.install();
    let release, reads = 0;
    await page.route(url => url.pathname === `/api/cases/${id(2)}`, async route => {
      if (++reads === 1) { await new Promise(resolve => { release = resolve; }); return json(route, view.present(view.state.cases[1])); }
      return route.fallback();
    });
    await view.choose('Matter 002'); await expect.poll(() => !!release).toBe(true); await page.clock.fastForward(31000);
    await expect(page.locator('#matterLoadState')).toContainText('taking too long'); await expect(page.locator('.matter-stage')).toBeHidden();
    release(); await page.locator('#matterLoadRetry').click(); await expect(page.locator('#caseTitle')).toHaveText('Matter 002');
    view.state.user = { ...view.state.user, id: id(9999), _id: id(9999) };
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.getByRole('button', { name: 'Reload workspace', exact: true })).toBeVisible(); await expect(page.locator('.matter-stage')).toBeEmpty();
  });

  test(`${role}: the Matter title and chooser remain readable on mobile, dark and enlarged screens`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message)); const view = await install(page, role); await view.choose('(NY) [A]');
    for (const [width, theme, scale] of [[1440, 'light', 1], [390, 'light', 1], [390, 'dark', 1], [320, 'dark', 2]]) {
      await page.setViewportSize({ width, height: 960 }); await page.evaluate(({ theme, scale }) => { document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.body.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = `${16 * scale}px`; }, { theme, scale }); await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: info.outputPath(`${role}-${width}-${theme}-${scale}-workspace.png`), animations: 'disabled' }); await view.open();
      await expect(view.dialog().getByRole('button', { name: 'Retry search', includeHidden: true })).toBeHidden();
      const scan = await new AxeBuilder({ page }).include('.matter-switch-matter-choice-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(scan.violations).toEqual([]);
      const bounds = await view.dialog().boundingBox(); expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThanOrEqual(2); expect(bounds.y).toBeGreaterThanOrEqual(15);
      await expect(view.dialog().getByRole('button', { name: 'Next Matters', exact: true })).toBeInViewport({ ratio: 0.99 });
      expect(await view.dialog().evaluate(dialog => dialog.scrollWidth > dialog.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
      const controls = await view.dialog().locator('button,input').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && (node.getBoundingClientRect().height < 44 || node.getBoundingClientRect().left < 0 || node.getBoundingClientRect().right > innerWidth + 1)).map(node => node.outerHTML)); expect(controls).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${role}-${width}-${theme}-${scale}-dialog.png`), animations: 'disabled' }); await page.keyboard.press('Escape'); await expect(view.opener()).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}
