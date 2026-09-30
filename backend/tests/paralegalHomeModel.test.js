const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const path = require("path");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "../../frontend/assets/scripts/paralegal-v2/home-model.mjs")).href;
const businessDatePath = path.resolve(__dirname, "../utils/businessDate.js");
function check(assertions) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import * as m from ${JSON.stringify(moduleUrl)};
    import businessDate from ${JSON.stringify(pathToFileURL(businessDatePath).href)};
    const userId='a'.repeat(24), otherId='b'.repeat(24), now=Date.parse('2026-09-08T15:00:00Z');
    const ok=value=>({available:true,value});
    const snapshot=()=>({
      userId, dashboard:ok({activeCases:[],metrics:{earnings:12.34,earningsLast30Days:56.78,earningsTotal:90.12}}),
      profile:ok({_id:userId,profileImage:'/api/users/me/photo',availability:'Available now',availabilityDetails:{status:'available'}}),
      stripe:ok({readiness:{ready:true,evidenceState:'verified'}}), recommendations:ok({items:[],hasMatchingProfile:true}),
      invites:ok({items:[]}), events:ok({items:[],total:0,pages:0}), threads:ok({threads:[],total:0,pages:0}), unread:ok({count:0}), applications:ok([]),
    });
    const matter=(id,patch={})=>({caseId:id,jobId:'job-'+id,title:'Matter '+id,paralegalId:userId,status:'in progress',archived:false,paymentReleased:false,escrowStatus:'funded',escrowIntentId:'pi-synthetic',tasksTotal:3,tasksRemaining:2,...patch});
    const application=(id,patch={})=>({_id:id,paralegalId:userId,caseId:'case-'+id,jobId:{_id:'job-'+id,title:'Application '+id,status:'open',caseId:'case-'+id},status:'submitted',createdAt:'2026-09-05T12:00:00Z',...patch});
    const invitation=(id,patch={})=>({_id:id,title:'Invitation '+id,status:'open',inviteStatus:'pending',inviteInvitedAt:'2026-09-07T12:00:00Z',...patch});
    const recommendation=(id,patch={})=>({_id:id,title:'Recommended '+id,status:'open',createdAt:'2026-09-06T12:00:00Z',...patch});
    const model=s=>m.buildHomeModel(s,{now,userId});
    ${assertions}
  `], { stdio: "pipe" });
}

describe("Paralegal Home state model", () => {
  test("A: approved empty work makes recommendations available without implying eligibility", () => check(`
    const s=snapshot();s.recommendations.value.items=[recommendation('r')];const v=model(s);
    assert.equal(v.attention.item.kind,'recommendation');assert.equal(v.activeWork.length,0);
    assert.equal(v.opportunities.recommendations[0].href,'/browse?matterId=r');
    assert.equal(v.opportunities.recommendations[0].eligible,undefined);
  `));

  test("B/C: invitation outranks application movement, while a verified request outranks both", () => check(`
    const s=snapshot();s.invites.value.items=[invitation('i')];s.applications.value=[application('a',{status:'shortlisted'})];
    assert.equal(model(s).attention.item.kind,'invitation');
    s.applications.value[0].preEngagement={status:'requested',requestedParalegalId:userId,conflictsCheckRequired:true,requestedAt:'2026-09-07T12:00:00Z'};
    const v=model(s);assert.equal(v.attention.item.kind,'request');assert.match(v.attention.item.detail,/conflicts/);
    assert.equal(v.activeWork.length,0);assert.equal(v.opportunities.applications[0].href,'/work?applicationId=a');
  `));

  test("D: one ordinary matter has honest continuation and authoritative progress", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('m')];const v=model(s);
    assert.equal(v.attention.item.kind,'workspace');assert.equal(v.activeWork[0].actionLabel,'Open workspace');
    assert.equal(v.activeWork[0].progress,'1 of 3 work items complete');
    assert.equal(v.activeWork[0].href,'/matter/m?tab=overview');
    assert.equal(v.activeWork[0].page,undefined);assert.equal(v.activeWork[0].revisions,undefined);
  `));

  test("E/G: overdue/current dates precede invitations; future dates use proximity without an urgency threshold", () => check(`
    const s=snapshot();s.invites.value.items=[invitation('i')];
    s.dashboard.value.activeCases=[matter('future',{deadlineDate:'2026-09-10'}),matter('today',{deadlineDate:'2026-09-08'}),matter('past',{deadlineDate:'2026-09-07'})];
    assert.equal(model(s).attention.item.id,'past');
    s.dashboard.value.activeCases=s.dashboard.value.activeCases.filter(x=>x.caseId!=='past');assert.equal(model(s).attention.item.id,'today');
    s.dashboard.value.activeCases=s.dashboard.value.activeCases.filter(x=>x.caseId!=='today');assert.equal(model(s).attention.item.kind,'invitation');
    s.invites.value.items=[];assert.equal(model(s).attention.item.id,'future');
    assert.match(model(s).attention.item.detail,/Upcoming matter deadline/);
  `));

  test("F: latest file does not manufacture urgency and unread does not imply a response", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('m',{latestFileName:'Synthetic brief.pdf'})];
    s.threads.value={threads:[{id:'m',title:'Matter m',unread:2,lastMessageSnippet:'Synthetic snippet',updatedAt:'2026-09-07T12:00:00Z'}],total:1,pages:1};s.unread.value.count=2;
    const v=model(s);assert.equal(v.attention.item.kind,'communication');assert.equal(v.communications.items[0].unread,2);
    assert.equal(v.activeWork[0].latestFileName,'Synthetic brief.pdf');
    assert.doesNotMatch(JSON.stringify(v.attention),/needs a response|new file|since your last visit/i);
    assert.equal(v.attention.candidates.filter(x=>x.groupId==='matter:m').length,1);
    s.dashboard.value.activeCases[0].latestUpdate='Attorney updated the brief';s.dashboard.value.activeCases[0].latestUpdateAt='2026-09-07T13:00:00Z';
    assert.equal(model(s).attention.item.kind,'update');
  `));

  test("priority tie breaks use deadline, event time and stable IDs independent of array order", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('z',{deadlineDate:'2026-09-07',latestUpdateAt:'2026-09-05T12:00:00Z'}),matter('b',{deadlineDate:'2026-09-07',latestUpdateAt:'2026-09-06T12:00:00Z'}),matter('a',{deadlineDate:'2026-09-07',latestUpdateAt:'2026-09-06T12:00:00Z'})];
    const before=model(s);assert.equal(before.attention.item.id,'a');s.dashboard.value.activeCases.reverse();
    assert.deepEqual(model(s).attention,before.attention);assert.deepEqual(model(s).activeWork,before.activeWork);
    s.invites.value.items=[invitation('z'),invitation('a')];s.dashboard.value.activeCases=[];
    assert.equal(model(s).attention.item.id,'a');s.invites.value.items.reverse();assert.equal(model(s).attention.item.id,'a');
  `));

  test("H/I: profile photo and payout requirements stay in the actions they block", () => check(`
    const s=snapshot();s.profile.value.profileImage='';s.stripe.value.readiness.ready=false;s.dashboard.value.activeCases=[matter('m')];
    let v=model(s);assert.equal(v.attention.item.kind,'workspace');assert.deepEqual(v.readiness.items,[]);assert.equal(v.activeWork[0].workspaceReady,true);
    s.recommendations.value.items=[recommendation('r')];v=model(s);assert.equal(v.readiness.profile,'incomplete');assert.equal(v.readiness.payout,'incomplete');
    assert.deepEqual(v.readiness.items.map(x=>x.id),['photo','payout']);assert.equal(v.attention.item.kind,'workspace');
    s.recommendations.value.items=[];s.invites.value.items=[invitation('i')];assert.deepEqual(model(s).readiness.items.map(x=>x.id),['payout']);
    s.stripe={available:false,error:{status:503}};assert.equal(model(s).readiness.payout,'unknown');
    assert.equal(model(s).opportunities.invitations[0].actionLabel,'Review invitation');
  `));

  test("matching profile fields affect recommendations, not the application photo requirement", () => check(`
    const s=snapshot();s.recommendations.value.hasMatchingProfile=false;
    const v=model(s);assert.equal(v.readiness.profile,'ready');assert.equal(v.readiness.items[0].id,'matching');
    assert.equal(v.readiness.items[0].scope,'recommendations');assert.equal(v.attention.item,null);
  `));

  test("J/K: successful empty, loading, unavailable and partial are distinct", () => check(`
    let s=snapshot();assert.equal(model(s).attention.state,'quiet');
    delete s.invites;assert.equal(model(s).attention.state,'loading');
    s.invites={available:false,error:{status:503}};assert.equal(model(s).attention.state,'unavailable');
    s.dashboard.value.activeCases=[matter('m')];let v=model(s);assert.equal(v.attention.state,'partial');assert.equal(v.attention.complete,false);assert.equal(v.activeWork.length,1);
    s.invites=ok({items:[]});assert.equal(model(s).attention.state,'ready');
  `));

  test("malformed successful payloads never become successful empty lists or financial zeros", () => check(`
    for(const [name,value] of [['dashboard',{}],['applications',null],['recommendations',{}],['threads',{}],['unread',{count:null}]]){
      const s=snapshot();s[name]=ok(value);const v=model(s);assert.equal(v.sources[name].state,'unavailable');assert.notEqual(v.attention.state,'quiet');
    }
    const s=snapshot();delete s.dashboard.value.metrics.earnings;assert.equal(model(s).history.metrics[0].value,null);
  `));

  test("L: account mismatch, logout, or late unauthorized data cannot produce protected rows", () => check(`
    for(const change of [s=>s.userId=otherId,s=>s.profile.value._id=otherId,s=>s.threads={available:false,error:{status:401}}]){
      const s=snapshot();s.dashboard.value.activeCases=[matter('m')];s.recommendations.value.items=[recommendation('r')];change(s);const v=model(s);
      assert.equal(v.activeWork.length,0);assert.equal(v.opportunities.recommendations.length,0);assert.equal(v.attention.item,null);assert.equal(v.attention.state,'restricted');assert.equal(v.history.metrics[0].value,null);
    }
    assert.equal(m.buildHomeModel(snapshot(),{now}).attention.state,'restricted');
  `));

  test("explicit current-profile restriction overrides an older approved session identity", () => check(`
    for(const patch of [{role:'attorney'},{role:'admin'},{status:'suspended'},{status:'pending'},{status:'denied'},{disabled:true},{deleted:true}]){
      const s=snapshot();Object.assign(s.profile.value,patch);s.dashboard.value.activeCases=[matter('m')];s.recommendations.value.items=[recommendation('r')];
      const v=model(s);assert.equal(v.attention.state,'restricted');assert.equal(v.activeWork.length,0);assert.equal(v.opportunities.recommendations.length,0);
      assert.equal(v.availability.canEdit,false);assert.equal(v.history.metrics[0].value,null);assert.equal(v.readiness.payout,'unknown');
    }
    const s=snapshot();Object.assign(s.profile.value,{role:'paralegal',status:'approved',disabled:false,deleted:false});assert.equal(model(s).attention.state,'quiet');
  `));

  test("stale values cannot restore current permission-sensitive records or released-payment totals", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('m')];s.dashboard.state='stale';let v=model(s);
    assert.equal(v.activeWork.length,0);assert.equal(v.history.metrics[0].value,null);assert.equal(v.attention.state,'stale');
    s.stale=true;v=model(s);assert.equal(v.availability.canEdit,false);assert.equal(v.readiness.payout,'unknown');
  `));

  test("non-current assignments, final records and missing funding evidence never open workspaces", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('other',{paralegalId:otherId}),matter('released',{paymentReleased:true}),matter('archived',{archived:true}),matter('completed',{status:'completed'}),matter('unfunded',{escrowStatus:'pending'}),matter('unknown',{archived:undefined})];
    const v=model(s);assert.deepEqual(v.activeWork.map(x=>x.id),['unfunded','unknown']);
    assert.ok(v.activeWork.every(x=>!x.workspaceReady && x.href==='/work'));assert.equal(v.attention.item,null);
    const legacy=matter('legacy');delete legacy.paralegalId;legacy.paralegal=userId;s.dashboard.value.activeCases=[legacy];assert.equal(model(s).activeWork[0].workspaceReady,true);
  `));

  test("resolved, wrong-recipient, funded and inaccessible pre-hiring requests are excluded", () => check(`
    const request={status:'requested',requestedParalegalId:userId};
    for(const patch of [{status:'withdrawn'},{status:'rejected'},{status:'hired'},{status:''},{casePaymentReleased:true},{caseEscrowStatus:'funded'},{paralegalId:otherId},{jobId:{_id:'job-a',status:'closed'}},{preEngagement:{...request,requestedParalegalId:otherId}},{preEngagement:{status:'requested'}}]){
      const s=snapshot();s.applications.value=[application('a',{preEngagement:request,...patch})];assert.notEqual(model(s).attention.item?.kind,'request');
    }
  `));

  test("embedded accepted invitations retain their application and supported deep link", () => check(`
    const s=snapshot();s.applications.value=[application('',{applicationSource:'invite_accept',caseId:'legacy',jobId:{_id:'legacy',caseId:'legacy',title:'Legacy application',status:'open'},preEngagement:{status:'requested',requestedParalegalId:userId}})];
    const v=model(s);assert.equal(v.opportunities.applications[0].id,'case:legacy');assert.equal(v.attention.item.href,'/work?jobId=legacy');assert.equal(v.activeWork.length,0);
  `));

  test("pending invitations require explicit status and cannot resurrect final or assigned work", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('active')];s.invites.value.items=[invitation('good'),invitation('missing',{inviteStatus:undefined}),invitation('accepted',{inviteStatus:'accepted'}),invitation('done',{status:'completed'}),invitation('assigned',{paralegalId:otherId}),invitation('active')];
    assert.deepEqual(model(s).opportunities.invitations.map(x=>x.id),['good']);
  `));

  test("the current-user invite projection is not overridden by the legacy first-pending invite pointer", () => check(`
    const s=snapshot();s.invites.value.items=[invitation('multiple',{pendingParalegalId:otherId})];
    assert.equal(model(s).opportunities.invitations[0].id,'multiple');
  `));

  test("recommendations exclude every application history, invitation and assigned matter without rematching", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('active')];s.applications.value=[application('old',{status:'withdrawn'})];s.invites.value.items=[invitation('invited')];
    s.recommendations.value.items=[recommendation('active'),recommendation('mirror',{jobId:'job-active'}),recommendation('case-old'),recommendation('job-old'),recommendation('invited'),recommendation('fresh'),recommendation('fresh')];
    assert.deepEqual(model(s).opportunities.recommendations.map(x=>x.id),['fresh']);
  `));

  test("opportunity previews use supplied scope and the existing gross-compensation display rules", () => check(`
    const s=snapshot();s.recommendations.value.items=[recommendation('r',{briefSummary:'Synthetic public scope',remainingAmount:25000,lockedTotalAmount:50000,budget:999})];
    s.invites.value.items=[invitation('i',{details:'Synthetic invitation scope',lockedTotalAmount:60000,currency:'USD',deadlineDate:'2026-09-20'})];
    const v=model(s);assert.equal(v.opportunities.recommendations[0].description,'Synthetic public scope');assert.equal(v.opportunities.recommendations[0].compensation,250);
    assert.equal(v.opportunities.invitations[0].compensation,600);assert.equal(v.opportunities.invitations[0].matterDeadline,'2026-09-20');
    assert.equal(v.opportunities.invitations[0].payout,undefined);
    s.recommendations.value.items=[recommendation('missing-rec')];s.invites.value.items=[invitation('missing-invite')];
    assert.equal(model(s).opportunities.recommendations[0].compensation,null);assert.equal(model(s).opportunities.invitations[0].compensation,null);
  `));

  test("date-only validation and New York midnight match the existing backend across DST", () => check(`
    for(const input of ['2026-02-29','2024-02-29','2026-04-31','2026-09-08T00:00:00Z','0099-01-01','not-a-date']) assert.equal(m.dateOnly(input),businessDate.normalizeDateOnly(input));
    for(const instant of ['2026-09-08T03:59:59Z','2026-09-08T04:00:00Z','2026-03-08T06:59:59Z','2026-03-08T07:00:00Z','2026-11-01T05:59:59Z','2026-11-01T06:00:00Z']) assert.equal(m.newYorkDateOnly(instant),businessDate.dateOnlyFromZonedInstant(instant));
    const s=snapshot();s.dashboard.value.activeCases=[matter('m',{deadlineDate:'2026-09-08'})];
    assert.equal(m.buildHomeModel(s,{now:Date.parse('2026-09-08T03:59:59Z'),userId}).activeWork[0].overdue,false);
    assert.equal(m.buildHomeModel(s,{now:Date.parse('2026-09-09T04:00:00Z'),userId}).activeWork[0].overdue,true);
  `));

  test("schedule keeps unresolved past Matter dates and distinguishes authorized private reminders", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('m',{deadlineDate:'2026-08-01'})];
    s.events.value={items:[{id:'reminder',owner:userId,caseId:'m',type:'deadline',start:'2026-09-09T12:00:00Z',isAllDay:true},{id:'meeting',type:'meeting',start:'2026-09-09T12:00:00Z'},{id:'revoked',caseId:'lost',type:'deadline',start:'2026-09-09T12:00:00Z'},{id:'done',caseId:'m',type:'deadline',start:'2026-09-09T12:00:00Z',completed:true},{id:'invalid',type:'deadline',start:'2026-02-29'},{id:'untimed',type:'deadline',isAllDay:false},{id:'personal',owner:userId,type:'deadline',start:'2026-09-08T03:00:00Z',isAllDay:false}],total:7,pages:1};
    const v=model(s);assert.deepEqual(v.deadlines.map(x=>x.id),['matter:m','event:personal','event:reminder']);
    assert.equal(v.deadlines[1].deadline,'2026-09-07');assert.equal(v.deadlines[1].href,'');assert.equal(v.deadlines[2].label,'Private reminder');
  `));

  test("bounded/paginated source coverage stays incomplete and inaccessible snippets are not exposed", () => check(`
    const s=snapshot();s.events.value={items:[],total:80,pages:2};s.threads.value={threads:[{id:'lost',unread:3,lastMessageSnippet:'Protected stale snippet'}],total:1,pages:1};s.unread.value.count=3;
    const v=model(s);assert.equal(v.sources.events.complete,false);assert.equal(v.attention.complete,false);assert.deepEqual(v.communications.items,[]);assert.equal(v.communications.unreadCount,3);
    assert.equal(v.attention.item.href,'/work');assert.doesNotMatch(JSON.stringify(v.communications),/Protected stale snippet/);
  `));

  test("availability uses authoritative return date and does not invent available state", () => check(`
    const s=snapshot();s.profile.value.availability='Unavailable';s.profile.value.availabilityDetails={status:'unavailable',nextAvailable:'2026-09-08'};
    assert.equal(model(s).availability.status,'available');s.profile.value.availabilityDetails.nextAvailable='2026-09-09';assert.equal(model(s).availability.status,'unavailable');
    s.profile.value={_id:userId};assert.equal(model(s).availability.status,'unknown');assert.equal(model(s).availability.canEdit,false);
    s.profile.value.availability='Available now';assert.equal(model(s).availability.canEdit,false);
    s.profile={available:false};assert.equal(model(s).availability.canEdit,false);
  `));

  test("released history preserves server dollar projections and never converts completion into payment", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('done',{status:'completed',paymentReleased:false})];s.dashboard.value.metrics.expectedPayouts=10000;
    assert.deepEqual(model(s).history.metrics.map(x=>x.value),[12.34,56.78,90.12]);assert.equal(model(s).history.completedCount,undefined);
    s.dashboard.value.metrics={};assert.ok(model(s).history.metrics.every(x=>x.value===null));
  `));

  test("model is pure: inputs are unchanged and no confidential full Matter fetch is needed", () => check(`
    const s=snapshot();s.dashboard.value.activeCases=[matter('m')];const before=JSON.stringify(s);model(s);assert.equal(JSON.stringify(s),before);
    const v=model(s);assert.equal(v.activeWork[0].detailsAvailable,undefined);assert.equal(v.activeWork[0].revisionNotes,undefined);
  `));
});

test('profile to-dos identify missing required fields without requiring work opportunities', () => check(`
  const s=snapshot();
  Object.assign(s.profile.value,{state:'',location:'',bio:'',skills:[],practiceAreas:[],resumeURL:'',profileImage:'',avatarURL:''});
  assert.deepEqual(model(s).profileTodos.map(x=>x.id),['primary-state','bio','skills','practice-areas','résumé','profile-photo']);
  assert.equal(model(s).profileTodos[0].href,'/settings?tab=profile&section=primary-state');
  Object.assign(s.profile.value,{state:'VA',bio:'Professional summary',skills:['Research'],practiceAreas:['Litigation'],resumeURL:'protected/resume.pdf',pendingProfileImage:'pending-photo'});
  assert.deepEqual(model(s).profileTodos,[]);
`));
test('profile to-dos do not infer missing fields from failed, stale, or wrong-owner reads', () => check(`
  const s=snapshot();s.profile={available:false,error:{status:503}};
  assert.deepEqual(model(s).profileTodos,[]);
  s.profile=ok({_id:userId});s.stale=true;assert.deepEqual(model(s).profileTodos,[]);
  s.stale=false;s.profile.value._id=otherId;assert.deepEqual(model(s).profileTodos,[]);
`));
