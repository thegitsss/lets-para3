const el = id => document.getElementById(id);
export const calmMode = () => new URL(location.href).searchParams.get('view') !== 'queue';
function fold(nodes, title, className = '') {
  const available = nodes.filter(Boolean);
  if (!available.length) return;
  const details = document.createElement('details');
  details.className = `admin-calm-options ${className}`;
  const summary = document.createElement('summary');
  summary.textContent = title;
  available[0].before(details);
  details.append(summary, ...available);
  return details;
}
export function simplifyInquiry(ticket) {
  if (!calmMode()) return;
  const detail = el('adminInboxDetail');
  fold([detail.querySelector(':scope > .admin-inline-actions')], 'Request details');
  const form = el('adminReplyForm');
  const template = el('adminReplyTemplate');
  const suggestions = fold([el('adminPreparedReply'), form.querySelector('label[for="adminReplyTemplate"]'), template], 'Reply suggestions');
  const status = el('adminReplyStatus');
  const afterReply = fold([status?.closest('label')], 'After replying');
  const options = [...detail.querySelectorAll(':scope > details')];
  const more = fold(options, 'Details', 'admin-inquiry-options');
  more.append(suggestions, afterReply);
  const heading = detail.querySelector(':scope > .panel-header');
  const identity = detail.querySelector(':scope > .admin-inquiry-identity');
  more.append(heading, identity, el('adminInquirySummary'));
  const name = document.createElement('h2');
  name.className = 'admin-request-name';
  name.textContent = ticket.requester?.name || ticket.contextSnapshot?.requesterName || ticket.requesterEmail || 'Visitor';
  el('adminInboxBack').after(name);
  el('adminInboxBack').textContent = '← Back';
  detail.append(more);
  const messages = detail.querySelectorAll('.admin-message');
  if (messages.length === 1 && ['User', 'Original question'].includes(messages[0].querySelector('strong')?.textContent)) messages[0].querySelector('strong').hidden = true;
  el('adminReplyText').placeholder = 'Write a reply…';
  el('adminReplyText').setAttribute('aria-label', 'Reply');
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'adminResolveRequest'; button.className = 'btn secondary';
  button.textContent = el('adminTicketStatus').value === 'resolved' || el('adminTicketStatus').value === 'closed' ? 'Resolved' : 'Mark resolved';
  button.disabled = button.textContent === 'Resolved';
  el('adminReplySend').after(button);
  const result = document.createElement('p');
  result.id = 'adminResolveResult'; result.setAttribute('role', 'status');
  form.after(result);
  el('adminReplyTitle').textContent = form.classList.contains('admin-reply-unavailable') ? 'Reply unavailable' : 'Reply';
}
export function initCalmAdmin() {
  if (!calmMode()) return;
  simplifyFinance();
  const section = el('section-support-ops');
  section.classList.add('admin-calm-inbox');
  const queue = el('adminInboxList').closest('.admin-inbox-queue');
  const sourceTabs = section.querySelector(':scope > .admin-tabs');
  const controls = queue.querySelector('.pending-controls');
  const toolbar = document.createElement('div');
  toolbar.className = 'admin-request-toolbar';
  const sourceSelect = document.createElement('select');
  sourceSelect.id = 'adminRequestType';
  sourceSelect.setAttribute('aria-label','Request type');
  sourceSelect.innerHTML = '<option value="all">All requests</option><option value="contact">Contact forms</option><option value="email">Emails</option><option value="human">Human requests</option>';
  const status = el('adminInboxStatus');
  status.querySelector('[value="active"]').textContent = 'Active';
  const statusLabel = status.closest('label');
  toolbar.append(sourceSelect, status);
  statusLabel?.remove();
  el('adminInboxSearch').placeholder = 'Search';
  el('adminInboxSearch').before(toolbar);
  toolbar.append(el('adminInboxSearch'));
  const columnHeadings = document.createElement('div');
  columnHeadings.className = 'admin-mail-columns';
  columnHeadings.setAttribute('aria-hidden', 'true');
  columnHeadings.innerHTML = '<span>From</span><span>Message</span><span>Date</span>';
  el('adminInboxList').before(columnHeadings);
  const tools = fold([section.querySelector(':scope > .admin-context-nav'), section.querySelector('[data-admin-knowledge]')], 'Request settings', 'admin-support-tools');
  el('section-ai-control-room').append(tools);
  sourceTabs.hidden = true;
  tools.append(sourceTabs, controls);
  el('adminInboxRefresh').textContent = 'Refresh requests';
  const checkbox = document.createElement('label');
  checkbox.className = 'admin-test-request-toggle';
  checkbox.innerHTML = '<input type="checkbox" id="adminInboxIncludeTests"> Include test requests';
  tools.append(checkbox);
  const delivery = section.querySelector('.admin-communications');
  if (delivery) tools.append(delivery);
  sourceSelect.addEventListener('change', () => sourceTabs.querySelector(`[data-inbox-source="${sourceSelect.value}"]`).click());
  const update = () => {
    sourceSelect.value = sourceTabs.querySelector('[aria-pressed="true"]')?.dataset.inboxSource || 'all';
  };
  new MutationObserver(update).observe(sourceTabs, {subtree:true, attributes:true, attributeFilter:['aria-pressed']});
  update();
  for (const id of ['pendingUsersPanel','photoReviewsPanel','approvedUsersPanel','deletedUsersPanel']) {
    const controls = el(id)?.querySelector('.pending-controls');
    if (!controls) continue;
    const secondary = [...controls.children].filter(node => !node.matches('input[type="search"],.search'));
    fold(secondary, 'Filters');
  }
}

