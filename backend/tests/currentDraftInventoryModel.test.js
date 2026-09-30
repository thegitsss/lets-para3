const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const model = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils/current-draft-inventory.mjs')).href;
const check = source => { execFileSync(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict';
import { createCurrentDraftInventory } from ${JSON.stringify(model)};
const ownerId='a'.repeat(24),id='b'.repeat(24);
const filters={view:'draft',search:'',practice:'',deadline:'',updated:'',sort:'recent',archiveStatus:'all',page:1,targetId:''};
const response=(f=filters)=>({ownerId,revision:'a'.repeat(64),filters:f,counts:{active:0,draft:1,archived:0,applications:0},practices:[],total:1,page:f.page,pageSize:15,pages:1,target:null,items:f.page===1?[{id,recordType:'draft',archiveBucket:false,status:'draft',revision:'b'.repeat(64)}]:[]});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
${source}`], { stdio: 'pipe' }); };

test('failed and malformed reads stay unavailable until explicit retry and retain no previous rows or false zero', () => check(`
 let reads=0,value=response();const changed=[];
 const model=createCurrentDraftInventory({ownerId,verifyOwner:async()=>ownerId,read:async()=>{reads++;return value;},onChange:s=>changed.push(s.phase)});
 await model.load(filters);assert.equal(model.state.result.total,1);
 value={};await model.load(filters,{force:true});assert.equal(model.state.phase,'unavailable');assert.equal(model.state.result,null);
 await model.load(filters);assert.equal(reads,2);
 value={...response(),total:0,counts:{...response().counts,draft:0},items:[]};await model.load(filters,{force:true});assert.equal(model.state.phase,'ready');assert.equal(model.state.result.total,0);
 assert.deepEqual(changed,['loading','ready','loading','unavailable','loading','ready']);
`));

test('an older search response cannot replace the newer selected draft page', () => check(`
 const first=deferred(),arrived=deferred();let aborted;
 const model=createCurrentDraftInventory({ownerId,verifyOwner:async()=>ownerId,read:async(f,{signal})=>{if(!f.search){aborted=signal;arrived.resolve();return first.promise;}return response(f);}});
 const pending=model.load(filters);await arrived.promise;
 const selected={...filters,search:'new'};await model.load(selected);first.resolve(response());await pending;
 assert.equal(aborted.aborted,true);assert.equal(model.state.key,JSON.stringify(selected));assert.equal(model.state.phase,'ready');
`));

test('clearing access discards pending private results even if the same account returns', () => check(`
 const held=deferred(),arrived=deferred();let count=0;
 const model=createCurrentDraftInventory({ownerId,verifyOwner:async()=>ownerId,read:async()=>{count++;arrived.resolve();return held.promise;}});
 const pending=model.load(filters);await arrived.promise;model.clear();held.resolve(response());await pending;
 assert.equal(model.state.result,null);assert.equal(model.state.phase,'unavailable');await model.load(filters);assert.equal(count,1);
 await model.load(filters,{force:true});assert.equal(model.state.phase,'ready');
`));

test('wrong owners and published or incomplete draft pages cannot authorize rows', () => check(`
 for(const transform of [r=>({...r,ownerId:id}),r=>({...r,items:[{...r.items[0],publishedCaseId:id}]}),r=>({...r,items:[]}),r=>({...r,counts:{...r.counts,draft:0}})]) {
 const model=createCurrentDraftInventory({ownerId,verifyOwner:async()=>ownerId,read:async()=>transform(response())});await model.load(filters);assert.equal(model.state.phase,'unavailable');assert.equal(model.state.result,null);
 }
`));

test('account changes during a draft read withhold its complete result', () => check(`
 let checks=0;const model=createCurrentDraftInventory({ownerId,verifyOwner:async()=>++checks===1?ownerId:id,read:async()=>response()});
 await model.load(filters);assert.equal(model.state.phase,'unavailable');assert.equal(model.state.result,null);
`));

test('current draft return links retain only bounded list context and discard nested object/tool redirects', () => check(`
 const {safeCurrentMatterReturn}=await import(new URL('../attorney-v2/matter-return.mjs',${JSON.stringify(model)}));
 const source='/dashboard-attorney.html?q=Estate+review&matterPractice=Probate&matterDeadline=none&matterUpdated=30_days&matterSort=alphabetical&draftPage=14&caseId='+id+'&returnTo=https%3A%2F%2Fexample.com#cases:draft';
 assert.equal(safeCurrentMatterReturn(source),'/dashboard-attorney.html?q=Estate+review&matterPractice=Probate&matterDeadline=none&matterUpdated=30_days&matterSort=alphabetical&draftPage=14#cases:draft');
 assert.equal(safeCurrentMatterReturn('/dashboard-attorney.html?q=one&q=two&draftPage=0&matterSort=bad#cases:draft'),'/dashboard-attorney.html#cases:draft');
 assert.equal(safeCurrentMatterReturn('/dashboard-attorney.html?activePage=7&draftPage=14&archivedPage=6&inquiriesPage=4#cases:draft'),'/dashboard-attorney.html?activePage=7&draftPage=14&archivedPage=6&inquiriesPage=4#cases:draft');
 assert.equal(safeCurrentMatterReturn('/dashboard-attorney.html?activePage=7&activePage=8&archivedPage=-1&inquiriesPage=1000001#cases:active'),'/dashboard-attorney.html#cases:active');
`));

test('current draft returns cannot navigate outside the Matter list or smuggle a second fragment', () => check(`
 const {safeCurrentMatterReturn}=await import(new URL('../attorney-v2/matter-return.mjs',${JSON.stringify(model)}));
 for(const value of ['https://example.com/dashboard-attorney.html#cases:draft','//example.com/dashboard-attorney.html#cases:draft','javascript:alert(1)','/create-case.html#cases:draft','/dashboard-attorney.html#tasks','/dashboard-attorney.html#cases:draft#other','/dashboard-attorney.html?q=hello world#cases:draft',null]) assert.equal(safeCurrentMatterReturn(value),null);
 assert.equal(safeCurrentMatterReturn('/dashboard-attorney.html?q=%00&draftPage=1000001#cases:draft'),'/dashboard-attorney.html#cases:draft');
`));
