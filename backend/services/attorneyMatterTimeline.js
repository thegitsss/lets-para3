const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Message = require('../models/Message');
const CaseFile = require('../models/CaseFile');
const Event = require('../models/Event');
const Decision = require('../models/ApplicationDecision');
const files = require('./attorneyMatterFiles');
const {decryptCaseFilePayload} = require('../utils/dataEncryption');
const validId = value => /^[a-f0-9]{24}$/i.test(String(value || ''));
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fail = status => {throw Object.assign(new Error('Matter activity could not be verified.'),{status,publicCode:'MATTER_ACTIVITY_UNAVAILABLE'});};
const PAGE_SIZE = 50;
const ACTIONS = {
  'case.create':['Posted','overview'], 'case.update':['Posting updated','overview'],
  'case.task.review':['Agreed work reviewed','work'], 'case.zoom.update':['Meeting details updated','deadlines'],
  'case.file.status.update':['Document review recorded','files'], 'case.file.revision.request':['Document revisions requested','files'],
  'case.file.replace':['Document replaced','files'], 'case.file.remove':['Document removed','files'],
  'case.applicant.rejected':['Application rejected','applications'], 'case.apply':['Application submitted','applications'],
  'paralegal_invited':['Paralegal invited','applications'], 'paralegal_invite_accepted':['Invitation accepted','applications'], 'paralegal_declined':['Invitation declined','applications'],
  'case.release':['Payment released','financials'], 'case.complete.archive':['Matter archive prepared','financials'],
  'case.completion.recorded':['Completion recorded','financials'], 'case.withdrawal.requested':['Paralegal withdrew','financials'],
  'case.withdrawal.recorded':['Withdrawal decision recorded','financials'], 'case.withdrawal.expired':['Withdrawal review window ended','financials'],
  'case.withdrawal.relist':['Remaining work relisted','applications'], 'case.withdrawal.payout':['Partial payout recorded','financials'],
  'case.funding.prepared':['Funding prepared','financials'], 'case.funding.checked':['Funding status checked','financials'], 'case.funding.budget':['Matter amount updated','financials'],
  'case.archive':['Archived','overview'], 'case.restore':['Restored','overview'], 'case.terminate':['Closed','overview'],
  'case.flagged':['Posting flagged for review','overview'], 'case.flag.resolved':['Posting review resolved','overview'],
  'calendar.event.create':['Private calendar entry added','deadlines'], 'calendar.event.update':['Private calendar entry updated','deadlines'],
  'calendar.event.delete':['Private calendar entry removed','deadlines'], 'calendar.event.attendee.add':['Attendee record added','deadlines'], 'calendar.event.reminder.add':['Reminder settings recorded','deadlines'],
};
function parseCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 400 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400);
  let cursor; try {cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail(400);}
  if (!cursor || Object.keys(cursor).sort().join(',') !== 'at,id,snapshot' || !iso(cursor.at) || !iso(cursor.snapshot) || iso(cursor.at) !== cursor.at || iso(cursor.snapshot) !== cursor.snapshot || cursor.at > cursor.snapshot || Date.parse(cursor.snapshot) > Date.now()+2000 || !/^[a-z]+:[a-z0-9_-]{1,80}$/.test(cursor.id || '')) fail(400);
  return cursor;
}
function sourceBoundary(field,prefix,cursor,snapshot) {
  if (!cursor) return {[field]:{$lte:new Date(snapshot)}};
  const [kind,key] = cursor.id.split(':');
  const equal = prefix === kind && validId(key) ? {[field]:new Date(cursor.at),_id:{$lt:new mongoose.Types.ObjectId(key)}} : prefix < kind ? {[field]:new Date(cursor.at)} : null;
  return {$and:[{[field]:{$lte:new Date(snapshot)}},{$or:[{[field]:{$lt:new Date(cursor.at)}},...(equal ? [equal] : [])]}]};
}
function compare(a,b) {return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);}
function pack(items,cursor,snapshot) {
  const seen = new Set(), ids = new Set();
  const rows = items.filter(item=>{
    if (item.id === 'milestone:posted' && items.some(other=>other.id.startsWith('audit:') && other.label==='Posted'))return false;
    if (!item.at || item.at > snapshot || cursor && compare(item,cursor) <= 0) return false;
    const key=`${item.label}|${item.at}|${item.target?.fileId || item.target?.eventId || item.target?.messageId || item.target?.applicantId || ''}|${item.target?.taskIndex ?? ''}`;
    if(ids.has(item.id) || !item.id.startsWith('audit:') && seen.has(key))return false;ids.add(item.id);seen.add(key);return true;
  }).sort(compare);
  const page = rows.slice(0,PAGE_SIZE), last=page.at(-1);
  return {items:page,nextCursor:rows.length > PAGE_SIZE ? Buffer.from(JSON.stringify({at:last.at,id:last.id,snapshot})).toString('base64url') : null};
}
async function list(req) {
  if (Object.keys(req.query).some(key=>!['expectedOwnerId','reviewFeed','cursor'].includes(key)) || req.query.reviewFeed !== '1') fail(400);
  const cursor=parseCursor(req.query.cursor), snapshot=cursor?.snapshot || new Date().toISOString();
  const doc=await files.matter(req), owner=new mongoose.Types.ObjectId(String(req.user.id)), caseId=String(doc._id), variants=[doc._id,caseId];
  const sources = [AuditLog.find({$and:[{$or:[{case:doc._id},{targetType:'case',targetId:caseId}]},{$or:[{action:{$in:Object.keys(ACTIONS).filter(action=>!action.startsWith('calendar.'))}},{action:{$in:Object.keys(ACTIONS).filter(action=>action.startsWith('calendar.'))},actor:owner,'meta.kind':'attorney_calendar_action'}]},sourceBoundary('createdAt','audit',cursor,snapshot)]}).select('_id action actor actorRole createdAt meta targetId').populate('actor','firstName lastName').sort({createdAt:-1,_id:-1}).limit(PAGE_SIZE+1).lean().then(rows=>rows.map(row=>{
    const [base,tab]=ACTIONS[row.action], target={tab};
    if (validId(row.meta?.fileId)) target.fileId=String(row.meta.fileId);
    if (validId(row.meta?.applicantId || row.meta?.paralegalId)) target.applicantId=String(row.meta.applicantId || row.meta.paralegalId);
    if (row.action === 'case.task.review' && Number.isSafeInteger(row.meta?.taskIndex)) target.taskIndex=row.meta.taskIndex;
    if (row.action.startsWith('calendar.') && validId(row.targetId)) target.eventId=String(row.targetId);
    const label=row.action === 'case.file.status.update' ? ({approved:'Document approved',attorney_revision:'Document revisions requested',pending_review:'Document returned to review'})[row.meta?.status] || base : row.action === 'case.task.review' ? row.meta?.completed === true ? 'Work marked complete' : row.meta?.completed === false ? 'Work returned to review' : base : base;
    return {id:`audit:${row._id}`,label,at:iso(row.createdAt),actorName:[row.actor?.firstName,row.actor?.lastName].filter(Boolean).join(' ') || ({system:'LPC',admin:'LPC administrator',attorney:'Attorney',paralegal:'Paralegal'})[row.actorRole] || '',target};
  }))];
  sources.push(Decision.collection.find({$and:[{caseId:{$in:variants},ownerId:{$in:[owner,String(owner)]}},sourceBoundary('recordedAt','decision',cursor,snapshot)]}).sort({recordedAt:-1,_id:-1}).limit(PAGE_SIZE+1).toArray().then(rows=>rows.map(row=>({id:`decision:${row._id}`,label:({star:'Application starred',unstar:'Application star removed',shortlist:'Application shortlisted',return:'Application returned to submitted',reject:'Application rejected'})[row.action] || 'Application decision recorded',at:iso(row.recordedAt),actorName:'You',target:{tab:'applications',...(validId(row.applicantId) ? {applicantId:String(row.applicantId)} : {})}}))));
  if (!doc.purgedAt) {
    sources.push(Message.find({$and:[{caseId:{$in:variants},deleted:{$ne:true},type:{$ne:'system'},$or:[{senderRole:{$in:['attorney','paralegal']}},{senderRole:{$exists:false}}]},sourceBoundary('createdAt','message',cursor,snapshot)]}).select('_id senderId senderRole createdAt').populate('senderId','firstName lastName role').sort({createdAt:-1,_id:-1}).limit(PAGE_SIZE+1).lean().then(rows=>rows.filter(row=>['attorney','paralegal'].includes(row.senderRole || row.senderId?.role)).map(row=>({id:`message:${row._id}`,label:'Message sent',at:iso(row.createdAt),actorName:[row.senderId?.firstName,row.senderId?.lastName].filter(Boolean).join(' ') || (row.senderRole === 'attorney' ? 'Attorney' : 'Paralegal'),target:{tab:'messages',messageId:String(row._id)}}))));
    for (const [field,prefix,label] of [['createdAt','document','Document shared'],['approvedAt','approved','Document approved'],['revisionRequestedAt','revisions','Document revisions requested'],['replacedAt','replaced','Document replaced']]) {
      const query={$and:[{caseId:{$in:variants}},sourceBoundary(field,prefix,cursor,snapshot)]};
      const status=({approvedAt:'approved',revisionRequestedAt:'attorney_revision'})[field];
      const read=field === 'createdAt' ? CaseFile.collection.find(query).sort({[field]:-1,_id:-1}).limit(PAGE_SIZE+1).toArray() : CaseFile.collection.aggregate([
        {$match:query},{$lookup:{from:AuditLog.collection.name,let:{fileId:{$toString:'$_id'},at:'$'+field},pipeline:[{$match:{action:field === 'replacedAt' ? 'case.file.replace' : 'case.file.status.update',...(status ? {'meta.status':status} : {}),$expr:{$and:[{$eq:['$case',doc._id]},{$eq:['$meta.fileId','$$fileId']},{$gte:['$createdAt',{$subtract:['$$at',2000]}]},{$lte:['$createdAt',{$add:['$$at',2000]}]},{$lte:['$createdAt',new Date(snapshot)]}]}}},{$limit:1}],as:'recordedChange'}},{$match:{recordedChange:{$size:0}}},{$sort:{[field]:-1,_id:-1}},{$limit:PAGE_SIZE+1},{$unset:'recordedChange'},
      ]).toArray();
      sources.push(read.then(rows=>rows.map(raw=>{const plain=decryptCaseFilePayload(raw);return {id:`${prefix}:${raw._id}`,label,detail:plain.originalName || 'Document',at:iso(raw[field]),actorName:field === 'createdAt' ? ({attorney:'Attorney',paralegal:'Paralegal'})[plain.uploadedByRole] || '' : '',target:{tab:'files',fileId:String(raw._id)}};})));
    }
  }
  // Never expose another user's private calendar entries through a Matter feed.
  sources.push(Event.aggregate([
    {$match:{$and:[{caseId:{$in:variants},owner:{$in:[owner,String(owner)]}},sourceBoundary('createdAt','calendar',cursor,snapshot)]}},
    {$lookup:{from:AuditLog.collection.name,let:{eventId:{$toString:'$_id'}},pipeline:[{$match:{actor:owner,case:doc._id,action:'calendar.event.create','meta.kind':'attorney_calendar_action',$expr:{$eq:['$targetId','$$eventId']}}},{$limit:1}],as:'recordedCreation'}},
    {$match:{recordedCreation:{$size:0}}},{$sort:{createdAt:-1,_id:-1}},{$limit:PAGE_SIZE+1},{$project:{_id:1,title:1,createdAt:1}},
  ]).then(rows=>rows.map(row=>({id:`calendar:${row._id}`,label:'Private calendar entry added',detail:row.title,at:iso(row.createdAt),actorName:'You',target:{tab:'deadlines',eventId:String(row._id)}}))));
  const results=await Promise.allSettled(sources), items=results.flatMap(result=>result.status === 'fulfilled' ? result.value : []);
  for (const [field,key,label,tab] of [['createdAt','posted','Posted','overview'],['hiredAt','assigned','Paralegal assigned','work'],['completedAt','completed','Completed','financials'],['pausedAt','paused','Matter paused','financials'],['relistRequestedAt','relisted','Remaining work relisted','applications']]) if(iso(doc[field]))items.push({id:`milestone:${key}`,label,at:iso(doc[field]),actorName:'',target:{tab}});
  const current=await files.matter(req); if(files.matterRevision(doc) !== files.matterRevision(current))fail(409);
  return {caseId,caseTitle:doc.title || 'Untitled Matter',ownerId:String(req.user.id),feedVersion:1,complete:results.every(result=>result.status === 'fulfilled'),...pack(items,cursor,snapshot)};
}
module.exports={list,parseCursor,sourceBoundary,pack,ACTIONS};
