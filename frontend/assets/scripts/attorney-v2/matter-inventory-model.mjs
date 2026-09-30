import { array, count, id, validId, bucket } from './read-model.mjs';

const invalid = () => { throw new TypeError('Matter inventory could not be verified.'); };
export function readMatterInventory(value, ownerId, filters) {
  if (!value || value.ownerId !== ownerId || !validId(ownerId) || !/^[a-f0-9]{64}$/.test(value.revision || '')) invalid();
  const expected = { ...filters, search: filters.search.trim(), archiveStatus: filters.archiveStatus || 'all', targetId: filters.targetId || '' };
  for (const key of ['view', 'search', 'practice', 'deadline', 'updated', 'sort', 'archiveStatus', 'page', 'targetId']) if (value.filters?.[key] !== expected[key]) invalid();
  const total = count(value.total), page = count(value.page), pages = count(value.pages);
  if (value.pageSize !== 15 || !page || pages !== Math.max(1, Math.ceil(total / 15))) invalid();
  if (expected.targetId) {
    if (value.target?.id !== expected.targetId || typeof value.target.found !== 'boolean' || value.target.page !== (value.target.found ? page : null)) invalid();
  } else if (value.target !== null) invalid();
  if (!value.target?.found && page !== filters.page) invalid();
  const counts = {};
  for (const view of ['active', 'draft', 'archived', 'applications']) counts[view] = count(value.counts?.[view]);
  if (total > counts[filters.view]) invalid();
  const practices = array(value.practices);
  if (practices.some(item => typeof item !== 'string' || !item || item.length > 200) || new Set(practices).size !== practices.length) invalid();
  const seen = new Set();
  const items = array(value.items).map(item => {
    if (!item || !validId(id(item)) || !['draft', 'matter'].includes(item.recordType) || typeof item.archiveBucket !== 'boolean' || item.recordType === 'draft' && item.archiveBucket) invalid();
    if (item.recordType === 'draft' && item.publishedCaseId != null) invalid();
    const key = `${item.recordType}:${id(item)}`;
    if (seen.has(key)) invalid(); seen.add(key);
    const record = { ...item, localDraft: item.recordType === 'draft', __av2ArchiveBucket: item.archiveBucket };
    if (bucket(record) !== filters.view) invalid();
    return record;
  });
  if (items.length !== Math.max(0, Math.min(15, total - (page - 1) * 15))) invalid();
  if (value.target?.found && !items.some(item => !item.localDraft && id(item) === expected.targetId)) invalid();
  return { total, page, pages, counts, practices, items, revision: value.revision };
}
