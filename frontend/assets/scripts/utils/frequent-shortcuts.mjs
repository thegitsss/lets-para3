const DAY = 86400000;
export const SHORTCUT_RULES = Object.freeze({ visits: 4, window: 30 * DAY, cooldown: 10 * 60000, limit: 4 });
const validOwner = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
export function shortcutCatalog(role) {
  const settings = [['/settings', 'Profile settings'], ['/settings?tab=security', 'Security'], ['/settings?tab=preferences', 'Preferences'], ['/help', 'Help']];
  const pages = role === 'attorney'
    ? [...settings, ['/tasks', 'Personal tasks'], ['/profile', 'View profile'], ...[['active','Active Matters'],['draft','Drafts'],['archived','Archived Matters'],['inquiries','Applications']].map(([view,label]) => [`/matters?view=${view}`,label])]
    : role === 'paralegal' ? [...settings, ['/profile/me','View profile'], ...[['active','Active Matters'],['applications','Applications'],['invitations','Invitations'],['history','History']].map(([view,label]) => [`/work?section=${view}`,label]), ...[['reviews','Revisions'],['deadlines','Deadlines'],['insights','Insights'],['work','Work overview'],['matters','Matter summary'],['document','Matter overview'],['pulse','Updates'],['inbox','Inbox']].map(([view,label]) => [`/home?view=${view}`,label])] : [];
  return pages.map(([key,label]) => Object.freeze({ key, label }));
}
export function shortcutPage(role, hash) {
  if (typeof hash !== 'string' || hash.length > 2048) return null;
  const [path, query=''] = hash.replace(/^#/, '').split('?'), params = new URLSearchParams(query);
  let key = path.replace(/\/$/, '') || '/home';
  const matter = role === 'attorney' ? key.match(/^\/matters\/([a-f\d]{24})\/(overview|applications|work|files|messages|deadlines|activity|financials)$/i) : role === 'paralegal' ? key.match(/^\/matter\/([a-f\d]{24})$/i) : null;
  if (matter) return { key: role === 'attorney' ? `/matters/${matter[1].toLowerCase()}/overview` : `/matter/${matter[1].toLowerCase()}`, label: 'Matter', matterId: matter[1].toLowerCase() };
  if (key === '/settings') { const tab=params.get('tab'); if (tab && tab !== 'profile') key += `?tab=${tab}`; }
  else if (role === 'attorney' && key === '/matters' && params.has('view')) key += `?view=${params.get('view')}`;
  else if (role === 'paralegal' && key === '/work' && params.has('section')) key += `?section=${params.get('section')}`;
  else if (role === 'paralegal' && key === '/home' && params.has('view')) key += `?view=${params.get('view')}`;
  return shortcutCatalog(role).find(page => page.key === key) || null;
}
export function readShortcutVisits(raw, { role, ownerId, now = Date.now() }) {
  const visits = {};
  try {
    if (typeof raw !== 'string' || raw.length > 100000) return visits;
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.ownerId !== ownerId || value.role !== role || !value.visits || typeof value.visits !== 'object') return visits;
    const allowed = Object.entries(value.visits).map(([key,times])=>({page:shortcutPage(role,key),key,times})).filter(({page,key,times})=>page?.key===key && Array.isArray(times)).map(({key,times})=>[key,[...new Set(times.filter(time=>Number.isSafeInteger(time)&&time>now-SHORTCUT_RULES.window&&time<=now))].sort((a,b)=>a-b).slice(-128)]).sort((a,b)=>(b[1].at(-1)||0)-(a[1].at(-1)||0)).slice(0,32);
    for (const [key,times] of allowed) visits[key]=times;
  } catch { /* Optional, untrusted browser storage never blocks navigation. */ }
  return visits;
}
export function rankShortcuts(visits, role) {
  return Object.keys(visits).map(key=>shortcutPage(role,key)).filter(page => page && visits[page.key]?.length >= SHORTCUT_RULES.visits)
    .sort((a,b)=>visits[b.key].length-visits[a.key].length || visits[b.key].at(-1)-visits[a.key].at(-1) || a.label.localeCompare(b.label)).slice(0,SHORTCUT_RULES.limit);
}
export function createFrequentShortcuts({ role, host, storage, resolveMatter, now = () => Date.now() } = {}) {
  if (!host || !shortcutCatalog(role).length) return { scopeToIdentity(){}, record(){}, clear(){} };
  let ownerId='', lastPage='', memory={}, storageFailed=false, generation=0, controller;
  const section=document.createElement('section');section.className='lpc-shortcuts';section.setAttribute('aria-label','Shortcuts');section.hidden=true;
  const title=document.createElement('h2');title.className='lpc-shortcuts-title';title.textContent='Shortcuts';
  const links=document.createElement('div');links.className='lpc-shortcuts-links';section.append(title,links);host.append(section);
  const key=()=>`lpc-shortcuts:v1:${role}:${ownerId}`;
  let removedMemory=new Set(), pinnedMemory=[], menu, menuOrigin, pressTimer, suppressClick=false, closingMenu;
  const pinnedKey=()=>`${key()}:pinned`;
  function pinned(){try {const value=JSON.parse((storage||window.localStorage).getItem(pinnedKey())||'[]');return [...new Set([...pinnedMemory,...(Array.isArray(value)?value:[])])].filter(k=>typeof k==='string'&&shortcutPage(role,k)?.key===k).slice(0,8);}catch{return pinnedMemory;}}
  const feedback=document.createElement('span');feedback.setAttribute('role','status');feedback.className='lpc-shortcut-status';section.append(feedback);
  function savePins(pages){pinnedMemory=pages;try{(storage||window.localStorage).setItem(pinnedKey(),JSON.stringify(pages));}catch{} }
  async function pinCurrent(){
    const page=shortcutPage(role,location.hash),expectedOwner=ownerId;if(!ownerId||!page)return;
    if(page.matterId){try{const matter=await resolveMatter?.(page.matterId,{ownerId:expectedOwner});if(ownerId!==expectedOwner||String(matter?._id||matter?.id||'').toLowerCase()!==page.matterId)return;}catch{return;}}
    const pages=pinned();if(!pages.includes(page.key)){if(pages.length>=8){feedback.dataset.state='error';feedback.textContent='Unpin a shortcut before adding another.';return;}savePins([...pages,page.key]);}
    feedback.dataset.state='saved';feedback.textContent='Page pinned to Shortcuts.';void render();
  }
  document.addEventListener('lpc-shortcut-pin-current',()=>void pinCurrent());
  const pagePin=document.createElement('button');pagePin.type='button';pagePin.className='lpc-pin-current-page';pagePin.textContent='Pin this page to shortcuts';pagePin.hidden=true;
  if(role==='paralegal')pagePin.setAttribute('role','menuitem');
  const account=role==='attorney'?document.querySelector('.av2-sidebar-account'):document.querySelector('[data-v2-profile-menu]');
  if(account){if(role==='paralegal')account.insertBefore(pagePin,account.querySelector('[data-v2-sign-out]'));else account.append(pagePin);}
  pagePin.addEventListener('click',()=>void pinCurrent());
  function syncPagePin(){const page=ownerId&&shortcutPage(role,location.hash);pagePin.hidden=!page||Boolean(page.matterId)||pinned().includes(page.key);}

  const removedKey=()=>`${key()}:removed`;
  function removed(){try{const value=JSON.parse((storage||window.localStorage).getItem(removedKey())||'[]');return new Set([...removedMemory,...(Array.isArray(value)?value.filter(k=>typeof k==='string'&&shortcutPage(role,k)?.key===k):[])]);}catch{return removedMemory;}}
  function focusShortcut(page){const link=[...links.querySelectorAll('a')].find(a=>a.dataset.shortcutPage===page);(link||host.querySelector('a')||host.closest('aside,dialog')?.querySelector('a'))?.focus();}
  function finishClosingMenu(){if(closingMenu){closingMenu.getAnimations().forEach(a=>a.cancel());closingMenu.remove();closingMenu=null;}}
  function closeMenu(){
    if(menuOrigin?.hasAttribute('aria-haspopup'))menuOrigin.setAttribute('aria-expanded','false');
    finishClosingMenu();const current=menu;menu=null;menuOrigin=null;if(!current)return;
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){current.remove();return;}
    const opacity=getComputedStyle(current).opacity,transform=getComputedStyle(current).transform;
    current.getAnimations().forEach(a=>a.cancel());current.inert=true;closingMenu=current;
    current.animate([{opacity,transform},{opacity:0,transform:'translateY(-3px)'}],{duration:120,easing:'ease-out',fill:'forwards'}).finished.catch(error=>{if(error?.name!=='AbortError')console.warn('Shortcut menu transition did not finish.',error);}).finally(()=>{current.remove();if(closingMenu===current)closingMenu=null;});
  }
  function openMenu(link,x,y,origin=link){
    closeMenu();finishClosingMenu();const expectedOwner=ownerId,page=link.dataset.shortcutPage;menuOrigin=origin;if(origin.hasAttribute('aria-haspopup'))origin.setAttribute('aria-expanded','true');
    menu=document.createElement('div');menu.className='lpc-shortcut-menu';menu.setAttribute('popover','manual');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Shortcut actions');
    const remove=document.createElement('button');remove.type='button';remove.textContent='Remove shortcut';remove.setAttribute('role','menuitem');
    remove.addEventListener('click',()=>{if(ownerId!==expectedOwner){closeMenu();return;}const excluded=removed();excluded.add(page);removedMemory=excluded;savePins(pinned().filter(k=>k!==page));try{(storage||window.localStorage).setItem(removedKey(),JSON.stringify([...excluded]));}catch{}const row=link.closest('.lpc-shortcut-row'),next=(row?.nextElementSibling||row?.previousElementSibling)?.querySelector('a')?.dataset.shortcutPage;closeMenu();void render().then(()=>focusShortcut(next));});
    const pin=document.createElement('button');pin.type='button';pin.setAttribute('role','menuitem');pin.textContent=pinned().includes(page)?'Unpin shortcut':'Pin shortcut';
    pin.addEventListener('click',()=>{if(ownerId!==expectedOwner){closeMenu();return;}const pages=pinned();if(pages.includes(page))savePins(pages.filter(k=>k!==page));else if(pages.length<8)savePins([...pages,page]);else {feedback.dataset.state='error';feedback.textContent='Unpin a shortcut before adding another.';}closeMenu();void render().then(()=>focusShortcut(page));});
    const dialog=link.closest('dialog[open]');
    menu.append(pin,remove);(dialog || document.body).append(menu);menu.showPopover();
    const box=menu.getBoundingClientRect(),bounds=dialog?.getBoundingClientRect();
    const left=Math.max(8,bounds?.left+8||8),right=Math.min(window.innerWidth-8,bounds?.right-8||window.innerWidth-8);
    const bottom=Math.min(window.innerHeight-8,bounds?.bottom-8||window.innerHeight-8);
    menu.style.maxWidth=`${right-left}px`;
    menu.style.left=`${Math.max(left,Math.min(x-box.width,right-box.width))}px`;
    menu.style.top=`${Math.max(8,Math.min(y,bottom-box.height))}px`;
    if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)menu.animate([{opacity:0,transform:'translateY(-3px)'},{opacity:1,transform:'translateY(0)'}],{duration:150,easing:'cubic-bezier(.2,.7,.3,1)'});
    pin.focus();

    menu.addEventListener('keydown',event=>{if(event.key==='Tab'){const origin=menuOrigin;closeMenu();origin?.focus();return;}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();const origin=menuOrigin;closeMenu();origin?.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll('button')];buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(buttons.indexOf(document.activeElement)+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}});
  }
  links.addEventListener('contextmenu',event=>{const link=event.target.closest('a[data-shortcut-page]');if(!link)return;event.preventDefault();const box=link.getBoundingClientRect();openMenu(link,event.clientX||box.right,event.clientY||box.top);});
  links.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){const link=event.target.closest('a[data-shortcut-page]');if(link){event.preventDefault();const box=link.getBoundingClientRect();openMenu(link,box.right,box.top);}}});
  links.addEventListener('pointerdown',event=>{suppressClick=false;if(event.pointerType!=='touch')return;const link=event.target.closest('a[data-shortcut-page]');if(link)pressTimer=setTimeout(()=>{suppressClick=true;openMenu(link,event.clientX,event.clientY);},550);});
  for(const type of ['pointerup','pointercancel','pointermove'])links.addEventListener(type,()=>clearTimeout(pressTimer));
  links.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopPropagation();suppressClick=false;}},true);
  function read(){if(storageFailed)return memory;try{return readShortcutVisits((storage || window.localStorage).getItem(key()),{role,ownerId,now:now()});}catch{storageFailed=true;return memory;}}
  async function render(){
    syncPagePin();
    const ticket=++generation;controller?.abort();controller=new AbortController();const signal=controller.signal;const expectedOwner=ownerId;
    const excluded=removed();
    const pins=ownerId?pinned():[];
    const ranked=ownerId?[...pins.map(key=>({...shortcutPage(role,key),pinned:true})),...rankShortcuts(Object.fromEntries(Object.entries(read()).filter(([key])=>!excluded.has(key)&&!pins.includes(key))),role)]:[], current=shortcutPage(role,location.hash)?.key;
    const timer=setTimeout(()=>controller?.signal===signal&&controller.abort(),8000);
    const pending=ranked.map(async page=>{
      if(!page.matterId)return page;
      if(typeof resolveMatter!=='function')return null;
      try {const matter=await resolveMatter(page.matterId,{signal,ownerId:expectedOwner});const id=String(matter?._id||matter?.id||'').toLowerCase();const label=typeof matter?.title==='string'?matter.title.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,200):'';return id===page.matterId&&label&&!signal.aborted?{...page,label}:null;}catch{return null;}
    });
    const pages=ranked.some(page=>page.matterId)?(await Promise.all(pending)).filter(Boolean):ranked;clearTimeout(timer);
    if(ticket!==generation||ownerId!==expectedOwner)return;
    // Leave the focused link intact when a background tab updates its counts.
    const signature=JSON.stringify(pages.map(page=>[page.key,page.label,Boolean(page.pinned)]));
    if(links.dataset.pages!==signature){links.replaceChildren(...pages.map(page=>{const a=document.createElement('a');const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.65');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');const circle=document.createElementNS(icon.namespaceURI,'circle');circle.setAttribute('cx','12');circle.setAttribute('cy','12');circle.setAttribute('r','9');const hands=document.createElementNS(icon.namespaceURI,'path');hands.setAttribute('d','M12 7v5l3 2');if(page.pinned){hands.setAttribute('d','m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z');icon.append(hands);}else icon.append(circle,hands);a.dataset.shortcutPinned=String(Boolean(page.pinned));a.title=page.pinned?'Pinned shortcut':'Frequently visited';const label=document.createElement('span');label.textContent=page.label;a.append(icon,label);a.href=`/${role}-v2.html#${page.key}`;a.dataset.shortcutPage=page.key;a.setAttribute(role==='attorney'?'data-av2-route':'data-v2-route','');if(role==='paralegal')a.className='v2-nav-link';const row=document.createElement('div');row.className='lpc-shortcut-row';row.append(a);return row;}));links.dataset.pages=signature;}
    for(const link of links.querySelectorAll('a[data-shortcut-page]')){if(link.dataset.shortcutPage===current)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    section.hidden=!pages.length;
  }
  function clear(){feedback.textContent='';delete feedback.dataset.state;closeMenu();finishClosingMenu();clearTimeout(pressTimer);removedMemory=new Set();pinnedMemory=[];generation++;controller?.abort();ownerId='';memory={};lastPage='';links.replaceChildren();delete links.dataset.pages;section.hidden=true;pagePin.hidden=true;}
  function scopeToIdentity(identity){const id=String(identity?.id||identity?._id||'');if(identity?.role!==role||!validOwner(id)){clear();return;}if(id!==ownerId){clear();ownerId=id;}render();}
  async function record(){
    if(!ownerId)return;
    const page=shortcutPage(role,location.hash), previous=lastPage;lastPage=page?.key||location.hash;
    if(page?.matterId&&previous!==page.key){const expectedOwner=ownerId;try{const value=await resolveMatter?.(page.matterId,{ownerId:expectedOwner});if(ownerId!==expectedOwner||lastPage!==page.key||String(value?._id||value?.id||'').toLowerCase()!==page.matterId)return;}catch{if(ownerId===expectedOwner)void render();return;}}
    if(page&&previous!==page.key){const visits=read(),time=now(),times=visits[page.key]||[];if(!times.length||time-times.at(-1)>=SHORTCUT_RULES.cooldown){visits[page.key]=[...times,time].slice(-128);memory=visits;try{(storage||window.localStorage).setItem(key(),JSON.stringify({version:1,role,ownerId,visits}));}catch{storageFailed=true;/* Fall back to this session. */}}}
    render();
  }
  document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target)&&!menuOrigin?.contains(event.target))closeMenu();});
  document.addEventListener('keydown',event=>{if(menu&&event.key==='Escape'){const origin=menuOrigin;closeMenu();origin?.focus();}});
  window.addEventListener('hashchange',closeMenu);
  window.addEventListener('resize',closeMenu);
  window.addEventListener('storage',event=>{if(ownerId&&(event.key===key()||event.key===removedKey()||event.key===pinnedKey())){if(event.key===pinnedKey())pinnedMemory=[];closeMenu();render();}});
  return Object.freeze({scopeToIdentity,record,clear});
}
