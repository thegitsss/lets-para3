const path = require('node:path');
const { pathToFileURL } = require('node:url');
const model = import(pathToFileURL(path.resolve(__dirname, '../../../../frontend/assets/scripts/attorney-v2/read-model.mjs')).href);

async function inventoryFixture(data, ownerId, query) {
  const { mergeRecords, bucket, filterRecords, filtersFromQuery } = await model;
  const filters = filtersFromQuery(new URLSearchParams({
    view: query.get('view') || 'active', q: query.get('q') || '', matterPractice: query.get('practice') || '',
    matterDeadline: query.get('deadline') || '', matterUpdated: query.get('updated') || '',
    matterSort: query.get('sort') || 'recent', archiveStatus: query.get('archiveStatus') || 'all', page: query.get('page') || '1',
  }));
  filters.search = filters.search.trim();
  filters.targetId = query.get('targetId') || '';
  const all = mergeRecords(data.active, data.archived, data.drafts.items);
  const matches = filterRecords(all, filters);
  const targetIndex = filters.targetId ? matches.findIndex(item => !item.localDraft && String(item.id || item._id) === filters.targetId) : -1;
  const page = targetIndex >= 0 ? Math.floor(targetIndex / 15) + 1 : filters.page;
  const counts = Object.fromEntries(['active', 'draft', 'archived', 'applications'].map(view => [view, all.filter(item => bucket(item) === view).length]));
  return {
    ownerId, revision: 'a'.repeat(64), filters, counts,
    practices: [...new Set(all.map(item => item.practiceArea).filter(Boolean))].sort(),
    total: matches.length, page, pageSize: 15, pages: Math.max(1, Math.ceil(matches.length / 15)),
    target: filters.targetId ? { id: filters.targetId, found: targetIndex >= 0, page: targetIndex >= 0 ? page : null } : null,
    items: matches.slice((page - 1) * 15, page * 15).map(item => ({ ...item, recordType: item.localDraft ? 'draft' : 'matter', archiveBucket: item.__av2ArchiveBucket === true })),
  };
}
module.exports = { inventoryFixture };
