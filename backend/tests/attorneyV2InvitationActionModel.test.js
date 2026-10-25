const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("invitation-action-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))};
 const owner='a'.repeat(24),caseId='b'.repeat(24),paralegalId='c'.repeat(24), revision='d'.repeat(64);
 const value={caseId,ownerId:owner,paralegalId,caseTitle:'Matter',name:'Paralegal',revision,reason:'ready',canInvite:true,amountCents:40001,currency:'usd',amountLocked:false,invitation:null,relisted:false,remainingCents:null};
 ${source}`], { stdio: "pipe" }); };
test("only coherent exact-party invitation reviews offer send controls", () => check(`
 assert.equal(m.readInvitationReview(value,caseId,owner,paralegalId).canInvite,true);assert.equal(m.invitationAmount(value),'$400.01');
 for(const patch of [{ownerId:caseId},{caseId:owner},{paralegalId:owner},{revision:'bad'},{reason:'unknown'},{reason:'pending'},{amountCents:null},{amountCents:1.2},{currency:'bad currency'},{invitation:{status:'pending',invitedAt:null,respondedAt:null}}])assert.throws(()=>m.readInvitationReview({...value,...patch},caseId,owner,paralegalId));
 assert.equal(m.readInvitationReview({...value,reason:'pending',canInvite:false,invitation:{status:'pending',invitedAt:null,respondedAt:null}},caseId,owner,paralegalId).canInvite,false);
`));
test("paging validates owner, target, cursor and unique Matter references", () => check(`
 const page={ownerId:owner,paralegalId,cursor:'',next:null,matters:[{caseId,title:'Matter'}]};assert.equal(m.readInvitationOptions(page,owner,paralegalId).matters.length,1);
 for(const patch of [{ownerId:caseId},{paralegalId:owner},{cursor:caseId},{next:'invalid'},{matters:[{caseId,title:'Matter'},{caseId,title:'Duplicate'}]}])assert.throws(()=>m.readInvitationOptions({...page,...patch},owner,paralegalId));
`));
test("save confirmation must identify the reviewed paralegal, revision and amount", () => check(`
 const record={paralegalId,reviewedRevision:revision,amountCents:40001,invitedAt:'2026-09-07T00:00:00Z'};assert.ok(m.confirmInvitation({invitationConfirmation:record},value));
 for(const patch of [{paralegalId:owner},{reviewedRevision:'e'.repeat(64)},{amountCents:90000},{invitedAt:null}])assert.throws(()=>m.confirmInvitation({invitationConfirmation:{...record,...patch}},value));assert.throws(()=>m.confirmInvitation({success:true},value));
`));
test("unconfirmed invitations remain in tab memory and clear with account protection", () => check(`
 const state=createPrivateState();state.invitations.set(paralegalId,{caseId});assert.equal(state.hasUnsaved(),false);state.invitations.get(paralegalId).pending={caseId};assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.invitations.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("sending binds CSRF, owner and displayed revision, and does not retry a lost response", () => check(`
 const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});if(options.method==='POST')throw new Error('lost');return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:{csrfToken:'synthetic'}));}});
 await assert.rejects(api.sendReviewedInvitation(caseId,paralegalId,revision,{ownerId:owner}));const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');assert.deepEqual(JSON.parse(writes[0].body),{expectedOwnerId:owner,reviewedRevision:revision});
`));
test("a late account change discards the invitation response", () => check(`
 let reads=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:++reads>1?caseId:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{success:true}))});
 await assert.rejects(api.sendReviewedInvitation(caseId,paralegalId,revision,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
`));
