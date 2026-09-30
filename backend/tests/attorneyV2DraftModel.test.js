const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const url = (name) => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/${name}.mjs`)).href;
function check(program) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("matter-draft-contract"))}; import {newDraftState,createDraftSession} from ${JSON.stringify(url("matter-draft-session"))}; ${program}`], { stdio: "pipe" });
}
test('retained adapter refuses oversized stored text instead of silently clipping it', () => check(`
  const {retainedDraftApi}=await import(${JSON.stringify(url('attorney-v2/retained-draft-api'))});
  const state=newDraftState({id:'a'.repeat(24),descriptionLimit:100000});
  const posting={id:state.id,isDraft:true,revision:'b'.repeat(64),permissions:{canEdit:true,canDelete:true,amountLocked:false,tasksLocked:false},values:m.draftValues({title:'Retained title',description:'Supported text'})};
  const adapter=retainedDraftApi({get:async()=>({posting})},state);
  assert.equal((await adapter.get('/api/case-drafts/'+state.id)).draft.description,'Supported text');
  for(const extra of [{description:'x'.repeat(100001)},{title:'x'.repeat(301)},{tasks:[{title:'x'.repeat(201)}]}]){
    const values=posting.values;posting.values={...values,...extra};
    await assert.rejects(()=>adapter.get('/api/case-drafts/'+state.id),{code:'DRAFT_RETAINED_REVIEW_REQUIRED'});posting.values=values;
  }
`));
test('retained draft sessions preserve long descriptions during saves, lost-response recovery and conflict merges', () => check(`
  const abort=new AbortController(),state=newDraftState({id:'a'.repeat(24),descriptionLimit:100000});
  const long='Retained paragraph.\\n\\n'.repeat(400),opts={descriptionLimit:100000};
  let stored=m.draftValues({title:'Retained title',description:long,state:'NY'},opts),revision='a'.repeat(64),lost=true;
  const response=()=>({draft:{...stored,id:state.id,rawTitle:stored.title,revision}});
  const api={get:async()=>response(),saveMatterDraft:async(_id,values)=>{stored=values;revision='b'.repeat(64);if(lost){lost=false;throw new Error('lost')}return response()}};
  const session=createDraftSession(state,{signal:abort.signal,api});await session.check();
  assert.equal(state.values.description,long.trim());session.edit({...state.values,title:'Changed'});
  assert.equal(await session.save(),false);assert.equal(stored.description,long.trim());
  await session.check();assert.equal(state.values.description,long.trim());assert.equal(state.dirty,false);
  session.edit({...state.values,title:'My new title'});stored={...stored,state:'CA'};await session.check();
  assert.ok(state.conflict);session.choose(true);assert.equal(state.values.state,'CA');assert.equal(state.values.title,'My new title');assert.equal(state.values.description,long.trim());
  assert.equal(await session.save(),true);assert.equal(stored.description,long.trim());
  assert.equal(m.draftValues({description:long}).description.length,4000);abort.abort();
`));
test("draft contract preserves paragraphs and exact cents, validates review, and merges only edited fields", () => check(`
  const base=m.draftValues({title:'Original',description:'First\\n\\nSecond',compAmount:'400.01',practiceArea:'Contract Law',state:'NY',tasks:[{title:'Prepare'}]});
  assert.equal(base.description,'First\\n\\nSecond'); assert.equal(m.dollarCents('400.01'),40001);
  for(const bad of ['400.001','400 dollars','-400','Infinity','1e5']) assert.equal(m.dollarCents(bad),null);
  assert.equal(m.validDraftDate('2026-02-30'),false); assert.equal(m.validDraftDate('2028-02-29'),true);
  assert.deepEqual(m.draftErrors(base),{}); assert.ok(m.draftErrors({...base,tasks:[]}).tasks);
  const manyTasks=Array.from({length:26},(_,i)=>({title:'Task '+i}));
  assert.ok(m.draftErrors({...base,tasks:manyTasks}).tasks); assert.deepEqual(m.draftErrors({...base,tasks:manyTasks.slice(0,25)}),{});
  const merged=m.mergeDraft(base,{...base,title:'My edit'},{...base,title:'Other edit',state:'CA',tasks:[{title:'Other task'}]});
  assert.equal(merged.title,'My edit');assert.equal(merged.state,'CA');assert.equal(merged.tasks[0].title,'Other task');
  assert.throws(()=>m.readDraft({draft:{id:'a'.repeat(24),revision:'a'.repeat(64),...base}}));
`));
test("an uncertain create is resolved by reading its token, without retrying, and later typing is retained", () => check(`
  const abort=new AbortController(), state=newDraftState({requestId:'12345678-1234-4234-9234-123456789012'});
  let saved=null, writes=0;
  const response=()=>({draft:{...saved,id:'a'.repeat(24),rawTitle:saved.title,revision:'a'.repeat(64)}});
  const session=createDraftSession(state,{ownerId:'b'.repeat(24),signal:abort.signal,api:{
    get:async()=>{if(!saved) throw Object.assign(new Error(),{status:404});return response()},
    createMatterDraft:async values=>{writes++;saved=values;throw new Error('lost response')}
  }});
  await session.check(); session.edit(m.draftValues({title:'First write'})); assert.equal(await session.save(),false);
  session.edit(m.draftValues({title:'More typing'})); assert.equal(await session.save(),false); assert.equal(writes,1);
  await session.check(); assert.equal(state.id,'a'.repeat(24)); assert.equal(state.values.title,'More typing'); assert.equal(state.dirty,true); assert.equal(state.uncertain,false); assert.equal(writes,1);
  abort.abort();
`));
test("conflicts require explicit choice, preserve remote untouched fields, and deleted identities are not recreated", () => check(`
  const abort=new AbortController(), state=newDraftState({id:'a'.repeat(24),requestId:'12345678-1234-4234-9234-123456789012'});
  let remote=m.draftValues({title:'Base',state:'NY'}), missing=false, saves=0;
  const session=createDraftSession(state,{signal:abort.signal,api:{get:async()=>{if(missing)throw Object.assign(new Error(),{status:404}); return {draft:{...remote,id:state.id,rawTitle:remote.title,revision:'b'.repeat(64)}}},saveMatterDraft:async()=>{saves++;throw Object.assign(new Error(),{status:409})}}});
  await session.check();session.edit({...state.values,title:'Local'});remote={...remote,title:'Remote',state:'CA'};
  await session.save();await session.check();assert.ok(state.conflict);assert.equal(state.values.title,'Local');
  session.choose(true);assert.equal(state.values.title,'Local');assert.equal(state.values.state,'CA');assert.equal(saves,1);
  missing=true;await session.check();assert.equal(state.missing,true);assert.equal(await session.save(),false);assert.equal(saves,1);abort.abort();
`));
test("typing during a write is saved sequentially and save-and-exit waits for the last edit", () => check(`
  const abort=new AbortController(), state=newDraftState({id:'a'.repeat(24)});let release, submitted, calls=0;
  const gate=new Promise(resolve=>release=resolve), reply=values=>({draft:{...values,id:state.id,rawTitle:values.title,revision:'a'.repeat(64)}});
  const session=createDraftSession(state,{signal:abort.signal,api:{get:async()=>reply(m.draftValues()),saveMatterDraft:async(_id,values)=>{calls++;submitted=values;if(calls===1)await gate;return reply(values)}}});
  await session.check();session.edit(m.draftValues({title:'First'}));const save=session.save();session.edit(m.draftValues({title:'Last'}));release();assert.equal(await save,true);
  assert.equal(calls,2);assert.equal(submitted.title,'Last');assert.equal(state.dirty,false);abort.abort();
`));
test("undoing an uncertain write back to the baseline is retained when its response is recovered", () => check(`
  const abort=new AbortController(),state=newDraftState({id:'a'.repeat(24)}); let stored=m.draftValues({title:'Original'});
  const session=createDraftSession(state,{signal:abort.signal,api:{get:async()=>({draft:{...stored,id:state.id,rawTitle:stored.title,revision:'a'.repeat(64)}}),saveMatterDraft:async(_id,values)=>{stored=values;throw new Error('lost')}}});
  await session.check();session.edit(m.draftValues({title:'Changed'}));await session.save();session.edit(m.draftValues({title:'Original'}));
  await session.check();assert.equal(state.values.title,'Original');assert.equal(state.base.title,'Changed');assert.equal(state.dirty,true);abort.abort();
`));
test("a lost delete followed by missing access cannot confirm deletion or recreate the draft", () => check(`
  const abort=new AbortController(),state=newDraftState({id:'a'.repeat(24)});let missing=false,deletes=0,saves=0;
  const session=createDraftSession(state,{signal:abort.signal,api:{get:async()=>{if(missing)throw Object.assign(new Error(),{status:404});return {draft:{...m.draftValues({title:'Retained text'}),id:state.id,rawTitle:'Retained text',revision:'a'.repeat(64)}}},deleteMatterDraft:async()=>{deletes++;missing=true;throw new Error('lost')},saveMatterDraft:async()=>{saves++}}});
  await session.check();assert.equal(await session.remove(),false);assert.equal(await session.check(),false);
  assert.equal(state.deleted,false);assert.equal(state.missing,true);assert.equal(state.uncertain,true);assert.equal(state.values.title,'Retained text');assert.match(state.error,/Deletion was not confirmed/);
  assert.equal(await session.remove(),false);assert.equal(await session.save(),false);assert.equal(deletes,1);assert.equal(saves,0);abort.abort();
`));
test("a confirmed draft deletion clears the text and repeated removal sends no request", () => check(`
  const abort=new AbortController(),state=newDraftState({id:'a'.repeat(24)});let deletes=0;
  const session=createDraftSession(state,{signal:abort.signal,api:{get:async()=>({draft:{...m.draftValues({title:'Retained text'}),id:state.id,rawTitle:'Retained text',revision:'a'.repeat(64)}}),deleteMatterDraft:async()=>{deletes++;return {success:true}}}});
  await session.check();assert.equal(await session.remove(),true);assert.equal(state.deleted,true);assert.equal(state.values.title,'');assert.equal(await session.remove(),false);assert.equal(deletes,1);abort.abort();
`));
test('requirements survive draft normalization and concurrent field merges', () => check(`
  const base=m.draftValues({title:'Original',requirements:['Clio proficiency']});
  const local={...base,requirements:['Virginia litigation experience']};
  const remote={...base,title:'Remote title'};
  const merged=m.mergeDraft(base,local,remote);
  assert.deepEqual(merged.requirements,local.requirements);assert.equal(merged.title,'Remote title');
  assert.equal(m.sameDraft(base,local),false);
  assert.deepEqual(m.mergeDraft(base,{...base,title:'Local'},local).requirements,local.requirements);
  assert.ok(m.draftErrors({...base,requirements:['Clio','clio']}).requirements);
  assert.deepEqual(m.draftValues({}).requirements,[]);
  assert.equal(m.hasDraftContent(m.draftValues({requirements:['Clio proficiency']})),true);
`));
