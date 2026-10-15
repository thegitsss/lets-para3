const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const Approval = require('../models/IncidentApproval');
const Ticket = require('../models/SupportTicket');
const User = require('../models/User');
const {nextAdminTask,saveFollowUp} = require('../services/adminFlowService');
const {connect,clearDatabase,closeDatabase} = require('./helpers/db');
let owner,sequence=0;
beforeAll(connect);afterAll(closeDatabase);
beforeEach(async()=>{await clearDatabase();owner=await User.create({firstName:'Synthetic',lastName:'Owner',email:`related-${++sequence}@example.test`,password:'Synthetic owner password',role:'admin',status:'approved',emailVerified:true});});
const incident = extra => Incident.create({publicId:`synthetic-related-${new mongoose.Types.ObjectId()}`,source:'admin_created',summary:'One synthetic technical problem',originalReportText:'Local synthetic report',state:'awaiting_founder_approval',...extra});
const approval = (row,extra={}) => Approval.create({incidentId:row._id,attemptNumber:1,approvalType:'production_deploy',requiredByPolicy:true,requestedAt:new Date(),...extra});
const report = (row,extra={}) => Ticket.create({subject:'Related technical report',message:'Local fixture',requestKind:'support',routingSuggestion:{ownerKey:'incident_watch'},linkedIncidentIds:[row._id],riskFlags:['active_incident'],createdAt:new Date('2020-01-01'),updatedAt:new Date('2020-01-01'),...extra});

test('already handed-off reports share one current technical review while retaining every record and exact link',async()=>{
 const problem=await incident(),a=await report(problem),b=await report(problem),decision=await approval(problem);
 const before=await Ticket.find().sort({_id:1}).lean(),queue=await nextAdminTask({owner:owner._id,current:`inquiry:${a._id}`});
 expect(queue.items.map(item=>item.key)).toEqual([`incident:${decision._id}`]);expect(queue.remaining).toBe(1);expect(queue.total).toBe(1);
 expect(queue.task.relatedReportCount).toBe(2);expect(queue.task.relatedReports.map(row=>row.id).sort()).toEqual([String(a._id),String(b._id)].sort());
 expect(queue.currentPending).toBe(true);expect(queue.currentRevision).toBe(a.updatedAt.toISOString());
 expect(await Ticket.find().sort({_id:1}).lean()).toEqual(before);expect((await Approval.findById(decision._id)).status).toBe('pending');
});

test.each([
 ['human request',{requestKind:'human'}],['contact request',{requestKind:'contact'}],['financial decision',{riskFlags:['active_incident','money_sensitive']}],['account access',{riskFlags:['account_access']}],['another owner workflow',{routingSuggestion:{ownerKey:'support_ops'}}],['due ticket follow-up',{followUpAt:new Date('2020-01-01')}],
 ...['unknown','pending','disabled','failed'].map(delivery=>[`delivery ${delivery}`,{emailReplies:[{requestId:'unconfirmed',text:'Synthetic earlier reply',delivery}]}]),
])('a separate %s remains actionable beside the technical decision',async(_label,extra)=>{
 const problem=await incident(),r=await report(problem,extra),decision=await approval(problem),queue=await nextAdminTask({owner:owner._id});
 expect(new Set(queue.items.map(item=>item.key))).toEqual(new Set([`inquiry:${r._id}`,`incident:${decision._id}`]));expect(queue.remaining).toBe(2);
});

test.each(['missing incident','resolved incident','expired approval','multiple approvals','multiple linked problems'])('%s cannot hide an open report',async(kind)=>{
 const problem=await incident(kind==='resolved incident'?{state:'resolved'}:{}),r=await report(problem);let decision;
 if(kind!=='missing incident')decision=await approval(problem,kind==='expired approval'?{expiresAt:new Date('2020-01-01')}:{});
 else await Incident.deleteOne({_id:problem._id});
 if(kind==='multiple approvals')await approval(problem,{attemptNumber:2});
 if(kind==='multiple linked problems')await Ticket.updateOne({_id:r._id},{$push:{linkedIncidentIds:new mongoose.Types.ObjectId()}});
 expect((await nextAdminTask({owner:owner._id})).items.some(item=>item.key===`inquiry:${r._id}`)).toBe(true);
});

