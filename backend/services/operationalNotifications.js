"use strict";
const mongoose=require('mongoose');
const {randomUUID,createHash}=require('crypto');
const State=require('../models/OpsMonitorState');
const {getOwnerAlertRecipients}=require('../utils/opsAlerting');
const validEmail=value=>/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
async function persistMonitorState(summary,{noticeKind=null}={}){
 if(noticeKind&&!['failure','recovery','fatal'].includes(noticeKind))throw new Error('Invalid operational notification kind.');
 const recipients=[...new Set(getOwnerAlertRecipients().map(value=>value.toLowerCase()))];
 if(noticeKind&&(!recipients.length||recipients.some(value=>!validEmail(value))))throw Object.assign(new Error('Operational alert recipients are unavailable.'),{code:'MISSING_RECIPIENTS'});
 const indexes=await State.collection.indexes();
 if(!indexes.some(index=>index.unique&&JSON.stringify(index.key)===JSON.stringify({key:1})))throw new Error('Operational notification state index is unavailable.');
 const session=await mongoose.startSession();let result;
 try{
  await session.withTransaction(async()=>{
   const previous=await State.findOne({key:'platform'}).session(session).lean();
   const state={ok:Boolean(summary.ok),fingerprint:String(summary.fingerprint||'').slice(0,8000),checkedAt:new Date(summary.checkedAt)};
   if(!Number.isFinite(state.checkedAt.getTime()))throw new Error('Invalid operational check time.');
   const changed=!previous||previous.ok!==state.ok||previous.fingerprint!==state.fingerprint;
   const notify=Boolean(noticeKind&&changed);
   const revision=notify?randomUUID():previous?.noticeRevision||null;
   const stored=await State.findOneAndUpdate({key:'platform'},{$set:{...state,...(notify?{noticeRevision:revision,noticeKind,noticeRequestedAt:new Date()}: {})}},{upsert:true,returnDocument:'after',session});
   if(notify){
    const {enqueueAlert}=require('./adminAlertService');
    for(const recipient of recipients)await enqueueAlert({key:`operational:${revision}:${createHash('sha256').update(recipient).digest('hex')}`,kind:'operational',targetId:stored._id,recipient,sourceRevision:revision,operationalKind:noticeKind},{session});
   }
   result={queued:notify,recipientCount:notify?recipients.length:0,noticeRevision:revision};
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
 }finally{await session.endSession();}
 return result;
}
module.exports={persistMonitorState};
