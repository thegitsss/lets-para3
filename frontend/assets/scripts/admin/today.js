import { privateApi as api, onAdminPrivateInvalidation, escapeHTML as esc } from './shared.js';

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
export function initAdminToday(overview, { configureWorkspaces = true } = {}) {
  if (configureWorkspaces) simplifyGrowth();
  const root = document.createElement('div');
  root.className = 'admin-today-details';
  root.innerHTML = `<div class="admin-background-status"><p id="adminTodayEvidence" role="status">Checking background work…</p><p id="adminTodayWorker" role="status"></p><button class="btn secondary" type="button" id="adminTodayOpenSystem" hidden>Open System</button><p id="adminTodayFinancialEvidence" role="status"></p><button class="btn secondary" type="button" id="adminTodayOpenFinance" hidden>Open Finances</button></div><section id="adminTodayWaitingPanel" hidden aria-label="Waiting"><p id="adminTodayApplicationWaiting">Application follow-ups are being checked.</p><div id="adminTodayWaiting"></div></section><section id="adminTodayActivityPanel" hidden aria-label="Handled"><div id="adminTodayOwnerHandled"><p>Recorded owner decisions are being checked.</p></div><h2>Background actions</h2><div id="adminTodayHandled"></div><button type="button" class="btn secondary" id="adminTodayFullActivity">Full activity log</button></section>`;
  overview.querySelector('#adminFlow').after(root);
  if (!configureWorkspaces) root.hidden = true;
  document.getElementById('adminTodayWaitingPanel').prepend(document.getElementById('adminFlowSaved'));
  let activityProblem = 'Background checks are being completed.', activityKnown = false;
  let operationsProblem = configureWorkspaces ? '' : 'Review preparation is being checked.', operationsKnown = configureWorkspaces;
  let financialKnown = configureWorkspaces, financialProblem = configureWorkspaces ? '' : 'Platform earnings are being checked.';
  let metricsKnown = configureWorkspaces, metricsProblem = '';
  function backgroundState() {
    const problem = activityProblem || operationsProblem || metricsProblem;
    document.getElementById('adminTodayWorker').textContent = problem;
    document.getElementById('adminTodayOpenSystem').hidden = !(activityKnown && activityProblem || operationsKnown && operationsProblem);
    document.dispatchEvent(new CustomEvent('admin:background-state', { detail: { healthy: activityKnown && operationsKnown && financialKnown && metricsKnown && !problem && !financialProblem, checked: activityKnown && operationsKnown && financialKnown && metricsKnown } }));
  }
  function preparationState(data) {
    if (configureWorkspaces) return;
    operationsKnown = true;
    operationsProblem = data?.healthy === true ? '' : (data?.message || ({ running: 'Review preparation is still running.', paused: 'Review preparation is paused.', failed: 'Review preparation failed.', stale: 'Review preparation has no recent check-in.', unknown: 'Review preparation has not completed its first check.' }[data?.status] || 'Review-preparation status is unavailable.'));
    backgroundState();
  }
  const pick = view => {
    if (!configureWorkspaces) root.hidden = view === 'review';
    document.getElementById('adminFlowQueueLayout').hidden = view !== 'review';
    document.querySelector('.admin-queue-evidence').hidden = view !== 'review';
    document.getElementById('adminTodayWaitingPanel').hidden = view !== 'waiting';
    document.getElementById('adminTodayActivityPanel').hidden = view !== 'activity';
    document.querySelectorAll('[data-today-view]').forEach(button => {
      const selected = button.dataset.todayView === view; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
  };
  document.querySelector('.admin-today-tabs').addEventListener('click', event => { const button = event.target.closest('[data-today-view]'); if (button) pick(button.dataset.todayView); });
  document.querySelector('.admin-today-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const tabs = [...document.querySelectorAll('[data-today-view]')];
    const current = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    pick(tabs[index].dataset.todayView); tabs[index].focus();
  });
  document.getElementById('adminTodayOpenFinance').addEventListener('click', () => window.activateAdminSection('finance'));
  document.addEventListener('admin:earnings-evidence', event => {
    if (configureWorkspaces) return;
    financialKnown = true; financialProblem = event.detail?.available === true ? '' : 'Platform earnings could not be verified.';
    document.getElementById('adminTodayFinancialEvidence').textContent = financialProblem;
    document.getElementById('adminTodayOpenFinance').hidden = !financialProblem; backgroundState();
  });
  document.getElementById('adminTodayOpenSystem').addEventListener('click', () => window.activateAdminSection('ai-control-room'));
  document.addEventListener('admin:queue-state', event => {
    const count = event.detail?.waiting;
    document.getElementById('adminTodayApplicationWaiting').textContent = Number.isSafeInteger(count) && count >= 0 ? count ? `${count} ${count === 1 ? 'application is' : 'applications are'} waiting for a reply.` : 'No applications are waiting for a reply.' : 'Application follow-ups are unavailable.';
  });
  const handledUnavailable = () => { document.getElementById('adminTodayOwnerHandled').textContent = 'Recorded owner decisions are unavailable.'; };
  document.addEventListener('admin:executive-unavailable', () => { handledUnavailable(); metricsKnown = true; metricsProblem = 'Business figures could not be fully checked.'; preparationState(null); });
  document.addEventListener('admin:executive-data', event => {
    const sources = event.detail?.metrics?.sources;
    metricsKnown = true; metricsProblem = sources && ['acquisition','marketplace','customerExperience','automation','owner'].every(key => sources[key]?.available === true) ? '' : 'Some business figures could not be checked.';
    preparationState(event.detail?.operations);
    const data = event.detail?.handled;
    if (!data?.available || !Array.isArray(data.items)) { handledUnavailable(); return; }
    document.getElementById('adminTodayOwnerHandled').innerHTML = `<h2>Recorded decisions</h2>${data.items.length ? data.items.map(row => `<div class="admin-activity-row"><div><strong>${esc(row.label)}</strong>${row.name ? `<span>${esc(row.name)}</span>` : ''}</div><span>${esc(time(row.createdAt))}</span></div>`).join('') : '<p>No owner decisions were recorded in this period.</p>'}`;
  });
  document.getElementById('adminTodayFullActivity').addEventListener('click', () => window.activateAdminSection('activity-logs'));
  let system = null;
  if (configureWorkspaces) {
  system = document.getElementById('section-ai-control-room');
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
  }
  const el = id => document.getElementById(id);
  let sequence = 0;
  let changing = false;
  onAdminPrivateInvalidation(() => {
    sequence++;
    for (const id of ['adminTodayWaiting', 'adminTodayHandled', 'adminTodayOwnerHandled', 'adminAutomationPolicies', 'adminTodayWorker']) el(id)?.replaceChildren();
    el('adminTodayEvidence').textContent = 'Verify your Admin access before reviewing background work.';
    el('adminTodayFinancialEvidence').textContent = ''; el('adminTodayOpenFinance').hidden = true; financialKnown = true; financialProblem = 'Verify your Admin access before checking earnings.';
    el('adminTodayApplicationWaiting').textContent = 'Verify your Admin access before reviewing follow-ups.'; el('adminTodayOpenSystem').hidden = true;
    activityKnown = true; activityProblem = 'Verify your Admin access before relying on background work.'; backgroundState();
    if (configureWorkspaces) el('adminAutomationStatus').textContent = 'Verify your Admin access before checking automation.';
  });
  async function refresh() {
    const request = ++sequence;
    try {
      const data = await api('/api/admin/workspace/activity');
      if (request !== sequence) return;
      el('adminTodayEvidence').textContent = data.unavailable?.length ? 'Some background checks are unavailable.' : `Checked ${time(data.checkedAt)}`;
      el('adminTodayWaiting').innerHTML = data.waiting ? `<p>${data.waiting.count ? `${data.waiting.count} ${data.waiting.count === 1 ? 'inquiry is' : 'inquiries are'} waiting for a reply or more information.` : 'No inquiries are waiting for a reply or more information.'}</p>${data.waiting.upcoming.length ? '<p>Next scheduled review times. These do not send messages:</p>' : ''}${data.waiting.upcoming.map(row => `<p><strong>${esc(row.subject)}</strong><br>${esc(time(row.followUpAt))}</p>`).join('')}` : '<p>Waiting inquiries could not be checked. Please refresh.</p>';
      el('adminTodayHandled').innerHTML = data.activity ? data.activity.length ? data.activity.map(row => `<div class="admin-activity-row"><strong>${esc(row.label)}${row.status === 'undone' ? ' · later undone' : ''}</strong><span>${esc(time(row.createdAt))}</span></div>`).join('') : '<p>No handled background actions were recorded in the past seven days.</p>' : '<p>Recent activity could not be checked. Please refresh.</p>';
      const mailbox = data.mailbox;
      const automationMessage = data.automation?.message || 'Scheduled automation status could not be checked.';
      const workerRecent = mailbox?.workerHealth?.ok === true;
      const workerMessage = mailbox?.workerHealth?.message || 'Message-service health could not be verified. Open System to check it.';
      const problem = !mailbox ? 'Message-service status is unavailable.' : !mailbox.configured ? 'Support email is not connected.' : !workerRecent ? 'Message processing has no current check-in.' : mailbox.error ? 'Support email sync needs attention.' : !['completed','running'].includes(data.automation?.status) ? 'Scheduled work needs attention.' : data.recovery?.blocked ? 'Some recorded decisions need recovery.' : data.unavailable?.length ? 'Some background checks could not finish.' : '';
      activityKnown = true; activityProblem = problem; backgroundState();
      if (configureWorkspaces) {
      el('adminAutomationStatus').textContent = !mailbox ? 'Message service unavailable. Please refresh.' : `${workerMessage} ${mailbox.configured ? `Last mailbox sync: ${time(mailbox.lastCompletedAt)}.` : 'Support mailbox isn’t connected.'}${mailbox.error ? ` ${mailbox.error}` : ''}`;
      const mailboxMessage = el('adminAutomationStatus').textContent;
      el('adminAutomationStatus').replaceChildren(...[mailboxMessage, automationMessage].map(text => { const paragraph = document.createElement('p'); paragraph.textContent = text; return paragraph; }));
      el('adminAutomationPolicies').innerHTML = data.policies ? data.policies.map(row => `<div class="admin-policy-row"><div><h2>${esc(row.label)}</h2><strong>${row.mode === 'auto' ? 'Automatic approval configured' : 'Needs your review'}</strong><details><summary>Details</summary><p>${esc(row.description)}</p></details></div>${row.mode === 'auto' ? `<button type="button" class="btn secondary" data-pause-role="${esc(row.role)}" data-pause-action="${esc(row.actionType)}" aria-label="Pause ${esc(row.label.toLowerCase())}">Pause approvals</button>` : ''}</div>`).join('') : '<p>Automation settings could not be checked. Please refresh before relying on them.</p>';
      }
    } catch (error) {
      if (request !== sequence) return;
      el('adminTodayEvidence').textContent = 'Background work could not be checked. Please refresh.';
      activityKnown = true; activityProblem = 'Background checks could not finish.'; backgroundState();
      el('adminTodayWaiting').textContent = 'Waiting inquiries are unavailable.';
      el('adminTodayHandled').textContent = 'Recent activity is unavailable.';
      if (configureWorkspaces) { el('adminAutomationStatus').textContent = error.message || 'Automation settings are unavailable. Please refresh.'; el('adminAutomationPolicies').replaceChildren(); }
    }
  }
  if (configureWorkspaces) {
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
  }
  if (configureWorkspaces) { el('adminTodayOwnerHandled').hidden = true; void refresh(); }
  return refresh;
}
