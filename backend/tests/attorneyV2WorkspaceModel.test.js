const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("workspace-model"))}; import {parseRoute} from ${JSON.stringify(url("routes"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; const ownerId='a'.repeat(24),caseId='b'.repeat(24),otherId='c'.repeat(24); ${source}`], { stdio: "pipe" }); };
test("all eight section addresses retain the exact Matter and selected record", () => check(`
 for(const tab of m.MATTER_TABS){const href=m.matterLink(caseId,tab,new URLSearchParams({messageId:otherId,returnTo:'https://outside.test',fileId:'invalid'}));const route=parseRoute(href);assert.equal(route.caseId,caseId);assert.equal(route.tab,tab);assert.equal(route.query.get('messageId'),otherId);assert.equal(route.query.has('returnTo'),false);assert.equal(route.query.has('fileId'),false);}assert.equal(m.matterLink('../x','overview'),null);
`));
test("a Matter response must identify an authorized owner and complete section contract", () => check(`
 const value={id:caseId,title:'Matter',status:'open',tasks:[],matterExperience:{version:1,header:{relationship:'Matter owner'},sections:m.MATTER_TABS.map(id=>({id})),overview:{},work:{},activity:[]}};assert.equal(m.readMatter(value,caseId),value);assert.throws(()=>m.readMatter({...value,id:otherId},caseId));assert.throws(()=>m.readMatter({...value,matterExperience:{...value.matterExperience,header:{relationship:'Applicant'}}},caseId));assert.throws(()=>m.readMatter({...value,tasks:[{title:'Review',completed:'false'}]},caseId));
 const raw={...value,_id:caseId};delete raw.id;assert.equal(m.readMatter(raw,caseId).id,caseId);assert.equal(raw.id,undefined);assert.throws(()=>m.readMatter({...raw,id:otherId},caseId));
`));
test("conversation entries keep exact Matter identity, audio text and safe references", () => check(`
 const value={messages:[{id:otherId,caseId,type:'audio',transcript:'Recorded words',fileKey:'private/key',fileName:'audio.webm',senderId:{id:ownerId,firstName:'Alex',lastName:'Lee'}}]};const [entry]=m.readMessages(value,caseId);assert.equal(entry.sender,'Alex Lee');assert.equal(entry.transcript,'Recorded words');assert.equal(entry.fileKey,undefined);assert.throws(()=>m.readMessages(value,ownerId));assert.throws(()=>m.readMessages({messages:[...value.messages,...value.messages]},caseId));assert.throws(()=>m.readMessages({error:'unavailable'},caseId));
`));
test("workspace reads verify the signed-in account on both sides of the protected response", () => check(`
 const calls=[];let checks=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path,options)=>{calls.push({path,...options});return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:++checks===1?ownerId:otherId,role:'attorney',status:'approved'}}:{id:caseId,title:'Private title'}));}});await assert.rejects(api.readWorkspaceMatter(caseId,{ownerId}));assert.equal(lost,1);assert.deepEqual(calls.map(c=>c.path),['/api/auth/me','/api/cases/'+caseId+'?expectedOwnerId='+ownerId,'/api/auth/me']);assert.ok(calls.every(c=>c.method==='GET'&&c.cache==='no-store'&&c.credentials==='include'&&c.redirect==='error'));
`));
test("route cancellation suppresses delayed Matter data without another request", () => check(`
 const controller=new AbortController();let calls=0;const api=createApiClient({fetchImpl:async(path)=>{calls++;if(path!='/api/auth/me')controller.abort();return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:ownerId,role:'attorney',status:'approved'}}:{id:caseId}));}});await assert.rejects(api.readWorkspaceMatter(caseId,{ownerId,signal:controller.signal}),{name:'AbortError'});assert.equal(calls,2);
`));
test("cached Matter headings are private tab memory and erase with session protection", () => check(`
 const state=createPrivateState();state.workspaceHeaders.set(caseId,{title:'Private Matter title'});assert.equal(state.hasUnsaved(),false);state.clear();assert.equal(state.workspaceHeaders.size,0);assert.match(m.matterNotice({status:'paused',pausedReason:'paralegal_withdrew'}),/withdrew/);assert.match(m.matterNotice({status:'completed'}),/closed to further work/);
