import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupportRequestStore } from '../../frontend/assets/scripts/utils/support-request-state.mjs';

const ownerId='111111111111111111111111', role='attorney';
const requestId='11111111-1111-4111-8111-111111111111';
const make=()=>({version:1,ownerId,role,requestId,conversationId:'222222222222222222222222',action:'send',createdAt:Date.now(),body:{text:'Exact question',sourcePage:'/attorney-v2.html#/help',pageContext:{viewName:'help',recentPages:['/help']},promptAction:null}});
function fixture(){let raw=null;const target={getItem:()=>raw,setItem:(key,value)=>{raw=value;},removeItem:()=>{raw=null;}};return {target,store:createSupportRequestStore({storage:()=>target}),raw:()=>raw,set:value=>{raw=value;}};}

test('exact input survives a new store instance without sharing mutable caller objects',()=>{
  const f=fixture(),record=make(),saved=f.store.save(record);record.body.pageContext.recentPages.push('/later');saved.body.text='changed';
  assert.deepEqual(createSupportRequestStore({storage:()=>f.target}).read({ownerId,role}).body,{text:'Exact question',sourcePage:'/attorney-v2.html#/help',pageContext:{viewName:'help',recentPages:['/help']},promptAction:null});
});
test('owner replacement discards the inaccessible record',()=>{const f=fixture();f.store.save(make());assert.equal(f.store.read({ownerId:'333333333333333333333333',role}),null);assert.equal(f.raw(),null);});
test('same owner role replacement also discards the record',()=>{const f=fixture();f.store.save(make());assert.equal(f.store.read({ownerId,role:'paralegal'}),null);assert.equal(f.raw(),null);});
test('late completion cannot clear a newer same-owner request',()=>{const f=fixture();const record={...make(),requestId:'22222222-2222-4222-8222-222222222222'};f.store.save(record);f.store.clear({ownerId,role,requestId});assert.deepEqual(f.store.read({ownerId,role}),record);});
test('matching completion and explicit account exit erase the record',()=>{const f=fixture();f.store.save(make());f.store.clear({ownerId,role,requestId});assert.equal(f.raw(),null);f.store.save(make());f.store.clear();assert.equal(f.raw(),null);});
test('malformed, oversized and invalid records never become a retry',()=>{for(const raw of ['{',JSON.stringify({...make(),action:'delete'}),JSON.stringify({...make(),requestId:'not-a-request'}),' '.repeat(120001)]){const f=fixture();f.set(raw);assert.equal(f.store.read({ownerId,role}),null);assert.equal(f.raw(),null);}});
test('invalid or excessive input is refused before persistence',()=>{for(const change of [{body:{...make().body,text:''}},{body:{...make().body,text:'x'.repeat(4001)}},{body:{...make().body,unexpected:true}},{body:{...make().body,pageContext:{long:'x'.repeat(120001)}}}]){const f=fixture();assert.throws(()=>f.store.save({...make(),...change}),{name:'SupportRequestStorageError'});assert.equal(f.raw(),null);}});
test('denied and silently discarded storage fail clearly',()=>{for(const target of [{getItem(){throw Error('denied');},setItem(){throw Error('denied');}},{getItem:()=>null,setItem(){}}])assert.throws(()=>createSupportRequestStore({storage:()=>target}).save(make()),{name:'SupportRequestStorageError'});});
test('failed reads and erasure are visible instead of treating storage as empty',()=>{const store=createSupportRequestStore({storage(){throw Error('denied');}});assert.throws(()=>store.read({ownerId,role}),{name:'SupportRequestStorageError'});assert.throws(()=>store.clear(),{name:'SupportRequestStorageError'});});
test('restart retains only its original navigation/context input',()=>{const f=fixture();const record={...make(),action:'restart',body:{sourcePage:'/attorney-v2.html#/help',pageContext:{viewName:'help'}}};f.store.save(record);assert.deepEqual(f.store.read({ownerId,role}),record);assert.throws(()=>f.store.save({...record,body:{...record.body,text:'surprise'}}),{name:'SupportRequestStorageError'});});
