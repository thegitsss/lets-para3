import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api, escapeHTML as esc, person } from './shared.js';
import { icon, age, emptyState } from './presentation.js';
import { getStoredSession } from '../auth.js';
import { initAdminNavigation } from './navigation.mjs';
const el = id => document.getElementById(id);
function disclosure(node, title) {
  if (!node) return;
  const fold = document.createElement('details');
  fold.className = 'admin-detail-fold admin-home-disclosure';
  const summary = document.createElement('summary');
  summary.textContent = title;
  fold.append(summary);
  node.before(fold);
  fold.append(node);
  return fold;
}
function init() {
  const main = el('main');
  const icons = { overview:'overview', 'user-management':'users', matters:'matters', 'support-ops':'inbox', finance:'finance' };
  document.querySelectorAll('#sidebarNav nav > button').forEach(button => {
    button.insertAdjacentHTML('afterbegin', icon(icons[button.dataset.section]));
  });
  const navLabel = document.createElement('p');
  navLabel.className = 'admin-nav-label';
  navLabel.textContent = 'DAILY OPERATIONS';
  el('sidebarNav').querySelector('nav').before(navLabel);
  const topbar = document.createElement('header');
  topbar.className = 'admin-topbar';
  topbar.innerHTML = `<div class="admin-breadcrumb">Workspace <span>/</span> <strong id="adminCurrentWorkspace">Today</strong></div><div class="admin-topbar-actions"><span class="admin-today">${esc(new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',weekday:'short'}).format(new Date()))}</span><button type="button" id="adminSearchOpen" aria-haspopup="dialog" aria-label="Search workspace">${icon('search')}<span>Search workspace</span></button><a class="admin-identity" href="profile-settings.html#security" aria-label="My account and security" id="adminIdentity"></a></div>`;
  main.prepend(topbar);
  initAdminNavigation(topbar, main);
  function identity() {
    const user = getStoredSession().user;
    el('adminIdentity').textContent = 'Security';
    el('adminIdentity').title = user ? `${person(user)} · Account & security` : 'Account & security';
  }
  identity();
  addEventListener('lpc:user-updated', identity);
  function sectionName() {
    const active = document.querySelector('#sidebarNav [aria-current="page"]');
    el('adminCurrentWorkspace').textContent = active ? [...active.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim() : 'Today';
  }
  new MutationObserver(sectionName).observe(el('sidebarNav'),{subtree:true,attributes:true,attributeFilter:['aria-current']});
  sectionName();

  const search = document.querySelector('.admin-global-search');
  const dialog = document.createElement('dialog');
  dialog.id = 'adminSearchDialog';
  dialog.className = 'admin-search-dialog';
  dialog.setAttribute('aria-labelledby','adminSearchTitle');
  dialog.innerHTML = `<div class="admin-search-heading"><div><h2 id="adminSearchTitle">Search your workspace</h2></div><button type="button" class="btn secondary" id="adminSearchClose" aria-label="Close search">${icon('close')}</button></div><p class="admin-search-hint">↑ ↓ to navigate · Enter to open · Esc to close</p>`;
  document.body.append(dialog);
  dialog.querySelector('.admin-search-hint').before(search);
  search.open = true;
  let opener;
  function openSearch(event) {
    if (document.querySelector('[aria-modal="true"]:not(.hidden):not([aria-hidden="true"]), dialog[open]')) return;
    opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement;
    search.open = true;
    dialog.showModal();
    el('adminGlobalSearch').focus();
  }
  replaceEventHandler(el('adminSearchOpen'), 'click', openSearch);
  replaceEventHandler(el('adminSearchClose'), 'click', () => dialog.close());
  dialog.addEventListener('close',()=>opener?.focus({preventScroll:true}));
  dialog.addEventListener('click',e=>{if(e.target===dialog && (e.clientX<dialog.getBoundingClientRect().left || e.clientX>dialog.getBoundingClientRect().right || e.clientY<dialog.getBoundingClientRect().top || e.clientY>dialog.getBoundingClientRect().bottom))dialog.close();});
  addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k') { e.preventDefault(); if(dialog.open)dialog.close();else openSearch(); }
  });
  dialog.addEventListener('keydown',e=>{
    if(e.key==='Escape') { e.preventDefault(); e.stopPropagation(); dialog.close(); return; }
    if(!['ArrowDown','ArrowUp'].includes(e.key))return;
    const buttons = [...dialog.querySelectorAll('[data-global-kind]')];
    if(!buttons.length)return;
    e.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    if(e.key==='ArrowUp'&&index===0)el('adminGlobalSearch').focus();
    else buttons[(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
  });
  if(!/Mac|iPhone|iPad/.test(navigator.platform))el('adminSearchOpen').querySelector('kbd').textContent='Ctrl K';

  const overview = el('section-overview');
  const grid = document.createElement('div');
  grid.className = 'admin-home-grid';
  el('adminSignupPanel').before(grid);
  const column = document.createElement('div');
  column.className = 'admin-home-primary';
  grid.append(column,el('adminPeoplePanel'));
  column.append(el('adminSignupPanel'),el('adminOperationalAttention'));
  el('adminHomeRefresh').innerHTML = icon('refresh');
  el('adminHomeRefresh').setAttribute('aria-label','Refresh overview');
  el('adminHomeRefresh').title='Refresh overview';
  const reviewNext = document.createElement('button');
  reviewNext.type='button';reviewNext.id='adminReviewNext';reviewNext.className='btn primary';
  reviewNext.innerHTML=`Review next application ${icon('arrow')}`;
  reviewNext.hidden=true;
  el('adminSignupPanel').querySelector('[data-admin-open-users]').before(reviewNext);
  replaceEventHandler(reviewNext, 'click', ()=>el('adminSignupList').querySelector('[data-admin-review]')?.click());
  new MutationObserver(()=>{reviewNext.hidden=!el('adminSignupList').querySelector('[data-admin-review]');}).observe(el('adminSignupList'),{childList:true});
  el('adminPeoplePanel').querySelectorAll('.admin-inquiry-card').forEach((card,i)=>card.insertAdjacentHTML('afterbegin',icon(i?'person':'mail')));
  const recent = document.createElement('div');
  recent.id='adminRecentInquiries';recent.innerHTML='<p role="status" class="small">Loading recent questions…</p>';
  el('adminPeoplePanel').append(recent);
  let recentSeq=0;
  async function recentInquiries() {
    const seq=++recentSeq;
    try {
      const queues=await Promise.all(['open','in_review'].map(status=>api(`/api/admin/support/inbox?source=all&status=${status}&page=1&limit=3`)));
      const data={tickets:queues.flatMap(q=>q.tickets).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))};
      if(seq!==recentSeq)return;
      recent.innerHTML = `<div class="admin-recent-heading"><h3>Waiting for your review</h3><button class="btn-link" type="button" data-admin-inbox="all">View inbox ${icon('arrow')}</button></div>`+(data.tickets.length?data.tickets.slice(0,3).map(t=>`<button class="admin-recent-inquiry" type="button" data-recent-ticket="${esc(t.id)}"><span class="admin-row-meta">${esc(t.requesterUserId?person(t.requesterUserId):t.contextSnapshot?.requesterName||t.requesterEmail)} <span>${age(t.updatedAt)}</span></span><strong>${esc(t.subject)}</strong><span class="admin-row-preview">${esc(t.latestUserMessage||t.message)}</span></button>`).join(''):emptyState('No questions waiting','','inbox'));
    } catch { if(seq===recentSeq)recent.innerHTML='<p role="status">Recent inquiries are unavailable. Open the inbox to retry.</p>'; }
  }
  replaceEventHandler(recent, 'click', e=>{const b=e.target.closest('[data-recent-ticket]');if(b)window.openSupportTicketInAdmin(b.dataset.recentTicket);});
  void recentInquiries();
  el('adminHomeRefresh').addEventListener('click',recentInquiries);
  document.addEventListener('admin:inbox-counts',recentInquiries);
  disclosure(overview.querySelector('.overview-action-panel'),'Growth & system work');
  const metrics=overview.querySelector('.metrics');
  const reports=disclosure(metrics,'Platform totals & reporting');
  if(reports&&overview.querySelector(':scope > .grid-four'))reports.append(overview.querySelector(':scope > .grid-four'));
  overview.append(el('healthBanner'));

  const modalContent=el('pendingUserModal').querySelector('.details-content');
  const scroll=document.createElement('div');scroll.className='admin-account-scroll';
  const header=modalContent.querySelector('.details-header');
  header.after(scroll);
  [...modalContent.children].filter(n=>n!==header&&n!==scroll&&!n.classList.contains('pending-modal-actions')).forEach(n=>scroll.append(n));
  el('closePendingModal').innerHTML=icon('close');el('closePendingModal').setAttribute('aria-label','Close account review');
  el('adminInboxDetail').innerHTML=emptyState('Select an inquiry','','inbox');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
