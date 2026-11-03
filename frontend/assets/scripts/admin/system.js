import './live.js';
import { initCorrespondenceSettings } from './correspondence-settings.js';
import { api, escapeHTML as esc, onAdminPrivateInvalidation } from './shared.js';
import { readExecutive } from './executive.js';
import { readFinancial } from './financial-read.js';
import { fetchCSRF } from '../auth.js';
const el = id => document.getElementById(id);
export function initSystem() {
  if (new URL(location.href).searchParams.get('view') === 'queue') return;
  const root = el('section-ai-control-room');
  const navigation = document.querySelector('[aria-label="System views"]');
  if (!navigation) {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[aria-label="System views"]')) { observer.disconnect(); initSystem(); }
    });
    observer.observe(el('main'), {childList:true,subtree:true});
    return;
  }
  if (el('adminSystemView')) return;
  const options = [...navigation.querySelectorAll('[data-section]')];
  for (const button of options) {
    const section = el(`section-${button.dataset.section}`);
    if (!section.querySelector(':scope > header') && section.querySelector(':scope > h1')) {
      const heading = section.querySelector(':scope > h1');
      const header = document.createElement('header');heading.before(header);header.append(heading);
    }
  }
  const select = document.createElement('select');
  select.id = 'adminSystemView'; select.setAttribute('aria-label', 'System view');
  const names = {'ai-control-room':'Automation',engineering:'Technical issues','activity-logs':'Activity',settings:'Settings'};
  select.replaceChildren(...options.map(button => {
    const option = document.createElement('option');
    option.value = button.dataset.section;
    option.textContent = names[button.dataset.section] || button.textContent;
    return option;
  }));
  navigation.classList.add('admin-system-navigation');
  navigation.append(select);
  const security = el('adminIdentity');
  if (security) navigation.append(security);
  select.addEventListener('change', () => window.activateAdminSection?.(select.value));
  const sync = () => { const active = options.find(button => el(`section-${button.dataset.section}`)?.classList.contains('visible')); if (active) select.value = active.dataset.section; };
  for (const button of options) new MutationObserver(sync).observe(el(`section-${button.dataset.section}`),{attributes:true,attributeFilter:['class']});
  sync();
  const engineering = el('section-engineering');
  const engineeringInfo = document.createElement('details');
  engineeringInfo.className = 'admin-system-diagnostics';
  engineeringInfo.innerHTML = '<summary>Review guidance &amp; status</summary>';
  for (const node of [engineering.querySelector('.ai-room-summary-strip'), engineering.querySelector('.workspace-grid--engineering-top')]) if (node) engineeringInfo.append(node);
  engineering.append(engineeringInfo);
  engineering.querySelector('.workspace-panel--queue h2').textContent = 'Technical issues';
  el('auditSearch').placeholder = 'Search activity';
  const auditIntro = el('section-activity-logs').querySelector(':scope > p');
  if (auditIntro) auditIntro.textContent = 'Account and system changes.';
  const settings = root.querySelector('.admin-support-tools');
  const advanced = document.createElement('details');
  advanced.className = 'admin-system-diagnostics';
  advanced.innerHTML = '<summary>Diagnostics</summary>';
  [...root.children].filter(node => node !== navigation && node !== settings).forEach(node => advanced.append(node));
  const header = document.createElement('header'); header.innerHTML = '<h1>System</h1>';
  const status = document.createElement('div');
  status.className = 'admin-system-overview';
  status.innerHTML = '<div class="admin-system-heading"><h2>Needs attention</h2><button type="button" class="btn secondary" id="adminSystemRefresh">Refresh</button></div><p id="adminSystemError" role="status"></p><ul id="adminSystemAttention" aria-label="System checks"></ul><details class="admin-system-diagnostics" id="adminSystemConnectionDetails"><summary>Connections &amp; recent runs</summary><dl id="adminSystemConnections"></dl></details><details class="admin-system-diagnostics" id="adminSystemPreparationRecovery" hidden><summary>Preparation recovery</summary><p id="adminSystemPreparationStatus" role="status"></p><div id="adminSystemPreparationJobs"></div></details><details class="admin-system-diagnostics" id="adminSystemAutomationSettings"><summary>Automation settings</summary><div id="adminSystemPolicies"></div></details>';
  root.prepend(header); header.after(navigation, status);
  const refreshCorrespondence = initCorrespondenceSettings(el("adminSystemAutomationSettings"));
  root.append(advanced);
  if (settings) {settings.querySelector('summary').textContent='Requests & email';root.append(settings);}
  advanced.addEventListener('toggle', () => {if(advanced.open) void window.loadAdminAutomationDetails?.(true);});
  let sequence = 0, changing = false, failedPreparation = [], privacyEpoch = 0;
  onAdminPrivateInvalidation(() => {
    sequence++; privacyEpoch++; failedPreparation = [];
    for (const id of ['adminSystemPreparationJobs','adminSystemConnections','adminSystemPolicies','adminSystemAttention']) el(id).replaceChildren();
    el('adminSystemPreparationRecovery').hidden = true;
    el('adminSystemError').textContent = 'Verify your Admin access before checking System.';
  });
  async function refresh() {
    if (changing) return;
    const request = ++sequence;
    el('adminSystemError').textContent = 'Checking…';
    try {
      const [data, executive] = await Promise.all([api('/api/admin/workspace/activity'), readExecutive().catch(() => null)]);
      if (request !== sequence) return;
      const mailbox = data.mailbox;
      const recent = mailbox?.workerHealth?.ok === true;
      const attention = [];
      const operations = executive?.operations;
      if (operations?.healthy !== true) attention.push(operations?.message || 'Review-preparation status is unavailable.');
      failedPreparation = Array.isArray(operations?.failedItems) ? operations.failedItems : [];
      el('adminSystemPreparationRecovery').hidden = !failedPreparation.length;
      el('adminSystemPreparationJobs').innerHTML = failedPreparation.map((row,index) => `<div class="admin-policy-row"><span>${esc(({application:'Application review',inquiry:'Inquiry review',matter:'Matter review'})[row.kind] || 'Review preparation')}</span><button type="button" class="btn secondary" data-preparation-retry="${index}">Retry preparation</button></div>`).join('');
      el('adminSystemPreparationStatus').textContent = failedPreparation.length ? 'Retrying prepares a fresh review; it does not decide, send a message or move money.' : '';
      if (!mailbox) attention.push('Support email status is unavailable.');
      else if (!mailbox.configured) attention.push('Support email is not connected.');
      else {
        if (mailbox.error) attention.push('Support email needs checking. Open Requests & email below.');
        if (!recent) attention.push(mailbox.workerHealth?.message || 'Message-service health could not be verified.');
        else if (!mailbox.lastCompletedAt) attention.push('Support email has not completed its first sync.');
      }
      if (!data.automation || !['completed','running'].includes(data.automation.status)) attention.push(data.automation?.message || 'Scheduled automation status is unavailable.');
      if (data.recovery?.blocked) attention.push(`${data.recovery.blocked} recorded decisions need technical follow-up. Automatic retries have stopped.`);
      else if (data.recovery?.pending) attention.push(`${data.recovery.pending} recorded decisions are waiting for background follow-up.`);
      el('adminSystemAttention').innerHTML = attention.map(message => `<li>${esc(message)}</li>`).join('');
      el('adminSystemConnections').innerHTML = `<div><dt>Support email</dt><dd>${!mailbox ? 'Unavailable' : !mailbox.configured ? 'Not connected' : mailbox.error ? 'Needs attention' : mailbox.lastCompletedAt ? 'Last sync recorded' : 'Not yet checked'}</dd></div><div><dt>Background service</dt><dd>${!mailbox ? 'Unavailable' : recent ? 'Current and completing work' : 'Needs checking'}</dd></div><div><dt>Review preparation</dt><dd>${esc(operations?.message || 'Status unavailable.')}</dd></div><div><dt>Scheduled automation</dt><dd>${esc(data.automation?.message || 'Status unavailable. Refresh to retry.')}</dd></div>`;
      el('adminSystemPolicies').innerHTML = data.policies ? data.policies.map(row => `<details class="admin-system-policy"><summary><span>${esc(row.label)}</span><span>${row.mode === 'auto' ? 'Automatic approval' : 'Your review'}</span></summary><p>${esc(row.description)}</p>${row.mode === 'auto' ? `<button type="button" class="btn secondary" data-pause-role="${esc(row.role)}" data-pause-action="${esc(row.actionType)}">Pause approvals</button>` : ''}</details>`).join('') : '<p>Automation settings unavailable.</p>';
      el('adminSystemError').textContent = data.unavailable?.length ? 'Some checks are unavailable. Refresh to retry.' : attention.length ? '' : 'No issues reported by these checks.';
    } catch(error) {
      if(request!==sequence)return;
      el('adminSystemError').textContent=error.message || 'Status unavailable. Refresh to retry.';
      el('adminSystemConnections').replaceChildren();el('adminSystemPolicies').replaceChildren();el('adminSystemAttention').replaceChildren();
      failedPreparation = []; el('adminSystemPreparationJobs').replaceChildren(); el('adminSystemPreparationRecovery').hidden = true;
    }
  }
  el('adminSystemPolicies').addEventListener('click', async event => {
    const button = event.target.closest('[data-pause-role]');
    if (!button || changing) return;
    changing = true; ++sequence; button.disabled = true;
    try {
      await api(`/api/admin/ai/control-room/autonomy-preferences/${encodeURIComponent(button.dataset.pauseRole)}/${encodeURIComponent(button.dataset.pauseAction)}/manual`, { method: 'POST', body: {} });
      changing = false; await refresh();
      el('adminSystemError').textContent = 'Automatic approval is paused for this category. An action already underway may still finish.';
    } catch (error) { el('adminSystemError').textContent = error.message || 'The change could not be saved. Refresh to check it.'; }
    finally { changing = false; button.disabled = false; }
  });
  el('adminSystemPreparationJobs').addEventListener('click', async event => {
    const button = event.target.closest('[data-preparation-retry]');
    const row = button && failedPreparation[Number(button.dataset.preparationRetry)];
    if (!row || changing || button.disabled || !['application','inquiry','matter'].includes(row.kind) || !/^[a-f0-9]{24}$/i.test(row.id || '')) return;
    changing = true; button.disabled = true; let uncertain = false; const epoch = privacyEpoch;
    try {
      const fresh = await readFinancial(`/api/admin/workspace/preparation/${row.kind}/${encodeURIComponent(row.id)}`, { suppressToast: true });
      if (epoch !== privacyEpoch) return;
      if (fresh.preparation?.status !== 'failed' || fresh.preparation.sourceRevision !== row.sourceRevision) throw new Error('This preparation changed. Refresh status before retrying.');
      await fetchCSRF(); if (epoch !== privacyEpoch) return; uncertain = true;
      await api(`/api/admin/workspace/preparation/${row.kind}/${encodeURIComponent(row.id)}/retry?expectedOwnerId=${encodeURIComponent(fresh.ownerId)}`, { method:'POST', body:{ expectedOwnerId:fresh.ownerId, reviewedRevision:row.sourceRevision } });
      uncertain = false; if (epoch !== privacyEpoch) return; changing = false; await refresh();
      if (epoch !== privacyEpoch) return;
      el('adminSystemError').textContent = 'Preparation queued. Completion has not yet been confirmed.';
    } catch(error) {
      if (epoch !== privacyEpoch) return;
      if (error.status >= 400 && error.status < 500) uncertain = false;
      el('adminSystemPreparationStatus').textContent = uncertain ? 'The retry outcome is unconfirmed. Refresh status before trying again.' : error.message;
    } finally { changing = false; if (!uncertain) button.disabled = false; }
  });
  el('adminSystemRefresh').addEventListener('click', () => { void refresh(); void refreshCorrespondence(); });
  window.addEventListener('admin:automation-changed', () => {
    if (root.classList.contains('visible')) void refresh();
  });
  new MutationObserver(() => {if(root.classList.contains('visible'))void refresh();}).observe(root,{attributes:true,attributeFilter:['class']});
  if(root.classList.contains('visible'))void refresh();
}
