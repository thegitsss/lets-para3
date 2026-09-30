import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {setSupportMatterContext,getSupportMatterContext,clearSupportMatterContext} from '../../frontend/assets/scripts/utils/support-workspace-context.mjs';
const owner='111111111111111111111111',other='222222222222222222222222',matter='333333333333333333333333';
for(const role of ['attorney','paralegal']) {
 const location={pathname:`/${role}-v2.html`,hash:role==='attorney'?`#/matters/${matter}/files`:`#/matter/${matter}?tab=files`};
 test(`${role}: hints require matching owner and exact current authorized route`,()=>{
  clearSupportMatterContext();const controller=new AbortController();
  setSupportMatterContext({ownerId:owner,role,matterId:matter,routeMatterId:matter,currentTab:'files',availableMatterTabs:['overview','files','bogus','files'],signal:controller.signal,location});
  const expected={caseId:matter,currentTab:'files',availableMatterTabs:['overview','files'],status:'',relationship:''};
  assert.deepEqual(getSupportMatterContext({ownerId:owner,role,location}),expected);
  assert.equal(getSupportMatterContext({ownerId:other,role,location}),null);
  assert.equal(getSupportMatterContext({ownerId:owner,role:role==='attorney'?'paralegal':'attorney',location}),null);
  assert.equal(getSupportMatterContext({ownerId:owner,role,location:{...location,hash:'#/help'}}),null);
  const copy=getSupportMatterContext({ownerId:owner,role,location});copy.availableMatterTabs.push('financials');assert.deepEqual(getSupportMatterContext({ownerId:owner,role,location}),expected);
  controller.abort();assert.equal(getSupportMatterContext({ownerId:owner,role,location}),null);
 });
 test(`${role}: invalid record or aborted read cannot publish context`,()=>{
  for(const args of [{matterId:other},{ownerId:'bad'},{routeMatterId:other},{signal:AbortSignal.abort()}]){
   clearSupportMatterContext();setSupportMatterContext({ownerId:owner,role,matterId:matter,routeMatterId:matter,currentTab:'files',availableMatterTabs:['files'],location,...args});
   assert.equal(getSupportMatterContext({ownerId:owner,role,location}),null);
  }
 });
 test(`${role}: stale cleanup cannot erase a newer verified context`,()=>{
  clearSupportMatterContext();const old=setSupportMatterContext({ownerId:owner,role,matterId:matter,routeMatterId:matter,currentTab:'files',availableMatterTabs:['files'],location});
  setSupportMatterContext({ownerId:owner,role,matterId:matter,routeMatterId:matter,currentTab:'files',availableMatterTabs:['files'],status:'completed',location});old();
  assert.equal(getSupportMatterContext({ownerId:owner,role,location}).status,'completed');clearSupportMatterContext();
  assert.equal(getSupportMatterContext({ownerId:owner,role,location}),null);
 });
 test(`${role}: replaced context removes its listener and leaves the current context intact`,()=>{
  clearSupportMatterContext();const controller=new AbortController();
  const options={ownerId:owner,role,matterId:matter,routeMatterId:matter,currentTab:'files',availableMatterTabs:['files'],signal:controller.signal,location};
  for(let i=0;i<25;i++){
   const clear=setSupportMatterContext(options);assert.equal(getEventListeners(controller.signal,'abort').length,1);
   clear();assert.equal(getEventListeners(controller.signal,'abort').length,0);
  }
  const old=setSupportMatterContext(options);setSupportMatterContext({...options,status:'completed'});old();
  assert.equal(getSupportMatterContext({ownerId:owner,role,location}).status,'completed');
  assert.equal(getEventListeners(controller.signal,'abort').length,1);
  controller.abort();assert.equal(getEventListeners(controller.signal,'abort').length,0);
  assert.equal(getSupportMatterContext({ownerId:owner,role,location}),null);
 });
}
