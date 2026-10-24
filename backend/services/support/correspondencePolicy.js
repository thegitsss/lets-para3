"use strict";
const mongoose=require('mongoose');
const {createHash}=require('crypto');
const Preference=require('../../models/AutonomyPreference');
const Ticket=require('../../models/SupportTicket');
const User=require('../../models/User');
const Audit=require('../../models/AuditLog');
const {lockActiveAccounts}=require('../../utils/activeAccountWrite');
const {POLICIES,rules}=require('./automaticCorrespondence');
const DEFINITIONS=[
 {kind:'routine_reply',label:'Routine support replies',description:'Sends exact, current approved answers for the requester’s role. Payment, legal and disputed work stays with you.'},
 {kind:'admission_information',label:'Application information requests',description:'Requests known missing details after an applicant has had a day to finish their profile. Admission decisions stay with you.'},
 {kind:'reminder',label:'Information reminders',description:'Follows up on the assistant’s accepted information requests, at most twice. A reply or your takeover stops reminders.'},
];
const fail=(statusCode,message)=>{throw Object.assign(new Error(message),{statusCode});};
function project(definition,record){
 const config=rules(record),mode=record?.mode||'manual',configurationRevision=record?.outboundConfigurationRevision||0;
 const revision=createHash('sha256').update(JSON.stringify([definition.kind,mode,config,record?.dailyAttemptLimit||25,configurationRevision])).digest('hex');
 return {...definition,actionType:POLICIES[definition.kind],mode,rules:config,dailyAttemptLimit:record?.dailyAttemptLimit||25,revision};
}
async function readPolicies(){
 const [records,counts]=await Promise.all([Preference.find({agentRole:'CCO',actionType:{$in:Object.values(POLICIES)}}).lean(),Ticket.aggregate([{$match:{automaticCorrespondence:{$exists:true}}},{$group:{_id:'$automaticCorrespondence.status',count:{$sum:1}}}])]);
 return {policies:DEFINITIONS.map(definition=>project(definition,records.find(record=>record.actionType===POLICIES[definition.kind]))),counts:Object.fromEntries(counts.map(row=>[row._id,row.count]))};
}
async function savePolicy(req){
 const definition=DEFINITIONS.find(row=>row.kind===req.params.kind);if(!definition)fail(400,'Choose a supported correspondence policy.');
 const body=req.body||{};
 if(Object.keys(body).some(key=>!['mode','rules','dailyAttemptLimit','revision','confirmed'].includes(key))||!['manual','auto'].includes(body.mode)||!/^[a-f0-9]{64}$/.test(body.revision||''))fail(400,'Refresh and review these message settings.');
 if(!Number.isInteger(body.dailyAttemptLimit)||body.dailyAttemptLimit<1||body.dailyAttemptLimit>25)fail(400,'Choose a daily attempt limit between 1 and 25.');
 const allowed=['startHour','endHour','timeZone','reminderLimit','reminderIntervalHours','spendingLimitCents'];
 if(!body.rules||typeof body.rules!=='object'||Array.isArray(body.rules)||Object.keys(body.rules).some(key=>!allowed.includes(key)))fail(400,'Choose the supported message limits.');
 let config;try{config=rules({outboundRules:body.rules});}catch(_){fail(400,'Check the business hours, time zone and reminder limits.');}
 if(body.mode==='auto'){
  if(body.confirmed!==true)fail(428,'Confirm enabling automatic messages.');
  if(String(process.env.EMAIL_DISABLE).toLowerCase()==='true'||!process.env.SMTP_HOST||!process.env.SMTP_FROM_EMAIL)fail(409,'Connect the message service before enabling automatic messages.');
 }
 const id=req.user?.id||req.user?._id,session=await mongoose.startSession();let saved;
 try{await session.withTransaction(async()=>{
  const user=await User.findById(id).session(session).select('role status disabled deleted authVersion').lean();
  if(!user||user.role!=='admin'||user.status!=='approved'||user.disabled||user.deleted||Number(user.authVersion||0)!==Number(req.auth?.payload?.av||0))fail(403,'Verify your administrator session.');
  await lockActiveAccounts([id],session,{ownerId:String(id),authVersion:req.auth?.payload?.av||0});
  const record=await Preference.findOne({agentRole:'CCO',actionType:POLICIES[definition.kind]}).session(session).lean();
  if(project(definition,record).revision!==body.revision)fail(409,'These message settings changed. Refresh before saving.');
  await Preference.findOneAndUpdate({agentRole:'CCO',actionType:POLICIES[definition.kind]},{$set:{mode:body.mode,outboundRules:config,dailyAttemptLimit:body.dailyAttemptLimit},$inc:{executionRevision:1,outboundConfigurationRevision:1}},{upsert:true,session,runValidators:true});
  await Audit.create([{actor:id,actorRole:'admin',action:'support.correspondence.policy_changed',targetType:'other',targetId:definition.kind,meta:{previousMode:record?.mode||'manual',mode:body.mode,rules:config,dailyAttemptLimit:body.dailyAttemptLimit}}],{session});
 },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:10000});saved=await readPolicies();}finally{await session.endSession();}
 return saved;
}
module.exports={readPolicies,savePolicy,DEFINITIONS,project};
