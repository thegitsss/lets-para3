import { initGrowthReview } from './growth-review.js';
const el = id => document.getElementById(id);

// Organize the existing controls; their handlers and authorization stay attached.
export function initGrowth() {
  const navigation = document.querySelector('[aria-label="Growth views"]');
  if (!navigation || el('adminGrowthView')) return;
  const marketing = el('section-marketing-drafts'), sales = el('section-sales-workspace');
  window.refreshAdminGrowthReview = initGrowthReview(marketing);
  const definitions = [
    ['weekly','Weekly review',marketing,['adminGrowthReview'],'adminWeeklyReviewRefresh'],
    ['drafts','Post drafts',marketing,['marketingPacketList','marketingPacketDetail'],'marketingRefreshBtn'],
    ['batches','Post batches',marketing,['marketingCycleList','marketingCycleDetail'],'marketingPublishingRefreshBtn'],
    ['research','Research notes',marketing,['marketingJrCmoLibrary'],'marketingJrCmoRefreshBtn'],
    ['posting','Posting settings',marketing,['marketingPublishingSettingsForm'],'marketingPublishingRefreshBtn'],
    ['brief','Create a draft',marketing,['marketingBriefForm'],'marketingRefreshBtn'],
    ['summary','Activity',marketing,[],'marketingFounderRefreshBtn'],
    ['contacts','Contacts',sales,['salesAccountList','salesAccountDetail'],'salesRefreshBtn'],
    ['outreach','Outreach drafts',sales,['salesPacketList','salesPacketDetail'],'salesRefreshBtn'],
    ['contact','Add a contact',sales,['salesAccountForm'],'salesRefreshBtn'],
  ];
  const panels = new Map();
  for (const [key, title, root, ids] of definitions) {
    const panel = document.createElement('div'); panel.dataset.growthView = key; panel.hidden = true;
    for (const id of ids) {
      const node = el(id)?.closest('.panel');
      if (node) panel.append(node);
    }
    root.append(panel); panels.set(key,panel);
    if (ids.length === 2) {
      const list = el(ids[0]), detail = el(ids[1]);
      const listPanel = list.closest('.panel'), detailPanel = detail.closest('.panel');
      listPanel.dataset.growthList=''; detailPanel.dataset.growthDetail='';
      const back = document.createElement('button'); back.type='button'; back.className='btn-link admin-growth-back'; back.textContent=`← ${title}`;
      detailPanel.prepend(back);
      const close = () => { panel.classList.remove('admin-growth-detail-open'); listPanel.hidden=false; detailPanel.hidden=true; };
      const open = event => {
        if (event.type === 'keydown' && !['Enter',' '].includes(event.key)) return;
        if (!event.target.closest('[role="button"]')) return;
        panel.classList.add('admin-growth-detail-open'); listPanel.hidden=true; detailPanel.hidden=false;
        back.focus({preventScroll:true});
      };
      list.addEventListener('click',open); list.addEventListener('keydown',open);
      back.addEventListener('click',() => {close(); list.querySelector('[role="button"]')?.focus();});
      close();
    }
  }
  // Move the remaining summaries together, retaining all existing data and actions.
  for (const root of [marketing,sales]) {
    const remainder = document.createElement('details'); remainder.className='admin-detail-fold';
    remainder.innerHTML='<summary>Activity totals & history</summary>';
    for (const node of [...root.children]) {
      if (node.matches('header,nav,[data-growth-view]')) continue;
      // Drop emptied layout wrappers left behind by the moved panels.
      if (!node.querySelector('.panel,.card,button,input,select,textarea,[role="status"]')) {node.remove();continue;}
      remainder.append(node);
    }
    (root === marketing ? panels.get('summary') : panels.get('contacts')).append(remainder);
    root.classList.add('admin-growth-workspace');
  }
  // The existing per-domain status must remain visible outside the creation forms.
  for (const [root,id] of [[marketing,'marketingFormStatus'],[sales,'salesFormStatus']]) root.append(el(id));
  for (const id of ['marketingPublishingCadenceSummary','marketingLinkedInConnectionForm']) {
    const block=el(id)?.closest('.ai-room-focus-block');if(!block)continue;
    const disclosure=document.createElement('details');disclosure.className='admin-detail-fold';
    const summary=document.createElement('summary');summary.textContent=id==='marketingLinkedInConnectionForm'?'LinkedIn connection':'Posting guidance';
    block.before(disclosure);disclosure.append(summary,block);
  }
  const select = document.createElement('select'); select.id='adminGrowthView'; select.setAttribute('aria-label','Growth view');
  for (const [key,title] of definitions) {const option=document.createElement('option');option.value=key;option.textContent=title;select.append(option);}
  const refresh=document.createElement('button');refresh.type='button';refresh.className='btn secondary';refresh.id='adminGrowthRefresh';refresh.textContent='Refresh';
  navigation.classList.add('admin-growth-navigation');navigation.append(select,refresh);
  let selected='drafts';
  const show = (key,navigate=true) => {
    const definition=definitions.find(row=>row[0]===key);if(!definition)return;
    selected=key;select.value=key;
    for(const [name,panel] of panels) panel.hidden=name!==key;
    if(navigate)window.activateAdminSection?.(definition[2].id.replace('section-',''));
  };
  window.addEventListener('admin:growth-open',event=>{
    const {view,record}=event.detail||{};
    if(!panels.has(view))return;
    show(view);
    const panel=panels.get(view);
    if(record && panel.querySelector('[data-growth-detail]')) {
      panel.classList.add('admin-growth-detail-open');
      panel.querySelector('[data-growth-list]').hidden=true;
      panel.querySelector('[data-growth-detail]').hidden=false;
    }
  });
  select.addEventListener('change',()=>show(select.value));
  refresh.addEventListener('click',()=>el(definitions.find(row=>row[0]===selected)[4])?.click());
  // Keep one visible refresh; the shared button delegates to these existing handlers.
  for (const id of new Set(definitions.map(row=>row[4]))) if(el(id)) el(id).hidden=true;
  const sync=()=>{
    const active=[marketing,sales].find(root=>root.classList.contains('visible'));
    if(active && definitions.find(row=>row[0]===selected)[2]!==active)show(active===marketing?'drafts':'contacts',false);
  };
  for(const root of [marketing,sales])new MutationObserver(sync).observe(root,{attributes:true,attributeFilter:['class']});
  show('drafts',false);sync();
  if (marketing.classList.contains('visible')) void window.refreshAdminGrowthReview();
  // Existing summary links still lead to a visible draft list.
  el('marketingFounderOpenQueueBtn')?.addEventListener('click',()=>show('drafts'));
}
