const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("conversation-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; const ownerId='a'.repeat(24),caseId='b'.repeat(24),otherId='c'.repeat(24); ${source}`], { stdio: "pipe" }); };
test("conversation pages reject foreign identities, unbounded results and private raw attachments", () => check(`
const item={_id:otherId,caseId,type:'text',senderId:ownerId,text:'Private instruction',revision:'d'.repeat(64),createdAt:'2026-09-01T10:00:00Z',reactions:{'👍':[ownerId]},readBy:[ownerId],fileKey:'private/key'};
const page={caseId,messages:[item],nextCursor:null,targetMissing:false,writable:true};assert.equal(m.readConversation(page,caseId).messages[0].fileKey,undefined);assert.throws(()=>m.readConversation(page,otherId));assert.throws(()=>m.readConversation({...page,messages:Array(51).fill(item)},caseId));assert.throws(()=>m.readConversation({...page,nextCursor:'../../private'},caseId));assert.throws(()=>m.readConversation({...page,messages:[{...item,revision:'unknown'}]},caseId));
`));
test("only an exact message identity and sender can confirm sending", () => check(`
const message={_id:otherId,caseId,senderId:ownerId,type:'text'};assert.equal(m.confirmedMessage({message},caseId,ownerId),otherId);assert.throws(()=>m.confirmedMessage({message:{...message,senderId:otherId}},caseId,ownerId));assert.throws(()=>m.confirmedMessage({ok:true},caseId,ownerId));
`));
test("message drafts and uncertain requests remain in tab memory and clear with the account", () => check(`
const state=createPrivateState();state.conversations.set(caseId,{text:'Draft lease terms',pending:{id:'private-request-0001'}});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.conversations.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("a message write verifies identity and CSRF and never retries a lost response", () => check(`
const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});if(path==='/api/auth/me')return new Response(JSON.stringify({user:{id:ownerId,role:'attorney',status:'approved'}}));if(path==='/api/csrf')return new Response(JSON.stringify({csrfToken:'synthetic-token'}));throw new Error('Connection lost');}});await assert.rejects(api.sendWorkspaceMessage(caseId,'Recorded message','synthetic-request-0001',{ownerId}));const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic-token');assert.deepEqual(JSON.parse(writes[0].body),{text:'Recorded message',clientMessageId:'synthetic-request-0001',expectedOwnerId:ownerId});
`));
test("an account switch after sending discards the prior account's acknowledgement", () => check(`
let reads=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:++reads===1?ownerId:otherId,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic-token'}:{message:{_id:otherId,caseId,senderId:ownerId,type:'text'}}))});await assert.rejects(api.sendWorkspaceMessage(caseId,'Text','synthetic-request-0001',{ownerId}));assert.equal(lost,1);
`));
test("paged conversation merging replaces a changed record without duplicates", () => check(`
const old={id:ownerId,createdAt:'2026-09-01T10:00:00Z',text:'Old'};const current={...old,text:'Edited'};const next={id:otherId,createdAt:'2026-09-01T10:01:00Z'};assert.deepEqual(m.mergeMessages([old],[current,next]),[current,next]);
`));
