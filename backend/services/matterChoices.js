const mongoose = require('mongoose');
const Case = require('../models/Case');
const { fingerprint } = require('./matterDraftRevision');

const LIMIT = 10;
const currentMatterScope = () => ({
  archived: { $ne: true }, paymentReleased: { $ne: true },
  $expr: { $not: { $in: [{ $toLower: { $trim: { input: { $ifNull: ['$status', ''] } } } }, ['draft', 'completed', 'closed', 'cancelled', 'canceled', 'expired', 'archived']] } },
});
const invalid = () => { throw Object.assign(new Error('Invalid Matter search.'), { status: 400 }); };
function parseChoiceQuery(query = {}) {
  if (Object.keys(query).some(key => !['expectedOwnerId', 'q', 'page', 'selectedId'].includes(key) || typeof query[key] !== 'string')) invalid();
  if (query.page && !/^[1-9]\d{0,5}$/.test(query.page) || (query.q || '').length > 200 || /[\u0000-\u001f\u007f]/.test(query.q || '') || query.selectedId && !/^[a-f0-9]{24}$/i.test(query.selectedId)) invalid();
  return { search: (query.q || '').trim(), page: Number(query.page || 1), selectedId: (query.selectedId || '').toLowerCase() };
}

// The caller supplies its role-specific participant scope. Only bounded
// navigation metadata is read; CaseDraft records are never Case links.
async function readCaseChoices(ownerId, filters, scope) {
  const match = filters.search ? { title: { $regex: filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};
  const projection = { _id: 0, id: { $toString: '$_id' }, title: { $ifNull: ['$title', ''] }, status: { $ifNull: ['$status', ''] }, archived: { $eq: ['$archived', true] }, practiceArea: { $ifNull: ['$practiceArea', ''] } };
  const pipeline = [
    { $match: scope },
    { $project: { title: 1, status: 1, archived: 1, practiceArea: 1 } },
    { $facet: {
      total: [{ $match: match }, { $count: 'value' }],
      items: [{ $match: match }, { $sort: { title: 1, _id: 1 } }, { $skip: (filters.page - 1) * LIMIT }, { $limit: LIMIT }, { $project: projection }],
      selected: [{ $match: { _id: filters.selectedId ? new mongoose.Types.ObjectId(filters.selectedId) : null } }, { $project: projection }],
    } },
  ];
  const run = () => Case.aggregate(pipeline).collation({ locale: 'en', strength: 2 }).option({ maxTimeMS: 15000, allowDiskUse: true });
  const [result] = await run(), revision = fingerprint(result), [current] = await run();
  if (fingerprint(current) !== revision) throw Object.assign(new Error('Your Matters changed. Search again to see current choices.'), { status: 409, publicCode: 'MATTER_CHOICES_CHANGED' });
  const total = result.total[0]?.value || 0;
  return { ownerId, revision, filters, total, page: filters.page, pageSize: LIMIT, pages: Math.max(1, Math.ceil(total / LIMIT)), items: result.items, selected: result.selected[0] || null };
}

module.exports = { parseChoiceQuery, readCaseChoices, currentMatterScope };
