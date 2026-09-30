import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { money, stateLabel, providerLabel, unitAmount } from './financial-read.js';
import { api, escapeHTML as esc, date, label, person, debounce, visible, routeParam } from './shared.js';
import {avatar,age,badge,icon} from './presentation.js';
const el = id => document.getElementById(id);
let homeSequence = 0,
  previousInbox = null,
  matterPage = 1,
  matterPages = 1,
  matterSequence = 0,
  detailSequence = 0;
async function refreshHome() {
  const seq = ++homeSequence;
  const results = await Promise.allSettled([api('/api/admin/pending-users?status=pending&limit=5&sort=oldest'), api('/api/admin/support/inbox-summary')]);
  if (seq !== homeSequence) return;
  const signups = results[0],
    inbox = results[1];
  if (signups.status === 'fulfilled') {
    const data = signups.value;
    el('adminSignupStatus').textContent = data.total ? `${data.total} ${data.total === 1 ? 'application' : 'applications'} awaiting your decision · oldest first` : 'No new applications.';
    el('adminSignupBadge').textContent = data.total || '';
    el('adminSignupList').innerHTML = data.users.length ? data.users.map(u=>`<div class="admin-signup-row">${avatar(u.name||person(u),u.role)}<div class="admin-signup-person"><strong>${esc(u.name||person(u))}</strong><p>${esc(u.email)}</p></div><div class="admin-signup-context">${badge('pending',label(u.role).replace(/^./,c=>c.toUpperCase()))}<small title="${esc(date(u.createdAt))}">${age(u.createdAt)}</small></div><button type="button" class="btn primary" data-admin-review="${esc(u.id)}">Review ${icon('arrow')}</button></div>`).join('') : '';
    el('adminSignupList').hidden = !data.users.length;
    document.dispatchEvent(new CustomEvent('admin:home-data',{detail:{signups:data.total,oldest:data.users[0]?.createdAt}}));
  } else {
    el('adminSignupStatus').textContent = 'Applications are unavailable. Refresh to try again.';
    el('adminSignupList').innerHTML = '';
    el('adminSignupList').hidden = true;
    el('adminSignupBadge').textContent = '!';
  }
  if (inbox.status === 'fulfilled') {
    const value = inbox.value;
    el('adminInboxBadge').textContent = value.all || '';
    el('adminContactCount').textContent = value.contact;
    el('adminHumanCount').textContent = value.human;
    el('adminInboxHomeStatus').textContent = `${value.all} ${value.all === 1 ? 'inquiry' : 'inquiries'} waiting for your review. `;
    if (previousInbox !== null && (value.human > previousInbox.human || value.contact > previousInbox.contact)) {
      window.toastUtils?.show('A new inquiry is waiting in Inbox.', {
        targetId: 'toastBanner',
        type: 'info'
      });
    }
    previousInbox = value;
    document.dispatchEvent(new CustomEvent('admin:inbox-counts',{detail:value}));
  } else {
    el('adminInboxHomeStatus').textContent = 'Inquiry counts are unavailable. Open Inbox to retry.';
    el('adminInboxBadge').textContent = '!';
    el('adminContactCount').textContent = '—';
    el('adminHumanCount').textContent = '—';
  }
}
function usersLayout() {
  const section = el('section-user-management');
  if (!section) return;
  const tabs = document.createElement('div');
  tabs.className = 'admin-tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'User workspace');
  tabs.innerHTML = '<button type="button" data-user-view="applications" aria-pressed="true">Applications</button><button type="button" data-user-view="directory" aria-pressed="false">All users</button><button type="button" data-user-view="photos" aria-pressed="false">Photo review</button><button type="button" data-user-view="deactivated" aria-pressed="false">Deactivated</button>';
  section.querySelector('header').after(tabs);
  const content = document.createElement('div');
  content.id = 'adminUsersContent';
  tabs.after(content);
  const panels = {
    applications: el('pendingUsersPanel'),
    directory: el('approvedUsersPanel'),
    photos: el('photoReviewsPanel'),
    deactivated: el('deletedUsersPanel')
  };
  Object.values(panels).forEach(panel => {
    panel.classList.remove('collapsed');
    panel.classList.add('admin-user-panel');
    panel.querySelectorAll('.panel-content').forEach(c => {
      c.style.display = 'block';
    });
    panel.querySelectorAll('[data-panel-toggle]').forEach(h => {
      h.removeAttribute('data-panel-toggle');
      h.removeAttribute('role');
      h.removeAttribute('tabindex');
    });
    content.append(panel);
  });
  panels.directory.querySelector('h2').textContent = 'All users';
  const select = document.createElement('select');
  select.id = 'adminUserStatus';
  select.setAttribute('aria-label', 'Account status');
  select.innerHTML = '<option value="all">All account states</option><option value="approved">Approved</option><option value="pending">Pending</option><option value="denied">Denied</option><option value="suspended">Suspended</option>';
  panels.directory.querySelector('.pending-controls').prepend(select);
  replaceEventHandler(select, 'change', () => window.refreshAdminUsers?.());
  window.showAdminUsers = (view = 'applications', {
    navigate = true
  } = {}) => {
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== view;
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.userView === view)));
    if (navigate) window.activateAdminSection?.('user-management');
    if (view === 'directory') window.refreshAdminUsers?.();
  };
  replaceEventHandler(tabs, 'click', e => {
    if (e.target.dataset.userView) window.showAdminUsers(e.target.dataset.userView);
  });
  for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== 'applications';
  el('section-photo-reviews').innerHTML = '';
  const report = document.createElement('details');
  report.className = 'admin-detail-fold';
  report.innerHTML = '<summary>Registration reporting &amp; outreach</summary>';
  section.append(report);
  const chart = section.querySelector('.dashboard-grid');
  if (chart) report.append(chart);
  if (el('massEmailPanel')) report.append(el('massEmailPanel'));
  section.querySelector('.user-approvals-grid')?.remove();
  section.querySelector('.user-management-secondary')?.remove();
}
function financeLayout() {
  const section = el('section-escrow');
  // The Finance heading and selected panel already identify each destination.
  for (const id of ['section-disputes', 'section-revenue']) el(id).querySelector(':scope > header')?.remove();
  const tabs = document.createElement('div');
  tabs.className = 'admin-tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Finance workspace');
  tabs.innerHTML = '<button type="button" data-finance-view="exceptions" aria-pressed="true">Disputes &amp; chargebacks</button><button type="button" data-finance-view="reporting" aria-pressed="false">Payments &amp; receipts</button><button type="button" data-finance-view="reconcile" aria-pressed="false">Check payment</button>';
  section.querySelector('header').after(tabs);
  const row = section.querySelector('.escrow-chart-row');
  row.dataset.adminFinancePanel = 'reconcile';
  const pick = view => {
    row.hidden = view !== 'reconcile';
    el('section-disputes').hidden = view !== 'exceptions';
    el('section-revenue').hidden = view !== 'reporting';
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.financeView === view)));
  };
  replaceEventHandler(tabs, 'click', e => {
    if (e.target.dataset.financeView) pick(e.target.dataset.financeView);
  });
  window.showAdminFinance = pick;
  pick('exceptions');
  el('disputeStatusFilter').hidden = true;
  // A context-aware action supplies the selected matter to the existing reconciliation flow.
  window.openAdminFinance = (caseId = '') => {
    window.activateAdminSection?.('finance');
    pick(caseId ? 'reconcile' : 'exceptions');
    if (caseId) { el('reconcileCaseId').value = caseId; void window.selectAdminPaymentMatter?.(caseId); }
  };
}
async function loadMatters() {
  const seq = ++matterSequence;
  el('adminMatterStatus').textContent = 'Loading matters…';
  try {
    const params = new URLSearchParams({
      page: matterPage,
      q: el('adminMatterSearch').value,
      filter: el('adminMatterFilter').value
    });
    const selectedUser = new URL(location.href).searchParams.get('matterUser');
    if (selectedUser) params.set('user', selectedUser);
    const result = await api(`/api/admin/workspace/matters?${params}`);
    if (seq !== matterSequence) return;
    matterPages = Math.max(1, result.pages);
    if (matterPage > matterPages) {
      matterPage = matterPages;
      return loadMatters();
    }
    el('adminMatterStatus').textContent = `${result.total} ${result.total === 1 ? 'matter' : 'matters'} · page ${matterPage} of ${matterPages}`;
    el('adminMatterPage').closest('.admin-pager').hidden = matterPages <= 1;
    el('adminMatterPage').textContent = `Page ${matterPage} of ${matterPages}`;
    el('adminMatterPrev').disabled = matterPage <= 1;
    el('adminMatterNext').disabled = matterPage >= matterPages;
    el('adminMatterList').innerHTML = result.items.length ? `<div class="table-wrap"><table class="admin-matters-table"><thead><tr><th>Matter</th><th>Attorney / paralegal</th><th>Engagement</th><th>Posting review</th><th>Deadline</th></tr></thead><tbody>${result.items.map(m => `<tr><td><button class="btn-link" type="button" data-admin-matter="${esc(m.id)}">${esc(m.title || 'Untitled matter')}</button><small>${esc(m.practiceArea || '')}</small></td><td>${esc(person(m.attorney))}<small>${esc(person(m.paralegal))}</small></td><td>${badge(m.status, label(m.status))}${m.archived ? ' · Archived' : ''}</td><td>${badge(m.moderationStatus||'neutral',label(m.moderationStatus||'Clear'))}${m.flagCount ? ` · ${m.flagCount} reports` : ''}</td><td>${esc(date(m.deadline))}</td></tr>`).join('')}</tbody></table></div>` : '<p>No matters match these filters.</p>';
  } catch (e) {
    if (seq !== matterSequence) return;
    el('adminMatterStatus').textContent = e.message;
    el('adminMatterList').innerHTML = '<p>Matters are unavailable. Refresh to try again.</p>';
  }
}
async function openMatter(id, { navigate = true } = {}) {
  if (!/^[a-f0-9]{24}$/i.test(id)) return;
  if (navigate) window.activateAdminSection?.('matters');
  routeParam('matter', id);
  const seq = ++detailSequence;
  const root = el('adminMatterDetail');
  root.dataset.matterId = id;
  root.tabIndex = -1;
  root.setAttribute('aria-label','Matter details');
  root.hidden = false;
  root.innerHTML = '<p role="status">Loading matter…</p>';
  try {
    const data = await api(`/api/admin/workspace/matters/${id}`);
    if (seq !== detailSequence) return;
    const m = data.matter;
    const party = (p, role) => p ? `<button class="btn-link" data-admin-review="${esc(p._id)}">${esc(person(p))}</button> (${role})` : `No ${role} assigned`;
    root.innerHTML = `<div class="panel-header"><div><h2>${esc(m.title)}</h2></div><button class="btn secondary" data-close-matter type="button">${icon('back')} Back to matters</button></div><p>${party(m.attorney, 'attorney')} · ${party(m.paralegal, 'paralegal')}</p>
 <div class="admin-facts"><div><span>Engagement</span><strong>${esc(label(m.status))}</strong></div><div><span>Posting review</span><strong>${esc(label(m.moderationStatus || 'clear'))}</strong></div><div><span>Deadline</span><strong>${esc(date(m.deadline))}</strong></div><div><span>Recorded matter amount</span><strong>${esc(money(m.lockedTotalAmount ?? m.totalAmount, m.currency || 'USD'))}</strong></div></div>
 <div class="admin-inline-actions"><button class="btn secondary" data-matter-finance="${id}" type="button">Check payment</button><button class="btn secondary" data-matter-moderation type="button">Posting moderation</button></div>
 <div class="admin-tabs" role="group" aria-label="Matter detail"><button type="button" data-matter-tab="overview" aria-pressed="true">Overview</button><button type="button" data-matter-tab="work" aria-pressed="false">Work</button><button type="button" data-matter-tab="support" aria-pressed="false">Support</button><button type="button" data-matter-tab="financials" aria-pressed="false">Financials</button><button type="button" data-matter-tab="activity" aria-pressed="false">Activity</button></div>
 <div data-matter-panel="overview"><details class="admin-detail-fold"><summary>Reference</summary><code>${esc(m.id)}</code></details><h3>Scope</h3><p class="admin-preserve-text">${esc(m.description || 'No scope summary available.')}</p><p>Created ${esc(date(m.createdAt))} · Updated ${esc(date(m.updatedAt))}</p><p>Archive: ${m.archived ? 'Archived' : 'Not archived'} · Withdrawal/termination: ${esc(label(m.terminationStatus || 'none'))}${m.relistRequestedAt ? ` · Relisting requested ${esc(date(m.relistRequestedAt))}` : ''}</p></div>
 <div data-matter-panel="work" hidden><h3>Shared tasks</h3>${m.tasks.length ? `<ul>${m.tasks.map(t => `<li>${esc(t.title || 'Task')} · ${esc(t.status || (t.completed || t.completedAt ? 'completed' : 'pending'))}</li>`).join('')}</ul>` : '<p>No shared tasks recorded.</p>'}<h3>File review</h3>${data.files.length ? `<ul>${data.files.map(f => `<li>${esc(label(f._id))}: ${f.count}</li>`).join('')}</ul>` : '<p>No files recorded.</p>'}</div>
 <div data-matter-panel="support" hidden><h3>Recent linked inquiries</h3>${data.tickets.length ? data.tickets.map(t => `<p><button class="btn-link" data-matter-ticket="${esc(t._id)}">${esc(t.subject)}</button> · ${esc(label(t.status))}</p>`).join('') : '<p>No linked inquiries.</p>'}</div>
 <div data-matter-panel="financials" hidden><h3>${esc(stateLabel(data.financial?.balance?.status))}</h3><dl class="admin-facts"><div><dt>Remaining principal</dt><dd>${esc(money(unitAmount(data.financial?.held, data.financial?.balance?.currency, data.financial?.balance?.stripeMode), data.financial?.balance?.currency))}</dd></div><div><dt>Platform fees recorded</dt><dd>${esc(money(unitAmount(data.financial?.incomeTotals, data.financial?.balance?.currency, data.financial?.balance?.stripeMode), data.financial?.balance?.currency))}</dd></div></dl><h3>Payout records</h3>${data.payouts.length ? data.payouts.map(p => `<p>${esc(p.amount === null ? stateLabel(p.state) : money(p.amount, p.currency))} · ${esc(p.paralegalName || 'Name unavailable')} · ${esc(date(p.recordedAt))} · ${esc(providerLabel(p.stripeMode))}</p>`).join('') : '<p>No payout records.</p>'}</div>
 <div data-matter-panel="activity" hidden><h3>Recent administrative activity</h3>${data.activity.length ? data.activity.map(a => `<p>${esc(label(a.action))} · ${esc(date(a.createdAt))}</p>`).join('') : '<p>No administrative events recorded.</p>'}<button class="btn secondary" data-matter-audit type="button">Open full activity log</button></div>`;
    window.enrichAdminMatter?.(data, root);
    el('section-matters').classList.add('admin-matter-selected');
    document.dispatchEvent(new CustomEvent('admin:matter-selected',{detail:{id,title:m.title}}));
    root.focus({preventScroll:true});
    root.scrollIntoView({
      block: 'start',
      behavior: 'smooth'
    });
  } catch (e) {
    if (seq !== detailSequence) return;
    root.innerHTML = `<p role="alert">${esc(e.message)}</p><button class="btn secondary" data-admin-matter="${esc(id)}">Try again</button>`;
  }
}
window.addEventListener('admin:financial-source-changed', () => { detailSequence++; const panel = el('adminMatterDetail')?.querySelector('[data-matter-panel=financials]'); if (panel) panel.textContent = 'Financial records changed. Refresh the Matter before continuing.'; });
window.addEventListener('admin:financial-account-changed', () => { detailSequence++; const root = el('adminMatterDetail'); if (root) { root.replaceChildren(); root.hidden = true; } });
function init() {
  usersLayout();
  financeLayout();
  document.addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-admin-review')) {
      b.disabled = true;
      Promise.resolve(window.reviewAdminApplicant?.(b.dataset.adminReview)).catch(e => window.toastUtils?.show(e.message, {
        targetId: 'toastBanner',
        type: 'err'
      })).finally(() => b.disabled = false);
    }
    if (b.hasAttribute('data-admin-open-users')) window.showAdminUsers('applications');
    if (b.hasAttribute('data-admin-inbox')) window.openAdminInbox?.(b.dataset.adminInbox);
    if (b.hasAttribute('data-admin-knowledge')) window.activateAdminSection?.('knowledge-studio');
    if (b.hasAttribute('data-admin-matter')) void openMatter(b.dataset.adminMatter);
    if (b.hasAttribute('data-close-matter')) {
      detailSequence++;
      el('adminMatterDetail').hidden = true;
      el('section-matters').classList.remove('admin-matter-selected');
      routeParam('matter', '');
      const row=[...el('adminMatterList').querySelectorAll('[data-admin-matter]')].find(item=>item.dataset.adminMatter===el('adminMatterDetail').dataset.matterId);
      (row||el('adminMatterSearch')).focus();
    }
    if (b.hasAttribute('data-matter-finance')) window.openAdminFinance(b.dataset.matterFinance);
    if (b.hasAttribute('data-matter-ticket')) window.openSupportTicketInAdmin?.(b.dataset.matterTicket);
    if (b.hasAttribute('data-matter-audit')) {
      window.activateAdminSection?.('activity-logs');
      el('auditSearch').value = new URL(location.href).searchParams.get('matter') || '';
      el('auditSearch').dispatchEvent(new Event('input'));
    }
    if (b.dataset.matterTab) {
      el('adminMatterDetail').querySelectorAll('[data-matter-panel]').forEach(p => p.hidden = p.dataset.matterPanel !== b.dataset.matterTab);
      el('adminMatterDetail').querySelectorAll('[data-matter-tab]').forEach(p => p.setAttribute('aria-pressed', String(p === b)));
    }
  });
  replaceEventHandler(el('adminHomeRefresh'), 'click', refreshHome);
  addEventListener('admin:inbox-changed', refreshHome);
  addEventListener('admin:admissions-changed', refreshHome);
  setInterval(() => {
    if (!document.hidden) void refreshHome();
  }, 15000);
  void refreshHome();
  replaceEventHandler(el('adminMatterRefresh'), 'click', loadMatters);
  replaceEventHandler(el('adminMatterSearch'), 'input', debounce(() => {
    matterPage = 1;
    routeParam('matterUser', '');
    void loadMatters();
  }));
  replaceEventHandler(el('adminMatterFilter'), 'change', () => {
    matterPage = 1;
    void loadMatters();
  });
  replaceEventHandler(el('adminMatterPrev'), 'click', () => {
    matterPage--;
    void loadMatters();
  });
  replaceEventHandler(el('adminMatterNext'), 'click', () => {
    matterPage++;
    void loadMatters();
  });
  window.openAdminMatter = openMatter;
  let wasVisible = false;
  new MutationObserver(() => {
    const now = visible('matters');
    if (now && !wasVisible) {
      void loadMatters();
      const id = new URL(location.href).searchParams.get('matter');
      if (id) void openMatter(id);
    }
    wasVisible = now;
  }).observe(el('section-matters'), {
    attributes: true,
    attributeFilter: ['class']
  });
  if (visible('matters')) {
    void loadMatters();
    const id = new URL(location.href).searchParams.get('matter');
    if (id) void openMatter(id);
  }
  // Reuse the existing user modal while linking it into the operational workspaces.
  const modal = el('pendingUserModal');
  const links = document.createElement('div');
  links.className = 'admin-inline-actions';
  links.innerHTML = '<button class="btn secondary" type="button" id="adminAccountMatters">View matters</button><button class="btn secondary" type="button" id="adminAccountSupport">Find inquiries</button>';
  modal.querySelector('.details-content').append(links);
  replaceEventHandler(el('adminAccountMatters'), 'click', () => {
    const id = modal.dataset.adminAccountId;
    if (!id) return;
    modal.querySelector('#closePendingModal')?.click();
    window.activateAdminSection?.('matters');
    routeParam('matterUser', id);
    matterPage = 1;
    void loadMatters();
  });
  replaceEventHandler(el('adminAccountSupport'), 'click', () => {
    modal.querySelector('#closePendingModal')?.click();
    window.openAdminInbox?.('all');
    el('adminInboxSearch').value = modal.dataset.adminAccountEmail || '';
    el('adminInboxSearch').dispatchEvent(new Event('input'));
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
