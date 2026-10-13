"use strict";
// The canonical SupportTicket owns the work intent and delivery history. Nothing
// runs unless the owner explicitly enables one of these existing preferences.
const mongoose = require('mongoose');
const {randomUUID,createHash} = require('crypto');
const Ticket = require('../../models/SupportTicket');
const Preference = require('../../models/AutonomyPreference');
const User = require('../../models/User');
const Audit = require('../../models/AuditLog');
const Item = require('../../models/KnowledgeItem');
const Revision = require('../../models/KnowledgeRevision');
const Collection = require('../../models/KnowledgeCollection');
const {encryptString,decryptString} = require('../../utils/dataEncryption');
const {isDefiniteSmtpFailure} = require('../../utils/smtpDeliveryOutcome');
const {lockActiveAccounts} = require('../../utils/activeAccountWrite');
const sendEmail = require('../../utils/email');
const POLICIES = Object.freeze({routine_reply:'support_routine_reply',admission_information:'application_information_request',reminder:'support_information_reminder'});
const RISK = /\b(payment|payments|billing|refund|chargeback|payout|stripe|dispute|lawsuit|settlement|legal advice|guarantee|compensation|credit|charge|charges|invoice|bank|card|cost|amount|funding|fee|fees|percent|percentage)\b/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = text => String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const disclosure = 'This is an automated LPC assistant message. Reply to this email if you need Samantha to review your request.';
const value = (row,key) => Object.hasOwn(row,key)?row[key]:{$exists:false};
function snapshot(ticket) {
 return Object.fromEntries(['subject','message','latestUserMessage','requesterUserId','userId','requesterEmail','requesterRole','requestKind','status','assignedTo','lastInboundMailAt','lastAdminReplyAt','caseId','jobId','applicationId','conversationId','escalationReason','linkedIncidentIds','riskFlags','automaticReminders','emailReplies'].map(key=>[key,ticket[key]]));
}
function sourceFilter(ticket) {return Object.fromEntries(Object.keys(snapshot(ticket)).map(key=>[key,value(ticket,key)]));}
function rules(policy) {
 const incoming=policy?.outboundRules||{};
 const result={startHour:incoming.startHour??9,endHour:incoming.endHour??17,timeZone:incoming.timeZone??'America/New_York',reminderLimit:incoming.reminderLimit??2,reminderIntervalHours:incoming.reminderIntervalHours??72,spendingLimitCents:incoming.spendingLimitCents??0};
 if(typeof result.timeZone!=='string'||!Number.isInteger(result.startHour)||!Number.isInteger(result.endHour)||result.startHour<0||result.endHour>24||result.startHour>=result.endHour||!Number.isInteger(result.reminderLimit)||result.reminderLimit<0||result.reminderLimit>2||!Number.isInteger(result.reminderIntervalHours)||result.reminderIntervalHours<24||result.reminderIntervalHours>168||result.spendingLimitCents!==0)throw new Error('Invalid automatic correspondence limits.');
 new Intl.DateTimeFormat('en-US',{timeZone:result.timeZone}).format(new Date());
 return result;
}
function businessHours(policy,now) {
 const config=rules(policy),parts=new Intl.DateTimeFormat('en-US',{timeZone:config.timeZone,weekday:'short',hour:'numeric',hourCycle:'h23'}).formatToParts(now);
 const part=key=>parts.find(value=>value.type===key)?.value;
 return !['Sat','Sun'].includes(part('weekday'))&&Number(part('hour'))>=config.startHour&&Number(part('hour'))<config.endHour;
}
async function policyFor(action,session=null) {
 const policy=await Preference.findOne({agentRole:'CCO',actionType:action}).session(session).lean();
 return policy?.mode==='auto'?policy:null;
}
async function person(ticket,session=null,{pending=false}={}) {
 const id=ticket.requesterUserId||ticket.userId;
 if(!id||ticket.requesterUserId&&ticket.userId&&String(ticket.requesterUserId)!==String(ticket.userId))return null;
 const user=await User.findById(id).session(session).select('-password').lean();
 if(!user||!['attorney','paralegal'].includes(user.role)||user.status!==(pending?'pending':'approved')||user.disabled||user.deleted||user.suspended||!user.emailVerified||String(user.email).trim().toLowerCase()!==String(ticket.requesterEmail).trim().toLowerCase()||user.role!==ticket.requesterRole)return null;
 return user;
}
function unowned(ticket) {return !ticket.assignedTo&&!['human','contact'].includes(ticket.requestKind)&&!ticket.conversationId&&!ticket.escalationReason&&!ticket.caseId&&!ticket.jobId&&!ticket.applicationId&&!ticket.linkedIncidentIds?.length&&!ticket.riskFlags?.length;}
async function approvedAnswer(key,role,session=null,now=new Date()) {
 const item=await Item.findOne({key,approvalState:'approved',isActive:true,audienceScopes:'support_safe'}).session(session).lean();
 if(!item||!item.currentApprovedRevisionId||!item.nextReviewAt||new Date(item.nextReviewAt)<=now)return null;
 const roles=(item.tags||[]).filter(tag=>['attorney','paralegal'].includes(String(tag).toLowerCase())).map(tag=>String(tag).toLowerCase());
 if(roles.length&&!roles.includes(role))return null;
 const [revision,collection]=await Promise.all([Revision.findOne({_id:item.currentApprovedRevisionId,knowledgeItemId:item._id}).session(session).lean(),Collection.findOne({_id:item.collectionId,isActive:true}).session(session).lean()]);
 if(!revision||!collection||revision.approvalState!=='approved')return null;
 const question=revision.content?.objection,answer=revision.content?.approvedResponse;
 if(!question||!answer||answer.length>10000||RISK.test(question+' '+answer)||/[$]|\d\s*%/.test(question+' '+answer))return null;
 return {key:item.key,question,answer,fingerprint:hash([item.key,String(revision._id),revision.fingerprint,question,answer,roles,item.nextReviewAt])};
}
async function routine(ticket,now) {
 if(!unowned(ticket)||ticket.status!=='open'||ticket.emailReplies?.length||ticket.lastAdminReplyAt)return null;
 const user=await person(ticket);if(!user)return null;
 const query=ticket.latestUserMessage||ticket.message;
 if(RISK.test(ticket.subject+' '+query))return null;
 const items=await Item.find({approvalState:'approved',isActive:true,audienceScopes:'support_safe'}).select('key').limit(100).lean();
 const matches=[];
 for(const item of items){const answer=await approvedAnswer(item.key,user.role,null,now);if(answer&&normalize(answer.question)===normalize(query))matches.push(answer);}
 if(matches.length!==1)return null;
 return {kind:'routine_reply',policyAction:POLICIES.routine_reply,text:`${disclosure}\n\n${matches[0].answer}`,sourceKey:matches[0].key,sourceAnswerFingerprint:matches[0].fingerprint};
}
function admission(user) {
 const {evaluateAttorneyAccountReadiness,evaluateParalegalAdmissionReadiness}=require('../readinessPolicy');
 const readiness=user.role==='attorney'?evaluateAttorneyAccountReadiness(user):evaluateParalegalAdmissionReadiness(user);
 const prepared=require('../adminPreparationService').prepareApplication(user,readiness);
 return {text:prepared.requestText,missing:prepared.missing,fingerprint:hash([user.role,user.status,user.disabled,user.deleted,user.email,user.emailVerified,prepared.missing])};
}
async function stage(ticket,prepared,{now=new Date(),session=null}={}) {
 const intent={requestId:randomUUID(),kind:prepared.kind,policyAction:prepared.policyAction,status:'pending',encryptedText:encryptString(prepared.text,{plaintext:true}),sourceFingerprint:hash(snapshot(ticket)),sourceKey:prepared.sourceKey||'',sourceAnswerFingerprint:prepared.sourceAnswerFingerprint||'',admissionFingerprint:prepared.admissionFingerprint||'',recipient:ticket.requesterEmail,attempts:0,nextAttemptAt:now,createdAt:now};
 const changed=await Ticket.updateOne({_id:ticket._id,...sourceFilter(ticket),$or:[{automaticCorrespondence:{$exists:false}},{'automaticCorrespondence.status':'accepted'}]},{$set:{automaticCorrespondence:intent}},{session});
 return changed.modifiedCount===1;
}
async function stageAdmission(user,policy,now) {
 if(user.createdAt&&now-new Date(user.createdAt)<24*3600000)return false;
 if(user.status!=='pending'||user.disabled||user.deleted||user.suspended||!user.emailVerified||!['attorney','paralegal'].includes(user.role))return false;
 const prepared=admission(user);if(!prepared.missing.length)return false;
 // One canonical initial request per account. Subsequent reminders reuse it.
 const key=`admission:auto:${user._id}`;
 const ticket=await Ticket.findOneAndUpdate({administrativeRequestKey:key},{$setOnInsert:{subject:'Application information requested',message:'LPC needs application details before the owner can review admission.',requesterUserId:user._id,userId:user._id,requesterEmail:user.email,requesterRole:user.role,sourceSurface:'admin',sourceLabel:'Application review',requestKind:'support',nextAction:'Review the applicant response.'}},{upsert:true,returnDocument:'after'}).select('+automaticCorrespondence').lean();
 if(!unowned(ticket)||ticket.automaticCorrespondence||ticket.emailReplies?.length||ticket.status!=='open')return false;
 return stage(ticket,{kind:'admission_information',policyAction:policy.actionType,text:`${disclosure}\n\n${prepared.text}`,admissionFingerprint:prepared.fingerprint},{now});
}
async function stillEligible(ticket,intent,session=null,now=new Date()) {
 const originalSource={...ticket,emailReplies:(ticket.emailReplies||[]).filter(row=>row.requestId!==intent.requestId)};
 if(!unowned(ticket)||hash(snapshot(originalSource))!==intent.sourceFingerprint)return null;
 const pending=intent.kind==='admission_information'||Boolean(intent.admissionFingerprint);
 const user=await person(ticket,session,{pending});if(!user)return null;
 if(pending){const prepared=admission(user);if(!prepared.missing.length||prepared.fingerprint!==intent.admissionFingerprint)return null;}
 if(intent.sourceKey){const answer=await approvedAnswer(intent.sourceKey,user.role,session,now);if(!answer||answer.fingerprint!==intent.sourceAnswerFingerprint)return null;}
 if(intent.kind==='routine_reply'&&ticket.status!=='open')return null;
 if(intent.kind==='admission_information'&&ticket.status!=='open')return null;
 if(intent.kind==='reminder'&&(!['waiting_on_user','waiting_on_info'].includes(ticket.status)||ticket.lastInboundMailAt&&ticket.lastAdminReplyAt&&new Date(ticket.lastInboundMailAt)>new Date(ticket.lastAdminReplyAt)))return null;
 return user;
}
async function claim(id,now) {
 const session=await mongoose.startSession();let claimed;
 try{await session.withTransaction(async()=>{
  claimed=null;const ticket=await Ticket.findById(id).select('+automaticCorrespondence').session(session).lean(),intent=ticket?.automaticCorrespondence;
  if(!intent||!['pending','failed'].includes(intent.status)||intent.attempts>=3||new Date(intent.nextAttemptAt)>now)return;
  const policy=await policyFor(intent.policyAction,session);if(!policy||!businessHours(policy,now))return;
  const user=await stillEligible(ticket,intent,session,now);
  if(!user){await Ticket.updateOne({_id:id,'automaticCorrespondence.requestId':intent.requestId},{$set:{'automaticCorrespondence.status':'skipped','automaticCorrespondence.failure':'The request, owner, recipient or approved answer changed.'}},{session});return;}
  const day=now.toISOString().slice(0,10),used=policy.executionDay===day?policy.dailyAttempts||0:0,limit=policy.dailyAttemptLimit||25;
  if(used>=limit)return;
  if(intent.kind==='reminder'&&(ticket.automaticReminders||0)>=rules(policy).reminderLimit)return;
  await lockActiveAccounts([user._id],session,{requireApproved:!intent.admissionFingerprint});
  const reserved=await Preference.updateOne({_id:policy._id,mode:'auto',executionRevision:policy.executionRevision||0},{$set:{executionDay:day,dailyAttempts:used+1},$inc:{executionRevision:1}},{session});
  if(!reserved.modifiedCount)throw new Error('Automatic correspondence policy changed.');
  const claimId=randomUUID(),text=decryptString(intent.encryptedText),already=ticket.emailReplies?.some(reply=>reply.requestId===intent.requestId);
  await Ticket.updateOne({_id:id,'automaticCorrespondence.requestId':intent.requestId},{$set:{'automaticCorrespondence.status':'sending','automaticCorrespondence.claim':claimId,'automaticCorrespondence.claimedAt':now,...(already?{'emailReplies.$[reply].delivery':'pending'}:{})},$inc:{'automaticCorrespondence.attempts':1},...(!already?{$push:{emailReplies:{requestId:intent.requestId,messageId:`<lpc-support.${id}.${intent.requestId}@lets-paraconnect.com>`,text,adminName:'LPC automated assistant',automatedKind:intent.kind,delivery:'pending',createdAt:now}}}: {})},{session,...(already?{arrayFilters:[{'reply.requestId':intent.requestId}]}:{})});
  await Audit.create([{actorRole:'system',action:'support.automatic.send_claimed',targetType:'other',targetId:id,meta:{requestId:intent.requestId,kind:intent.kind,sourceKey:intent.sourceKey,policyAction:intent.policyAction,dailyAttempt:used+1}}],{session});
  claimed={ticket,intent,claimId,text,config:rules(policy)};
 },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:10000});}finally{await session.endSession();}
 return claimed;
}
async function deliver(claimed,now) {
 const {ticket,intent,claimId,text,config}=claimed;let status='unknown',failure='',attempted=false;
 try{
  const fresh=await Ticket.findById(ticket._id).select('+automaticCorrespondence').lean();
  // Compare the original source; the one newly claimed history entry is local
  // bookkeeping, not an incoming reply or an owner takeover.
  const source={...fresh,emailReplies:(fresh?.emailReplies||[]).filter(row=>row.requestId!==intent.requestId)};
  const policy=await policyFor(intent.policyAction);
  if(!fresh||fresh.automaticCorrespondence?.claim!==claimId||!policy||!businessHours(policy,now)||!await stillEligible(source,intent,null,now))status='skipped';
  else{
   attempted=true;const result=await sendEmail(intent.recipient,`Re: ${ticket.subject}`,`<p style="white-space:pre-wrap">${text.replace(/[&<>"']/g,value=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]))}</p>`,{text,throwOnError:true,messageId:`<lpc-support.${ticket._id}.${intent.requestId}@lets-paraconnect.com>`,replyTo:process.env.SUPPORT_ZOHO_MAILBOX||'help@lets-paraconnect.com',headers:{'Auto-Submitted':'auto-generated'}});
   const matches=list=>Array.isArray(list)&&list.some(value=>String(value?.address||value).trim().toLowerCase()===String(intent.recipient).trim().toLowerCase());
   status=result?.disabled?'skipped':matches(result?.accepted)&&!matches(result?.rejected)?'accepted':matches(result?.rejected)?'failed':'unknown';
  }
 }catch(error){status=isDefiniteSmtpFailure(error,attempted)?'failed':'unknown';failure=status==='failed'?'The attempt failed before confirmed acceptance.':'Delivery could not be confirmed. Check the provider before retrying.';}
 const changes={'automaticCorrespondence.status':status,'automaticCorrespondence.failure':failure,'automaticCorrespondence.nextAttemptAt':new Date(now.getTime()+2**(intent.attempts+1)*60000),'emailReplies.$[reply].delivery':status};
 if(status==='accepted')changes['automaticCorrespondence.nextReminderAt']=new Date(now.getTime()+config.reminderIntervalHours*3600000);
 const match={_id:ticket._id,'automaticCorrespondence.claim':claimId,'automaticCorrespondence.status':'sending'};
 await Ticket.updateOne(match,{$set:changes},{arrayFilters:[{'reply.requestId':intent.requestId}]});
 if(status==='accepted'){
  await Ticket.updateOne({...match,'automaticCorrespondence.status':'accepted',assignedTo:null,status:ticket.status,message:value(ticket,'message'),latestUserMessage:value(ticket,'latestUserMessage'),lastInboundMailAt:value(ticket,'lastInboundMailAt'),lastAdminReplyAt:value(ticket,'lastAdminReplyAt')},{$set:{status:'waiting_on_user',lastAdminReplyAt:now},...(intent.kind==='reminder'?{$inc:{automaticReminders:1}}:{})});
 }
 return status;
}
async function processAutomaticCorrespondence({limit=20,now=new Date(),shouldStop=()=>false,onProgress=async()=>{}}={}) {
 // A paused policy must still expose any abandoned in-flight attempt as unknown.
 await Ticket.updateMany({'automaticCorrespondence.status':'sending','automaticCorrespondence.claimedAt':{$lt:new Date(now.getTime()-10*60000)}},[{$set:{'automaticCorrespondence.status':'unknown','automaticCorrespondence.failure':'The worker stopped before delivery was confirmed. Check the provider.',emailReplies:{$map:{input:{$ifNull:['$emailReplies',[]]},as:'reply',in:{$cond:[{$eq:['$$reply.requestId','$automaticCorrespondence.requestId']},{$mergeObjects:['$$reply',{delivery:'unknown'}]},'$$reply']}}}}}],{updatePipeline:true});
 const active=await Preference.find({agentRole:'CCO',mode:'auto',actionType:{$in:Object.values(POLICIES)}}).lean();
 if(!active.length)return {processed:0,staged:0};
 let staged=0,processed=0;
 const advance=async(policy,cursor)=>Preference.updateOne({_id:policy._id,mode:'auto'},{$set:{outboundScanCursor:cursor||null}});
 const routinePolicy=active.find(row=>row.actionType===POLICIES.routine_reply);
 if(routinePolicy&&businessHours(routinePolicy,now)){
  const rows=await Ticket.find({status:'open',assignedTo:null,automaticCorrespondence:{$exists:false},...(routinePolicy.outboundScanCursor?{_id:{$gt:routinePolicy.outboundScanCursor}}:{})}).select('+automaticCorrespondence').sort({_id:1}).limit(limit).lean();
  if(!rows.length)await advance(routinePolicy,null);
  for(const ticket of rows){if(shouldStop())break;const prepared=await routine(ticket,now);if(prepared&&await stage(ticket,prepared,{now}))staged++;await advance(routinePolicy,ticket._id);await onProgress();}
 }
 const admissionPolicy=active.find(row=>row.actionType===POLICIES.admission_information);
 if(admissionPolicy&&businessHours(admissionPolicy,now)){
  const rows=await User.find({status:'pending',emailVerified:true,role:{$in:['attorney','paralegal']},disabled:{$ne:true},deleted:{$ne:true},createdAt:{$lte:new Date(now.getTime()-24*3600000)},...(admissionPolicy.outboundScanCursor?{_id:{$gt:admissionPolicy.outboundScanCursor}}:{})}).select('-password').sort({_id:1}).limit(limit).lean();
  if(!rows.length)await advance(admissionPolicy,null);
  for(const user of rows){if(shouldStop())break;if(await stageAdmission(user,admissionPolicy,now))staged++;await advance(admissionPolicy,user._id);await onProgress();}
 }
 const reminderPolicy=active.find(row=>row.actionType===POLICIES.reminder);
 if(reminderPolicy&&businessHours(reminderPolicy,now))for await(const ticket of Ticket.find({status:{$in:['waiting_on_user','waiting_on_info']},assignedTo:null,'automaticCorrespondence.status':'accepted','automaticCorrespondence.nextReminderAt':{$lte:now},automaticReminders:{$lt:rules(reminderPolicy).reminderLimit}}).select('+automaticCorrespondence').limit(limit).lean().cursor()){
  if(shouldStop())break;const prior=ticket.automaticCorrespondence;
  if(ticket.emailReplies?.at(-1)?.requestId!==prior.requestId||ticket.lastInboundMailAt&&new Date(ticket.lastInboundMailAt)>new Date(ticket.lastAdminReplyAt)){await Ticket.updateOne({_id:ticket._id,'automaticCorrespondence.requestId':prior.requestId,'automaticCorrespondence.status':'accepted'},{$set:{'automaticCorrespondence.status':'skipped','automaticCorrespondence.failure':'A newer reply or owner action replaced this reminder.'}});continue;}
  if(await stage(ticket,{kind:'reminder',policyAction:POLICIES.reminder,text:`${disclosure}\n\nA reminder about the LPC information requested below. If you have already replied, please let us know.\n\n${decryptString(prior.encryptedText)}`,sourceKey:prior.sourceKey,sourceAnswerFingerprint:prior.sourceAnswerFingerprint,admissionFingerprint:prior.admissionFingerprint},{now}))staged++;await onProgress();
 }
 for await(const row of Ticket.find({'automaticCorrespondence.status':{$in:['pending','failed']},'automaticCorrespondence.nextAttemptAt':{$lte:now}}).select('_id').limit(limit).lean().cursor()){
  if(shouldStop())break;const work=await claim(row._id,now);if(work){await deliver(work,now);processed++;}await onProgress();
 }
 return {processed,staged};
}
module.exports={POLICIES,rules,businessHours,processAutomaticCorrespondence,claim,deliver,stage,routine,admission};
