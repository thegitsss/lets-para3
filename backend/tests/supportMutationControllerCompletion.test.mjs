import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupportRequestStore } from '../../frontend/assets/scripts/utils/support-request-state.mjs';
import { createSupportMutationController } from '../../frontend/assets/scripts/utils/support-mutation-controller.mjs';

const ownerId='111111111111111111111111',role='attorney',conversationId='222222222222222222222222',requestId='11111111-1111-4111-8111-111111111111';
const input=()=>({ownerId,role,conversationId,action:'send',body:{text:'Original question',sourcePage:'/attorney-v2.html#/help',pageContext:{viewName:'help'},promptAction:null}});
const descriptor=(state='succeeded',action='send')=>({id:requestId,action,state});
const result=()=>({request:descriptor(),conversation:{id:conversationId},userMessage:{id:'333333333333333333333333',text:'Original question'},assistantMessage:{id:'444444444444444444444444',text:'Recorded answer'}});
const response=(payload,status=200)=>({ok:status>=200&&status<300,status,json:async()=>payload});
function fixture(){let raw=null;const storage={getItem:()=>raw,setItem:(key,value)=>{raw=value},removeItem:()=>{raw=null}};const store=createSupportRequestStore({storage:()=>storage});return {store,raw:()=>raw,storage};}
function setup(request,options={}){const f=fixture(),states=[],results=[];const controller=createSupportMutationController({request,store:f.store,makeId:()=>requestId,onChange:s=>states.push(s),onResult:(value,record)=>results.push({value,record}),...options});return {...f,controller,states,results};}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}

test('acknowledged send applies exact IDs and clears its recovery record',async()=>{const f=setup(async()=>response(result(),201));await f.controller.begin(input());assert.equal(f.results.length,1);assert.equal(f.results[0].value.assistantMessage.id,result().assistantMessage.id);assert.equal(f.raw(),null);assert.equal(f.controller.snapshot().phase,'idle');});
test('lost response retains exact input and explicit Check makes no second POST',async()=>{const calls=[];const f=setup(async(path,options)=>{calls.push({path,options});if(options.method==='POST')throw Object.assign(Error('lost'),{dispatched:true});return response({request:descriptor(),result:result()});});const original=input();await f.controller.begin(original);original.body.text='Newer unrelated draft';assert.equal(f.controller.snapshot().phase,'uncertain');assert.equal(calls.length,1);await f.controller.check();assert.equal(calls.filter(c=>c.options.method==='POST').length,1);assert.equal(f.results[0].record.body.text,'Original question');assert.equal(f.raw(),null);});
test('reload restores one unresolved request and only checks when requested',async()=>{const first=setup(async()=>{throw Object.assign(Error('lost'),{dispatched:true})});await first.controller.begin(input());const calls=[];const reloaded=createSupportMutationController({store:first.store,request:async(path,options)=>{calls.push(options.method);return response({request:descriptor(),result:result()});}});assert.equal(reloaded.restore({ownerId,role}).pending.requestId,requestId);assert.deepEqual(calls,[]);await reloaded.check();assert.deepEqual(calls,['GET']);assert.equal(reloaded.snapshot().pending,null);});
test('404 means unknown; deliberate retry preserves the original ID and input',async()=>{const bodies=[];let posts=0;const f=setup(async(path,options)=>{if(options.method==='GET')return response({error:'not found'},404);bodies.push(options.body);if(posts++===0)throw Object.assign(Error('lost'),{dispatched:true});return response(result(),201);});await f.controller.begin(input());await f.controller.check();assert.equal(f.controller.snapshot().phase,'unknown');assert.equal(bodies.length,1);await f.controller.retry();assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[1].requestId,requestId);assert.equal(f.results.length,1);});
test('pending request does not automatically retry or accept another operation',async()=>{let calls=0;const f=setup(async()=>{calls++;return response({code:'SUPPORT_REQUEST_PENDING'},409)});await f.controller.begin(input());assert.equal(f.controller.snapshot().phase,'pending');await f.controller.retry();await f.controller.begin({...input(),body:{...input().body,text:'another'}});assert.equal(calls,1);assert.equal(f.controller.snapshot().pending.body.text,'Original question');});
test('durable retryable result permits an explicit same-ID retry',async()=>{const calls=[];const f=setup(async(path,options)=>{calls.push(options);return options.method==='GET'?response({request:descriptor('retryable'),result:null}):response({code:'SUPPORT_REQUEST_PENDING'},409)});await f.controller.begin(input());await f.controller.check();assert.equal(f.controller.snapshot().canRetry,true);await f.controller.retry();assert.equal(calls.length,3);assert.deepEqual(calls[0].body,calls[2].body);});
test('malformed or mismatched success never becomes an acknowledged message',async()=>{for(const value of [{...result(),request:{...descriptor(),id:'other'}},{...result(),assistantMessage:null},{...result(),conversation:{id:'555555555555555555555555'}},{...result(),userMessage:{...result().userMessage,text:'Different question'}}]){const f=setup(async()=>response(value,201));await f.controller.begin(input());assert.equal(f.results.length,0);assert.equal(f.controller.snapshot().phase,'uncertain');assert.ok(f.raw());}});
test('mismatched outcome action cannot replace the conversation',async()=>{let count=0;const f=setup(async()=>++count===1?response({code:'SUPPORT_REQUEST_PENDING'},409):response({request:descriptor('succeeded','restart'),result:result()}));await f.controller.begin(input());await f.controller.check();assert.equal(f.results.length,0);assert.equal(f.controller.snapshot().phase,'uncertain');});
test('stopping a wait retains recovery and ignores a late successful response',async()=>{const gate=deferred(),started=deferred();let signal;const f=setup(async(path,options)=>{signal=options.signal;started.resolve();return gate.promise});const work=f.controller.begin(input());try{await started.promise;f.controller.stopWaiting();assert.equal(signal.aborted,true);assert.equal(f.controller.snapshot().phase,'uncertain');assert.ok(f.raw());}finally{gate.resolve(response(result(),201));await work;}assert.equal(f.results.length,0);assert.ok(f.raw());});
test('account exit clears private request state and late JSON cannot restore it',async()=>{const gate=deferred(),started=deferred();const f=setup(async()=>({ok:true,status:201,json:async()=>{started.resolve();return gate.promise}}));const work=f.controller.begin(input());try{await started.promise;f.controller.clear();assert.equal(f.raw(),null);}finally{gate.resolve(result());await work;}assert.equal(f.results.length,0);assert.equal(f.controller.snapshot().pending,null);});
test('a verified pre-dispatch failure preserves a safely retryable request',async()=>{const f=setup(async()=>{throw Object.assign(Error('offline'),{kind:'unavailable',dispatched:false})});await f.controller.begin(input());assert.equal(f.controller.snapshot().phase,'retryable');assert.equal(f.controller.snapshot().pending.requestId,requestId);});
test('terminal request state requires a deliberate return before clearing',async()=>{const f=setup(async()=>response({code:'SUPPORT_CONVERSATION_CHANGED'},409));await f.controller.begin(input());assert.equal(f.controller.snapshot().phase,'failed');assert.ok(f.raw());assert.equal(f.controller.dismissFailed(),true);assert.equal(f.raw(),null);});
test('storage failure prevents dispatch instead of losing recovery',async()=>{let calls=0;const f=setup(async()=>{calls++;return response(result())},{store:{save(){throw Error('storage unavailable')}}});await assert.rejects(f.controller.begin(input()),/storage unavailable/);assert.equal(calls,0);assert.equal(f.controller.snapshot().pending,null);});
test('restart accepts only a different valid successor and its confirmed history',async()=>{const successor={request:descriptor('succeeded','restart'),conversation:{id:'555555555555555555555555'},messages:[]};const f=setup(async()=>response(successor,201));await f.controller.begin({...input(),action:'restart',body:{sourcePage:'/attorney-v2.html#/help',pageContext:{viewName:'help'}}});assert.equal(f.results.length,1);assert.equal(f.results[0].value.conversation.id,successor.conversation.id);assert.equal(f.raw(),null);});


