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
    const server = await start({ includeAdminSupport: true, port: 0 });
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
    const errors = [], events = [], consoleErrors = [];
    const snapshot = async () => { const mongoose=require('mongoose'),result={}; for(const name of Object.keys(mongoose.models).filter(name=>!['User','AuthSession','AuthChallenge','PasskeyCredential'].includes(name)).sort()){ const model=mongoose.models[name];if(model)result[name]=await model.collection.find({}).sort({_id:1}).toArray();} result.User=await mongoose.models.User.collection.find({},{projection:{role:1,status:1,disabled:1,deleted:1,authVersion:1,twoFactorEnabled:1,twoFactorMethod:1,onboarding:1,isFirstLogin:1,preferences:1,firstName:1,lastName:1,lawFirm:1,state:1}}).sort({_id:1}).toArray();result.AuthSession=await mongoose.models.AuthSession.collection.find({},{projection:{userId:1,expiresAt:1,revokedAt:1,revokedReason:1}}).sort({_id:1}).toArray();result.AuthChallenge=await mongoose.models.AuthChallenge.collection.find({},{projection:{userId:1,purpose:1,status:1,expiresAt:1}}).sort({_id:1}).toArray();result.PasskeyCredential=await mongoose.models.PasskeyCredential.collection.find({},{projection:{userId:1,name:1,counter:1,createdAt:1,lastUsedAt:1}}).sort({_id:1}).toArray();return result;};
    const before=await snapshot();
    let phase = 'test', contextClosed = false, artifactError = null;
    const observe = page => { page.on('console', message => { if (message.type() === 'error') consoleErrors.push({text:message.text(),url:page.url(),location:message.location()}); }); page.on('pageerror', error => {
      errors.push(error.message);
      events.push({ phase, message: error.message, stack: error.stack, at: Date.now() });
    }); };
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
        errors, events, consoleErrors, captureScope: 'automatic-per-test-through-context-close', contextClosed,
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

// Native controller fault injection stays explicit; business records are local.
const messageFingerprints=new Map();
async function persistObservedMessages(rows,caseId,ownerId){
 const mongoose=require('mongoose'),Case=mongoose.models.Case,Message=mongoose.models.Message,User=mongoose.models.User;
 if(mongoose.connection.name!=='jest')throw Error('Unowned fixture database');
 const matter=await Case.findById(caseId).lean();if(!matter||String(matter.attorneyId||matter.attorney)!==String(ownerId))throw Error('Unowned fixture Matter');
 for(const row of rows){
  const sender=row.senderId?._id||row.senderId;const identity=row.senderId&&typeof row.senderId==='object'?row.senderId:{};
  await User.collection.updateOne({_id:new mongoose.Types.ObjectId(sender)},{$setOnInsert:{role:row.senderRole||'paralegal',status:'approved',email:'synthetic-message-'+sender+'@example.test',emailVerified:true,firstName:identity.firstName||'Synthetic',lastName:identity.lastName||'Participant'}},{upsert:true});
  const attachment=row.hasAttachment||row.attachments?.some(value=>value.hasAttachment);
  const data={caseId:new mongoose.Types.ObjectId(caseId),senderId:new mongoose.Types.ObjectId(sender),senderRole:row.senderRole||'paralegal',type:row.type||'text',text:row.text||'',transcript:row.transcript||null,fileKey:attachment?'synthetic-message/'+caseId+'/'+row._id:null,fileName:row.fileName||row.attachments?.[0]?.filename||null,mimeType:row.audioMimeType||row.attachments?.[0]?.audioMimeType||null,createdAt:row.createdAt?new Date(row.createdAt):new Date('2026-01-01T00:00:00Z'),readBy:[],reactions:{},deleted:Boolean(row.deleted)};
  const key=caseId+':'+row._id,fingerprint=require('crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex');if(messageFingerprints.get(key)===fingerprint)continue;
  let stored=await Message.findById(row._id);if(stored&&String(stored.caseId)!==String(caseId))throw Error('Cross-Matter fixture ID');if(!stored)stored=new Message({_id:new mongoose.Types.ObjectId(row._id)});Object.assign(stored,data);await stored.save();messageFingerprints.set(key,fingerprint);
 }
}
async function persistSecurityRows(model){
 const mongoose=require('mongoose'),Passkey=mongoose.models.PasskeyCredential;
 if(mongoose.connection.name!=='jest'||!await mongoose.models.User.exists({_id:model.owner,role:'attorney'}))throw Error('Unowned security fixture');
 await Passkey.deleteMany({userId:model.owner});
 for(const row of model.passkeys){row.id=require('crypto').createHash('sha256').update(model.owner+':'+row.id).digest('hex').slice(0,24);await Passkey.create({_id:row.id,userId:model.owner,credentialId:'local-native-read-'+row.id,publicKey:Buffer.from('synthetic-local-public-key'),name:row.name,counter:0});}
}
module.exports.persistObservedMessages=persistObservedMessages;
module.exports.persistSecurityRows=persistSecurityRows;

async function ensureEligibleMatter(page,caseId,foundationServer){
 const mongoose=require('mongoose');if(mongoose.connection.name!=='jest')throw Error('Unowned eligibility database');
 const me=(await(await page.request.get('/api/auth/me')).json()).user,ownerId=String(me.id||me._id);
 const before=await mongoose.models.Case.findById(caseId).lean();expect(String(before.attorneyId||before.attorney)).toBe(ownerId);
 const person=await foundationServer.createActor('paralegal',{},true);
 const ctx=await page.context().browser().newContext({baseURL:foundationServer.origin});let closed=false;
 try{
  await ctx.addCookies([person.cookie]);
  async function request(client,method,url,data){const csrf=await(await client.get('/api/csrf')).json();const response=await client[method](url,{headers:{'X-CSRF-Token':csrf.csrfToken},...(data?{data}:{} )});expect(response.ok(),await response.text()).toBeTruthy();return response.json();}
  const job=await mongoose.models.Job.findOne({caseId}).lean();expect(job).toBeTruthy();
  await request(ctx.request,'post','/api/jobs/'+job._id+'/apply',{coverLetter:'I can prepare the exhibit index.'});
  await request(page.request,'post','/api/payments/payment-method/default',{paymentMethodId:'pm_browser_card'});
  const review=await request(page.request,'get','/api/cases/'+caseId+'/hiring-review/'+person.id+'?expectedOwnerId='+ownerId);
  await request(page.request,'post','/api/cases/'+caseId+'/hire/'+person.id,{expectedOwnerId:ownerId,reviewedRevision:review.revision});
  const after=await mongoose.models.Case.findById(caseId).lean();expect(String(after.paralegalId||after.paralegal)).toBe(person.id);expect(after.escrowStatus).toBe('funded');expect(after.escrowIntentId).toBeTruthy();
  return {caseId,ownerId,paralegalId:person.id,escrowStatus:after.escrowStatus};
 }finally{await ctx.close();closed=true;expect(closed).toBe(true);}
}
module.exports.ensureEligibleMatter=ensureEligibleMatter;
