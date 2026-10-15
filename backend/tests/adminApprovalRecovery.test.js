const mongoose = require('mongoose');
jest.mock('../services/lpcEvents/routerService', () => ({routeEvent: jest.fn()}));
const { routeEvent } = require('../services/lpcEvents/routerService');
const { connect,clearDatabase,closeDatabase } = require('./helpers/db');
const { LpcEvent } = require('../models/LpcEvent');
const { publishApprovalDecisionEvent } = require('../services/approvals/eventService');
const { recoverApprovalDecisions } = require('../services/approvals/recoveryService');
const payload = () => ({decision:'approved',approvalRecordId:new mongoose.Types.ObjectId().toString(),approvalTargetType:'faq_candidate',approvalTargetId:new mongoose.Types.ObjectId().toString(),title:'Approved answer',actor:{actorType:'system'}});
beforeAll(connect);afterAll(closeDatabase);
beforeEach(async()=>{await clearDatabase();routeEvent.mockReset();routeEvent.mockImplementation(async(event,{claimToken})=>{
  await LpcEvent.updateOne({_id:event._id,'routing.claimToken':claimToken},{$set:{'routing.status':'routed','routing.claimToken':'','routing.leaseExpiresAt':null}});
});});
test('decision event commits with its approval and can route after a process restart',async()=>{
 const session=await mongoose.startSession();
 try{await session.withTransaction(async()=>{await publishApprovalDecisionEvent(payload(),{session});expect(routeEvent).not.toHaveBeenCalled();});}
 finally{await session.endSession();}
 expect(await LpcEvent.countDocuments({'routing.status':'pending'})).toBe(1);
 expect(await recoverApprovalDecisions()).toMatchObject({processed:1,failed:0,blocked:0});
 expect(await recoverApprovalDecisions()).toMatchObject({processed:0});
 expect(routeEvent).toHaveBeenCalledTimes(1);
});
test('rolled back approvals leave no event to recover',async()=>{
 const session=await mongoose.startSession();
 try{await expect(session.withTransaction(async()=>{await publishApprovalDecisionEvent(payload(),{session});throw new Error('rollback');})).rejects.toThrow('rollback');}
 finally{await session.endSession();}
 expect(await LpcEvent.countDocuments()).toBe(0);
});
test('overlapping workers claim a decision once and retries are bounded',async()=>{
 await publishApprovalDecisionEvent(payload(),{routeNow:false});
 await Promise.all([recoverApprovalDecisions(),recoverApprovalDecisions()]);
 expect(routeEvent).toHaveBeenCalledTimes(1);
 routeEvent.mockRejectedValue(new Error('unavailable'));
 const {event}=await publishApprovalDecisionEvent(payload(),{routeNow:false});
 for(let attempt=0;attempt<5;attempt++){
   await LpcEvent.updateOne({_id:event._id},{$set:{'routing.nextAttemptAt':null}});
   expect((await recoverApprovalDecisions()).failed).toBe(1);
 }
 expect(await recoverApprovalDecisions()).toEqual({processed:0,failed:0,blocked:1});
 expect((await LpcEvent.findById(event._id)).routing.attempts).toBe(5);
});
test('expired claims recover while a live claim is left alone',async()=>{
 const {event}=await publishApprovalDecisionEvent(payload(),{routeNow:false});
 await LpcEvent.updateOne({_id:event._id},{$set:{'routing.claimToken':'prior-process','routing.leaseExpiresAt':new Date(Date.now()+60000)}});
 expect((await recoverApprovalDecisions()).processed).toBe(0);
 await LpcEvent.updateOne({_id:event._id},{$set:{'routing.leaseExpiresAt':new Date(Date.now()-60000)}});
 expect((await recoverApprovalDecisions()).processed).toBe(1);
});
test('recovering an older decision cannot close a newer review alert for the same target',async()=>{
 const {LpcAction}=require('../models/LpcAction');
 const data=payload();
 const {event}=await publishApprovalDecisionEvent({...data,related:{approvalTaskId:data.approvalRecordId}},{routeNow:false});
 const action=await LpcAction.create({actionType:'founder_alert',status:'open',dedupeKey:`founder-alert:approval:${data.approvalTargetType}:${data.approvalTargetId}`,title:'New review',subject:{entityType:'approval_task',entityId:new mongoose.Types.ObjectId().toString()},related:{approvalTaskId:new mongoose.Types.ObjectId()},lastSeenAt:new Date(event.occurredAt.getTime()+1000)});
 await jest.requireActual('../services/lpcEvents/routerService').routeEvent(event);
 expect((await LpcAction.findById(action._id)).status).toBe('open');
});

test('an old knowledge approval preserves newer stale-knowledge alerts and follow-ups',async()=>{
 const {LpcAction}=require('../models/LpcAction');
 const knowledgeItemId=new mongoose.Types.ObjectId();
 const {event}=await publishApprovalDecisionEvent({...payload(),approvalTargetType:'knowledge_revision',related:{knowledgeItemId}},{routeNow:false});
 for(const [actionType,prefix] of [['founder_alert','founder-alert'],['lifecycle_follow_up','lifecycle']]) {
   await LpcAction.create({actionType,status:'open',dedupeKey:`${prefix}:knowledge-stale:${knowledgeItemId}`,title:'New review',subject:{entityType:'knowledge_item',entityId:String(knowledgeItemId)},lastSeenAt:new Date(event.occurredAt.getTime()+1000)});
 }
 await jest.requireActual('../services/lpcEvents/routerService').routeEvent(event);
 expect(await LpcAction.countDocuments({status:'open'})).toBe(2);
});
