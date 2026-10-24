const { randomUUID } = require('crypto');
const Alert = require('../models/AdminCommunicationAlert');
const User = require('../models/User');
const Ticket = require('../models/SupportTicket');
const WebhookEvent = require('../models/WebhookEvent');
const Case = require('../models/Case');
const OpsMonitorState = require('../models/OpsMonitorState');
const { getOwnerAlertRecipients } = require('../utils/opsAlerting');
const sendEmail = require('../utils/email');
const { letterEmail } = require('../email/layout');
const { accountEmailFooter } = require('../email/accountFooter');
const { revision } = require('./communicationRetry');
const { isDefiniteSmtpFailure } = require('../utils/smtpDeliveryOutcome');
const ACTIVE = ['open','in_review','waiting_on_user','waiting_on_info'];
const titles = { signup:'New signup awaiting your review', contact:'New contact form inquiry', human:'A user is waiting for the LPC team', email:'A new email needs your attention', overdue:'An inquiry follow-up is overdue', payment:'An LPC payment event requires your review', dispute_comment:'A Matter dispute has a new participant comment' };
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function recipient() { return String(process.env.ADMIN_ALERT_EMAIL || 'admin@lets-paraconnect.com').trim().toLowerCase(); }
async function enqueueAlert({ key, kind, targetId, dueAt, recipient: intendedRecipient, sourceRevision, operationalKind }, { session } = {}) {
  try {
    return await Alert.findOneAndUpdate({ key }, { $setOnInsert:{ kind,targetId,dueAt, ...(kind==='operational'?{recipient:intendedRecipient,sourceRevision,operationalKind}:{}) } }, { upsert:true, returnDocument:'after', ...(session ? {session} : {}) });
  } catch(error) { if(error.code!==11000 || session)throw error; return Alert.findOne({key}); }
}
// Reconcile authoritative records so a process exit between saving a request and
// enqueuing its alert cannot lose the notification. Cursors have no list cap.
async function reconcileAlerts({ shouldStop=()=>false, onProgress=async()=>{} }={}) {
  for await (const event of WebhookEvent.find({ attentionRequired: true }).select('_id eventId').lean().cursor()) {
    if (shouldStop()) return;
    await onProgress();
    await enqueueAlert({ key: `payment:${event.eventId}`, kind: 'payment', targetId: event._id });
  }
  for await(const user of User.find({status:'pending',role:{$in:['attorney','paralegal']}}).select('_id').lean().cursor()) {
    if(shouldStop())return;
    await onProgress();
    await enqueueAlert({key:`signup:${user._id}`,kind:'signup',targetId:user._id});
  }
  for await(const ticket of Ticket.find({status:{$in:ACTIVE},$or:[{requestKind:{$in:['contact','human']}},{followUpAt:{$lte:new Date(),$ne:null}}]}).select('_id requestKind status lastAdminReplyAt followUpAt').lean().cursor()) {
    if(shouldStop())return;
    await onProgress();
    if(ticket.requestKind==='contact' && !ticket.lastAdminReplyAt)await enqueueAlert({key:`contact:${ticket._id}`,kind:'contact',targetId:ticket._id});
    if(ticket.requestKind==='human' && ['open','in_review'].includes(ticket.status))await enqueueAlert({key:`human:${ticket._id}:${ticket.lastAdminReplyAt?.toISOString()||'initial'}`,kind:'human',targetId:ticket._id});
    if(ticket.followUpAt && ticket.followUpAt<=new Date())await enqueueAlert({key:`overdue:${ticket._id}:${ticket.followUpAt.toISOString()}`,kind:'overdue',targetId:ticket._id,dueAt:ticket.followUpAt});
  }
}
async function processAlerts({ limit=20, key, shouldStop=()=>false, onProgress=async()=>{} }={}) {
  if(shouldStop())return 0;
  // SMTP acceptance cannot be inferred after a worker dies while sending.
  await Alert.updateMany({status:'sending',claimedAt:{$lt:new Date(Date.now()-10*60000)}},{$set:{status:'unknown',failure:'The worker stopped before delivery could be confirmed. Check the mailbox before retrying.'}});
  let count=0;
  while(count<limit&&!shouldStop()) {
    const claim=randomUUID();
    const alert=await Alert.findOneAndUpdate({ ...(key?{key}:{}),status:{$in:['pending','failed']},attempts:{$lt:5},nextAttemptAt:{$lte:new Date()}},{$set:{status:'sending',claim,claimedAt:new Date()},$inc:{attempts:1}},{returnDocument:'after',sort:{createdAt:1}});
    if(!alert)break;
    count++;
    let status='unknown',failure='',acceptedAt,sendAttempted=false;
    try {
      const destination=alert.kind==='operational'?String(alert.recipient||'').trim().toLowerCase():recipient();
      await Alert.updateOne({_id:alert._id,claim,status:'sending'},{$set:{recipient:destination}}); alert.recipient=destination;
      const record=alert.kind==='operational' ? await OpsMonitorState.findById(alert.targetId).select('noticeRevision noticeKind').lean() : alert.kind==='dispute_comment' ? await Case.findById(alert.targetId).select('disputes._id disputes.disputeId disputes.comments._id').lean() : alert.kind==='payment' ? await WebhookEvent.findById(alert.targetId).select('attentionRequired').lean() : alert.kind==='signup' ? await User.findById(alert.targetId).select('status').lean() : await Ticket.findById(alert.targetId).select('status followUpAt lastAdminReplyAt').lean();
      const commentRef=alert.kind==='dispute_comment' ? alert.key.split(':') : [];
      const stillRelevant=record && (alert.kind==='operational' ? record.noticeRevision===alert.sourceRevision && record.noticeKind===alert.operationalKind && getOwnerAlertRecipients().map(value=>value.toLowerCase()).includes(alert.recipient) : alert.kind==='dispute_comment' ? commentRef.length===4 && String(record._id)===commentRef[1] && record.disputes?.some(review=>String(review.disputeId || review._id)===commentRef[2] && review.comments?.some(comment=>String(comment._id)===commentRef[3])) : alert.kind==='payment' ? record.attentionRequired === true : alert.kind==='signup' ? record.status==='pending' : ACTIVE.includes(record.status) && (alert.kind!=='overdue'||record.followUpAt?.getTime()===alert.dueAt?.getTime()) && (!['contact','human'].includes(alert.kind)||['open','in_review'].includes(record.status)));
      if(!stillRelevant) status='skipped';
      else {
        const base=String(process.env.APP_BASE_URL||'').replace(/\/+$/,'');
        const path=alert.kind==='operational'?'/admin-dashboard.html#section-system':alert.kind==='dispute_comment'?'/admin-dashboard.html#section-disputes':alert.kind==='payment'?'/admin-dashboard.html#section-escrow':alert.kind==='signup'?`/admin-dashboard.html?account=${alert.targetId}#section-user-management`:`/admin-dashboard.html?ticket=${alert.targetId}#section-support-ops`;
        const link=base?`${base}${path}`:'';
        const title=alert.kind==='operational'?({failure:"LPC platform checks need attention",recovery:"LPC platform checks are healthy again",fatal:"LPC platform checks could not finish"}[alert.operationalKind]):titles[alert.kind];
        const footer = alert.kind === 'signup' ? accountEmailFooter() : null;
        const text=`${title}. Open LPC admin to review it.${link?'\n'+link:''}${footer?'\n\n'+footer.text:''}`;
        const body = `<p>${escape(title)}.</p><p>Open LPC admin to review it.</p>${link?`<p><a href="${escape(link)}">Open request</a></p>`:''}`;
        sendAttempted=true;
        const result=await sendEmail(alert.recipient,title,footer ? letterEmail(body, { footer: footer.html }) : body,{text,throwOnError:true,headers:{'Auto-Submitted':'auto-generated'},messageId:`<lpc-alert.${alert._id}@lets-paraconnect.com>`});
        const matches = list => Array.isArray(list) && list.some(value => String(value?.address || value).trim().toLowerCase() === alert.recipient.toLowerCase());
        status=result?.disabled?'disabled':matches(result?.accepted)&&!matches(result?.rejected)?'accepted':matches(result?.rejected)?'failed':'unknown';
        if(status==='accepted')acceptedAt=new Date();
      }
    } catch(error) {
      // A definite SMTP rejection or failure before DATA is safe to retry.
      const definite=isDefiniteSmtpFailure(error,sendAttempted);
      status=definite?'failed':'unknown';
      failure=definite?(sendAttempted?'The mail provider rejected this attempt.':'The request could not be checked before sending. The worker will retry.'):'Delivery could not be confirmed. Check the mailbox before retrying.';
    }
    await Alert.updateOne({_id:alert._id,claim,status:'sending'},{$set:{status,failure,acceptedAt,nextAttemptAt:new Date(Date.now()+Math.min(60,2**alert.attempts)*60000)}});
    await onProgress();
  }
  return count;
}
async function alertStatus() {
  const [counts, recent] = await Promise.all([
    Alert.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]),
    Alert.find({status:{$in:['failed','unknown','disabled']}}).sort({updatedAt:-1}).limit(10).select('kind targetId status attempts failure updatedAt claim').lean(),
  ]);
  return {recipient:recipient(),counts:Object.fromEntries(counts.map(x=>[x._id,x.count])),recent:recent.map(({claim,...record})=>({...record,revision:revision({...record,claim})}))};
}
module.exports={enqueueAlert,reconcileAlerts,processAlerts,alertStatus};
