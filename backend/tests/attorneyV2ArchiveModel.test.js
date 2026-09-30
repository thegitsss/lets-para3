const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("archive-model"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {parseRoute} from ${JSON.stringify(url("routes"))}; ${source}`], { stdio: "pipe" }); };
test("archive reviews reject another account/Matter, conflicting permissions and malformed receipts", () => check(`
  const value={caseId:'case',ownerId:'owner',caseTitle:'Matter',revision:'a'.repeat(64),status:'open',archived:false,targetArchived:true,canChange:true,reason:'ready',legacyReopen:false,restoredView:'active',readOnly:false,receipt:null};assert.equal(m.readArchive(value,'case','owner'),value);
  for(const change of [{caseId:'foreign'},{revision:''},{targetArchived:false},{canChange:false},{legacyReopen:true},{restoredView:'external'},{receipt:{requestId:'bad'}}])assert.throws(()=>m.readArchive({...value,...change},'case','owner'));
  assert.throws(()=>m.readArchive(value,'case','other'),e=>e.kind==='authentication');assert.equal(parseRoute('#/matters/'+'b'.repeat(24)+'/archive').name,'matter-archive');
`));
test("receipt confirmation requires the exact action, request and revision; private pending work is retained until cleared", () => check(`
  const sent={requestId:'request',revision:'a'.repeat(64),archived:true};assert.equal(m.confirmsArchive({receipt:sent},sent),true);
  for(const change of [{requestId:'other'},{revision:'b'.repeat(64)},{archived:false}])assert.equal(m.confirmsArchive({receipt:{...sent,...change}},sent),false);
  const state=createPrivateState();state.archives.set('case',{pending:sent});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.archives.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("restore copy preserves paused/read-only state and explicitly distinguishes legacy reopening", () => check(`
  assert.equal(m.archiveAction({archived:true,status:"draft",restoredView:"draft",legacyReopen:false}),"Restore draft");assert.match(m.archiveEffect({archived:true,status:"draft"}),/stay private/);
  const value={archived:true,status:'paused',restoredView:'archived',readOnly:true};assert.equal(m.archiveAction(value),'Remove manual archive');assert.match(m.archiveEffect(value),/paused status and read-only restrictions/);assert.match(m.archiveEffect(value),/Archived until/);
  assert.equal(m.archiveAction({...value,legacyReopen:true}),'Restore as open posting');assert.match(m.archiveEffect({...value,legacyReopen:true}),/reopen as an open posting/);
`));
test("archive writes verify the account and CSRF, send one reviewed PATCH, and never use the generic status editor", () => check(`
  const owner='a'.repeat(24),calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});return {ok:options.method==='GET',status:options.method==='GET'?200:409,json:async()=>path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{code:'ARCHIVE_CHANGED'}};}});
  const sent={requestId:'request',revision:'b'.repeat(64),archived:false};await assert.rejects(api.changeMatterArchive('c'.repeat(24),sent,{ownerId:owner}),e=>e.code==='ARCHIVE_CHANGED');assert.equal(calls.length,3);assert.ok(calls[2].path.endsWith('/archive'));assert.equal(calls[2].method,'PATCH');assert.equal(calls[2].headers['X-CSRF-Token'],'synthetic');assert.deepEqual(JSON.parse(calls[2].body),{...sent,expectedOwnerId:owner});
`));

const adminFixture = `
  const {archiveAdminPost}=await import(${JSON.stringify(url("../admin-matter-archive"))});
  const owner='a'.repeat(24),caseId='c'.repeat(24),calls=[];
  let confirms=0,accepted=true,changed=false,mode='success';
  const value={caseId,ownerId:owner,caseTitle:'Fresh server title',revision:'b'.repeat(64),status:'open',archived:false,targetArchived:true,canChange:true,reason:'ready',legacyReopen:false,restoredView:'active',readOnly:false,receipt:null};
  const options={confirmAction:async(text)=>{confirms++;assert.match(text,/Fresh server title/);return accepted;},fetchImpl:async(path,options={})=>{
    calls.push({path,...options});let body;
    if(path==='/api/auth/me')body={user:{id:changed&&confirms?'d'.repeat(24):owner,role:'admin'}};
    else if(path==='/api/csrf')body={csrfToken:'synthetic'};
    else if(options.method==='PATCH'){
      if(mode==='network')throw new Error('lost response');
      const sent=JSON.parse(options.body);body={ok:true,archive:{...value,archived:true,targetArchived:false,receipt:{requestId:sent.requestId,revision:sent.revision,archived:true,at:new Date().toISOString()}}};
      if(mode==='missing')body.archive.receipt=null;
      if(mode==='foreign')body.archive.ownerId='f'.repeat(24);
    }else body=value;
    return {ok:true,json:async()=>body};
  }};
`;
test("the existing admin archive action reads fresh content and cancels without writing", () => check(adminFixture+`
  accepted=false;assert.equal(await archiveAdminPost(caseId,options),null);assert.equal(confirms,1);assert.equal(calls.length,2);assert.ok(calls[1].path.includes('expectedOwnerId='+owner));
`));
test("admin archive verifies identity again and confirms the single CSRF-protected write by exact receipt", () => check(adminFixture+`
  assert.deepEqual(await archiveAdminPost(caseId,options),{state:'recorded'});assert.equal(confirms,1);assert.equal(calls.filter(call=>call.path==='/api/auth/me').length,2);
  const writes=calls.filter(call=>call.method==='PATCH');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');const sent=JSON.parse(writes[0].body);assert.equal(sent.expectedOwnerId,owner);assert.equal(sent.revision,value.revision);assert.equal(sent.archived,true);assert.equal(Object.hasOwn(sent,'status'),false);
`));
test("admin archive rejects an account change and unavailable state and does not reverse an already archived post", () => check(adminFixture+`
  changed=true;await assert.rejects(archiveAdminPost(caseId,options),/account changed/);assert.equal(calls.some(call=>call.method==='PATCH'),false);
  changed=false;confirms=0;value.canChange=false;value.reason='assigned';await assert.rejects(archiveAdminPost(caseId,options),/assigned paralegal/);assert.equal(confirms,0);
  value.archived=true;value.targetArchived=false;assert.deepEqual(await archiveAdminPost(caseId,options),{state:'already_archived'});assert.equal(confirms,0);
`));
test("an admin archive acknowledgement must be recognizable and never triggers an automatic retry", () => check(adminFixture+`
  for(mode of ['network','missing','foreign']){calls.length=0;await assert.rejects(archiveAdminPost(caseId,options),/result was not confirmed/);assert.equal(calls.filter(call=>call.method==='PATCH').length,1);}
`));
