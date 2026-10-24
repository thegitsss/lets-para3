'use strict';
// Harness adaptation only: original support-session fixture and scenario bodies
// remain intact; the private actual-app lifecycle has bounded normal teardown.
const { test: base, expect } = require('./support-session-fixture');
const path = require('node:path'), fs = require('node:fs/promises');
const start = require('../helpers/financialLifecycleBrowserServer');
const { writeStorageStateOwnerOnly, removeStorageState } = require('./auth-state');
const errorsByContext = new WeakMap();
const test = base.extend({
  foundationServer: [async ({ browser }, use, info) => {
    const server = await start({ includeAdminSupport: true });
    // The original absolute-entry helper reads this private project's origin.
    // Point it to this owned ephemeral app, preserving every relative target.
    info.project.use.baseURL = server.origin;
    process.env.PLAYWRIGHT_BASE_URL = server.origin;
    const actor = await server.createUser('attorney');
    const User = require('../../models/User');
    // These retained cases exercise a returning account's existing filters,
    // not first-use onboarding. Preserve that original fixture precondition.
    await User.updateOne({ _id: actor.id }, { $set: { profileImage: '', 'onboarding.attorneyTourCompleted': true } });
    const storageState = path.join(__dirname, '.auth/support-attorney.json');
    const context = await browser.newContext({ baseURL: server.origin });
    const loginErrors=[],loginEvents=[];let loginClosed=false;
    context.on('page',page=>page.on('pageerror',error=>{loginErrors.push(error.message);loginEvents.push({message:error.message,stack:error.stack,at:Date.now()});}));
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    try {
      const page = await context.newPage();
      await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
      const user = await User.findById(actor.id).lean();
      expect(user.onboarding?.attorneyTourCompleted).toBe(true);
      await page.locator('#email').fill(user.email);
      await page.locator('#password').fill('Private synthetic lifecycle password!');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard-attorney\.html(?:[?#].*)?$/);
      const me = await context.request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      const verified = (await me.json()).user;
      expect(String(verified.id || verified._id)).toBe(actor.id);
      await writeStorageStateOwnerOnly(context, storageState);
      await context.close();loginClosed=true;
      expect(loginErrors).toEqual([]);
      process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_EMAIL = user.email;
      process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD = 'Private synthetic lifecycle password!';
      await use({ origin: server.origin, storageState, actorId: actor.id, createActor: server.createUser, ownedDatabaseName: server.ownedDatabaseName, ownedMongoUri: require('../helpers/mongoHarnessState').readReadyState().uri });
    } finally {
      await context.close();loginClosed=true;
      await fs.writeFile(path.join(process.env.LPC_POSTING_PUBLICATION_BROWSER_OUTPUT,`login-context-${info.project.name}-${process.pid}.json`),JSON.stringify({errors:loginErrors,events:loginEvents,contextClosed:loginClosed,captureScope:'managed-sign-in-through-context-close'},null,2));
      const output = path.join(process.env.LPC_POSTING_PUBLICATION_BROWSER_OUTPUT, `actual-app-${info.project.name}-${process.pid}.json`);
      await fs.writeFile(output, JSON.stringify({ actorId: actor.id, role: 'attorney', managedSignIn: true, ...server.evidence() }, null, 2));
      removeStorageState(storageState);
      await server.close();
      expect(loginErrors).toEqual([]);
    }
  }, { scope: 'worker', timeout: 180000 }],
  baseURL: async ({ foundationServer }, use) => use(foundationServer.origin),
  storageState: async ({ foundationServer }, use) => use(foundationServer.storageState),
  _postingStrictContextEvidence: [async ({ context, foundationServer }, use, info) => {
    // Extended automatic fixtures apply to every test, including test files
    // importing the same CommonJS module after another file has loaded it.
    const errors = [], events = [];
    const snapshot = async () => { const mongoose=require('mongoose'),result={}; for(const name of Object.keys(mongoose.models).filter(name=>!['User','AuthSession','AuthChallenge','PasskeyCredential'].includes(name)).sort()){ const model=mongoose.models[name];if(model)result[name]=await model.collection.find({}).sort({_id:1}).toArray();} result.User=await mongoose.models.User.collection.find({},{projection:{role:1,status:1,disabled:1,deleted:1,authVersion:1,onboarding:1,isFirstLogin:1,preferences:1,firstName:1,lastName:1,lawFirm:1,state:1}}).sort({_id:1}).toArray();result.AuthSession=await mongoose.models.AuthSession.collection.find({},{projection:{userId:1,expiresAt:1,revokedAt:1,revokedReason:1}}).sort({_id:1}).toArray();return result;};
    const before=await snapshot();
    let phase = 'test', contextClosed = false, artifactError = null;
    const observe = page => page.on('pageerror', error => {
      errors.push(error.message);
      events.push({ phase, message: error.message, stack: error.stack, at: Date.now() });
    });
    context.pages().forEach(observe);
    context.on('page', observe);
    await context.route('**/*', route => new URL(route.request().url()).origin === foundationServer.origin ? route.continue() : route.abort('blockedbyclient'));
    try { await use(); }
    finally {
      phase = 'artifact';
      try {
        const page = context.pages().find(page => !page.isClosed());
        if (page) await page.screenshot({ path: info.outputPath('posting-refresh-rendered.png') });
      } catch (error) { artifactError = error; }
      phase = 'context-close';
      try { await context.close(); contextClosed = true; }
      catch (error) { artifactError ||= error; }
      context.off('page', observe);
      await fs.writeFile(info.outputPath('posting-page-errors.json'), JSON.stringify({
        errors, events, captureScope: 'automatic-per-test-through-context-close', contextClosed,
        artifactFailure: artifactError?.message || null,
      }, null, 2));
      await fs.writeFile(info.outputPath('current-actual-records.json'), JSON.stringify({title:info.title,engine:info.project.name,before,after:await snapshot(),contextClosed,errors,artifactFailure:artifactError?.message||null},null,2));
      expect(errors).toEqual([]);
      if (artifactError) throw artifactError;
    }
  }, { auto: true }],
});
async function observeManagedContext(context,info,label='secondary') {
 const errors=[],events=[];let phase='test';const observe=page=>page.on('pageerror',error=>{errors.push(error.message);events.push({phase,message:error.message,stack:error.stack,at:Date.now()});});
 context.pages().forEach(observe);context.on('page',observe);
 const origin=info.project.use.baseURL;await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
 return async()=>{phase='context-close';await context.close();context.off('page',observe);await fs.writeFile(info.outputPath(label+'-context-errors.json'),JSON.stringify({errors,events,contextClosed:true,captureScope:'explicit-secondary-context-through-close'},null,2));expect(errors).toEqual([]);};
}
module.exports = { test, expect, observeManagedContext };
