import { array, count, validId, dates } from './read-model.mjs';

const invalid = () => { throw new TypeError('Home inventory could not be verified.'); };
const actions = ['files', 'moderation', 'payment', 'withdrawal'];
export function readHomeInventory(value, ownerId, attentionPage = 1, deadlinePage = 1) {
  if (!validId(ownerId) || value?.ownerId !== ownerId || !/^[a-f0-9]{64}$/.test(value.revision || '')) invalid();
  const counts = Object.fromEntries(['active', 'applications', 'draft', 'archived'].map(key => [key, count(value.counts?.[key])]));
  const all = Object.values(counts).reduce((sum, total) => sum + total, 0), postedCount = count(value.postedCount);
  if (!Number.isSafeInteger(all) || postedCount > all) invalid();
  const records = (input, limit, offset = 0, kind = '') => {
    const total = count(input?.total), items = array(input?.items), seen = new Set();
    if (total > postedCount || items.length !== Math.min(limit, Math.max(0, total - offset))) invalid();
    for (const item of items) {
      if (!validId(item?.id) || seen.has(item.id) || ['title', 'label', 'practiceArea'].some(key => typeof item[key] !== 'string') || !item.label) invalid();
      seen.add(item.id);
      if (kind === 'attention' && (!array(item.actions).length || new Set(item.actions).size !== item.actions.length || item.actions.some(action => !actions.includes(action)))) invalid();
      if (kind === 'week' && !dates.normalize(item.dueDate)) invalid();
    }
    return { ...input, total, items };
  };
  const attention = records(value.attention, 5, (attentionPage - 1) * 5, 'attention');
  if (attention.page !== attentionPage || attention.pageSize !== 5 || attention.pages !== Math.max(1, Math.ceil(attention.total / 5))) invalid();
  const week = records(value.week, 3, (deadlinePage - 1) * 3, 'week');
  if (week.page !== deadlinePage || week.pageSize !== 3 || week.pages !== Math.max(1, Math.ceil(week.total / 3))) invalid();
  if (!dates.normalize(week.start) || !dates.normalize(week.end) || week.end !== dates.addDays(week.start, 6) || week.items.some(item => item.dueDate < week.start || item.dueDate > week.end)) invalid();
  return { counts, postedCount, attention, recent: records(value.recent, 5), completed: records(value.completed, 3), week };
}

export function readHomeApplications(value) {
  const seen = new Set();
  for (const item of array(value)) {
    if (typeof item?.id !== 'string' || !item.id || seen.has(item.id) || item.caseId && !validId(item.caseId) || typeof item.jobTitle !== 'string') invalid();
    seen.add(item.id);
  }
  return value;
}