`));
const decisionFixture = `
 const receipt={applicantId:otherId,applicationId:'d'.repeat(24),action:'reject',status:'rejected',starred:false};
 const before={id:caseId,title:'Reviewed Matter',status:'open',amount:40001,applicants:[{paralegalId:otherId,applicationId:receipt.applicationId,status:'pending',starred:false,name:'Applicant',profile:{bio:'Recorded bio'}}],matterExperience:{header:{relationship:'Matter owner'},applications:{items:[{id:otherId,status:'pending',name:'Applicant',preEngagementStatus:null}]},financials:{funded:false}}};
 const after=structuredClone(before);after.applicants[0].status='rejected';after.matterExperience.applications.items[0].status='rejected';
`;
test("only a confirmed decision advances its exact applicant status and star in the reviewed Matter", () => check(decisionFixture + `
 assert.deepEqual(m.acknowledgeApplicationDecision(before,after,receipt),after);assert.equal(before.applicants[0].status,'pending');
 const rawBefore=structuredClone(before),rawAfter=structuredClone(after);for(const value of [rawBefore,rawAfter]){value.applicants[0].paralegalId=otherId.toUpperCase();value.applicants[0].applicationId=receipt.applicationId.toUpperCase();value.matterExperience.applications.items[0].id=otherId.toUpperCase();}assert.deepEqual(m.acknowledgeApplicationDecision(rawBefore,rawAfter,receipt),rawAfter);
 const starred=structuredClone(before);starred.applicants[0].starred=true;
 assert.deepEqual(m.acknowledgeApplicationDecision(before,starred,{...receipt,action:'star',status:'submitted',starred:true}),starred);
 assert.deepEqual(m.acknowledgeApplicationDecision(starred,before,{...receipt,action:'unstar',status:'submitted'}),before);
 for(const status of ['shortlisted','submitted']){const next=structuredClone(before);next.applicants[0].status=status;next.matterExperience.applications.items[0].status=status;assert.deepEqual(m.acknowledgeApplicationDecision(before,next,{...receipt,action:status==='shortlisted'?'shortlist':'return',status}),next);}
`));
test("independent Matter, financial, profile, engagement and other applicant changes remain unacknowledged", () => check(decisionFixture + `
 const changes=[v=>v.title='New title',v=>v.status='paused',v=>v.amount=50000,v=>v.matterExperience.financials.funded=true,v=>v.matterExperience.header.relationship='Applicant',v=>v.applicants[0].profile.bio='Changed bio',v=>v.matterExperience.applications.items[0].preEngagementStatus='requested',v=>v.applicants.push({paralegalId:ownerId,status:'pending'}),v=>v.applicants[0].applicationId=ownerId];
 for(const change of changes){const changed=structuredClone(after);change(changed);const baseline=m.acknowledgeApplicationDecision(before,changed,receipt);assert.notDeepEqual(baseline,changed);assert.equal(baseline.title,before.title);assert.equal(baseline.amount,before.amount);assert.equal(baseline.applicants[0].profile.bio,before.applicants[0].profile.bio);}
`));
test("missing ambiguous mismatched and superseded decision records never refresh the reviewed context", () => check(decisionFixture + `
 for(const change of [v=>v.id=ownerId,v=>v.applicants=[],v=>v.applicants.push({...v.applicants[0]}),v=>v.matterExperience.applications.items.push({...v.matterExperience.applications.items[0]}),v=>v.matterExperience.applications.items=[],v=>v.applicants[0].status='withdrawn',v=>v.applicants[0].starred=true,v=>v.matterExperience.applications.items[0].status='pending']){const changed=structuredClone(after);change(changed);assert.equal(m.acknowledgeApplicationDecision(before,changed,receipt),before);}
 for(const patch of [{applicantId:ownerId},{applicationId:ownerId},{action:'hire'},{applicantId:null}])assert.equal(m.acknowledgeApplicationDecision(before,after,{...receipt,...patch}),before);
