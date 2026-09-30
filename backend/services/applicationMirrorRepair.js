// Explicit maintenance operation. Never invoked by normal reads or application actions.
const mongoose = require('mongoose');
const Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application');
const {id, refs, one, uniqueRecords} = require('./applicationIdentity');
const {fingerprint} = require('./matterDraftRevision');
const {syncApplicationMirror} = require('./applicationService');
const fail = reason => { throw Object.assign(new Error(reason), {code:'APPLICATION_REPAIR_UNSAFE'}); };
const mirrorStatus = status => status === 'submitted' ? 'pending' : status;
function fields(application) {
  const profile = application.profileSnapshot || {};
  return {paralegalId:id(application.paralegalId),note:application.coverLetter || '',resumeURL:application.resumeURL || '',linkedInURL:application.linkedInURL || '',status:mirrorStatus(application.status),appliedAt:application.createdAt,
    profileSnapshot:{location:profile.location||'',availability:profile.availability||'',bio:profile.bio||'',yearsExperience:profile.yearsExperience??null,languages:profile.languages||[],specialties:profile.specialties||[]},requirementConfirmations:application.requirementConfirmations||[]};
}
function normalizedMirror(mirror) {
  return fields({paralegalId:mirror.paralegalId,coverLetter:mirror.note,resumeURL:mirror.resumeURL,linkedInURL:mirror.linkedInURL,status:mirror.status,createdAt:mirror.appliedAt,profileSnapshot:mirror.profileSnapshot,requirementConfirmations:mirror.requirementConfirmations});
}
async function inspect({applicationId,caseId,ownerId}, session=null) {
  const application=await one(Application,applicationId,null,session), matter=await one(Case,caseId,null,session);
  if(!application||!matter)fail('Canonical application or Matter is missing.');
  const job=await one(Job,application.jobId,null,session);
  if(!job||id(job.caseId)!==id(matter._id)||id(matter.jobId||matter.job)!==id(job._id))fail('Application, Job and Matter do not form a reciprocal relationship.');
  if(id(job.attorneyId)!==id(ownerId)||id(matter.attorneyId||matter.attorney)!==id(ownerId)||matter.attorney&&matter.attorneyId&&id(matter.attorney)!==id(matter.attorneyId))fail('Attorney ownership does not agree.');
  if(!['submitted','viewed','shortlisted','accepted','rejected','withdrawn'].includes(application.status))fail('Unknown canonical status.');
  if(matter.archived||['closed','completed'].includes(String(matter.status).toLowerCase()))fail('Closed or archived records require a separate historical review.');
  const canonical=await uniqueRecords(Application,{jobId:{$in:refs(job._id)},paralegalId:{$in:refs(application.paralegalId)}},null,session);
  if(canonical.length!==1||id(canonical[0]._id)!==id(application._id))fail('Ambiguous canonical application.');
  const assigned=id(matter.paralegalId||matter.paralegal);
  if(application.status==='accepted'&&assigned!==id(application.paralegalId))fail('Accepted applicant does not match the assigned paralegal.');
  if(application.status!=='accepted'&&assigned===id(application.paralegalId))fail('Assigned paralegal has a non-accepted canonical application.');
  const all=Array.isArray(matter.applicants)?matter.applicants:[];
  if(matter.applicants!=null&&!Array.isArray(matter.applicants))fail('Unreadable Matter applicant list.');
  const seen=new Set();for(const entry of all){if(seen.has(id(entry.paralegalId)))fail('Duplicate embedded applicant identities.');seen.add(id(entry.paralegalId));}
  const matches=all.filter(a=>id(a.paralegalId)===id(application.paralegalId));
  // Existing disagreements need explicit conflict resolution, not blanket replacement.
  if(matches.length&&application.status!=='withdrawn'&&fingerprint(normalizedMirror(matches[0]))!==fingerprint(fields(application)))fail('Existing mirror disagrees with canonical fields.');
  const needed=application.status==='withdrawn'?matches.length>0:matches.length===0;
  return {application,matter,job,needed,revision:fingerprint([application,matter,job])};
}
function summary(value){return {applicationId:id(value.application._id),caseId:id(value.matter._id),jobId:id(value.job._id),status:value.application.status,needed:value.needed,revision:value.revision,mirrorCount:value.matter.applicants?.length||0};}
async function repair(input, expectedRevision){
  const session=await mongoose.startSession();
  try{session.startTransaction();const before=await inspect(input,session);if(before.revision!==expectedRevision)fail('Records changed after inspection.');
    if(!before.needed){await session.abortTransaction();return {...summary(before),changed:false};}
    await syncApplicationMirror({application:before.application,caseId:before.matter._id,session});
    const after=await inspect(input,session);if(after.needed)fail('Repair did not restore the canonical relationship.');
    await session.commitTransaction();return {...summary(after),changed:true};
  }catch(e){if(session.inTransaction())await session.abortTransaction();throw e;}finally{await session.endSession();}
}
module.exports={inspect,summary,repair};
