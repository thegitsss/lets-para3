const mongoose=require('mongoose');
const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
const Packet=require('../models/MarketingDraftPacket'),Cycle=require('../models/MarketingPublishingCycle');
const {readWeeklyReview,weekStart}=require('../services/marketing/weeklyReviewService');
beforeAll(connect);afterAll(closeDatabase);beforeEach(clearDatabase);
async function packet(state,date,workflow='linkedin_company_post'){
 const row=await Packet.create({briefId:new mongoose.Types.ObjectId(),packetVersion:1,workflowType:workflow,approvalState:state,packetSummary:'Synthetic reviewed draft'});
 await Packet.collection.updateOne({_id:row._id},{$set:{createdAt:new Date(date),updatedAt:new Date(date)}});return row;
}
test('weekly review includes unfinished older decisions, excludes retired channels and keeps canonical ids',async()=>{
 const now=new Date('2026-10-09T12:00Z'),older=await packet('pending_review','2026-09-20'),current=await packet('approved','2026-10-08');
 await packet('approved','2026-09-20');
 await Cycle.create({triggerSource:'manual',linkedinPacketId:older._id,cycleLabel:'Earlier batch'});
 const data=await readWeeklyReview({now});expect(data.total).toBe(2);expect(data.items).toEqual([expect.objectContaining({id:String(older._id),title:'Earlier batch',olderPending:true}),expect.objectContaining({id:String(current._id),approvalState:'approved',olderPending:false})]);
 expect(await Packet.countDocuments({approvalState:'pending_review'})).toBe(1);expect(weekStart(now).toISOString()).toBe('2026-10-05T00:00:00.000Z');
});
test('bounded review tells the owner when pending work extends beyond the displayed batch',async()=>{
 await packet('pending_review','2026-09-20');await packet('pending_review','2026-09-21');
 expect(await readWeeklyReview({now:new Date('2026-10-09T12:00Z'),limit:1})).toMatchObject({total:2,limited:true,items:[expect.any(Object)]});
});

test('a draft without its canonical approval task stays visible without a broken review action',async()=>{
 const now=new Date('2026-10-09T12:00Z'),registered=await packet('pending_review','2026-10-08'),orphan=await packet('pending_review','2026-10-08');
 const Task=require('../models/ApprovalTask');
 await Task.create({taskType:'marketing_review',targetType:'marketing_draft_packet',targetId:String(registered._id),title:'Synthetic registered review',approvalState:'pending'});
 const data=await readWeeklyReview({now});
 expect(data.items.find(row=>row.id===String(registered._id)).reviewAvailable).toBe(true);
 expect(data.items.find(row=>row.id===String(orphan._id)).reviewAvailable).toBe(false);
 expect(await Task.countDocuments()).toBe(1);expect(await Packet.countDocuments()).toBe(2);
});
