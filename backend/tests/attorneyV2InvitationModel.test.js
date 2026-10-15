const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("invitation-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {parseRoute} from ${JSON.stringify(url("routes"))}; ${source}`], { stdio: "pipe" }); };
test("invitation projections reject foreign accounts, Matter IDs and malformed records; unknown response is explicit", () => check(`
  const item={paralegal:{id:'a'.repeat(24),name:'Synthetic',available:true,email:'PRIVATE'},status:'unknown',invitedAt:null,respondedAt:null};
  const value={caseId:'case',ownerId:'owner',caseTitle:'Title',complete:true,invites:[item]}; assert.equal(m.readInvitations(value,'case','owner').invites[0].paralegal.email,undefined);
  assert.throws(()=>m.readInvitations(value,'other','owner'));assert.throws(()=>m.readInvitations(value,'case','other'),e=>e.kind==='authentication');
  for(const patch of [{status:'madeup'},{invitedAt:'invalid'},{respondedAt:{}},{paralegal:{...item.paralegal,id:'https://evil'}}]) assert.throws(()=>m.readInvitations({...value,invites:[{...item,...patch}]},'case','owner'));
  assert.equal(m.invitationStatus('accepted'),'Accepted invitation'); assert.equal(m.invitationStatus('unknown'),'Invitation status unavailable');
`));
test("profile links preserve Matter context and a safe return route", () => check(`
  const caseId='b'.repeat(24),invite={paralegal:{id:'a'.repeat(24),available:true}};const href=m.invitationProfileHref(invite,caseId);const query=new URLSearchParams(href.split('?')[1]);assert.equal(query.get('caseId'),caseId);assert.equal(query.get('returnTo'),'#/matters/'+caseId+'/invitations');assert.equal(parseRoute(query.get('returnTo')).name,'matter-invitations');
  assert.equal(m.invitationProfileHref({paralegal:{...invite.paralegal,available:false}},caseId),null);assert.equal(m.invitationProfileHref(invite,'invalid'),null);
`));
test("each invitation read verifies the session and sends expected account, no-store and cancellation", () => check(`
  const owner='a'.repeat(24),calls=[],controller=new AbortController();let lost=0;let account=owner;
  const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path,options)=>{calls.push({path,...options});return {ok:true,json:async()=>path==='/api/auth/me'?{user:{id:account,role:'attorney',status:'approved'}}:{invites:[]}};}});
  await api.readMatterInvitations('b'.repeat(24),{ownerId:owner,signal:controller.signal});assert.equal(calls.length,3);assert.ok(calls[1].path.endsWith('expectedOwnerId='+owner));assert.equal(calls[1].cache,'no-store');assert.equal(calls[1].method,'GET');
  account='c'.repeat(24);await assert.rejects(api.readMatterInvitations('b'.repeat(24),{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);assert.equal(calls.length,4);
`));
test("invitation inventory filters and sorts all retained records before paging without dropping duplicate history", () => check(`
 const owner='b'.repeat(24),caseId='c'.repeat(24),person='d'.repeat(24);
 const invites=Array.from({length:61},(_,i)=>({paralegal:{id:person,name:'Paralegal '+String(i).padStart(3,'0'),available:true,profileImage:null},status:i%2?'accepted':'pending',invitedAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),respondedAt:null}));
 const value=m.readInvitations({ownerId:owner,caseId,caseTitle:'Matter',complete:true,invites},caseId,owner);
 const last=m.invitationInventory(value,m.invitationFilters(new URLSearchParams('invPage=3')));assert.equal(last.total,61);assert.equal(last.invites.length,11);assert.equal(last.counts.pending,31);
 const older=m.invitationInventory(value,m.invitationFilters(new URLSearchParams('invStatus=pending&invSort=oldest&invSearch=Paralegal+00')));assert.equal(older.total,5);assert.equal(older.invites[0].paralegal.name,'Paralegal 000');assert.equal(value.invites.length,61);
 for(const query of ['invPage=0','invSort=random','invStatus=paid','invSearch=%00','invPage=1&invPage=2'])assert.throws(()=>m.invitationFilters(new URLSearchParams(query)));
`));
test("candidate return keeps invitation page ordering and filters", () => check(`
 const caseId='b'.repeat(24),invite={paralegal:{id:'a'.repeat(24),available:true}};
 const filters=m.invitationFilters(new URLSearchParams('invPage=3&invStatus=declined&invSort=oldest&invSearch=Élodie'));
 const href=m.invitationProfileHref(invite,caseId,false,'#/matters/'+caseId+'/invitations?'+m.invitationQuery(filters));
 const back=new URLSearchParams(href.split('?')[1]).get('returnTo');assert.deepEqual(m.invitationFilters(new URLSearchParams(back.split('?')[1])),filters);
`));
test("an account switch after loading an invitation list withholds its private names", () => check(`
 const owner='a'.repeat(24);let reads=0;
 const api=createApiClient({fetchImpl:async path=>({ok:true,status:200,json:async()=>path==='/api/auth/me'?{user:{id:++reads===1?owner:'b'.repeat(24),role:'attorney',status:'approved'}}:{invites:[{name:'Private'}]}})});
 await assert.rejects(api.readMatterInvitations('c'.repeat(24),{ownerId:owner}),e=>e.kind==='authentication');
`));
