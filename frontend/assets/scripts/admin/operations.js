import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api, escapeHTML as esc, date, label, person, debounce } from './shared.js';
import { confirmAction, promptForText } from '../utils/dialogs.js';
const el = id => document.getElementById(id);
function fold(node, title) {
  if (!node) return;
  const details = document.createElement('details');
  details.className = 'admin-detail-fold';
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.append(summary);
  node.before(details);
  details.append(node);
  return details;
}
function init() {
  const search = document.createElement('details');
  search.className = 'panel admin-global-search';
  search.innerHTML = '<summary>Search all admin records</summary><label for="adminGlobalSearch">Name, email, matter, inquiry reference, or payment reference</label><input id="adminGlobalSearch" type="search" class="search" maxlength="200"><div id="adminGlobalResults" role="status"></div>';
  el('main').prepend(search);
  let searchSequence = 0;
  const clearSearch = () => { searchSequence++; el('adminGlobalResults').replaceChildren(); };
  window.addEventListener('admin:financial-account-changed', clearSearch);
  window.addEventListener('admin:financial-source-changed', clearSearch);
  const searchRecords = debounce(async () => {
    const seq = ++searchSequence,
      q = el('adminGlobalSearch').value.trim();
    if (q.length < 2) {
      el('adminGlobalResults').textContent = 'Enter at least two characters.';
      return;
    }
    el('adminGlobalResults').textContent = 'Searching…';
    try {
      const data = await api(`/api/admin/workspace/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSequence) return;
      const groups = [['Accounts', data.users, 'account', u => `${person(u)} · ${u.email} · ${label(u.status)}`], ['Matters', data.matters, 'matter', m => `${m.title} · ${label(m.status)}`], ['Inquiries', data.tickets, 'ticket', t => `${t.reference} · ${t.subject}`], ['Payment operations', data.payments, 'payment', p => `${p.title || p.operationKind} · ${p.reference || p.id}`]];
      el('adminGlobalResults').innerHTML = groups.map(([title, items, kind, text]) => `<section><h3>${title}</h3>${items.length ? items.map(item => `<p><button class="btn-link" type="button" data-global-kind="${kind}" data-global-id="${esc(kind === 'payment' ? item.caseId || '' : item.id || item._id)}">${esc(text(item))}</button></p>`).join('') : '<p>No matches.</p>'}</section>`).join('') + '<p class="small">Up to eight matches per source. Use the workspace filters for the complete list.</p>';
    } catch (e) {
      if (seq === searchSequence) el('adminGlobalResults').textContent = e.message;
    }
  });
  replaceEventHandler(el('adminGlobalSearch'), 'input', () => { clearSearch(); searchRecords(); });
  replaceEventHandler(el('adminGlobalResults'), 'click', async e => {
    const b = e.target.closest('[data-global-kind]');
    if (!b) return;
    search.open = false;
    document.getElementById('adminSearchDialog')?.close();
    const id = b.dataset.globalId;
    try {
      if (b.dataset.globalKind === 'account') await window.reviewAdminApplicant(id);
      if (b.dataset.globalKind === 'matter') await window.openAdminMatter(id);
      if (b.dataset.globalKind === 'ticket') await window.openSupportTicketInAdmin(id);
      if (b.dataset.globalKind === 'payment') window.openAdminFinance(id);
    } catch (error) {
      window.toastUtils?.show(error.message,{targetId:'toastBanner',type:'err'});
    }
  });
  const attention = document.createElement('div');
  attention.className = 'panel';
  attention.id = 'adminOperationalAttention';
  attention.innerHTML = '<h2>Matter &amp; money exceptions</h2><div id="adminAttentionItems" class="admin-inline-actions"></div><p id="adminAttentionStatus" class="small" role="status"></p>';
  el('healthBanner').before(attention);
  async function refresh() {
    const results = await Promise.allSettled([api('/api/admin/workspace/attention'), api('/api/admin/support/inbox-summary')]);
    const target = el('adminAttentionItems');
    target.innerHTML = '';
    if (results[0].status === 'fulfilled') {
      const a = results[0].value;
      const add = (text, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn secondary';
        b.textContent = text;
        replaceEventHandler(b, 'click', fn);
        target.append(b);
      };
      if(a.money) add(`${a.money} failed / uncertain payment operations`, () => {
        window.openAdminFinancialRecords('operations');
        el('adminFinanceStatus').value = 'exceptions';
        el('adminFinanceStatus').dispatchEvent(new Event('change'));
      });
      if(a.chargebacks) add(`${a.chargebacks} chargebacks needing review`, () => {
        window.openAdminFinance();
        window.showAdminExceptions('chargebacks');
      });
      for (const [key, title] of [['overdue', 'overdue matters'], ['stalled', 'workflow exceptions']]) if(a[key]) add(`${a[key]} ${title}`, () => {
        window.activateAdminSection('matters');
        el('adminMatterFilter').value = key;
        el('adminMatterFilter').dispatchEvent(new Event('change'));
      });
      el('adminAttentionStatus').textContent = `Recorded queues checked ${date(a.checkedAt)}. Provider reconciliation remains in Finance.`;
    } else el('adminAttentionStatus').textContent = 'Matter and money counts are unavailable. Refresh to retry.';
    if (results[1].status === 'fulfilled' && results[1].value.overdue) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn secondary';
      b.textContent = `${results[1].value.overdue} overdue inquiry follow-ups`;
      replaceEventHandler(b, 'click', () => {
        window.openAdminInbox('all');
        el('adminInboxFollowUp').value = 'overdue';
        el('adminInboxFollowUp').dispatchEvent(new Event('change'));
      });
      target.append(b);
    }
    if(results.every(r=>r.status==='fulfilled')&&!target.children.length) target.textContent='No current items in these recorded exception queues.';
  }
  el('adminHomeRefresh').addEventListener('click', refresh);
  addEventListener('admin:inbox-changed', refresh);
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 30000);
  const auditControls = el('auditSearch').parentElement;
  for (const [id, title] of [['adminAuditFrom', 'From (UTC)'], ['adminAuditTo', 'Through (UTC)']]) {
    const field = document.createElement('label');
    field.textContent = title;
    const input = document.createElement('input');
    input.id = id;
    input.type = 'date';
    replaceEventHandler(input, 'change', () => el('refreshAuditLogs')?.click());
    field.append(input);
    auditControls.append(field);
  }
  // Preserve canonical controls while bringing the actual queue ahead of settings and reporting.
  fold(el('section-posts').querySelector('.dashboard-grid'), 'Posting reports');
  const marketing = el('section-marketing-drafts');
  fold(marketing.querySelector('.founder-layer-grid'), 'Daily marketing summary');
  fold(el('marketingFounderReadyPosts')?.closest('.workspace-stack'), 'Ready posts summary');
  fold(marketing.querySelector('.grid-four'), 'Marketing counts');
  fold(el('marketingPublishingSettingsForm')?.closest('.workspace-grid'), 'Posting settings & scheduling');
  fold(el('marketingBriefForm')?.closest('.panel'), 'Create a marketing brief');
  fold(el('marketingCycleDetail')?.closest('.workspace-stack'),'Selected publishing batch');
  fold(el('marketingJrCmoLibrary')?.closest('.workspace-stack'),'Research notes');
  marketing.querySelectorAll('.workspace-step-label').forEach(n=>n.textContent=n.textContent.replace(/^\d+\.\s*/,''));
  const revealBatch=()=>{const detail=el('marketingCycleDetail');if(detail?.querySelector('button,a,textarea'))detail.closest('details').open=true;};new MutationObserver(revealBatch).observe(el('marketingCycleDetail'),{childList:true,subtree:true});
  const queue = el('marketingPacketList')?.closest('.panel');
  if (queue) marketing.querySelector('header').after(queue);
  const detail = el('marketingPacketDetail')?.closest('.workspace-stack');
  if (detail && queue) queue.after(detail);
  const showSelected = () => {
    if (detail) detail.hidden = !el('marketingPacketDetail').querySelector('button,textarea,a');
  };
  new MutationObserver(showSelected).observe(el('marketingPacketDetail'), {
    childList: true,
    subtree: true
  });
  showSelected();
  el('marketingFounderOpenQueueBtn')?.addEventListener('click', () => queue?.scrollIntoView({
    block: 'start'
  }));
  fold(el('section-engineering').querySelector('.grid-four'), 'Engineering summary');
  const security = document.createElement('a');
  security.className = 'btn secondary';
  security.href = 'profile-settings.html#security';
  security.textContent = 'My account & security';
  el('section-activity-logs').querySelector('h1').after(security);
}
window.enrichAdminMatter = (data, root) => {
  const m = data.matter,
    w = m.workflow || {};
  const overview = root.querySelector('[data-matter-panel="overview"]');
  const lifecycle = document.createElement('div');
  lifecycle.innerHTML = `<h3>Engagement history</h3><p>Pre-engagement: ${esc(label(w.preEngagement?.status || 'not started'))}</p>${(data.timeline || []).map(t => `<p>${esc(t.label)} · ${esc(date(t.at))}</p>`).join('')}${(w.withdrawals || []).map(h => `<p>Withdrawal: ${esc(h.paralegalName || 'Paralegal')} · ${esc(date(h.pausedAt))} · Settlement ${esc(label(h.payoutType || 'not finalized'))}</p>`).join('')}`;
  overview.append(lifecycle);
  const moderation = document.createElement('details');
  moderation.className = 'admin-detail-fold';
  moderation.innerHTML = `<summary>Posting moderation · ${esc(label(m.moderationStatus || 'clear'))}</summary>${(m.flags || []).map(f => `<p>${esc(f.reason)} · ${esc(date(f.createdAt))}<br>${esc(f.details)}</p>`).join('') || '<p>No reports recorded.</p>'}<div class="admin-inline-actions"><button type="button" class="btn secondary" data-moderate="request-edits">Request posting edits</button>${m.flagCount ? '<button type="button" class="btn secondary" data-moderate="resolve">Resolve reports</button>' : ''}</div><p role="status" data-moderation-result></p>`;
  overview.append(moderation);
  replaceEventHandler(root.querySelector('[data-matter-moderation]'), 'click', e => {
    e.stopPropagation();
    root.querySelector('[data-matter-tab="overview"]').click();
    moderation.open = true;
    moderation.scrollIntoView({
      block: 'center'
    });
  });
  replaceEventHandler(moderation, 'click', async e => {
    const b = e.target.closest('[data-moderate]');
    if (!b) return;
    const resolve = b.dataset.moderate === 'resolve';
    const text = await promptForText(resolve ? 'Record why these reports can be cleared.' : 'Explain which posting details the attorney needs to change.', {
      title: resolve ? 'Resolve posting reports' : 'Request posting edits',
      confirmLabel: 'Review action',
      required: true,
      maxLength: resolve ? 1000 : 2000
    });
    if (!text) return;
    if (!(await confirmAction(`${resolve ? 'Clear the reports on' : 'Request edits to'} “${m.title}”?\n\n${text}`, {
      confirmLabel: resolve ? 'Resolve reports' : 'Send edit request'
    }))) return;
    b.disabled = true;
    try {
      await api(`/api/cases/${m.id}/flags/${resolve ? 'resolve' : 'request-edits'}`, {
        method: 'POST',
        body: resolve ? {
          note: text
        } : {
          message: text
        }
      });
      await window.openAdminMatter(m.id);
    } catch (error) {
      moderation.querySelector('[data-moderation-result]').textContent = error.message;
    } finally {
      b.disabled = false;
    }
  });
  const work = root.querySelector('[data-matter-panel="work"]');
  work.insertAdjacentHTML('beforeend', '<div class="admin-tabs" role="group" aria-label="Matter records"><button type="button" data-record-type="applications">Applications</button><button type="button" data-record-type="files" aria-pressed="true">Files &amp; submissions</button><button type="button" data-record-type="deadlines">Shared deadlines</button></div><div id="adminMatterRecords"></div>');
  let seq = 0,
    type = 'files',
    page = 1;
  const load = async () => {
    const request = ++seq;
    const target = work.querySelector('#adminMatterRecords');
    target.innerHTML = '<p role="status">Loading records…</p>';
    try {
      const result = await api(`/api/admin/workspace/matters/${m.id}/records?${new URLSearchParams({
        type,
        page
      })}`);
      if (seq !== request || !root.isConnected) return;
      const description = item => type === 'applications' ? `${person(item.paralegalId)} · ${label(item.status)} · ${date(item.createdAt)}` : type === 'files' ? `${item.originalName} · version ${item.version} · ${label(item.status)} · scan ${label(item.securityStatus)} · ${date(item.updatedAt)}` : `${item.title} · ${date(item.start)} · ${label(item.visibility)}`;
      target.innerHTML = `<p>${result.total} records · page ${page} of ${Math.max(1, result.pages)}</p>${result.items.length ? result.items.map(item => `<article class="admin-message">${esc(description(item))}${type === 'applications' && item.paralegalId?._id ? ` <button type="button" class="btn-link" data-admin-review="${esc(item.paralegalId._id)}">Open account</button>` : ''}</article>`).join('') : '<p>No records in this view.</p>'}${type === 'applications' && result.legacyApplicants.length ? `<details class="admin-detail-fold"><summary>Embedded application history (${result.legacyApplicants.length})</summary><p class="small">Earlier posting records may overlap the application records above.</p>${result.legacyApplicants.map(a => `<p><button type="button" class="btn-link" data-admin-review="${esc(a.paralegalId)}">Open applicant</button> · ${esc(label(a.status))} · ${esc(date(a.appliedAt))}</p>`).join('')}</details>` : ''}<div class="admin-pager"><button type="button" class="btn secondary" data-record-prev ${page <= 1 ? 'disabled' : ''}>Previous</button><button type="button" class="btn secondary" data-record-next ${page >= result.pages ? 'disabled' : ''}>Next</button></div>`;
      replaceEventHandler(target.querySelector('[data-record-prev]'), 'click', () => {
        page--;
        void load();
      });
      replaceEventHandler(target.querySelector('[data-record-next]'), 'click', () => {
        page++;
        void load();
      });
    } catch (e) {
      target.innerHTML = `<p role="alert">${esc(e.message)}</p><button class="btn secondary" type="button" data-record-retry>Retry</button>`;
      replaceEventHandler(target.querySelector('[data-record-retry]'), 'click', load);
    }
  };
  work.querySelectorAll('[data-record-type]').forEach(b => replaceEventHandler(b, 'click', () => {
    type = b.dataset.recordType;
    page = 1;
    work.querySelectorAll('[data-record-type]').forEach(t => t.setAttribute('aria-pressed', String(t === b)));
    void load();
  }));
  void load();
  const support = root.querySelector('[data-matter-panel="support"]');
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'btn secondary';
  all.textContent = 'Find all linked inquiries';
  replaceEventHandler(all, 'click', () => {
    window.openAdminInbox('all');
    el('adminInboxSearch').value = m.id;
    el('adminInboxSearch').dispatchEvent(new Event('input'));
  });
  support.append(all);
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
