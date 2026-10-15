const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url'), path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils/earlier-application-withdrawal.mjs')).href;
function check(source) { execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {createEarlierApplicationWithdrawal} from ${JSON.stringify(moduleUrl)};
const application = {caseId:'a'.repeat(24),applicationSource:'case_applicant',withdrawal:{available:true,revision:'a'.repeat(64)}};
const response = {success:true,status:'withdrawn',caseId:application.caseId,alreadyRevoked:false};let owner='b'.repeat(24);
${source}`], { stdio: 'pipe' }); }

test('a pending withdrawal is single flight and its completion reaches the reopened view', () => check(`
 let release,writes=0;const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,post:()=>{writes++;return new Promise(resolve=>release=resolve);},get:()=>{throw Error('unexpected read');}});
 const first=api.act(application);assert.equal(api.state(application).pending,true);await api.act(application);assert.equal(writes,1);
 let seen;const stop=api.observe(application,state=>seen={pending:state.pending,saved:state.saved});release(response);await first;assert.deepEqual(seen,{pending:false,saved:true});stop();
 await api.act(application);assert.equal(writes,1);
`));

test('an unknown write requires a manual read and a new explicit confirmation of changed details', () => check(`
 let writes=0,reads=0;const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,post:async(_url,body)=>{writes++;if(writes===1)throw Error('lost');assert.equal(body.expectedRevision,'c'.repeat(64));return response;},get:async()=>{reads++;return [{...application,withdrawal:{available:true,revision:'c'.repeat(64)}}];}});
 await api.act(application);assert.equal(api.state(application).review,true);assert.equal(reads,0);await api.act(application);assert.equal(writes,1);assert.equal(reads,1);await api.act(application);assert.equal(writes,2);assert.equal(api.state(application).saved,true);
`));

for(const mutation of ['wrong-case','missing-success','malformed-outcome']) test(`${mutation} cannot acknowledge a withdrawal`,()=>check(`
 const bad={...response,...${JSON.stringify(mutation === 'wrong-case' ? { caseId: 'd'.repeat(24) } : mutation === 'missing-success' ? { success: false } : { alreadyRevoked: null })}};
 const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,post:async()=>bad,get:async()=>[]});await api.act(application);assert.equal(api.state(application).saved,false);assert.equal(api.state(application).review,true);
`));

test('account loss followed by the same account returning cannot revive an old acknowledgement',()=>check(`
 let release;const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,post:()=>new Promise(resolve=>release=resolve),get:async()=>[]});const action=api.act(application);api.clear();owner='c'.repeat(24);owner='b'.repeat(24);release(response);assert.equal(await action,null);assert.equal(api.state(application).saved,false);
`));

test('a failed manual read retains recovery and never submits again',()=>check(`
 let writes=0;const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,post:async()=>{writes++;throw Error('lost');},get:async()=>{throw Error('read unavailable');}});await api.act(application);await api.act(application);assert.equal(writes,1);assert.equal(api.state(application).review,true);
`));

test('an additional existing writer has the same explicit read recovery without repeating a lost write',()=>check(`
let writes=0,reads=0;const canonical={caseId:application.caseId,_id:'c'.repeat(24),status:'submitted'};
const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,resolveAdditionalAction:item=>item._id?{url:'/canonical/revoke',body:{},verify:r=>r.success===true}:null,post:async(url)=>{writes++;assert.equal(url,'/canonical/revoke');throw Error('Lost acknowledgement');},get:async()=>{reads++;return [{...canonical,status:'withdrawn'}];}});
await api.act(canonical);assert.equal(writes,1);assert.equal(api.state(canonical).review,true);assert.equal(reads,0);await api.act(canonical);assert.equal(writes,1);assert.equal(reads,1);assert.equal(api.state(canonical).saved,true);
`));

test('an unsupported source cannot invoke an additional writer and an invalid acknowledgement requires review',()=>check(`
let writes=0;const api=createEarlierApplicationWithdrawal({getOwner:()=>owner,post:async()=>{writes++;return {};},get:async()=>[],resolveAdditionalAction:item=>item._id?{url:'/canonical/revoke',body:{},verify:r=>r.success===true}:null});
await api.act({caseId:'d'.repeat(24)});assert.equal(writes,0);const canonical={caseId:application.caseId,_id:'c'.repeat(24)};await api.act(canonical);assert.equal(writes,1);assert.equal(api.state(canonical).saved,false);assert.equal(api.state(canonical).review,true);
`));
