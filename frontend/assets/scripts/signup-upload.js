/* Résumé selection UI. The existing registration request owns the upload. */
window.LPCResumeUpload = {
 mount(input) {
  if (!input) return;
  if (input.resumeUI) { input.resumeUI.refresh(); return; }
  const root = input.closest('.signup-resume-cell');
  root.classList.add('lpc-resume-upload');
  root.insertAdjacentHTML('beforeend', `<div class="resume-zone" aria-label="Résumé upload">
   <div class="resume-empty"><div class="resume-art" aria-hidden="true"><div class="resume-back"></div><div class="resume-paper"></div><div class="resume-paper second"></div><div class="resume-front"></div></div>
   <button type="button" class="resume-link" data-browse>Upload résumé</button></div>
   <div class="resume-result" hidden><div class="resume-filetext"><div class="resume-filename"></div><div class="resume-sub" data-status role="status"></div><div class="resume-actions"><button type="button" class="resume-link" data-replace>Replace</button><button type="button" class="resume-link" data-remove>Remove</button></div></div></div>
  </div><div id="resumeFileHint" class="resume-error" role="alert" hidden></div>`);
  const zone = root.querySelector('.resume-zone'), empty = root.querySelector('.resume-empty'), result = root.querySelector('.resume-result'), error = root.querySelector('.resume-error'), status = root.querySelector('[data-status]');
  input.setAttribute('aria-describedby', 'resumeFileHint');
  input.tabIndex = -1;
  let selected = input.files?.[0] || null, timer, depth = 0, busy = false, folderMotion, fileMotion;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const assign = file => { const transfer = new window.DataTransfer(); if (file) transfer.items.add(file); input.files = transfer.files; };
  const showError = message => { error.textContent = message; error.hidden = !message; input.setAttribute('aria-invalid', String(!!message)); };
  const render = (animate = false) => {
   const art = root.querySelector('.resume-art');
   const from = art.getBoundingClientRect();
   const revealing = result.hidden && !!selected;
   folderMotion?.cancel(); fileMotion?.cancel();
   zone.classList.remove('settling');
   empty.hidden = false; root.querySelector('[data-browse]').hidden = !!selected; result.hidden = !selected;
   root.querySelector('.resume-filename').textContent = selected?.name || '';
   root.querySelector('.resume-filename').title = selected?.name || '';
   status.textContent = selected ? 'Selected · ready to submit' : '';
   if (animate && !reduced.matches) {
    const to = art.getBoundingClientRect();
    folderMotion = art.animate([
     { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
     { transform: 'translate(0, 0)' }
    ], { duration: 440, easing: 'cubic-bezier(.22,1,.36,1)' });
    if (revealing) fileMotion = result.animate([
     { opacity: 0, transform: 'translateY(6px)' },
     { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 260, delay: 100, fill: 'backwards', easing: 'ease-out' });
   }
  };
  const choose = files => {
   if (busy || !files.length) return;
   const file = files[0];
   let problem = files.length !== 1 ? 'Choose one résumé PDF.' : !/\.pdf$/i.test(file.name) || (file.type && file.type !== 'application/pdf') ? 'Choose a PDF résumé.' : file.size > 10 * 1024 * 1024 ? 'Résumé must be 10 MB or smaller.' : !file.size ? 'This file is empty. Choose a PDF résumé.' : '';
   if (problem) { assign(selected); showError(problem); return; }
   clearTimeout(timer); selected = file; assign(file); showError('');
   zone.classList.remove('over'); depth = 0;
   // Cosmetic paper settling only; the file is selected, not uploaded.
   input.dispatchEvent(new Event('input', { bubbles: true }));
   if (reduced.matches || !result.hidden) { render(); return; }
   const focused = root.contains(document.activeElement);
   empty.hidden = false; result.hidden = true; zone.classList.add('settling');
   timer = setTimeout(() => { if (!root.isConnected) return; render(true); if (focused) root.querySelector('[data-replace]').focus({preventScroll:true}); }, 650);
  };
  root.querySelector('[data-browse]').onclick = root.querySelector('[data-replace]').onclick = () => { if (!busy) input.click(); };
  zone.addEventListener('click', event => { if (!event.target.closest('button') && !busy && !input.disabled) input.click(); });
  root.querySelector('[data-remove]').onclick = () => { if (busy) return; clearTimeout(timer); selected = null; assign(null); showError(''); render(true); input.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector('[data-browse]').focus({preventScroll:true}); };
  input.addEventListener('change', () => choose([...input.files]));
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  zone.addEventListener('dragenter', e => { stop(e); if (!busy) { depth++; zone.classList.add('over'); } });
  zone.addEventListener('dragover', e => { stop(e); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; });
  zone.addEventListener('dragleave', e => { stop(e); if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } });
  zone.addEventListener('drop', e => { stop(e); depth = 0; zone.classList.remove('over'); choose([...e.dataTransfer.files]); });
  reduced.addEventListener('change', () => { if (reduced.matches) { clearTimeout(timer); render(); } });
  input.resumeUI = {
   refresh() { clearTimeout(timer); render(); },
   busy(value) { busy = value; clearTimeout(timer); render(); const hidden = !!input.closest('[hidden], [inert]'); for (const control of [input, ...root.querySelectorAll('button')]) { control.disabled = value || hidden; if (!value && hidden) control.dataset.disabledByStepFlow = 'true'; } if (value) status.textContent = 'Submitting with your application…'; },
   error(message) { showError(message); }
  };
  render();
 }
};
window.LPCResumeUpload.mountCertificate = input => {
 if (!input || input.dataset.certificateMounted) return;
 input.dataset.certificateMounted = 'true';
 const wrapper = input.parentElement;
 wrapper.classList.add('lpc-certificate-upload');
 wrapper.insertAdjacentHTML('beforeend', `<div class="certificate-zone"><button type="button" class="certificate-pick" data-cert-choose aria-label="Upload certificate"><span class="certificate-details"><span data-cert-name>Certificate</span></span><span data-cert-action hidden>Replace</span></button><div class="certificate-actions"><button type="button" data-cert-remove hidden>Remove</button></div></div>`);
 const zone=wrapper.querySelector('.certificate-zone'), name=wrapper.querySelector('[data-cert-name]'), choose=wrapper.querySelector('[data-cert-choose]'), action=wrapper.querySelector('[data-cert-action]'), remove=wrapper.querySelector('[data-cert-remove]'), error=document.getElementById('certFileHint');
 error.setAttribute('role','alert'); input.setAttribute('aria-describedby','certFileHint'); input.tabIndex=-1;
 let selected=null,depth=0;
 const assign=file=>{const dt=new window.DataTransfer();if(file)dt.items.add(file);input.files=dt.files;};
 const render=()=>{name.textContent=selected?.name||'Certificate';name.title=selected?.name||'';action.hidden=!selected;choose.setAttribute('aria-label',selected?'Replace':'Upload certificate');remove.hidden=!selected;};
 const accept=files=>{if(input.disabled||!files.length)return;const file=files[0];const message=files.length!==1?'Choose one certificate PDF.':!/\.pdf$/i.test(file.name)||(file.type&&file.type!=='application/pdf')?'Choose a PDF certificate.':file.size>10*1024*1024?'Certificate must be 10 MB or smaller.':!file.size?'This file is empty. Choose a PDF certificate.':'';error.textContent=message;input.setAttribute('aria-invalid',String(!!message));if(message){assign(selected);return;}selected=file;assign(file);render();input.dispatchEvent(new Event('input',{bubbles:true}));};
 choose.onclick=()=>{if(!input.disabled)input.click();};remove.onclick=()=>{if(input.disabled)return;selected=null;assign(null);error.textContent='';input.removeAttribute('aria-invalid');render();input.dispatchEvent(new Event('input',{bubbles:true}));choose.focus();};
 input.addEventListener('change',()=>accept([...input.files]));
 zone.addEventListener('dragenter',e=>{e.preventDefault();depth++;zone.classList.add('over');});zone.addEventListener('dragover',e=>e.preventDefault());zone.addEventListener('dragleave',e=>{e.preventDefault();if(--depth<=0){depth=0;zone.classList.remove('over');}});zone.addEventListener('drop',e=>{e.preventDefault();depth=0;zone.classList.remove('over');accept([...e.dataTransfer.files]);});render();
};
