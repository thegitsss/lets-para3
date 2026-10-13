import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api, escapeHTML as esc, routeParam, visible } from './shared.js';
import { icon } from './presentation.js';
import { initAdminToday } from './today.js';
import { getStoredSession } from '../auth.js';

const el = id => document.getElementById(id);
const placements = [];
let current = null, completed = 0, sequence = 0, busy = false, active = false;
let followUps = [];
let queuePage = 1, savedSelection = '';
let queueData = null;
let storageKey = '', mounted = '', pendingCompletion = null;
let refreshActivity = () => {};
let reading = false, working = false, navigating = false, pendingSection = '';

function saveSession() {
  if (!storageKey) {
    const user = getStoredSession().user;
    const id = user?.id || user?._id;
    if (id) storageKey = `lpc-admin-flow:${id}`;
  }
  if (!storageKey) return;
  try { sessionStorage.setItem(storageKey, JSON.stringify({ completed, queuePage, selected: current?.key || savedSelection })); } catch { /* Progress is still visible in the current tab. */ }
}
function loadSession() {
  const user = getStoredSession().user;
  const id = user?.id || user?._id;
  storageKey = id ? `lpc-admin-flow:${id}` : '';
  try {
    const saved = JSON.parse(storageKey && sessionStorage.getItem(storageKey) || '{}');
    queuePage = Number.isSafeInteger(saved.queuePage) && saved.queuePage > 0 ? saved.queuePage : 1;
    savedSelection = typeof saved.selected === 'string' ? saved.selected : '';
    completed = Number.isSafeInteger(saved.completed) && saved.completed >= 0 ? saved.completed : 0;
  } catch { completed = 0; }
}
function status(message) { el('adminFlowStatus').textContent = message; }
function updateBusy() {
  busy = reading || working || navigating;
  // Moved account actions must remain unavailable until their record opens.
  // Keep editors usable during a save, so newer draft text is preserved.
  for (const id of ['adminFlowBody', 'adminFlowActions', 'adminFlowOptions']) el(id).inert = reading || navigating;
  el('adminFlowLater').disabled = busy;
  for (const id of ['adminFlowSaveFollowUp', 'adminFlowCancelFollowUp', 'adminFlowFollowUpAt']) el(id).disabled = busy;
  el('adminFlowQueue').querySelectorAll('button').forEach(button => { button.disabled = busy || (button.hasAttribute('data-flow-page') && (Number(button.dataset.flowPage) < 1 || Number(button.dataset.flowPage) > (queueData?.pages || 1))); });
  el('adminFlowSaved').querySelectorAll('button').forEach(button => { button.disabled = busy; });
  el('adminFlowCheck').disabled = busy;
  el('adminFlowRefresh').disabled = busy;
  if (el('adminFlowResume')) el('adminFlowResume').disabled = busy;
  el('adminFlow').setAttribute('aria-busy', String(busy));
  if (busy) return;
  compact();
  if (active && pendingCompletion) {
    const detail = pendingCompletion; pendingCompletion = null; completedWork(detail);
  } else if (active && pendingSection) {
    const section = pendingSection; pendingSection = ''; void navigate(section);
  }
}
function mount(node, target = el('adminFlowBody')) {
  if (!node) throw new Error('This task could not be opened. Try again.');
  const marker = document.createComment('Admin flow return position');
  node.before(marker);
  placements.push({ node, marker, hidden: node.hidden });
  node.hidden = false;
  target.append(node);
}
function restore({ clearRoute = true } = {}) {
  el('adminFlowOptions').hidden = true;
  el('adminFlowOptions').open = false;
  if (mounted === 'payment') el('reconcileCaseId').readOnly = false;
  if (mounted === 'inquiry') el('adminReplyTitle')?.removeAttribute('aria-level');
  mounted = '';
  if (el('pendingUserModal').classList.contains('admin-flow-inline')) {
    el('closePendingModal').click();
    el('pendingUserModal').classList.remove('admin-flow-inline');
    el('pendingUserModal').setAttribute('role', 'dialog');
    el('pendingUserModal').setAttribute('aria-modal', 'true');
  }
  for (const { node, marker, hidden } of placements.splice(0).reverse()) {
    marker.replaceWith(node);
    node.hidden = hidden;
  }
  window.adminFlowChargebackId = '';
  window.adminFlowDisputeCaseId = '';
  if (clearRoute) for (const key of ['account', 'ticket', 'matter', 'dispute']) routeParam(key, '');
}
async function flushDraft() {
  if (mounted === 'application') await window.flushAdminAccountDraft?.();
  if (mounted === 'inquiry') await window.flushAdminInquiryDraft?.();
}
async function readQueue(key = '', selected = '') {
  return api(`/api/admin/workspace/flow?${new URLSearchParams({ current: key, selected, page: String(queuePage) })}`);
}
function progress(data) {
  queueData = data; queuePage = data.page || 1;
  const selected = data.task?.key || '';
  el('adminFlowQueue').innerHTML = (data.items || (data.task ? [data.task] : [])).map(task => `<button type="button" class="admin-queue-item" data-flow-select="${esc(task.key)}" aria-pressed="${task.key === selected}"><span class="admin-queue-icon">${icon({application:'users',inquiry:'inbox',payment:'finance',matter:'matters'}[task.kind] || 'document')}</span><span><strong>${esc(task.title)}</strong><small>${esc(task.name)}${task.followUpDue ? ' · Follow-up due' : ''}</small></span>${task.priority === 'urgent' ? '<span class="admin-queue-urgent">Urgent</span>' : ''}</button>`).join('') || '<p class="admin-queue-empty">No items in this queue.</p>';
  if (data.pages > 1) el('adminFlowQueue').insertAdjacentHTML('beforeend', `<div class="admin-queue-pager"><button class="btn secondary" type="button" data-flow-page="${queuePage - 1}" ${queuePage <= 1 ? 'disabled' : ''}>Previous</button><span>${queuePage} / ${data.pages}</span><button class="btn secondary" type="button" data-flow-page="${queuePage + 1}" ${queuePage >= data.pages ? 'disabled' : ''}>Next</button></div>`);
  el('adminTodayNeedsCount').textContent = data.remaining;
  el('adminFlowQueueCount').textContent = `${data.remaining} to review`;
  el('adminFlowProgress').textContent = [completed ? `${completed} reviewed this visit` : '', `${data.remaining} to review`, data.deferred ? `${data.deferred} set for later` : ''].filter(Boolean).join(' · ');
  el('adminFlowScope').textContent = `Checked: ${data.scope}.`;
  followUps = data.followUps || [];
  const saved = el('adminFlowSaved');
  saved.hidden = !followUps.length;
  saved.innerHTML = followUps.length ? `<summary>Set for later · ${followUps.length}</summary><p>Saved reminders · No messages sent</p>${followUps.map((item, index) => `<div class="admin-follow-up-row"><div><strong>${esc(item.name)}</strong><span>${esc(new Date(item.followUpAt).toLocaleString())}</span></div><button class="btn secondary" type="button" data-resume-follow-up="${index}" aria-label="Bring back ${esc(item.name)}">Bring back</button></div>`).join('')}` : '';
}
function compact() {
  const body = el('adminFlowBody');
  if (mounted === 'application' && body.contains(el('pendingUserModal')) && el('pendingUserModal').dataset.adminAccountId === current?.id) {
    const context = [el('pendingModalTitle').textContent, el('pendingModalSubhead').textContent].filter(Boolean).join(' · ');
    if (el('adminFlowContext').textContent !== context) el('adminFlowContext').textContent = context;
  }
  body.querySelectorAll('[data-account-tab]').forEach(button => {
    const text = { review: 'Review', profile: 'Profile', history: 'History' }[button.dataset.accountTab];
    if (button.textContent !== text) button.textContent = text;
  });
  const more = el('adminInformationRequest')?.closest('details');
  if (body.contains(more) && !more.dataset.flowReady) {
    more.dataset.flowReady = 'true';
    more.open = Boolean(el('adminInformationText').value || el('adminInformationText').readOnly);
  }
  const note = el('adminDecisionNote')?.closest('.admin-review-card');
  if (body.contains(note) && !note.closest('details')) {
    const fold = document.createElement('details');
    fold.className = 'admin-detail-fold';
    fold.innerHTML = '<summary>Internal note</summary>';
    note.before(fold); fold.append(note);
    fold.open = Boolean(el('adminDecisionNote').value);
  }
  if (mounted === 'inquiry' && el('adminReplySend') && !el('adminReplyText').readOnly) {
    el('adminReplyTitle')?.setAttribute('aria-level', '2');
    const text = (el('adminReplyForm').querySelector('h3').textContent.includes('email') ? 'Send email' : 'Send') + (el('adminReplyStatus').value === 'in_review' ? '' : ' & next');
    if (el('adminReplySend').textContent !== text && !busy) el('adminReplySend').textContent = text;
  }
  if (mounted === 'application' && el('approveUserBtn').textContent === 'Approve' && !busy) el('approveUserBtn').textContent = 'Approve & next';
  if (mounted === 'chargeback') {
    const labels = [...el('chargebackPanel').querySelectorAll('thead th')].map(node => node.textContent);
    el('chargebacksBody').querySelectorAll('tr').forEach(row => {
      if (row.children.length !== labels.length) return;
      [...row.children].forEach((cell, index) => { if (cell.dataset.label !== labels[index]) cell.dataset.label = labels[index]; });
      for (const index of [6, 7]) {
        const cell = row.children[index];
        const text = cell.textContent.replace(/_/g, ' ');
        if (cell.textContent !== text) cell.textContent = text;
      }
    });
  }
}
async function openTask(task, request) {
  restore();
  el('adminFlowQueueLayout').classList.remove('is-empty');
  const body = el('adminFlowBody');
  body.replaceChildren();
  el('adminFlowTitle').textContent = task.title;
  el('adminFlowContext').textContent = [task.name, task.detail].filter(Boolean).join(' · ');
  el('adminFlowActions').hidden = false;
  el('adminFlowCheck').hidden = ['application', 'inquiry'].includes(task.kind);
  current = task; savedSelection = task.key; saveSession();
  el('adminFlowFollowUpForm').hidden = true;
  el('adminFlowReason').textContent = task.kind === 'application' && !task.followUpDue ? '' : task.reason || '';
  try {
    if (['approval', 'incident', 'photo'].includes(task.kind) || task.view === 'posting') {
      body.innerHTML = `<button class="btn primary" type="button" id="adminFlowOpenReview">Open review</button>`;
      replaceEventHandler(el('adminFlowOpenReview'), 'click', async () => {
        const section = task.view === 'posting' ? 'posts' : task.section;
        const destination = await navigate(section);
        if (destination !== section) return;
        if (task.kind === 'approval') await window.openApprovalWorkspaceItem(task.workKey);
        if (task.kind === 'incident') await window.openEngineeringItemInAdmin(task.incidentId);
        if (task.kind === 'photo') window.showAdminUsers('photos', { navigate: false });
      });
    } else if (task.kind === 'application') {
      mounted = 'application'; mount(el('pendingUserModal'));
      mount(el('pendingUserModal').querySelector('.pending-modal-actions'), el('adminFlowActions'));
      mount(el('editEmailBtn'), el('adminFlowOptionsContent'));
      el('adminFlowActions').append(el('adminFlowLater'));
      el('adminFlowOptions').hidden = false;
      await window.reviewAdminApplicant(task.id, { inline: true });
    } else if (task.kind === 'inquiry') {
      mounted = 'inquiry'; mount(el('adminInboxDetail'));
      await window.selectSupportTicketInAdmin(task.id);
    } else if (task.kind === 'payment' && task.view === 'chargeback') {
      mounted = 'chargeback';
      window.adminFlowChargebackId = task.id;
      window.adminChargebackPage = 1;
      mount(el('chargebackPanel'));
      await window.loadChargebacks();
    } else if (task.kind === 'matter' && task.view === 'dispute') {
      mounted = 'dispute';
      window.adminFlowDisputeCaseId = task.id;
      window.adminDisputePage = 1;
      mount(el('disputesBody').closest('.panel'));
      await window.loadDisputes();
    } else if (task.kind === 'payment' && task.caseId) {
      mounted = 'payment';
      mount(el('reconcileCaseId').closest('.escrow-chart-row'));
      el('reconcileCaseId').value = task.caseId;
      el('reconcileCaseId').readOnly = true;
      el('reconcileStatus').textContent = '';
    } else if (task.caseId) {
      mounted = 'matter'; mount(el('adminMatterDetail'));
      await window.openAdminMatter(task.caseId, { navigate: false });
    } else {
      body.innerHTML = `<p role="status">This payment has no linked matter.</p><p class="small">${esc(task.id)}</p><button class="btn secondary" type="button" id="adminFlowFindPayment">Find payment</button>`;
      replaceEventHandler(el('adminFlowFindPayment'), 'click', () => { pause(); window.openAdminFinancialRecords('operations'); el('adminFinanceSearch').value = task.id; el('adminFinanceSearch').dispatchEvent(new Event('input')); });
    }
    if (request !== sequence || !active) return;
    // Today restores its selected record from the private per-owner session.
    // Record deep links belong to standalone reviews, not the embedded queue.
    for (const key of ['account', 'ticket', 'matter', 'dispute']) routeParam(key, '');
    compact();
    el('main').scrollTo({ top: 0, behavior: 'instant' });
    el('adminFlowTitle').focus({ preventScroll: true });
  } catch (error) {
    if (request !== sequence || !active) return;
    status(error.message);
    // Keep any loaded record and its draft; Refresh is an explicit retry.
  }
}
function renderEmpty(data) {
  restore(); current = null; savedSelection = ''; saveSession();
  el('adminFlowQueueLayout').classList.add('is-empty');
  el('adminFlowActions').hidden = true;
  el('adminFlowTitle').textContent = 'You’re up to date here.';
  el('adminFlowContext').textContent = data.deferred ? `${data.deferred} ${data.deferred === 1 ? 'item is' : 'items are'} set for later.` : data.waiting ? `Waiting for ${data.waiting} ${data.waiting === 1 ? 'applicant to reply' : 'applicants to reply'}.` : 'No items need review in your checked queues right now.';
  el('adminFlowReason').textContent = '';
  el('adminFlowFollowUpForm').hidden = true;
  el('adminFlowBody').replaceChildren();
  el('main').scrollTo({ top: 0, behavior: 'instant' });
}
async function refresh({ completion = '', check = false, followUpAt, bringBack, selected = '', page } = {}) {
  if (busy || !active) return;
  const request = ++sequence;
  const key = current?.key || '';
  reading = true; updateBusy();
  status('');
  try {
    await flushDraft();
    if (page) queuePage = page;
    if (completion || check || followUpAt || bringBack) queuePage = 1;
    let data = await readQueue(key, completion || check || followUpAt || bringBack ? '' : selected || current?.key || savedSelection);
    if (request !== sequence || !active) return;
    if (bringBack || (followUpAt && current)) {
      const selected = bringBack || { key, sourceRevision: current.revision, revision: current.followUpRevision };
      await api('/api/admin/workspace/flow/follow-up', { method: 'PUT', body: { key: selected.key, sourceRevision: selected.sourceRevision, revision: selected.revision, followUpAt: bringBack ? null : followUpAt } });
      if (request !== sequence || !active) return;
      el('adminFlowFollowUpForm').hidden = true;
      data = await readQueue();
      if (request !== sequence || !active) return;
    } else if ((completion || check) && data.currentPending) {
      current.revision = data.currentRevision;
      current.followUpRevision = data.followUpRevision;
      progress({ ...data, task: current });
      status(completion ? `${completion} This still needs your review.` : 'This still needs your review. You can continue now or choose a follow-up time.');
      return;
    } else if ((completion || check) && key) {
      completed++; saveSession();
    }
    progress(data);
    void refreshActivity();
    if (data.task) await openTask(data.task, request);else renderEmpty(data);
    if (completion) status(completion);
    else if (followUpAt) status('Follow-up saved. Next item ready.');
    else if (bringBack) {
      status('The item is back in your queue.');
      document.querySelector('[data-today-view="review"]').click();
      el('adminFlowQueueLayout').classList.add('show-review');
    }
  } catch (error) {
    if (request !== sequence || !active) return;
    status(error.message || 'Your queue is unavailable. Try again.');
    if (!current) {
      el('adminFlowTitle').textContent = 'Couldn’t load your queue.';
      el('adminFlowContext').textContent = 'Try again.';
      el('adminFlowReason').textContent = '';
      el('adminFlowBody').replaceChildren();
    }
  } finally {
    if (request === sequence) { reading = false; updateBusy(); }
  }
}
function pause() {
  active = false; sequence++; restore({ clearRoute: false });
  el('adminFlowBody').replaceChildren();
  document.body.classList.remove('admin-flow-active');
  reading = false; working = false; pendingSection = ''; updateBusy();
}
async function navigate(section) {
  navigating = true; updateBusy();
  let destination = '';
  try {
    await flushDraft();
    destination = pendingSection || section; pendingSection = '';
    pause();
    if (document.body.classList.contains('nav-open')) el('sidebarToggle').click();
    window.activateAdminSection(destination);
  } catch (error) { pendingSection = ''; status(error.message); }
  finally { navigating = false; updateBusy(); }
  if (destination === 'overview') resume();
  return destination;
}
function resume() {
  active = true; document.body.classList.add('admin-flow-active');
  void refresh();
}
function completedWork(detail) {
  if (!active || !current || current.id !== String(detail.id)) return;
  if (busy) { pendingCompletion = detail; return; }
  void refresh({ completion: detail.message || 'Saved.' });
}
function init() {
  if (new URL(location.href).searchParams.get('view') !== 'queue') return;
  if (!el('section-overview')) return;
  loadSession();
  const overview = el('section-overview');
  const more = document.createElement('details');
  more.className = 'admin-flow-more';
  more.innerHTML = '<summary>Reports &amp; platform totals</summary>';
  [...overview.children].forEach(node => more.append(node));
  overview.append(more);
  const flow = document.createElement('div');
  flow.id = 'adminFlow';
  flow.innerHTML = `<header class="admin-live-page-heading"><h1>Today</h1><button type="button" class="btn secondary" id="adminFlowRefresh" aria-label="Refresh queue">${icon('refresh')}</button></header><div class="admin-tabs admin-today-tabs" role="group" aria-label="Today views"><button type="button" data-today-view="review" aria-pressed="true">Needs you <span id="adminTodayNeedsCount"></span></button><button type="button" data-today-view="waiting" aria-pressed="false">Waiting</button><button type="button" data-today-view="activity" aria-pressed="false">Activity</button></div><div id="adminFlowQueueLayout" class="admin-live-queue"><aside class="admin-live-queue-list" aria-label="Decision queue"><div class="admin-queue-heading" id="adminFlowQueueCount">Loading queue…</div><div id="adminFlowQueue"></div></aside><section id="adminReviewPane" class="admin-live-review" aria-label="Selected decision"><header class="admin-flow-heading"><button class="btn secondary admin-queue-back" type="button" id="adminFlowBack">${icon('back')}Back</button><div><h2 id="adminFlowTitle" tabindex="-1">Loading…</h2><p id="adminFlowContext"></p><p id="adminFlowReason"></p></div><details id="adminFlowOptions" class="admin-record-options" hidden><summary aria-label="Account options">•••</summary><div id="adminFlowOptionsContent"></div></details></header><p id="adminFlowStatus" role="status" aria-live="polite"></p><div id="adminFlowBody" class="admin-flow-body"></div><form id="adminFlowFollowUpForm" class="admin-flow-follow-up" hidden><label for="adminFlowFollowUpAt">Remind me</label><input id="adminFlowFollowUpAt" type="datetime-local" required><p>No message will be sent.</p><div class="admin-inline-actions"><button class="btn primary" type="submit" id="adminFlowSaveFollowUp">Save follow-up</button><button class="btn secondary" type="button" id="adminFlowCancelFollowUp">Cancel</button></div></form><div id="adminFlowActions" class="admin-flow-actions" hidden><button type="button" class="btn secondary" id="adminFlowLater" aria-label="Choose follow-up">Later</button><button type="button" class="btn primary" id="adminFlowCheck" hidden>Check &amp; next ${icon('arrow')}</button></div></section></div><details class="admin-queue-evidence"><summary>Queue details</summary><p id="adminFlowScope" class="small"></p><p id="adminFlowProgress"></p></details><details id="adminFlowSaved" class="admin-flow-saved" hidden></details>`;
  overview.prepend(flow);
  refreshActivity = initAdminToday(overview);
  el('adminFlowQueue').addEventListener('click', event => {
    const row = event.target.closest('[data-flow-select]');
    const page = event.target.closest('[data-flow-page]');
    if (busy) return;
    if (row) { el('adminFlowQueueLayout').classList.add('show-review'); void refresh({ selected: row.dataset.flowSelect }); }
    if (page) void refresh({ page: Number(page.dataset.flowPage) });
  });
  el('adminFlowBack').addEventListener('click', () => { el('adminFlowQueueLayout').classList.remove('show-review'); el('adminFlowQueue').querySelector('[aria-pressed="true"]')?.focus(); });
  // Keep legacy reports available, without repeating decision lists beneath Today.
  for (const node of more.querySelectorAll('.admin-home-grid, .overview-action-panel')) node.hidden = true;
  document.body.classList.add('admin-guided');
  const home = document.querySelector('#sidebarNav [data-section="overview"]');
  [...home.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => node.textContent = 'Today');
  replaceEventHandler(el('adminFlowRefresh'), 'click', () => { if (!active) resume();else void refresh(); });
  replaceEventHandler(el('adminFlowLater'), 'click', () => {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
    el('adminFlowFollowUpAt').value = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    el('adminFlowFollowUpForm').hidden = false; el('adminFlowFollowUpAt').focus();
    el('adminFlowFollowUpAt').scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  replaceEventHandler(el('adminFlowCancelFollowUp'), 'click', () => { el('adminFlowFollowUpForm').hidden = true; el('adminFlowLater').focus(); });
  replaceEventHandler(el('adminFlowFollowUpForm'), 'submit', event => {
    event.preventDefault();
    const date = new Date(el('adminFlowFollowUpAt').value);
    if (!Number.isFinite(date.getTime())) { status('Choose a follow-up time.'); return; }
    void refresh({ followUpAt: date.toISOString() });
  });
  replaceEventHandler(el('adminFlowSaved'), 'click', event => {
    const button = event.target.closest('[data-resume-follow-up]');
    if (button && !busy) void refresh({ bringBack: followUps[Number(button.dataset.resumeFollowUp)] });
  });
  replaceEventHandler(el('adminFlowCheck'), 'click', () => void refresh({ check: true }));
  el('adminFlowBody').addEventListener('change', event => { if (event.target.id === 'adminReplyStatus') compact(); });
  new MutationObserver(compact).observe(el('adminFlowBody'), { childList: true, subtree: true });
  new MutationObserver(() => {
    if (visible('overview') && !active) resume();
    else if (!visible('overview') && active) pause();
  }).observe(overview, { attributes: true, attributeFilter: ['class'] });
  // Save the current draft before explicit sidebar navigation; a failed save keeps it visible.
  el('sidebarNav').addEventListener('click', event => {
    const button = event.target.closest('[data-section]');
    if (!active || !button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (working) { status('Finish the current action first.'); return; }
    if (busy) { pendingSection = button.dataset.section; status('Opening workspace…'); return; }
    void navigate(button.dataset.section);
  }, true);
  addEventListener('admin:work-busy', event => {
    if (!active || current?.id !== String(event.detail?.id)) return;
    working = Boolean(event.detail.busy);
    if (working) pendingSection = '';
    updateBusy();
  });
  addEventListener('admin:admissions-changed', event => completedWork({ ...event.detail, message: 'Decision saved.' }));
  addEventListener('admin:work-saved', event => completedWork(event.detail));
  // Existing home polling can bring new work into an empty flow without replacing an open draft.
  for (const event of ['admin:home-data', 'admin:inbox-counts']) document.addEventListener(event, () => {
    if (active && !current && !busy) void refresh();
  });
  new MutationObserver(() => {
    if (!active || mounted !== 'application' || !el('pendingUserModal').classList.contains('hidden') || busy) return;
    status('Application stays in your queue.');
    el('adminFlowBody').insertAdjacentHTML('beforeend','<button class="btn primary" type="button" id="adminFlowReopen">Continue review</button>');
    replaceEventHandler(el('adminFlowReopen'), 'click', () => void refresh());
  }).observe(el('pendingUserModal'), { attributes: true, attributeFilter: ['class'] });
  const params = new URL(location.href).searchParams;
  if (visible('overview') && !['account', 'ticket', 'matter', 'dispute'].some(key => params.has(key))) resume();
  else { el('adminFlowContext').textContent = 'Return here to work through your queue.'; }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
