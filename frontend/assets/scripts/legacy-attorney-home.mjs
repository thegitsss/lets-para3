import { node, link, button } from './attorney-v2/dom.mjs';
import { readHomeInventory, readHomeApplications } from './attorney-v2/home-inventory-model.mjs';
import { count, dates, SOURCES, reconcileUnread } from './attorney-v2/read-model.mjs';
import { readDefaultCard } from './attorney-v2/payment-setup-model.mjs';

const keys = ['inventory', 'applications', 'messages', 'overdue', 'payment'];
const note = text => node('p', { className: 'overview-module-summary', text });
const preview = (item, archived = false) => `dashboard-attorney.html?previewCaseId=${item.id}#cases${archived ? ':archived' : ''}`;
const workspace = (item, tab) => `case-detail.html?caseId=${item.id}&tab=${tab}`;
const recentHref = item => item.label === 'In Progress' ? workspace(item, 'overview') : preview(item);

// The original shell and V2 consume the same complete, read-only projection.
// Each independent source stays unavailable until both the owner and response
// have been checked. Capped Matter caches never establish Home totals or actions.
export function createLegacyAttorneyHome({ api, ownerId, onReviewMatter, onChange = () => {} }) {
  const state = Object.fromEntries(keys.map(key => [key, { phase: 'loading', value: null }]));
  const pending = new Map();
  const query = new URLSearchParams(location.search);
  const pages = Object.fromEntries(['attentionPage', 'deadlinePage'].map(key => [key, Math.min(999999, Math.max(1, Number.parseInt(query.get(key), 10) || 1))]));
  let suspended = false, lost = false;
  const ready = key => state[key].phase === 'ready' ? state[key].value : null;
  function fill(id, source, contents) {
    const target = document.getElementById(id);
    if (!target) return;
    target.dataset.state = state[source].phase;
    target.setAttribute('aria-busy', String(state[source].phase === 'loading'));
    target.closest('.status-item, .mini-deadlines')?.setAttribute('aria-busy', String(state[source].phase === 'loading'));
    target.replaceChildren(...contents);
  }
  function problem(key, label) {
    if (state[key].phase === 'loading') return [note(`Loading ${label}…`)];
    return [note(lost ? 'Your account changed. Reload to continue.' : `${label} could not be verified.`),
      ...(lost ? [] : [button(`Retry ${label.toLowerCase()}`, async event => {
        const target = event.currentTarget.parentElement;
        await refresh([key]);
        if (!suspended && !lost && target?.isConnected && document.activeElement === document.body) { target.tabIndex = -1; target.focus(); }
      }, 'legacy-home-control')])];
  }
  async function go(key, value, focusId) {
    const focusedBefore = document.activeElement;
    pages[key] = value;
    const url = new URL(location.href);
    if (value === 1) url.searchParams.delete(key); else url.searchParams.set(key, String(value));
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    await refresh(['inventory']);
    if (!suspended && !lost && (document.activeElement === document.body || document.activeElement === focusedBefore)) {
      const target = document.getElementById(focusId);
      if (target) { target.tabIndex = -1; target.focus(); }
    }
  }
  function paging(data, key, label, focusId) {
    if (data.pages === 1 && data.page === 1) return [];
    const controls = node('nav', { className: 'legacy-home-pages', 'aria-label': `${label} pages` });
    controls.append(note(`Page ${data.page} of ${data.pages}`));
    const add = (text, page) => controls.append(button(text, () => void go(key, page, focusId), 'legacy-home-control'));
    if (data.page > 1) add(`Previous ${label.toLowerCase()} page`, data.page - 1);
    if (data.page < data.pages) add(`Next ${label.toLowerCase()} page`, data.page + 1);
    if (data.page > data.pages) add(`First ${label.toLowerCase()} page`, 1);
    return [controls];
  }
  function renderInventory() {
    const data = ready('inventory');
    if (!data) {
      for (const [id, label] of [['overviewMattersBody', 'Matters'], ['overviewCompletedBody', 'Completed Matters'], ['deadlineList', 'Deadlines'], ['caseCards', 'Recent Matters'], ['completedJobsList', 'Completed records']]) fill(id, 'inventory', problem('inventory', label));
      return;
    }
    fill('overviewMattersBody', 'inventory', [note(data.recent.total ? `${data.recent.total} current` : 'No current Matters.')]);
    fill('overviewCompletedBody', 'inventory', [note(data.completed.total ? String(data.completed.total) : 'None yet.')]);
    fill('caseCards', 'inventory', data.recent.items.length ? [
      ...(data.recent.total > data.recent.items.length ? [note(`Showing ${data.recent.items.length} of ${data.recent.total}`)] : []),
      ...data.recent.items.map(item => node('div', { className: 'matter-row', 'data-home-matter': item.id }, [node('div', { className: 'matter-main' }, [
        link(item.title || 'Untitled Matter', recentHref(item), 'matter-title matter-title-link'),
        node('div', { className: 'matter-meta', text: [item.label, item.practiceArea].filter(Boolean).join(' · ') }),
      ])])),
    ] : [note('No current Matters yet.')]);
    const week = data.week;
    fill('deadlineList', 'inventory', [
      note(`${dates.format(week.start, { year: undefined })} – ${dates.format(week.end, { year: undefined })}`),
      ...(week.total ? [node('ul', { className: 'overview-deadline-list' }, week.items.map(item => node('li', { className: 'overview-deadline-row' }, [
        link(item.title || 'Untitled Matter', recentHref(item)), node('time', { dateTime: item.dueDate, text: dates.format(item.dueDate, { year: undefined }) }),
      ]))), ...(!week.items.length ? [note('No deadlines on this page.')] : [])] : [note('No Matter deadlines this week.')]),
      ...paging(week, 'deadlinePage', 'Deadline', 'deadlineList'),
    ]);
    fill('completedJobsList', 'inventory', data.completed.items.length ? [
      ...data.completed.items.map(item => node('div', { className: 'completed-job-card' }, [link(item.title || 'Untitled Matter', preview(item, true))])),
      link(`View all completed records (${data.completed.total})`, 'dashboard-attorney.html?archiveStatus=completed#cases:archived'),
    ] : [note('None yet.')]);
  }
  function render(changed) {
    if (!changed || changed === "inventory") renderInventory();
    const applications = ready('applications');
    if (!changed || changed === 'applications') fill('overviewApplicationsBody', 'applications', applications ? [note(applications.length ? `${applications.length} awaiting review` : 'No applications to review.')] : problem('applications', 'Applications'));
    const messages = ready('messages');
    if (!changed || changed === 'messages') fill('overviewMessagesBody', 'messages', messages ? [note(messages.mismatch ? 'Unread counts are updating. Refresh to verify.' : messages.total ? String(messages.total) : 'No unread messages.')] : problem('messages', 'Messages'));
    onChange(state, changed);
  }
  function attentionNodes() {
    const data = ready('inventory');
    if (!data) return [node('div', { className: 'queue-item legacy-home-unavailable' }, problem('inventory', 'Matter attention'))];
    const labels = { files: 'Review submitted files', moderation: 'Review flagged listing', payment: 'Review payment status', withdrawal: 'Review withdrawal and response deadline' };
    return [
      ...data.attention.items.map(item => node('div', { className: 'queue-item legacy-home-matter-attention', 'data-home-attention': item.id }, [
        node('div', { className: 'queue-title', text: item.title || 'Untitled Matter' }),
        node('div', { className: 'legacy-home-actions' }, item.actions.map(action => action === 'moderation'
          ? button(labels[action], event => { event.currentTarget.focus(); void onReviewMatter(item.id); }, 'queue-action')
          : link(labels[action], workspace(item, action === 'files' ? 'files' : 'financials'), 'queue-action'))),
      ])),
      ...(data.attention.total && !data.attention.items.length ? [note('No Matters on this page.')] : []),
      ...paging(data.attention, 'attentionPage', 'Attention', 'attorneyNeedsAttentionTitle'),
    ];
  }
  async function load(key) {
    pending.get(key)?.abort();
    const controller = new AbortController(); pending.set(key, controller);
    state[key] = { phase: 'loading', value: null }; render(key);
    const options = { ownerId, signal: controller.signal }, currentPages = { ...pages };
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      await api.verifyOwner(options);
      let value;
      if (key === 'inventory') {
        const params = new URLSearchParams({ expectedOwnerId: ownerId, attentionPage: String(currentPages.attentionPage), deadlinePage: String(currentPages.deadlinePage) });
        value = readHomeInventory(await api.get(`/api/cases/inventory/home?${params}`, options), ownerId, currentPages.attentionPage, currentPages.deadlinePage);
      } else if (key === 'applications') value = readHomeApplications(await api.readReceivedApplications(options));
      else if (key === 'payment') {
        const card = readDefaultCard(await api.readDefaultCard(options));
        value = { hasPaymentMethod: Boolean(card.card), bypass: card.bypass };
      } else if (key === 'overdue') value = count((await api.get(SOURCES.overdue, options)).total);
      else value = reconcileUnread(...await Promise.all(['unread', 'messageSummary', 'threads'].map(name => api.get(SOURCES[name], options))));
      await api.verifyOwner(options);
      if (pending.get(key) !== controller || suspended || lost) return;
      if (controller.signal.aborted) throw new Error('Read timed out');
      state[key] = { phase: 'ready', value };
    } catch (error) {
      if (pending.get(key) !== controller || suspended || lost) return;
      state[key] = { phase: 'failed', value: null };
    } finally {
      clearTimeout(timer);
      if (pending.get(key) === controller) { pending.delete(key); if (!suspended) render(key); }
    }
  }
  async function refresh(selected = keys) {
    if (suspended || lost) return;
    await Promise.all(selected.map(load));
  }
  function stop() {
    suspended = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  }
  function clear() {
    lost = true; stop();
    for (const key of keys) state[key] = { phase: 'failed', value: null };
    render();
  }
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', event => { if (event.persisted && !lost) { suspended = false; void refresh(); } });
  return { state, refresh, attentionNodes, clear };
}
