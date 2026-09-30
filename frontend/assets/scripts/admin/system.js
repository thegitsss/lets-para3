import './live.js';
import { api, escapeHTML as esc } from './shared.js';
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
  status.innerHTML = '<div class="admin-system-heading"><h2>Connections</h2><button type="button" class="btn secondary" id="adminSystemRefresh">Refresh</button></div><p id="adminSystemError" role="status"></p><dl id="adminSystemConnections"></dl><h2>Automation</h2><div id="adminSystemPolicies"></div>';
  root.prepend(header); header.after(navigation, status);
  root.append(advanced);
  if (settings) {settings.querySelector('summary').textContent='Requests & email';root.append(settings);}
  advanced.addEventListener('toggle', () => {if(advanced.open) void window.loadAdminAutomationDetails?.(true);});
  let sequence = 0, changing = false;
  async function refresh() {
    if (changing) return;
    const request = ++sequence;
    el('adminSystemError').textContent = 'Checking…';
    try {
      const data = await api('/api/admin/workspace/activity');
      if (request !== sequence) return;
      const mailbox = data.mailbox;
      const age = Date.now()-Date.parse(mailbox?.lastWorkerAt);
      const recent = Number.isFinite(age) && age >= 0 && age < 600000;
      el('adminSystemConnections').innerHTML = `<div><dt>Support email</dt><dd>${!mailbox ? 'Unavailable' : !mailbox.configured ? 'Not connected' : mailbox.error ? 'Needs attention' : mailbox.lastCompletedAt ? 'Last sync recorded' : 'Not yet checked'}</dd></div><div><dt>Background service</dt><dd>${!mailbox ? 'Unavailable' : recent ? 'Checked in recently' : 'No recent check-in'}</dd></div><div><dt>Scheduled automation</dt><dd>${esc(data.automation?.message || 'Status unavailable. Refresh to retry.')}</dd></div>`;
      el('adminSystemPolicies').innerHTML = data.policies ? data.policies.map(row => `<details class="admin-system-policy"><summary><span>${esc(row.label)}</span><span>${row.mode === 'auto' ? 'Automatic approval' : 'Your review'}</span></summary><p>${esc(row.description)}</p>${row.mode === 'auto' ? `<button type="button" class="btn secondary" data-pause-role="${esc(row.role)}" data-pause-action="${esc(row.actionType)}">Pause approvals</button>` : ''}</details>`).join('') : '<p>Automation settings unavailable.</p>';
      el('adminSystemError').textContent = data.unavailable?.length ? 'Some checks are unavailable. Refresh to retry.' : '';
    } catch(error) {
      if(request!==sequence)return;
      el('adminSystemError').textContent=error.message || 'Status unavailable. Refresh to retry.';
      el('adminSystemConnections').replaceChildren();el('adminSystemPolicies').replaceChildren();
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
  el('adminSystemRefresh').addEventListener('click', refresh);
  new MutationObserver(() => {if(root.classList.contains('visible'))void refresh();}).observe(root,{attributes:true,attributeFilter:['class']});
  if(root.classList.contains('visible'))void refresh();
}
