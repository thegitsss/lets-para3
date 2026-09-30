import {node} from './dom.mjs';
// Presentation-only disclosure; existing forms retain their submit handlers/contracts.
export function compactFilters(form, {placeholder='Search', signal}={}) {
  form.classList.add('av2-compact-filters');
  const search=form.querySelector('input[type=search]');
  if(search) {search.placeholder=placeholder;search.setAttribute('aria-label',search.closest('label')?.textContent.trim() || placeholder);(search.closest('label') || search.parentElement)?.classList.add('av2-search-field');}
  const advanced=node('details',{className:'av2-filter-disclosure'},[node('summary',{text:'Filter', 'aria-label':'Filter options'})]);
  const panel=node('div',{className:'av2-filter-panel'});advanced.append(panel);
  for(const label of [...form.children]) {
    if(label.contains(search) || label===search) continue;
    if(label.matches('button[type=submit]')) {label.hidden=true;continue;}
    panel.append(label);
  }
  form.append(advanced);
  form.addEventListener('change',()=>form.requestSubmit());
  advanced.addEventListener('keydown',event=>{if(event.key==='Escape'){advanced.open=false;advanced.querySelector('summary').focus();}});
  document.addEventListener('pointerdown',event=>{if(!advanced.contains(event.target))advanced.open=false;},{signal});
  return advanced;
}
export function actionMenu(label, contents, signal) {
  const summary=node('summary',{'aria-label':label,'aria-expanded':'false',text:'⋯'});
  const menu=node('details',{className:'av2-context-menu'},[summary,node('div',{className:'av2-context-options'},contents)]);
  menu.addEventListener('toggle',()=>summary.setAttribute('aria-expanded',String(menu.open)));
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.open=false;summary.focus();}});
  menu.addEventListener('click',event=>{if(event.target.closest('button,a'))menu.open=false;});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))menu.open=false;},{signal});
  return menu;
}
