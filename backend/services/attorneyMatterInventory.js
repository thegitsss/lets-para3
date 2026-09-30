const mongoose = require('mongoose');
const { recentActivity } = require('./attorneyMatterActivity');
const Case = require('../models/Case');
const CaseDraft = require('../models/CaseDraft');
const User = require('../models/User');
const { applicationPendingStages } = require('./applicationPendingStages');
const { fingerprint } = require('./matterDraftRevision');
const { getBlockedUserIds } = require('../utils/blocks');
const { dateOnlyFromZonedInstant, addCalendarDays } = require('../utils/businessDate');

const PAGE_SIZE = 15;
const VIEWS = ['active', 'draft', 'archived', 'applications'];
const ARCHIVE_STATUSES = ['completed', 'closed', 'paused', 'cancelled', 'canceled'];
const METADATA_FIELDS = Object.fromEntries(['title', 'practiceArea', 'status', 'archived', 'paymentReleased', 'pausedReason', 'relistRequestedAt', 'payoutFinalizedAt', 'payoutFinalizedType', 'disputeDeadlineAt', 'paralegal', 'paralegalId', 'deadlineDate', 'deadline', 'updatedAt', 'createdAt', 'hiredAt', 'attorney', 'attorneyId', 'job', 'jobId', 'escrowStatus', 'applicants.status', 'applicants.paralegalId'].map(field => [field, 1]));
const invalid = () => Object.assign(new Error('Invalid Matter list request.'), { status: 400 });
const text = value => ({ $convert: { input: value, to: 'string', onError: '', onNull: '' } });
const truthy = value => ({ $not: [{ $in: [{ $ifNull: [value, null] }, [null, '', false, 0]] }] });
const firstValue = (a, b) => ({ $cond: [truthy(a), a, b] });
const date = value => ({ $convert: { input: value, to: 'date', onError: null, onNull: null } });
const objectId = value => ({ $convert: { input: value, to: 'objectId', onError: null, onNull: null } });

function parseInventoryQuery(query = {}) {
  const allowed = new Set(['expectedOwnerId', 'view', 'q', 'practice', 'deadline', 'updated', 'sort', 'archiveStatus', 'page', 'targetId']);
  if (Object.keys(query).some(key => !allowed.has(key) || typeof query[key] !== 'string')) throw invalid();
  const choice = (key, values, fallback = '') => {
    const value = query[key] || fallback;
    if (!values.includes(value)) throw invalid();
    return value;
  };
  if ((query.q || '').length > 200 || (query.practice || '').length > 200 || /[\u0000-\u001f\u007f]/.test((query.q || '') + (query.practice || ''))) throw invalid();
  if (query.page && (!/^[1-9]\d{0,6}$/.test(query.page) || Number(query.page) > 1000000)) throw invalid();
  if (query.targetId && !/^[a-f0-9]{24}$/i.test(query.targetId)) throw invalid();
  return {
    view: choice('view', VIEWS, 'active'), search: (query.q || '').trim(), practice: query.practice || '',
    deadline: choice('deadline', ['', 'overdue', '7_days', 'none']), updated: choice('updated', ['', '7_days', '30_days']),
    sort: choice('sort', ['recent', 'deadline', 'status', 'alphabetical', 'recent_reverse', 'deadline_reverse', 'status_reverse', 'alphabetical_reverse'], 'recent'),
    archiveStatus: choice('archiveStatus', ['all', 'completed', 'paused', 'archived'], 'all'), page: Number(query.page || 1), targetId: (query.targetId || '').toLowerCase(),
  };
}

