import { api, escapeHTML as esc, person, debounce } from './shared.js';
const el = id => document.getElementById(id);
function disclose(node, title) {
  if (!node) return;
  const existing = node.closest('details.admin-detail-fold');
  if (existing) { existing.querySelector(':scope > summary').textContent = title; return existing; }
  const details = document.createElement('details');
  details.className = 'admin-detail-fold';
  const summary = document.createElement('summary'); summary.textContent = title;
  node.before(details); details.append(summary, node);
  return details;
}
export function initUsability() {
  // Keep the existing payment action and its authorization checks. Selection
  // only reads a matter; checking Stripe always requires an explicit click.
  const input = el('reconcileCaseId'), button = el('reconcileCaseBtn');
  input.hidden = true;
  input.previousElementSibling.hidden = true;
  const panel = input.closest('.panel');
  panel.classList.add('admin-payment-check');
  const picker = document.createElement('div');
  picker.innerHTML = '<label for="adminPaymentSearch">Matter</label><input id="adminPaymentSearch" type="search" placeholder="Search by matter name" autocomplete="off"><div id="adminPaymentMatches"></div><p id="adminPaymentSelection" role="status">Choose a matter to check.</p>';
  input.before(picker);
  const details = document.createElement('details'); details.className = 'admin-record-reference';
  details.innerHTML = '<summary>Reference</summary><code id="adminPaymentReference"></code>';
  details.hidden = true; panel.append(details);
  button.disabled = true;
  let revision = 0;
  const clear = () => {input.value = ''; button.disabled = true; details.hidden = true; el('reconcileStatus').textContent = '';};
  const matches = el('adminPaymentMatches'), search = el('adminPaymentSearch');
  window.selectAdminPaymentMatter = async id => {
    const request = ++revision;
    clear(); matches.replaceChildren(); el('adminPaymentSelection').textContent = 'Loading matter…';
    try {
      const data = await api(`/api/admin/workspace/matters/${encodeURIComponent(id)}`);
      if (request !== revision) return;
      if (!data.matter?.id) throw new Error('Matter unavailable. Search again.');
      input.value = data.matter.id;
      search.value = data.matter.title || 'Untitled matter';
      el('adminPaymentSelection').textContent = person(data.matter.attorney);
      el('adminPaymentReference').textContent = data.matter.id;
      details.hidden = false; button.disabled = false;
    } catch(error) { if(request === revision) el('adminPaymentSelection').textContent = error.message; }
  };
  const find = debounce(async () => {
    const request = ++revision, q = search.value.trim();
    if (q.length < 2) return;
    el('adminPaymentSelection').textContent = 'Searching…';
    try {
      const data = await api(`/api/admin/workspace/matters?${new URLSearchParams({q,page:'1',filter:'all'})}`);
      if (request !== revision) return;
      matches.innerHTML = data.items.map(m => `<button type="button" class="admin-payment-match" data-payment-choice="${esc(m.id)}"><strong>${esc(m.title || 'Untitled matter')}</strong><small>${esc(person(m.attorney))}</small></button>`).join('');
      el('adminPaymentSelection').textContent = data.items.length ? (data.pages > 1 ? 'Refine your search for more matches.' : '') : 'No matching matters.';
    } catch(error) { if(request === revision) el('adminPaymentSelection').textContent = error.message; }
  });
  search.addEventListener('input', () => { revision++; clear(); matches.replaceChildren(); el('adminPaymentSelection').textContent = 'Type at least two characters.'; find(); });
  matches.addEventListener('click', event => {const choice=event.target.closest('[data-payment-choice]'); if(choice) void window.selectAdminPaymentMatter(choice.dataset.paymentChoice);});
  const row = input.closest('.escrow-chart-row');
  // The chart describes all payments, not the selected matter.
  const chartPanel = row.querySelector('.panel');
  const reports = el('section-revenue').querySelector(':scope > details');
  if (chartPanel !== panel && reports) reports.append(chartPanel);

  const records = el('adminFinanceRecords');
  const dates = el('adminFinanceFrom').closest('.admin-inline-actions');
  const exportButton = el('adminFinanceExport');
  exportButton.title = 'Download CSV. Amounts are in cents.';
  const filters = disclose(dates, 'Date range & export');
  filters.addEventListener('toggle', () => { if(!filters.open) filters.querySelector('summary').textContent = el('adminFinanceFrom').value || el('adminFinanceTo').value ? 'Date range applied' : 'Date range & export'; });
  const updateTitle = () => {
    const active=records.querySelector('[data-finance-kind][aria-pressed="true"]');
    records.querySelector('h2').textContent=active?.textContent || 'Payments';
  };
  new MutationObserver(updateTitle).observe(records.querySelector('.admin-tabs'),{subtree:true,attributes:true,attributeFilter:['aria-pressed']});
  updateTitle();

  // Creation forms and configuration are secondary to the work queues.
  for (const [id,title] of [['salesAccountForm','Add contact'],['marketingBriefForm','Create brief'],['marketingPublishingSettingsForm','Posting settings']]) {
    const node=el(id)?.closest('.panel'); if(node) disclose(node,title);
  }
  for (const id of ['section-sales-workspace','section-marketing-drafts','section-approvals-workspace','section-knowledge-studio']) {
    const root=el(id); if(!root) continue;
    const metrics=root.querySelector(':scope > .grid-four, :scope > .ai-room-summary-strip'); if(metrics) disclose(metrics,'Activity totals');
  }
  const marketing=el('section-marketing-drafts');
  disclose(marketing?.querySelector('.founder-layer-grid'),'Daily summary');
  for(const [id,title] of [['marketingResearchList','Research'],['marketingBatchList','Post batches']]) {
    const panel=el(id)?.closest('.panel'); if(panel) disclose(panel,title);
  }
  for(const id of ['salesAccountDetail','salesPacketDetail']) {
    const target=el(id), panel=target?.closest('.panel'); if(!panel) continue;
    const sync=()=>{panel.hidden=Boolean(target.querySelector(':scope > .ai-room-empty')) && !target.querySelector('button,input,textarea,a');};
    new MutationObserver(sync).observe(target,{subtree:true,childList:true}); sync();
  }
  const names = {salesAccountCount:'Contacts', salesAccountList:'Contacts',salesPacketList:'Outreach drafts',marketingDraftList:'Drafts'};
  for(const [id,title] of Object.entries(names)) {const heading=el(id)?.closest('.panel')?.querySelector('h2');if(heading)heading.textContent=title;}
}
