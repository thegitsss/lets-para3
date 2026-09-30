const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("work-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; const ownerId='a'.repeat(24),caseId='b'.repeat(24),otherId='c'.repeat(24); ${source}`], { stdio: "pipe" }); };
test("work reviews bind each task to its Matter, revision and position", () => check(`
const item={id:null,index:0,title:'Review exhibit',completed:false,canToggle:true};const value={caseId,title:'Matter',revision:'d'.repeat(64),taskRevision:0,canToggle:true,canEditScope:false,completedLocked:false,reason:'ready',items:[item,{...item,index:1}]};assert.equal(m.readWork(value,caseId),value);assert.throws(()=>m.readWork(value,otherId));assert.throws(()=>m.readWork({...value,revision:'unknown'},caseId));assert.throws(()=>m.readWork({...value,items:[item,item]},caseId));assert.throws(()=>m.readWork({...value,completedLocked:true,items:[{...item,completed:true}]},caseId));
`));
test("closed and uncertain work notices do not imply an available completion action", () => check(`
assert.match(m.workNotice({reason:'decision_pending'}),/cannot be changed/);assert.match(m.workNotice({reason:'closed'}),/retained for reference/);assert.match(m.workNotice({reason:'ready',completedLocked:true}),/withdrawal and rehire/);
`));
test("the work write sends only the reviewed position and completion value, once, after identity and CSRF", () => check(`
const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});if(path==='/api/auth/me')return new Response(JSON.stringify({user:{id:ownerId,role:'attorney',status:'approved'}}));if(path==='/api/csrf')return new Response(JSON.stringify({csrfToken:'synthetic-token'}));throw new Error('lost response');}});await assert.rejects(api.updateWorkspaceWork(caseId,1,true,'d'.repeat(64),{ownerId}));const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].body),{index:1,completed:true,reviewedRevision:'d'.repeat(64),expectedOwnerId:ownerId});assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic-token');
`));
test("invalid task positions and account replacement stop an update", () => check(`
let writes=0;const api=createApiClient({fetchImpl:async(path,options)=>{if(options.method==='POST')writes++;return new Response(JSON.stringify({user:{id:otherId,role:'attorney',status:'approved'}}));}});assert.throws(()=>api.updateWorkspaceWork(caseId,-1,true,'d'.repeat(64),{ownerId}));await assert.rejects(api.updateWorkspaceWork(caseId,0,true,'d'.repeat(64),{ownerId}));assert.equal(writes,0);
`));
test("uncertain work decisions stay in page memory until rechecked or account protection clears them", () => check(`
const state=createPrivateState();state.workReviews.set(caseId,{pending:{index:0,completed:true}});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.workReviews.size,0);assert.equal(state.hasUnsaved(),false);
`));
