const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const path = require("path");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "../../frontend/assets/scripts/paralegal-v2/home-model.mjs")).href;
const businessDatePath = path.resolve(__dirname, "../utils/businessDate.js");
function check(assertions) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import * as m from ${JSON.stringify(moduleUrl)};
    import {chooseWorkTab} from ${JSON.stringify(moduleUrl.replace('home-model','home-workspace-model'))};
    import businessDate from ${JSON.stringify(pathToFileURL(businessDatePath).href)};
    const userId='a'.repeat(24), otherId='b'.repeat(24), now=Date.parse('2026-09-08T15:00:00Z');
    const ok=value=>({available:true,value});
    const snapshot=()=>({
      userId, dashboard:ok({activeCases:[],metrics:{earnings:12.34,earningsLast30Days:56.78,earningsTotal:90.12}}),
      profile:ok({_id:userId,profileImage:'/api/users/me/photo',availability:'Available now',availabilityDetails:{status:'available'}}),
      stripe:ok({readiness:{ready:true,evidenceState:'verified'}}), recommendations:ok({items:[],hasMatchingProfile:true}),
      invites:ok({items:[]}), events:ok({items:[],total:0,pages:0}), threads:ok({threads:[],total:0,pages:0}), unread:ok({count:0}), applications:ok([]), notifications:ok([]), submissions:ok({matters:{}}),
    });
    const matter=(id,patch={})=>({caseId:id,jobId:'job-'+id,title:'Matter '+id,paralegalId:userId,status:'in progress',archived:false,paymentReleased:false,escrowStatus:'funded',escrowIntentId:'pi-synthetic',tasksTotal:3,tasksRemaining:2,...patch});
    const application=(id,patch={})=>({_id:id,paralegalId:userId,caseId:'case-'+id,jobId:{_id:'job-'+id,title:'Application '+id,status:'open',caseId:'case-'+id},status:'submitted',createdAt:'2026-09-05T12:00:00Z',...patch});
    const invitation=(id,patch={})=>({_id:id,title:'Invitation '+id,status:'open',inviteStatus:'pending',inviteInvitedAt:'2026-09-07T12:00:00Z',...patch});
    const recommendation=(id,patch={})=>({_id:id,title:'Recommended '+id,status:'open',createdAt:'2026-09-06T12:00:00Z',...patch});
    const model=s=>m.buildHomeModel(s,{now,userId});
    ${assertions}
  `], { stdio: "pipe" });
}


describe('Linear contract presentation authority',()=>{
 test('defaults preserve explicit choices and actionable cross-tab counts',()=>check(`
  const s=snapshot();s.dashboard.value.activeCases=[matter('m')];s.invites.value.items=[invitation('i')];s.applications.value=[application('a',{preEngagement:{status:'changes_requested',requestedParalegalId:userId,conflictsCheckRequired:true}})];
  let w=model(s).workspace;assert.equal(chooseWorkTab(w),'work');assert.equal(chooseWorkTab(w,'applications'),'applications');assert.equal(w.counts.invitations,1);assert.equal(w.counts.requests,1);
  s.dashboard.value.activeCases=[];assert.equal(chooseWorkTab(model(s).workspace),'invitations');s.invites.value.items=[];assert.equal(chooseWorkTab(model(s).workspace),'applications');s.applications.value=[];assert.equal(chooseWorkTab(model(s).workspace),'recommendations');
 `));
 test('actual revisions take priority once per matter and awaiting documents does not imply another actor',()=>check(`
  const s=snapshot();s.dashboard.value.activeCases=[matter('m',{status:'awaiting_documents',deadlineDate:'2026-09-01'}),matter('n',{status:'reviewing'}),matter('o',{status:'awaiting_documents'})];
  s.submissions.value.matters.m={state:'ready',value:{files:[{id:'f',uploadedByRole:'paralegal',status:'attorney_revision',revisionNotes:'Replace exhibit 4',revisionRequestedAt:'2026-09-07T12:00:00Z'},{id:'g',uploadedByRole:'paralegal',status:'attorney_revision',revisionNotes:'Fix citations'}]}};
  const w=model(s).workspace;assert.equal(w.tabs.work.length,3);assert.equal(w.tabs.work.find(r=>r.id==='m').group,'Needs your action');assert.equal(w.tabs.work.find(r=>r.id==='m').signals.length,2);assert.equal(w.tabs.work.find(r=>r.id==='o').group,'Active work');assert.equal(w.reviews.action.length,2);assert.equal(w.reviews.waiting.length,0);assert.equal(w.tabs.work[0].reference,'');
 `));
 test('submission state and matching revision cycle decide review responsibility',()=>check(`
  const s=snapshot();s.dashboard.value.activeCases=[matter('m',{tasksRemaining:0})];const files=[{id:'f',uploadedByRole:'paralegal',status:'attorney_revision',revisionRequestedAt:'2026-09-07T12:00:00Z'},{id:'r',uploadedByRole:'paralegal',status:'pending_review',revisionOfFileId:'f',revisionRequestAt:'2026-09-07T12:00:00Z'},{id:'a',uploadedByRole:'paralegal',status:'approved'},{id:'attorney',uploadedByRole:'attorney',status:'pending_review'}];s.submissions.value.matters.m={state:'ready',value:{files}};
  const w=model(s).workspace;assert.equal(w.reviews.action.length,0);assert.equal(w.reviews.waiting.length,1);assert.equal(w.reviews.history.length,1);assert.equal(w.tabs.work[0].group,'Waiting');
  files[1].revisionRequestAt='older';assert.equal(model(s).workspace.reviews.action.length,1);
 `));
 test('ordering uses due date, event time and canonical ID independent of source order',()=>check(`
  const s=snapshot();s.dashboard.value.activeCases=[matter('c',{deadlineDate:'2026-10-02'}),matter('b',{deadlineDate:'2026-10-01'}),matter('a',{deadlineDate:'2026-10-01'})];assert.deepEqual(model(s).workspace.tabs.work.map(r=>r.id),['a','b','c']);s.dashboard.value.activeCases.reverse();assert.deepEqual(model(s).workspace.tabs.work.map(r=>r.id),['a','b','c']);
 `));
 test('events are real notifications, not state-derived history or response obligations',()=>check(`
  const s=snapshot();s.dashboard.value.activeCases=[matter('m',{latestUpdate:'Scope updated',latestUpdateAt:'2026-09-08T12:00:00Z'})];assert.equal(model(s).workspace.events.length,0);
  s.notifications.value=[{id:'n',type:'case_update',message:'Matter was updated',createdAt:'2026-09-08T12:00:00Z',context:{},isRead:false}];const e=model(s).workspace.events[0];assert.equal(e.actor,'');assert.equal(e.unread,true);assert.equal(e.actionRequired,undefined);assert.equal(e.content,'Matter was updated');
 `));
 test('failed, stale and forbidden sources never produce fabricated empty success or confidential previews',()=>check(`
  const s=snapshot();s.dashboard.value.activeCases=[matter('m')];s.submissions.value.matters.m={state:'unavailable',value:null};assert.equal(model(s).workspace.reviewsComplete,false);s.submissions.value.matters.m.state='restricted';assert.equal(model(s).activeWork.length,0);assert.equal(model(s).workspace.reviewsComplete,false);assert.equal(model(s).workspace.reviewSources[0].state,'restricted');s.stale=true;assert.equal(model(s).workspace.tabs.work.length,0);assert.equal(model(s).workspace.events.length,0);
 `));
 test('acceptance cannot become a funded assignment; terminal applications cannot carry requests',()=>check(`
  const s=snapshot();s.applications.value=[application('a',{status:'hired',preEngagement:{status:'changes_requested',requestedParalegalId:userId}}),application('b',{applicationSource:'invite_accept'})];const w=model(s).workspace;assert.equal(w.tabs.work.length,0);assert.equal(w.counts.requests,0);assert.equal(w.tabs.applications.length,1);
 `));
});
