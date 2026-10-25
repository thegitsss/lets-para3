const Alert=require('../models/AdminCommunicationAlert');
const User=require('../models/User');
const {createEmailNoticeDelivery}=require('./emailNoticeDelivery');
const {letterEmail,button,escape}=require('../email/layout');
const {accountEmailFooter}=require('../email/accountFooter');
const RELEASE='signup-signin-20261023';
async function enqueueAlert({key,kind,targetId},{session}={}) {
  if(kind!=='signup'||key!==`signup:${targetId}`)throw new Error('Invalid account signup notice.');
  return Alert.findOneAndUpdate({key},{$setOnInsert:{kind,targetId,releaseKey:RELEASE}},{upsert:true,returnDocument:'after',...(session?{session}:{})});
}
async function prepare(notice){
  if(notice.kind!=='signup'||notice.releaseKey!==RELEASE)return null;
  const user=await User.findById(notice.targetId).select('firstName lastName role status disabled deleted').lean();
  if(!user||user.status!=='pending'||user.disabled||user.deleted)return null;
  const base=new URL(process.env.EMAIL_BASE_URL||process.env.APP_BASE_URL||'https://www.lets-paraconnect.com');
  const href=new URL(`/admin-dashboard.html?account=${user._id}#section-user-management`,base.origin).href;
  const subject='New signup awaiting your review',footer=accountEmailFooter();
  return {to:String(process.env.ADMIN_ALERT_EMAIL||'admin@lets-paraconnect.com').trim().toLowerCase(),subject,
    html:letterEmail(`<p>${escape(subject)}.</p><p>${escape(`${user.firstName} ${user.lastName}`)} (${escape(user.role)}) submitted an application.</p>${button(href,'Open request')}`,{title:subject,footer:footer.html,footerOutside:true,brandUrl:base.origin+'/'}),
    text:`${subject}.\n${user.firstName} ${user.lastName} (${user.role})\n${href}\n\n${footer.text}`};
}
const delivery=createEmailNoticeDelivery({Notice:Alert,prepare,prefix:'signup-admin'});
async function processAlerts({key,limit=20,...options}={}){
  const notice=key?await Alert.findOne({key,kind:'signup',releaseKey:RELEASE}).select('_id').lean():null;
  if(key&&!notice)return 0;
  return delivery.processNotices({...options,limit,...(notice?{noticeId:notice._id}:{}),releaseOnly:true});
}
module.exports={enqueueAlert,processAlerts,prepare};
