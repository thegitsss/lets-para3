const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const moduleUrl = (name) => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
function check(program, timezone = "UTC") {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as s from ${JSON.stringify(moduleUrl("private-state"))}; import * as c from ${JSON.stringify(moduleUrl("candidate-model"))}; import {createApiClient} from ${JSON.stringify(moduleUrl("api-client"))}; ${program}`], { stdio: "pipe", env: { ...process.env, TZ: timezone } });
}

test.each(["UTC", "America/New_York", "Pacific/Honolulu", "Pacific/Kiritimati"])("weekly navigation retains calendar dates across DST/year/leap boundaries in %s", (timezone) => check(`
  assert.equal(s.weekKey('2026-01-01'), '2025-12-29');
  assert.equal(s.weekKey('2024-02-29'), '2024-02-26');
  assert.equal(s.moveWeek('2026-03-02', 1), '2026-03-09');
  assert.equal(s.moveWeek('2026-10-26', 1), '2026-11-02');
  assert.equal(s.weekKey('2026-02-30'), null);
  assert.equal(s.weekKey(null), null);
  assert.throws(() => s.readWeek({weekStart:'2026-08-24', notes:Array(7).fill('')}, '2026-08-31'));
`, timezone));
test("private draft state survives route reuse and clears completely at account boundaries", () => check(`
  const state = s.createPrivateState();
  state.setTask({title:'Private title'}); state.weeks.set('2026-08-31',{notes:['secret'],dirty:true});
  assert.equal(state.hasUnsaved(),true); state.clear(); assert.equal(state.hasUnsaved(),false);
  assert.equal(state.weeks.size,0); assert.deepEqual(state.task,{});
  state.contextualBlocks.set('matter:person',{pending:true}); assert.equal(state.hasUnsaved(),true); state.clear(); assert.equal(state.contextualBlocks.size,0); assert.equal(state.hasUnsaved(),false);
  assert.throws(()=>s.readTaskPage({items:[],total:'0',page:1,pages:0}));
`));
test("candidate projection omits private fields and public documents, and rejects foreign document/photo keys", () => check(`
  const id='a'.repeat(24), other='b'.repeat(24);
  const input={id,firstName:'Priya',lastName:'Test',bio:'Bio',email:'secret',stripeAccountId:'secret',preferences:{secret:true},notificationPrefs:{secret:true},identityDocumentKey:'secret',resumeURL:'paralegal-resumes/'+id+'/resume.pdf',availabilityDetails:{nextAvailable:'2027-01-01T00:00:00Z',updatedAt:'secret'}};
  const publicProfile=c.projectCandidate(input,id,'public'); const member=c.projectCandidate(input,id,'authenticated');
  assert.equal(JSON.stringify(publicProfile).includes('secret'),false); assert.equal(JSON.stringify(member).includes('secret'),false);
  assert.equal(publicProfile.documents,undefined); assert.equal(member.documents.length,1);
  assert.equal(c.safeDocumentKey('paralegal-resumes/'+other+'/resume.pdf',id),null);
  assert.equal(c.safeDocumentKey('paralegal-resumes/'+id+'/../x.pdf',id),null);
  assert.equal(c.profilePhoto('/api/users/profile-photo/'+id+'?variant=pending',id,'https://lpc.test'),'/assets/avatar-placeholder.svg');
  assert.equal(c.profilePhoto('/api/public/paralegals/'+id+'/photo?v=123',id,'https://lpc.test'),'/api/public/paralegals/'+id+'/photo?v=123');
  for(const bad of ['javascript:alert(1)','data:text/html,x','https://u:p@evil.test','https://good.test\\\\@evil.test']) assert.equal(c.safeSignedUrl(bad,'https://lpc.test'),null);
`));
test("candidate routes preserve only safe directory, Matter, applicant and return context", () => check(`
  const id='a'.repeat(24), matter='b'.repeat(24), applicant='c'.repeat(24);
  for(const value of ['https://evil.test','#/settings','#/paralegals?returnTo=https://evil.test','//evil.test']) {
    const result=c.safeCandidateReturn(value); assert.ok(result===null || !result.includes('evil'));
  }
  const query=new URLSearchParams({caseId:matter,applicantId:applicant,returnTo:'#/matters?view=applications&caseId='+matter,privateNote:'secret'});
  assert.ok(c.safeCandidateReturn('#/paralegals?caseId='+matter).includes(matter));
  const matterReturn = c.safeCandidateReturn('#/matters?view=applications&page=2&matterSort=alphabetical&q=contract&returnTo=https://evil.test');
  assert.ok(matterReturn.includes('page=2')); assert.ok(matterReturn.includes('matterSort=alphabetical')); assert.ok(!matterReturn.includes('evil'));
  const matterOnly = new URL(c.legacyCandidateHref(id,new URLSearchParams({caseId:matter})),'https://lpc.test');
  assert.ok(matterOnly.searchParams.get('returnTo').startsWith('/case-detail.html?caseId='+matter));
  assert.ok(c.candidateHref(id,query).includes(matter)); assert.equal(c.candidateHref(id,query).includes('secret'),false);
  const legacy=new URL(c.legacyCandidateHref(id,query),'https://lpc.test');
  const back=new URL(legacy.searchParams.get('returnTo'),'https://lpc.test');
  assert.equal(back.searchParams.get('applicantId'),applicant); assert.equal(back.searchParams.get('caseId'),matter);
`));
test("private operations verify the owner, carry CSRF, project exact bodies and never retry writes", () => check(`
  const owner='a'.repeat(24); const calls=[];
  const client=createApiClient({fetchImpl:async(path,options)=>{
    calls.push({path,...options});
    const payload=path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'csrf-synthetic'}:{error:'unconfirmed'};
    return {ok:options.method==='GET',status:options.method==='GET'?200:503,json:async()=>payload};
  }});
  await assert.rejects(client.createPrivateTask({title:'Private',notes:'Text',owner:'foreign',due:null,caseId:null},{ownerId:owner}));
  assert.deepEqual(calls.map(x=>x.path),['/api/auth/me','/api/csrf','/api/checklist']);
  const write=calls.at(-1); assert.equal(write.headers['X-CSRF-Token'],'csrf-synthetic'); assert.equal(write.credentials,'include');
  assert.deepEqual(JSON.parse(write.body),{title:'Private',notes:'Text',due:null,caseId:null});
  calls.length=0; await assert.rejects(client.togglePrivateTask('b'.repeat(24),{ownerId:'c'.repeat(24)}));
  assert.deepEqual(calls.map(x=>x.path),['/api/auth/me']);
`));


test("contextual block writes bind the reviewed owner and target and never retry an uncertain response", () => check(`
  const owner='a'.repeat(24), matter='b'.repeat(24), target='c'.repeat(24), calls=[];
  const client=createApiClient({fetchImpl:async(path,options)=>{
    calls.push({path,...options});
    const value=path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{error:'unconfirmed'};
    return {ok:options.method==='GET',status:options.method==='GET'?200:503,json:async()=>value};
  }});
  await assert.rejects(client.createContextualBlock(matter,target,{ownerId:owner,application:true}));
  const writes=calls.filter(call=>call.method==='POST'); assert.equal(writes.length,1); assert.equal(writes[0].path,'/api/blocks');
  assert.deepEqual(JSON.parse(writes[0].body),{caseId:matter,expectedBlockedId:target,paralegalId:target,expectedOwnerId:owner});
  assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');
  calls.length=0;
  await assert.rejects(client.createContextualBlock(matter,target,{ownerId:target,application:false}));
  assert.equal(calls.filter(call=>call.method==='POST').length,0);
`));
