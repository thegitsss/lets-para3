import { FIELDS, LABELS, sameEntry, mergeSuggestions } from './resume-import-model.mjs';
const el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) { if(k === 'text') e.textContent = v; else if(k === 'class') e.className = v; else e.setAttribute(k,v); }
  e.append(...children); return e;
};
const button = (text, handler, secondary = false) => { const b = el('button', { type: 'button', class: secondary ? 'ri-secondary' : 'ri-primary', text }); b.addEventListener('click', handler); return b; };
const FIELD_LABELS = { title:'Role / employer', years:'Dates as written', description:'Description', school:'School', degree:'Degree / certificate', fieldOfStudy:'Field of study', grade:'Grade', activities:'Activities', startMonth:'Start month', startYear:'Start year', endMonth:'End month', endYear:'End year', name:'Language', proficiency:'Proficiency' };
export function resumeAnimation({ animate = true } = {}) {
  return el('div', { class:animate ? 'ri-animation' : 'ri-animation is-settled', 'aria-hidden':'true' }, [
    el('div', { class:'ri-paper' }, [el('span',{text:'Résumé'}), ...Array.from({length:5},()=>el('i'))]),
    el('div', { class:'ri-preview' }, ['Experience','Education','Skills'].map((text,i)=>el('div',{class:`ri-piece ri-piece-${i}`},[el('span',{text}),el('i'),el('i')]))),
    el('span',{class:'ri-spark',text:'✦'}),
  ]);
}
export function createResumeImport({ getProfile, getUser, readPolicy, extract, apply, canOpen, toast, presentation, onSaved, onManual }) {
  let dialog, controller, generation = 0, saving = false, inMemorySeen = false;
  const seenKey = () => `lpc_resume_intro_v1:${getUser()?._id || getUser()?.id}`;
  const seen = () => { try { return inMemorySeen || localStorage.getItem(seenKey()) === 'seen'; } catch { return inMemorySeen; } };
  const remember = () => { inMemorySeen = true; try { localStorage.setItem(seenKey(),'seen'); } catch {} };
  let trigger, reviewDraft = null;
  const decorate = () => presentation?.(dialog);
  const owner = () => String(getUser()?._id || getUser()?.id || '');
  function close() { if (saving) return; generation++; controller?.abort(); if(presentation && dialog?.querySelector('.ri-review-actions')) reviewDraft={dialog,owner:owner()};
    dialog?.close(); dialog?.remove(); dialog = null; requestAnimationFrame(() => (trigger?.isConnected ? trigger : document.querySelector('[data-resume-autofill]'))?.focus({preventScroll:true})); }
  function shell(title, copy) {
    dialog.replaceChildren();
    const heading = el('h2',{id:'ri-title',text:title});
    const dismiss = button('×',close,true); dismiss.classList.add('ri-close'); dismiss.setAttribute('aria-label','Dismiss résumé import');
    const body = el('div',{class:'ri-body'});
    dialog.append(dismiss, heading, el('p',{class:'ri-copy',text:copy}), body);
    return body;
  }
  async function open(origin, { automatic = false } = {}) {
    if (dialog?.open || (automatic && seen())) return;
    if (!canOpen()) { if (!automatic) toast('Finish or cancel your current Profile edit before importing.'); return; }
    trigger = origin; remember();
    if(reviewDraft && reviewDraft.owner===owner()) {
      dialog=reviewDraft.dialog;reviewDraft=null;document.body.append(dialog);dialog.showModal();decorate();dialog.querySelector('h2')?.focus();return;
    }
    reviewDraft=null;
    dialog = el('dialog',{class:'ri-dialog v2-settings-dialog','aria-labelledby':'ri-title'});
    dialog.addEventListener('cancel',event=>{ event.preventDefault(); close(); });
    let pressedOutside=false;
    const outside=event=>{const r=dialog?.getBoundingClientRect();return r&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};
    dialog.addEventListener('pointerdown',event=>{pressedOutside=event.target===dialog&&outside(event);});
    dialog.addEventListener('click',event=>{if(presentation&&pressedOutside&&event.target===dialog&&outside(event))close();pressedOutside=false;});
    document.body.append(dialog); dialog.showModal();
    await showWelcome();
  }
  async function showWelcome({ animate = true, focusDifferent = false } = {}) {
    const version = ++generation;
    const hasResume = Boolean(getUser()?.resumeURL || getUser()?.resumeKey);
    const body = shell(hasResume ? 'Your résumé has a head start.' : 'Your experience. Already written.', hasResume ? 'Use the résumé you submitted to fill in your experience, education, and skills. You’ll review everything before it’s saved.' : 'Upload your résumé and we’ll bring the details into your profile. Review everything before saving.');
    body.append(resumeAnimation({ animate }));
    const status = el('p',{role:'status',text:'Checking résumé processing options…'}); body.append(status);
    const run = button(hasResume ? 'Autofill from my résumé' : 'Choose résumé',()=> hasResume ? process('existing') : choose()); run.disabled = true;
    const manual = button(hasResume ? 'I’ll enter it myself' : 'Enter manually',()=>{close();onManual?.();},true);
    body.append(el('div',{class:'ri-actions'},[run,manual]));
    if (hasResume) { const different = button('Use a different résumé',()=>choose(),true); different.classList.add('ri-different'); different.disabled = true; body.append(different); }
    const processingCopy = el('p');
    const processing = el('details',{class:'ri-processing',hidden:''},[
      el('summary',{text:'How Autofill works'}), processingCopy,
    ]);
    body.append(processing); decorate();
    try { const policy = await readPolicy(); if (version !== generation || !dialog?.open) return; status.hidden = Boolean(policy.enabled); status.textContent = policy.enabled ? '' : 'Résumé Autofill is awaiting local review. You can enter your details manually.'; processingCopy.textContent = policy.disclosure || ''; processing.hidden = !policy.enabled || !policy.disclosure; run.disabled = !policy.enabled; body.querySelectorAll('button').forEach(b => { if(b.textContent==='Use a different résumé') b.disabled = !policy.enabled; }); }
    catch { if(version === generation && dialog?.open) status.textContent = 'Processing options are unavailable. Please try again later or enter details manually.'; }
    if (version === generation && dialog?.open) (focusDifferent ? body.querySelector('.ri-different') || run : run).focus();
  }
  function choose() {
    const body = shell('Use a different résumé', 'This file is only for Autofill. Your saved résumé attachment will stay as it is.');
    const input = el('input',{type:'file',id:'ri-resume-file',accept:'.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document','aria-label':'Choose résumé','aria-describedby':'ri-file-guidance'});
    const title = el('label',{id:'ri-file-label',for:'ri-resume-file',text:'Upload your résumé'});
    const hint = el('span',{class:'ri-dropzone-hint',text:'Choose a file or drag it here.'});
    const formats = el('small',{id:'ri-file-guidance',text:'PDF, DOC, or DOCX · Up to 10 MB'});
    const zone = el('div',{class:'ri-dropzone',role:'group','aria-labelledby':'ri-file-label'},[title, hint, input, formats]);
    const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
    for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) icon.setAttribute(key,value);
    const path = document.createElementNS(icon.namespaceURI,'path'); path.setAttribute('d','M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5'); icon.append(path);
    zone.append(el('div',{class:'ri-drop-preview','aria-hidden':'true'},[icon,el('strong',{text:'Add your résumé'}),el('span',{text:'Drop your file here to read it.'})]));
    const status = el('p',{class:'ri-file-status',role:'status','aria-live':'polite',hidden:''});
    let reading = false, dragDepth = 0;
    const selectFile = files => {
      if (reading || !input.isConnected || !dialog?.open) return;
      const file = files?.[0];
      const valid = files?.length === 1 && file.size > 0 && file.size <= 10*1024*1024 && /\.(pdf|doc|docx)$/i.test(file.name);
      if (!valid) {
        input.value = ''; status.hidden = false;
        status.textContent = 'Choose one PDF, DOC, or DOCX, up to 10 MB.';
        return;
      }
      reading = true;
      void process('different',file);
    };
    input.addEventListener('change',()=>selectFile(input.files));
    zone.addEventListener('dragenter',event=>{event.preventDefault();dragDepth++;zone.classList.add('is-dragging');});
    zone.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';});
    zone.addEventListener('dragleave',event=>{event.preventDefault();if(--dragDepth<=0){dragDepth=0;zone.classList.remove('is-dragging');}});
    zone.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;zone.classList.remove('is-dragging');selectFile(event.dataTransfer?.files);});
    const back=button('Back',()=>showWelcome({animate:false,focusDifferent:true}),true);back.classList.add('resume-back');body.append(zone,status,back);decorate(); input.focus();
  }
  async function process(source, file) {
    const baseline = structuredClone(getProfile());
    const body = shell('Let’s bring your experience in.', 'Reading your résumé. Your saved profile stays as it is.');
    body.append(el('p',{role:'status',text:'Extracting readable text and matching profile sections…'}),button('Cancel',close,true));
    decorate(); controller = new AbortController(); const version = ++generation;
    try { const result = await extract(source,file,controller.signal); if(version !== generation || !dialog?.open) return; review(result,baseline); }
    catch(error) { if(version !== generation || !dialog?.open) return; const errorBody = shell('A little help is needed.',error.message || 'Your résumé could not be read. Your saved profile is unchanged.'); errorBody.append(button('Try again',()=>process(source,file)),button('Use a different résumé',choose,true),button('Enter manually',close,true)); }
  }
  function review(result, baseline) {
    const body = shell('A head start. Your final say.', 'Edit the suggestions and choose what to save. Existing entries are kept; selecting an About or LinkedIn suggestion replaces that field.');
    body.append(el('p',{class:'ri-note',...(result.warnings?.length?{'data-has-warnings':'true'}:{}),text:result.warnings?.join(' ') || 'Review each suggestion against your résumé.'}));
    const rows = [];
    for (const suggestion of [...(result.suggestions || [])].sort((a,b) => Object.keys(FIELDS).indexOf(a.field) - Object.keys(FIELDS).indexOf(b.field))) {
      if (!Object.hasOwn(FIELDS,suggestion.field)) continue;
      const {field,source} = suggestion;
      const value = structuredClone(suggestion.value);
      const duplicates = Array.isArray(baseline[field]) && baseline[field].some(entry=>sameEntry(field,entry,value));
      const row = {field,value,selected:!duplicates && (Array.isArray(baseline[field]) || !baseline[field])}; rows.push(row);
      const card = el('section',{class:'ri-suggestion'});
      const check = el('input',{type:'checkbox','aria-label':`Apply ${LABELS[field]} suggestion ${rows.length}`}); check.checked = row.selected; check.disabled = duplicates;
      check.addEventListener('change',()=>row.selected=check.checked);
      card.append(el('label',{class:'ri-select'},[check,el('strong',{text:LABELS[field]}),el('span',{text:duplicates ? 'Already on your profile — kept' : Array.isArray(baseline[field]) ? 'Add to profile' : baseline[field] ? 'Replace current value' : 'Fill empty field'})]));
      if (!Array.isArray(baseline[field]) && baseline[field]) card.append(el('p',{class:'ri-current',text:`Current: ${baseline[field]}`}));
      const keys = FIELDS[field];
      const extras = el('details',{class:'ri-extra-fields'},[el('summary',{text:'Add missing details'})]);
      for(const key of keys || ['value']) {
        const label = el('label',{class:'ri-field'},[el('span',{text:keys ? FIELD_LABELS[key] : LABELS[field]})]);
        const control = el(['description','bio'].includes(key) || field==='bio' ? 'textarea' : 'input', { ...(key==='description' || field==='bio' ? {rows:'3'} : {type:'text'}), maxlength: key === 'description' ? '5000' : key === 'title' ? '300' : key === 'activities' ? '1000' : key === 'grade' ? '120' : key.endsWith('Month') ? '20' : key.endsWith('Year') ? '10' : field === 'bio' ? '4000' : key==='name'||key==='proficiency'||key==='years' ? '120' : field==='linkedInURL' ? '500' : '200' });
        control.value = keys ? value[key] || '' : value; control.disabled = duplicates;
        control.addEventListener('input',()=>{ if(keys) row.value[key] = control.value.trim(); else row.value = control.value.trim(); });
        label.append(control); if(keys && field==='education' && !value[key]) extras.append(label); else card.append(label);
      }
      if (extras.children.length > 1) card.append(extras);
      card.append(el('details',{},[el('summary',{text:'From your résumé'}),el('blockquote',{text:source || ''})])); body.append(card);
    }
    const status = el('p',{role:'status','aria-live':'polite'});
    if (!rows.length) status.textContent='No compatible suggestions were found. Try a résumé with clearly labeled Experience, Education and Skills sections, or enter your details manually.';
    const save = button('Apply selected changes',async()=>{
      let patch;
      try { patch = mergeSuggestions(baseline,rows); if(!presentation&&!Object.keys(patch).length) {status.textContent='Choose a new suggestion to apply. Existing entries are already kept.';return;} }
      catch(error) {status.textContent=error.message;return;}
      const controlStates=new Map([...body.querySelectorAll('input,textarea,select,button')].map(control=>[control,control.disabled]));
      saving = true; save.disabled = true; dialog.querySelector('.ri-close').disabled = true; dialog.setAttribute('aria-busy','true'); body.querySelectorAll('input,textarea,select,button').forEach(control=>control.disabled=true); status.textContent='Saving selected changes…';
      try { if(Object.keys(patch).length)await apply(patch,baseline); saving=false; const completed=dialog;close();reviewDraft=null;completed?.remove();if(onSaved)onSaved();else toast('Selected résumé details saved. Your résumé attachment is unchanged.'); }
      catch(error) {status.textContent=error.message || 'Saving was not confirmed. Your draft is still here. Check the saved profile before retrying.';}
      finally {saving=false; if(dialog?.open) {dialog.querySelector('.ri-close').disabled = false;dialog.removeAttribute('aria-busy');controlStates.forEach((disabled,control)=>control.disabled=disabled);} }
    });
    save.disabled = !rows.length;
    body.append(status,el('div',{class:'ri-actions ri-review-actions'},[save,button('Cancel',close,true)])); decorate();dialog.querySelector('h2').tabIndex=-1; dialog.querySelector('h2').focus();
  }
  return { open, close, isOpen:()=>Boolean(dialog?.open), showFirstVisit(trigger) { if(!seen()) void open(trigger,{automatic:true}); }, destroy(){saving=false;close();reviewDraft?.dialog.remove();reviewDraft=null;} };
}
