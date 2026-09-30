const { test: base, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
// This server configures different synthetic authentication/provider modules
// from the cached-history server. A worker fixture gives it its own module cache.
const test = base.extend({
  releaseServer: [async ({}, use) => {
    server = await start();
    try { await use(server); }
    finally { await server.close(); }
  }, { scope: 'worker', auto: true, timeout: 180000 }],
});
test.beforeEach(async () => server.reset());
async function api(context, method, path, data) {
  const csrf = await (await context.request.get(server.origin + '/api/csrf')).json();
  const response = await context.request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json();
}
async function fixture(browser) {
  const contexts = {}, actors = {}, errors = [], requestFailures = [], browserEvents = [];
  for (const role of ['attorney', 'paralegal', 'admin']) {
    actors[role] = await server.createUser(role);
    contexts[role] = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    contexts[role].setDefaultTimeout(15000); contexts[role].setDefaultNavigationTimeout(30000);
    await contexts[role].addCookies([actors[role].cookie]);
    await contexts[role].route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    await contexts[role].exposeBinding('__lpcRoutingEvent', (_source, event) => { browserEvents.push({ role, ...event }); });
    await contexts[role].addInitScript(() => {
      window.__routingEvents = [];
      for (const type of ['pagehide', 'unhandledrejection', 'error']) window.addEventListener(type, event => {
        const row = { type, at: Date.now(), path: location.pathname, message: String(event.reason?.message || event.message || ''), stack: String(event.reason?.stack || event.error?.stack || '') };
        window.__routingEvents.push(row); void window.__lpcRoutingEvent(row).catch(() => {});
      });
    });
    contexts[role].on('page', page => {
      page.on('pageerror', error => errors.push({ role, message: error.message, stack: error.stack, path: new URL(page.url()).pathname, at: Date.now() }));
      page.on('requestfailed', request => requestFailures.push({ role, method: request.method(), path: new URL(request.url()).pathname, failure: request.failure()?.errorText, at: Date.now() }));
      page.on('framenavigated', async frame => {
        if (frame !== page.mainFrame()) return;
        try { browserEvents.push({ role, path: new URL(frame.url()).pathname, at: Date.now(), events: await frame.evaluate(() => window.__routingEvents || []) }); } catch { /* The navigation may replace the execution context before capture. */ }
      });
    });
  }
  const User = require('../../../models/User');
  await User.updateMany({ _id: { $in: Object.values(actors).map(actor => actor.id) } }, { $set: { profileImage: '' } });
  let policy = { expectedRevision: 0, enabled: true, killSwitch: false, attorney: { basisPoints: 0, overrides: { [actors.attorney.id]: 'v2' } }, paralegal: { basisPoints: 0, overrides: { [actors.paralegal.id]: 'v2' } }, reason: 'Private local routing drill.' };
  return { actors, contexts, errors,
    async configure(changes = {}) { policy = { ...policy, ...changes }; const result = await api(contexts.admin, 'put', '/api/admin/workspace-release', policy); policy.expectedRevision = result.settings.revision; return result; },
    async close(info) { for (const [role, context] of Object.entries(contexts)) for (const page of context.pages()) { try { browserEvents.push({ role, path: new URL(page.url()).pathname, events: await page.evaluate(() => window.__routingEvents || []) }); } catch { /* A replaced document has no remaining diagnostic context. */ } } await fs.writeFile(info.outputPath('release-evidence.json'), JSON.stringify({ errors, requestFailures, browserEvents, ...server.evidence() }, null, 2)); for (const context of Object.values(contexts)) await context.close(); },
  };
}
async function matter(actors) {
  expect(require('mongoose').connection.name).toBe('financial_lifecycle_browser');
  return require('../../../models/Case').create({ title: 'River Street filing', details: 'Prepare an exhibit index for attorney review.', attorney: actors.attorney.id, attorneyId: actors.attorney.id, paralegal: actors.paralegal.id, paralegalId: actors.paralegal.id, status: 'in progress', totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeParalegalPct: 18, feeAttorneyPct: 22, currency: 'usd', stripeMode: 'test', escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: 'pi_release_synthetic', paymentIntentId: 'pi_release_synthetic', hiredAt: new Date() });
}
function route(role, id, tab) { return `/${role}-v2.html#${role === 'attorney' ? `/matters/${id}/${tab}` : `/matter/${id}?tab=${tab}`}`; }
const notice = page => page.locator('[data-workspace-release-notice]');
async function refreshPolicy(page) { await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
async function finishSwitch(page, destination) {
  // A completed background read may already have switched the now-clean page.
  // Either completion must reach the same destination, with no repeated write.
  await Promise.allSettled([
    page.waitForURL(destination, { timeout: 15000 }),
    notice(page).getByRole('button', { name: 'Check and switch' }).click({ timeout: 2000 }),
  ]);
  await expect(page).toHaveURL(destination);
}

for (const role of ['attorney', 'paralegal']) test(`${role}: an interacted original page or unavailable routing read stays open`, async ({ browser }, info) => {
  const f = await fixture(browser); let release = () => {};
  try {
    await f.configure(); const page = await f.contexts[role].newPage();
    let entered; const began = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
    await page.route('**/api/auth/workspace-release', async request => { entered(); await gate; await request.continue(); });
    await page.goto(server.origin + `/dashboard-${role}.html`, { waitUntil: 'domcontentloaded' }); await began;
    await page.keyboard.press('Tab'); release();
    await expect(page.locator('html')).toHaveAttribute('data-workspace-entry', 'v2');
    expect(new URL(page.url()).pathname).toBe(`/dashboard-${role}.html`);
    await page.unroute('**/api/auth/workspace-release');
    await page.route('**/api/auth/workspace-release', request => request.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic routing read unavailable' }) }));
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-workspace-entry', 'unavailable');
    expect(new URL(page.url()).pathname).toBe(`/dashboard-${role}.html`);
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(info); }
});

for (const role of ['attorney', 'paralegal']) test(`${role}: password sign-in uses the current server-selected default`, async ({ browser }, info) => {
  const f = await fixture(browser);
  try {
    await f.configure();
    const User = require('../../../models/User'), user = await User.findById(f.actors[role].id).select('email');
    const context = f.contexts[role]; await context.clearCookies();
    const page = await context.newPage(); await page.goto(server.origin + '/login.html');
    await page.locator('#email').fill(user.email); await page.locator('#password').fill('Private synthetic lifecycle password!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${role}-v2\\.html#/home`));
    const result = await api(context, 'get', '/api/auth/me'); expect(String(result.user.id || result.user._id)).toBe(f.actors[role].id);
    expect(f.errors).toEqual([]);
  } finally { await f.close(info); }
});

for (const role of ['attorney', 'paralegal']) test(`${role}: server selection, manual previous entry and live rollback preserve the same financial Matter`, async ({ browser }, info) => {
  const f = await fixture(browser);
  try {
    const current = await matter(f.actors), Case = require('../../../models/Case');
    const before = JSON.stringify(await Case.findById(current.id).lean());
    expect((await api(f.contexts[role], 'get', '/api/auth/workspace-release')).workspace.version).toBe('baseline');
    await f.configure();
    const page = await f.contexts[role].newPage();
    await page.goto(server.origin + `/dashboard-${role}.html`);
    await expect(page).toHaveURL(new RegExp(`/${role}-v2\\.html#/home`));
    await page.goto(server.origin + route(role, current.id, 'financials'));
    if (role === 'attorney') await expect(page.locator('[data-av2-outlet]')).toHaveAttribute('aria-busy', 'false');
    else await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'matter');
    if (role === 'attorney') await page.locator('.av2-brand-menu > summary').click();
    await expect(page.getByRole('link', { name: 'Previous workspace', exact: true })).toHaveAttribute('href', `/case-detail.html?caseId=${current.id}&tab=financials&workspace=legacy`);
    // A deliberate previous-workspace entry must remain there under a V2 policy.
    const previous = await f.contexts[role].newPage(); await previous.goto(server.origin + `/dashboard-${role}.html?workspace=legacy`);
    await expect(previous.locator('body')).toBeVisible(); expect(new URL(previous.url()).pathname).toBe(`/dashboard-${role}.html`);
    await page.bringToFront();
    if (role === 'attorney') await expect(page.locator('[data-av2-outlet] [aria-busy="true"]')).toHaveCount(0);
    await f.configure({ killSwitch: true }); await refreshPolicy(page);
    await expect(page).toHaveURL(server.origin + `/case-detail.html?caseId=${current.id}&tab=financials`);
    expect((await api(f.contexts[role], 'get', '/api/auth/me')).user._id || (await api(f.contexts[role], 'get', '/api/auth/me')).user.id).toBe(f.actors[role].id);
    expect(JSON.stringify(await Case.findById(current.id).lean())).toBe(before);
    expect(server.evidence().provider.filter(call => !/\.(retrieve|list)$/.test(call.method))).toEqual([]); expect(f.errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${role}-previous-financials.png`) });
  } finally { await f.close(info); }
});

for (const role of ['attorney', 'paralegal']) test(`${role}: a routing change preserves unsent message text until the author clears it`, async ({ browser }, info) => {
  const f = await fixture(browser);
  try {
    const current = await matter(f.actors); await f.configure();
    const page = await f.contexts[role].newPage(); await page.goto(server.origin + route(role, current.id, 'messages'));
    const composer = page.getByLabel(role === 'attorney' ? 'Message to the paralegal' : 'Write a message', { exact: true });
    await composer.fill('Keep this unsent explanation in this Matter.');
    await f.configure({ killSwitch: true }); await refreshPolicy(page);
    await expect(notice(page)).toBeVisible(); await expect(composer).toHaveValue('Keep this unsent explanation in this Matter.');
    expect(new URL(page.url()).pathname).toBe(`/${role}-v2.html`);
    await notice(page).getByRole('button', { name: 'Check and switch' }).click(); await expect(composer).toHaveValue('Keep this unsent explanation in this Matter.');
    await page.setViewportSize({ width: 320, height: 780 });
    await expect.poll(() => page.locator(role === 'attorney' ? '.av2-sidebar' : '.v2-sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    if (role === 'paralegal') await expect.poll(() => page.locator('[data-v2-persistent="application-frame"]').evaluate(element => ({ left: element.getBoundingClientRect().left, width: element.getBoundingClientRect().width }))).toEqual({ left: 0, width: 320 });
    await page.evaluate(() => { document.documentElement.classList.add('theme-dark'); document.documentElement.classList.remove('theme-light'); });
    await page.screenshot({ path: info.outputPath(`${role}-retained-message-320.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await composer.scrollIntoViewIfNeeded(); await expect(composer).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${role}-retained-composer-320.png`) });
    await composer.fill(''); await finishSwitch(page, server.origin + `/case-detail.html?caseId=${current.id}&tab=messages`);
    expect(await require('../../../models/Message').countDocuments({ caseId: current.id })).toBe(0);
    expect(server.evidence().requests.filter(row => row.method === 'POST' && /messages/.test(row.path))).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(info); }
});

test('an in-flight draft save and lost response stay available until readback resolves the original write', async ({ browser }, info) => {
  const f = await fixture(browser); let release = () => {};
  try {
    await f.configure(); const owner = f.actors.attorney.id, context = f.contexts.attorney;
    const saved = (await api(context, 'post', '/api/case-drafts', { expectedOwnerId: owner, title: 'Saved draft', practiceArea: 'Contract Law', state: 'California', compAmount: '400', description: 'Draft description.', tasks: [{ title: 'Prepare exhibits' }] })).draft;
    const page = await context.newPage(); await page.goto(server.origin + `/attorney-v2.html#/matters/new?draftId=${saved.id}`);
    const status = page.getByRole('region', { name: 'Draft save status', exact: true }); await expect(page.locator('#av2-draft-title')).toHaveValue('Saved draft');
    let entered; const began = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve); let writes = 0;
    await page.route(`**/api/case-drafts/${saved.id}`, async request => { if (request.request().method() !== 'PUT') return request.continue(); writes++; entered(); await gate; await request.fetch(); await request.abort('failed'); });
    await page.locator('#av2-draft-title').fill('The saved title after rollback'); await began;
    await f.configure({ killSwitch: true }); await refreshPolicy(page); await expect(notice(page)).toBeVisible();
    await expect(page.locator('#av2-draft-title')).toHaveValue('The saved title after rollback'); release();
    await expect(status).toHaveAttribute('data-state', 'uncertain'); await notice(page).getByRole('button', { name: 'Check and switch' }).click();
    expect(new URL(page.url()).pathname).toBe('/attorney-v2.html');
    await status.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(page).toHaveURL(/\/create-case\.html\?draftId=/);
    expect(new URL(page.url()).searchParams.get('draftId')).toBe(saved.id); expect(writes).toBe(1);
    await expect(page.locator('#caseTitleInput')).toHaveValue('The saved title after rollback');
    expect(await require('../../../models/CaseDraft').countDocuments({ owner })).toBe(1); expect(f.errors).toEqual([]);
  } finally { release(); await f.close(info); }
});

test('an older Case draft rolls back, saves and publishes the same retained record in the previous editor', async ({ browser }, info) => {
  const f = await fixture(browser);
  try {
    const mongoose = require('mongoose'), Case = require('../../../models/Case'), id = new mongoose.Types.ObjectId(), owner = f.actors.attorney.id;
    expect(mongoose.connection.name).toBe('financial_lifecycle_browser');
    await Case.collection.insertOne({ _id: id, attorney: new mongoose.Types.ObjectId(owner), attorneyId: new mongoose.Types.ObjectId(owner), status: 'draft', currency: 'usd', title: 'Earlier saved Matter', details: 'First paragraph.\n\nSecond paragraph.', practiceArea: 'Contract Law', state: 'California', totalAmount: 40000, tasks: [{ _id: new mongoose.Types.ObjectId(), title: 'Prepare exhibits', completed: false }], createdAt: new Date(), updatedAt: new Date(), legacyRoot: { retained: true } });
    await f.configure(); const page = await f.contexts.attorney.newPage();
    const returnTo = '#/matters?view=draft&q=Earlier&page=2';
    await page.goto(server.origin + '/attorney-v2.html#/matters/new?' + new URLSearchParams({ caseDraftId: String(id), step: 'description', returnTo }));
    const status = page.getByRole('region', { name: 'Draft save status', exact: true }); await expect(page.locator('#av2-draft-description')).toHaveValue('First paragraph.\n\nSecond paragraph.');
    await f.configure({ killSwitch: true }); await refreshPolicy(page); await expect(page).toHaveURL(/\/create-case\.html\?caseDraftId=/);
    await expect(status).toHaveAttribute('data-state', 'ready'); await expect(page.locator('#av2-draft-description')).toHaveValue('First paragraph.\n\nSecond paragraph.');
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/dashboard-attorney.html?q=Earlier&draftPage=2#cases:draft');
    await page.locator('#av2-draft-description').fill('Revised first paragraph.\n\nPreserved second paragraph.'); await status.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(status).toHaveAttribute('data-state', 'ready'); await expect(status).toContainText('Saved');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('retained-draft-previous-390.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Review draft', exact: true }).click(); await page.getByRole('button', { name: 'Review publishing confirmation', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm and publish Matter', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Publication status', exact: true })).toHaveAttribute('data-state', 'complete');
    const raw = await Case.collection.findOne({ _id: id }); expect(raw.status).toBe('open'); expect(raw.legacyRoot).toEqual({ retained: true }); expect(raw.details).toBe('Revised first paragraph.\n\nPreserved second paragraph.');
    expect(await require('../../../models/CaseDraft').countDocuments()).toBe(0); expect(await Case.countDocuments()).toBe(1); expect(f.errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('retained-draft-published-390.png') });
  } finally { await f.close(info); }
});
