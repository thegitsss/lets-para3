const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("moderation-model"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; ${source}`], { stdio: "pipe" }); };
test("read models reject another account/Matter, contradictory permissions and invalid receipts", () => check(`
  const value={caseId:'case',ownerId:'owner',caseTitle:'Title',status:'flagged',revision:'a'.repeat(64),canRequestReview:true,reason:'ready',feedback:'Admin feedback',receipt:null}; assert.deepEqual(m.readModeration(value,'case','owner'),value);
  assert.throws(()=>m.readModeration(value,'foreign','owner')); assert.throws(()=>m.readModeration(value,'case','other'),e=>e.kind==='authentication'); assert.throws(()=>m.readModeration({...value,status:'none'},'case','owner')); assert.throws(()=>m.readModeration({...value,receipt:{requestId:'bad'}},'case','owner'));
`));
test("a receipt confirms the exact reviewed request even after an admin clears the flag", () => check(`
  const sent={requestId:'request',revision:'a'.repeat(64)}; assert.equal(m.confirmsReview({status:'none',receipt:sent},sent),true); assert.equal(m.confirmsReview({receipt:{...sent,revision:'b'.repeat(64)}},sent),false); assert.equal(m.confirmsReview({receipt:{...sent,requestId:'other'}},sent),false);
  const state=createPrivateState();state.moderation.set('case',{pending:sent});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.moderation.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("review submissions carry the exact revision and owner with CSRF and no write retry", () => check(`
  const owner='a'.repeat(24),calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});return {ok:options.method==='GET',status:options.method==='GET'?200:409,json:async()=>path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{code:'MODERATION_CONFLICT'}};}});
  const sent={requestId:'request',revision:'b'.repeat(64)};await assert.rejects(api.requestMatterReview('c'.repeat(24),sent,{ownerId:owner}),e=>e.code==='MODERATION_CONFLICT');assert.equal(calls.length,3);assert.equal(calls.at(-1).headers['X-CSRF-Token'],'synthetic');assert.deepEqual(JSON.parse(calls.at(-1).body),{...sent,expectedOwnerId:owner});
`));