// This is a read projection of the existing V2 categories. It never changes a
// Case, applicant mirror, draft, assignment, lifecycle or payment record.
function inventoryPipeline(ownerId, filters, now = new Date(), blocked = [], { extraFields = {}, facets } = {}) {
  const owner = new mongoose.Types.ObjectId(ownerId), variants = [owner, ownerId, ownerId.toUpperCase()];
  const today = dateOnlyFromZonedInstant(now), nextWeek = addCalendarDays(today, 7);
  const normalStatus = { $toLower: { $trim: { input: text('$status') } } };
  const normalizedStatus = { $switch: { branches: [
    { case: { $in: [normalStatus, ['in_progress', 'active', 'awaiting_documents', 'reviewing']] }, then: 'in progress' },
    { case: { $in: [normalStatus, ['cancelled', 'canceled']] }, then: 'closed' },
    { case: { $in: [normalStatus, ['assigned', 'awaiting_funding']] }, then: 'open' },
  ], default: normalStatus } };
  const rawArchive = { $or: [
    { $eq: ['$archived', true] }, { $eq: ['$paymentReleased', true] },
    { $in: ['$status', ARCHIVE_STATUSES.filter(status => status !== 'paused')] },
    { $and: [{ $eq: ['$status', 'paused'] }, { $eq: [{ $ifNull: ['$relistRequestedAt', null] }, null] }] },
  ] };
  const deadlineCandidate = { $substrBytes: [{ $trim: { input: text(firstValue('$deadlineDate', '$deadline')) } }, 0, 10] };
  const deadlineDate = { $dateFromString: { dateString: deadlineCandidate, format: '%Y-%m-%d', onError: null, onNull: null } };
  const match = { __inventoryBucket: filters.view };
  const expressions = [];
  if (filters.search) expressions.push({ $regexMatch: { input: '$__inventorySearch', regex: filters.search.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
  if (filters.practice) expressions.push({ $eq: [{ $ifNull: ['$practiceArea', ''] }, filters.practice] });
  if (filters.deadline === 'none') expressions.push({ $eq: ['$__inventoryDeadline', ''] });
  if (filters.deadline === 'overdue') expressions.push({ $and: [{ $ne: ['$__inventoryDeadline', ''] }, { $lt: ['$__inventoryDeadline', today] }] });
  if (filters.deadline === '7_days') expressions.push({ $and: [{ $gte: ['$__inventoryDeadline', today] }, { $lte: ['$__inventoryDeadline', nextWeek] }] });
  if (filters.updated) expressions.push({ $gte: ['$__inventoryUpdated', new Date(now.getTime() - (filters.updated === '7_days' ? 7 : 30) * 86400000)] });
  if (filters.view === 'archived' && filters.archiveStatus !== 'all') {
    if (filters.archiveStatus === 'completed') expressions.push('$__inventoryCompleted');
    if (filters.archiveStatus === 'paused') expressions.push({ $eq: ['$__inventoryStatus', 'paused'] });
    if (filters.archiveStatus === 'archived') expressions.push({ $and: [{ $not: ['$__inventoryCompleted'] }, { $ne: ['$__inventoryStatus', 'paused'] }] });
  }
  if (expressions.length) match.$expr = { $and: expressions };
  const titleSort = { title: 1, _id: 1, __inventorySource: 1 };
  const sortKey = filters.sort.replace(/_reverse$/, '');
  const sort = sortKey === 'alphabetical' ? titleSort : sortKey === 'deadline' ? { __inventoryDeadlineSort: 1, ...titleSort } : sortKey === 'status' ? { __inventoryLabel: 1, ...titleSort } : { lastActivityAt: -1, _id: -1, __inventorySource: 1 };
  if (filters.sort.endsWith('_reverse')) for (const key of Object.keys(sort)) sort[key] *= -1;
  return [
    { $match: { $or: [{ attorney: { $in: variants } }, { attorneyId: { $in: variants } }] } },
    { $project: { ...METADATA_FIELDS, ...extraFields } },
    ...applicationPendingStages(ownerId, blocked),
    { $set: { __inventorySource: 'case' } },
    // Publication locks its source in the same transaction as the Case/Job.
    // Cleanup may be interrupted; that source is evidence, not unfinished work.
    { $unionWith: { coll: CaseDraft.collection.name, pipeline: [{ $match: { owner: { $in: variants }, publishedCaseId: null } }, { $project: METADATA_FIELDS }, { $set: { __inventorySource: 'draft' } }] } },
    { $set: { title: { $cond: [{ $eq: ['$__inventorySource', 'draft'] }, firstValue('$title', 'Untitled Matter'), '$title'] } } },
    { $set: {
      __inventoryStatus: normalizedStatus, __inventoryArchiveSource: rawArchive,
      __inventoryPrimaryId: objectId('$paralegal'), __inventorySecondaryId: objectId('$paralegalId'),
      __inventoryDeadline: { $cond: [{ $and: [{ $regexMatch: { input: deadlineCandidate, regex: /^\d{4}-\d{2}-\d{2}$/ } }, { $eq: [{ $dateToString: { date: deadlineDate, format: '%Y-%m-%d', onNull: '' } }, deadlineCandidate] }, { $gte: [deadlineCandidate, '0100-01-01'] }] }, deadlineCandidate, ''] },
      __inventoryUpdated: { $ifNull: [date(firstValue('$updatedAt', '$createdAt')), new Date(0)] },

    } },
    { $set: { __inventoryParalegalIds: ['$__inventoryPrimaryId', '$__inventorySecondaryId'] } },
    { $lookup: { from: User.collection.name, localField: '__inventoryParalegalIds', foreignField: '_id', pipeline: [{ $project: { firstName: 1, lastName: 1 } }], as: '__inventoryPeople' } },
    { $set: {
      __inventoryParalegal: { $ifNull: [
        { $arrayElemAt: [{ $filter: { input: '$__inventoryPeople', as: 'person', cond: { $eq: ['$$person._id', '$__inventoryPrimaryId'] } } }, 0] },
        { $arrayElemAt: [{ $filter: { input: '$__inventoryPeople', as: 'person', cond: { $eq: ['$$person._id', '$__inventorySecondaryId'] } } }, 0] },
      ] },
      __inventoryArchived: { $or: [rawArchive, truthy('$archived'), truthy('$paymentReleased'), { $in: ['$__inventoryStatus', ['completed', 'closed']] }, { $and: [
        { $eq: ['$__inventoryStatus', 'paused'] }, { $not: [truthy('$relistRequestedAt')] },
        { $not: [{ $and: [truthy('$payoutFinalizedAt'), { $in: ['$payoutFinalizedType', ['zero_auto', 'partial_attorney', 'expired_zero', 'admin']] }] }] },
      ] }] },
      __inventoryCompleted: { $or: [truthy('$paymentReleased'), { $eq: ['$__inventoryStatus', 'completed'] }] },
      __inventoryDeadlineSort: firstValue('$__inventoryDeadline', '9999-12-31'),
    } },
    { $set: {
      __inventoryBucket: { $switch: { branches: [
        { case: { $eq: ['$__inventorySource', 'draft'] }, then: 'draft' },
        { case: '$__inventoryArchived', then: 'archived' },
        { case: { $and: [{ $eq: [{ $ifNull: ['$__inventoryParalegal', null] }, null] }, { $gt: ['$__inventoryApplicants', 0] }] }, then: 'applications' },
        { case: { $eq: ['$__inventoryStatus', 'draft'] }, then: 'draft' },
      ], default: 'active' } },
      __inventorySearch: { $toLower: { $concat: [text('$title'), ' ', text('$practiceArea'), ' ', { $trim: { input: { $concat: [text('$__inventoryParalegal.firstName'), ' ', text('$__inventoryParalegal.lastName')] } } }] } },
      __inventoryLabel: { $switch: { branches: [
        { case: { $eq: ['$__inventorySource', 'draft'] }, then: 'Draft' },
        { case: { $and: [{ $eq: ['$__inventoryStatus', 'paused'] }, { $eq: ['$pausedReason', 'paralegal_withdrew'] }, { $not: [truthy('$payoutFinalizedAt')] }, { $gt: [date('$disputeDeadlineAt'), now] }] }, then: '24 Hour Hold' },
        { case: { $and: [truthy('$archived'), { $not: [{ $in: ['$__inventoryStatus', ['completed', 'closed', 'paused', 'disputed']] }] }] }, then: 'Archived' },
        ...Object.entries({ open: 'Posted', 'in progress': 'In Progress', completed: 'Completed', disputed: 'Disputed', archived: 'Archived', closed: 'Closed', paused: 'Paused', draft: 'Draft' }).map(([key, value]) => ({ case: { $eq: ['$__inventoryStatus', key] }, then: value })),
      ], default: { $cond: [truthy('$__inventoryStatus'), { $concat: ['Status: ', { $replaceAll: { input: '$__inventoryStatus', find: '_', replacement: ' ' } }] }, 'Status unavailable'] } } },
    } },
    ...(!facets ? [...recentActivity(now), { $set: { lastActivityAt: { $cond: [{ $eq: ['$__inventorySource', 'draft'] }, '$__inventoryUpdated', '$lastActivityAt'] } } }] : []),
    { $facet: facets || {
      invalid: [{ $match: { __applicationInvalid: true } }, { $limit: 1 }, { $project: { _id: 1 } }],
      counts: [{ $group: { _id: '$__inventoryBucket', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      practices: [{ $match: { practiceArea: { $type: 'string', $ne: '' } } }, { $group: { _id: '$practiceArea' } }, { $sort: { _id: 1 } }],
      total: [{ $match: match }, { $count: 'count' }],
      rows: [{ $match: match }, { $sort: sort }, { $skip: (filters.page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }, { $project: { _id: 1, __inventorySource: 1, __inventoryArchiveSource: 1, __inventoryBucket: 1, updatedAt: 1, lastActivityAt: 1 } }],
      ...(filters.targetId ? { target: [
        { $match: match },
        { $setWindowFields: { sortBy: sort, output: { position: { $sum: 1, window: { documents: ['unbounded', 'current'] } } } } },
        { $match: { _id: new mongoose.Types.ObjectId(filters.targetId), __inventorySource: 'case' } },
        { $project: { position: 1 } },
      ] } : {}),
    } },
  ];
}

async function readInventory(ownerId, filters, { now = new Date() } = {}) {
  const blocked = (await getBlockedUserIds(ownerId)).map(value => String(value).toLowerCase()).sort();
  const run = values => Case.aggregate(inventoryPipeline(ownerId, values, now, blocked)).collation({ locale: 'en', strength: 3 }).option({ maxTimeMS: 15000, allowDiskUse: true });
  let [result] = await run(filters);
  if (result.invalid?.length) throw Object.assign(new Error('Application records need verification before this list can be shown.'), { status: 409 });
  const targetPosition = result.target?.[0]?.position;
  const page = targetPosition ? Math.ceil(targetPosition / PAGE_SIZE) : filters.page;
  if (page !== filters.page) [result] = await run({ ...filters, page, targetId: '' });
  if (targetPosition && !result.rows.some(row => row.__inventorySource === 'case' && String(row._id) === filters.targetId)) throw Object.assign(new Error('Matter list changed.'), { status: 409 });
  const counts = Object.fromEntries(VIEWS.map(view => [view, 0]));
  for (const entry of result.counts) counts[entry._id] = entry.count;
  const total = result.total[0]?.count || 0;
  const revision = fingerprint(result);
  const verify = async () => {
    const currentBlocked = (await getBlockedUserIds(ownerId)).map(value => String(value).toLowerCase()).sort();
    const [current] = await run(page !== filters.page ? { ...filters, page, targetId: '' } : filters);
    if (fingerprint(currentBlocked) !== fingerprint(blocked) || fingerprint(current) !== revision) throw Object.assign(new Error('Matter list changed.'), { status: 409 });
  };
  return { verify, ownerId, filters, counts, practices: result.practices.map(entry => entry._id), total, page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), target: filters.targetId ? { id: filters.targetId, found: Boolean(targetPosition), page: targetPosition ? page : null } : null, rows: result.rows };
}

module.exports = { PAGE_SIZE, parseInventoryQuery, inventoryPipeline, readInventory };
