const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("saved-view-model"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; ${source}`], { stdio: "pipe" }); };
test("restoration retains all seven filters and normalizes the current/V2 category name", () => check(`
  const filters={view:'archived',search:'Long search '+ 'x'.repeat(150),practice:'Contract Law',deadline:'none',updated:'30_days',sort:'alphabetical',archiveStatus:'paused'};
  assert.deepEqual(m.viewFilters(filters),filters); assert.equal(m.sameFilters({view:'applications'},{view:'inquiries'}),true); assert.equal(m.sameFilters(filters,{...filters,archiveStatus:'completed'}),false);
  const view={id:'legacy-id',scope:m.VIEW_SCOPE,name:'Test',filters,revision:'a'.repeat(64)};
  assert.deepEqual(m.readSavedViews({ownerId:'owner',scope:m.VIEW_SCOPE,views:[view]},'owner'),[view]);
  assert.throws(()=>m.readSavedViews({ownerId:'foreign',scope:m.VIEW_SCOPE,views:[view]},'owner'),e=>e.kind==='authentication'); assert.throws(()=>m.readSavedViews({ownerId:'owner',scope:m.VIEW_SCOPE,views:[{...view,revision:null}]},'owner'));
  assert.equal(m.matchesCreation(view,{...view,name:'Other'}),false); assert.equal(m.matchesCreation(view,view),true);
`));
test("unfinished view requests stay in route memory and clear at the account boundary", () => check(`
  const state=createPrivateState(), ref=state.savedViews; ref.draft={name:'PRIVATE'}; assert.equal(state.hasUnsaved(),true); state.clear(); assert.equal(ref,state.savedViews); assert.deepEqual(ref,{}); assert.equal(state.hasUnsaved(),false);
  ref.pending={action:'delete'}; assert.equal(state.hasUnsaved(),true); state.clear(); assert.equal(state.hasUnsaved(),false);
`));
test("saved-view reads and writes verify account ownership, use CSRF, and never automatically repeat writes", () => check(`
  const owner='a'.repeat(24), calls=[]; let foreign=false;
  const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options}); return {ok:options.method==='GET',status:options.method==='GET'?200:409,json:async()=>path==='/api/auth/me'?{user:{id:foreign?'b'.repeat(24):owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{code:'SAVED_VIEW_CONFLICT'}};}});
  await api.readMatterViews({ownerId:owner}); assert.equal(calls.at(-1).path,'/api/account/dashboard-views?scope=attorney_matters&expectedOwnerId='+owner);
  calls.length=0; await assert.rejects(api.deleteMatterView('legacy-id','a'.repeat(64),{ownerId:owner}),e=>e.code==='SAVED_VIEW_CONFLICT'); assert.equal(calls.length,3); assert.equal(calls.at(-1).method,'DELETE'); assert.equal(calls.at(-1).headers['X-CSRF-Token'],'synthetic'); assert.equal(JSON.parse(calls.at(-1).body).expectedOwnerId,owner);
  foreign=true; calls.length=0; await assert.rejects(api.readMatterViews({ownerId:owner})); assert.equal(calls.length,1); await assert.rejects(api.saveMatterView({name:'Private'},{ownerId:owner})); assert.equal(calls.length,2);
`));
