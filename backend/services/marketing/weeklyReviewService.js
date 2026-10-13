'use strict';
const Packet = require('../../models/MarketingDraftPacket');
const Cycle = require('../../models/MarketingPublishingCycle');
const ApprovalTask = require('../../models/ApprovalTask');
// One read projection over canonical drafts, never a second approval queue.
function weekStart(now) {
  const date = new Date(now);date.setUTCHours(0,0,0,0);
  date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));return date;
}
async function readWeeklyReview({now=new Date(),limit=40}={}) {
  const start=weekStart(now),end=new Date(start.getTime()+7*86400000),bound=Math.min(100,Math.max(1,Number(limit)||40));
  const filter={workflowType:'linkedin_company_post',$or:[{approvalState:'pending_review'},{updatedAt:{$gte:start,$lt:end}}]};
  const [packets,total]=await Promise.all([Packet.find(filter).select('briefId approvalState packetSummary createdAt updatedAt').sort({createdAt:1,_id:1}).limit(bound).lean(),Packet.countDocuments(filter)]);
  const registered=await ApprovalTask.find({targetType:'marketing_draft_packet',targetId:{$in:packets.map(row=>String(row._id))}}).select('targetId').lean();
  const reviewable=new Set(registered.map(row=>String(row.targetId)));
  const cycles=await Cycle.find({linkedinPacketId:{$in:packets.map(row=>row._id)}}).select('cycleLabel linkedinPacketId dueSlotAt settingsSnapshot.cadenceMode status').sort({createdAt:-1,_id:-1}).lean();
  const byPacket=new Map();for(const cycle of cycles)if(!byPacket.has(String(cycle.linkedinPacketId)))byPacket.set(String(cycle.linkedinPacketId),cycle);
  return {weekStart:start.toISOString(),weekEnd:end.toISOString(),timeZone:'UTC',total,limited:total>packets.length,items:packets.map(row=>{
    const cycle=byPacket.get(String(row._id));return {id:String(row._id),reviewAvailable:reviewable.has(String(row._id)),cycleId:cycle?String(cycle._id):null,title:cycle?.cycleLabel||row.packetSummary||'LinkedIn draft',approvalState:row.approvalState,olderPending:row.approvalState==='pending_review'&&new Date(row.createdAt)<start,updatedAt:row.updatedAt};
  })};
}
module.exports={readWeeklyReview,weekStart};
