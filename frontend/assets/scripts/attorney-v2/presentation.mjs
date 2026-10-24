import {node} from './dom.mjs';
import {createAppliedFilters} from '../utils/applied-filters.mjs';
import {portalIcon} from '../utils/portal-controls.mjs';
// Presentation-only disclosure; existing forms retain their submit handlers/contracts.
export function compactFilters(form, {placeholder='Search', signal}={}) {
  form.classList.add('av2-compact-filters');
  const search=form.querySelector('input[type=search]');
  if(search) {
    // Explicit labels also need to resolve while this form is still detached.
    const label=search.closest('label') || [...form.querySelectorAll('label')].find(label=>label.htmlFor===search.id) || search.labels?.[0];
    search.placeholder=placeholder;search.setAttribute('aria-label',label?.textContent.trim() || placeholder);(search.closest('label') || search.parentElement)?.classList.add('av2-search-field');
  }
  const advanced=node('details',{className:'av2-filter-disclosure'},[node('summary',{'aria-label':'Filters',title:'Filters'},[portalIcon('filter')])]);
  const panel=node('div',{className:'av2-filter-panel'});advanced.append(panel);
  for(const label of [...form.children]) {
    if(label.contains(search) || label===search) continue;
    if(label.matches('button[type=submit]')) {if(search){label.textContent='Search';label.classList.add('av2-secondary');}else label.hidden=true;continue;}
    panel.append(label);
  }
  // Keep sorting independent from filter resets.
  const filterFields = [...panel.querySelectorAll('select')].filter(control => !/sort/i.test(control.name || control.closest('label')?.querySelector('span')?.textContent || ''));
  for (const control of panel.querySelectorAll('select')) if (!filterFields.includes(control)) form.append(control.closest('label') || control);
  for (const control of panel.querySelectorAll('button')) if (/clear filters/i.test(control.textContent)) control.hidden = true;
  const applied = createAppliedFilters(filterFields.map((control, index) => ({control, defaultValue:control.options[0].value, label:control.getAttribute('aria-label') || control.closest('label')?.querySelector('span')?.textContent || 'Filter', key:String(index)})), () => form.requestSubmit());
  form.append(advanced, applied.element);
  form.addEventListener('change',event=>{if(event.target.matches('select,input[type=checkbox],input[type=radio]'))form.requestSubmit();});
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
