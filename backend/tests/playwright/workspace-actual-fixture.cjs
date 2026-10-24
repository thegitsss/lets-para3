'use strict';
// Workspace diagnostic harness: original support-session fixture and scenario bodies
// remain intact; the private actual-app lifecycle has bounded normal teardown.
const { test: base, expect } = require('./support-session-fixture');
const path = require('node:path'), fs = require('node:fs/promises');
const start = require('../helpers/financialLifecycleBrowserServer');
const { writeStorageStateOwnerOnly, removeStorageState } = require('./auth-state');
const { createContextObservation } = require('./workspace-paired-observation.cjs');
const test = base.extend({
  workspaceObservation: [async ({ context }, use, info) => {
    const tracker = createContextObservation(info.title, info.project.name);
    tracker.attach(context, 'framework-test');
    try { await use(tracker.observation); } finally {
      // Complete this framework-owned context at its normal fixture teardown;
      // the observer remains attached while its actual close operation resolves.
      await context.close();
      const observation = tracker.finish();
      await fs.writeFile(info.outputPath('workspace-ui-observation.json'), JSON.stringify(observation, null, 2));
      expect(observation.pageErrors).toEqual([]);
      expect(observation.contextCloseComplete).toBe(true);
    }
  }, { auto: true }],
  foundationServer: [async ({ browser }, use, info) => {
    const server = await start({ includeAdminSupport: true });
    // The original absolute-entry helper reads this private project's origin.
    // Point it to this owned ephemeral app, preserving every relative target.
    info.project.use.baseURL = server.origin;
    const actor = await server.createUser('attorney');
    const User = require('../../models/User');
    // These retained cases exercise a returning account's existing filters,
    // not first-use onboarding. Preserve that original fixture precondition.
    await User.updateOne({ _id: actor.id }, { $set: { profileImage: '', 'onboarding.attorneyTourCompleted': true } });
    const returningActor = await User.findById(actor.id).select('onboarding').lean();
    expect(returningActor.onboarding.attorneyTourCompleted).toBe(true);
    const storageState = path.join(__dirname, '.auth/support-attorney.json');
    const context = await browser.newContext({ baseURL: server.origin });
    const signInObservation = createContextObservation('Returning-account worker sign-in', info.project.name);
    signInObservation.attach(context, 'worker-sign-in');
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    try {
      const page = await context.newPage();
      await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
      const user = await User.findById(actor.id).lean();
      await page.locator('#email').fill(user.email);
      await page.locator('#password').fill('Private synthetic lifecycle password!');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard-attorney\.html(?:[?#].*)?$/);
      const me = await context.request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      const verified = (await me.json()).user;
      expect(String(verified.id || verified._id)).toBe(actor.id);
      await writeStorageStateOwnerOnly(context, storageState);
      await context.close();
      process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_EMAIL = user.email;
      process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD = 'Private synthetic lifecycle password!';
      await use({ origin: server.origin, storageState, actorId: actor.id });
    } finally {
      await context.close();
      const observation = signInObservation.finish();
      await fs.writeFile(path.join(process.env.LPC_WORKSPACE_BROWSER_OUTPUT, `worker-sign-in-observation-${info.project.name}.json`), JSON.stringify(observation, null, 2));
      const output = path.join(process.env.LPC_WORKSPACE_BROWSER_OUTPUT, `actual-app-${info.project.name}.json`);
      await fs.writeFile(output, JSON.stringify({ actorId: actor.id, role: 'attorney', managedSignIn: true, ...server.evidence() }, null, 2));
      removeStorageState(storageState);
      await server.close();
      expect(observation.pageErrors).toEqual([]);
      expect(observation.contextCloseComplete).toBe(true);
    }
  }, { scope: 'worker', timeout: 180000 }],
  baseURL: async ({ foundationServer }, use) => use(foundationServer.origin),
  storageState: async ({ foundationServer }, use) => use(foundationServer.storageState),
});
test.beforeEach(async ({ context, foundationServer }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === foundationServer.origin ? route.continue() : route.abort('blockedbyclient'));
});
test.afterEach(async ({ page }, info) => {
  if (page.url().includes('/dashboard-attorney.html')) await expect(page.locator('#attorneyTourModal')).toBeHidden();
  await page.screenshot({ path: info.outputPath('workspace-rendered.png') });
});
module.exports = { test, expect };
