const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');
jest.mock('../utils/email', () => jest.fn(async () => ({
  accepted: ['visitor@example.test']
})));
jest.mock('../services/lpcEvents/publishEventService', () => ({
  publishEventSafe: jest.fn(async () => ({
    ok: true
  }))
}));
jest.mock('../utils/stripe', () => ({
  accounts: {
    retrieve: jest.fn()
  }
}));
const sendEmail = require('../utils/email');
const User = require('../models/User');
const Case = require('../models/Case');
const SupportTicket = require('../models/SupportTicket');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const Incident = require('../models/Incident');
const {
  connect,
  clearDatabase,
  closeDatabase
} = require('./helpers/db');
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/public', require('../routes/public'));
app.use('/api/support', require('../routes/support'));
app.use('/api/admin/support', require('../routes/adminSupport'));
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use('/api/admin', require('../routes/admin'));
app.use((e, req, res, next) => res.status(e.statusCode || 500).json({
  error: e.message
}));
let admin, attorney, paralegal;
const cookie = u => `token=${jwt.sign({
  id: String(u._id),
  role: u.role,
  email: u.email,
  status: u.status
}, process.env.JWT_SECRET, {
  expiresIn: '1h'
})}`;
const makeUser = (role, email) => User.create({
  firstName: 'Inbox',
  lastName: role,
  email,
  password: 'Example123!Strong',
  role,
  status: 'approved',
  emailVerified: true,
  state: 'CA'
});
beforeAll(async () => {
  await connect();
}, 120000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({
    accepted: ['visitor@example.test']
  });
  admin = await makeUser('admin', 'admin@example.test');
  attorney = await makeUser('attorney', 'attorney@example.test');
  paralegal = await makeUser('paralegal', 'para@example.test');
});