function simplifyFinance() {
  const tabs = document.querySelector('[aria-label="Finance workspace"]');
  const sources = document.querySelector('[aria-label="Finance exception source"]');
  if (!tabs || !sources) return;
  const select = document.createElement('select');
  select.id = 'adminFinanceDestination';
  select.setAttribute('aria-label', 'Finance view');
  select.innerHTML = '<option value="disputes">Disputes</option><option value="chargebacks">Chargebacks</option><option value="reporting">Payments</option><option value="payouts">Payouts</option><option value="pending">Awaiting payout</option><option value="income">Platform income</option><option value="commissions">Commissions</option><option value="reconcile">Check payment</option>';
  tabs.before(select);
  tabs.classList.add('admin-calm-finance-tabs');
  sources.classList.add('admin-calm-finance-tabs');
  select.addEventListener('change', () => {
    const exception = ['disputes','chargebacks'].includes(select.value);
    if (['reporting','payouts','pending','income','commissions'].includes(select.value)) window.openAdminFinancialRecords(select.value === 'reporting' ? 'operations' : select.value);
    else window.showAdminFinance(exception ? 'exceptions' : select.value);
    if (exception) window.showAdminExceptions(select.value);
  });
  const sync = () => {
    const view = tabs.querySelector('[aria-pressed="true"]')?.dataset.financeView;
    const kind = document.querySelector('[data-finance-kind][aria-pressed="true"]')?.dataset.financeKind;
    select.value = view === 'exceptions' ? sources.querySelector('[aria-pressed="true"]')?.dataset.exceptionSource || 'disputes' : view === 'reporting' && kind !== 'operations' ? kind : view;
  };
  const observer = new MutationObserver(sync);
  for (const target of [tabs,sources,document.querySelector('[aria-label="Financial record source"]')].filter(Boolean)) observer.observe(target,{subtree:true,attributes:true,attributeFilter:['aria-pressed']});
  sync();
  const controls = el('disputeSearch').closest('.pending-controls');
  const filters = fold([controls], 'Filters · Open', 'admin-dispute-filters');
  const update = () => {
    const active = el('disputeTabs').querySelector('.active');
    filters.querySelector('summary').textContent = `Filters · ${active?.textContent || 'Open'}${el('disputeSearch').value ? ' · Search applied' : ''}`;
  };
  new MutationObserver(update).observe(el('disputeTabs'),{subtree:true,attributes:true,attributeFilter:['class']});
  el('disputeSearch').addEventListener('input',update);
}
