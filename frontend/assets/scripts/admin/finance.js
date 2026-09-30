import { commissionMoney, commissionPaymentLabel } from '../utils/director-financials.mjs';
import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { money, stateLabel, providerLabel, downloadFinancialExport } from './financial-read.js';
import { api, escapeHTML as esc, date, label, person, debounce, routeParam } from './shared.js';
const el = id => document.getElementById(id);
function recordSubtitle(row) {
  const context = String(row.kind === 'commissions' ? row.attorneyEmail || '' : row.directorEmail || (row.operationKind ? label(row.operationKind) : '')).trim();
  const title = String(row.title || (row.caseId ? row.caseId : row.operationKind || label(row.kind))).trim();
  return context && context.toLowerCase() !== title.toLowerCase() ? `<small>${esc(context)}</small>` : '';
}
let page = 1,
  pages = 1,
  sequence = 0;
function pager(id) {
  const node = document.createElement('div');
  node.className = 'admin-pager';
  node.id = id;
  node.innerHTML = '<button type="button" class="btn secondary" data-prev>Previous</button><span role="status"></span><button type="button" class="btn secondary" data-next>Next</button>';
  return node;
}
function bindPager(node, total, current, max, fn, { showTotal = true } = {}) {
  node.querySelector('span').textContent = showTotal ? `${total} ${total === 1 ? 'record' : 'records'} · page ${current} of ${Math.max(1, max)}` : `Page ${current} of ${Math.max(1, max)}`;
  node.querySelector('[data-prev]').disabled = current <= 1;
  node.querySelector('[data-next]').disabled = current >= max;
  replaceEventHandler(node.querySelector('[data-prev]'), 'click', () => fn(current - 1));
  replaceEventHandler(node.querySelector('[data-next]'), 'click', () => fn(current + 1));
}
function init() {
  const revenue = el('section-revenue');
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'adminFinanceRecords';
  panel.innerHTML = `<h2>Payments</h2><div class="admin-tabs" role="group" aria-label="Financial record source"><button type="button" data-finance-kind="operations" aria-pressed="true">Payments</button><button type="button" data-finance-kind="payouts">Payouts</button><button type="button" data-finance-kind="pending">Awaiting payout</button><button type="button" data-finance-kind="income">Platform income</button><button type="button" data-finance-kind="commissions">Commissions</button></div><div class="pending-controls"><input id="adminFinanceSearch" class="search" type="search" placeholder="Search records" aria-label="Search matter, person, payment reference, or ID"><select id="adminFinanceStatus" aria-label="Payment status"><option value="all">All statuses</option><option value="exceptions">Needs attention</option><option value="pending">Pending</option><option value="needs_reconciliation">Needs checking</option><option value="failed">Failed</option><option value="succeeded">Succeeded</option><option value="paid">Paid</option><option value="reversed">Reversed</option></select></div><div class="admin-inline-actions"><label>From (UTC)<input id="adminFinanceFrom" type="date"></label><label>Through (UTC)<input id="adminFinanceTo" type="date"></label><button type="button" class="btn secondary" id="adminFinanceApply">Apply filters</button><button type="button" class="btn secondary" id="adminFinanceExport" disabled>Export records</button></div><p id="adminFinanceRecordStatus" role="status"></p><div id="adminFinanceRecordList"></div>`;
  const reports = document.createElement('details');
  reports.className = 'admin-detail-fold';
  reports.innerHTML = '<summary>Totals, activity &amp; receipts</summary>';
  Array.from(revenue.children).filter(c => c.tagName !== 'HEADER').forEach(c => reports.append(c));
  revenue.append(panel, reports);
  const recordPager = pager('adminFinanceRecordPager');
  recordPager.setAttribute('role', 'navigation');
  recordPager.setAttribute('aria-label', 'Financial record pages');
  panel.append(recordPager);
  let kind = 'operations', revision = null, exportUrl = null, filterKey = null, pagerFocus = null;
  const setRecordStatus = text => { el('adminFinanceRecordStatus').textContent = text; };
  const clearRecordPager = () => {
    recordPager.hidden = true;
    recordPager.querySelector('span').textContent = '';
    for (const control of recordPager.querySelectorAll('button')) { control.disabled = true; replaceEventHandler(control, 'click', null); }
  };
  const restorePagerFocus = () => {
    const direction = pagerFocus; pagerFocus = null;
    if (!direction || ![document.body, document.documentElement, revenue.closest('main, .main'), ...recordPager.querySelectorAll('button')].includes(document.activeElement)) return;
    const requested = recordPager.querySelector(`[data-${direction}]`);
    const target = recordPager.hidden ? el('adminFinanceApply') : !requested.disabled ? requested : recordPager.querySelector('button:not(:disabled)');
    target?.focus({ preventScroll: true });
  };
  clearRecordPager(); setRecordStatus('');
  const invalidate = () => {
    const hadPagerFocus = recordPager.contains(document.activeElement);
    sequence++; revision = null; exportUrl = null; pagerFocus = null;
    el('adminFinanceExport').disabled = true; el('adminFinanceRecordList').replaceChildren(); clearRecordPager(); setRecordStatus('');
    el('adminFinanceApply').textContent = 'Apply filters';
    if (hadPagerFocus) el('adminFinanceApply').focus({ preventScroll: true });
  };
  window.addEventListener('admin:financial-account-changed', () => { invalidate(); setRecordStatus('The signed-in account changed. Refresh before continuing.'); });
  window.addEventListener('admin:financial-source-changed', () => { invalidate(); setRecordStatus('Financial records changed. Refresh before continuing.'); });
  const params = () => new URLSearchParams({
    kind,
    page,
    q: el('adminFinanceSearch').value,
    status: el('adminFinanceStatus').value,
    from: el('adminFinanceFrom').value,
    to: el('adminFinanceTo').value
  });
  const load = async (returnToPager = null) => {
    pagerFocus = returnToPager;
    const seq = ++sequence;
    setRecordStatus('Loading financial records…');
    el('adminFinanceApply').textContent = 'Apply filters';
    el('adminFinanceExport').disabled = true; exportUrl = null;
    clearRecordPager();
    el('adminFinanceRecordList').replaceChildren();
    try {
      const query = params(), key = new URLSearchParams(query); key.delete('page');
      if (key.toString() !== filterKey || page === 1) revision = null;
      filterKey = key.toString();
      if (revision) query.set('revision', revision);
      const data = await api(`/api/admin/workspace/finance/records?${query}`);
      if (seq !== sequence) return;
      if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || !Number.isSafeInteger(data.pages)) throw new Error('The financial record response could not be verified.');
      revision = data.revision;
      pages = Math.max(1, data.pages);
      if (page > pages) {
        page = pages;
        return load(pagerFocus);
      }
      el('adminFinanceStatus').disabled = !['operations', 'payouts'].includes(kind);
      setRecordStatus(data.total ? `${data.total} matching ${data.total === 1 ? 'record' : 'records'}${kind === 'pending' ? ' · Unreleased completed matters' : ''}` : 'No records match these filters.');
      query.set('revision', revision); query.set('expectedOwnerId', data.ownerId);
      exportUrl = `/api/admin/workspace/finance/export?${query}`;
      el('adminFinanceExport').disabled = false;
      el('adminFinanceRecordList').innerHTML = data.items.length ? `<p class="admin-table-scroll-hint">Scroll for all columns.</p><div class="table-wrap" tabindex="0" role="region" aria-label="Financial records columns"><table class="admin-matters-table" data-financial-source="${esc(kind)}"><thead><tr><th>${kind === 'commissions' ? 'Referral created' : 'Date'}</th><th>${kind === 'commissions' ? 'Attorney' : 'Matter / source'}</th>${kind === 'commissions' ? '<th>Director</th>' : ''}<th>Status</th><th>${kind === 'commissions' ? 'Outstanding' : 'Amount'}</th><th>Review</th></tr></thead><tbody>${data.items.map(r => `<tr><td>${esc(date(r.createdAt))}</td><td>${r.caseId ? `<button type="button" class="btn-link" data-finance-matter="${esc(r.caseId)}">${esc(r.title || 'Untitled matter')}</button>` : esc(r.title || r.operationKind || label(r.kind))}${recordSubtitle(r)}</td>${r.kind === 'commissions' ? `<td>${esc(r.directorEmail)}</td>` : ''}<td>${esc(r.kind === 'commissions' ? commissionPaymentLabel({ commissionPayments: { state: r.status } }) : stateLabel(r.state))}${r.details ? `<small>${esc(r.details)}</small>` : ''}</td><td>${esc(r.kind === 'commissions' ? commissionMoney(r.amount, r.currency, r.stripeMode, '—') : r.amount === null ? '—' : money(r.amount, r.currency))}${r.kind === 'commissions' ? '' : `<small>${esc(r.amount === null && r.requestedAmount !== null && r.currency ? `${money(r.requestedAmount, r.currency)} requested` : label(r.basis))}</small>`}</td><td>${r.kind === 'commissions' ? `<a href="admin-directors.html?record=${encodeURIComponent(r.recordId)}">Review director commission</a>` : r.caseId ? `<button type="button" class="btn secondary" data-finance-reconcile="${esc(r.caseId)}">Check payment</button>` : ''}${r.kind === 'commissions' ? '' : `<details class="admin-record-reference"><summary>Reference</summary><code>${esc(r.reference || r.id)}</code></details>${r.stripeMode ? `<small>${esc(providerLabel(r.stripeMode))}</small>` : ''}`}</td></tr>`).join('')}</tbody></table></div>` : '';
      bindPager(recordPager, data.total, page, pages, next => {
        const direction = next > page ? 'next' : 'prev';
        page = next;
        void load(direction);
      }, { showTotal: false });
      recordPager.hidden = pages <= 1 || !data.items.length;
    } catch (e) {
      if (seq !== sequence) return;
      revision = null; exportUrl = null;
      setRecordStatus(e.message);
      el('adminFinanceRecordList').replaceChildren();
      el('adminFinanceApply').textContent = 'Try again';
    } finally { if (seq === sequence) restorePagerFocus(); }
  };
  panel.querySelectorAll('[data-finance-kind]').forEach(b => replaceEventHandler(b, 'click', () => {
    kind = b.dataset.financeKind;
    page = 1;
    panel.querySelectorAll('[data-finance-kind]').forEach(t => t.setAttribute('aria-pressed', String(t === b)));
    void load();
  }));
  const debouncedLoad = debounce(() => { page = 1; void load(); });
  replaceEventHandler(el('adminFinanceSearch'), 'input', () => { invalidate(); debouncedLoad(); });
  for (const id of ['adminFinanceFrom', 'adminFinanceTo']) replaceEventHandler(el(id), 'input', () => { invalidate(); setRecordStatus('Apply filters to update records.'); });
  replaceEventHandler(el('adminFinanceExport'), 'click', async () => {
    if (!exportUrl) return;
    const seq = sequence, target = exportUrl;
    el('adminFinanceExport').disabled = true;
    setRecordStatus('Preparing export…');
    try { await downloadFinancialExport(target, { isCurrent: () => seq === sequence && target === exportUrl }); if (seq === sequence) setRecordStatus('Download requested. Check your browser’s downloads.'); }
    catch (error) { if (seq === sequence) { invalidate(); setRecordStatus(error.message); } }
    finally { if (seq === sequence) el('adminFinanceExport').disabled = !exportUrl; }
  });
  replaceEventHandler(el('adminFinanceApply'), 'click', () => {
    page = 1;
    void load();
  });
  replaceEventHandler(el('adminFinanceStatus'), 'change', () => {
    page = 1;
    void load();
  });
  panel.addEventListener('click', event => {
    const matter = event.target.closest('[data-finance-matter]'),
      reconcile = event.target.closest('[data-finance-reconcile]');
    if (matter) window.openAdminMatter(matter.dataset.financeMatter);
    if (reconcile) window.openAdminFinance(reconcile.dataset.financeReconcile);
  });
  window.openAdminFinancialRecords = (source = 'operations') => {
    window.activateAdminSection('finance');
    window.showAdminFinance('reporting');
    kind = source;
    page = 1;
    panel.querySelectorAll('[data-finance-kind]').forEach(t => t.setAttribute('aria-pressed', String(t.dataset.financeKind === kind)));
    void load();
  };
  new MutationObserver(() => {
    if (revenue.classList.contains('visible') && !revenue.hidden) void load();
    else invalidate();
  }).observe(revenue, {
    attributes: true,
    attributeFilter: ['class', 'hidden']
  });
  const linkedReviewNotice = document.createElement('div');
  linkedReviewNotice.className = 'admin-inline-actions';
  linkedReviewNotice.hidden = !new URL(location.href).searchParams.has('review');
  linkedReviewNotice.innerHTML = '<p data-linked-review-status>Showing the review linked from your notice.</p><button type="button" class="btn secondary" data-linked-review-clear>Return to review queue</button>';
  el('disputesBody').closest('.table-wrap').before(linkedReviewNotice);
  replaceEventHandler(linkedReviewNotice.querySelector('button'), 'click', () => {
    routeParam('review', ''); routeParam('reviewMatter', ''); routeParam('dispute', ''); linkedReviewNotice.hidden = true;
    window.adminDisputePage = 1; window.loadDisputes();
  });
  const disputePager = pager('adminDisputePager');
  el('disputesBody').closest('.table-wrap')?.after(disputePager);
  if (!disputePager.isConnected) el('disputesBody').closest('table').after(disputePager);
  const refreshDisputes = next => {
    window.adminDisputePage = next;
    window.loadDisputes();
  };
  el('disputeSearch').addEventListener('input', () => {
    window.adminDisputePage = 1;
  });
  document.querySelectorAll('[data-dispute-tab]').forEach(b => b.addEventListener('click', () => {
    window.adminDisputePage = 1;
  }, true));
  window.adminDisputesRendered = (items, payload, status) => {
    if (!linkedReviewNotice.hidden) linkedReviewNotice.querySelector('[data-linked-review-status]').textContent = items.length ? 'Showing the review linked from your notice.' : 'The linked review could not be found.';
    bindPager(disputePager, payload.total || 0, payload.page || 1, payload.pages || 1, refreshDisputes);
    const body = el('disputesBody');
    const table = body.closest('table');
    table.classList.add('admin-dispute-table');
    table.setAttribute('role', 'table');
    table.querySelector('thead').setAttribute('role', 'rowgroup');
    body.setAttribute('role', 'rowgroup');
    const summaryLabels = ['Matter', 'Attorney', 'Paralegal', 'Status', 'Created'];
    const rows = Array.from(body.querySelectorAll('tr[data-dispute-id]'));
    rows.forEach(row => {
      const item = items.find(i => String(i.dispute?.disputeId || i.dispute?._id) === row.dataset.disputeId);
      if (!item) return;
      const cells = Array.from(row.children),
        detail = document.createElement('tr'),
        cell = document.createElement('td');
      cell.colSpan = cells.length;
      detail.className = 'admin-dispute-detail';
      detail.hidden = true;
      detail.setAttribute('role', 'row'); cell.setAttribute('role', 'cell');
      Object.assign(detail.dataset, row.dataset);
      const id = String(item.dispute?.disputeId || item.dispute?._id);
      const section = document.createElement('section');
      const disputeMessage = String(item.dispute?.message || '').trim();
      const showDisputeMessage = disputeMessage && !/^Dispute flagged from the case workspace\.?$/i.test(disputeMessage);
      section.innerHTML = `<h3>${esc(item.caseTitle)}</h3><p>${esc(person(item.attorney))} · ${esc(person(item.paralegal))}</p><p>Created ${esc(date(item.dispute?.createdAt))}${item.disputeDeadlineAt ? ` · Review deadline ${esc(date(item.disputeDeadlineAt))}` : ''}</p>${showDisputeMessage ? `<p class="admin-preserve-text">${esc(disputeMessage)}</p>` : ''}<div class="admin-inline-actions"><button type="button" class="btn secondary" data-dispute-matter="${esc(item.caseId)}">Open matter</button><a class="btn secondary" href="/api/cases/${esc(item.caseId)}/archive/download" target="_blank" rel="noopener">Download evidence</a></div>`;
      const priorNotes = row.nextElementSibling?.classList.contains('dispute-details') ? row.nextElementSibling : null;
      if (priorNotes) {
        const notes = priorNotes.querySelector('.dispute-notes');
        if (notes) section.append(notes);
        priorNotes.remove();
      }
      const actionCell = cells.at(-1);
      actionCell.querySelector('[data-dispute-toggle]')?.remove();
      const actions = document.createElement('div');
      while (actionCell.firstChild) actions.append(actionCell.firstChild);
      const amountInput=actions.querySelector('[data-dispute-amount]');
      if(amountInput){const amountLabel=document.createElement('label');amountLabel.textContent='Payout to paralegal ($)';amountInput.before(amountLabel);amountLabel.append(amountInput);amountInput.setAttribute('aria-label','Payout to paralegal in dollars');amountInput.placeholder='0.00';}
      section.append(actions);
      cell.append(section);
      detail.append(cell);
      row.replaceChildren();
      row.classList.add('admin-dispute-summary'); row.setAttribute('role', 'row');
      const summary = [item.caseTitle, person(item.attorney), person(item.paralegal), label(item.dispute?.status || status), date(item.dispute?.createdAt)];
      for (let n = 0; n < cells.length - 1; n++) {
        const td = document.createElement('td');
        td.setAttribute('role', 'cell');
        const caption = document.createElement('span'), value = document.createElement('span');
        caption.className = 'admin-dispute-field-label'; caption.setAttribute('aria-hidden', 'true'); caption.textContent = summaryLabels[n];
        value.textContent = summary[n] || ''; td.append(caption, value);
        row.append(td);
      }
      const td = document.createElement('td'),
        button = document.createElement('button');
      button.type = 'button';
      td.setAttribute('role', 'cell');
      button.className = 'btn secondary';
      button.textContent = 'Review';
      button.setAttribute('aria-expanded', 'false');
      replaceEventHandler(button, 'click', () => {
        const opening = detail.hidden;
        body.querySelectorAll('.admin-dispute-detail').forEach(d => d.hidden = true);
        detail.hidden = !opening;
        button.setAttribute('aria-expanded', String(opening));
        routeParam('dispute', opening ? id : '');
      });
      td.append(button);
      row.append(td);
      row.after(detail);
      replaceEventHandler(section.querySelector('[data-dispute-matter]'), 'click', () => window.openAdminMatter(String(item.caseId)));
      if ([new URL(location.href).searchParams.get('dispute'), new URL(location.href).searchParams.get('review')].includes(id)) {
        detail.hidden = false;
        button.setAttribute('aria-expanded', 'true');
      }
      if (window.adminFlowDisputeCaseId === String(item.caseId)) detail.hidden = false;
    });
    const header = table.querySelector('thead tr');
    if (header) {
      header.setAttribute('role', 'row');
      Array.from(header.children).forEach((h, index) => { h.setAttribute('role', 'columnheader'); h.scope = 'col'; h.textContent = index === header.children.length - 1 ? 'Review' : summaryLabels[index]; });
    }
  };
  const exceptionTabs = document.createElement('div');
  exceptionTabs.className = 'admin-tabs';
  exceptionTabs.setAttribute('role', 'group');
  exceptionTabs.setAttribute('aria-label', 'Finance exception source');
  exceptionTabs.innerHTML = '<button type="button" data-exception-source="disputes" aria-pressed="true">Matter disputes</button><button type="button" data-exception-source="chargebacks" aria-pressed="false">Processor chargebacks</button>';
  const disputePanel = el('disputesBody').closest('.panel');
  disputePanel.before(exceptionTabs);
  el('chargebackPanel').hidden = true;
  window.showAdminExceptions = (source = 'disputes') => {
    disputePanel.hidden = source !== 'disputes';
    el('chargebackPanel').hidden = source !== 'chargebacks';
    exceptionTabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.exceptionSource === source)));
  };
  replaceEventHandler(exceptionTabs, 'click', e => {
    if (e.target.dataset.exceptionSource) window.showAdminExceptions(e.target.dataset.exceptionSource);
  });
  const chargePager = pager('adminChargebackPager');
  el('chargebackPanel').append(chargePager);
  const chargeStatus = document.createElement('select');
  chargeStatus.setAttribute('aria-label', 'Chargeback review state');
  chargeStatus.innerHTML = '<option value="all">All review states</option><option value="pending_review">Pending review</option><option value="acknowledged">Acknowledged</option><option value="hold_cleared">Hold cleared</option>';
  el('chargebackPanel').querySelector('table').before(chargeStatus);
  replaceEventHandler(chargeStatus, 'change', () => {
    window.adminChargebackPage = 1;
    window.adminChargebackStatus = chargeStatus.value;
    window.loadChargebacks();
  });
  window.adminChargebacksRendered = data => {
    if (!data) {
      chargePager.querySelector('span').textContent = 'Chargeback total unavailable';
      for (const button of chargePager.querySelectorAll('button')) button.disabled = true;
      return;
    }
    chargePager.hidden = data.pages <= 1;
    bindPager(chargePager, data.total, data.page, data.pages, next => {
      window.adminChargebackPage = next;
      window.loadChargebacks();
    });
  };
  const fullQueue = document.createElement('button');
  fullQueue.type = 'button';
  fullQueue.className = 'btn secondary';
  fullQueue.textContent = 'View all pending payouts';
  replaceEventHandler(fullQueue, 'click', () => window.openAdminFinancialRecords('pending'));
  document.querySelector('.payout-schedule')?.after(fullQueue);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