const {randomUUID}=require('crypto');
const Draft=require('../models/AdminDraft');
const Alert=require('../models/AdminCommunicationAlert');
const Mail=require('../models/AdminInboundMail');
const State=require('../models/AdminMailboxState');
const FileNotice=require('../models/MatterFileNotification');
const {loadDraft,saveDraft}=require('../services/adminDraftService');
const {enqueueAlert,reconcileAlerts,processAlerts}=require('../services/adminAlertService');
const {syncMailbox,importMessage,ticketEmails}=require('../services/support/mailboxSyncService');
const {configuration,headers,plainText}=require('../services/support/zohoMailbox');
const config={configured:true,key:'help@example.test:123:456',mailbox:'help@example.test',accountId:'123',folderId:'456'};
const ticket=overrides=>SupportTicket.create({subject:'Question',message:'Hello',requestKind:'contact',requesterEmail:'visitor@example.test',...overrides});
const incoming=(n,overrides={})=>({messageId:String(9000000000000000000n+BigInt(n)),receivedTime:String(Date.now()-n*1000),fromAddress:'visitor@example.test',subject:'Re: Question',...overrides});
const content=(overrides={})=>({headers:{from:'Visitor <visitor@example.test>'},text:'Thanks, here is more detail.',...overrides});

 test('private drafts survive reads, isolate owners, and reject stale concurrent saves',async()=>{
  const t=await ticket();const args={owner:admin._id,kind:'inquiry',recordId:t._id};
  expect((await loadDraft(args)).revision).toBe(0);
  const saved=await saveDraft(args,{text:'Private reply',note:'Private note',requestId:randomUUID(),uncertain:false,revision:0});
  expect(saved.revision).toBe(1);expect((await loadDraft(args)).text).toBe('Private reply');
  expect((await loadDraft({...args,owner:attorney._id})).text).toBe('');
  const results=await Promise.allSettled(['One','Two'].map(text=>saveDraft(args,{text,revision:1})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected').reason.statusCode).toBe(409);
  const doc=await Draft.findOne({owner:admin._id});expect(doc.expiresAt-new Date()).toBeGreaterThan(29*86400000);
  await Draft.updateOne({_id:doc._id},{$set:{expiresAt:new Date(0)}});
  expect((await loadDraft(args)).text).toBe('');
 });
 test('draft and communication endpoints reject non-admin access and forged draft ownership',async()=>{
  const t=await ticket();const path=`/api/admin/workspace/drafts/inquiry/${t._id}`;
  expect((await request(app).get(path)).status).toBe(401);
  expect((await request(app).get(path).set('Cookie',cookie(attorney))).status).toBe(403);
  const saved=await request(app).put(path).set('Cookie',cookie(admin)).send({owner:attorney._id,text:'mine',revision:0});
  expect(saved.status).toBe(200);expect(await Draft.countDocuments({owner:admin._id})).toBe(1);
  expect(await Draft.countDocuments({owner:attorney._id})).toBe(0);
  expect((await request(app).get('/api/admin/workspace/communications').set('Cookie',cookie(paralegal))).status).toBe(403);
  expect((await request(app).post('/api/admin/workspace/communications/sync').set('Cookie',cookie(attorney))).status).toBe(403);
 });
 test.each(['files','work','payments','withdrawals','completion','reviews','resolution','applications','invitations','invitation_accepted','invitation_declined','invitation_revoked','pre_requested','pre_submitted','pre_changes_requested','post_created','post_updated','post_deleted','post_edits_requested','post_review_requested'])('%s email review and retry require an admin, an explicit delivery check and the current record',async label=>{
  const kind=label.startsWith('post_')?'posting':label.startsWith('pre_')?'pre-engagement':label.startsWith('invitation_')?'invitations':label==='completion'?'payments':label==='resolution'?'reviews':label;
  const Model=kind==='posting'?require('../models/MatterPostingNotification'):kind==='pre-engagement'?require('../models/MatterPreEngagementNotification'):kind==='invitations'?require('../models/MatterInvitationNotification'):kind==='applications'?require('../models/MatterApplicationNotification'):kind==='files'?FileNotice:kind==='work'?require('../models/MatterWorkNotification'):kind==='payments'?require('../models/MatterPaymentNotification'):kind==='reviews'?require('../models/MatterReviewNotification'):require('../models/MatterWithdrawalNotification');
  const notice=await Model.create({_id:new mongoose.Types.ObjectId(),...(kind==='posting'?{kind:label.slice(5),ownerId:attorney._id,eventKey:'a'.repeat(64),stateKey:'b'.repeat(64)}:{}),...(kind==='pre-engagement'?{kind:label.slice(4),ownerId:attorney._id,revisionKey:'a'.repeat(64)}:{}),...(kind==='invitations'?{kind:label.startsWith('invitation_')?label.slice(11):'sent',ownerId:attorney._id,invitationKey:'a'.repeat(64)}:{}),...(kind==='applications'?{applicationId:new mongoose.Types.ObjectId(),submissionKey:'a'.repeat(64),jobId:new mongoose.Types.ObjectId()}:{}),...(label==='resolution'?{kind:'resolved',resolvedAt:new Date(),action:'refund',operationId:new mongoose.Types.ObjectId()}:{}),...(label==='completion'?{kind:'completion',payoutId:new mongoose.Types.ObjectId(),transferId:'tr_synthetic_completion',completedAt:new Date()}:{}),userRole:"paralegal",disputeId:new mongoose.Types.ObjectId().toString(),openedAt:new Date(),userId:kind==='payments'?attorney._id:paralegal._id,actorUserId:attorney._id,attorneyId:attorney._id,hiredAt:new Date(),paralegalId:paralegal._id,withdrawnAt:new Date(),outcome:'awaiting_attorney_decision',caseId:new mongoose.Types.ObjectId(),fileId:new mongoose.Types.ObjectId(),fileVersion:1,paymentIntentId:'pi_synthetic',paymentStatus:'requires_action',status:'unknown',failure:'Delivery could not be confirmed.'});
  const endpoint=`/api/admin/workspace/communications/${kind}/${notice._id}/retry`;
  expect((await request(app).post(endpoint).send({confirmed:true})).status).toBe(401);
  expect((await request(app).post(endpoint).set('Cookie',cookie(paralegal)).send({confirmed:true})).status).toBe(403);
  const status=await request(app).get('/api/admin/workspace/communications').set('Cookie',cookie(admin));
  expect(status.status).toBe(200);expect(status.headers['cache-control']).toBe('no-store');
  const shown=status.body[kind==='posting'?'postingNotices':kind==='pre-engagement'?'preEngagementNotices':kind==='invitations'?'invitationNotices':kind==='applications'?'applicationNotices':kind==='files'?'fileNotices':kind==='work'?'workNotices':kind==='payments'?'paymentNotices':kind==='reviews'?'reviewNotices':'withdrawalNotices'].recent[0];expect(shown._id).toBe(String(notice._id));expect(shown.revision).toMatch(/^[a-f0-9]{64}$/);expect(shown.claim).toBeUndefined();if(['invitations','pre-engagement','posting'].includes(kind))expect(shown.kind).toBe(notice.kind);
  expect((await request(app).post(endpoint).set('Cookie',cookie(admin)).send({revision:shown.revision})).status).toBe(400);
  const body={confirmed:true,revision:shown.revision};
  expect((await request(app).post(endpoint).set('Cookie',cookie(admin)).send(body)).body).toEqual({ok:true});
  expect((await request(app).post(endpoint).set('Cookie',cookie(admin)).send(body)).status).toBe(409);
  expect((await Model.findById(notice._id)).status).toBe('pending');
 });
 test('an owner-alert retry returns success only with its valid audit record',async()=>{
  const alert=await Alert.create({key:'owner-retry',kind:'signup',targetId:attorney._id,status:'unknown'});
  const status=await request(app).get('/api/admin/workspace/communications').set('Cookie',cookie(admin));
  const shown=status.body.alerts.recent.find(row=>row._id===String(alert._id));
  const response=await request(app).post(`/api/admin/workspace/communications/alerts/${alert._id}/retry`).set('Cookie',cookie(admin)).send({confirmed:true,revision:shown.revision});
  expect(response.status).toBe(200);expect(response.body).toEqual({ok:true});
  expect(await require('../models/AuditLog').findOne({targetId:String(alert._id)})).toMatchObject({targetType:'other',action:'admin.communication.retry_requested'});
 });
 test('chat reply retries create exactly one message and cannot change its text or owner',async()=>{
  const conversation=await SupportConversation.create({userId:attorney._id,role:'attorney',status:'escalated'});
  const t=await ticket({requestKind:'human',conversationId:conversation._id,requesterUserId:attorney._id});
  await SupportMessage.init();
  const path=`/api/admin/support/tickets/${t._id}/reply`,body={text:'A team reply',requestId:randomUUID()};
  const results=await Promise.all([1,2].map(()=>request(app).post(path).set('Cookie',cookie(admin)).send(body)));
  expect(results.map(r=>r.status)).toEqual([201,201]);
  expect(await SupportMessage.countDocuments({'metadata.adminReplyRequestId':body.requestId})).toBe(1);
  await SupportTicket.updateOne({_id:t._id},{$set:{status:'open'}});
  expect((await request(app).post(path).set('Cookie',cookie(admin)).send(body)).status).toBe(201);
  expect((await SupportTicket.findById(t._id)).status).toBe('open');
  expect((await request(app).post(path).set('Cookie',cookie(admin)).send({...body,text:'Changed'})).status).toBe(409);
  const other=await makeUser('admin','other@example.test');
  expect((await request(app).post(path).set('Cookie',cookie(other)).send(body)).status).toBe(409);
 });
 test('outgoing email records an exact thread ID before sending',async()=>{
  const t=await ticket();const id=randomUUID();
  await request(app).post(`/api/admin/support/tickets/${t._id}/reply`).set('Cookie',cookie(admin)).send({text:'Hello back',requestId:id});
  const stored=await SupportTicket.findById(t._id);
  expect(stored.emailReplies[0].messageId).toContain(id);
  expect(sendEmail.mock.calls[0][3].messageId).toBe(stored.emailReplies[0].messageId);
 });
 test('alert reconciliation survives repeated runs and concurrent workers send each alert once',async()=>{
  await User.updateOne({_id:attorney._id},{$set:{status:'pending'}});
  const t=await ticket();await ticket({requestKind:'human'});
  await reconcileAlerts();await reconcileAlerts();expect(await Alert.countDocuments()).toBe(3);
  await Promise.all([processAlerts(),processAlerts()]);expect(sendEmail).toHaveBeenCalledTimes(3);
  expect(await Alert.countDocuments({status:'accepted'})).toBe(3);
  await reconcileAlerts();await processAlerts();expect(sendEmail).toHaveBeenCalledTimes(3);
  await SupportTicket.updateOne({_id:t._id},{$set:{followUpAt:new Date(Date.now()-60000)}});
  await reconcileAlerts();await reconcileAlerts();expect(await Alert.countDocuments({kind:'overdue'})).toBe(1);
 });
 test('definite SMTP failures retry, ambiguous outcomes do not, and expired claims remain visible',async()=>{
  const t=await ticket();await enqueueAlert({key:'failure',kind:'contact',targetId:t._id});
  sendEmail.mockRejectedValueOnce(Object.assign(new Error('rejected'),{responseCode:451}));
  await processAlerts();expect((await Alert.findOne({key:'failure'})).status).toBe('failed');
  await Alert.updateOne({key:'failure'},{$set:{nextAttemptAt:new Date(0)}});
  sendEmail.mockRejectedValueOnce(new Error('lost DATA response'));
  await processAlerts();expect((await Alert.findOne({key:'failure'})).status).toBe('unknown');
  await processAlerts();expect(sendEmail).toHaveBeenCalledTimes(2);
  await Alert.create({key:'crash',kind:'contact',targetId:t._id,status:'sending',claimedAt:new Date(0)});
  await processAlerts();expect((await Alert.findOne({key:'crash'})).status).toBe('unknown');
  const r=await request(app).post(`/api/admin/workspace/communications/alerts/${(await Alert.findOne({key:'crash'}))._id}/retry`).set('Cookie',cookie(admin)).send({});expect(r.status).toBe(400);
 });
 test('resolved requests and rescheduled follow-ups are skipped instead of producing stale alerts',async()=>{
  const t=await ticket({followUpAt:new Date(0)});await reconcileAlerts();
  await SupportTicket.updateOne({_id:t._id},{$set:{status:'resolved',followUpAt:null}});
  await processAlerts();expect(sendEmail).not.toHaveBeenCalled();expect(await Alert.countDocuments({status:'skipped'})).toBe(2);
 });
 test('an email reply matches only an exact issued message ID and the expected sender',async()=>{
  const thread='<lpc-support.secret@lets-paraconnect.com>';
  const t=await ticket({status:'resolved',emailReplies:[{requestId:randomUUID(),messageId:thread,text:'Question',delivery:'accepted'}]});
  const c=content({headers:{from:'Visitor <visitor@example.test>','in-reply-to':thread}});
  const m=await importMessage({row:incoming(1),content:c,config});expect(String(m.ticketId)).toBe(String(t._id));
  expect((await SupportTicket.findById(t._id)).status).toBe('open');
  const detail=await request(app).get(`/api/admin/support/tickets/${t._id}`).set('Cookie',cookie(admin));expect(detail.body.ticket.inboundEmails[0].text).toContain('more detail');
  const foreign=await importMessage({row:incoming(2),content:content({headers:{from:'different@example.test','in-reply-to':thread}}),config});expect(String(foreign.ticketId)).not.toBe(String(t._id));
  const unthreaded=await importMessage({row:incoming(3,{subject:`SUP-${String(t._id).slice(-6)}`}),content:content(),config});expect(String(unthreaded.ticketId)).not.toBe(String(t._id));
  await importMessage({row:incoming(1),content:c,config});expect(await Mail.countDocuments()).toBe(3);
  expect(await Alert.countDocuments({kind:'email'})).toBe(3);
 });
 test('auto replies are ignored and replaying imported mail cannot undo a newer admin reply',async()=>{
  await importMessage({row:incoming(1),content:content({headers:{from:'visitor@example.test','auto-submitted':'auto-replied'}}),config});
  expect(await SupportTicket.countDocuments()).toBe(0);expect(await Alert.countDocuments()).toBe(0);
  const m=await importMessage({row:incoming(2),content:content(),config});
  await SupportTicket.updateOne({_id:m.ticketId},{$set:{status:'waiting_on_user',lastAdminReplyAt:new Date()}});
  await Mail.updateOne({_id:m._id},{$set:{applied:false}});
  await importMessage({row:incoming(2),content:content(),config});
  expect((await SupportTicket.findById(m.ticketId)).status).toBe('waiting_on_user');
 });
 test.each(['waiting_on_user','waiting_on_info'])('a new email cancels the %s reminder and its queued overdue alert',async status=>{
  const thread='<lpc-support.follow-up@lets-paraconnect.com>';
  const t=await ticket({status,followUpAt:new Date(0),assignedTo:admin._id,nextAction:'Review the requested details',lastAdminReplyAt:new Date(Date.now()-60000),emailReplies:[{requestId:randomUUID(),messageId:thread,text:'Please reply',delivery:'accepted'}]});
  await reconcileAlerts();
  const mail=await importMessage({row:incoming(20,{receivedTime:String(Date.now()+1000)}),content:content({headers:{from:'visitor@example.test','in-reply-to':thread}}),config});
  const current=await SupportTicket.findById(t._id);
  expect(String(mail.ticketId)).toBe(String(t._id));expect(current.followUpAt).toBeNull();expect(current.status).toBe('open');
  expect(String(current.assignedTo)).toBe(String(admin._id));expect(current.nextAction).toBe('Review the requested details');
  await processAlerts({key:`overdue:${t._id}:${new Date(0).toISOString()}`});
  expect(sendEmail).not.toHaveBeenCalled();expect((await Alert.findOne({kind:'overdue',targetId:t._id})).status).toBe('skipped');
 });
 test('delayed and replayed email preserves a more recent owner follow-up',async()=>{
  const thread='<lpc-support.newer-follow-up@lets-paraconnect.com>', due=new Date(Date.now()+86400000);
  const t=await ticket({status:'waiting_on_user',followUpAt:due,lastAdminReplyAt:new Date(Date.now()-60000),emailReplies:[{requestId:randomUUID(),messageId:thread,text:'Please reply',delivery:'accepted'}]});
  const row=incoming(21,{receivedTime:String(Date.now()-30000)}), contents=content({headers:{from:'visitor@example.test','in-reply-to':thread}});
  const mail=await importMessage({row,content:contents,config});
  expect((await SupportTicket.findById(t._id)).followUpAt).toEqual(due);
  const newerDue=new Date(Date.now()+172800000);
  await SupportTicket.updateOne({_id:t._id},{$set:{status:'waiting_on_user',followUpAt:newerDue,lastAdminReplyAt:new Date()}});
  await Mail.updateOne({_id:mail._id},{$set:{applied:false}});
  await importMessage({row,content:contents,config});
  expect((await SupportTicket.findById(t._id)).followUpAt).toEqual(newerDue);
 });
 test('mail sync resumes after a failure and scans beyond 200 messages without duplication',async()=>{
  const rows=Array.from({length:205},(_,n)=>incoming(n));
  let reads=0,fail=true;
  const adapter={verify:jest.fn(),list:jest.fn(async(start,limit)=>rows.slice(start-1,start-1+limit)),read:jest.fn(async()=>{reads++;if(reads===3&&fail){fail=false;throw new Error('provider offline');}return content();})};
  await expect(syncMailbox({config,adapter,maxMessages:40})).rejects.toMatchObject({statusCode:503});
  expect((await State.findById(config.key)).error).toBeTruthy();
  let result;
  for(let n=0;n<8;n++){result=await syncMailbox({config,adapter,maxMessages:40});if(result.complete)break;}
  expect(result.complete).toBe(true);expect(await Mail.countDocuments()).toBe(205);
  expect(await SupportTicket.countDocuments()).toBe(205);expect(await Alert.countDocuments()).toBe(205);
  expect((await State.findById(config.key)).lastCompletedAt).toBeTruthy();
  await syncMailbox({config,adapter,maxMessages:10});expect(await Mail.countDocuments()).toBe(205);
 },120000);
 test('an active mailbox lease prevents overlapping scans and unavailable settings are explicit',async()=>{
  await State.create({_id:config.key,since:new Date(0),lease:'other',leaseUntil:new Date(Date.now()+60000)});
  const adapter={verify:jest.fn()};expect((await syncMailbox({config,adapter})).busy).toBe(true);expect(adapter.verify).not.toHaveBeenCalled();
  expect(await syncMailbox({config:{configured:false}})).toEqual({configured:false});
 });
 test('mail normalization strips executable markup and safely retains large string IDs',()=>{
  expect(plainText('<script>secret()</script><p>Hello &amp; welcome</p><img src=x onerror=bad()>')).toBe('Hello & welcome');
  expect(headers('From: Person <person@example.test>\r\nReferences: <one@test>\r\n <two@test>').references).toBe('<one@test> <two@test>');
  expect(configuration().refreshToken).toBe('');
 });

test('a retry repairs a chat reply interrupted after message persistence',async()=>{
 const conversation=await SupportConversation.create({userId:attorney._id,role:'attorney',status:'escalated'});
 const t=await ticket({requestKind:'human',conversationId:conversation._id});const id=randomUUID();
 await SupportMessage.create({conversationId:conversation._id,sender:'system',text:'Saved before the worker stopped',metadata:{kind:'team_reply',adminReplyRequestId:id,adminId:String(admin._id),ticketStatus:'waiting_on_user'}});
 const result=await request(app).post(`/api/admin/support/tickets/${t._id}/reply`).set('Cookie',cookie(admin)).send({text:'Saved before the worker stopped',requestId:id});
 expect(result.status).toBe(201);expect(result.body.reused).toBe(true);
 expect(await SupportMessage.countDocuments({'metadata.adminReplyRequestId':id})).toBe(1);
 expect((await SupportTicket.findById(t._id)).status).toBe('waiting_on_user');
});

test('platform notification emails cannot loop into new inquiries or owner alerts',async()=>{
 const prior=process.env.SMTP_FROM_EMAIL;process.env.SMTP_FROM_EMAIL='notifications@example.test';
 try {
  await importMessage({row:incoming(1),content:content({headers:{from:'notifications@example.test'}}),config});
  await importMessage({row:incoming(2),content:content({headers:{from:'visitor@example.test','auto-submitted':'auto-generated'}}),config});
  expect(await SupportTicket.countDocuments()).toBe(0);expect(await Alert.countDocuments()).toBe(0);
 }finally{if(prior===undefined)delete process.env.SMTP_FROM_EMAIL;else process.env.SMTP_FROM_EMAIL=prior;}
});

test('existing personal-data removal clears communication bodies and drafts without reimporting mail',async()=>{
 const t=await ticket({requestKind:'email',requesterEmail:attorney.email,requesterUserId:attorney._id});
 await Draft.create({owner:admin._id,kind:'account',recordId:attorney._id,content:'private review',expiresAt:new Date(Date.now()+86400000)});
 await Draft.create({owner:admin._id,kind:'inquiry',recordId:t._id,content:'private reply',expiresAt:new Date(Date.now()+86400000)});
 await Mail.create({mailboxKey:config.key,providerId:'999',ticketId:t._id,sender:attorney.email,subject:'Private',content:'private body',receivedAt:new Date(),applied:true});
 await enqueueAlert({key:'removal',kind:'email',targetId:t._id});
 await User.updateOne({_id:attorney._id},{$set:{deleted:true,disabled:true}});
 await require('../services/userDeletion').finalizeAccountDataRemoval(attorney._id);
 expect(await Draft.countDocuments()).toBe(0);
 const mail=await Mail.findOne({providerId:'999'});expect(mail.content).toBe('');expect(mail.ignored).toBe(true);expect(mail.applied).toBe(true);
 expect((await Alert.findOne({key:'removal'})).status).toBe('skipped');
 expect((await SupportTicket.findById(t._id)).requesterEmail).toBe('');
});
