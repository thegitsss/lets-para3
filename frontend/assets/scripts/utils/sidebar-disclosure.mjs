const animations=new WeakMap();
export function toggleSidebarList(panel, open, { details } = {}) {
 if(!panel)return;
 panel.inert=!open;
 if(!animations.has(panel)&&(details?details.open:!panel.hidden)===open)return;
 const current=panel.getBoundingClientRect().height;
 animations.get(panel)?.cancel();
 const finish=()=>{if(details)details.open=open;else panel.hidden=!open;panel.style.removeProperty('overflow');};
 if(matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
 if(details)details.open=true;else panel.hidden=false;
 const natural=panel.scrollHeight;
 panel.style.overflow='hidden';
 const frames=open?[{height:`${current}px`,opacity:current?1:0},{height:`${natural+3}px`,opacity:1,offset:.72},{height:`${natural}px`,opacity:1}]:[{height:`${current}px`,opacity:1},{height:`${current+2}px`,opacity:1,offset:.18},{height:'0px',opacity:0}];
 const animation=panel.animate(frames,{duration:220,easing:'ease-out',fill:'both'});animations.set(panel,animation);
 animation.onfinish=()=>{if(animations.get(panel)!==animation)return;finish();animation.cancel();animations.delete(panel);};
}
export function bindSidebarDetails(details) {
 const summary=details?.querySelector(':scope > summary'),panel=details?.querySelector(':scope > .v2-more-tools-list');if(!summary||!panel)return;
 let open=details.open;
 summary.setAttribute('aria-expanded',String(open));
 details.addEventListener('toggle',()=>{if(!animations.has(panel)){open=details.open;summary.setAttribute('aria-expanded',String(open));}});
 summary.addEventListener('click',event=>{event.preventDefault();open=!open;summary.setAttribute('aria-expanded',String(open));toggleSidebarList(panel,open,{details});});
}
