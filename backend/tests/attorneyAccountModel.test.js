const path=require("path");
const{execFileSync}=require("child_process");
const{pathToFileURL}=require("url");
const moduleUrl=name=>pathToFileURL(path.resolve(__dirname,`../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
function check(program){execFileSync(process.execPath,["--input-type=module","--eval",`import assert from 'node:assert/strict'; import {createAccountApi,accountPhoto} from ${JSON.stringify(moduleUrl("account-api"))}; import {createPrivateState} from ${JSON.stringify(moduleUrl("private-state"))}; globalThis.location={origin:'https://lpc.test'}; ${program}`],{stdio:"pipe"});}
test("account drafts crop bytes and failed preference intent clear at the private account boundary",()=>check(`
 const state=createPrivateState(); state.account.changes={lawFirm:'Private firm draft'}; state.account.photoSelection={file:new Uint8Array([1,2,3])}; state.account.preferenceRequests={theme:{requested:'dark'}};
 assert.equal(state.hasUnsaved(),true);state.clear();assert.deepEqual(state.account,{});assert.equal(state.hasUnsaved(),false);
 state.account.preferenceRequests={fontSize:{requested:'xl'}};assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.hasUnsaved(),false);
`));
test("account transport clears late private replies even when fetch ignores cancellation",()=>check(`
 const id='a'.repeat(24);let resolve;let calls=0;
 const api=createAccountApi({fetchImpl:async()=>{calls++;if(calls===1)return new Response(JSON.stringify({user:{id,role:'attorney',status:'approved'}}));return new Promise(done=>{resolve=done;});}});
 const pending=api.readProfile({ownerId:id});while(!resolve)await new Promise(done=>setTimeout(done,0));api.clear();resolve(new Response(JSON.stringify({_id:id,firstName:'Private',lastName:'Person',email:'private@example.test'})));await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(calls,2);
`));
test("account writes retain exact owner value and CSRF proof and do not leak server error text",()=>check(`
 const id='a'.repeat(24),calls=[];let lost=0;
 const api=createAccountApi({onAuthenticationLost:()=>lost++,fetchImpl:async(path,options)=>{calls.push({path,...options});return path==='/api/auth/me'?new Response(JSON.stringify({user:{id,role:'attorney',status:'approved'}})):path==='/api/csrf'?new Response(JSON.stringify({csrfToken:'synthetic-token'})):new Response(JSON.stringify({code:'ACCOUNT_CHANGED',error:'Confidential server internals'}),{status:403});}});
 await assert.rejects(api.savePreferences({theme:'dark'},{theme:'light'},{ownerId:id}),error=>error.kind==='authentication'&&!error.message.includes('Confidential'));
 assert.equal(lost,1);assert.equal(calls.length,3);assert.equal(calls[2].headers['X-CSRF-Token'],'synthetic-token');assert.equal(calls[2].credentials,'include');assert.equal(calls[2].cache,'no-store');assert.equal(calls[2].redirect,'error');assert.deepEqual(JSON.parse(calls[2].body),{theme:'dark',expectedValues:{theme:'light'},expectedOwnerId:id});
`));
test("account photos accept only the current owner's authenticated origin path",()=>check(`
 const id='a'.repeat(24);assert.equal(accountPhoto('/api/users/profile-photo/'+id+'?v=1',id),'/api/users/profile-photo/'+id+'?v=1');
 for(const value of ['https://evil.test/api/users/profile-photo/'+id,'/api/users/profile-photo/'+'b'.repeat(24),'javascript:alert(1)','data:image/png;base64,x','/api/users/profile-photo/'+id+'#other'])assert.equal(accountPhoto(value,id),'');
`));

test('pending photo removals protect unload and clear with the private owner scope',()=>check(`
 const state=createPrivateState();state.account.photoRemoval={expectedPhotoRevision:'a'.repeat(64)};assert.equal(state.hasUnsaved(),true);state.clear();assert.deepEqual(state.account,{});assert.equal(state.hasUnsaved(),false);
`));
