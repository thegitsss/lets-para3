import { dateOnly, newYorkDateOnly } from './paralegal-v2/home-model.mjs';

const id = value => String(value?._id || value?.id || value || '');
const validId = value => /^[a-f0-9]{24}$/i.test(value);
const closed = new Set(['completed', 'closed', 'cancelled', 'canceled', 'expired', 'archived']);
export const calendarRange = (today = newYorkDateOnly()) => {
  if (dateOnly(today) !== today) throw new Error('Calendar date could not be verified.');
  const end = new Date(`${today}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 7);
  return { start: today, end: end.toISOString().slice(0, 10) };
};

export function calendarRows({ matters = [], reminders = [], ownerId, range = calendarRange() }) {
  const allowed = new Map(), rows = new Map();
  const add = row => { if (row.start >= range.start && row.start < range.end && !rows.has(row.key)) rows.set(row.key, row); };
  for (const matter of matters) {
    const caseId = id(matter.caseId || matter._id || matter.id), owner = id(matter.paralegalId || matter.paralegal);
    if (!validId(caseId) || owner !== ownerId || matter.paralegalAccessRevokedAt || matter.archived === true || matter.paymentReleased === true || closed.has(String(matter.status || '').trim().toLowerCase())) continue;
    // Only a verified funded assignment supplies a link into its workspace.
    const linked = matter.archived === false && matter.paymentReleased === false && String(matter.escrowStatus || '').toLowerCase() === 'funded' && Boolean(matter.escrowIntentId);
    allowed.set(caseId, linked);
    const start = dateOnly(matter.deadlineDate || matter.deadline);
    if (start) add({ key: `matter:${caseId}`, title: matter.jobTitle || matter.title || 'Matter deadline', start, caseId: linked ? caseId : '', source: 'matter' });
  }
  for (const event of reminders) {
    const eventId = id(event.id || event._id), caseId = id(event.caseId || event.case);
    if (!validId(eventId) || id(event.owner) !== ownerId || event.type !== 'deadline' || event.completed === true || event.cancelled === true || closed.has(String(event.status || '').trim().toLowerCase()) || caseId && !allowed.has(caseId)) continue;
    const start = event.isAllDay === false ? newYorkDateOnly(event.start) : dateOnly(event.start);
    if (start) add({ key: `event:${eventId}`, title: event.title || 'Private reminder', start, caseId: allowed.get(caseId) ? caseId : '', source: 'event' });
  }
  return [...rows.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}
export function renderCalendar(root, { rows, unavailable = [], loading = false, page = 1, onPage, onRetry }) {
  if (!root) return;
  root.dataset.state = loading ? 'loading' : unavailable.length ? 'unavailable' : 'ready';
  root.setAttribute('aria-busy', String(loading)); root.tabIndex = -1; root.replaceChildren();
  if (loading) { root.append(element('p', 'private-office-secondary-state', 'Checking your calendar…')); return; }
  if (unavailable.length) {
    const notice = element('div', 'office-calendar-notice');
    notice.append(element('p', '', `${unavailable.join(' and ')} couldn’t load.`));
    const retry = element('button', 'office-calendar-control', 'Retry calendar'); retry.type = 'button'; retry.addEventListener('click', onRetry); notice.append(retry); root.append(notice);
  }
  if (!rows.length) { if (!unavailable.length) root.append(element('p', 'private-office-secondary-state', 'No deadlines or reminders this week.')); return; }
  const pageSize = 5, pages = Math.ceil(rows.length / pageSize), current = Math.max(1, Math.min(pages, page)), start = (current - 1) * pageSize;
  const list = element('ol', 'office-calendar-agenda'); list.start = start + 1;
  for (const row of rows.slice(start, start + pageSize)) {
    const item = element('li', 'office-calendar-entry'); item.dataset.calendarKey = row.key;
    const when = element('time', '', new Date(`${row.start}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })); when.dateTime = row.start;
    const content = element('div'); const title = element(row.caseId ? 'a' : 'strong', '', row.title);
    if (row.caseId) title.href = `case-detail.html?caseId=${encodeURIComponent(row.caseId)}&tab=work`;
    content.append(title, element('span', '', row.source === 'matter' ? 'Matter deadline' : 'Private reminder')); item.append(when, content); list.append(item);
  }
  root.append(list);
  if (pages > 1) {
    const nav = element('nav', 'office-calendar-pagination'); nav.setAttribute('aria-label', 'Calendar pages');
    const previous = element('button', 'office-calendar-control', 'Previous'), next = element('button', 'office-calendar-control', 'Next');
    for (const [button, delta, label] of [[previous, -1, 'Previous calendar page'], [next, 1, 'Next calendar page']]) {
      button.type = 'button'; button.setAttribute('aria-label', label); button.disabled = delta < 0 ? current === 1 : current === pages;
      button.addEventListener('click', () => { onPage(current + delta); root.focus({ preventScroll: true }); });
    }
    nav.append(previous, element('span', '', `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length}`), next); root.append(nav);
  }
}
