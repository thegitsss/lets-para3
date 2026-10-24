const mongoose=require('mongoose');
let timer=null,running=false;
async function runOnce(){
  if(running||mongoose.connection.readyState!==1)return;
  running=true;
  try{
    const steps=[()=>require('./authSignupAlerts').processAlerts({limit:20}),()=>require('./signupReviewNotifications').processNotices({limit:20,releaseOnly:true}),()=>require('./admissionDecisionNotifications').processNotices({limit:20,releaseOnly:true})];
    for(const step of steps){try{await step()}catch(error){console.warn('[auth-notices] Saved account notices remain queued.',{code:error.code||error.name})}}
  }finally{running=false}
}
async function start(){
  if(timer||process.env.NODE_ENV==='test')return;
  for(const name of ['EmailVerificationToken','SignupReviewNotification','AdmissionDecisionNotification','AdminCommunicationAlert','AuthSession','AuthChallenge','PasskeyCredential']){
    const model=require('../models/'+name);
    await model.createCollection();
    await model.createIndexes();
  }
  timer=setInterval(()=>void runOnce(),30000);timer.unref();
  void runOnce();
}
function stop(){if(timer)clearInterval(timer);timer=null}
module.exports={start,stop,runOnce};
