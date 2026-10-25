const Message = require('../models/Message');
const CaseFile = require('../models/CaseFile');
const AuditLog = require('../models/AuditLog');

// Explicit user-visible events; background saves and message read receipts do not count.
function recentActivity(now) {
  const validDate = value => ({ $convert: { input: value, to: 'date', onError: null, onNull: null } });
  const actions = ['case.create', 'case.update', 'case.task.review', 'case.zoom.update', 'case.file.attach', 'case.file.status.update', 'case.file.revision.request', 'case.file.replace', 'case.apply', 'paralegal_invited', 'paralegal_invite_accepted', 'paralegal_declined', 'case.withdrawal.requested', 'case.withdrawal.reject', 'case.restore'];
  return [
    { $lookup: { from: Message.collection.name, localField: '_id', foreignField: 'caseId', pipeline: [
      { $match: { deleted: { $ne: true }, senderRole: { $in: ['attorney', 'paralegal'] }, type: { $ne: 'system' }, createdAt: { $lte: now } } },
      { $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { _id: 0, at: '$createdAt' } },
    ], as: '__activityMessages' } },
    { $lookup: { from: CaseFile.collection.name, localField: '_id', foreignField: 'caseId', pipeline: [
      { $project: { _id: 0, at: { $max: ['$createdAt', '$approvedAt', '$revisionRequestedAt', '$replacedAt'] } } },
      { $match: { at: { $lte: now } } }, { $sort: { at: -1 } }, { $limit: 1 },
    ], as: '__activityFiles' } },
    { $lookup: { from: AuditLog.collection.name, let: { matterId: { $toString: '$_id' } }, pipeline: [
      { $match: { $expr: { $eq: ['$targetId', '$$matterId'] }, targetType: 'case', action: { $in: actions }, actorRole: { $in: ['attorney', 'paralegal', 'admin'] }, createdAt: { $lte: now } } },
      { $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { _id: 0, at: '$createdAt' } },
    ], as: '__activityActions' } },
    { $set: { lastActivityAt: { $max: [validDate('$createdAt'), validDate('$hiredAt'), { $max: '$__activityMessages.at' }, { $max: '$__activityFiles.at' }, { $max: '$__activityActions.at' }] } } },
  ];
}

module.exports = { recentActivity };
