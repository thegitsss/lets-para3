'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../frontend/assets/scripts/case-detail.js'),'utf8');
const tree=require('@babel/parser').parse(source,{sourceType:'module'});
const bodies=['getLatestMessageTimestamp','markCaseMessagesRead'].map(name=>{
  const node=tree.program.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);
  assert(node,'Real source function missing');return source.slice(node.start,node.end);
}).join('\n');
const id=n=>n.toString(16).padStart(24,'0'),early={_id:id(1),createdAt:'2026-10-15T10:00:00Z'},later={_id:id(2),createdAt:'2026-10-15T11:00:00Z'};
function fixture({target=id(1),visible=[early,later],csrf=async()=>{}}={}){
 const state={owner:id(10),target,activeCaseId:id(20),writes:[]};
 const context=vm.createContext({Date,encodeURIComponent,console,state,
  getRequestedMessageId:()=>state.target,getCurrentUserId:()=>state.owner,
  filterMessagesForViewer:()=>visible,fetchCSRF:()=>csrf(state),
  fetchWithFallback:async(urls,options)=>{state.writes.push(JSON.parse(JSON.stringify({urls,options})));return{};}});
 vm.runInContext(bodies+'\nglobalThis.mark=markCaseMessagesRead;',context);
 return {state,mark:()=>context.mark(id(20),[early,later])};
}
test('real legacy link code sends only the verified older boundary with owner and target binding',async()=>{
 const f=fixture();await f.mark();assert.deepEqual(f.state.writes,[{urls:['/api/messages/'+id(20)+'/read'],options:{method:'POST',headers:{'X-LPC-Owner-Id':id(10)},body:{upTo:'2026-10-15T10:00:00.000Z',messageId:id(1)},noRedirect:true}}]);
});
for(const kind of ['missing-visible-target','invalid-target-timestamp','missing-owner'])test('real link acknowledgement fails closed for '+kind,async()=>{
 const f=fixture({visible:kind==='missing-visible-target'?[later]:kind==='invalid-target-timestamp'?[{...early,createdAt:'invalid'}]:[early,later]});
 if(kind==='missing-owner')f.state.owner='';await f.mark();assert.equal(f.state.writes.length,0);
});
for(const kind of ['owner','target','case'])test('real link acknowledgement discards a late CSRF return after '+kind+' changes',async()=>{
 const f=fixture({csrf:async state=>{if(kind==='owner')state.owner=id(11);if(kind==='target')state.target=id(2);if(kind==='case')state.activeCaseId=id(21);}});
 await f.mark();assert.equal(f.state.writes.length,0);
});
test('ordinary non-target history retains the existing latest-timestamp acknowledgement body',async()=>{
 const f=fixture({target:''});await f.mark();assert.deepEqual(f.state.writes[0].options,{method:'POST',body:{upTo:'2026-10-15T11:00:00.000Z'},noRedirect:true});
});
