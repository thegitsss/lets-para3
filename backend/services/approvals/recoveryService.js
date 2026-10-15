const { randomUUID } = require('node:crypto');
const { LpcEvent } = require('../../models/LpcEvent');
const { routeEvent } = require('../lpcEvents/routerService');
const MAX_ATTEMPTS = 5;
// Only finish already-recorded decisions. This cannot approve drafts, publish
// content, contact recipients, or move funds. Routing is idempotent.
async function recoverApprovalDecisions({ limit = 20, now = new Date() } = {}) {
  let processed = 0, failed = 0;
  while (processed < Math.min(100, Math.max(0, limit))) {
    const claimToken = randomUUID();
    const event = await LpcEvent.findOneAndUpdate({
      eventType: { $in: ['approval.approved', 'approval.rejected'] },
      'routing.status': { $in: ['pending','failed'] },
      $and: [
        { $or: [{ 'routing.attempts': { $lt: MAX_ATTEMPTS } }, { 'routing.attempts': { $exists: false } }] },
        { $or: [{ 'routing.leaseExpiresAt': null }, { 'routing.leaseExpiresAt': { $lte: now } }] },
        { $or: [{ 'routing.nextAttemptAt': null }, { 'routing.nextAttemptAt': { $lte: now } }] },
      ],
    }, { $set: { 'routing.claimToken': claimToken, 'routing.leaseExpiresAt': new Date(now.getTime()+120000) }, $inc: { 'routing.attempts': 1 } }, { sort:{occurredAt:1,_id:1}, returnDocument:'after' });
    if (!event) break;
    processed++;
    try { await routeEvent(event, { claimToken }); }
    catch (_) {
      failed++;
      await LpcEvent.updateOne({_id:event._id,'routing.claimToken':claimToken},{$set:{
        'routing.status':'failed','routing.error':'Decision follow-up could not finish. Check the recorded decision.',
        'routing.claimToken':'','routing.leaseExpiresAt':null,
        'routing.nextAttemptAt':new Date(now.getTime()+Math.min(60,2 ** event.routing.attempts)*60000),
      }});
    }
  }
  const blocked = await LpcEvent.countDocuments({eventType:{$in:['approval.approved','approval.rejected']},'routing.status':{$in:['pending','failed']},'routing.attempts':{$gte:MAX_ATTEMPTS}});
  return {processed,failed,blocked};
}
async function approvalRecoveryStatus() {
  const query={eventType:{$in:['approval.approved','approval.rejected']},'routing.status':{$in:['pending','failed']}};
  const [pending,blocked]=await Promise.all([
    LpcEvent.countDocuments(query),
    LpcEvent.countDocuments({...query,'routing.attempts':{$gte:MAX_ATTEMPTS}}),
  ]);
  return {pending,blocked};
}
module.exports={recoverApprovalDecisions,approvalRecoveryStatus};
