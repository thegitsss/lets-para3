const mongoose = require('mongoose');
const Audit = require('../models/AuditLog');
const Ticket = require('../models/SupportTicket');
const User = require('../models/User');
const Message = require('../models/SupportMessage');
const LABELS = {
  'admin.user.approved': 'Application approved', 'admin.user.denied': 'Application denied',
  'admin.profile_photo.approved': 'Photo approved', 'admin.profile_photo.rejected': 'Photo rejected',
  'admin.user.information_requested': 'Information request recorded',
  'admin.user.suspended': 'Account suspended', 'admin.user.reinstated': 'Account reinstated',
};
async function readHandled({ owner, now = new Date(), limit = 20 } = {}) {
  if (!mongoose.isValidObjectId(owner)) throw Object.assign(new Error('Current Admin access is required.'), { statusCode: 403 });
  const since = new Date(now.getTime() - 7 * 86400000), actor = new mongoose.Types.ObjectId(owner);
  const [audits, replies, conversations] = await Promise.all([
    Audit.find({ actor, actorRole: 'admin', createdAt: { $gte: since, $lte: now }, action: { $in: Object.keys(LABELS) } }).select('action targetId targetType createdAt').sort({ createdAt: -1, _id: -1 }).limit(limit).lean(),
    Ticket.aggregate([
      { $match: { emailReplies: { $elemMatch: { adminId: actor, delivery: 'accepted', createdAt: { $gte: since, $lte: now } } } } },
      { $unwind: '$emailReplies' },
      { $match: { 'emailReplies.adminId': actor, 'emailReplies.delivery': 'accepted', 'emailReplies.createdAt': { $gte: since, $lte: now } } },
      { $sort: { 'emailReplies.createdAt': -1, _id: -1 } }, { $limit: limit },
      { $project: { subject: 1, reply: '$emailReplies' } },
    ]),
    Message.find({ 'metadata.adminId': { $in: [String(owner), actor] }, 'metadata.kind': 'team_reply', createdAt: { $gte: since, $lte: now } }).select('createdAt metadata').sort({ createdAt: -1, _id: -1 }).limit(limit).lean(),
  ]);
  const ids = audits.filter(row => row.targetType === 'user' && mongoose.isValidObjectId(row.targetId)).map(row => row.targetId);
  const names = new Map((await User.find({ _id: { $in: ids } }).select('firstName lastName').lean()).map(row => [String(row._id), [row.firstName, row.lastName].filter(Boolean).join(' ')]));
  const items = [
    ...audits.map(row => ({ id: String(row._id), label: LABELS[row.action], name: names.get(String(row.targetId)) || '', createdAt: row.createdAt, section: 'user-management', targetId: String(row.targetId), outcome: 'recorded', key: `audit:${row._id}` })),
    ...conversations.map(row => ({ id: String(row._id), label: 'Reply recorded in conversation', name: '', createdAt: row.createdAt, section: 'support-ops', targetId: String(row.metadata.ticketId || ''), outcome: 'recorded', key: `reply:${row.metadata.adminReplyRequestId || row._id}` })),
    ...replies.map(row => ({ id: `${row._id}:${row.reply.requestId || row.reply._id}`, label: 'Reply accepted for delivery', name: row.subject, createdAt: row.reply.createdAt, section: 'support-ops', targetId: String(row._id), outcome: 'provider_accepted', key: `reply:${row.reply.requestId || row.reply._id}` })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const seen = new Set();
  const distinct = items.filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true; }).slice(0, limit);
  return { available: true, since: since.toISOString(), checkedAt: now.toISOString(), items: distinct, definition: 'Recorded decisions, in-app replies and provider-accepted email replies by this Admin in the last seven days. Acceptance does not prove inbox delivery or resolution.' };
}
module.exports = { readHandled };
