const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../../frontend/assets/scripts");
const url = relative => JSON.stringify(pathToFileURL(path.join(root, relative)).href);
const run = body => { execFileSync(process.execPath, ["--input-type=module", "--eval", `
  import assert from 'node:assert/strict';
  import {createWorkspacePresenceController} from ${url("paralegal-v2/workspace-presence.mjs")};
  import {createApiClient} from ${url("attorney-v2/api-client.mjs")};
  const ownerId='a'.repeat(24),caseId='b'.repeat(24);
  ${body}
`], { stdio: "pipe", timeout: 10000 }); };

const environment = `
  globalThis.document=new EventTarget();document.hidden=false;
  globalThis.window=new EventTarget();let nextTimer=0;const timers=new Map();
  window.setInterval=fn=>{timers.set(++nextTimer,fn);return nextTimer;};window.clearInterval=id=>timers.delete(id);
  const calls=[];const api={post:async(path,body)=>{calls.push({method:'POST',body});return {success:true};},request:async(path,options)=>{calls.push({method:options.method,body:JSON.parse(options.body)});return {success:true};}};
`;

test("two paralegal browser contexts use distinct leases and one stopping leaves the other's heartbeat running", () => run(`
  ${environment}
  const first=createWorkspacePresenceController({api}),second=createWorkspacePresenceController({api});
  first.start(caseId,{surface:'messages'});second.start(caseId,{surface:'messages'});
  assert.notEqual(calls[0].body.presenceId,calls[1].body.presenceId);
  const firstId=calls[0].body.presenceId,secondId=calls[1].body.presenceId;
  first.stop();for(const callback of timers.values())callback();
  assert.deepEqual(calls.map(row=>[row.method,row.body.presenceId,row.body.revision]),[['POST',firstId,1],['POST',secondId,1],['DELETE',firstId,2],['POST',secondId,2]]);
  second.stop();assert.equal(timers.size,0);
`));

test("surface changes, visibility and stopping issue monotonically ordered paralegal intents", () => run(`
  ${environment}
  const controller=createWorkspacePresenceController({api});controller.start(caseId,{surface:'messages'});controller.start(caseId,{surface:'files'});
  document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));assert.equal(timers.size,0);
  document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));controller.stop();
  assert.deepEqual(calls.map(row=>[row.method,row.body.surface,row.body.revision]),[['POST','messages',1],['DELETE','messages',2],['POST','files',3],['DELETE','files',4],['POST','files',5],['DELETE','files',6]]);
  assert.equal(new Set(calls.map(row=>row.body.presenceId)).size,1);
`));

test("every paralegal Matter tab uses its server surface or clears presence without suppressing other content", () => run(`
  ${environment}
  const {MATTER_TABS}=await import(${url("paralegal-v2/deep-links.mjs")});
  const expected={overview:'overview',applications:null,work:'tasks',files:'files',messages:'messages',deadlines:'deadlines',activity:'history',financials:null};
  assert.deepEqual([...MATTER_TABS].sort(),Object.keys(expected).sort());
  for(const tab of MATTER_TABS){
    calls.length=0;
    const controller=createWorkspacePresenceController({api});
    controller.start(caseId,{surface:'messages'});controller.start(caseId,{surface:tab});controller.stop();
    const posts=calls.filter(row=>row.method==='POST');
    assert.deepEqual(posts.map(row=>row.body.surface),expected[tab]?['messages',expected[tab]]:['messages']);
    assert.equal(timers.size,0);
    assert.ok(calls.every(row=>row.body.surface!=='workspace'));
    if(expected[tab])assert.equal(calls.at(-1).body.surface,expected[tab]);
    else assert.deepEqual(calls.map(row=>row.method),['POST','DELETE']);
    assert.deepEqual(calls.map(row=>row.body.revision),calls.map((_,index)=>index+1));
  }
`));

test("attorney contexts have independent leases while repeated writes keep their own increasing revision", () => run(`
  const calls=[];const fetchImpl=async(path,options)=>{
    if(path==='/api/auth/me')return Response.json({user:{id:ownerId,role:'attorney',status:'approved'}});
    if(path==='/api/csrf')return Response.json({csrfToken:'local-presence-csrf'});
    calls.push({method:options.method,body:JSON.parse(options.body)});return Response.json({success:true});
  };
  const first=createApiClient({fetchImpl}),second=createApiClient({fetchImpl});
  await first.setWorkspacePresence(caseId,true,{ownerId});await second.setWorkspacePresence(caseId,true,{ownerId});await first.setWorkspacePresence(caseId,false,{ownerId});
  assert.notEqual(calls[0].body.presenceId,calls[1].body.presenceId);assert.equal(calls[0].body.presenceId,calls[2].body.presenceId);
  assert.deepEqual(calls.map(row=>[row.method,row.body.revision]),[['POST',1],['POST',1],['DELETE',2]]);
  assert.ok(calls.every(row=>row.body.expectedOwnerId===ownerId&&row.body.surface==='messages'));
`));

test("an attorney heartbeat delayed by its account check retains the older intent revision", () => run(`
  const calls=[];let release,hold=true;const gate=new Promise(resolve=>release=resolve);
  const api=createApiClient({fetchImpl:async(path,options)=>{
    if(path==='/api/auth/me'){if(hold){hold=false;await gate;}return Response.json({user:{id:ownerId,role:'attorney',status:'approved'}});}
    if(path==='/api/csrf')return Response.json({csrfToken:'local-presence-csrf'});
    calls.push({method:options.method,body:JSON.parse(options.body)});return Response.json({success:true});
  }});
  const earlier=api.setWorkspacePresence(caseId,true,{ownerId});await api.setWorkspacePresence(caseId,false,{ownerId});release();await earlier;
  assert.deepEqual(calls.map(row=>[row.method,row.body.revision]),[['DELETE',2],['POST',1]]);
  assert.equal(calls[0].body.presenceId,calls[1].body.presenceId);
`));

test("an unconfirmed attorney presence response is rejected", () => run(`
  const api=createApiClient({fetchImpl:async(path)=>Response.json(path==='/api/auth/me'?{user:{id:ownerId,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'local-presence-csrf'}:{})});
  await assert.rejects(api.setWorkspacePresence(caseId,true,{ownerId}),error=>error.kind==='invalid_response');
`));

test("disabling the same paralegal surface clears its existing hint", () => run(`
  ${environment}
  const controller=createWorkspacePresenceController({api});controller.start(caseId,{surface:'messages'});controller.start(caseId,{surface:'messages',enabled:false});
  assert.deepEqual(calls.map(row=>[row.method,row.body.revision]),[['POST',1],['DELETE',2]]);assert.equal(timers.size,0);
`));


test("paralegal page departure clears its exact lease with an unload-safe request and stops heartbeats", () => run(`
  ${environment}
  const requests=[];api.request=async(path,options)=>{requests.push({path,...options});return {success:true};};
  const controller=createWorkspacePresenceController({api});controller.start(caseId,{surface:'overview'});
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(timers.size,0);assert.equal(requests.length,1);assert.equal(requests[0].keepalive,true);
  assert.equal(requests[0].method,'DELETE');assert.deepEqual(JSON.parse(requests[0].body),{caseId,surface:'overview',presenceId:calls[0].body.presenceId,revision:2});
  window.dispatchEvent(new Event('pagehide'));assert.equal(requests.length,1);
`));