`));
test("earlier Matter entries acknowledge their exact pending category without inventing a canonical application identity", () => check(decisionFixture + `
 const legacy=structuredClone(before),rejected=structuredClone(after);legacy.applicants[0].applicationId=null;rejected.applicants[0].applicationId=null;
 assert.deepEqual(m.acknowledgeApplicationDecision(legacy,rejected,receipt),rejected);
 for(const status of ['submitted','viewed','shortlisted']){const starred=structuredClone(legacy);starred.applicants[0].starred=true;assert.deepEqual(m.acknowledgeApplicationDecision(legacy,starred,{...receipt,action:'star',status,starred:true}),starred);assert.equal(starred.applicants[0].applicationId,null);assert.equal(starred.applicants[0].status,'pending');}
 assert.equal(m.acknowledgeApplicationDecision(before,rejected,receipt),before);
 const changed=structuredClone(rejected);changed.applicants[0].profile.bio='Independent profile change';assert.notDeepEqual(m.acknowledgeApplicationDecision(legacy,changed,receipt),changed);
`));


test("a confirmed rejection advances only its exact derived pending count and review prompt", () => check(decisionFixture + `
 const action=count=>({code:'review_applications',label:'Review applications',detail:count+' application'+(count===1?'':'s')+' ready for review',tab:'applications'});
 for(const count of [1,2,251]){
  const prior=structuredClone(before),next=structuredClone(after);
  prior.matterExperience.applications.pendingCount=count;next.matterExperience.applications.pendingCount=count-1;
  prior.matterExperience.header={...prior.matterExperience.header,attention:'Applications available',primaryAction:action(count)};
  next.matterExperience.header={...next.matterExperience.header,attention:count>1?'Applications available':null,primaryAction:count>1?action(count-1):{code:'view_posting',label:'View posting',tab:'overview'}};
  assert.deepEqual(m.acknowledgeApplicationDecision(prior,next,receipt),next);
  for(const change of [v=>v.matterExperience.applications.pendingCount=count-2,v=>v.matterExperience.header.title='Independent title',v=>v.matterExperience.header.attention='Information needed before hiring',v=>v.matterExperience.header.primaryAction={code:'view_receipt',label:'View payments',tab:'financials'},v=>v.matterExperience.applications.items.push({id:ownerId,status:'rejected'})]){
   const changed=structuredClone(next);change(changed);assert.notDeepEqual(m.acknowledgeApplicationDecision(prior,changed,receipt),changed);
  }
 }
`));


test("received-application refresh checks its exact owner before and after the response", () => check(`
 const calls=[];let checks=0,lost=0;
 const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async path=>{calls.push(path);return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:++checks===1?ownerId:otherId,role:'attorney',status:'approved'}}:[]));}});
 await assert.rejects(api.readReceivedApplications({ownerId}));assert.equal(lost,1);
 assert.deepEqual(calls,['/api/auth/me','/api/applications/my-postings?expectedOwnerId='+ownerId,'/api/auth/me']);
`));


test("an account-loss response while refreshing received applications erases private controls", () => check(`
 let lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async path=>new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:ownerId,role:'attorney',status:'approved'}}:{code:'APPLICATION_ACCOUNT_CHANGED'}),{status:path==='/api/auth/me'?200:403})});
 await assert.rejects(api.readReceivedApplications({ownerId}),error=>error.kind==='authentication');assert.equal(lost,1);
`));

test("old Activity links to an exact calendar entry open Deadlines with context intact", () => check(`
 const query=new URLSearchParams({eventId:otherId,returnTo:'#/matters?view=archived&page=2'});
 const route=parseRoute('#/matters/'+caseId+'/activity?'+query);
 assert.equal(route.tab,'deadlines');assert.equal(route.caseId,caseId);assert.equal(route.query.get('eventId'),otherId);assert.equal(route.query.get('returnTo'),'#/matters?view=archived&page=2');
 assert.equal(parseRoute('#/matters/'+caseId+'/activity').tab,'activity');
 assert.equal(parseRoute('#/matters/'+caseId+'/activity?eventId=invalid').tab,'activity');
`));
