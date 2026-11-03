const Case = require('../models/Case');
const Payment = require('../models/PaymentOperation');
// Group only the same explicit funding intent, with one outstanding operation.
// A dispute, overdue deadline, separate workflow failure or personal follow-up
// remains its own decision. This read projection never resolves either record.
async function relatedFinancialMatters({ query, now, protectedIds = [] }) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return Case.aggregate([
    { $match: { $and: [query, { fundingIntegrityStatus: 'failed', _id: { $nin: protectedIds },
      postingSyncStatus: { $ne: 'needs_reconciliation' }, hiringClaimStatus: { $ne: 'needs_reconciliation' }, completionClaimStatus: { $ne: 'needs_reconciliation' },
      moderationStatus: { $ne: 'resolution_requested' },
      $nor: [{ disputes: { $elemMatch: { status: { $nin: ['resolved', 'rejected'] } } } },
        { status: { $in: ['open', 'in progress', 'in_progress', 'paused'] }, deadlineDate: { $nin: ['', null], $lt: today } }],
    }] } },
    { $set: { fundingIntent: { $ifNull: ['$escrowIntentId', '$paymentIntentId'] } } },
    { $match: { fundingIntent: { $type: 'string', $ne: '' } } },
    { $lookup: { from: Payment.collection.name, let: { caseId: '$_id', intent: '$fundingIntent' }, pipeline: [
      { $match: { kind: 'funding', status: { $in: ['failed', 'needs_reconciliation'] }, $expr: { $and: [{ $eq: ['$caseId', '$$caseId'] }, { $eq: ['$stripePaymentIntentId', '$$intent'] }] } } },
      { $limit: 2 }, { $project: { _id: 1, updatedAt: 1 } },
    ], as: 'fundingOperation' } },
    { $match: { $expr: { $eq: [{ $size: '$fundingOperation' }, 1] } } },
    { $project: { _id: 1, updatedAt: 1, title: 1, operationId: { $arrayElemAt: ['$fundingOperation._id', 0] }, operationUpdatedAt: { $arrayElemAt: ['$fundingOperation.updatedAt', 0] } } },
  ]);
}
async function verifyRelatedFinancialMatters(rows) {
  if (!rows.length) return;
  const [cases, operations] = await Promise.all([
    Case.countDocuments({ $or: rows.map(row => ({ _id: row._id, updatedAt: row.updatedAt })) }),
    Payment.countDocuments({ $or: rows.map(row => ({ _id: row.operationId, updatedAt: row.operationUpdatedAt, kind: 'funding', status: { $in: ['failed', 'needs_reconciliation'] } })) }),
  ]);
  if (cases !== rows.length || operations !== rows.length) throw Object.assign(new Error('Related financial work changed. Refresh the queue before deciding.'), { statusCode: 409 });
}
module.exports = { relatedFinancialMatters, verifyRelatedFinancialMatters };
