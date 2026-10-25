import {applyAppearance,normalizeAppearance,createReadingSizeControl} from './appearance.mjs';
export const ACCENTS=Object.freeze([['cornflower','Cornflower'],['violet','Violet'],['teal','Teal'],['rose','Rose']]);
export const normalizeAccent=value=>ACCENTS.some(([key])=>key===value)?value:'cornflower';
export function applyAccent(value){const next=normalizeAccent(value);if(typeof document!=='undefined')document.documentElement.dataset.lpcAccent=next;return next;}
function optionsControl(values,value,{label,onChange,theme=false}){
 const element=document.createElement('div');element.className=theme?'v2-settings-theme-options lpc-theme-choices':'lpc-accent-choices';element.setAttribute('role','radiogroup');element.setAttribute('aria-label',label);
 function sync(next){for(const b of element.children){b.setAttribute('aria-checked',String(b.dataset.value===next));b.tabIndex=b.dataset.value===next?0:-1;}}
 for(const [key,name]of values){const button=document.createElement('button');button.type='button';button.dataset.value=key;button.setAttribute('role','radio');button.setAttribute('aria-label',name);button.className=theme?'v2-settings-theme':'lpc-accent-choice';if(theme){button.title=key==='system'?'Light 7 a.m.–7 p.m.; dark overnight (local time)':name;const img=document.createElement('img');img.src=`assets/images/lpc-appearance-${key==='system'?'auto':key}.svg`;img.alt='';img.width=144;img.height=90;button.append(img);}else{const swatch=document.createElement('span');swatch.className='lpc-accent-swatch';swatch.dataset.accent=key;swatch.setAttribute('aria-hidden','true');button.append(swatch);}button.append(document.createTextNode(name));button.addEventListener('click',()=>{sync(key);onChange(key);});button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const keys=values.map(([key])=>key),at=keys.indexOf(button.dataset.value),n=event.key==='Home'?0:event.key==='End'?keys.length-1:(at+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+keys.length)%keys.length;element.children[n].focus();element.children[n].click();});element.append(button);}
 sync(value);return {element,sync,disable(value){for(const b of element.children)b.disabled=value;}};
}
export function createThemeChoices(value,onChange){return optionsControl([['light','Light'],['dark','Dark'],['system','Auto']],normalizeAppearance(value),{label:'Appearance',onChange,theme:true});}
export function createAccentChoices(value,onChange){return optionsControl(ACCENTS,normalizeAccent(value),{label:'Accent color',onChange});}
export function enhanceAppearanceRow(row,key,value,{onPreview}={}){
 const native=row.querySelector('select');const wrapper=native.closest('.av2-account-field');wrapper.hidden=true;
 let ui;
 if(key==='theme')ui=createThemeChoices(value,next=>{applyAppearance(next);native.value=next;native.dispatchEvent(new Event('change',{bubbles:true}));});
 else if(key==='accentColor')ui=createAccentChoices(value,next=>{applyAccent(next);native.value=next;native.dispatchEvent(new Event('change',{bubbles:true}));});
 else {ui=createReadingSizeControl(value,{onPreview});ui.control.addEventListener('change',()=>{native.value=ui.control.value;native.dispatchEvent(new Event('change',{bubbles:true}));});}
 const heading=document.createElement('h3');heading.className='lpc-appearance-label';heading.textContent=key==='accentColor'?'Accent color':'';if(heading.textContent)row.prepend(heading);row.insertBefore(ui.element,wrapper);
 const sync=()=>{ui.sync(key==='theme'?normalizeAppearance(native.value):native.value);if(key==='theme')applyAppearance(native.value);if(key==='accentColor')applyAccent(native.value);if(ui.disable)ui.disable(native.disabled);else ui.control.disabled=native.disabled;};native.addEventListener('lpc-preference-sync',sync);new MutationObserver(sync).observe(native,{attributes:true,attributeFilter:['disabled']});return row;
}
