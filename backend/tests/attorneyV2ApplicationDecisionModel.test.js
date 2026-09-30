const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("application-decision-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))};
 const owner='a'.repeat(24),caseId='b'.repeat(24),applicantId='c'.repeat(24),item={applicantId,applicationId:'d'.repeat(24)};
 const value={ownerId:owner,caseId,...item,name:'Applicant',caseTitle:'Matter',revision:'e'.repeat(64),status:'submitted',starred:false,reason:'ready',actions:['star','shortlist','reject']};
 const sent={requestId:'00000000-0000-4000-8000-000000000000',revision:value.revision,action:'reject',status:'submitted',starred:false,applicationId:item.applicationId};
 const receipt={...sent,ownerId:owner,caseId,...item,status:'rejected',recordedAt:'2026-09-07T00:00:00.000Z'};
 ${source}`], { stdio: "pipe" }); };
test("only exact application reviews can offer actions and earlier-only entries cannot invent shortlist states", () => check(`
 assert.equal(m.readDecision(value,caseId,owner,item).actions.length,3);
 for(const patch of [{ownerId:caseId},{caseId:owner},{applicationId:null},{actions:['hire']},{actions:['reject']},{status:'accepted'},{revision:'bad'},{starred:'true'},{reason:'fabricated'}])assert.throws(()=>m.readDecision({...value,...patch},caseId,owner,item));
 assert.equal(m.readDecision({...value,reason:'hiring_started',actions:[]},caseId,owner,item).actions.length,0);
 assert.equal(m.readDecision({...value,applicationId:null,actions:['star','reject']},caseId,owner,{...item,applicationId:null}).actions.length,2);
`));
test("confirmation requires the exact request, action, reviewed version and resulting state", () => check(`
 assert.equal(m.readDecisionResult({receipt},caseId,owner,item,sent).status,'rejected');assert.equal(m.readDecisionResult({receipt:null},caseId,owner,item,sent),null);
 for(const patch of [{ownerId:caseId},{caseId:owner},{applicantId:owner},{applicationId:null},{requestId:'different'},{revision:'bad'},{action:'star'},{status:'accepted'},{starred:true},{recordedAt:'bad'}])assert.throws(()=>m.readDecisionResult({receipt:{...receipt,...patch}},caseId,owner,item,sent));
 assert.throws(()=>m.readDecisionResult({},caseId,owner,item,sent));
`));
test("unconfirmed decisions stay only in account-scoped memory and warn before leaving", () => check(`
 const state=createPrivateState();assert.equal(state.hasUnsaved(),false);state.applicationDecisions.set(caseId+':'+applicantId,{pending:sent});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.applicationDecisions.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("writes verify the account, send one explicit action with CSRF, and check the account after the response", () => check(`
 const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{receipt}),{headers:{'Content-Type':'application/json'}});}});
 const response=await api.saveApplicationDecision(caseId,applicantId,{requestId:sent.requestId,revision:sent.revision,action:sent.action},{ownerId:owner});assert.deepEqual(response,{receipt});const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');assert.equal(JSON.parse(writes[0].body).expectedOwnerId,owner);assert.equal(calls.at(-1).path,'/api/auth/me');
`));
test("a changed account cannot submit a decision and network failures do not retry it", () => check(`
 let writes=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path,options)=>{if(options.method==='POST')writes++;return new Response(JSON.stringify({user:{id:caseId,role:'attorney',status:'approved'}}));}});
 await assert.rejects(api.saveApplicationDecision(caseId,applicantId,sent,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(writes,0);assert.equal(lost,1);
 const failing=createApiClient({fetchImpl:async(path,options)=>{if(options.method==='POST'){writes++;throw new Error('network');}return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:{csrfToken:'synthetic'}));}});
 await assert.rejects(failing.saveApplicationDecision(caseId,applicantId,sent,{ownerId:owner}));assert.equal(writes,1);
`));
