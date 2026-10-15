const mongoose=require('mongoose');
jest.mock('../utils/email',()=>jest.fn(async recipient=>({accepted:[recipient]})));
const email=require('../utils/email');
const User=require('../models/User'),Ticket=require('../models/SupportTicket'),Preference=require('../models/AutonomyPreference'),Item=require('../models/KnowledgeItem'),Revision=require('../models/KnowledgeRevision'),Collection=require('../models/KnowledgeCollection'),Audit=require('../models/AuditLog');
const service=require('../services/support/automaticCorrespondence'),policyService=require('../services/support/correspondencePolicy');
const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
const now=new Date('2026-10-09T14:00:00Z'),question='How do I change notification preferences?';
let user,admin,ticket,item;
beforeAll(connect);afterAll(closeDatabase);afterEach(()=>jest.restoreAllMocks());
beforeEach(async()=>{
 await clearDatabase();email.mockReset().mockImplementation(async recipient=>({accepted:[recipient]}));
 [user,admin]=await User.create(['paralegal','admin'].map(role=>({firstName:'Synthetic',lastName:role,email:`${role}@capture.invalid`,password:'Synthetic123!',role,status:'approved',emailVerified:true})));
 const collection=await Collection.create({key:'synthetic-support',title:'Synthetic support',audienceScopes:['support_safe']});
 item=await Item.create({key:'synthetic-notifications',title:'Notification preferences',collectionId:collection._id,recordType:'objection_card',approvalState:'approved',audienceScopes:['support_safe'],tags:['paralegal'],nextReviewAt:new Date('2027-01-01')});
 const revision=await Revision.create({knowledgeItemId:item._id,revisionNumber:1,fingerprint:'synthetic-approved-answer',approvalState:'approved',content:{objection:question,approvedResponse:'Open Settings and select Notifications to change your message preferences.'}});
 await Item.updateOne({_id:item._id},{$set:{currentApprovedRevisionId:revision._id}});
 ticket=await Ticket.create({subject:'Notification preferences',message:question,requesterUserId:user._id,userId:user._id,requesterEmail:user.email,requesterRole:user.role,sourceSurface:'paralegal'});
});
const enable=(kind='routine_reply',extra={})=>Preference.create({agentRole:'CCO',actionType:service.POLICIES[kind],mode:'auto',...extra});
const retained=()=>Ticket.findById(ticket._id).select('+automaticCorrespondence').lean();
test('absent policies remain off and viewing them creates no work',async()=>{
 expect((await policyService.readPolicies()).policies.every(row=>row.mode==='manual')).toBe(true);
 expect(await service.processAutomaticCorrespondence({now})).toEqual({processed:0,staged:0});expect(await Preference.countDocuments()).toBe(0);expect(email).not.toHaveBeenCalled();
});
test('an exact approved role-safe answer is durable, disclosed and accepted once',async()=>{
 await enable();await service.processAutomaticCorrespondence({now});await service.processAutomaticCorrespondence({now});
 const row=await retained();expect(row.automaticCorrespondence.status).toBe('accepted');expect(row.automaticCorrespondence.encryptedText).toMatch(/^enc:v1:/);expect(row.emailReplies).toHaveLength(1);expect(row.status).toBe('waiting_on_user');
 expect(email).toHaveBeenCalledTimes(1);expect(email.mock.calls[0][3].text).toContain('automated LPC assistant');expect(await Audit.countDocuments({action:'support.automatic.send_claimed'})).toBe(1);
 expect(await Ticket.findById(ticket._id).lean()).not.toHaveProperty('automaticCorrespondence');
});
test.each(['owner','human','conversation','matter','risk','wrong_role','stale_answer','inactive_collection','inactive_user','different_question'])('automatic eligibility refuses %s',async change=>{
 await enable();
 const patch=change==='owner'?{assignedTo:admin._id}:change==='human'?{requestKind:'human'}:change==='conversation'?{conversationId:new mongoose.Types.ObjectId()}:change==='matter'?{caseId:new mongoose.Types.ObjectId()}:change==='risk'?{message:'I need a payout refund.'}:change==='different_question'?{message:'Do something different.'}:null;
 if(patch)await Ticket.updateOne({_id:ticket._id},{$set:patch});
 if(change==='wrong_role')await Item.updateOne({_id:item._id},{$set:{tags:['attorney']}});
 if(change==='stale_answer')await Item.updateOne({_id:item._id},{$set:{nextReviewAt:new Date('2025-01-01')}});
 if(change==='inactive_collection')await Collection.updateMany({},{$set:{isActive:false}});
 if(change==='inactive_user')await User.updateOne({_id:user._id},{$set:{disabled:true}});
 await service.processAutomaticCorrespondence({now});expect(email).not.toHaveBeenCalled();
});
test('a failed audit rolls back the daily reservation and send claim',async()=>{
 const policy=await enable(),prepared=await service.routine(await retained(),now);await service.stage(await retained(),prepared,{now});
 jest.spyOn(Audit,'create').mockRejectedValueOnce(new Error('audit unavailable'));
 await expect(service.claim(ticket._id,now)).rejects.toThrow('audit unavailable');expect(email).not.toHaveBeenCalled();expect((await retained()).automaticCorrespondence.status).toBe('pending');expect((await Preference.findById(policy._id)).dailyAttempts).toBe(0);
});
test('owner takeover and changed approved content prevent a claimed but unsent message',async()=>{
 await enable();const prepared=await service.routine(await retained(),now);await service.stage(await retained(),prepared,{now});
 const work=await service.claim(ticket._id,now);await Ticket.updateOne({_id:ticket._id},{$set:{assignedTo:admin._id}});
 expect(await service.deliver(work,now)).toBe('skipped');expect(email).not.toHaveBeenCalled();expect((await retained()).assignedTo.toString()).toBe(admin._id.toString());
});
test('source withdrawal after staging suppresses the pending send',async()=>{
 await enable();const prepared=await service.routine(await retained(),now);await service.stage(await retained(),prepared,{now});await Item.updateOne({_id:item._id},{$set:{approvalState:'rejected'}});
 expect(await service.claim(ticket._id,now)).toBeFalsy();expect((await retained()).automaticCorrespondence.status).toBe('skipped');expect(email).not.toHaveBeenCalled();
});
test('unknown SMTP acceptance is held and definite rejection recovers without a second history row',async()=>{
 await enable();email.mockRejectedValueOnce(Object.assign(new Error('lost DATA acknowledgement'),{code:'ECONNRESET',command:'CONN'}));
 await service.processAutomaticCorrespondence({now});await service.processAutomaticCorrespondence({now:new Date(now.getTime()+3600000)});
 expect((await retained()).automaticCorrespondence.status).toBe('unknown');expect(email).toHaveBeenCalledTimes(1);
 await Ticket.deleteMany({});ticket=await Ticket.create({subject:'Notification preferences',message:question,requesterUserId:user._id,userId:user._id,requesterEmail:user.email,requesterRole:user.role,sourceSurface:'paralegal'});
 email.mockRejectedValueOnce(Object.assign(new Error('rejected'),{responseCode:451}));await Preference.updateMany({},{$set:{outboundScanCursor:null}});
 await service.processAutomaticCorrespondence({now});expect((await retained()).automaticCorrespondence.status).toBe('failed');
 await service.processAutomaticCorrespondence({now:new Date(now.getTime()+3600000)});expect((await retained()).automaticCorrespondence.status).toBe('accepted');expect((await retained()).emailReplies).toHaveLength(1);
});
test('daily attempts and business hours bound overlapping workers',async()=>{
 const policy=await enable('routine_reply',{dailyAttemptLimit:1});const second=await Ticket.create({subject:ticket.subject,message:question,requesterUserId:user._id,userId:user._id,requesterEmail:user.email,requesterRole:user.role,sourceSurface:'paralegal'});
 await Promise.all([service.processAutomaticCorrespondence({now}),service.processAutomaticCorrespondence({now})]);expect(email).toHaveBeenCalledTimes(1);expect((await Preference.findById(policy._id)).dailyAttempts).toBe(1);
 await service.processAutomaticCorrespondence({now:new Date('2026-10-10T14:00:00Z')});expect(email).toHaveBeenCalledTimes(1);
 expect((await Ticket.findById(second._id).select('+automaticCorrespondence')).automaticCorrespondence.status).toBe('pending');
});
test('pending applicant requests use known missing fields, wait a day, and never decide admission',async()=>{
 await enable('admission_information');await Ticket.deleteMany({});await User.updateOne({_id:user._id},{$set:{status:'pending'}});
 await service.processAutomaticCorrespondence({now});expect(email).not.toHaveBeenCalled();
 await User.collection.updateOne({_id:user._id},{$set:{createdAt:new Date('2026-10-07T14:00:00Z')}});await Preference.updateMany({},{$set:{outboundScanCursor:null}});
 await service.processAutomaticCorrespondence({now});expect(email).toHaveBeenCalledTimes(1);expect(email.mock.calls[0][3].text).toContain('Please reply');expect((await User.findById(user._id)).status).toBe('pending');
 expect(await Ticket.countDocuments({administrativeRequestKey:`admission:auto:${user._id}`})).toBe(1);
});
test('at most two reminders follow accepted requests and newer replies stop them',async()=>{
 await enable();await enable('reminder');await service.processAutomaticCorrespondence({now});
 const monday=new Date('2026-10-12T14:00:00Z'),thursday=new Date('2026-10-15T14:00:00Z'),next=new Date('2026-10-19T14:00:00Z');
 await service.processAutomaticCorrespondence({now:monday});await service.processAutomaticCorrespondence({now:thursday});await service.processAutomaticCorrespondence({now:next});
 expect(email).toHaveBeenCalledTimes(3);expect((await retained()).automaticReminders).toBe(2);
});