test('a fresh tab can adopt an owner-bound server receipt without automatically posting',async()=>{
 const calls=[];const f=setup(async(path,options)=>{calls.push(options.method);return response({request:descriptor('retryable'),result:null});});
 const record={...input(),version:1,requestId,createdAt:Date.now()};
 f.controller.adopt(record,{ownerId,role});assert.deepEqual(calls,[]);
 await f.controller.check();assert.deepEqual(calls,['GET']);assert.equal(f.controller.snapshot().pending.body.text,'Original question');assert.equal(f.controller.snapshot().canRetry,true);
});
test('server recovery cannot adopt another owners or roles private request',()=>{
 const f=setup(async()=>{throw Error('unexpected request')});const record={...input(),version:1,requestId,createdAt:Date.now()};
 f.controller.adopt(record,{ownerId:'999999999999999999999999',role});assert.equal(f.raw(),null);
 f.controller.adopt(record,{ownerId,role:'paralegal'});assert.equal(f.raw(),null);assert.equal(f.controller.snapshot().pending,null);
});
test('manual handoff recovery checks and retries the same selected answer',async()=>{
 const calls=[];const messageId='444444444444444444444444';
 const payload={request:descriptor('succeeded','escalate'),conversation:{id:conversationId},assistantMessage:{id:messageId,text:'Recorded answer',metadata:{escalation:{requested:true}}},ticket:{id:'777777777777777777777777'}};
 const f=setup(async(path,options)=>{calls.push({path,options});return options.method==='GET'?response({request:descriptor('retryable','escalate')}):response(payload,201);});
 f.controller.adopt({...input(),version:1,requestId,createdAt:Date.now(),action:'escalate',body:{messageId,sourcePage:'',pageContext:{}}},{ownerId,role});
 await f.controller.check();await f.controller.retry();assert.equal(f.results.length,1);assert.match(calls[1].path,/\/escalate$/);assert.equal(calls[1].options.body.requestId,requestId);assert.equal(f.raw(),null);
});


test('a rejected competing draft yields to the server active receipt after its outcome is checked',async()=>{
 const f=setup(async(path,options)=>options.method==='POST'?response({code:'SUPPORT_CONVERSATION_BUSY'},409):response({request:descriptor('retryable'),result:null}));
 await f.controller.begin(input());
 const active={...input(),version:1,createdAt:Date.now(),requestId:'99999999-9999-4999-8999-999999999999',body:{...input().body,text:'Earlier interrupted question'}};
 f.controller.adopt(active,{ownerId,role},{replaceInactive:true});assert.equal(f.controller.snapshot().pending.requestId,requestId);
 await f.controller.check();f.controller.adopt(active,{ownerId,role},{replaceInactive:true});assert.equal(f.controller.snapshot().pending.requestId,active.requestId);
});