test('a deferred technical decision does not reappear as duplicate reports; new report facts return to attention',async()=>{
 const problem=await incident(),r=await report(problem),decision=await approval(problem),queue=await nextAdminTask({owner:owner._id});
 await saveFollowUp({owner:owner._id,key:queue.task.key,sourceRevision:queue.task.revision,revision:0,followUpAt:new Date(Date.now()+3600000).toISOString()});
 const deferred=await nextAdminTask({owner:owner._id});expect(deferred.task).toBeNull();expect(deferred.remaining).toBe(0);expect(deferred.followUps).toHaveLength(1);
 await Ticket.updateOne({_id:r._id},{$set:{latestUserMessage:'A new material fact',updatedAt:new Date(decision.updatedAt.getTime()+1000)}},{timestamps:false});
 const changed=await nextAdminTask({owner:owner._id});expect(changed.task.key).toBe(`inquiry:${r._id}`);expect(changed.followUps).toHaveLength(1);expect((await Ticket.findById(r._id)).status).toBe('open');
});

test('a personal report reminder stays a separate owner task and remains private',async()=>{
 const problem=await incident(),r=await report(problem);await saveFollowUp({owner:owner._id,key:`inquiry:${r._id}`,sourceRevision:r.updatedAt.toISOString(),revision:0,followUpAt:new Date(Date.now()+3600000).toISOString()});const decision=await approval(problem);
 const own=await nextAdminTask({owner:owner._id});expect(own.remaining).toBe(1);expect(own.followUps).toHaveLength(1);expect(own.task.relatedReportCount||0).toBe(0);
 const another=await User.create({firstName:'Another',lastName:'Owner',email:`another-${sequence}@example.test`,password:'Synthetic password',role:'admin',status:'approved'});
 const other=await nextAdminTask({owner:another._id});expect(other.remaining).toBe(1);expect(other.followUps).toEqual([]);expect(other.task.relatedReportCount).toBe(1);expect(other.task.key).toBe(`incident:${decision._id}`);
});

test('all grouped decisions remain reachable across pages; sharing a Matter does not merge distinct incidents',async()=>{
 const ids=[];for(let i=0;i<22;i++){const problem=await incident({context:{caseId:owner._id}});await report(problem);ids.push(String((await approval(problem))._id));}
 const first=await nextAdminTask({owner:owner._id}),second=await nextAdminTask({owner:owner._id,page:2});expect(first.remaining).toBe(22);expect(first.pages).toBe(2);expect(first.items).toHaveLength(20);expect(second.items).toHaveLength(2);
 expect([...first.items,...second.items].map(row=>row.id).sort()).toEqual(ids.sort());expect([...first.items,...second.items].every(row=>row.relatedReportCount===1)).toBe(true);
});

test('failed relationship lookup is an error rather than an empty checked queue',async()=>{
 const failure=jest.spyOn(Ticket,'aggregate').mockRejectedValueOnce(new Error('Synthetic relation lookup failure'));
 try{await expect(nextAdminTask({owner:owner._id})).rejects.toThrow('Synthetic relation lookup failure');}finally{failure.mockRestore();}
});

test.each(['decision completed','new report facts','another approval'])('%s during grouping cannot render a falsely empty checked queue',async(kind)=>{
 const problem=await incident(),r=await report(problem),decision=await approval(problem),original=Ticket.aggregate;
 const lookup=jest.spyOn(Ticket,'aggregate').mockImplementation(function(pipeline,...args){
  const result=original.call(this,pipeline,...args);
  if(!pipeline.some(stage=>stage.$lookup?.from==='incident_approvals'))return result;
  return result.then(async rows=>{
   if(kind==='decision completed')await Approval.updateOne({_id:decision._id},{$set:{status:'approved'}});
   else if(kind==='new report facts')await Ticket.updateOne({_id:r._id},{$set:{latestUserMessage:'New information'}});
   else await approval(problem,{attemptNumber:2});
   return rows;
  });
 });
 try{await expect(nextAdminTask({owner:owner._id})).rejects.toMatchObject({statusCode:409});}finally{lookup.mockRestore();}
});
