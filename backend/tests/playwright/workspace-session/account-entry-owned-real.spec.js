const { test: base, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
const PASSWORD = 'Private synthetic lifecycle password!';
const test = base.extend({ entryServer: [async ({}, use) => {
  server = await start();
  try { await use(server); } finally { await server.close(); }
}, { scope: 'worker', auto: true, timeout: 180000 }] });
test.beforeEach(async () => server.reset());

async function fixture(browser) {
  const contexts = [], errors = [], outcomes = [], lifecycle = [], browserRequests = [];
  const User = require('../../../models/User');
  async function actor(role, publicProfile = false) {
    const owner = await server.createUser(role, {}, publicProfile);
    await User.updateOne({ _id: owner.id }, { $set: { profileImage: '' } });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    contexts.push(context);
    await context.addCookies([owner.cookie]);
    await context.exposeBinding('__lpcEntryLifecycle', (_source, event) => lifecycle.push({ role, owner: owner.id, ...event }));
    await context.addInitScript(() => {
      for (const type of ['beforeunload', 'pagehide', 'pageshow', 'DOMContentLoaded', 'error', 'unhandledrejection']) window.addEventListener(type, event => {
        void window.__lpcEntryLifecycle({ type, at: Date.now(), path: location.pathname, message: String(event.reason?.message || event.message || ''), stack: String(event.reason?.stack || event.error?.stack || '') }).catch(() => {});
      });
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    context.on('page', page => {
      page.on('pageerror', error => errors.push({ role, path: new URL(page.url()).pathname, at: Date.now(), message: error.message, stack: error.stack }));
      page.on('request', request => { if (request.url().startsWith(server.origin + '/api/')) browserRequests.push({ phase: 'start', role, path: new URL(request.url()).pathname, method: request.method(), at: Date.now() }); });
      page.on('requestfinished', request => { if (request.url().startsWith(server.origin + '/api/')) browserRequests.push({ phase: 'finish', role, path: new URL(request.url()).pathname, method: request.method(), at: Date.now() }); });
      page.on('requestfailed', request => { if (request.url().startsWith(server.origin + '/api/')) browserRequests.push({ phase: 'failed', role, path: new URL(request.url()).pathname, method: request.method(), failure: request.failure()?.errorText, at: Date.now() }); });
    });
    const user = await User.findById(owner.id).select('+password +authVersion').lean();
    return { ...owner, role, context, user };
  }
  return { actor, errors, outcomes, lifecycle, async configure(actors) {
    const admin = await actor('admin');
    const csrf = await (await admin.context.request.get(server.origin + '/api/csrf')).json();
    const response = await admin.context.request.put(server.origin + '/api/admin/workspace-release', {
      headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { expectedRevision: 0, enabled: true, killSwitch: false,
        attorney: { basisPoints: 0, overrides: Object.fromEntries(actors.filter(a => a.role === 'attorney').map(a => [a.id, 'v2'])) },
        paralegal: { basisPoints: 0, overrides: Object.fromEntries(actors.filter(a => a.role === 'paralegal').map(a => [a.id, 'v2'])) },
        reason: 'Private bounded account-entry acceptance.' } });
    expect(response.status()).toBe(200);
  }, async close(info) {
    lifecycle.push({ type: 'fixture-contexts-close-start', at: Date.now() });
    try { for (const context of contexts) await context.close(); }
    finally { await fs.writeFile(info.outputPath('entry-evidence.json'), JSON.stringify({ errors, outcomes, lifecycle, browserRequests, ...server.evidence() }, null, 2)); }
  } };
}
async function signIn(actor, { status = 200, message } = {}) {
  await actor.context.clearCookies();
  const page = await actor.context.newPage();
  await page.goto(server.origin + '/login.html');
  await page.locator('#email').fill(actor.user.email);
  await page.locator('#password').fill(PASSWORD);
  const response = page.waitForResponse(r => r.url() === server.origin + '/api/auth/login' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(status);
  if (status === 200) await expect(page).toHaveURL(new RegExp(`/${actor.role}-v2\\.html#/home`));
  else { await expect(page).toHaveURL(server.origin + '/login.html'); await expect(page.locator('#toastBanner')).toContainText(message); }
  return page;
}
async function identity(actor) {
  const response = await actor.context.request.get(server.origin + '/api/auth/me');
  expect(response.status()).toBe(200);
  const user = (await response.json()).user;
  expect(String(user.id || user._id)).toBe(actor.id);
  return user;
}
async function sessions(actor) { return require('../../../models/AuthSession').countDocuments({ userId: actor.id, revokedAt: null }); }
async function menu(page, role) {
  if (role === 'attorney') await page.locator('.av2-brand-menu > summary').click();
  else await page.getByRole('button', { name: 'Open profile menu', exact: true }).click();
  return page.getByRole(role === 'attorney' ? 'link' : 'menuitem', { name: 'Previous workspace', exact: true });
}

test('Attorney approved password sign-in, actual account menu and previous/current entry retain the managed owner', async ({ browser }, info) => {
  const f = await fixture(browser);
  try {
    const actor = await f.actor('attorney'); await f.configure([actor]); const before = await sessions(actor);
    const page = await signIn(actor); await identity(actor);
    await expect(page.locator('[data-attorney-state]')).toHaveAttribute('data-attorney-state', 'ready');
    expect(await sessions(actor)).toBe(before + 1);
    await page.screenshot({ path: info.outputPath('attorney-current.png') });
    const previous = await menu(page, 'attorney');
    await expect(previous).toHaveAttribute('href', '/dashboard-attorney.html?workspace=legacy');
    await previous.click(); await expect(page).toHaveURL(server.origin + '/dashboard-attorney.html?workspace=legacy');
    await expect(page.locator('[data-view-target="home"]').first()).toBeVisible(); await identity(actor);
    await page.screenshot({ path: info.outputPath('attorney-previous.png') });
    await page.goBack(); await expect(page).toHaveURL(server.origin + '/attorney-v2.html#/home');
    await expect(page.locator('[data-attorney-state]')).toHaveAttribute('data-attorney-state', 'ready');
    await page.getByRole('link', { name: 'Home', exact: true }).first().click(); await identity(actor);
    expect(await sessions(actor)).toBe(before + 1);
    f.outcomes.push({ role: actor.role, owner: actor.id, sessionsBefore: before, sessionsAfter: await sessions(actor), current: '/attorney-v2.html#/home', previous: '/dashboard-attorney.html?workspace=legacy' });
    expect(f.errors).toEqual([]);
  } finally { await f.close(info); }
});

test('Paralegal admitted first sign-in, own-profile alias and actual previous-profile Home control use saved owner data', async ({ browser }, info) => {
  const f = await fixture(browser);
  try {
    const actor = await f.actor('paralegal', true); await f.configure([actor]); const before = await sessions(actor);
    const page = await signIn(actor); await identity(actor);
    await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    const Notification = require('../../../models/Notification');
    const welcome = await Notification.find({ userId: actor.id, type: 'paralegal_welcome' }).lean();
    expect(welcome).toHaveLength(1); expect(welcome[0].payload.body).toMatch(/approved/i);
    expect(welcome[0].message).not.toMatch(/under review|after approval/i);
    await page.getByRole('button', { name: /^View notifications(?:, \d+ unread)?$/ }).click();
    await expect(page.locator('[data-v2-notifications-content]')).toContainText(welcome[0].payload.body);
    await page.screenshot({ path: info.outputPath('paralegal-admitted-welcome.png') });
    await page.getByRole('button', { name: /^View notifications(?:, \d+ unread)?$/ }).click();
    const alias = await page.evaluate(() => {
      const adapter = window.__LPC_PARALEGAL_V2__;
      const result = adapter.adaptLegacyDestination('/paralegal-v2.html#/profile/me');
      return { result, navigated: adapter.navigateToDestination(result) };
    });
    expect(alias.result).toEqual({ href: '/paralegal-v2.html#/profile/me', internal: true }); expect(alias.navigated).toBe(true);
    await expect(page.locator('[data-v2-profile-preview] h1')).toHaveText('River paralegal');
    await expect(page.locator('[data-v2-profile-preview]')).toContainText(actor.user.bio);
    await page.screenshot({ path: info.outputPath('paralegal-current-own-profile.png') });
    const previous = await menu(page, 'paralegal');
    const previousPath = `/profile-paralegal.html?paralegalId=${actor.id}&workspace=legacy`;
    await expect(previous).toHaveAttribute('href', previousPath); await previous.click();
    await expect(page).toHaveURL(server.origin + previousPath);
    await expect(page.locator('#profileName')).toHaveText('River paralegal'); await identity(actor);
    await page.screenshot({ path: info.outputPath('paralegal-previous-own-profile.png') });
    await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(server.origin + '/paralegal-v2.html#/home');
    await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready'); await identity(actor);
    expect(await sessions(actor)).toBe(before + 1); expect(await Notification.countDocuments({ userId: actor.id, type: 'paralegal_welcome' })).toBe(1);
    f.outcomes.push({ role: actor.role, owner: actor.id, alias, welcomeBody: welcome[0].payload.body, sessionsBefore: before, sessionsAfter: await sessions(actor), previous: previousPath });
    expect(f.errors).toEqual([]);
  } finally { await f.close(info); }
});

async function restricted(browser, info, variants) {
  const f = await fixture(browser);
  try {
    for (const role of ['attorney', 'paralegal']) for (const variant of variants) {
      const actor = await f.actor(role), approved = await identity(actor), before = await sessions(actor);
      const User = require('../../../models/User'), Notification = require('../../../models/Notification');
      await User.updateOne({ _id: actor.id }, { $set: variant.fields });
      const pendingBody = 'Your application is under review. We’ll notify you when a decision is recorded.';
      if (role === 'paralegal' && variant.fields.status === 'pending') await Notification.create({ userId: actor.id, userRole: role, type: 'paralegal_welcome', message: pendingBody, payload: { body: pendingBody } });
      const signInPage = await signIn(actor, { status: 403, message: variant.message });
      for (const destination of [`/${role}-v2.html#/home`, `/dashboard-${role}.html?workspace=legacy`]) {
        await actor.context.addCookies([actor.cookie]);
        const page = await actor.context.newPage();
        await page.goto(server.origin + '/api/health');
        await page.waitForLoadState('networkidle');
        // Restore a legitimately issued but now stale owner projection through
        // the application's own persistence function in a neutral document.
        // An active login document may independently redirect its restored user.
        // No API response is mocked.
        await page.evaluate(async user => (await import('/assets/scripts/auth.js')).persistSession({ user }), approved);
        const entryStartedAt = Date.now();
        f.lifecycle.push({ type: 'restricted-entry-start', role, destination, at: entryStartedAt });
        await page.goto(server.origin + destination, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/(?:login|paralegal-admission)\.html(?:[?#].*)?$/);
        await page.waitForLoadState('domcontentloaded');
        const landed = new URL(page.url()).pathname;
        await expect.poll(() => f.lifecycle.some(event => event.owner === actor.id && event.type === 'pageshow' && event.path === landed && event.at >= entryStartedAt)).toBe(true);
        if (landed === '/login.html') await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
        else {
          await expect(page.getByRole('heading', { name: 'Our Application Review', exact: true })).toBeVisible();
          await expect(page.getByRole('link', { name: 'Sign in', exact: true }).filter({ visible: true }).first()).toBeVisible();
        }
        await expect.poll(() => page.evaluate(() => localStorage.getItem('lpc_user'))).toBeNull();
        f.lifecycle.push({ type: 'restricted-landing-settled', role, destination, landed, at: Date.now(), functionalControlsReady: true, storedUserCleared: true });
        expect((await actor.context.request.get(server.origin + `/api/${role}/dashboard`)).status()).toBeGreaterThanOrEqual(400);
        await page.close();
      }
      const current = await User.findById(actor.id).select('+password +authVersion').lean();
      expect(current.password).toBe(actor.user.password); expect(current.authVersion).toBe(actor.user.authVersion);
      for (const [field, value] of Object.entries(variant.fields)) expect(current[field]).toBe(value);
      expect(await sessions(actor)).toBe(before);
      const welcomes = await Notification.find({ userId: actor.id, type: 'paralegal_welcome' }).lean();
      expect(welcomes).toHaveLength(role === 'paralegal' && variant.fields.status === 'pending' ? 1 : 0);
      if (welcomes.length) expect(welcomes[0].payload.body).toBe(pendingBody);
      f.outcomes.push({ role, owner: actor.id, unavailable: variant.fields, sessionsBefore: before, sessionsAfter: await sessions(actor), passwordUnchanged: true, authVersion: current.authVersion, welcomeBodies: welcomes.map(n => n.payload.body) });
      await signInPage.close(); await actor.context.close();
    }
    // Intentional guard throws on original-page entry are recorded in evidence;
    // successful approved pages require zero errors in their separate cases.
  } finally { await f.close(info); }
}
test('Both roles pending/denied accounts retain admission state and gain no session through sign-in or stale current/previous entry', async ({ browser }, info) => restricted(browser, info, [
  { fields: { status: 'pending' }, message: 'still under review' }, { fields: { status: 'denied' }, message: 'not approved' },
]));
test('Both roles disabled/deleted accounts fail closed through sign-in and stale current/previous entry without new sessions', async ({ browser }, info) => restricted(browser, info, [
  { fields: { disabled: true }, message: 'deactivated' }, { fields: { deleted: true }, message: 'deactivated' },
]));
