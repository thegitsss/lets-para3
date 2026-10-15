const Ticket = require('../models/SupportTicket');
const Approval = require('../models/IncidentApproval');
const Incident = require('../models/Incident');
const {INCIDENT_TERMINAL_STATES} = require('../utils/incidentConstants');

// Only an explicit technical handoff covered by one current decision can share
// its queue entry. A shared Matter alone is not proof of the same decision.
// New facts, personal reminders and separate communication/financial authority
// remain individual tasks. This projection never resolves a domain record.
async function relatedTechnicalReports({query,now,protectedIds=[]}) {
  return Ticket.aggregate([
    {$match:{$and:[query,{
      requestKind:'support','routingSuggestion.ownerKey':'incident_watch',
      followUpAt:null,administrativeRequestKey:{$exists:false},
      riskFlags:{$not:{$elemMatch:{$ne:'active_incident'}}},
      ...(protectedIds.length?{_id:{$nin:protectedIds}}:{}),
      $expr:{$and:[
        {$eq:[{$size:{$ifNull:['$linkedIncidentIds',[]]}},1]},
        {$not:[{$in:[{$ifNull:[{$arrayElemAt:['$emailReplies.delivery',-1]},'']},['unknown','pending','disabled','failed']]}]},
      ]},
    }]}},
    {$lookup:{from:'incidents',localField:'linkedIncidentIds',foreignField:'_id',as:'relatedIncident',pipeline:[{$match:{state:{$nin:INCIDENT_TERMINAL_STATES}}},{$project:{_id:1}}]}},
    {$match:{$expr:{$eq:[{$size:'$relatedIncident'},1]}}},
    {$lookup:{from:'incident_approvals',localField:'linkedIncidentIds',foreignField:'incidentId',as:'relatedApproval',pipeline:[{$match:{status:'pending',$or:[{expiresAt:null},{expiresAt:{$gt:now}}]}},{$limit:2},{$project:{_id:1,updatedAt:1}}]}},
    {$match:{$expr:{$and:[{$eq:[{$size:'$relatedApproval'},1]},{$lte:['$updatedAt',{$arrayElemAt:['$relatedApproval.updatedAt',0]}]}]}}},
    {$sort:{createdAt:1,_id:1}},
    {$project:{_id:1,subject:1,updatedAt:1,incidentId:{$arrayElemAt:['$linkedIncidentIds',0]},approvalId:{$arrayElemAt:['$relatedApproval._id',0]},approvalUpdatedAt:{$arrayElemAt:['$relatedApproval.updatedAt',0]}}},
  ]);
}

async function verifyRelatedReports(rows,now) {
  if (!rows.length) return;
  const decisions=[...new Map(rows.map(row=>[String(row.approvalId),row])).values()];
  const incidentIds=[...new Set(rows.map(row=>String(row.incidentId)))];
  const [reports,approvals,incidents,currentDecisions]=await Promise.all([
    Ticket.countDocuments({$or:rows.map(row=>({_id:row._id,updatedAt:row.updatedAt}))}),
    Approval.countDocuments({$and:[{status:'pending',$or:[{expiresAt:null},{expiresAt:{$gt:now}}]},{$or:decisions.map(row=>({_id:row.approvalId,updatedAt:row.approvalUpdatedAt}))}]}),
    Incident.countDocuments({_id:{$in:incidentIds},state:{$nin:INCIDENT_TERMINAL_STATES}}),
    Approval.countDocuments({incidentId:{$in:incidentIds},status:'pending',$or:[{expiresAt:null},{expiresAt:{$gt:now}}]}),
  ]);
  if (reports!==rows.length || approvals!==decisions.length || incidents!==incidentIds.length || currentDecisions!==decisions.length) {
    throw Object.assign(new Error('Related work changed while the queue was being checked. Refresh to see the current decisions.'),{statusCode:409});
  }
}

module.exports={relatedTechnicalReports,verifyRelatedReports};
