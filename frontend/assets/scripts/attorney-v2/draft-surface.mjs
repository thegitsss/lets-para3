import {normalizeRequirement, needsRequirementClarification, requirementSuggestions} from './requirement-entry.mjs';
import {canvasValue} from './canvas-value.mjs';
import {node, button} from './dom.mjs';
import {draftErrors, dollarCents} from '../matter-draft-contract.mjs';
const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits: cents % 100 ? 2 : 0}).format(cents/100);
const labels={title:'Matter',description:'Scope',tasks:'Tasks',practiceArea:'Practice area',state:'State',compAmount:'Compensation',deadline:'Deadline',experience:'Experience',requirements:'Requirements'};

// Native inputs keep inline editing accessible to keyboard and touch users.
export function createDraftSurface({controls, panel, review, state, edit, focus, canvas=false}) {
  for(const [key,control] of Object.entries(controls)) {
    control.closest('.av2-field').querySelector('label').textContent=labels[key];
    control.classList.add('av2-compose-inline');
  }
  controls.title.placeholder='Name your Matter';
  controls.description.placeholder='Describe the scope of work'; controls.description.rows=3;
  controls.compAmount.placeholder=canvas?'400 minimum':'Set compensation';
  controls.state.options[0].textContent='Select state';
  controls.practiceArea.options[0].textContent='Select practice area';
  const deadlinePlaceholder=button('Add deadline',()=>{deadlinePlaceholder.hidden=true;controls.deadline.hidden=false;controls.deadline.focus();try{controls.deadline.showPicker();}catch{}},'av2-compose-example');
  if(!canvas)controls.deadline.before(deadlinePlaceholder);
  const editors={};
  if(canvas)for(const [key,control] of Object.entries(controls).filter(([key])=>!['deadline','compAmount'].includes(key)))editors[key]=canvasValue(control,{persistent:()=>!state.values.sourceDescription?.trim()&&!state.values.appliedSourceDescription?.trim(),label:labels[key].toLowerCase(),placeholder:({title:'Name your Matter',description:'Describe the scope',practiceArea:'Select practice area',state:'Select state',compAmount:'Set compensation',experience:'No minimum',deadline:'Add deadline'})[key],format:value=>key==='compAmount'&&dollarCents(value)!==null?money(dollarCents(value)):key==='deadline'?globalThis.LPCBusinessDate.format(value)||value:control.tagName==='SELECT'?control.selectedOptions[0]?.textContent||value:value});
  if(canvas){
    const date=controls.deadline, amount=controls.compAmount;
    date.hidden=false;amount.hidden=false;
    const dateEntry=node('div',{className:'av2-canvas-date-entry'});
    date.before(dateEntry);dateEntry.append(date);
    const calendar=button('',()=>{
      date.focus();
      try{date.showPicker?.();}catch{ /* Keep keyboard entry available when a picker is unavailable. */ }
    },'av2-canvas-calendar');
    calendar.setAttribute('aria-label','Choose deadline');
    calendar.setAttribute('title','Choose deadline');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');
    path.setAttribute('d','M8 3v4m8-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z');
    svg.append(path);calendar.append(svg);dateEntry.append(calendar);
    const amountEntry=node('div',{className:'av2-canvas-amount-entry'});
    amount.before(amountEntry);amountEntry.append(node('span',{'aria-hidden':'true',text:'$'}),amount);
  }
  controls.deadline.addEventListener('blur',()=>{if(!canvas&&!controls.deadline.value){controls.deadline.hidden=true;deadlinePlaceholder.hidden=false;}});
  const requirements=node('div',{className:'av2-compose-requirements'},[node('h2',{text:canvas?'Requirements':'Matter requirements'}),...(!canvas?[node('p',{className:'av2-muted',text:'Add any requirements a paralegal must meet to work on this Matter.'})]:[])]);
  const chips=node('div',{className:'av2-compose-requirement-list'});
  const input=node('input',{type:'text',maxlength:200,'aria-label':'New requirement',placeholder:canvas?'e.g. Clio proficiency':'For example, Clio proficiency'});
  const feedback=node('p',{role:'status',className:'av2-muted'});
  const entry=node('div',{className:'av2-actions av2-requirement-entry'});
  entry.hidden=!canvas;
  const add=button('+ Add requirement',()=>{entry.hidden=false;add.hidden=true;input.focus();},'av2-compose-example');
  const suggestions=node('div',{className:'av2-requirement-suggestions',role:'group','aria-label':'Requirement suggestions',hidden:''});
  const keep=button('Use as written',()=>commit(true),'av2-compose-example');keep.hidden=true;
  feedback.id='av2-requirement-feedback';input.setAttribute('aria-describedby',feedback.id);input.setAttribute('autocapitalize','sentences');
  function clearFeedback(){feedback.textContent='';keep.hidden=true;}
  function suggest(){
    suggestions.replaceChildren();
    const query=input.value.trim().toLowerCase();
    const matches=query?requirementSuggestions.filter(value=>value.toLowerCase().includes(query)&&!(state.values.requirements||[]).some(item=>item.toLowerCase()===value.toLowerCase())).slice(0,3):[];
    for(const value of matches){
      const choice=button(value,()=>{input.value=value;commit();input.focus();},'av2-requirement-suggestion');
      choice.addEventListener('pointerdown',event=>event.preventDefault());
      suggestions.append(choice);
    }
    suggestions.hidden=!matches.length;
  }
  function commit(acceptUnclear=false){
    const value=canvas?normalizeRequirement(input.value):input.value.trim(), list=state.values.requirements || [];
    if(!value)return true;
    input.value=value;
    if(list.length>=12||list.some(item=>item.toLowerCase()===value.toLowerCase())){feedback.textContent=list.length>=12?'Use up to 12 requirements.':'That requirement is already listed.';keep.hidden=true;return false;}
    if(canvas&&!acceptUnclear&&needsRequirementClarification(value)){
      feedback.textContent=value.split(/\s+/).length<2?'What should the paralegal know or be able to do?':'Review this custom requirement. Applicants must meet it.';keep.hidden=false;return false;
    }
    input.value='';entry.hidden=!canvas;clearFeedback();suggestions.hidden=true;edit({...state.values,pendingRequirement:'',requirements:[...list,value]});if(!canvas)add.focus();return true;
  }
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();if(!event.isComposing)commit();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!suggestions.hidden)suggestions.hidden=true;else closeEntry();}});
  function closeEntry(){entry.hidden=!canvas;input.value='';if(canvas)edit({...state.values,pendingRequirement:''});clearFeedback();suggestions.hidden=true;add.hidden=canvas||(state.values.requirements||[]).length>=12;if(!canvas)add.focus();}
  entry.append(input);
  if(canvas){
    entry.append(suggestions);
    input.addEventListener('input',()=>{clearFeedback();edit({...state.values,pendingRequirement:input.value});suggest();});
    input.addEventListener('focus',suggest);
    input.addEventListener('blur',()=>{input.value=normalizeRequirement(input.value);if(input.value!==(state.values.pendingRequirement||''))edit({...state.values,pendingRequirement:input.value});});
    entry.addEventListener('focusout',()=>queueMicrotask(()=>{if(!entry.contains(document.activeElement))suggestions.hidden=true;}));
  }else entry.append(button('Add',()=>commit(),'av2-secondary'),button('Cancel',closeEntry,'av2-compose-example'));
  const note=node('p',{className:'av2-muted av2-compose-requirements-note',text:canvas?'Applicants must meet all requirements.':'Paralegals who do not meet every listed requirement will not be able to apply.'});
  requirements.append(chips,add,entry,feedback,keep,note);
  let options,optionsBody,optionsToggle,lastOptionsValue;
  function showAdditional(open=true){
    if(!optionsBody)return;
    optionsBody.hidden=!open;optionsToggle.textContent=(open?'−':'+')+' Additional options';optionsToggle.setAttribute('aria-expanded',String(open));
  }
  if(canvas){
    controls.experience.closest('.av2-field').querySelector('label').textContent='Minimum experience';
    controls.deadline.closest('.av2-field').querySelector('label').textContent='Deadline (optional)';
    optionsBody=node('div',{id:'av2-draft-additional-options',className:'av2-additional-options-body',hidden:'',role:'region','aria-label':'Additional options'},[controls.experience.closest('.av2-field'),requirements]);
    optionsToggle=button('+ Additional options',()=>{
      const opening=optionsBody.hidden;
      showAdditional(opening);
      if(opening)requestAnimationFrame(()=>{
        if(optionsBody.hidden||!options.isConnected)return;
        const scroller=options.closest('.av2-creation-content');
        if(!scroller)return;
        const bounds=scroller.getBoundingClientRect();
        const footer=panel.querySelector('.av2-draft-step-actions')?.getBoundingClientRect();
        const bottom=Math.min(bounds.bottom,footer?.top??bounds.bottom)-16;
        const region=options.getBoundingClientRect();
        const distance=Math.max(0,Math.min(region.bottom-bottom,region.top-bounds.top-16));
        if(distance)scroller.scrollBy({top:distance,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
      });
    },'av2-compose-example av2-additional-options-toggle');
    optionsToggle.setAttribute('aria-expanded','false');optionsToggle.setAttribute('aria-controls',optionsBody.id);
    options=node('div',{className:'av2-additional-options'},[optionsToggle,optionsBody]);
    panel.querySelector('.av2-draft-step-actions').before(options);
  }else panel.querySelector('.av2-draft-step-actions').before(requirements);
  function update(){
    if(canvas&&document.activeElement!==input)input.value=state.values.pendingRequirement||'';
    const optionsValue=JSON.stringify([state.values.experience||'',state.values.requirements||[],state.values.pendingRequirement||'']);
    if(optionsValue!==lastOptionsValue&&(state.values.experience||state.values.pendingRequirement||(state.values.requirements||[]).length))showAdditional();
    lastOptionsValue=optionsValue;
    const manual=canvas&&!state.values.sourceDescription?.trim()&&!state.values.appliedSourceDescription?.trim();
    controls.title.closest('.av2-field').querySelector('label').textContent=manual?'Title':'Matter';
    controls.title.placeholder=manual?'For example, trial binder preparation':'Name your Matter';
    controls.description.placeholder=manual?'Prepare a tabbed trial binder from the provided documents.':'Describe the scope of work';
    if(!panel.hidden){controls.description.style.height="auto";controls.description.style.height=Math.max(64,controls.description.scrollHeight+2)+"px";}
    if(!canvas){deadlinePlaceholder.hidden=Boolean(state.values.deadline)||document.activeElement===controls.deadline;
    controls.deadline.hidden=!deadlinePlaceholder.hidden;}
    Object.values(editors).forEach(editor=>editor.update());
    chips.replaceChildren();
    (state.values.requirements || []).forEach((value,index)=>{
      const remove=button('×',()=>{edit({...state.values,requirements:state.values.requirements.filter((_,i)=>i!==index)});(canvas?input:add).focus();},'av2-compose-remove');remove.setAttribute('aria-label',`Remove requirement: ${value}`);
      chips.append(node('span',{className:'av2-compose-requirement'},[node('span',{text:value}),remove]));
    });
    note.hidden=!(state.values.requirements || []).length;
    add.hidden=canvas||!entry.hidden||(state.values.requirements || []).length>=12;
    if(canvas)input.disabled=(state.values.requirements||[]).length>=12;
    const data=state.values, errors=draftErrors(data), cents=dollarCents(data.compAmount);
    review.replaceChildren();
    if(Object.keys(errors).length){
      const missing=node('section',{className:'av2-compose-missing','aria-label':'Before publishing'});
      const [key,message]=Object.entries(errors)[0];
      missing.append(node('p',{text:key==='compAmount'&&!data.compAmount?'Compensation is still needed.':message}),button(key==='compAmount'?'Add compensation':`Review ${labels[key].toLowerCase()}`,()=>focus(key),'av2-compose-example'));
      review.append(missing);
    }
    const title=node('h2',{className:'av2-compose-posting-title',text:data.title || 'Untitled Matter'});
    if(canvas){const editTitle=button('Edit Matter details',()=>focus('title'),'av2-compose-example');review.append(editTitle);}
    review.append(title);
    const date=data.deadline?globalThis.LPCBusinessDate.format(data.deadline):'';
    review.append(node('p',{className:'av2-compose-posting-meta',text:[data.practiceArea,data.state,date?`Due ${date}`:''].filter(Boolean).join(' · ')}));
    if(cents!==null)review.append(node('p',{className:'av2-compose-posting-price',text:`${money(cents)} flat fee`}));
    for(const [heading,value] of [['Scope',data.description],['Tasks',data.tasks.map(t=>t.title)],['Requirements',data.requirements || []]]){
      if(!value.length)continue;
      const sectionHeading=node('h3',{text:heading});
      if(canvas){const correction=button('Edit',()=>focus(({Scope:'description',Tasks:'tasks',Requirements:'requirements'})[heading]),'av2-canvas-correction');correction.setAttribute('aria-label',`Edit ${heading.toLowerCase()}`);sectionHeading.append(correction);}
      review.append(node('section',{className:'av2-compose-posting-section'},[sectionHeading,Array.isArray(value)?node('ul',{},value.map(text=>node('li',{text}))):node('p',{text:value})]));
    }
    review.append(node('p',{className:'av2-muted',text:`Experience: ${data.experience || 'No minimum'}`}));
  }
  return {update,requirements,input,add,showAdditional,prepareReview:()=>{const ready=commit();if(!ready){showAdditional();input.focus();input.scrollIntoView({block:'center'});}return ready;},focus:key=>{if(key==='experience')showAdditional();return editors[key]?editors[key].open():controls[key]?.focus();}};
}
