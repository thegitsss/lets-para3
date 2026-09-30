const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const State = require('../../models/AdminMailboxState');
const Mail = require('../../models/AdminInboundMail');
const Ticket = require('../../models/SupportTicket');
const { encryptString, decryptString } = require('../../utils/dataEncryption');
const { enqueueAlert } = require('../adminAlertService');
const { configuration, createZohoMailbox, email } = require('./zohoMailbox');
const { followUpAfterMail } = require('./answeredFollowUp');
const messageIds = value => String(value||'').match(/<[^<>\s]{1,250}>/g)||[];

async function applyMail(mail) {
  if(mail.applied)return;
  if(!mail.ignored) {
    // Upsert a separate inquiry only for unmatched mail. A retry reuses its ID.
    await Ticket.updateOne({_id:mail.ticketId},{$setOnInsert:{subject:mail.subject||'Email inquiry',message:'An email was received in the LPC support mailbox.',requestKind:'email',sourceSurface:'manual',sourceLabel:'Support mailbox',requesterEmail:mail.sender,requesterRole:'visitor',createdAt:new Date(),updatedAt:new Date()}},{upsert:true,runValidators:true,timestamps:false});
    // Reopen only for newer incoming mail; replaying an old page must not undo a reply.
    await Ticket.updateOne({_id:mail.ticketId,$and:[{$or:[{lastInboundMailAt:null},{lastInboundMailAt:{$lt:mail.receivedAt}}]},{$or:[{lastAdminReplyAt:null},{lastAdminReplyAt:{$lt:mail.receivedAt}}]},{$or:[{resolvedAt:null},{resolvedAt:{$lt:mail.receivedAt}}]}]},[{$set:{followUpAt:followUpAfterMail(mail.receivedAt),status:'open',resolvedAt:null,resolutionIsStable:false,lastInboundMailAt:mail.receivedAt,latestUserMessage:'New email received. Open the inquiry to read it.'}}],{updatePipeline:true});
    await enqueueAlert({key:`email:${mail._id}`,kind:'email',targetId:mail.ticketId});
  }
  await Mail.updateOne({_id:mail._id},{$set:{applied:true}});
}
async function importMessage({row,content,config}) {
  const h=content.headers||{}, sender=email(h.from||row.fromAddress);
  const refs=messageIds(`${h['in-reply-to']||''} ${h.references||''}`);
  // A short SUP reference, subject or display name is never sufficient to link.
  const matches=sender&&refs.length ? await Ticket.find({requesterEmail:sender,'emailReplies.messageId':{$in:refs}}).select('_id').limit(2).lean():[];
  const auto=(h['auto-submitted']&&h['auto-submitted'].toLowerCase()!=='no')||/\b(bulk|list|junk)\b/i.test(h.precedence||'')||!!h['list-id']||/multipart\/report/i.test(h['content-type']||'');
  const ownAddresses=[config.mailbox,process.env.ADMIN_ALERT_EMAIL||'admin@lets-paraconnect.com',process.env.SMTP_FROM_EMAIL,process.env.SMTP_USER].map(email).filter(Boolean);
  const ignored=!sender||ownAddresses.includes(sender)||!!auto;
  const receivedAt=new Date(Number(row.receivedTime));
  if(!Number.isFinite(receivedAt.getTime()))throw new Error('Mailbox returned an invalid received date.');
  const data={mailboxKey:config.key,providerId:row.messageId,ticketId:ignored?null:matches.length===1?matches[0]._id:new mongoose.Types.ObjectId(),sender,subject:String(row.subject||'Email inquiry').slice(0,300),content:ignored?'':encryptString(content.text||'(No readable text in this email.)'),receivedAt,messageId:messageIds(h['message-id'])[0]||'',hasAttachments:content.hasAttachments,truncated:content.truncated,ignored};
  let mail;
  try {mail=await Mail.findOneAndUpdate({mailboxKey:config.key,providerId:row.messageId},{$setOnInsert:data},{upsert:true,returnDocument:'after'});}
  catch(error){if(error.code!==11000)throw error;mail=await Mail.findOne({mailboxKey:config.key,providerId:row.messageId});}
  await applyMail(mail);
  return mail;
}
async function syncMailbox({config=configuration(),adapter,maxMessages=40,shouldStop=()=>false,onProgress=async()=>{}}={}) {
  if(!config.configured)return {configured:false};
  if(shouldStop())return {configured:true,paused:true};
  let state;
  const since=new Date(process.env.SUPPORT_MAIL_SYNC_SINCE||Date.now()-7*86400000);
  if(!Number.isFinite(since.getTime())||since>new Date())throw new Error('Set a valid past SUPPORT_MAIL_SYNC_SINCE date.');
  try {await State.updateOne({_id:config.key},{$setOnInsert:{since,cursor:1}},{upsert:true});}catch(error){if(error.code!==11000)throw error;}
  const lease=randomUUID();
  state=await State.findOneAndUpdate({_id:config.key,$or:[{leaseUntil:null},{leaseUntil:{$lt:new Date()}}]},{$set:{lease,leaseUntil:new Date(Date.now()+120000),lastAttemptAt:new Date(),error:''}},{returnDocument:'after'});
  if(!state)return {configured:true,busy:true};
  const mailbox=adapter||createZohoMailbox(config);
  let imported=0,complete=false,cursor=state.cursor||1;
  const renew=async()=>{const r=await State.updateOne({_id:config.key,lease,leaseUntil:{$gt:new Date()}},{$set:{leaseUntil:new Date(Date.now()+120000)}});if(!r.matchedCount)throw new Error('Mailbox sync lease expired.');await onProgress();};
  try {
    // A saved message must finish applying even if it was moved out of the
    // provider Inbox after a crash. Its saved ticket ID makes replay idempotent.
    for await(const saved of Mail.find({mailboxKey:config.key,applied:false}).sort({_id:1}).cursor()) {
      if(shouldStop())return {configured:true,paused:true,imported,cursor};
      await renew();
      await applyMail(saved);
    }
    if(shouldStop())return {configured:true,paused:true,imported,cursor};
    await mailbox.verify();
    // Always scan the newest page first, then continue a durable cursor through
    // the backlog. Every complete pass restarts, repairing folder offset shifts.
    let inspected=0;
    const consume=async row=>{
      const when=new Date(Number(row.receivedTime));
      if(!Number.isFinite(when.getTime()))throw new Error('Mailbox returned an invalid received date.');
      if(when<state.since)return false;
      if(typeof row.messageId!=='string')throw new Error('Mailbox returned a message ID without string precision.');
      await renew();
      const saved=await Mail.findOne({mailboxKey:config.key,providerId:row.messageId});
      if(saved){await applyMail(saved);return true;}
      const content=await mailbox.read(row);
      await renew();
      await importMessage({row,content,config});imported++;return true;
    };
    if(cursor>1&&!shouldStop())for(const row of await mailbox.list(1,20)) {
      if(shouldStop())break;
      await consume(row);
    }
    while(inspected<maxMessages&&!complete&&!shouldStop()) {
      await renew();
      const rows=await mailbox.list(cursor,Math.min(20,maxMessages-inspected));
      if(shouldStop())break;
      if(!rows.length){complete=true;break;}
      for(const row of rows) {
        if(shouldStop())break;
        if(!await consume(row)){complete=true;break;}
        cursor++;inspected++;
        await State.updateOne({_id:config.key,lease},{$set:{cursor}});
      }
    }
    await State.updateOne({_id:config.key,lease},{$set:{cursor:complete?1:cursor,...(complete?{lastCompletedAt:new Date()}:{}),error:''}});
    return {configured:true,imported,complete,paused:shouldStop(),cursor:complete?1:cursor};
  } catch(error) {
    await State.updateOne({_id:config.key,lease},{$set:{error:'Email sync is unavailable. Check the mailbox connection and worker logs.'}});
    throw Object.assign(new Error('Email sync is unavailable. Check the support mailbox connection.'),{statusCode:503});
  } finally {await State.updateOne({_id:config.key,lease},{$unset:{lease:1,leaseUntil:1}});}
}
async function mailboxStatus() {
  const config=configuration();
  const [state,worker]=await Promise.all([State.findById(config.key).lean(),State.findById('communications-worker').lean()]);
  return {configured:config.configured,mailbox:config.mailbox,since:state?.since||null,lastAttemptAt:state?.lastAttemptAt||null,lastCompletedAt:state?.lastCompletedAt||null,backlog:!!state&&state.cursor>1,error:state?.error||'',lastWorkerAt:worker?.lastWorkerAt||null};
}
async function ticketEmails(ticketId) {
  const rows=await Mail.find({ticketId,ignored:false}).sort({receivedAt:1,_id:1}).lean();
  return rows.map(m=>({id:String(m._id),sender:m.sender,subject:m.subject,text:decryptString(m.content),createdAt:m.receivedAt,hasAttachments:m.hasAttachments,truncated:m.truncated}));
}
module.exports={syncMailbox,mailboxStatus,ticketEmails,importMessage,applyMail};