test('a committed send claim with a lost acknowledgement is not sent on recovery',async()=>{
 await enable();const prepared=await service.routine(await retained(),now);await service.stage(await retained(),prepared,{now});
 const start=mongoose.startSession.bind(mongoose);let lost=false;
 jest.spyOn(mongoose,'startSession').mockImplementation(async()=>{const session=await start(),commit=session.commitTransaction.bind(session);session.commitTransaction=async()=>{await commit();if(!lost){lost=true;throw Object.assign(new Error('claim acknowledgement lost'),{hasErrorLabel:()=>false});}};return session;});
 await expect(service.claim(ticket._id,now)).rejects.toThrow('claim acknowledgement lost');jest.restoreAllMocks();
 await service.processAutomaticCorrespondence({now:new Date(now.getTime()+3600000)});expect(email).not.toHaveBeenCalled();expect((await retained()).automaticCorrespondence.status).toBe('unknown');expect((await retained()).emailReplies[0].delivery).toBe('unknown');
});
test('source changes and new inbound replies stop pending reminders',async()=>{
 await enable();await enable('reminder');await service.processAutomaticCorrespondence({now});
 await Ticket.updateOne({_id:ticket._id},{$set:{lastInboundMailAt:new Date(now.getTime()+3600000),latestUserMessage:'I have replied with the requested details.'}});
 await service.processAutomaticCorrespondence({now:new Date('2026-10-12T14:00:00Z')});expect(email).toHaveBeenCalledTimes(1);expect((await retained()).automaticCorrespondence.status).toBe('skipped');
});
test('policy changes require an active admin, current review, confirmed activation and strict limits',async()=>{
 const env={EMAIL_DISABLE:process.env.EMAIL_DISABLE,SMTP_HOST:process.env.SMTP_HOST,SMTP_FROM_EMAIL:process.env.SMTP_FROM_EMAIL};
 try{
  const row=(await policyService.readPolicies()).policies[0],req={user:{id:String(admin._id)},params:{kind:row.kind},body:{mode:'auto',rules:row.rules,dailyAttemptLimit:5,revision:row.revision},auth:{payload:{av:0}}};
  await expect(policyService.savePolicy(req)).rejects.toMatchObject({statusCode:428});req.body.confirmed=true;await expect(policyService.savePolicy(req)).rejects.toMatchObject({statusCode:409});
  Object.assign(process.env,{EMAIL_DISABLE:'false',SMTP_HOST:'127.0.0.1',SMTP_FROM_EMAIL:'synthetic@capture.invalid'});
  await expect(policyService.savePolicy({...req,user:{id:String(user._id)}})).rejects.toMatchObject({statusCode:403});
  await expect(policyService.savePolicy({...req,body:{...req.body,rules:{...row.rules,reminderLimit:3}}})).rejects.toMatchObject({statusCode:400});
  const saved=await policyService.savePolicy(req);expect(saved.policies[0].mode).toBe('auto');expect(email).not.toHaveBeenCalled();
  await expect(policyService.savePolicy(req)).rejects.toMatchObject({statusCode:409});
  expect(await Audit.countDocuments({action:'support.correspondence.policy_changed'})).toBe(1);
 }finally{for(const [key,value]of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
