const Case = require('../models/Case');
const { recentActivity } = require('./attorneyMatterActivity');
const { inventoryPipeline, parseInventoryQuery } = require('./attorneyMatterInventory');
const { getBlockedUserIds } = require('../utils/blocks');
const { fingerprint } = require('./matterDraftRevision');
const { dateOnlyFromZonedInstant, startOfWeekDateOnly, endOfWeekDateOnly } = require('../utils/businessDate');

const LIMIT = 5;
const changed = () => Object.assign(new Error('Your Matters changed while Home was loading. Refresh to see the current records.'), { status: 409, publicCode: 'HOME_INVENTORY_CHANGED' });
const truthy = value => ({ $not: [{ $in: [{ $ifNull: [value, null] }, [null, '', false, 0]] }] });
const current = { __inventorySource: 'case', __inventoryArchived: false, __inventoryStatus: { $ne: 'draft' } };
const order = { __inventoryUpdated: -1, _id: -1 };
const fields = { _id: 0, id: { $toString: '$_id' }, title: { $ifNull: ['$title', ''] }, label: '$__inventoryLabel', practiceArea: { $ifNull: ['$practiceArea', ''] } };


function parseHomeQuery(query = {}) {
  if (Object.keys(query).some(key => !['expectedOwnerId', 'attentionPage', 'deadlinePage'].includes(key) || typeof query[key] !== 'string') || ['attentionPage', 'deadlinePage'].some(key => query[key] && !/^[1-9]\d{0,5}$/.test(query[key]))) throw Object.assign(new Error('Invalid Home request.'), { status: 400 });
  return { attentionPage: Number(query.attentionPage || 1), deadlinePage: Number(query.deadlinePage || 1) };
}

function homePipeline(ownerId, blocked, now, attentionPage, deadlinePage) {
  const today = dateOnlyFromZonedInstant(now), start = startOfWeekDateOnly(today), end = endOfWeekDateOnly(today);
  const active = { $and: [{ $eq: ['$__inventorySource', 'case'] }, { $not: ['$__inventoryArchived'] }, { $ne: ['$__inventoryStatus', 'draft'] }] };
  const action = (condition, name) => ({ $cond: [condition, [name], []] });
  const attention = [
    { $set: { actions: { $concatArrays: [
      action({ $and: [active, { $in: ['pending_review', { $ifNull: ['$files.status', []] }] }] }, 'files'),
      action({ $and: [active, { $in: ['$moderationStatus', ['flagged', 'resolution_requested']] }] }, 'moderation'),
      action({ $and: [active, { $or: [truthy('$paralegal'), truthy('$paralegalId')] }, { $ne: ['$escrowStatus', 'funded'] }, { $ne: ['$__inventoryStatus', 'open'] }] }, 'payment'),
      action({ $and: [{ $eq: ['$__inventorySource', 'case'] }, '$__inventoryArchived', { $eq: ['$__inventoryStatus', 'paused'] }, { $eq: ['$pausedReason', 'paralegal_withdrew'] }, { $not: [truthy('$payoutFinalizedAt')] }] }, 'withdrawal'),
    ] } } },
    { $match: { 'actions.0': { $exists: true } } },
  ];
  const completed = { __inventorySource: 'case', __inventoryCompleted: true };
  const deadlines = { ...current, __inventoryDeadline: { $gte: start, $lte: end } };
  const pipeline = inventoryPipeline(ownerId, parseInventoryQuery(), now, blocked, {
    extraFields: { 'files.status': 1, moderationStatus: 1, hiredAt: 1 },
    facets: {
      invalid: [{ $match: { __applicationInvalid: true } }, { $limit: 1 }, { $project: { _id: 1 } }],
      counts: [{ $group: { _id: '$__inventoryBucket', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      posted: [{ $match: { __inventorySource: 'case', __inventoryStatus: { $ne: 'draft' } } }, { $count: 'total' }],
      attentionTotal: [...attention, { $count: 'total' }],
      attention: [...attention, { $sort: order }, { $skip: (attentionPage - 1) * LIMIT }, { $limit: LIMIT }, { $project: { ...fields, actions: 1 } }],
      recentTotal: [{ $match: current }, { $count: 'total' }],
      recent: [{ $match: current }, ...recentActivity(now), { $sort: { lastActivityAt: -1, _id: -1 } }, { $limit: 5 }, { $project: { ...fields, lastActivityAt: 1, assignedParalegalName: { $trim: { input: { $concat: [{ $ifNull: ['$__inventoryParalegal.firstName', ''] }, ' ', { $ifNull: ['$__inventoryParalegal.lastName', ''] }] } } } } }],
      completedTotal: [{ $match: completed }, { $count: 'total' }],
      completed: [{ $match: completed }, { $sort: order }, { $limit: 3 }, { $project: fields }],
      deadlineTotal: [{ $match: deadlines }, { $count: 'total' }],
      deadlines: [{ $match: deadlines }, { $sort: { __inventoryDeadline: 1, _id: 1 } }, { $skip: (deadlinePage - 1) * 3 }, { $limit: 3 }, { $project: { ...fields, dueDate: '$__inventoryDeadline' } }],
    },
  });
  return { pipeline, start, end };
}

async function readHomeInventory(ownerId, { attentionPage = 1, deadlinePage = 1 } = {}, { now = new Date() } = {}) {
  const blocks = async () => (await getBlockedUserIds(ownerId)).map(value => String(value).toLowerCase()).sort();
  const blocked = await blocks(), { pipeline, start, end } = homePipeline(ownerId, blocked, now, attentionPage, deadlinePage);
  const run = () => Case.aggregate(pipeline).collation({ locale: 'en', strength: 3 }).option({ maxTimeMS: 15000, allowDiskUse: true });
  const [result] = await run();
  if (result.invalid?.length) throw changed();
  const revision = fingerprint(result);
  const [currentResult] = await run();
  if (fingerprint(currentResult) !== revision || fingerprint(await blocks()) !== fingerprint(blocked)) throw changed();
  const count = key => result[key][0]?.total || 0;
  const counts = Object.fromEntries(['active', 'applications', 'draft', 'archived'].map(view => [view, 0]));
  for (const row of result.counts) counts[row._id] = row.count;
  const total = count('attentionTotal');
  return { ownerId, revision, counts, postedCount: count('posted'),
    attention: { items: result.attention, total, page: attentionPage, pageSize: LIMIT, pages: Math.max(1, Math.ceil(total / LIMIT)) },
    recent: { items: result.recent, total: count('recentTotal') },
    completed: { items: result.completed, total: count('completedTotal') },
    week: { start, end, items: result.deadlines, total: count('deadlineTotal'), page: deadlinePage, pageSize: 3, pages: Math.max(1, Math.ceil(count('deadlineTotal') / 3)) },
  };
}

module.exports = { parseHomeQuery, readHomeInventory };
