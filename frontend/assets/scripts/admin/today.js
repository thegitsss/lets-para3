import { api, escapeHTML as esc } from './shared.js';

const time = value => value ? new Date(value).toLocaleString() : 'Not recorded';
function fold(node, title) {
  if (!node) return;
  if (node.parentElement?.matches('details.admin-detail-fold')) {
    node.parentElement.querySelector(':scope > summary').textContent = title;
    return;
  }
  const details = document.createElement('details');
  details.className = 'admin-detail-fold';
  const summary = document.createElement('summary'); summary.textContent = title;
  details.append(summary); node.before(details); details.append(node);
}
function simplifyGrowth() {
  const marketing = document.getElementById('section-marketing-drafts');
  marketing.querySelector('h1').textContent = 'Marketing';
  marketing.querySelector('header p').textContent = '';
  fold(document.getElementById('marketingBriefForm')?.closest('.panel'), 'Create a draft');
  fold(document.getElementById('marketingPublishingSettingsForm')?.closest('.workspace-grid'), 'Publishing schedule & connections');
  fold(document.getElementById('marketingJrCmoLibrary')?.closest('.workspace-stack'), 'Research notes');
  fold(marketing.querySelector('.founder-layer-grid'), 'Marketing summary & history');
  fold(document.getElementById('marketingFounderReadyPosts')?.closest('.workspace-stack'), 'Ready posts');
  fold(marketing.querySelector(':scope > .grid-four'), 'Marketing totals');
  const sales = document.getElementById('section-sales-workspace');
  sales.querySelector('h1').textContent = 'Sales';
  fold(document.getElementById('salesAccountForm')?.closest('.panel'), 'Add an account');
  fold(sales.querySelector(':scope > .grid-four'), 'Sales totals');
}
export function initAdminToday(overview) {
  simplifyGrowth();
  const root = document.createElement('div');
  root.className = 'admin-today-details';
  root.innerHTML = `<div class="admin-background-status"><p id="adminTodayEvidence" role="status">Checking background work…</p><p id="adminTodayWorker" role="status"></p></div><section id="adminTodayWaitingPanel" hidden aria-label="Waiting"><div id="adminTodayWaiting"></div></section><section id="adminTodayActivityPanel" hidden aria-label="Recent activity"><div id="adminTodayHandled"></div><button type="button" class="btn secondary" id="adminTodayFullActivity">Full activity log</button></section>`;
  overview.querySelector('#adminFlow').after(root);
  document.getElementById('adminTodayWaitingPanel').prepend(document.getElementById('adminFlowSaved'));
  const pick = view => {
    document.getElementById('adminFlowQueueLayout').hidden = view !== 'review';
    document.querySelector('.admin-queue-evidence').hidden = view !== 'review';
    document.getElementById('adminTodayWaitingPanel').hidden = view !== 'waiting';
    document.getElementById('adminTodayActivityPanel').hidden = view !== 'activity';
    document.querySelectorAll('[data-today-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.todayView === view)));
  };
  document.querySelector('.admin-today-tabs').addEventListener('click', event => { const button = event.target.closest('[data-today-view]'); if (button) pick(button.dataset.todayView); });
  document.getElementById('adminTodayFullActivity').addEventListener('click', () => window.activateAdminSection('activity-logs'));
  const system = document.getElementById('section-ai-control-room');
  const advanced = document.createElement('details');
  advanced.className = 'admin-automation-technical';
  advanced.innerHTML = '<summary>Technical details &amp; history</summary>';
  [...system.children].forEach(node => advanced.append(node));
  system.append(advanced);
  advanced.addEventListener('toggle', () => { if (advanced.open) void window.loadAdminAutomationDetails?.(true); });
  const controls = document.createElement('div');
  controls.className = 'admin-automation-controls';
  controls.innerHTML = '<header><h1>System</h1></header><div id="adminAutomationStatus" role="status"></div><div id="adminAutomationPolicies"></div><button type="button" class="btn secondary" id="adminAutomationRefresh">Refresh status</button>';
  system.prepend(controls);
  const el = id => document.getElementById(id);
  let sequence = 0;
  let changing = false;
  async function refresh() {
    const request = ++sequence;
    try {
      const data = await api('/api/admin/workspace/activity');
      if (request !== sequence) return;
      el('adminTodayEvidence').textContent = data.unavailable.length ? 'Some background checks are unavailable.' : `Updated ${time(data.checkedAt)}`;
      el('adminTodayWaiting').innerHTML = data.waiting ? `<p>${data.waiting.count ? `${data.waiting.count} ${data.waiting.count === 1 ? 'inquiry is' : 'inquiries are'} waiting for a reply or more information.` : 'No inquiries are waiting for a reply or more information.'}</p>${data.waiting.upcoming.length ? '<p>Next scheduled review times. These do not send messages:</p>' : ''}${data.waiting.upcoming.map(row => `<p><strong>${esc(row.subject)}</strong><br>${esc(time(row.followUpAt))}</p>`).join('')}` : '<p>Waiting inquiries could not be checked. Please refresh.</p>';
      el('adminTodayHandled').innerHTML = data.activity ? data.activity.length ? data.activity.map(row => `<div class="admin-activity-row"><strong>${esc(row.label)}${row.status === 'undone' ? ' · later undone' : ''}</strong><span>${esc(time(row.createdAt))}</span></div>`).join('') : '<p>No automation actions were recorded in the past seven days.</p>' : '<p>Recent activity could not be checked. Please refresh.</p>';
      const mailbox = data.mailbox;
      const automationMessage = data.automation?.message || 'Scheduled automation status could not be checked.';
      const workerRecent = mailbox?.lastWorkerAt && Date.now() - Date.parse(mailbox.lastWorkerAt) < 10 * 60000;
      el('adminTodayWorker').textContent = !mailbox ? 'Message service unavailable. Open System to check it.' : !workerRecent ? 'No recent message-service check-in. Open System to check it.' : mailbox.error ? 'Mailbox sync needs attention. Open System to check it.' : '';
      if (data.automation?.status !== 'completed') el('adminTodayWorker').textContent = [el('adminTodayWorker').textContent, automationMessage].filter(Boolean).join(' ');
      el('adminAutomationStatus').textContent = !mailbox ? 'Message service unavailable. Please refresh.' : `${workerRecent ? 'Message service checked in recently.' : 'No recent service check-in. Automatic messages may be paused.'} ${mailbox.configured ? `Last mailbox sync: ${time(mailbox.lastCompletedAt)}.` : 'Support mailbox isn’t connected.'}${mailbox.error ? ` ${mailbox.error}` : ''}`;
      const mailboxMessage = el('adminAutomationStatus').textContent;
      el('adminAutomationStatus').replaceChildren(...[mailboxMessage, automationMessage].map(text => { const paragraph = document.createElement('p'); paragraph.textContent = text; return paragraph; }));
      el('adminAutomationPolicies').innerHTML = data.policies ? data.policies.map(row => `<div class="admin-policy-row"><div><h2>${esc(row.label)}</h2><strong>${row.mode === 'auto' ? 'Automatic approval configured' : 'Needs your review'}</strong><details><summary>Details</summary><p>${esc(row.description)}</p></details></div>${row.mode === 'auto' ? `<button type="button" class="btn secondary" data-pause-role="${esc(row.role)}" data-pause-action="${esc(row.actionType)}" aria-label="Pause ${esc(row.label.toLowerCase())}">Pause approvals</button>` : ''}</div>`).join('') : '<p>Automation settings could not be checked. Please refresh before relying on them.</p>';
    } catch (error) {
      if (request !== sequence) return;
      el('adminTodayEvidence').textContent = 'Background work could not be checked. Please refresh.';
      el('adminTodayWorker').textContent = '';
      el('adminTodayWaiting').textContent = 'Waiting inquiries are unavailable.';
      el('adminTodayHandled').textContent = 'Recent activity is unavailable.';
      el('adminAutomationStatus').textContent = error.message || 'Automation settings are unavailable. Please refresh.';
      el('adminAutomationPolicies').replaceChildren();
    }
  }
  el('adminAutomationRefresh').addEventListener('click', () => { if (!changing) void refresh(); });
  el('adminAutomationPolicies').addEventListener('click', async event => {
    const button = event.target.closest('[data-pause-role]');
    if (!button || changing) return;
    changing = true; button.disabled = true;
    try {
      await api(`/api/admin/ai/control-room/autonomy-preferences/${encodeURIComponent(button.dataset.pauseRole)}/${encodeURIComponent(button.dataset.pauseAction)}/manual`, { method: 'POST', body: {} });
      await refresh();
      el('adminAutomationStatus').textContent = 'Automatic approval is paused for this category. An action already underway may still finish.';
    } catch (error) { el('adminAutomationStatus').textContent = error.message || 'The change could not be saved. Please refresh and try again.'; }
    finally { changing = false; button.disabled = false; }
  });
  new MutationObserver(() => { if (system.classList.contains('visible')) void refresh(); }).observe(system, { attributes: true, attributeFilter: ['class'] });
  void refresh();
  return refresh;
}
