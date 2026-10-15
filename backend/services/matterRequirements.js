const Decision = require('../models/MatterRequirementDecision');
function normalizeRequirements(value = []) {
  if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) {
    throw Object.assign(new Error('Use up to 12 requirements, each between 1 and 200 characters.'), { status:400, publicCode:'REQUIREMENTS_INVALID' });
  }
  const result = value.map(item => item.replace(/[\u0000-\u001f\u007f]/g, '').trim());
  if (result.some(item=>!item)) throw Object.assign(new Error('Requirements cannot be blank.'), {status:400, publicCode:'REQUIREMENTS_INVALID'});
  if (new Set(result.map(item => item.toLowerCase())).size !== result.length) throw Object.assign(new Error('Remove duplicate requirements.'), {status:400, publicCode:'REQUIREMENTS_INVALID'});
  return result;
}
const scopeKey = job => String(job.caseId || job._id);
async function assertRequirements(job, caseDoc, userId, answers, session) {
  if (await Decision.findOne({ matterKey:scopeKey(job), paralegalId:userId }).session(session || null)) throw Object.assign(new Error('You confirmed that you do not meet this Matter’s requirements. This Matter is unavailable to you.'), {status:403});
  const required = caseDoc?.requirements || job.requirements || [];
  if (required.length && (!Array.isArray(answers) || answers.length !== required.length || required.some((text,index) => answers[index]?.requirement !== text || answers[index]?.meets !== true))) {
    throw Object.assign(new Error('Confirm that you meet every current Matter requirement before applying.'), {status:400});
  }
  return required.map(requirement => ({requirement, meets:true}));
}
async function declineRequirements({jobId,caseId,userId,authVersion,requirements,confirmed}) {
  const {isValidObjectId}=require('mongoose'),Case=require('../models/Case'),Job=require('../models/Job');
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  if(confirmed!==true||!isValidObjectId(jobId||caseId))fail(400,'Confirm your requirement decision.');
  return require('../utils/activeAccountWrite').withActiveAccountWrite([userId],async session=>{
    const job=jobId?await Job.findById(jobId).session(session):await Job.findOne({caseId}).session(session);
    const matter=await Case.findById(caseId||job?.caseId||null).session(session);
    if(!matter&&!job)fail(404,'This Matter is unavailable.');
    const key=String(matter?._id||job._id);
    if(await Decision.exists({matterKey:key,paralegalId:userId}).session(session))return {ok:true,unavailable:true};
    const attorney=matter?.attorneyId||matter?.attorney||job?.attorneyId;
    if(!attorney||await require('../utils/blocks').isBlockedBetween(userId,attorney))fail(403,'This Matter is unavailable.');
    if(matter&&(matter.archived||matter.readOnly||matter.paymentReleased||matter.paralegal||matter.paralegalId||['completed','closed','cancelled','canceled','disputed'].includes(String(matter.status).toLowerCase())))fail(409,'This Matter is no longer accepting applications.');
    if(caseId){
      const invite=matter?.invites?.find(item=>String(item.paralegalId)===String(userId));
      if(invite?.status!=='pending'&&!(String(matter?.pendingParalegalId)===String(userId)&&!invite))fail(403,'This invitation is unavailable.');
    }else if(job?.status!=='open')fail(409,'This Matter is no longer accepting applications.');
    const required=matter?.requirements||job?.requirements||[];
    if(!required.length||JSON.stringify(required)!==JSON.stringify(requirements))fail(409,'The requirements changed. Open the Matter again before confirming.');
    if(matter?.applicants?.some(item=>String(item.paralegalId)===String(userId)&&item.status!=='withdrawn')||job&&await require('../models/Application').exists({jobId:job._id,paralegalId:userId,status:{$ne:'withdrawn'}}).session(session))fail(409,'You already have an application for this Matter.');
    if(job)await Job.updateOne({_id:job._id},{$inc:{__v:1}},{session});
    if(matter)await Case.updateOne({_id:matter._id},{$inc:{__v:1}},{session});
    await Decision.updateOne({matterKey:key,paralegalId:userId},{$setOnInsert:{requirements:required,confirmedAt:new Date()}},{upsert:true,session});
    return {ok:true,unavailable:true};
  },{ownerId:userId,authVersion});
}
module.exports = {normalizeRequirements, assertRequirements, scopeKey, declineRequirements};
